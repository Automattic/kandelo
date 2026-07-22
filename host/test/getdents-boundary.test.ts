import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/getdents_boundary_test.wasm");

describe.skipIf(!existsSync(program))("getdents64 directory cursor", () => {
  it("returns every entry across buffer boundaries, rewinds, and saved positions", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["getdents-boundary-test"],
      useDefaultRootfs: false,
      timeout: 30_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("GETDENTS_BOUNDARY_PASS");
    expect(result.stderr).toBe("");
  });
});
