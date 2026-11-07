import { expect } from "@playwright/test";
import { test } from "./support/streamed-artifacts";
import { requestLifetimePhp } from "../../../tests/go/frankenphp/request-lifetime";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../../host/src/constants";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const programPath = process.env.KANDELO_FRANKENPHP_CADDY_WASM;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("FrankenPHP Caddy php_server serves PHP and static HTTP", async ({ page, baseURL, serveArtifacts }) => {
  test.setTimeout(240_000);
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
  for (const directory of ["/etc", "/etc/caddy", "/tmp", "/var", "/srv", "/srv/www", "/srv/www/html"]) {
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
  root * /srv/www/html
  php_server
}
`));
  image.createFileWithOwner("/srv/www/html/index.php", 0o644, 0, 0,
    new TextEncoder().encode("<?php echo 'CADDY PHP ', $_SERVER['REQUEST_METHOD'], '|', $_SERVER['SCRIPT_NAME'];"));
  image.createFileWithOwner("/srv/www/html/robots.txt", 0o644, 0, 0,
    new TextEncoder().encode("CADDY STATIC\n"));

  image.createFileWithOwner("/srv/www/html/lifetime.php", 0o644, 0, 0,
    new TextEncoder().encode(requestLifetimePhp));
  const { program: programUrl, kernel: kernelUrl } = await serveArtifacts({
    program: { path: programPath!, contentType: "application/wasm" },
    kernel: { path: resolveBinary("kernel.wasm"), contentType: "application/wasm" },
  });
  const browserKernelUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href;
  const lifetimeModuleUrl = new URL(`/@fs/${resolve(repoRoot, "tests/go/frankenphp/request-lifetime.ts")}`, baseURL!).href;
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ programUrl, kernelUrl, browserKernelUrl, lifetimeModuleUrl, imageBytes }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
    const { countGoCollections, verifyRequestStringLifetimes, withDeadline } =
      await import(/* @vite-ignore */ lifetimeModuleUrl);
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
    let serverExitPromise: Promise<number> | undefined;
    let stopped = false;
    try {
      await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(imageBytes) });
      const exit = kernel.spawn(program, [
        "frankenphp-caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
      ], {
        env: ["HOME=/tmp", "TMPDIR=/tmp", "FRANKENPHP_PORT=8080", "GOGC=1", "GOMEMLIMIT=32MiB", "GODEBUG=gctrace=1"],
        onStarted: (pid: number) => { serverPid = pid; },
      });
      serverExitPromise = exit;
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
      const gcBefore = countGoCollections(stderr);
      const lifetime = await verifyRequestStringLifetimes(kernel);
      const gcAfter = countGoCollections(stderr);
      if (gcAfter <= gcBefore) throw new Error(`No collection during requests: ${gcBefore} -> ${gcAfter}`);
      await kernel.signalProcess(serverPid, 15);
      const exitCode = await withDeadline(exit, 30_000, "FrankenPHP shutdown timeout");
      stopped = true;
      return {
        lifetime, gcBefore, gcAfter, exitCode,
        phpStatus: php.status,
        phpBody: decoder.decode(php.body),
        staticStatus: staticAsset.status,
        staticBody: decoder.decode(staticAsset.body),
        stderr,
        diagnostics,
      };
    } finally {
      try {
        if (!stopped && serverPid !== 0) {
          await kernel.signalProcess(serverPid, 15).catch(() => {});
          if (serverExitPromise) {
            await withDeadline(serverExitPromise, 30_000, "FrankenPHP cleanup timeout").catch(() => {});
          }
        }
      } finally { await kernel.destroy(); }
    }
  }, { programUrl, kernelUrl, browserKernelUrl, lifetimeModuleUrl, imageBytes: Array.from(await image.saveImage()) });

  expect(result.phpStatus, JSON.stringify(result)).toBe(200);
  expect(result.phpBody).toBe("CADDY PHP GET|/index.php");
  expect(result.staticStatus).toBe(200);
  expect(result.staticBody).toBe("CADDY STATIC\n");
  expect(result.stderr).not.toContain("panic");
  expect(result.lifetime).toEqual({ requests: 32, concurrency: 4 });
  expect(result.gcAfter).toBeGreaterThan(result.gcBefore);
  expect(result.exitCode).toBe(0);
  expect(result.diagnostics).toEqual([]);
});
