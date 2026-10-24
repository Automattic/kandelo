import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * A blocking read/write/recv/send on a kernel pipe is a kernel park: the
 * kernel re-executes it on the caller's own buffer whenever the pipe's
 * readiness changes (`crates/runtime-core/src/wait_retry.rs`).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/transfer-kernel-wait.wasm");

describe.skipIf(!existsSync(binary))("kernel-owned transfer waits", () => {
  it("answers every way a blocking transfer can end", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: binary,
      argv: ["transfer-kernel-wait"],
      timeout: 30_000,
    });
    for (const name of [
      "read",
      "eof",
      "write",
      "socket",
      "signal-eintr",
      "signal-restart",
      "pinned",
      "cancel",
      "signal-pending-at-park",
      "expired-timeout",
      "ping-pong",
      "signal-retargeted",
    ]) {
      expect(stdout, stderr).toContain(`ok ${name}\n`);
    }
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 40_000);
});
