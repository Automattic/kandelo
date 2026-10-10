import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { zipSync, type Zippable } from "fflate";

import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";

interface LazyAcceptanceResult {
  readText: string;
  firstReadError?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

declare global {
  interface Window {
    __lazyArchiveVfsTestReady: boolean;
    __runLazyVfsAcceptance: (request: {
      vfsUrl: string;
      readPath: string;
      executable?: string;
      argv?: string[];
      env?: string[];
      corsProxyExternalLazyUrls?: boolean;
      retryReadAfterFailure?: boolean;
      timeoutMs: number;
    }) => Promise<LazyAcceptanceResult>;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const environmentProgram = join(
  here,
  "../../../examples/environment_lifecycle_test.wasm",
);
function tryResolveKernelWasm(): string | null {
  try {
    return resolveBinary("kernel.wasm");
  } catch {
    return null;
  }
}
const kernel = tryResolveKernelWasm();
const available = existsSync(environmentProgram) && kernel !== null;

async function prepareNativeAcceptance(page: Page, baseURL: string): Promise<void> {
  const kernelUrl = sameOriginFixtureUrl(baseURL, "kernel.wasm");
  await routeBytes(page, kernelUrl, readFileSync(resolveBinary("kernel.wasm")), "application/wasm");
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  await page.evaluate(async ({ moduleUrl, kernelUrl, proxyUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    window.__runLazyVfsAcceptance = async (request) => {
      let stdout = "";
      let stderr = "";
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        corsProxy: request.corsProxyExternalLazyUrls ? {
          url: proxyUrl,
          allowedRequestHeaderNames: [],
          allowAnonymousGetHeaderOmission: true,
        } : undefined,
        onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
        onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
      });
      try {
        await kernel.initFromImage({
          kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch(request.vfsUrl)).arrayBuffer()),
        });
        let firstReadError: string | undefined;
        let bytes: Uint8Array | null = null;
        try { bytes = await kernel.readFileFromVfs(request.readPath); }
        catch (error) {
          if (!request.retryReadAfterFailure) throw error;
          firstReadError = String(error);
          bytes = await kernel.readFileFromVfs(request.readPath);
        }
        let exitCode: number | undefined;
        if (request.executable) {
          const { exit } = await kernel.spawnFromVfs(request.executable,
            request.argv ?? [request.executable], { env: request.env });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            exitCode = await Promise.race([exit, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("lazy guest execution timed out")), request.timeoutMs);
            })]);
          } finally { clearTimeout(timer); }
        }
        return { readText: new TextDecoder().decode(bytes ?? new Uint8Array()), firstReadError, exitCode, stdout, stderr };
      } finally { await kernel.destroy(); }
    };
    window.__lazyArchiveVfsTestReady = true;
  }, {
    moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
    kernelUrl,
    proxyUrl: new URL("/__kandelo_cors_proxy?url=", baseURL).href,
  });
}

// The production preview itself supplies the cross-origin isolation headers.
// Keep Playwright's byte routes authoritative for these same-origin fixtures;
// the dedicated proxy test below separately exercises external transport.
test.use({ serviceWorkers: "block" });

function identity(bytes: Uint8Array): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function sameOriginFixtureUrl(baseURL: string, name: string): string {
  return new URL(`__kandelo_lazy_fixture__/${name}`, baseURL).href;
}

// The in-kernel rootfs is the sole `/` authority and its lazy-archive decoder
// is ZIP-only. Every lazy group is registered as a ZIP lazy archive, which the
// kernel fetches through `host_fetch_deferred` (host side:
// `buildRootfsLazyWiring`) and decodes itself.
async function lazyImage(groups: Array<{
  url: string;
  archive: Uint8Array;
}>): Promise<Uint8Array> {
  // Built by `KandeloImageFs`, the producer every shipped image uses. The
  // tests below are about the BROWSER; the image is only their input.
  const fs = KandeloImageFs.create();
  fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
  for (const group of groups) {
    fs.registerLazyArchive({
      url: group.url,
      entries: parseZipCentralDirectory(group.archive),
      mountPrefix: "/",
      integrity: identity(group.archive),
    });
  }
  return fs.saveImage();
}

async function routeBytes(
  page: Page,
  url: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(bytes.byteLength),
        "content-type": contentType,
      },
    });
  });
}

test.skip(!available, "lazy archive Chromium fixtures are not built");

test("Browser boots, reads, and execs through verified lazy archives", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const execUrl = sameOriginFixtureUrl(baseURL, "exec.zip");
  const dataUrl = sameOriginFixtureUrl(baseURL, "data.zip");
  const imageUrl = sameOriginFixtureUrl(baseURL, "lazy.vfs");
  const execBytes = new Uint8Array(readFileSync(environmentProgram));
  // The environment lifecycle fixture re-execs itself through argv[0]
  // (`/bin/environment-lifecycle`), so plant the executable directly at that
  // path in the ZIP archive (the kernel's lazy-archive decoder is ZIP-only).
  const execArchive = zipSync({
    "bin/": unixZipEntry(new Uint8Array(), 0o040755),
    "bin/environment-lifecycle": unixZipEntry(execBytes, 0o100755),
  } satisfies Zippable);
  const dataArchive = zipSync({
    "etc/lazy-browser-data": new TextEncoder().encode("lazy-browser-data"),
  });
  const image = await lazyImage([
    { url: execUrl, archive: execArchive },
    { url: dataUrl, archive: dataArchive },
  ]);
  let execFetches = 0;
  let dataFetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(execUrl, async (route) => {
    execFetches++;
    await route.fulfill({
      status: 200,
      body: Buffer.from(execArchive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(execArchive.byteLength),
      },
    });
  });
  await page.route(dataUrl, async (route) => {
    dataFetches++;
    await route.fulfill({
      status: 200,
      body: Buffer.from(dataArchive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(dataArchive.byteLength),
      },
    });
  });

  await prepareNativeAcceptance(page, baseURL);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/lazy-browser-data",
      executable: "/bin/environment-lifecycle",
      argv: ["/bin/environment-lifecycle"],
      env: ["INITIAL=parent", "REMOVE=before-fork"],
      timeoutMs: 90_000,
    }),
    imageUrl,
  );

  expect(result.readText).toBe("lazy-browser-data");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("EXEC_ENV_PASS");
  expect(result.stdout).toContain("EMPTY_ENV_PASS");
  expect(result.stderr).toBe("");
  expect(dataFetches).toBe(1);
  expect(execFetches).toBe(1);
});

