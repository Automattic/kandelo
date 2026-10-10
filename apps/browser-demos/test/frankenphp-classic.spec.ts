import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  ABI_CONTRACT_SECTION,
  readWasmCustomSectionPayload,
} from "../../../host/src/constants";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const programPath = process.env.KANDELO_FRANKENPHP_CLASSIC_WASM;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("FrankenPHP classic serves PHP and static HTTP", async ({ page, baseURL }) => {
  test.skip(!programPath, "Build frankenphp-classic and set KANDELO_FRANKENPHP_CLASSIC_WASM");
  expect(baseURL).toBeTruthy();

  const programBytes = readFileSync(programPath!);
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  expect(readWasmCustomSectionPayload(
    Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
  )).toEqual(readWasmCustomSectionPayload(
    Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
  ));

  const image = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  for (const directory of ["/tmp", "/var", "/var/www", "/var/www/html"]) {
    image.mkdir(directory, 0o755);
  }
  image.createFileWithOwner("/var/www/html/index.php", 0o644, 0, 0,
    new TextEncoder().encode("<?php header('X-Kandelo: classic'); echo $_SERVER['REQUEST_METHOD'], '|', $_SERVER['REQUEST_URI'], '|', $_SERVER['SCRIPT_NAME'];"));
  image.createFileWithOwner("/var/www/html/robots.txt", 0o644, 0, 0,
    new TextEncoder().encode("static asset\n"));

  const programUrl = new URL("/__frankenphp_classic__.wasm", baseURL!).href;
  const kernelUrl = new URL("/__frankenphp_kernel__.wasm", baseURL!).href;
  const browserKernelUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href;
  await page.route(programUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: programBytes,
  }));
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: kernelBytes,
  }));
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ programUrl, kernelUrl, browserKernelUrl, imageBytes }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
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
        env: ["HOME=/tmp", "TMPDIR=/tmp"],
        onStarted: (pid: number) => { serverPid = pid; },
      });
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
      return {
        phpStatus: php.status,
        phpBody: decoder.decode(php.body),
        phpHeader: php.headers["X-Kandelo"],
        staticStatus: staticAsset.status,
        staticBody: decoder.decode(staticAsset.body),
        diagnostics,
        stderr,
      };
    } finally {
      if (serverPid !== 0) await kernel.signalProcess(serverPid, 15).catch(() => {});
      await kernel.destroy();
    }
  }, { programUrl, kernelUrl, browserKernelUrl, imageBytes: Array.from(await image.saveImage()) });

  expect(result.phpStatus, JSON.stringify(result)).toBe(200);
  expect(result.phpBody).toBe("GET|/welcome?x=1|/index.php");
  expect(result.phpHeader).toBe("classic");
  expect(result.staticStatus).toBe(200);
  expect(result.staticBody).toBe("static asset\n");
  expect(result.diagnostics).toEqual([]);
  expect(result.stderr).not.toContain("panic");
});
