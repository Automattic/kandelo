import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

// Clang lowers __int128 division and modulo to compiler-rt builtins that
// the SDK provides from libc/glue/compiler_rt.c. Without them the program
// links (the SDK allows undefined symbols) and imports the builtin from the
// host, so the division traps when it runs.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const programs = [
  ["wasm32", join(repoRoot, "examples/int128_division_test.wasm")],
  ["wasm64", join(repoRoot, "examples/int128_division_test.wasm64.wasm")],
] as const;

describe("128-bit integer division", () => {
  it.each(programs)("%s computes exact quotients and remainders", async (_arch, program) => {
    // global-setup builds both; a missing binary is a build failure, not a skip.
    expect(existsSync(program), `${program} was not built`).toBe(true);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["int128_division_test"],
      useDefaultRootfs: false,
      timeout: 10_000,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS int128 division");
  });
});
