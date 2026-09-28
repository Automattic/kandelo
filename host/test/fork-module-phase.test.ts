import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHILD_PID,
  DIAGNOSTIC_RUN_FAILED,
  MODE_FORK,
  MODE_VFORK,
  PHASE_CAPTURE,
  PHASE_IDLE,
  PHASE_PARENT_REPLAY,
  RUN_FAILED_BAD_PHASE,
  RUN_FAILED_MODE_MISMATCH,
  RUN_FAILED_RETURN_MID_CONTINUATION,
  RUN_FAILED_UNWIND_OUTSIDE_CAPTURE,
  fixture,
  runFork,
  runForkExpectingTrap,
  type Fixture,
} from "./fork-module-capture-fixture";

/**
 * The fork lifecycle phase machine, which the module owns -- and, since lane F
 * step 3c, the run loop that walks it.
 *
 * It used to live in `ForkProcessContinuationCoordinator` as a TypeScript
 * `requirePhase(expected, operation)` in front of every coarse module call,
 * then in the module behind step entries a host called in order. Either way
 * the ORDER was the host's: a host that got it wrong called the module out of
 * order, and all the module could do was refuse the step (EBUSY). Now the
 * module runs the order itself (`fm_run`, `__wpk_fork_kernel_fork`), so what
 * can arrive out of order is the GUEST: an unwind with no capture open, a
 * replay that returns without reaching `fork()`, a `fork()` reached from the
 * middle of a capture or in the other mode. Each is a state no one can resume
 * from, so the run loop reports it through the kernel (`runFailed`) and traps.
 * These tests are those refusals, and that the module is untouched by them
 * where it can be.
 *
 * # Why there is still no phase accessor to assert against
 *
 * `fm_phase` existed so a host could choose the next step; no host chooses
 * one now. Every assertion here is BEHAVIOURAL -- what the run loop refuses,
 * what it reports, and whether the next fork runs -- which is also the
 * stronger claim. An accessor can agree with a broken machine.
 */

/** The run loop's `runFailed` report: the reason and its detail. */
function runFailed(reason: number, detail: number) {
  return { kind: DIAGNOSTIC_RUN_FAILED, values: [reason, detail, 0, 0, 0] };
}

/** A fork that runs to completion, proving the module is back at idle. */
function forksNormally(f: Fixture): boolean {
  (f.x.fm_abort as () => void)();
  return runFork(f).forkReturn === DEFAULT_CHILD_PID;
}

