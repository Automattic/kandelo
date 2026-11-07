import { expect } from "@playwright/test";
import { test } from "./support/streamed-artifacts";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { fileURLToPath } from "node:url";

const hostModule = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
let fixture: ReturnType<typeof compileSdkFixture>;
test.beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../../host/test/fixtures/offline-listener.c", import.meta.url), [], {
    forkInstrument: true,
  });
});
test.afterAll(() => fixture?.cleanup());

for (const address of ["127.0.0.1", "127.0.0.2", "0.0.0.0", "10.0.2.15", "::1"]) {
  for (const mode of ["same", "fork"]) {
    test(`TCP stays within this machine at ${address} (${mode})`, async ({ page, baseURL, serveArtifacts }) => {
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
      const moduleUrl = new URL(`/@fs/${hostModule}`, baseURL!).href;
      const result = await page.evaluate(async ({ urls, moduleUrl, address, mode }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
        const [program, kernelWasm, image] = await Promise.all(
          [urls.program, urls.kernel, urls.image].map(async url => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Artifact fetch failed: ${url}`);
            return response.arrayBuffer();
          }),
        );
        let stdout = "", stderr = "";
        const diagnostics: unknown[] = [];
        let pid: number | undefined;
        let released = false;
        const releaseListener = () => {
          if (!released && pid !== undefined && stdout.includes("GUEST LISTENING")) {
            released = true;
            kernel.appendStdinData(pid, new Uint8Array([1]));
          }
        };
        const decoder = new TextDecoder();
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          onStdout: (bytes: Uint8Array) => { stdout += decoder.decode(bytes); releaseListener(); },
          onStderr: (bytes: Uint8Array) => { stderr += decoder.decode(bytes); },
          onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
        });
        try {
          await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(image) });
          const exitCode = await kernel.spawn(program, ["local-tcp", "35001", address, mode], {
            onStarted: (value: number) => { pid = value; releaseListener(); },
          });
          return { exitCode, stdout, stderr, diagnostics };
        } finally {
          await kernel.destroy();
        }
      }, { urls, moduleUrl, address, mode });
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("GUEST LOOPBACK PASS");
      expect(result.stderr).toBe("");
      expect(result.diagnostics).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
