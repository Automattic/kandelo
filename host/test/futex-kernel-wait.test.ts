import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * The futex wait queue is kernel state.
 *
 * `FUTEX_WAIT` parks the caller in the Rust kernel
 * (`crates/runtime-core/src/wait_park.rs`), and every way out of that park --
 * a `FUTEX_WAKE`, a bitset wake, a requeue, a caught signal, a timeout, a
 * `pthread_cancel`, and the clear-TID wake `pthread_join` waits for -- is a
 * kernel decision the host only publishes. The guest program drives each case
 * through the raw syscall, so libc's own retry loops cannot hide a wrong
 * answer. The native host runs the signal-free cases from the same source
 * (`crates/host-native/fixtures/native_futex.c`).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/futex-kernel-wait.wasm");

describe.skipIf(!existsSync(binary))("kernel-owned futex waits", () => {
  it("answers every way a futex wait can end", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: binary,
      argv: ["futex-kernel-wait"],
      timeout: 30_000,
    });
    for (const name of [
      "mismatch",
      "relative-timeout",
      "absolute-timeout",
      "wake",
      "bitset",
      "requeue",
      "signal",
      "timed-signal",
      "cancel",
    ]) {
      expect(stdout, stderr).toContain(`ok ${name}\n`);
    }
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 40_000);
});
