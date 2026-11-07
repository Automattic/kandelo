import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

for (const arch of ["wasm32", "wasm64"] as const) {
  describe(`mmap zeroing on ${arch}`, () => {
    let fixture: ReturnType<typeof compileSdkFixture>;
    beforeAll(() => {
      fixture = compileSdkFixture(new URL("./fixtures/mmap-zeroing.c", import.meta.url), [], {
        arch, forkInstrument: true,
      });
    }, 120_000);
    afterAll(() => fixture?.cleanup());

    it("clears reused storage and preserves file and remap contents", async () => {
      const result = await runCentralizedProgram({ programPath: fixture.programPath, timeout: 30_000 });
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("MMAP ZEROING PASS");
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
    }, 60_000);
  });
}
