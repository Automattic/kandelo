import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * A sleep is a kernel park with a deadline.
 *
 * `nanosleep`, `clock_nanosleep` and `usleep` park the caller in the Rust
 * kernel (`crates/runtime-core/src/wait_park.rs`); the deadline, a caught
 * signal (with the `rem` write POSIX requires), and `pthread_cancel` are
 * kernel decisions the host only publishes. The native host runs the
 * signal-free cases from the same source
 * (`crates/host-native/fixtures/native_sleep.c`).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/sleep-kernel-wait.wasm");

describe.skipIf(!existsSync(binary))("kernel-owned sleeps", () => {
  it("answers every way a sleep can end", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: binary,
      argv: ["sleep-kernel-wait"],
      timeout: 30_000,
    });
    for (const name of [
      "duration",
      "zero",
      "invalid",
      "absolute",
      "usleep",
      "threads",
      "cancel",
      "signal-rem",
      "sleep-left",
      "signal-absolute",
      "blocked-signal",
    ]) {
      expect(stdout, stderr).toContain(`ok ${name}\n`);
    }
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 40_000);
});