test("Browser retries a transient lazy-tree response before surfacing EIO", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const archiveUrl = sameOriginFixtureUrl(baseURL, "transient.zip");
  const imageUrl = sameOriginFixtureUrl(baseURL, "transient.vfs");
  const payload = new TextEncoder().encode("verified-after-transient-502");
  const archive = zipSync({ "etc/transient-data": payload });
  const image = await lazyImage([{ url: archiveUrl, archive }]);
  let fetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(archiveUrl, async (route) => {
    fetches++;
    if (fetches === 1) {
      await route.fulfill({
        status: 502,
        body: "temporary release edge failure",
        headers: {
          "access-control-allow-origin": "*",
          "retry-after": "0",
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      body: Buffer.from(archive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(archive.byteLength),
      },
    });
  });

  await prepareNativeAcceptance(page, baseURL);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/transient-data",
      timeoutMs: 30_000,
    }),
    imageUrl,
  );

  expect(result.firstReadError).toBeUndefined();
  expect(result.readText).toBe("verified-after-transient-502");
  expect(fetches).toBe(2);
});

// There is no test of read-time byte transformation of lazy archive members:
// the in-kernel rootfs fetches raw archive bytes and decodes ZIP members
// verbatim (`buildRootfsLazyWiring` has no transform hook), so lazy read-time
// materialization is not a served behavior.

test("browser workers proxy external lazy archives under cross-origin isolation", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const archive = zipSync({
    "etc/proxied-data": new TextEncoder().encode("proxied-lazy-archive"),
  });
  let upstreamFetches = 0;
  const server = createServer((request, response) => {
    upstreamFetches++;
    if (request.url !== "/external.zip") {
      response.writeHead(404).end();
      return;
    }
    // Deliberately omit CORS. Lazy VFS must read the response bytes, and even
    // a CORP header would not make an opaque no-CORS body readable to JS.
    response.writeHead(200, {
      "content-length": String(archive.byteLength),
      "content-type": "application/zip",
    });
    response.end(archive);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const archiveUrl =
    `http://127.0.0.1:${address.port}/external.zip`;
  const imageUrl =
    "https://fixtures.kandelo.invalid/proxied-lazy.vfs";
  const image = await lazyImage([{ url: archiveUrl, archive }]);
  const browserRequests: string[] = [];
  page.on("request", (request) => browserRequests.push(request.url()));

  try {
    await routeBytes(page, imageUrl, image, "application/octet-stream");
    await prepareNativeAcceptance(page, baseURL);
    const result = await page.evaluate(
      ({ vfsUrl }) => window.__runLazyVfsAcceptance({
        vfsUrl,
        readPath: "/etc/proxied-data",
        corsProxyExternalLazyUrls: true,
        timeoutMs: 30_000,
      }),
      { vfsUrl: imageUrl },
    );

    expect(result.readText).toBe("proxied-lazy-archive");
    expect(upstreamFetches).toBe(1);
    expect(browserRequests).not.toContain(archiveUrl);
    expect(browserRequests.some((requestUrl) => {
      const url = new URL(requestUrl);
      return url.pathname.endsWith("/__kandelo_cors_proxy") &&
        url.searchParams.get("url") === archiveUrl;
    })).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("Browser reports digest failure without mutation and retries cleanly", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const archiveUrl = sameOriginFixtureUrl(baseURL, "retry.zip");
  const imageUrl = sameOriginFixtureUrl(baseURL, "retry.vfs");
  const archive = zipSync({
    "etc/retry-data": new TextEncoder().encode("verified-after-retry"),
  });
  const image = await lazyImage([{ url: archiveUrl, archive }]);
  const bad = archive.slice();
  bad[0] ^= 0xff;
  let fetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(archiveUrl, async (route) => {
    fetches++;
    const bytes = fetches === 1 ? bad : archive;
    await route.fulfill({
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(bytes.byteLength),
      },
    });
  });

  await prepareNativeAcceptance(page, baseURL);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/retry-data",
      retryReadAfterFailure: true,
      timeoutMs: 30_000,
    }),
    imageUrl,
  );

  expect(result.firstReadError).toContain("rootfs read failed");
  expect(result.readText).toBe("verified-after-retry");
  expect(fetches).toBe(2);
});

// These tests drive `/pages/lazy-archive-vfs-test/`, which this tree does not
// ship; they stay as the written specification of what a rebuilt acceptance
// harness must prove.

function unixZipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: ((mode << 16) >>> 0) }];
}
