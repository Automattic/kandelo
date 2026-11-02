import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

// A timerfd expiry ends a blocked epoll_wait/poll/select/read at the timer's
// deadline instead of at the host's next fallback retry, for one-shot,
// CLOCK_REALTIME, TFD_TIMER_ABSTIME and periodic timers, and for a timer
// armed by another thread after the waiter blocked, and under a multi-thread
// stress of foot's re-armed delayed-render timers, where a lost expiry is a
// stall. The browser counterpart
// is apps/browser-demos/test/timerfd-wake-latency.spec.ts.
describe("timerfd expiry wakes blocked waiters", () => {
  it("wakes epoll, poll, select and read at the deadline", async () => {
    const result = await runCentralizedProgram({
      programPath: join(repoRoot, "examples/timerfd_wake_latency_test.wasm"),
      argv: ["timerfd-wake-latency"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });
    // Record each case's wake latency with the run's evidence.
    console.log(result.stdout.match(/TIMERFD_WAKE(_STRESS)? .*/g)?.join("\n"));
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("TIMERFD_WAKE_PASS");
    expect(result.stdout.match(/TIMERFD_WAKE case=\S+ .* ok$/gm)).toHaveLength(9);
    expect(result.stdout).toMatch(/TIMERFD_WAKE_STRESS threads=\d+ rounds=\d+ stalls=0$/m);
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  }, 90_000);
});
