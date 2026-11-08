import { expect } from "@playwright/test";
import { test } from "./support/streamed-artifacts";
import { requestLifetimePhp } from "../../../tests/go/frankenphp/request-lifetime";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  ABI_CONTRACT_SECTION,
  readWasmCustomSectionPayload,
} from "../../../host/src/constants";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const programPath = process.env.KANDELO_FRANKENPHP_CLASSIC_WASM;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("FrankenPHP classic serves PHP and static HTTP", async ({ page, baseURL, serveArtifacts }) => {
  test.setTimeout(240_000);
  test.skip(!programPath, "Build frankenphp-classic and set KANDELO_FRANKENPHP_CLASSIC_WASM");
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
  for (const directory of ["/tmp", "/var", "/srv", "/srv/www", "/srv/www/html"]) {
    image.mkdir(directory, 0o755);
  }
  image.createFileWithOwner("/srv/www/html/index.php", 0o644, 0, 0,
    new TextEncoder().encode("<?php header('X-Kandelo: classic'); echo $_SERVER['REQUEST_METHOD'], '|', $_SERVER['REQUEST_URI'], '|', $_SERVER['SCRIPT_NAME'];"));
  image.createFileWithOwner("/srv/www/html/robots.txt", 0o644, 0, 0,
    new TextEncoder().encode("static asset\n"));

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
    if (!programResponse.ok || !kernelResponse.ok) {
      throw new Error("FrankenPHP test binaries failed to load");
    }
    const [program, kernelWasm] = await Promise.all([
      programResponse.arrayBuffer(), kernelResponse.arrayBuffer(),
    ]);
    const decoder = new TextDecoder();
    let stderr = "";
    let serverPid = 0;
    let serverExitPromise: Promise<number> | undefined;
    let stopped = false;
    let ready: (() => void) | undefined;
    const readiness = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const diagnostics: unknown[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStderr: (data: Uint8Array) => {
        stderr += decoder.decode(data);
        if (stderr.includes("FrankenPHP classic listening on")) ready?.();
      },
      onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
    });
    try {
      await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(imageBytes) });
      const exit = kernel.spawn(program, ["frankenphp-classic"], {
        env: ["HOME=/tmp", "TMPDIR=/tmp", "GOGC=1", "GOMEMLIMIT=32MiB", "GODEBUG=gctrace=1"],
        onStarted: (pid: number) => { serverPid = pid; },
      });
      serverExitPromise = exit;
      exit.catch(() => {});
      await Promise.race([
        readiness,
        exit.then((code: number) => { throw new Error(`server exited before readiness: ${code}`); }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("readiness timeout")), 60_000)),
      ]);
      const php = await kernel.fetchInKernel(8080, {
        method: "GET", url: "/welcome?x=1", headers: { Host: "localhost:8080" }, body: null,
      }, { timeoutMs: 60_000 });
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
        phpHeader: php.headers["X-Kandelo"],
        staticStatus: staticAsset.status,
        staticBody: decoder.decode(staticAsset.body),
        diagnostics,
        stderr,
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
  expect(result.phpBody).toBe("GET|/welcome?x=1|/index.php");
  expect(result.phpHeader).toBe("classic");
  expect(result.staticStatus).toBe(200);
  expect(result.staticBody).toBe("static asset\n");
  expect(result.lifetime).toEqual({ requests: 32, concurrency: 4 });
  expect(result.gcAfter).toBeGreaterThan(result.gcBefore);
  expect(result.exitCode).toBe(0);
  expect(result.diagnostics).toEqual([]);
  expect(result.stderr).not.toContain("panic");
});
