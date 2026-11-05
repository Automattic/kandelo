import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * A blocking advisory lock is a kernel park.
 *
 * fcntl(F_SETLKW) and blocking flock() park in the kernel with their request,
 * which the kernel re-executes whenever advisory-lock state changes
 * (`crates/runtime-core/src/wait_retry.rs`); the host only publishes the
 * answer. These cases replaced the host's 10 ms lock retry.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/lock-kernel-wait.wasm");

describe.skipIf(!existsSync(binary))("kernel-owned advisory-lock waits", () => {
  it("answers every way a blocking lock request can end", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: binary,
      argv: ["lock-kernel-wait"],
      timeout: 30_000,
    });
    for (const name of [
      "setlkw",
      "nonblocking",
      "flock",
      "signal-eintr",
      "signal-restart",
      "cancel",
    ]) {
      expect(stdout, stderr).toContain(`ok ${name}\n`);
    }
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 40_000);
});
