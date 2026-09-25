/**
 * Regression test for a bug that silently broke libc-test's
 * `regression/daemon-failure`:
 *
 * Initial PID must not be 1. daemon-failure checks `getppid() != 1` as the
 *    "daemon did not detach" condition. If the test harness spawns user
 *    programs at pid 1, forked children see ppid=1 and the test misfires.
 *    (Regressed when PR #289 reset the former host allocator to 1.) The Rust
 *    kernel now reserves PID 1 and allocates every user-process PID itself.
 */
import { describe, it, expect } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// Through the resolver, not host/wasm/sh.wasm: that copy is made once and
// never refreshed, so it outlived the instrumentation it was built with and
// the host refused it before `_start`.
const shellBinary = tryResolveBinary("programs/dash.wasm");

describe.skipIf(shellBinary === null)("popen/daemon regression gates", () => {
  it("initial user-program PID is not 1 (reserved for init)", async () => {
    // daemon-failure's orphan check fires on `getppid() == 1`, so the test
    // harness must not spawn user programs at pid 1.
    const result = await runCentralizedProgram({
      programPath: shellBinary!,
      argv: ["dash", "-c", "echo $$"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    const pid = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(1);
  });
});
