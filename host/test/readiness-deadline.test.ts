import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_BASE,
  CH_STATUS,
  CH_SYSCALL,
  KERNEL_SCRATCH_SIGNAL_DELIVERY_BYTES,
  SIGNAL_MASK_BYTES,
  STRUCT_SIZE_WASM_EPOLL_EVENT,
  STRUCT_SIZE_WASM_POLL_FD,
  WASM_EPOLL_EVENT_DATA_OFFSET,
  WASM_EPOLL_EVENT_EVENTS_OFFSET,
} from "../src/generated/abi";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  createKernelScratchTestInstance,
} from "./support/kernel-scratch-instance";

const EAGAIN = 11;
const EINTR = 4;
const PID = 42;
const SCRATCH_POINTER = 128;
const WAKE_READABLE = 1;

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
  readonly i32View: Int32Array;
  readinessDeadline?: number;
  readinessFinalCheck?: boolean;
}

interface ReadinessState {
  readonly blockingRetrySnapshots: Map<TestChannel, {
    readonly retryToken: bigint;
    readonly dispatch: {
      readonly adjustedArgs: readonly (number | bigint)[];
      readonly readinessTimeoutMs?: number;
    };
  }>;
  readonly hostReaped: Set<number>;
  readonly pendingPollRetries: Map<TestChannel, unknown>;
  readonly pendingSelectRetries: Map<TestChannel, {
    readonly deadline: number;
    readonly needsSignalSafeWake: boolean;
  }>;
}

interface KernelResult {
  readonly retVal: number;
  readonly errVal: number;
}

function createSharedMemory(pages = 2): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

function syscallArgs(...values: number[]): number[] {
  return Array.from(
    { length: CH_ARGS_COUNT },
    (_, index) => values[index] ?? 0,
  );
}

function writeSyscall(
  channel: TestChannel,
  syscallNr: number,
  args: readonly number[],
): void {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  view.setUint32(CH_SYSCALL, syscallNr, true);
  for (let index = 0; index < CH_ARGS_COUNT; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }
}

function readRawCompletion(channel: TestChannel): {
  readonly retVal: number;
  readonly errVal: number;
  readonly status: number;
} {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  return {
    retVal: Number(view.getBigInt64(CH_RETURN, true)),
    errVal: view.getUint32(CH_ERRNO, true),
    status: view.getUint32(CH_STATUS, true),
  };
}

