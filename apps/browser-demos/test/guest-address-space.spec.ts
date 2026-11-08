import { expect } from "../playwright-test";
import { test } from "./support/streamed-artifacts";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { GUEST_ADDRESS_PHASES } from "../../../host/test/support/guest-address-space";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

for (const arch of ["wasm32", "wasm64"] as const) {
  test.describe(`separate guest and kernel address spaces on ${arch}`, () => {
    let fixture: ReturnType<typeof compileSdkFixture>;
    test.beforeAll(() => {
      fixture = compileSdkFixture(new URL("../../../host/test/fixtures/guest-address-space.c", import.meta.url), [], {
        arch, forkInstrument: true,
      });
    });
    test.afterAll(() => fixture?.cleanup());

    test("grows guest mappings without mirroring their addresses in the kernel", async ({ page, baseURL, serveArtifacts }) => {
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
      const probeUrl = new URL(`/@fs/${repo}/host/test/support/guest-address-space.ts`, baseURL!).href;
      const result = await page.evaluate(async ({ urls, moduleUrl, probeUrl }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
        const { GuestAddressSpaceProbe } = await import(/* @vite-ignore */ probeUrl);
        const [program, kernelWasm, image] = await Promise.all(
          [urls.program, urls.kernel, urls.image].map(async url => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Artifact fetch failed: ${url}`);
            return response.arrayBuffer();
          }),
        );
        const probe = new GuestAddressSpaceProbe();
        let stderr = "";
        const diagnostics: unknown[] = [];
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          maxMemoryPages: 16_384,
          onStdout: (bytes: Uint8Array) => probe.onStdout(bytes),
          onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
          onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
        });
        try {
          await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(image) });
          return { ...(await probe.run(kernel, program)), stderr, diagnostics };
        } finally {
          await kernel.destroy();
        }
      }, { urls, moduleUrl, probeUrl });
      await test.info().attach("guest-address-space", {
        body: JSON.stringify(result, null, 2), contentType: "application/json",
      });
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("GUEST ADDRESS SPACE PASS");
      expect(result.errors).toEqual([]);
      expect(result.stderr).toBe("");
      expect(result.diagnostics).toEqual([]);
      expect(errors).toEqual([]);
      expect(result.phases.map((phase: { name: string }) => phase.name)).toEqual(GUEST_ADDRESS_PHASES);
      expect(result.phases[2].processBytes).toBeGreaterThan(256 * 1024 * 1024);
      expect(result.phases[6].processBytes).toBe(result.phases[5].processBytes);
      for (const phase of result.phases) {
        expect(phase.kernelBytes, JSON.stringify(result.phases))
          .toBeLessThanOrEqual(result.phases[0].kernelBytes + 4 * 1024 * 1024);
      }
    });
  });
}
