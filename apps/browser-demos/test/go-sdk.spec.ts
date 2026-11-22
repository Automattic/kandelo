import { expect, test } from "../playwright-test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { createGoSdkImage, goSdkProbeOutput, goSdkProbePath } from "../../../host/test/fixtures/go-sdk-image";

test("runs an SDK-built Go module from the guest VFS", async ({ page }) => {
  const probe = process.env.KANDELO_GO_SDK_PROBE;
  test.skip(!probe, "Build the Go SDK probe and set KANDELO_GO_SDK_PROBE");
  test.setTimeout(60_000);

  const image = await createGoSdkImage(probe!);
  const kernelPath = process.env.KANDELO_GO_TEST_KERNEL ?? resolveBinary("kernel.wasm");
  const kernelWasm = "/__go_sdk_kernel.wasm";
  const vfsImage = "/__go_sdk_image.vfs";
  await page.route(kernelWasm, route => route.fulfill({ body: readFileSync(kernelPath) }));
  await page.route(vfsImage, route => route.fulfill({ body: Buffer.from(image) }));
  await page.goto("/trap-signal-test.html");
  const module = resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts");
  const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, program }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
    const [wasm, image] = await Promise.all(
      [kernelUrl, imageUrl].map(async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fixture fetch failed: ${url}`);
        return response.arrayBuffer();
      }),
    );
    let stdout = "";
    let stderr = "";
    const decoder = new TextDecoder();
    const host = new BrowserKernel({
      onStdout: (bytes: Uint8Array) => { stdout += decoder.decode(bytes); },
      onStderr: (bytes: Uint8Array) => { stderr += decoder.decode(bytes); },
    });
    try {
      await host.initFromImage({ kernelWasm: wasm, vfsImage: new Uint8Array(image) });
      const process = await host.spawnFromVfs(program, [program]);
      return { status: await process.exit, stdout, stderr };
    } finally {
      await host.destroy();
    }
  }, { moduleUrl: `/@fs/${module}`, kernelUrl: kernelWasm, imageUrl: vfsImage, program: goSdkProbePath });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(goSdkProbeOutput);
  expect(result.stderr).toBe("");
});