function createHarness(
  handleResult: (
    syscallNr: number,
    scratch: DataView,
  ) => KernelResult = (syscallNr) => {
    if (
      syscallNr === ABI_SYSCALLS.EpollCreate1
      || syscallNr === ABI_SYSCALLS.EpollCreate
    ) {
      return { retVal: 7, errVal: 0 };
    }
    return { retVal: 0, errVal: 0 };
  },
  pointerWidth: 4 | 8 = 4,
) {
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();
  let handlerSignal = 0;
  let exitSignal = -1;
  let readableWakeQueued = false;

  const handleChannel = vi.fn((pointer: number | bigint) => {
    const scratch = new DataView(kernelMemory.buffer, Number(pointer));
    const result = handleResult(
      scratch.getUint32(CH_SYSCALL, true),
      scratch,
    );
    scratch.setBigInt64(CH_RETURN, BigInt(result.retVal), true);
    scratch.setUint32(CH_ERRNO, result.errVal, true);
    return 0;
  });
  const dequeueSignal = vi.fn((
    _pid: number,
    _tid: number,
    pointer: number | bigint,
    capacity: number,
  ) => {
    if (handlerSignal <= 0) return 0;
    const output = new Uint8Array(
      kernelMemory.buffer,
      Number(pointer),
      capacity,
    );
    output.fill(0);
    new DataView(
      kernelMemory.buffer,
      Number(pointer),
      capacity,
    ).setUint32(0, handlerSignal, true);
    return handlerSignal;
  });
  const drainWakeupEvents = vi.fn((
    pointer: number | bigint,
    _capacity: number,
    _maxEvents: number,
  ) => {
    if (!readableWakeQueued) return 0;
    readableWakeQueued = false;
    const output = new DataView(kernelMemory.buffer, Number(pointer), 5);
    output.setUint32(0, 99, true);
    output.setUint8(4, WAKE_READABLE);
    return 1;
  });
  const setCurrentTid = vi.fn(() => 0);
  const blockingRetryRelease = vi.fn(() => 0);
  const blockingRetryToken = vi.fn(() => 0n);
  const implementations: Record<string, unknown> = {
    kernel_blocking_retry_release: blockingRetryRelease,
    kernel_blocking_retry_token: blockingRetryToken,
    kernel_dequeue_signal: dequeueSignal,
    kernel_drain_wakeup_events: drainWakeupEvents,
    kernel_get_parent_pid: vi.fn(() => 0),
    kernel_get_process_exit_signal: vi.fn(() => exitSignal),
    kernel_handle_channel: handleChannel,
    kernel_set_current_tid: setCurrentTid,
  };
  const gate = new KernelEntryGate();
  const kernelInstance = createKernelEntryGatedInstance(
    createKernelScratchTestInstance(
      4,
      kernelMemory,
      () => implementations,
      () => SCRATCH_POINTER,
      4,
      [
        "kernel_blocking_retry_release",
        "kernel_blocking_retry_token",
        "kernel_dequeue_signal",
        "kernel_drain_wakeup_events",
        "kernel_get_parent_pid",
        "kernel_get_process_exit_signal",
        "kernel_handle_channel",
        "kernel_set_current_tid",
      ],
    ),
    gate,
  );
  const onExit = vi.fn();
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: { onExit },
  });
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    SCRATCH_POINTER,
    4,
    { boundInstance: kernelInstance, gate },
  );

  const completeChannel = vi.fn();
  const relistenChannel = vi.fn();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel: (
      channel,
      syscallNr,
      origArgs,
      argDescs,
      retVal,
      errVal,
    ) => {
      completeChannel(
        channel,
        syscallNr,
        origArgs,
        argDescs,
        retVal,
        errVal,
      );
    },
    relistenChannel,
  });
  const [registeredChannel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: PID,
      memory: processMemory,
      channelOffsets: [0],
      pointerWidth,
    });
  const channel = registeredChannel as TestChannel;

  return {
    blockingRetryRelease,
    blockingRetryToken,
    channel,
    completeChannel,
    dequeueSignal,
    drainWakeupEvents,
    handleChannel,
    onExit,
    processMemory,
    queueReadableWake(): void {
      readableWakeQueued = true;
    },
    relistenChannel,
    setExitSignal(signal: number): void {
      exitSignal = signal;
    },
    setHandlerSignal(signal: number): void {
      handlerSignal = signal;
    },
    state: worker as unknown as ReadinessState,
    worker,
  };
}

function dispatchSyscall(
  harness: ReturnType<typeof createHarness>,
  syscallNr: number,
  args: readonly number[],
): void {
  writeSyscall(harness.channel, syscallNr, args);
  harness.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
    harness.channel,
  );
}