describe("fork run loop phase", () => {
  it("refuses an unwind that reaches it with no capture open", () => {
    // The module's unwind tag is the capture's own transport. One that
    // reaches `fm_run` with nothing captured has no frames to seal: sealing
    // anyway would launch a child from nothing.
    const f = fixture();
    const tag = f.x.__wpk_fork_unwind as WebAssembly.Tag;
    // A guest that throws the transport without calling fork() first.
    f.entries.lexical = () => {
      throw new WebAssembly.Exception(tag, []);
    };
    const before = f.diagnostics().length;
    expect(() => (f.x.fm_run as (k: number, p: number, a: number) => bigint)(0, 0, 0))
      .toThrow(WebAssembly.RuntimeError);
    expect(f.diagnostics().slice(before)).toEqual([
      runFailed(RUN_FAILED_UNWIND_OUTSIDE_CAPTURE, PHASE_IDLE),
    ]);
    expect(forksNormally(f), "and the next fork runs").toBe(true);
  });

  it("refuses a replay entry that returns without reaching fork()", () => {
    // The replayed frames rewind back to the fork() call site, where the
    // fork finishes. An entry that returns with the replay still open would
    // leave the guest running with half its frames restored.
    const f = fixture();
    const { diagnostics } = runForkExpectingTrap(f, { replayReturnsEarly: true });
    expect(diagnostics.at(-1)).toEqual(
      runFailed(RUN_FAILED_RETURN_MID_CONTINUATION, PHASE_PARENT_REPLAY),
    );
    expect(forksNormally(f), "the abandoned fork is abortable").toBe(true);
  });

  it("refuses fork() reached again with the capture still open", () => {
    // `fork()` from the middle of its own capture -- a guest whose frames
    // called it again before unwinding -- is not a nested fork; the capture
    // the first call opened cannot be finished or begun from here.
    const f = fixture();
    const kernelFork = f.x.__wpk_fork_kernel_fork as (mode: number) => number;
    const { diagnostics } = runForkExpectingTrap(f, {
      duringCapture: () => {
        kernelFork(MODE_FORK);
      },
    });
    expect(diagnostics.at(-1)).toEqual(runFailed(RUN_FAILED_BAD_PHASE, PHASE_CAPTURE));
    expect(forksNormally(f)).toBe(true);
  });

  it("refuses a replay that reaches fork() in the other mode", () => {
    // The replay rewinds to the SAME call site, so it must reach the same
    // `fork()` or `vfork()`: another mode means the frames were replayed into
    // a different program point than the one captured.
    const f = fixture();
    const { diagnostics } = runForkExpectingTrap(f, { replayMode: MODE_VFORK });
    expect(diagnostics.at(-1)).toEqual(runFailed(RUN_FAILED_MODE_MISMATCH, MODE_VFORK));
    expect(forksNormally(f)).toBe(true);
  });

  it("refuses a fork mode it does not know, without opening anything", () => {
    // `EINVAL` to the guest, like any bad argument: nothing was captured.
    const f = fixture();
    const kernelFork = f.x.__wpk_fork_kernel_fork as (mode: number) => number;
    expect(kernelFork(7)).toBe(-22);
    expect(runFork(f).forkReturn, "and a fork afterwards runs").toBe(DEFAULT_CHILD_PID);
  });

  it("answers ENOSYS to a fork before activation 0 is registered", () => {
    // A guest that forks before its host registered it (from a start function
    // run at instantiation) has nothing the module could capture.
    const f = fixture();
    const kernelFork = f.x.__wpk_fork_kernel_fork as (mode: number) => number;
    expect(kernelFork(MODE_FORK)).toBe(-38);
  });

  it("does not begin an abort for a frame reserve outside a capture", () => {
    // The mid-unwind abort lives in the frame reserve. A reserve that fails
    // with no capture open is only a failed call: it must not seal or replay
    // anything, so the next fork still runs from idle.
    const f = fixture();
    expect((f.x.__wpk_fork_frame_reserve as (n: number) => number)(16)).toBe(0);
    expect(f.errno()).not.toBe(0);
    expect(runFork(f).forkReturn).toBe(DEFAULT_CHILD_PID);
  });

  it("accepts abort from idle, so a teardown can never be refused", () => {
    // `fm_abort` is the path a failed fork unwinds through (a host's trap
    // guard calls it). A teardown that can itself be refused leaves the
    // process stuck in the phase it is trying to leave, so this one is legal
    // everywhere -- including idle, where there is nothing to tear down.
    const f = fixture();
    (f.x.fm_abort as () => void)();
    expect(f.errno()).toBe(0);
    expect(runFork(f).forkReturn).toBe(DEFAULT_CHILD_PID);
  });

  it("names one wrong-phase errno, used for nothing else in the module", () => {
    // The internal guards still answer EBUSY (a child install or a peer-table
    // checkpoint from the middle of a fork: `fork-module-capture-drive`). If
    // EBUSY ever acquires a second meaning here, those tests stop being able
    // to tell a phase refusal from that other thing.
    const source = readFileSync(
      new URL("../../crates/fork-module/src/lib.rs", import.meta.url),
      "utf8",
    );
    const uses = source.match(/Errno::EBUSY/g) ?? [];
    // Exactly the two guards: `require_phase` and `require_phase_either`.
    expect(uses.length).toBe(2);
  });
});
