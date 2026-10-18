/**
 * CLI smoke for the scummvm package binary: `scummvm --version` runs
 * the full musl + libc++ + SDL2-linked binary to a clean exit without
 * touching video, audio, or input. Node has no GL context, so the
 * visual launcher gate lives in the browser spec
 * (apps/browser-demos/test/kandelo-scummvm.spec.ts).
 *
 * The binary comes from the binary resolver (the same tiers every other
 * program test uses); build it with `./run.sh setup` or
 * `cargo run -p xtask -- build-deps resolve scummvm` first. The test skips
 * when the package has not been built.
 */
import { describe, it, expect } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// WHY the resolver and not the newest ~/.cache/kandelo/programs/scummvm-*
// directory: that cache is shared by every checkout on the machine, so the
// newest entry can belong to another worktree built for a different ABI.
const programBinary = tryResolveBinary("programs/scummvm/scummvm.wasm");

describe("ScummVM CLI", () => {
  it.skipIf(!programBinary)(
    "scummvm --version prints the release banner and exits 0",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["scummvm", "--version"],
        timeout: 30_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("ScummVM 2026.3.0");
    },
  );
});