function initializeEpoll(
  harness: ReturnType<typeof createHarness>,
  hasInterest: boolean,
): void {
  dispatchSyscall(
    harness,
    ABI_SYSCALLS.EpollCreate1,
    syscallArgs(0),
  );
  if (hasInterest) {
    const eventPointer = 8192;
    const event = new DataView(
      harness.processMemory.buffer,
      eventPointer,
      STRUCT_SIZE_WASM_EPOLL_EVENT,
    );
    event.setUint32(WASM_EPOLL_EVENT_EVENTS_OFFSET, 0x001, true);
    event.setBigUint64(WASM_EPOLL_EVENT_DATA_OFFSET, 99n, true);
    dispatchSyscall(
      harness,
      ABI_SYSCALLS.EpollCtl,
      syscallArgs(7, 1, 3, eventPointer),
    );
  }
  harness.completeChannel.mockClear();
  harness.dequeueSignal.mockClear();
  harness.handleChannel.mockClear();
  harness.relistenChannel.mockClear();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("finite readiness deadlines", () => {
  it("keeps one poll deadline and performs a final readiness retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const observedKernelTimeouts: number[] = [];
    const harness = createHarness((syscallNr, scratch) => {
      expect(syscallNr).toBe(ABI_SYSCALLS.Poll);
      const timeout = Number(
        scratch.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
      );
      observedKernelTimeouts.push(timeout);
      return timeout === 0
        ? { retVal: 0, errVal: 0 }
        : { retVal: -1, errVal: EAGAIN };
    });
    const pollPointer = 1024;
    const pollfd = new DataView(
      harness.processMemory.buffer,
      pollPointer,
      STRUCT_SIZE_WASM_POLL_FD,
    );
    pollfd.setInt32(0, -1, true);
    pollfd.setInt16(4, 0x001, true);
    const args = syscallArgs(pollPointer, 1, 120);

    dispatchSyscall(harness, ABI_SYSCALLS.Poll, args);
    const retainedSnapshot = harness.state.blockingRetrySnapshots.get(
      harness.channel,
    );
    expect(retainedSnapshot?.dispatch.adjustedArgs[2]).toBe(120);
    expect(retainedSnapshot?.dispatch.readinessTimeoutMs).toBe(120);

    expect(harness.channel.readinessDeadline).toBe(1_120);
    await vi.advanceTimersByTimeAsync(119);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(observedKernelTimeouts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(observedKernelTimeouts)).toEqual(new Set([120]));
    expect(harness.channel.readinessDeadline).toBe(1_120);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(observedKernelTimeouts.at(-1)).toBe(0);
    expect(observedKernelTimeouts.filter((value) => value === 0)).toHaveLength(1);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    const completion = harness.completeChannel.mock.calls[0]!;
    expect(completion.slice(0, 3)).toEqual([
      harness.channel,
      ABI_SYSCALLS.Poll,
      args,
    ]);
    expect(completion.slice(4, 6)).toEqual([0, 0]);
    expect(harness.state.pendingPollRetries.size).toBe(0);
    expect(harness.state.blockingRetrySnapshots.has(harness.channel)).toBe(
      false,
    );
    expect(retainedSnapshot?.dispatch.adjustedArgs[2]).toBe(120);
    expect(retainedSnapshot?.dispatch.readinessTimeoutMs).toBe(120);
  });

  it("treats a final zero-time ppoll EAGAIN as timeout after mask cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_500);

    const observedSyscalls: number[] = [];
    const observedPpollTimeouts: number[] = [];
    const harness = createHarness((syscallNr, scratch) => {
      observedSyscalls.push(syscallNr);
      if (syscallNr === ABI_SYSCALLS.Ppoll) {
        observedPpollTimeouts.push(Number(
          scratch.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
        ));
        return { retVal: -1, errVal: EAGAIN };
      }
      expect(syscallNr).toBe(ABI_SYSCALLS.ThreadCancel);
      return { retVal: 0, errVal: 0 };
    });
    const pollPointer = 1024;
    const timeoutPointer = 2048;
    const maskPointer = 3072;
    const processView = new DataView(harness.processMemory.buffer);
    processView.setInt32(pollPointer, -1, true);
    processView.setInt16(pollPointer + 4, 0x001, true);
    processView.setBigInt64(timeoutPointer, 0n, true);
    processView.setBigInt64(timeoutPointer + 8, 10_000_000n, true);
    processView.setBigUint64(maskPointer, 0x80n, true);
    const args = syscallArgs(
      pollPointer,
      1,
      timeoutPointer,
      maskPointer,
      SIGNAL_MASK_BYTES,
    );

    dispatchSyscall(harness, ABI_SYSCALLS.Ppoll, args);
    const retainedSnapshot = harness.state.blockingRetrySnapshots.get(
      harness.channel,
    );
    expect(retainedSnapshot?.dispatch.adjustedArgs[2]).toBe(10);
    expect(retainedSnapshot?.dispatch.readinessTimeoutMs).toBe(10);

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(observedPpollTimeouts.at(-1)).toBe(0);
    expect(
      observedPpollTimeouts.filter((timeout) => timeout === 0),
    ).toHaveLength(1);
    expect(observedSyscalls.at(-1)).toBe(ABI_SYSCALLS.ThreadCancel);
    expect(
      observedSyscalls.filter(
        (syscall) => syscall === ABI_SYSCALLS.ThreadCancel,
      ),
    ).toHaveLength(1);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]!.slice(4, 6)).toEqual([
      0,
      0,
    ]);
    expect(harness.blockingRetryToken).toHaveBeenCalledOnce();
    expect(harness.blockingRetryRelease).not.toHaveBeenCalled();
    expect(harness.state.pendingPollRetries.size).toBe(0);
    expect(harness.state.blockingRetrySnapshots.has(harness.channel)).toBe(
      false,
    );
    expect(retainedSnapshot?.retryToken).toBe(0n);
    expect(retainedSnapshot?.dispatch.adjustedArgs[2]).toBe(10);
    expect(retainedSnapshot?.dispatch.readinessTimeoutMs).toBe(10);
  });

  it("postpones a signal-safe pselect fallback until the deferred wake", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const harness = createHarness(() => ({
      retVal: -1,
      errVal: EAGAIN,
    }));
    const retrySyscall = vi.fn();
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      retrySyscall,
    });
    const readfdsPointer = 1024;
    const timespecPointer = 2048;
    const maskDescriptorPointer = 3072;
    const maskPointer = 4096;
    const processView = new DataView(harness.processMemory.buffer);
    processView.setUint8(readfdsPointer, 1);
    processView.setBigInt64(timespecPointer, 0n, true);
    processView.setBigInt64(timespecPointer + 8, 100_000_000n, true);
    processView.setUint32(maskDescriptorPointer, maskPointer, true);
    processView.setUint32(
      maskDescriptorPointer + 4,
      SIGNAL_MASK_BYTES,
      true,
    );
    const args = syscallArgs(
      1,
      readfdsPointer,
      0,
      0,
      timespecPointer,
      maskDescriptorPointer,
    );

    dispatchSyscall(harness, ABI_SYSCALLS.Pselect6, args);

    const initialEntry = harness.state.pendingSelectRetries.get(
      harness.channel,
    );
    expect(initialEntry).toMatchObject({
      deadline: 2_100,
      needsSignalSafeWake: true,
    });
    await vi.advanceTimersByTimeAsync(20);
    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(
      harness.state.pendingSelectRetries.get(harness.channel),
    ).toBe(initialEntry);
    expect(initialEntry?.deadline).toBe(2_100);
    await vi.advanceTimersByTimeAsync(30);
    expect(retrySyscall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(19);
    expect(retrySyscall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(retrySyscall).toHaveBeenCalledOnce();
    expect(retrySyscall).toHaveBeenCalledWith(harness.channel);
    expect(harness.state.pendingSelectRetries.has(harness.channel)).toBe(false);
    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.drainWakeupEvents).toHaveBeenCalledOnce();
  });

});

