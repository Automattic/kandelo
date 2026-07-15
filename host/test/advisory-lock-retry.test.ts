import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ERRNO,
  CH_RETURN,
  PROCESS_STATE_RUNNING,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const EAGAIN = 11;
const EINTR = 4;
const ENOLCK = 37;
const F_SETLKW = 7;
const FLOCK_PTR = 512;
const SYS_FLOCK = 121;
const LOCK_EX = 2;
const LOCK_NB = 4;
const WAKE_ADVISORY_LOCK = 64;

describe("Rust-owned advisory-lock retry scheduling", () => {
  it("parks only a conflicting blocking request, not ENOLCK", () => {
    const conflict = createFcntlHarness(EAGAIN);
    conflict.worker.handleFcntlLock(conflict.channel, [3, F_SETLKW, FLOCK_PTR, 0, 0, 0]);

    const parked = conflict.worker.pendingAdvisoryLockRetries.get(conflict.channel);
    expect(parked).toBeDefined();
    expect(conflict.worker.completeChannel).not.toHaveBeenCalled();
    clearTimeout(parked.timer);

    const exhausted = createFcntlHarness(ENOLCK);
    exhausted.worker.handleFcntlLock(exhausted.channel, [3, F_SETLKW, FLOCK_PTR, 0, 0, 0]);

    expect(exhausted.worker.pendingAdvisoryLockRetries.size).toBe(0);
    expect(exhausted.worker.completeChannel).toHaveBeenCalledWith(
      exhausted.channel,
      expect.any(Number),
      [3, F_SETLKW, FLOCK_PTR, 0, 0, 0],
      undefined,
      -1,
      ENOLCK,
    );
  });

  it("completes a conflicting blocking request with EINTR for a caught signal", () => {
    const interrupted = createFcntlHarness(EAGAIN, 10);
    const args = [3, F_SETLKW, FLOCK_PTR, 0, 0, 0];

    interrupted.worker.handleFcntlLock(interrupted.channel, args);

    expect(interrupted.worker.pendingAdvisoryLockRetries.size).toBe(0);
    expect(interrupted.worker.completeChannel).toHaveBeenCalledWith(
      interrupted.channel,
      expect.any(Number),
      args,
      undefined,
      -1,
      EINTR,
    );
  });

  it("retries parked lock requests only from the advisory-lock wake bit", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(9, processMemory);
    const drain = vi.fn((outPtr: number) => {
      const view = new DataView(kernelMemory.buffer);
      view.setUint32(outPtr, 0, true);
      view.setUint8(outPtr + 4, WAKE_ADVISORY_LOCK);
      return 1;
    });
    const worker = createWorker({ kernel_drain_wakeup_events: drain });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[channel.pid, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.pendingAdvisoryLockRetries = new Map();
    worker.scheduleWakeBlockedRetries = vi.fn();
    worker.retrySyscall = vi.fn();

    const timer = setTimeout(() => undefined, 1_000);
    worker.pendingAdvisoryLockRetries.set(channel, { timer, channel });

    worker.drainAndProcessWakeupEvents();

    expect(worker.retrySyscall).toHaveBeenCalledOnce();
    expect(worker.retrySyscall).toHaveBeenCalledWith(channel);
    expect(worker.pendingAdvisoryLockRetries.size).toBe(0);
    expect(worker.scheduleWakeBlockedRetries).not.toHaveBeenCalled();
  });

  it("retires a parked lock request when its exact channel is removed", () => {
    const memory = createSharedMemory();
    const channel = createChannel(12, memory);
    const worker = createWorker({});
    worker.waitingForChild = [];
    worker.pendingAdvisoryLockRetries = new Map();
    const timer = setTimeout(() => undefined, 1_000);
    worker.pendingAdvisoryLockRetries.set(channel, { timer, channel });

    worker.retireExactChannelAsyncState(channel);

    expect(worker.pendingAdvisoryLockRetries.size).toBe(0);
  });

  it("drains Rust lock wakes after direct process removal", () => {
    const remove = vi.fn(() => 0);
    const worker = createWorker({ kernel_remove_process: remove });
    worker.drainAndProcessWakeupEvents = vi.fn();

    worker.removeFromKernelProcessTable(12);

    expect(remove).toHaveBeenCalledWith(12);
    expect(worker.drainAndProcessWakeupEvents).toHaveBeenCalledOnce();
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      worker.drainAndProcessWakeupEvents.mock.invocationCallOrder[0],
    );
  });

  it("drains Rust lock wakes after normal process exit", () => {
    const memory = createSharedMemory();
    const channel = createChannel(18, memory);
    const handleChannel = vi.fn(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
    const worker = createWorker({ kernel_handle_channel: handleChannel });
    worker.kernelMemory = createSharedMemory();
    worker.processes = new Map([[channel.pid, { channels: [channel], memory }]]);
    worker.releaseAllSharedMemoryForProcess = vi.fn();
    worker.getProcessExitSignal = vi.fn(() => -1);
    worker.discardStoppedChannelStateForProcess = vi.fn();
    worker.drainAndProcessWakeupEvents = vi.fn();
    worker.notifyParentOfExitedProcess = vi.fn();
    worker.completeChannelRaw = vi.fn();
    worker.scheduleWakeBlockedRetries = vi.fn();
    worker.callbacks = {};

    worker.handleExit(channel, ABI_SYSCALLS.ExitGroup, [0]);

    expect(worker.drainAndProcessWakeupEvents).toHaveBeenCalledOnce();
    expect(handleChannel.mock.invocationCallOrder[0]).toBeLessThan(
      worker.drainAndProcessWakeupEvents.mock.invocationCallOrder[0],
    );
  });

  it("drains Rust lock wakes before signal-termination notifications", () => {
    const memory = createSharedMemory();
    const channel = createChannel(20, memory);
    const worker = createWorker({
      kernel_get_process_exit_signal: vi.fn(() => 9),
    });
    worker.processes = new Map([[channel.pid, { channels: [channel], memory }]]);
    worker.discardStoppedChannelStateForProcess = vi.fn();
    worker.releaseAllSharedMemoryForProcess = vi.fn();
    worker.drainAndProcessWakeupEvents = vi.fn();
    worker.notifyParentOfExitedProcess = vi.fn();
    worker.callbacks = { onExit: vi.fn() };

    worker.handleProcessTerminated(channel);

    expect(worker.drainAndProcessWakeupEvents).toHaveBeenCalledOnce();
    expect(worker.notifyParentOfExitedProcess).toHaveBeenCalledWith(channel.pid);
    expect(worker.callbacks.onExit).toHaveBeenCalledWith(channel.pid, 137);
    expect(
      worker.releaseAllSharedMemoryForProcess.mock.invocationCallOrder[0],
    ).toBeLessThan(
      worker.drainAndProcessWakeupEvents.mock.invocationCallOrder[0],
    );
    expect(
      worker.drainAndProcessWakeupEvents.mock.invocationCallOrder[0],
    ).toBeLessThan(
      worker.notifyParentOfExitedProcess.mock.invocationCallOrder[0],
    );
    expect(
      worker.drainAndProcessWakeupEvents.mock.invocationCallOrder[0],
    ).toBeLessThan(worker.callbacks.onExit.mock.invocationCallOrder[0]);
  });

  it("drains Rust lock wakes after both exec cleanup phases", () => {
    const prepare = vi.fn(() => -5);
    const setup = vi.fn(() => -5);
    const worker = createWorker({
      kernel_exec_prepare: prepare,
      kernel_exec_setup_for_thread: setup,
    });
    worker.drainAndProcessWakeupEvents = vi.fn();
    worker.snapshotExecTcpListenerWakeIds = vi.fn(() => new Map());

    expect(worker.kernelExecPrepare(19)).toBe(-5);
    expect(worker.kernelExecSetup(19)).toBe(-5);

    expect(worker.drainAndProcessWakeupEvents).toHaveBeenCalledTimes(2);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      worker.drainAndProcessWakeupEvents.mock.invocationCallOrder[0],
    );
    expect(setup.mock.invocationCallOrder[0]).toBeLessThan(
      worker.drainAndProcessWakeupEvents.mock.invocationCallOrder[1],
    );
  });

  it("retires old-image lock retries at exec handoff", () => {
    const memory = createSharedMemory();
    const oldChannel = createChannel(16, memory);
    const peerChannel = createChannel(17, memory);
    const worker = createWorker({});
    worker.processes = new Map([[16, { channels: [oldChannel], memory }]]);
    worker.activeChannels = [oldChannel, peerChannel];
    worker.pendingAdvisoryLockRetries = new Map();
    const oldTimer = setTimeout(() => undefined, 1_000);
    const peerTimer = setTimeout(() => undefined, 1_000);
    worker.pendingAdvisoryLockRetries.set(oldChannel, {
      timer: oldTimer,
      channel: oldChannel,
    });
    worker.pendingAdvisoryLockRetries.set(peerChannel, {
      timer: peerTimer,
      channel: peerChannel,
    });
    worker.discardStoppedChannelStateForProcess = vi.fn();
    worker.cleanupPendingPollRetries = vi.fn();
    worker.cleanupPendingSelectRetries = vi.fn();
    worker.cleanupPendingSignalWaits = vi.fn();
    worker.cleanupPendingPipeReaders = vi.fn();
    worker.cleanupPendingPipeWriters = vi.fn();
    worker.waitingForChild = [];
    worker.cancelPendingSleepsForProcess = vi.fn();
    worker.pendingFutexWaits = new Map();
    worker.pendingCancels = new Set();
    worker.threadForkContexts = new Map();
    worker.threadCtidPtrs = new Map();
    worker.posixTimers = new Map();
    worker.socketTimeoutTimers = new Map();

    worker.prepareProcessForExec(16);

    expect(worker.pendingAdvisoryLockRetries.has(oldChannel)).toBe(false);
    expect(worker.pendingAdvisoryLockRetries.has(peerChannel)).toBe(true);
    expect(worker.activeChannels).toEqual([peerChannel]);
    expect(worker.processes.get(16).channels).toEqual([]);
    clearTimeout(peerTimer);
  });

  it("interrupts a parked lock request at a thread cancellation point", () => {
    const memory = createSharedMemory();
    const caller = createChannel(13, memory);
    const target = createChannel(13, memory, 256);
    const worker = createWorker({});
    worker.processes = new Map([[13, {
      channels: [caller, target],
      memory,
    }]]);
    worker.channelTids = new Map([["13:256", 99]]);
    worker.pendingCancels = new Set();
    worker.pendingFutexWaits = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingAdvisoryLockRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.waitingForChild = [];
    worker.completeChannelRaw = vi.fn();
    worker.relistenChannel = vi.fn();
    const timer = setTimeout(() => undefined, 1_000);
    worker.pendingAdvisoryLockRetries.set(target, { timer, channel: target });

    worker.handleThreadCancel(caller, [99]);

    expect(worker.pendingAdvisoryLockRetries.size).toBe(0);
    expect(worker.completeChannelRaw).toHaveBeenNthCalledWith(1, caller, 0, 0);
    expect(worker.completeChannelRaw).toHaveBeenNthCalledWith(2, target, -4, 4);
    expect(worker.relistenChannel).toHaveBeenCalledWith(target);
  });

  it("retries a parked lock request so Rust can observe a pending signal", () => {
    const memory = createSharedMemory();
    const channel = createChannel(14, memory);
    const worker = createWorker({
      kernel_pick_signal_target_tid: vi.fn(() => 14),
      kernel_thread_has_deliverable: vi.fn(() => 1),
    });
    worker.kernelMemory = createSharedMemory();
    worker.processes = new Map([[14, { channels: [channel], memory }]]);
    worker.pendingSleeps = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingAdvisoryLockRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.drainAndProcessWakeupEvents = vi.fn();
    worker.reapKilledProcessesAfterSyscall = vi.fn();
    worker.getProcessExitSignal = vi.fn(() => -1);
    worker.interruptWaitingChildForSignal = vi.fn(() => false);
    worker.retrySyscall = vi.fn();
    const timer = setTimeout(() => undefined, 1_000);
    worker.pendingAdvisoryLockRetries.set(channel, { timer, channel });

    worker.sendSignalToProcess(14, 10, false);

    expect(worker.pendingAdvisoryLockRetries.size).toBe(0);
    expect(worker.retrySyscall).toHaveBeenCalledWith(channel);
  });

  it("parks blocking flock but completes LOCK_NB conflicts immediately", () => {
    const memory = createSharedMemory();
    const channel = createChannel(15, memory);
    const worker = createWorker({});
    worker.processes = new Map([[channel.pid, { channels: [channel], memory }]]);
    worker.pendingAdvisoryLockRetries = new Map();
    worker.completeChannel = vi.fn();

    expect(
      worker.handleFlockConflict(
        channel,
        SYS_FLOCK,
        [3, LOCK_EX, 0, 0, 0, 0],
        -1,
        EAGAIN,
        0,
      ),
    ).toBe(true);
    const parked = worker.pendingAdvisoryLockRetries.get(channel);
    expect(parked).toBeDefined();
    expect(worker.completeChannel).not.toHaveBeenCalled();
    clearTimeout(parked.timer);
    worker.pendingAdvisoryLockRetries.clear();

    expect(
      worker.handleFlockConflict(
        channel,
        SYS_FLOCK,
        [3, LOCK_EX | LOCK_NB, 0, 0, 0, 0],
        -1,
        EAGAIN,
        0,
      ),
    ).toBe(true);
    expect(worker.pendingAdvisoryLockRetries.size).toBe(0);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      SYS_FLOCK,
      [3, LOCK_EX | LOCK_NB, 0, 0, 0, 0],
      undefined,
      -1,
      EAGAIN,
    );

    worker.completeChannel.mockClear();
    expect(
      worker.handleFlockConflict(
        channel,
        SYS_FLOCK,
        [3, LOCK_EX, 0, 0, 0, 0],
        -1,
        EAGAIN,
        10,
      ),
    ).toBe(true);
    expect(worker.pendingAdvisoryLockRetries.size).toBe(0);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      SYS_FLOCK,
      [3, LOCK_EX, 0, 0, 0, 0],
      undefined,
      -1,
      EINTR,
    );
  });
});

