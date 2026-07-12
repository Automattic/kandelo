import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const program = join(__dirname, "../../examples/environment_lifecycle_test.wasm");

describe("process environment lifecycle", () => {
  it("keeps initial, forked, replacement, and empty environments coherent", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["/bin/environment-lifecycle"],
      env: ["INITIAL=parent", "REMOVE=before-fork"],
      execPrograms: new Map([["/bin/environment-lifecycle", program]]),
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FORK_ENV_PASS");
    expect(result.stdout).toContain("EXEC_ENV_PASS");
    expect(result.stdout).toContain("EMPTY_ENV_PASS");
    expect(result.stderr).toBe("");
  });
});
