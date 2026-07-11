import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/clock_getcpuclockid_test.wasm");

describe.skipIf(!existsSync(program))("encoded process CPU clock IDs", () => {
  it("maps an invalid negative pid to ESRCH and rejects positive clock ID 10", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["clock_getcpuclockid_test"],
      useDefaultRootfs: false,
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS clock id validation");
    expect(result.stderr).toBe("");
  });
});
