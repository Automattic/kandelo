import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * sigsuspend, pause and sigtimedwait are kernel parks.
 *
 * The kernel (`crates/runtime-core/src/wait_signal.rs`) decides how each wait
 * ends -- a signal the mask lets through, a set member taken by
 * `sigtimedwait`, the timeout, or `pthread_cancel` -- and the host only
 * publishes it. These cases replaced the host's 10 ms and 500 ms polls.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/signal-kernel-wait.wasm");

describe.skipIf(!existsSync(binary))("kernel-owned signal waits", () => {
  it("answers every way a signal wait can end", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: binary,
      argv: ["signal-kernel-wait"],
      timeout: 30_000,
    });
    for (const name of [
      "sigsuspend",
      "pause-child",
      "suspend-blocked",
      "timedwait-pending",
      "timedwait-wakes",
      "timedwait-timeout",
      "timedwait-eintr",
      "timedwait-shared",
      "cancel",
    ]) {
      expect(stdout, stderr).toContain(`ok ${name}\n`);
    }
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 40_000);
});
