import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../../host/src/constants";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const programPath = process.env.KANDELO_FRANKENPHP_CADDY_WASM;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("FrankenPHP Caddy php_server serves PHP and static HTTP", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  test.skip(!programPath, "Build frankenphp-caddy and set KANDELO_FRANKENPHP_CADDY_WASM");
  expect(baseURL).toBeTruthy();

  const programBytes = readFileSync(programPath!);
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  expect(readWasmCustomSectionPayload(
    Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
  )).toEqual(readWasmCustomSectionPayload(
    Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
  ));

  const image = KandeloImageFs.create();
  image.setImageCapacity(2 * 1024 * 1024);
  for (const directory of ["/etc", "/etc/caddy", "/tmp", "/var", "/var/www", "/var/www/html"]) {
    image.mkdir(directory, 0o755);
  }
  image.createFileWithOwner("/etc/caddy/Caddyfile", 0o644, 0, 0, new TextEncoder().encode(`{
  admin off
  auto_https off
  frankenphp {
    num_threads 2
  }
}
:{$FRANKENPHP_PORT:8080} {
  root * /var/www/html
  php_server
}
`));
  image.createFileWithOwner("/var/www/html/index.php", 0o644, 0, 0,
    new TextEncoder().encode("<?php echo 'CADDY PHP ', $_SERVER['REQUEST_METHOD'], '|', $_SERVER['SCRIPT_NAME'];"));
  image.createFileWithOwner("/var/www/html/robots.txt", 0o644, 0, 0,
    new TextEncoder().encode("CADDY STATIC\n"));

  const programUrl = new URL("/__frankenphp_caddy_program__.wasm", baseURL!).href;
  const kernelUrl = new URL("/__frankenphp_caddy_kernel__.wasm", baseURL!).href;
  const browserKernelUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href;
  await page.route(programUrl, (route) => route.fulfill({
    status: 200, contentType: "application/wasm", body: programBytes,
  }));
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200, contentType: "application/wasm", body: kernelBytes,
  }));
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ programUrl, kernelUrl, browserKernelUrl, imageBytes }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
    const [programResponse, kernelResponse] = await Promise.all([fetch(programUrl), fetch(kernelUrl)]);
    if (!programResponse.ok || !kernelResponse.ok) throw new Error("FrankenPHP Caddy artifacts failed to load");
    const [program, kernelWasm] = await Promise.all([
      programResponse.arrayBuffer(), kernelResponse.arrayBuffer(),
    ]);
    const decoder = new TextDecoder();
    let stderr = "";
    const diagnostics: unknown[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 12,
      maxMemoryPages: 16384,
      onStderr: (data: Uint8Array) => { stderr += decoder.decode(data); },
      onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
    });
    let serverPid = 0;
    try {
      await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(imageBytes) });
      const exit = kernel.spawn(program, [
        "frankenphp-caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
      ], {
        env: ["HOME=/tmp", "TMPDIR=/tmp", "FRANKENPHP_PORT=8080"],
        onStarted: (pid: number) => { serverPid = pid; },
      });
      let serverExit: number | undefined;
      exit.then((code: number) => { serverExit = code; }).catch(() => {});
      let php: Awaited<ReturnType<typeof kernel.fetchInKernel>> | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (serverExit !== undefined) {
          throw new Error(`server exited before readiness: ${serverExit}\n${stderr}\n${JSON.stringify(diagnostics)}`);
        }
        try {
          php = await kernel.fetchInKernel(8080, {
            method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null,
          }, { timeoutMs: 30_000 });
          break;
        } catch (error) {
          if (!String(error).includes("No in-kernel listener")) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        }
      }
      if (!php) throw new Error(`server did not listen on 8080\n${stderr}`);
      const staticAsset = await kernel.fetchInKernel(8080, {
        method: "GET", url: "/robots.txt", headers: { Host: "localhost:8080" }, body: null,
      }, { timeoutMs: 30_000 });
      return {
        phpStatus: php.status,
        phpBody: decoder.decode(php.body),
        staticStatus: staticAsset.status,
        staticBody: decoder.decode(staticAsset.body),
        stderr,
        diagnostics,
      };
    } finally {
      if (serverPid !== 0) await kernel.signalProcess(serverPid, 15).catch(() => {});
      await kernel.destroy();
    }
  }, { programUrl, kernelUrl, browserKernelUrl, imageBytes: Array.from(await image.saveImage()) });

  expect(result.phpStatus, JSON.stringify(result)).toBe(200);
  expect(result.phpBody).toBe("CADDY PHP GET|/index.php");
  expect(result.staticStatus).toBe(200);
  expect(result.staticBody).toBe("CADDY STATIC\n");
  expect(result.stderr).not.toContain("panic");
  expect(result.diagnostics).toEqual([]);
});