function createFcntlHarness(
  errno: number,
  caughtSignal = 0,
): { worker: any; channel: any } {
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();
  const channel = createChannel(7, processMemory);
  const worker = createWorker({
    kernel_handle_channel: vi.fn((offset: number) => {
      const view = new DataView(kernelMemory.buffer, offset);
      view.setBigInt64(CH_RETURN, -1n, true);
      view.setUint32(CH_ERRNO, errno, true);
      return 0;
    }),
    kernel_dequeue_signal: vi.fn(() => caughtSignal),
  });
  worker.kernelMemory = kernelMemory;
  worker.processes = new Map([[channel.pid, {
    channels: [channel],
    memory: processMemory,
  }]]);
  worker.pendingAdvisoryLockRetries = new Map();
  worker.completeChannel = vi.fn();
  return { worker, channel };
}

function createWorker(exports: Record<string, unknown>): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => value },
    kernelInstance: {
      exports: {
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_get_process_state: vi.fn(() => PROCESS_STATE_RUNNING),
        ...exports,
      },
    },
    scratchOffset: 128,
    processes: new Map(),
    channelTids: new Map(),
    hostReaped: new Set(),
  });
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}

function createChannel(
  pid: number,
  memory: WebAssembly.Memory,
  channelOffset = 0,
): any {
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer, channelOffset),
    consecutiveSyscalls: 0,
  };
}