describe("host-emulated epoll signal delivery", () => {
  it("interrupts epoll with EINTR after copying a caught handler signal", () => {
    const harness = createHarness();
    initializeEpoll(harness, true);
    harness.setHandlerSignal(15);
    const args = syscallArgs(7, 4096, 1, 1000, 0, SIGNAL_MASK_BYTES);

    dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, args);

    expect(harness.dequeueSignal).toHaveBeenCalledWith(
      PID,
      PID,
      SCRATCH_POINTER + CH_SIG_BASE,
      KERNEL_SCRATCH_SIGNAL_DELIVERY_BYTES,
    );
    expect(
      new DataView(harness.processMemory.buffer).getUint32(CH_SIG_BASE, true),
    ).toBe(15);
    expect(readRawCompletion(harness.channel)).toEqual({
      retVal: -EINTR,
      errVal: EINTR,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(harness.relistenChannel).toHaveBeenCalledWith(harness.channel);
    expect(harness.onExit).not.toHaveBeenCalled();
    expect(harness.handleChannel).toHaveBeenCalledOnce();
  });

  it("reaps a default signal death without waking guest epoll code", () => {
    const harness = createHarness();
    initializeEpoll(harness, false);
    harness.setExitSignal(11);
    const args = syscallArgs(7, 4096, 1, 1000, 0, SIGNAL_MASK_BYTES);

    dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, args);

    expect(harness.onExit).toHaveBeenCalledWith(PID, 128 + 11);
    expect(harness.state.hostReaped.has(PID)).toBe(true);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.relistenChannel).not.toHaveBeenCalled();
    expect(harness.state.pendingPollRetries.size).toBe(0);
    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(
      new DataView(harness.processMemory.buffer).getUint32(CH_STATUS, true),
    ).toBe(CHANNEL_STATUS_PENDING);
  });
});
