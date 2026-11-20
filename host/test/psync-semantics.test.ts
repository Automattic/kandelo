/**
 * POSIX process-shared synchronization, case by case, on Node.
 *
 * `examples/psync_semantics_test.c` runs each case in its own process under a
 * deadline and reports PASS or DIVERGE. The expected result of every case is
 * recorded in `fixtures/psync-semantics.ts`, so known gaps stay visible and
 * each fix must flip its entry. The Chromium spec checks the same table.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { checkPsyncSemantics } from "./fixtures/psync-semantics";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/psync_semantics_test.wasm");

describe("process-shared synchronization", () => {
  it("matches the recorded result of every case", async () => {
    // A supported fixture must be built, not skipped.
    expect(existsSync(programPath), `${programPath}: run scripts/build-programs.sh`).toBe(true);
    const result = await runCentralizedProgram({
      programPath,
      argv: ["psync_semantics_test"],
      timeout: 240_000,
      useDefaultRootfs: false,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(checkPsyncSemantics(result.stdout), result.stdout).toEqual([]);
  }, 300_000);
});
