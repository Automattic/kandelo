/** Native artifacts must survive real worker creation and child replay. */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { nativeForkProcessCases } from "./fixtures/native-fork-process-cases";

describe.each(["wasm32", "wasm64"] as const)("native %s process artifacts", (arch) => {
  for (const fixture of nativeForkProcessCases) {
    it(fixture.source, async () => {
      // Use the ordinary SDK, compiler-facts and production post-optimizer.
      // Omit backend selection to exercise the normal native default.
      const program = compileSdkFixture(
        new URL(`../../programs/${fixture.source}.c`, import.meta.url), [],
        { forkInstrument: true, arch },
      );
      try {
        const result = await runCentralizedProgram({
          programPath: program.programPath,
          argv: [fixture.source],
          timeout: 30_000,
          maxPages: fixture.maxPages,
          // These programs need libc, syscalls and workers, but no rootfs files.
          useDefaultRootfs: false,
        });
        const diagnostic = `${result.stdout}\n${result.stderr}`;
        expect(result.exitCode, diagnostic).toBe(0);
        for (const marker of fixture.markers) {
          expect(result.stdout, diagnostic).toContain(marker);
        }
        expect(result.stdout, diagnostic).not.toContain("FAIL:");
        expect(result.stderr).toBe("");
      } finally {
        program.cleanup();
      }
    }, 120_000);
  }
});
