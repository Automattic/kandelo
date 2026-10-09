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

test("RoadRunner serves a PHP worker response in Chromium", async ({ page, baseURL, browserName }) => {
  test.skip(process.env.KANDELO_GO_ROADRUNNER_TESTS !== "1", "Build the RoadRunner fixture first");
  test.skip(browserName !== "chromium", "RoadRunner browser probe uses Chromium");
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const supervisorBytes = readFileSync(resolve(repoRoot, ".context/roadrunner-supervisor.wasm"));
  const serverBytes = readFileSync(resolve(repoRoot, ".context/roadrunner-minimal.wasm"));
  const phpBytes = readFileSync(resolveBinary("programs/wasm32/php/php.wasm"));
  const kernelDigest = readWasmCustomSectionPayload(
    Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
  );
  expect(kernelDigest?.length).toBe(32);
  for (const program of [supervisorBytes, serverBytes, phpBytes]) {
    expect(readWasmCustomSectionPayload(
      Uint8Array.from(program).buffer, ABI_CONTRACT_SECTION,
    )).toEqual(kernelDigest);
  }

  const capacity = serverBytes.byteLength + phpBytes.byteLength + 4 * 1024 * 1024;
  const image = MemoryFileSystem.create(new SharedArrayBuffer(Math.ceil(capacity / 4) * 4));
  image.mkdir("/bin", 0o755);
  image.mkdir("/etc", 0o755);
  image.createFileWithOwner("/bin/roadrunner.wasm", 0o755, 0, 0, new Uint8Array(serverBytes));
  image.createFileWithOwner("/bin/php.wasm", 0o755, 0, 0, new Uint8Array(phpBytes));
  image.createFileWithOwner("/etc/rr.yaml", 0o644, 0, 0,
    new Uint8Array(readFileSync(resolve(repoRoot, "tests/go/roadrunner/rr.yaml"))));
  image.createFileWithOwner("/worker.php", 0o644, 0, 0,
    new Uint8Array(readFileSync(resolve(repoRoot, "tests/go/roadrunner/worker.php"))));
  const imageBytes = Buffer.from(await image.saveImage());

  const supervisorUrl = new URL("/__roadrunner_supervisor__.wasm", baseURL!).href;
  const kernelUrl = new URL("/__roadrunner_kernel__.wasm", baseURL!).href;
  const imageUrl = new URL("/__roadrunner_image__.bin", baseURL!).href;
  const browserKernelUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href;
  await page.route(supervisorUrl, (route) => route.fulfill({
    status: 200, contentType: "application/wasm", body: supervisorBytes,
  }));
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200, contentType: "application/wasm", body: kernelBytes,
  }));
  await page.route(imageUrl, (route) => route.fulfill({
    status: 200, contentType: "application/octet-stream", body: imageBytes,
  }));
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ supervisorUrl, kernelUrl, imageUrl, browserKernelUrl }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
    const [supervisorResponse, kernelResponse, imageResponse] = await Promise.all([
      fetch(supervisorUrl), fetch(kernelUrl), fetch(imageUrl),
    ]);
    if (!supervisorResponse.ok || !kernelResponse.ok || !imageResponse.ok) {
      throw new Error("RoadRunner browser fixture fetch failed");
    }
    const [supervisor, kernelWasm, vfsImage] = await Promise.all([
      supervisorResponse.arrayBuffer(), kernelResponse.arrayBuffer(), imageResponse.arrayBuffer(),
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
      const exitCode = await kernel.spawn(supervisor, ["roadrunner-supervisor"]);
      return { exitCode, stdout, stderr, hostDiagnostics };
    } finally {
      await kernel.destroy();
    }
  }, { supervisorUrl, kernelUrl, imageUrl, browserKernelUrl });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("ROADRUNNER ROUND TRIP PASS");
  expect(result.stderr).toBe("");
  expect(result.hostDiagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
