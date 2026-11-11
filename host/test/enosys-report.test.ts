import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * A program that calls a syscall Kandelo has no implementation for is told
 * ENOSYS and nothing else, and may never print it. The kernel log is where
 * that refusal stays visible, so someone assembling an image or porting
 * software can read what the platform lacks.
 *
 * The Rust unit tests prove the reporting call; this is the evidence that the
 * dispatcher's unimplemented-syscall arms reach it, from a real guest through
 * libc, the channel glue, host staging and kernel dispatch, and that an
 * implemented syscall's ordinary failure does not.
 *
 * The guest (examples/enosys_report_test.c) judges its own result. It uses
 * inotify_init1, a deliberate documented refusal in docs/posix-status.md, and
 * fails loudly, rather than passing, should that syscall ever start working.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/enosys_report_test.wasm");

describe("ENOSYS reporting", () => {
  it("records an unimplemented syscall in the kernel log, and only that", async () => {
    const result = await runCentralizedProgram({
      programPath,
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("enosys-report-ok\n");
    expect(result.stderr).toBe("");
  });
});
