import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isNodeVfsImageUrl } from "../lib/shell-vfs-image-url";
import { runTerminalCommand } from "./support/terminal-command";

const strict = process.env.KANDELO_NODE_VFS_STRICT === "1";
const expectedImageSha256 = process.env.KANDELO_NODE_VFS_SHA256;
const localBootAssetRoot = process.env.KANDELO_NODE_LOCAL_BOOT_ASSET_ROOT;
const localProxyPort = Number(process.env.KANDELO_NODE_LOCAL_PROXY_PORT ?? 0);
const tlsOnly = process.env.KANDELO_NODE_TLS_ONLY === "1";

interface LocalProxyEvent {
  method: string;
  target: string;
  source: "local-asset" | "upstream";
  status: number;
  requestHeaders: Record<string, string | undefined>;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

async function terminalText(page: Page): Promise<string> {
  return page
    .locator(".xterm-rows")
    .first()
    .evaluate((node) => node.textContent ?? "");
}

async function waitForReady(page: Page, timeout = 180_000) {
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout })
    .toContain("Ready");
}

async function waitForPrompt(page: Page, timeout = 120_000) {
  await expect
    .poll(() => terminalText(page), { timeout })
    .toContain("spidermonkey-node$");
}

test("@slow Kandelo Node demo completes HTTPS and installs cowsay with npm", async ({
  context,
  page,
  baseURL,
}) => {
  test.setTimeout(300_000);
  if (
    strict &&
    (!expectedImageSha256 || !/^[0-9a-f]{64}$/.test(expectedImageSha256))
  ) {
    throw new Error(
      "KANDELO_NODE_VFS_SHA256 must be the exact lowercase image digest",
    );
  }
  if (!baseURL) throw new Error("Playwright baseURL is required");
  let localProxy: Server | undefined;
  const localProxyEvents: LocalProxyEvent[] = [];
  if (localBootAssetRoot) {
    if (!Number.isSafeInteger(localProxyPort) || localProxyPort <= 0) {
      throw new Error(
        "KANDELO_NODE_LOCAL_PROXY_PORT is required with local assets",
      );
    }
    const localAssets = new Map([
      [
        "kandelo-homebrew-bottle-libyaml-80c927883bbbc995-layer.bin",
        await readFile(`${localBootAssetRoot}/libyaml.bin`),
      ],
      [
        "kandelo-homebrew-bottle-ruby-c670cea14298b55d-layer.bin",
        await readFile(`${localBootAssetRoot}/ruby.bin`),
      ],
      [
        "homebrew-bootstrap.zip",
        await readFile(`${localBootAssetRoot}/homebrew-bootstrap.zip`),
      ],
    ]);
    localProxy = createServer(async (request, response) => {
      const origin = request.headers.origin ?? "*";
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": [
            "Accept",
            "Content-Type",
            "git-protocol",
            "wp_blog",
            "wp_install",
          ].join(", "),
        });
        response.end();
        return;
      }
      const target = (request.url ?? "").slice(2);
      const asset = [...localAssets.entries()].find(([name]) =>
        target.endsWith(`/${name}`),
      );
      try {
        const upstream = asset
          ? new Response(asset[1])
          : await fetch(target, {
              method: "GET",
              headers: request.headers.accept
                ? { Accept: request.headers.accept }
                : undefined,
              credentials: "omit",
            });
        localProxyEvents.push({
          method: request.method ?? "",
          target,
          source: asset ? "local-asset" : "upstream",
          status: upstream.status,
          requestHeaders: {
            accept: request.headers.accept,
            authorization: request.headers.authorization,
            "content-type": request.headers["content-type"],
            "npm-auth-type": request.headers["npm-auth-type"],
            "npm-command": request.headers["npm-command"],
            "pacote-integrity": request.headers["pacote-integrity"],
            "pacote-pkg-id": request.headers["pacote-pkg-id"],
            "pacote-req-type": request.headers["pacote-req-type"],
            "pacote-version": request.headers["pacote-version"],
          },
        });
        response.writeHead(upstream.status, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/octet-stream",
          "Cross-Origin-Resource-Policy": "cross-origin",
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        localProxyEvents.push({
          method: request.method ?? "",
          target,
          source: "upstream",
          status: 502,
          requestHeaders: {},
        });
        response.writeHead(502, { "Access-Control-Allow-Origin": "*" });
        response.end(error instanceof Error ? error.message : "Bad Gateway");
      }
    });
    await new Promise<void>((resolve, reject) => {
      localProxy!.once("error", reject);
      localProxy!.listen(localProxyPort, "127.0.0.1", () => {
        localProxy!.off("error", reject);
        resolve();
      });
    });
  }
  try {
    const runtimeErrors: string[] = [];
    const proxyOmissionDiagnostics: string[] = [];
    const bottleRequests: string[] = [];
    const nodeResponses: Array<{ ok: boolean; url: string }> = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        msg.type() === "error" ||
        /Maximum call stack|Segmentation fault/i.test(text)
      ) {
        runtimeErrors.push(`${msg.type()}: ${text}`);
      }
    });
    context.on("console", (msg) => {
      const text = msg.text();
      if (
        msg.type() === "warning" &&
        text.includes(
          "Browser CORS proxy omitted unsupported request headers for",
        )
      ) {
        proxyOmissionDiagnostics.push(text);
      }
      if (msg.type() === "error" && /cors/i.test(text)) {
        runtimeErrors.push(`context error: ${text}`);
      }
    });
    context.on("request", (request) => {
      if (
        /kandelo-homebrew-bottle-|homebrew-shell-bottles/i.test(request.url())
      ) {
        bottleRequests.push(request.url());
      }
    });
    page.on("pageerror", (err) =>
      runtimeErrors.push(`pageerror: ${err.message}`),
    );
    page.on("response", (response) => {
      if (!isNodeVfsImageUrl(response.url())) return;
      nodeResponses.push({ ok: response.ok(), url: response.url() });
    });

    const productBase = new URL(process.env.KANDELO_TEST_BASE_URL ?? baseURL);
    await page.goto(new URL("?demo=node", productBase).href, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2_000);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.waitForSelector("aside.kdemo", { timeout: 120_000 });
    await waitForReady(page, 240_000);
    await waitForPrompt(page);
    await expect
      .poll(() => nodeResponses.length, { timeout: 180_000 })
      .toBeGreaterThan(0);
    expect(
      nodeResponses.every(({ ok }) => ok),
      JSON.stringify(nodeResponses),
    ).toBe(true);
    if (strict) {
      const nodeUrls = [...new Set(nodeResponses.map(({ url }) => url))];
      const imageDigests = await Promise.all(
        nodeUrls.map((url) =>
          page.evaluate(async (imageUrl) => {
            // Hash a normal same-origin browser fetch. Large VFS responses can
            // be evicted from Chromium's inspector cache before body() reads it.
            const response = await fetch(imageUrl, { cache: "no-store" });
            if (!response.ok) {
              throw new Error(
                `could not fetch Node VFS image: ${response.status}`,
              );
            }
            const digest = await crypto.subtle.digest(
              "SHA-256",
              await response.arrayBuffer(),
            );
            return Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
          }, url),
        ),
      );
      expect(new Set(imageDigests)).toEqual(new Set([expectedImageSha256]));
    }
    const bottleRequestsBeforeNpm = bottleRequests.length;

    const tlsProbeCommand = [
      'node -e \'require("https").get("https://registry.npmjs.org/cowsay",response=>{',
      'console.log("KANDELO_TLS_STATUS="+response.statusCode);',
      "response.resume();",
      'response.on("end",()=>console.log("KANDELO_TLS_OK"));',
      '}).on("error",error=>{console.error(error);process.exitCode=1})\'',
    ].join(" ");
    const npmInstallCommand = tlsOnly
      ? tlsProbeCommand
      : [
          [
            'node -e \'const fs=require("fs");',
            'for(const path of ["node_modules","package-lock.json","/tmp/.npm-cache","/tmp/kandelo-npm.log"])',
            "fs.rmSync(path,{recursive:true,force:true})'",
          ].join(" "),
          tlsProbeCommand,
          "registry=$(npm config get registry)",
          "printf 'KANDELO_REGISTRY=%s\\n' \"$registry\"",
          [
            'if test "$registry" = https://registry.npmjs.org/',
            "&& npm install cowsay --verbose >/tmp/kandelo-npm.log 2>&1; then",
            'node -e \'const fs=require("fs");const log=fs.readFileSync("/tmp/kandelo-npm.log","utf8");console.log(log.slice(-1500))\';',
            "printf 'KANDELO_NPM_INSTALL_OK\\n';",
            "else",
            'node -e \'const fs=require("fs");const log=fs.readFileSync("/tmp/kandelo-npm.log","utf8");console.log(log.slice(-1500))\';',
            "printf 'KANDELO_NPM_FAIL\\n';",
            "exit 1;",
            "fi",
          ].join(" "),
        ].join("; ");

    try {
      await runTerminalCommand(
        page,
        npmInstallCommand,
        tlsOnly ? "KANDELO_TLS_OK" : "KANDELO_NPM_INSTALL_OK",
        180_000,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `local proxy events: ${JSON.stringify(localProxyEvents)}\n` +
          `proxy diagnostics: ${JSON.stringify(proxyOmissionDiagnostics)}\n` +
          `runtime errors: ${JSON.stringify(runtimeErrors)}`,
      );
    }

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain("KANDELO_TLS_STATUS=200");
    expect(text).toContain("KANDELO_TLS_OK");
    if (tlsOnly) {
      expect(runtimeErrors).toEqual([]);
      expect(
        localProxyEvents.some(
          ({ target, status }) =>
            target === "https://registry.npmjs.org/cowsay" && status === 200,
        ),
      ).toBe(true);
      return;
    }
    const bottleRequestsAfterNpm = bottleRequests.length;
    expect(bottleRequestsAfterNpm).toBe(bottleRequestsBeforeNpm);
    await runTerminalCommand(
      page,
      [
        'if node -e \'console.log(require("cowsay").say({text:"Kandelo"}))\'; then',
        "printf 'KANDELO_COWSAY_OK\\n';",
        "else printf 'KANDELO_COWSAY_FAIL\\n'; exit 1; fi",
      ].join(" "),
      "KANDELO_COWSAY_OK",
      60_000,
    );
    expect(bottleRequests).toHaveLength(bottleRequestsAfterNpm);

    const textAfterCowsay = await page.evaluate(() => document.body.innerText);
    expect(textAfterCowsay).toContain("< Kandelo >");
    expect(text).toContain("KANDELO_REGISTRY=https://registry.npmjs.org/");
    expect(text).toContain("KANDELO_NPM_INSTALL_OK");
    expect(textAfterCowsay).toContain("KANDELO_COWSAY_OK");
    expect(text).not.toContain("KANDELO_NPM_FAIL");
    expect(text).not.toMatch(/TAR_ENTRY_ERROR|EACCES/);
    expect(text).not.toContain("Segmentation fault");
    expect(runtimeErrors).toEqual([]);
    expect(proxyOmissionDiagnostics.length).toBeGreaterThan(0);
    const registryRequests = localProxyEvents.filter(({ target }) =>
      target.startsWith("https://registry.npmjs.org/"),
    );
    expect(registryRequests.length).toBeGreaterThan(0);
    expect(
      registryRequests.some(({ requestHeaders }) => requestHeaders.accept),
    ).toBe(true);
    for (const { requestHeaders } of registryRequests) {
      expect(requestHeaders.authorization).toBeUndefined();
      expect(requestHeaders["npm-auth-type"]).toBeUndefined();
      expect(requestHeaders["npm-command"]).toBeUndefined();
      expect(requestHeaders["pacote-integrity"]).toBeUndefined();
      expect(requestHeaders["pacote-pkg-id"]).toBeUndefined();
      expect(requestHeaders["pacote-req-type"]).toBeUndefined();
      expect(requestHeaders["pacote-version"]).toBeUndefined();
    }
  } finally {
    if (localProxy) await close(localProxy);
  }
});
