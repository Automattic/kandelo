import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * klogctl() used to be a fake success: the kernel's channel dispatch answered
 * SYS_SYSLOG with a bare 0, so a program asking for the kernel log was told
 * it had succeeded and handed nothing. Kandelo syscall 304 now routes to
 * the kernel message ring, and this is the end-to-end evidence for that route
 * — a real guest, a real libc klogctl(), the channel glue, host argument
 * staging and kernel dispatch.
 *
 * The guest judges its own result (examples/klogctl_test.c); its strongest
 * assertion is that SIZE_BUFFER reports 131072, a number only the kernel's
 * ring holds. The action table itself is unit-tested in
 * crates/runtime-core/src/syscalls.rs.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/klogctl_test.wasm");

describe("klogctl", () => {
  it("reaches the kernel message ring instead of being refused in the glue", async () => {
    const result = await runCentralizedProgram({
      programPath,
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("klogctl-ok\n");
    expect(result.stderr).toBe("");
  });

  // The program branches on its own `geteuid()`, so running it unprivileged
  // exercises the other half of the clear gate: reads stay unrestricted, and
  // the clearing actions refuse with EPERM — including when they are also
  // handed a buffer they do not take, which must not downgrade the refusal to
  // EINVAL and hide the authority failure behind an unrelated one.
  it("refuses a non-root clear while leaving its reads alone", async () => {
    const result = await runCentralizedProgram({
      programPath,
      timeout: 60_000,
      useDefaultRootfs: false,
      uid: 1000,
      gid: 1000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("klogctl-ok\n");
    expect(result.stderr).toBe("");
  });
});
