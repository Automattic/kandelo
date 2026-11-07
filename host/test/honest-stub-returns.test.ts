import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * Two syscalls used to answer 0 without doing anything:
 *
 *  - sync_file_range, which carries durability semantics: a caller told 0
 *    believes its data reached storage. It now performs the whole-file fsync
 *    the dispatcher can reach, so it fails as fsync does (EBADF for a bad
 *    descriptor) and succeeds only on a file it could sync.
 *  - personality, which answered PER_LINUX, a Linux compatibility claim
 *    Kandelo does not make. It is now refused with ENOSYS, and the refusal is
 *    recorded by name in the kernel log.
 *
 * The dispatcher is wasm-only, so a native test cannot call it; this runs a
 * real guest through libc, channel glue, host staging and kernel dispatch. The
 * guest (examples/honest_stub_returns_test.c) judges its own result.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/honest_stub_returns_test.wasm");

describe("honest stub returns", () => {
  it("sync_file_range does the sync it can reach and personality says ENOSYS", async () => {
    const result = await runCentralizedProgram({
      programPath,
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("honest-stub-returns-ok\n");
    expect(result.stderr).toBe("");
  });
});
