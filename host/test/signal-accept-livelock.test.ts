/**
 * Regression coverage for signal and pipe wakeups that snapshot retry maps.
 *
 * A blocked accept can synchronously re-park under the same channel key.
 * Iterating a live Map after deleting and reinserting that key revisits it
 * forever, wedging the dedicated kernel worker. These tests use a genuine
 * gated Wasm instance and the sealed worker's exact test authority; they do
 * not replace methods or install raw kernel exports on the worker.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import {
  allocateKernelScratchRegion,
} from "../src/kernel-scratch";
import {
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  KERNEL_SCRATCH_SIGNAL_DELIVERY_BYTES,
} from "../src/generated/abi";
import {
  createKernelScratchTestInstance,
} from "./support/kernel-scratch-instance";

const SIGCHLD = 17;
const SIGTERM = 15;
const SYS_TKILL = 204;
const SCRATCH_OFFSET = 4096;

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

interface SignalHarness {
  readonly worker: ReturnType<typeof createCentralizedKernelWorkerTestDouble>;
  readonly implementations: Record<string, unknown>;
  readonly completeChannel: ReturnType<typeof vi.fn>;
  readonly onExit: ReturnType<typeof vi.fn>;
  readonly onKernelFatal: ReturnType<typeof vi.fn>;
  readonly kernelMemory: WebAssembly.Memory;
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
}

function createChannel(
  pid: number,
  channelOffset = 0,
  memory = createSharedMemory(),
): TestChannel {
  const channel: TestChannel = {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(
      memory.buffer,
      channelOffset,
      CH_TOTAL_SIZE / Int32Array.BYTES_PER_ELEMENT,
    ),
    consecutiveSyscalls: 0,
    handling: true,
  };
  const view = new DataView(memory.buffer, channelOffset);
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  for (let index = 0; index < CH_ARGS_COUNT; index++) {
    view.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, 0n, true);
  }
  return channel;
}

function createWorkerHarness(): SignalHarness {
  const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const completeChannel = vi.fn();
  const onExit = vi.fn();
  const onKernelFatal = vi.fn();
  const implementations: Record<string, unknown> = {};
  implementations.kernel_set_current_tid = () => 0;
  implementations.kernel_handle_channel = (
    pointer: number | bigint,
  ) => {
    const view = new DataView(kernelMemory.buffer, Number(pointer));
    view.setBigInt64(CH_RETURN, 0n, true);
    view.setUint32(CH_ERRNO, 0, true);
    return 0;
  };
  implementations.kernel_pick_signal_target_tid = (pid: number) => pid;
  implementations.kernel_thread_has_deliverable = () => 1;
  implementations.kernel_get_process_exit_signal = () => -1;
  implementations.kernel_get_process_exit_status = () => -1;
  implementations.kernel_get_parent_pid = () => 0;
  implementations.kernel_dequeue_signal = () => 0;
  implementations.kernel_drain_wakeup_events = () => 0;

  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    4,
    kernelMemory,
    () => implementations,
    () => SCRATCH_OFFSET,
  );
  const gatedInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const scratch = allocateKernelScratchRegion(
    kernelMemory,
    gatedInstance.exports.kernel_alloc_scratch as
      (capacity: number) => number,
    CH_TOTAL_SIZE,
    4,
    "signal wake test scratch",
    gatedInstance,
  );
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: { onExit, onKernelFatal },
  });
  worker.testAuthority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch: scratch,
    tcpScratch: scratch,
  });
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel,
  });
  return {
    worker,
    implementations,
    completeChannel,
    onExit,
    onKernelFatal,
    kernelMemory,
  };
}

function mutableState(harness: SignalHarness) {
  return harness.worker as unknown as {
    processes: Map<number, {
      pid: number;
      memory: WebAssembly.Memory;
      channels: TestChannel[];
      ptrWidth: 4 | 8;
    }>;
    activeChannels: TestChannel[];
    channelTids: Map<string, number>;
    pendingSleeps: Map<TestChannel, {
      timer: ReturnType<typeof setTimeout>;
      channel: TestChannel;
      syscallNr: number;
      origArgs: number[];
      retVal: number;
      errVal: number;
    }>;
    pendingSignalWaits: Map<string, unknown>;
    signalWaitDeadlines: Map<string, unknown>;
    pendingPollRetries: Map<TestChannel, {
      timer: ReturnType<typeof setTimeout> | null;
      channel: TestChannel;
      pipeIndices: number[];
      acceptIndices?: number[];
    }>;
    pendingSelectRetries: Map<TestChannel, {
      timer: ReturnType<typeof setTimeout> | null;
      channel: TestChannel;
      origArgs: number[];
      syscallNr: number;
    }>;
    pendingPipeReaders: Map<
      number,
      Array<{ channel: TestChannel; pid: number }>
    >;
    pendingPipeWriters: Map<
      number,
      Array<{ channel: TestChannel; pid: number }>
    >;
    currentHandlePid: number;
    hostReaped: Set<number>;
  };
}

function registerProcess(
  harness: SignalHarness,
  pid: number,
  channels: TestChannel[],
): void {
  const state = mutableState(harness);
  state.processes.set(pid, {
    pid,
    memory: channels[0]!.memory,
    channels,
    ptrWidth: 4,
  });
  state.activeChannels.push(...channels);
  channels.forEach((channel, index) => {
    state.channelTids.set(
      `${pid}:${channel.channelOffset}`,
      index === 0 ? pid : pid + index,
    );
  });
}

describe("signal delivery to a process blocked in accept()", () => {
  it("does not livelock when retrySyscall re-parks the same poll key", () => {
    const harness = createWorkerHarness();
    const state = mutableState(harness);
    const targetPid = 42;
    const channel = createChannel(targetPid);
    registerProcess(harness, targetPid, [channel]);

    const makeEntry = () => ({
      timer: null,
      channel,
      pipeIndices: [],
      acceptIndices: [7],
    });
    state.pendingPollRetries.set(channel, makeEntry());

    let retryCount = 0;
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      retrySyscall: () => {
        retryCount++;
        if (retryCount < 5000) {
          state.pendingPollRetries.set(channel, makeEntry());
        }
      },
    });

    harness.worker.testAuthority.sendSignalForTest(targetPid, SIGCHLD);

    expect(retryCount).toBe(1);
  });

  it("notifyPipeReadable does not livelock on a re-parking poll", () => {
    const harness = createWorkerHarness();
    const state = mutableState(harness);
    const targetPid = 43;
    const pipeIdx = 11;
    const channel = createChannel(targetPid);
    registerProcess(harness, targetPid, [channel]);
    const makeEntry = () => ({
      timer: null,
      channel,
      pipeIndices: [pipeIdx],
      acceptIndices: [],
    });
    state.pendingPollRetries.set(channel, makeEntry());

    let retryCount = 0;
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      scheduleWakeBlockedRetries: vi.fn(),
      retrySyscall: () => {
        retryCount++;
        if (retryCount < 5000) {
          state.pendingPollRetries.set(channel, makeEntry());
        }
      },
    });

    harness.worker.notifyPipeReadable(pipeIdx);

    expect(retryCount).toBe(1);
  });

  it("interrupts only the sleeping thread selected for a shared signal", () => {
    vi.useFakeTimers();
    try {
      const harness = createWorkerHarness();
      const state = mutableState(harness);
      const pid = 44;
      const threadTid = 45;
      const memory = createSharedMemory();
      const mainChannel = createChannel(pid, 0, memory);
      const threadChannel = createChannel(pid, 256, memory);
      registerProcess(harness, pid, [mainChannel, threadChannel]);
      state.channelTids.set(`${pid}:${threadChannel.channelOffset}`, threadTid);
      const mainSleep = {
        timer: setTimeout(() => {}, 60_000),
        channel: mainChannel,
        syscallNr: 1,
        origArgs: [],
        retVal: 0,
        errVal: 0,
      };
      const threadSleep = {
        timer: setTimeout(() => {}, 60_000),
        channel: threadChannel,
        syscallNr: 1,
        origArgs: [],
        retVal: 0,
        errVal: 0,
      };
      state.pendingSleeps.set(mainChannel, mainSleep);
      state.pendingSleeps.set(threadChannel, threadSleep);
      const pickSignalTarget = vi.fn(() => threadTid);
      harness.implementations.kernel_pick_signal_target_tid = pickSignalTarget;

      harness.worker.testAuthority.sendSignalForTest(pid, SIGCHLD);

      expect(pickSignalTarget).toHaveBeenCalledWith(pid, SIGCHLD);
      expect(state.pendingSleeps.get(mainChannel)).toBe(mainSleep);
      expect(state.pendingSleeps.has(threadChannel)).toBe(false);
      expect(harness.completeChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.[0]).toBe(threadChannel);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a sleeping pthread's exact TID when dequeuing its signal", () => {
    const harness = createWorkerHarness();
    const state = mutableState(harness);
    const pid = 46;
    const tid = 47;
    const channel = createChannel(pid, 256);
    registerProcess(harness, pid, [channel]);
    state.channelTids.set(`${pid}:${channel.channelOffset}`, tid);
    const setCurrentTid = vi.fn(() => 0);
    const dequeueSignal = vi.fn(() => 0);
    harness.implementations.kernel_set_current_tid = setCurrentTid;
    harness.implementations.kernel_dequeue_signal = dequeueSignal;

    harness.worker.testAuthority.completeSleepWithSignalCheckForTest(
      channel,
      1,
      [],
      0,
      0,
    );

    expect(setCurrentTid).not.toHaveBeenCalled();
    expect(dequeueSignal).toHaveBeenCalledWith(
      pid,
      tid,
      expect.any(Number),
      KERNEL_SCRATCH_SIGNAL_DELIVERY_BYTES,
    );
  });

  it("does not rebind an ordinary synchronous signal dequeue", () => {
    const harness = createWorkerHarness();
    const pid = 48;
    const channel = createChannel(pid);
    registerProcess(harness, pid, [channel]);
    const setCurrentTid = vi.fn(() => 0);
    const dequeueSignal = vi.fn(() => 0);
    harness.implementations.kernel_set_current_tid = setCurrentTid;
    harness.implementations.kernel_dequeue_signal = dequeueSignal;

    harness.worker.testAuthority.dequeueSignalForDeliveryForTest(channel);

    expect(setCurrentTid).not.toHaveBeenCalled();
    expect(dequeueSignal).toHaveBeenCalledWith(
      pid,
      pid,
      expect.any(Number),
      KERNEL_SCRATCH_SIGNAL_DELIVERY_BYTES,
    );
  });

  it("fails closed when Rust rejects an exact signal dequeue task", () => {
    const harness = createWorkerHarness();
    const state = mutableState(harness);
    const pid = 48;
    const tid = 49;
    const channel = createChannel(pid, 256);
    registerProcess(harness, pid, [channel]);
    state.channelTids.set(`${pid}:${channel.channelOffset}`, tid);
    harness.implementations.kernel_dequeue_signal = vi.fn(() => -3);

    let caught: unknown;
    try {
      harness.worker.testAuthority.dequeueSignalForDeliveryForTest(channel);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/signal dequeue test/);
    expect((caught as Error & { cause?: Error }).cause?.message).toMatch(
      /Kernel rejected signal dequeue/,
    );
  });

  it("does not resume a sleeping pthread after dequeue terminates it", () => {
    const harness = createWorkerHarness();
    const state = mutableState(harness);
    const pid = 49;
    const tid = 50;
    const channel = createChannel(pid, 256);
    registerProcess(harness, pid, [channel]);
    state.channelTids.set(`${pid}:${channel.channelOffset}`, tid);
    let exited = false;
    harness.implementations.kernel_dequeue_signal = vi.fn(() => {
      exited = true;
      return 0;
    });
    harness.implementations.kernel_get_process_exit_signal =
      () => exited ? SIGTERM : -1;

    harness.worker.testAuthority.completeSleepWithSignalCheckForTest(
      channel,
      1,
      [],
      0,
      0,
    );

    expect(state.hostReaped.has(pid)).toBe(true);
    expect(harness.onExit).toHaveBeenCalledWith(pid, 128 + SIGTERM);
    expect(harness.completeChannel).not.toHaveBeenCalled();
  });

  it("leaves waits parked when the kernel consumed an ignored signal", () => {
    vi.useFakeTimers();
    try {
      const harness = createWorkerHarness();
      const state = mutableState(harness);
      const pid = 51;
      const channel = createChannel(pid);
      registerProcess(harness, pid, [channel]);
      const sleep = {
        timer: setTimeout(() => {}, 60_000),
        channel,
        syscallNr: 1,
        origArgs: [],
        retVal: 0,
        errVal: 0,
      };
      const pollEntry = {
        timer: null,
        channel,
        pipeIndices: [],
      };
      const selectEntry = {
        timer: setTimeout(() => {}, 60_000),
        channel,
        origArgs: [],
        syscallNr: 0,
      };
      state.pendingSleeps.set(channel, sleep);
      state.pendingPollRetries.set(channel, pollEntry);
      state.pendingSelectRetries.set(channel, selectEntry);
      harness.implementations.kernel_thread_has_deliverable = () => 0;
      const retrySyscall = vi.fn();
      harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
        retrySyscall,
      });

      harness.worker.testAuthority.sendSignalForTest(pid, SIGCHLD);

      expect(state.pendingSleeps.get(channel)).toBe(sleep);
      expect(state.pendingPollRetries.get(channel)).toBe(pollEntry);
      expect(state.pendingSelectRetries.get(channel)).toBe(selectEntry);
      expect(retrySyscall).not.toHaveBeenCalled();
      expect(harness.completeChannel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps a default-terminated process without selecting a sleeper", () => {
    const harness = createWorkerHarness();
    const state = mutableState(harness);
    const pid = 52;
    const channel = createChannel(pid);
    registerProcess(harness, pid, [channel]);
    const pickSignalTarget = vi.fn(() => pid);
    let exited = false;
    harness.implementations.kernel_handle_channel = (
      pointer: number | bigint,
    ) => {
      const view = new DataView(harness.kernelMemory.buffer, Number(pointer));
      view.setBigInt64(CH_RETURN, 0n, true);
      view.setUint32(CH_ERRNO, 0, true);
      exited = true;
      return 0;
    };
    harness.implementations.kernel_get_process_exit_signal =
      () => exited ? SIGTERM : -1;
    harness.implementations.kernel_pick_signal_target_tid = pickSignalTarget;

    harness.worker.testAuthority.sendSignalForTest(pid, SIGTERM);

    expect(state.hostReaped.has(pid)).toBe(true);
    expect(harness.onExit).toHaveBeenCalledWith(pid, 128 + SIGTERM);
    expect(pickSignalTarget).not.toHaveBeenCalled();
  });

  it("does not wake blocked channels when queuing the signal traps", async () => {
    const harness = createWorkerHarness();
    const pid = 53;
    const channel = createChannel(pid);
    registerProcess(harness, pid, [channel]);
    const pickSignalTarget = vi.fn(() => pid);
    harness.implementations.kernel_handle_channel = () => {
      throw new Error("synthetic kernel trap");
    };
    harness.implementations.kernel_pick_signal_target_tid = pickSignalTarget;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => {
        harness.worker.testAuthority.sendSignalForTest(pid, SIGTERM);
      }).toThrow(/kernel_handle_channel failed/);
      await Promise.resolve();

      expect(harness.onExit).not.toHaveBeenCalled();
      expect(pickSignalTarget).not.toHaveBeenCalled();
      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
    }
  });

  it("preserves the ambient host PID when signal TID binding is rejected", () => {
    const harness = createWorkerHarness();
    const state = mutableState(harness);
    const targetPid = 54;
    const priorPid = 91;
    const setCurrentTid = vi.fn(() => -3);
    const handleChannel = vi.fn();
    state.currentHandlePid = priorPid;
    harness.implementations.kernel_set_current_tid = setCurrentTid;
    harness.implementations.kernel_handle_channel = handleChannel;

    harness.worker.testAuthority.sendSignalForTest(targetPid, SIGTERM);

    expect(setCurrentTid).toHaveBeenCalledWith(targetPid, targetPid);
    expect(handleChannel).not.toHaveBeenCalled();
    expect(state.currentHandlePid).toBe(priorPid);
  });

  it("does not downgrade a successful directed tkill to a shared wake", () => {
    const harness = createWorkerHarness();
    const pid = 55;
    const targetTid = 56;
    const channel = createChannel(pid);
    registerProcess(harness, pid, [channel]);
    const processView = new DataView(channel.memory.buffer);
    processView.setUint32(CH_SYSCALL, SYS_TKILL, true);
    processView.setBigInt64(CH_ARGS, BigInt(targetTid), true);
    processView.setBigInt64(
      CH_ARGS + CH_ARG_SIZE,
      BigInt(SIGCHLD),
      true,
    );
    const exactWake = vi.fn(() => false);
    const sharedWake = vi.fn();
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      synchronizeSharedMemoryForBoundary: vi.fn(),
      scheduleWakeBlockedRetries: vi.fn(),
      interruptWaitingChildForDirectedSignal: exactWake,
      interruptWaitingChildrenForGeneratedSignal: sharedWake,
    });

    harness.worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(exactWake).toHaveBeenCalledWith(pid, targetTid);
    expect(sharedWake).not.toHaveBeenCalled();
  });
});
