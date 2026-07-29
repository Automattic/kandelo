import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/accept_signal_test.wasm");

describe.skipIf(!existsSync(program))("accept signal guest", () => {
  it("delivers SIGCHLD before restarting a blocked accept", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["accept_signal_test"],
      useDefaultRootfs: false,
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "PASS accept signal interruption and SA_RESTART",
    );
    expect(result.stderr).toBe("");
  });
});
