/**
 * Regression test for a kernel-worker deadlock: delivering a signal to a
 * process that is blocked in a non-interruptible re-parking syscall (notably
 * `accept()`, which has no EINTR path) must not livelock.
 *
 * `sendSignalToProcess` / `notifyPipeReadable` iterate `pendingPollRetries`
 * and, for each matching entry, delete it and synchronously `retrySyscall`.
 * A blocked `accept()` re-runs, returns EAGAIN, and re-registers under the
 * SAME channel key. A raw `for..of` over the live Map revisits the
 * re-inserted entry forever (JS Map iterators are not snapshots), spinning
 * the single kernel-worker thread and wedging the whole machine.
 *
 * Observed as: a forking SMTP daemon (msmtpd) delivering a WordPress
 * password-reset / new-blog email. Its master sits in `accept()`; the
 * per-connection session child exits and the resulting SIGCHLD delivery
 * livelocked the kernel — the reset request (and every other request) hung
 * forever. Fix: snapshot the entries before iterating (mirrors the existing
 * `wakeBlockedPoll` / `wakeAllBlockedRetries` pattern).
 */
import { describe, expect, it, vi } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const SIGCHLD = 17;

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
}

function createChannel(pid: number, channelOffset: number): any {
  return { pid, memory: createSharedMemory(), channelOffset };
}

/** A worker whose kernel exports are all inert — signal delivery is
 *  best-effort host bookkeeping, so the kernel side is a no-op here. */
function createWorkerHarness(): any {
  const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (v: number | bigint) => (typeof v === "bigint" ? Number(v) : v) },
    kernelInstance: {
      exports: {
        kernel_handle_channel: () => 0,
        kernel_set_current_tid: () => {},
        kernel_is_signal_blocked: () => 0, // deliverable — proceed to the wake loops
      },
    },
    kernelMemory: createSharedMemory(),
    scratchOffset: 128,
    processes: new Map(),
    pendingSleeps: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
  });
  return worker;
}

describe("signal delivery to a process blocked in accept()", () => {
  it("does not livelock when retrySyscall re-parks the same poll key", () => {
    const worker = createWorkerHarness();
    const targetPid = 42;
    const channelOffset = 0;
    const channel = createChannel(targetPid, channelOffset);

    worker.processes.set(targetPid, { channels: [channel] });

    // The accept()'s parked-retry entry, keyed by exact channel (matches
    // handleBlockingRetry's registration for SYS_ACCEPT).
    const makeEntry = () => ({
      timer: null,
      channel,
      pipeIndices: [],
      acceptIndices: [7],
    });
    worker.pendingPollRetries.set(channel, makeEntry());

    // Model accept() re-parking: every retry re-inserts the SAME key, exactly
    // as the real EAGAIN path does. Cap the re-insertions so a *regressed*
    // (livelocking) implementation still terminates the test with a wrong
    // count instead of hanging the whole suite forever.
    let retryCount = 0;
    worker.retrySyscall = vi.fn(() => {
      retryCount++;
      if (retryCount < 5000) {
        worker.pendingPollRetries.set(channel, makeEntry());
      }
    });

    worker.sendSignalToProcess(targetPid, SIGCHLD);

    // With the snapshot fix, the parked accept is retried exactly once. The
    // pre-fix live-Map iteration would revisit the re-inserted key until the
    // 5000-cap kicks in.
    expect(retryCount).toBe(1);
  });

  it("notifyPipeReadable does not livelock on a re-parking poll watching the pipe", () => {
    const worker = createWorkerHarness();
    const targetPid = 43;
    const channelOffset = 0;
    const pipeIdx = 11;
    const channel = createChannel(targetPid, channelOffset);
    worker.processes.set(targetPid, { channels: [channel] });
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.scheduleWakeBlockedRetries = () => {};

    const makeEntry = () => ({ timer: null, channel, pipeIndices: [pipeIdx], acceptIndices: [] });
    worker.pendingPollRetries.set(channel, makeEntry());

    let retryCount = 0;
    worker.retrySyscall = vi.fn(() => {
      retryCount++;
      if (retryCount < 5000) worker.pendingPollRetries.set(channel, makeEntry());
    });

    worker.notifyPipeReadable(pipeIdx);

    expect(retryCount).toBe(1);
  });
});
