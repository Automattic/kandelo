import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/select_signal_test.wasm");

describe.skipIf(!existsSync(program))("select signal guest", () => {
  it("interrupts select and pselect and restores the pselect mask", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["select_signal_test"],
      useDefaultRootfs: false,
      timeout: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS select and pselect EINTR");
    expect(result.stderr).toBe("");
  });
});
