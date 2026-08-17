import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(
  repoRoot,
  "local-binaries/programs/wasm32/pty-ownership.wasm",
);

describe("persistent devpts ownership, mode, and permissions", () => {
  it("uses authoritative PTY metadata for the full pair lifetime", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["pty-ownership"],
      timeout: 20_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("PTY_OWNERSHIP_PASS");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  });
});
