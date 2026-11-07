import { expect } from "@playwright/test";
import { test } from "./support/streamed-artifacts";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

for (const arch of ["wasm32", "wasm64"] as const) {
  test.describe(`mmap zeroing on ${arch}`, () => {
    let fixture: ReturnType<typeof compileSdkFixture>;
    test.beforeAll(() => {
      fixture = compileSdkFixture(new URL("../../../host/test/fixtures/mmap-zeroing.c", import.meta.url), [], {
        arch, forkInstrument: true,
      });
    });
    test.afterAll(() => fixture?.cleanup());

    test("clears reused storage and preserves file and remap contents", async ({ page, baseURL, serveArtifacts }) => {
      const urls = await serveArtifacts({
        program: { path: fixture.programPath, contentType: "application/wasm" },
        kernel: { path: resolveBinary("kernel.wasm"), contentType: "application/wasm" },
        image: { path: resolveBinary("programs/rootfs.vfs.zst"), contentType: "application/octet-stream" },
      });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto("/trap-signal-test.html");
      const moduleUrl = new URL(`/@fs/${repo}/host/src/browser-kernel-host.ts`, baseURL!).href;
      const result = await page.evaluate(async ({ urls, moduleUrl }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
        const [program, kernelWasm, image] = await Promise.all(
          [urls.program, urls.kernel, urls.image].map(async url => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Artifact fetch failed: ${url}`);
            return response.arrayBuffer();
          }),
        );
        let stdout = "";
        let stderr = "";
        const diagnostics: unknown[] = [];
        const decoder = new TextDecoder();
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          onStdout: (bytes: Uint8Array) => { stdout += decoder.decode(bytes); },
          onStderr: (bytes: Uint8Array) => { stderr += decoder.decode(bytes); },
          onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
        });
        try {
          await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(image) });
          const exitCode = await kernel.spawn(program, ["mmap-zeroing"]);
          return { exitCode, stdout, stderr, diagnostics };
        } finally {
          await kernel.destroy();
        }
      }, { urls, moduleUrl });
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("MMAP ZEROING PASS");
      expect(result.stderr).toBe("");
      expect(result.diagnostics).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
