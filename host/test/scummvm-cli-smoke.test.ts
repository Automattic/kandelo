/**
 * CLI smoke for the scummvm package binary: `scummvm --version` runs
 * the full musl + libc++ + SDL2-linked binary to a clean exit without
 * touching video, audio, or input. Node has no GL context, so the
 * visual launcher gate lives in the browser spec
 * (apps/browser-demos/test/kandelo-scummvm.spec.ts).
 *
 * The binary comes from the package cache; build it with
 * `cargo run -p xtask -- build-deps resolve scummvm` first. The test
 * skips when the package has not been built.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCentralizedProgram } from "./centralized-test-helper";

function tryResolveScummvm(): string | null {
  const cacheDir = join(homedir(), ".cache", "kandelo", "programs");
  try {
    const candidates = readdirSync(cacheDir)
      .filter((name) => /^scummvm-\d/.test(name))
      .map((name) => join(cacheDir, name, "scummvm.wasm"))
      .filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

const programBinary = tryResolveScummvm();

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
