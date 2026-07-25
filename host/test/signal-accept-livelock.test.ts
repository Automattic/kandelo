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
import {
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
} from "../src/generated/abi";

const SIGCHLD = 17;
const SIGTERM = 15;
const SYS_TKILL = 204;

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
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
        kernel_set_current_tid: () => 0,
        kernel_pick_signal_target_tid: (pid: number) => pid,
        kernel_thread_has_deliverable: () => 1,
        kernel_get_process_exit_signal: () => -1,
      },
    },
    kernelMemory: createSharedMemory(),
    scratchOffset: 128,
    processes: new Map(),
    channelTids: new Map(),
    pendingSleeps: new Map(),
    pendingSignalWaits: new Map(),
    signalWaitDeadlines: new Map(),
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

  it("interrupts only the sleeping thread selected for a shared signal", () => {
    vi.useFakeTimers();
    try {
      const worker = createWorkerHarness();
      const pid = 44;
      const threadTid = 45;
      const mainChannel = createChannel(pid, 0);
      const threadChannel = createChannel(pid, 256);
      const mainTimer = setTimeout(() => {}, 60_000);
      const threadTimer = setTimeout(() => {}, 60_000);
      const mainSleep = {
        timer: mainTimer,
        channel: mainChannel,
        syscallNr: 1,
        origArgs: [],
        retVal: 0,
        errVal: 0,
      };
      const threadSleep = {
        timer: threadTimer,
        channel: threadChannel,
        syscallNr: 1,
        origArgs: [],
        retVal: 0,
        errVal: 0,
      };
      worker.processes.set(pid, { channels: [mainChannel, threadChannel] });
      worker.channelTids.set(`${pid}:${threadChannel.channelOffset}`, threadTid);
      worker.pendingSleeps.set(mainChannel, mainSleep);
      worker.pendingSleeps.set(threadChannel, threadSleep);
      worker.kernelInstance.exports.kernel_pick_signal_target_tid = vi.fn(
        () => threadTid,
      );
      // Model a caught SIGCHLD still pending for the selected pthread.
      worker.completeSleepWithSignalCheck = vi.fn();

      worker.sendSignalToProcess(pid, SIGCHLD);

      expect(
        worker.kernelInstance.exports.kernel_pick_signal_target_tid,
      ).toHaveBeenCalledWith(pid, SIGCHLD);
      expect(worker.pendingSleeps.get(mainChannel)).toBe(mainSleep);
      expect(worker.pendingSleeps.has(threadChannel)).toBe(false);
      expect(worker.completeSleepWithSignalCheck).toHaveBeenCalledOnce();
      expect(worker.completeSleepWithSignalCheck).toHaveBeenCalledWith(
        threadChannel,
        threadSleep.syscallNr,
        threadSleep.origArgs,
        threadSleep.retVal,
        threadSleep.errVal,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a sleeping pthread's exact TID when dequeuing its pending signal", () => {
    const worker = createWorkerHarness();
    const pid = 46;
    const tid = 47;
    const channel = createChannel(pid, 256);
    const setCurrentTid = vi.fn(() => 0);
    const dequeueSignal = vi.fn(() => 0);
    worker.channelTids.set(`${pid}:${channel.channelOffset}`, tid);
    worker.kernelInstance.exports.kernel_set_current_tid = setCurrentTid;
    worker.kernelInstance.exports.kernel_dequeue_signal = dequeueSignal;
    worker.completeChannel = vi.fn();

    worker.completeSleepWithSignalCheck(channel, 1, [], 0, 0);

    expect(setCurrentTid).not.toHaveBeenCalled();
    expect(dequeueSignal).toHaveBeenCalledWith(pid, tid, expect.any(Number));
  });

  it("does not rebind an ordinary synchronous signal dequeue", () => {
    const worker = createWorkerHarness();
    const pid = 48;
    const channel = createChannel(pid, 0);
    const setCurrentTid = vi.fn(() => 0);
    worker.channelTids.set(`${pid}:${channel.channelOffset}`, pid);
    worker.kernelInstance.exports.kernel_set_current_tid = setCurrentTid;
    const dequeueSignal = vi.fn(() => 0);
    worker.kernelInstance.exports.kernel_dequeue_signal = dequeueSignal;

    worker.dequeueSignalForDelivery(channel);

    expect(setCurrentTid).not.toHaveBeenCalled();
    expect(dequeueSignal).toHaveBeenCalledWith(pid, pid, expect.any(Number));
  });

  it("fails closed when Rust rejects an exact signal dequeue task", () => {
    const worker = createWorkerHarness();
    const pid = 48;
    const tid = 49;
    const channel = createChannel(pid, 256);
    worker.channelTids.set(`${pid}:${channel.channelOffset}`, tid);
    worker.kernelInstance.exports.kernel_dequeue_signal = vi.fn(() => -3);

    expect(() => worker.dequeueSignalForDelivery(channel)).toThrow(
      /Kernel rejected signal dequeue/,
    );
  });

  it("does not resume a sleeping pthread after dequeue terminates it", () => {
    const worker = createWorkerHarness();
    const pid = 49;
    const tid = 50;
    const channel = createChannel(pid, 256);
    let exited = false;
    worker.channelTids.set(`${pid}:${channel.channelOffset}`, tid);
    worker.kernelInstance.exports.kernel_dequeue_signal = vi.fn(() => {
      exited = true;
      return 0;
    });
    worker.getProcessExitSignal = vi.fn(() => exited ? SIGTERM : -1);
    worker.handleProcessTerminated = vi.fn();
    worker.completeChannel = vi.fn();

    worker.completeSleepWithSignalCheck(channel, 1, [], 0, 0);

    expect(worker.handleProcessTerminated).toHaveBeenCalledWith(channel);
    expect(worker.completeChannel).not.toHaveBeenCalled();
  });

  it("leaves a sleep parked when the kernel consumed an ignored signal", () => {
    vi.useFakeTimers();
    try {
      const worker = createWorkerHarness();
      const pid = 51;
      const channel = createChannel(pid, 0);
      const timer = setTimeout(() => {}, 60_000);
      const sleep = {
        timer,
        channel,
        syscallNr: 1,
        origArgs: [],
        retVal: 0,
        errVal: 0,
      };
      worker.processes.set(pid, { channels: [channel] });
      worker.pendingSleeps.set(channel, sleep);
      worker.kernelInstance.exports.kernel_thread_has_deliverable = vi.fn(
        () => 0,
      );
      worker.completeSleepWithSignalCheck = vi.fn();
      worker.retrySyscall = vi.fn();
      worker.handlePselect6 = vi.fn();
      const pollEntry = { timer: null, channel };
      const selectEntry = {
        timer: setTimeout(() => {}, 60_000),
        channel,
        origArgs: [],
        syscallNr: 0,
      };
      worker.pendingPollRetries.set(channel, pollEntry);
      worker.pendingSelectRetries.set(channel, selectEntry);

      worker.sendSignalToProcess(pid, SIGCHLD);

      expect(worker.pendingSleeps.get(channel)).toBe(sleep);
      expect(worker.pendingPollRetries.get(channel)).toBe(pollEntry);
      expect(worker.pendingSelectRetries.get(channel)).toBe(selectEntry);
      expect(worker.completeSleepWithSignalCheck).not.toHaveBeenCalled();
      expect(worker.retrySyscall).not.toHaveBeenCalled();
      expect(worker.handlePselect6).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps a default-terminated process without resuming its channel", () => {
    const worker = createWorkerHarness();
    const pid = 52;
    const pickSignalTarget = vi.fn(() => pid);
    worker.kernelInstance.exports.kernel_pick_signal_target_tid = pickSignalTarget;
    worker.reapKilledProcessesAfterSyscall = vi.fn();
    worker.getProcessExitSignal = vi.fn(() => SIGTERM);

    worker.sendSignalToProcess(pid, SIGTERM);

    expect(worker.reapKilledProcessesAfterSyscall).toHaveBeenCalledOnce();
    expect(pickSignalTarget).not.toHaveBeenCalled();
  });

  it("does not wake blocked channels when queuing the signal traps", () => {
    const worker = createWorkerHarness();
    const pid = 53;
    const pickSignalTarget = vi.fn(() => pid);
    const reaper = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      worker.kernelInstance.exports.kernel_handle_channel = () => {
        throw new Error("synthetic kernel trap");
      };
      worker.kernelInstance.exports.kernel_pick_signal_target_tid = pickSignalTarget;
      worker.reapKilledProcessesAfterSyscall = reaper;

      worker.sendSignalToProcess(pid, SIGTERM);

      expect(reaper).not.toHaveBeenCalled();
      expect(pickSignalTarget).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("does not change the ambient host PID when signal TID binding is rejected", () => {
    const worker = createWorkerHarness();
    const targetPid = 54;
    const priorPid = 91;
    const setCurrentTid = vi.fn(() => -3);
    const handleChannel = vi.fn();
    worker.currentHandlePid = priorPid;
    worker.kernelInstance.exports.kernel_set_current_tid = setCurrentTid;
    worker.kernelInstance.exports.kernel_handle_channel = handleChannel;

    worker.sendSignalToProcess(targetPid, SIGTERM);

    expect(setCurrentTid).toHaveBeenCalledWith(targetPid, targetPid);
    expect(handleChannel).not.toHaveBeenCalled();
    expect(worker.currentHandlePid).toBe(priorPid);
  });

  it("does not downgrade a successful directed tkill to a shared waiter wake", () => {
    const worker = createWorkerHarness();
    const pid = 55;
    const targetTid = 56;
    const channel = createChannel(pid, 0);
    worker.channelTids.set(`${pid}:${channel.channelOffset}`, pid);
    const processView = new DataView(channel.memory.buffer);
    processView.setUint32(CH_SYSCALL, SYS_TKILL, true);
    processView.setBigInt64(CH_ARGS, BigInt(targetTid), true);
    processView.setBigInt64(CH_ARGS + CH_ARG_SIZE, BigInt(SIGCHLD), true);

    Object.assign(worker, {
      config: { enableSyscallLog: false },
      syscallRing: new Map(),
      syscallTraceEnabled: false,
      sharedMmapBackings: new Map(),
      hostReaped: new Set(),
      synchronizeSharedMemoryForBoundary: vi.fn(),
      dequeueSignalForDelivery: vi.fn(() => false),
      handlePendingInetConnect: vi.fn(() => false),
      handleFlockConflict: vi.fn(() => false),
      handleSleepDelay: vi.fn(() => false),
      drainAndProcessWakeupEvents: vi.fn(),
      scheduleWakeBlockedRetries: vi.fn(),
      reapKilledProcessesAfterSyscall: vi.fn(),
      wakePendingSignalWaits: vi.fn(),
      completeChannel: vi.fn(),
      currentHandlePid: 0,
    });
    const exactWake = vi.fn(() => false);
    const sharedWake = vi.fn();
    worker.interruptWaitingChildForDirectedSignal = exactWake;
    worker.interruptWaitingChildrenForGeneratedSignal = sharedWake;
    worker.kernelInstance.exports.kernel_handle_channel = vi.fn(() => {
      const kernelView = new DataView(
        worker.kernelMemory.buffer,
        worker.scratchOffset,
      );
      kernelView.setBigInt64(CH_RETURN, 0n, true);
      kernelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    worker._handleSyscallInner(channel);

    expect(exactWake).toHaveBeenCalledWith(pid, targetTid);
    expect(sharedWake).not.toHaveBeenCalled();
  });
});
