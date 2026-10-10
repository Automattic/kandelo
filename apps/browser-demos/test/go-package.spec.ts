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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const launcherPath = resolve(repoRoot, ".context/go-package/launcher.wasm");
const browserKernelModulePath = resolve(repoRoot, "host/src/browser-kernel-host.ts");

test("resolved Go package launches from a browser VFS image", async ({ page, baseURL }) => {
  test.skip(process.env.KANDELO_GO_PACKAGE_TESTS !== "1", "Build go-hello and set KANDELO_GO_PACKAGE_TESTS=1");
  expect(baseURL).toBeTruthy();

  const launcherBytes = readFileSync(launcherPath);
  const packageBytes = readFileSync(resolveBinary("programs/wasm32/go-hello.wasm"));
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const kernelDigest = readWasmCustomSectionPayload(
    Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
  );
  expect(kernelDigest?.length).toBe(32);
  for (const programBytes of [launcherBytes, packageBytes]) {
    expect(readWasmCustomSectionPayload(
      Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
    )).toEqual(kernelDigest);
  }

  const launcherUrl = new URL("/__kandelo_go_package_launcher__.wasm", baseURL).href;
  const kernelUrl = new URL("/__kandelo_go_package_kernel__.wasm", baseURL).href;
  const browserKernelUrl = new URL(`/@fs/${browserKernelModulePath}`, baseURL).href;
  await page.route(launcherUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: launcherBytes,
  }));
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: kernelBytes,
  }));

  const imageCapacity = Math.max(8 * 1024 * 1024, packageBytes.byteLength + 2 * 1024 * 1024);
  const image = MemoryFileSystem.create(new SharedArrayBuffer(Math.ceil(imageCapacity / 4) * 4));
  image.mkdir("/bin", 0o755);
  image.createFileWithOwner("/bin/go-hello.wasm", 0o755, 0, 0, new Uint8Array(packageBytes));
  const vfsImage = Array.from(await image.saveImage());

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(async ({ launcherUrl, kernelUrl, browserKernelUrl, vfsImage }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
    const [launcherResponse, kernelResponse] = await Promise.all([
      fetch(launcherUrl),
      fetch(kernelUrl),
    ]);
    if (!launcherResponse.ok || !kernelResponse.ok) {
      throw new Error(`Go package fetch failed: launcher=${launcherResponse.status}, kernel=${kernelResponse.status}`);
    }
    const [launcherWasm, kernelWasm] = await Promise.all([
      launcherResponse.arrayBuffer(),
      kernelResponse.arrayBuffer(),
    ]);
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    const hostDiagnostics: unknown[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => { stdout += decoder.decode(data); },
      onStderr: (data: Uint8Array) => { stderr += decoder.decode(data); },
      onHostDiagnostic: (diagnostic: unknown) => { hostDiagnostics.push(diagnostic); },
    });
    try {
      await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(vfsImage) });
      const exitCode = await kernel.spawn(launcherWasm, ["go-package-launcher"]);
      return { exitCode, stdout, stderr, hostDiagnostics };
    } finally {
      await kernel.destroy();
    }
  }, { launcherUrl, kernelUrl, browserKernelUrl, vfsImage });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("GO PACKAGE PASS");
  expect(result.stdout).toContain("GO PACKAGE LAUNCH PASS");
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
