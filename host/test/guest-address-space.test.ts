import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { GUEST_ADDRESS_PHASES, GuestAddressSpaceProbe } from "./support/guest-address-space";

for (const arch of ["wasm32", "wasm64"] as const) {
  describe(`separate guest and kernel address spaces on ${arch}`, () => {
    let fixture: ReturnType<typeof compileSdkFixture>;
    beforeAll(() => {
      fixture = compileSdkFixture(new URL("./fixtures/guest-address-space.c", import.meta.url), [], {
        arch, forkInstrument: true,
      });
    }, 120_000);
    afterAll(() => fixture?.cleanup());

    it("grows guest mappings without mirroring their addresses in the kernel", async () => {
      const probe = new GuestAddressSpaceProbe();
      let stderr = "";
      const diagnostics: unknown[] = [];
      const host = new NodeKernelHost({
        rootfsImage: "default",
        maxPages: 16_384,
        onStdout: (_pid, bytes) => probe.onStdout(bytes),
        onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
        onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
      });
      try {
        await host.init();
        const bytes = readFileSync(fixture.programPath);
        const result = await probe.run(host, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        expect(result.exitCode, JSON.stringify({ result, stderr, diagnostics })).toBe(0);
        expect(result.stdout).toContain("GUEST ADDRESS SPACE PASS");
        expect(result.errors).toEqual([]);
        expect(stderr).toBe("");
        expect(diagnostics).toEqual([]);
        expect(result.phases.map(phase => phase.name)).toEqual(GUEST_ADDRESS_PHASES);
        expect(result.phases[2].processBytes).toBeGreaterThan(256 * 1024 * 1024);
        expect(result.phases[6].processBytes).toBe(result.phases[5].processBytes);
        for (const phase of result.phases) {
          // Small kernel-owned I/O/metadata allocations remain legitimate.
          expect(phase.kernelBytes, JSON.stringify(result.phases))
            .toBeLessThanOrEqual(result.phases[0].kernelBytes + 4 * 1024 * 1024);
        }
      } finally {
        await host.destroy();
      }
    }, 60_000);
  });
}
