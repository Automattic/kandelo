import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_DATA,
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
import {
  emptyProcessTimerCleanup,
  installKernelWorkerTestScratch,
} from "./kernel-worker-test-scratch";
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
  waitHandle?: bigint;
  readinessFinalCheck?: boolean;
  epollWaitToken?: bigint;
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
  readonly pendingCancels: Set<TestChannel>;
  readonly pendingPollRetries: Map<TestChannel, {
    readonly deadlineHintMs: number;
  }>;
  readonly pendingSelectRetries: Map<TestChannel, {
    readonly deadlineHintMs: number;
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
  retryProbe?: () => number,
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
  const epollRetryState = retryProbe ? vi.fn(retryProbe) : undefined;
  const synchronizeSharedMemory = vi.fn();
  const epollWakeIndices = vi.fn((
    _pid: number, _epfd: number, _kind: number,
    _pointer: number | bigint, _capacity: number,
  ) => 0);
  const implementations: Record<string, unknown> = {
    kernel_blocking_retry_release: blockingRetryRelease,
    kernel_blocking_retry_token: blockingRetryToken,
    kernel_dequeue_signal: dequeueSignal,
    kernel_drain_wakeup_events: drainWakeupEvents,
    kernel_get_parent_pid: vi.fn(() => 0),
    kernel_get_process_exit_signal: vi.fn(() => exitSignal),
    kernel_get_fd_pipe_idx: vi.fn((_pid: number, fd: number) =>
      fd === 7 ? 99 : -1
    ),
    ...(epollRetryState ? { kernel_epoll_wait_retry_state: epollRetryState } : {}),
    kernel_epoll_wait_token: vi.fn(() => 19n),
    kernel_epoll_wait_finish: vi.fn(() => 0),
    kernel_epoll_wake_indices: epollWakeIndices,
    kernel_handle_channel: handleChannel,
    kernel_set_current_tid: setCurrentTid,
    kernel_take_process_timer_cleanup: emptyProcessTimerCleanup(kernelMemory),
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
        "kernel_get_fd_pipe_idx",
        ...(epollRetryState ? ["kernel_epoll_wait_retry_state"] : []),
        "kernel_epoll_wait_token",
        "kernel_epoll_wait_finish",
        "kernel_epoll_wake_indices",
        "kernel_handle_channel",
        "kernel_set_current_tid",
        "kernel_take_process_timer_cleanup",
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
    synchronizeSharedMemoryForBoundary: synchronizeSharedMemory,
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
    epollRetryState,
    epollWakeIndices,
    gate,
    synchronizeSharedMemory,
    onExit,
    processMemory,
    kernelMemory,
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

    // The deadline itself is kernel state now; what the host keeps is the
    // handle naming it. The invariant under test is that the retries share one
    // deadline rather than each restarting the clock, so the handle must be
    // the same one across all of them.
    const waitHandle = harness.channel.waitHandle;
    expect(waitHandle).toBeTypeOf("bigint");
    await vi.advanceTimersByTimeAsync(119);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(observedKernelTimeouts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(observedKernelTimeouts)).toEqual(new Set([120]));
    expect(harness.channel.waitHandle).toBe(waitHandle);

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

  it("does not extend an nfds=0 poll deadline across broad wakes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const observedKernelTimeouts: number[] = [];
    const harness = createHarness((_syscallNr, scratch) => {
      const timeout = Number(
        scratch.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
      );
      observedKernelTimeouts.push(timeout);
      return timeout === 0
        ? { retVal: 0, errVal: 0 }
        : { retVal: -1, errVal: EAGAIN };
    });
    const args = syscallArgs(0, 0, 30);

    dispatchSyscall(harness, ABI_SYSCALLS.Poll, args);
    // The absolute deadline is kernel state; the host keeps a monotonic hint
    // for sizing its safety timer. Either way the point is that a broad wake
    // must not push the expiry out, so assert the value does not move.
    const hint = harness.state.pendingPollRetries
      .get(harness.channel)?.deadlineHintMs;
    expect(hint).toBeTypeOf("number");
    expect(harness.channel.waitHandle).toBeTypeOf("bigint");
    const waitHandle = harness.channel.waitHandle;

    await vi.advanceTimersByTimeAsync(5);
    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state.pendingPollRetries.get(harness.channel)?.deadlineHintMs)
      .toBe(hint);
    expect(harness.channel.waitHandle).toBe(waitHandle);

    await vi.advanceTimersByTimeAsync(7);
    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state.pendingPollRetries.get(harness.channel)?.deadlineHintMs)
      .toBe(hint);
    expect(harness.channel.waitHandle).toBe(waitHandle);

    await vi.advanceTimersByTimeAsync(17);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(observedKernelTimeouts.at(-1)).toBe(0);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.state.pendingPollRetries.size).toBe(0);
  });

  it("cancels the poll deadline after targeted readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);

    let attempts = 0;
    const harness = createHarness((syscallNr) => {
      expect(syscallNr).toBe(ABI_SYSCALLS.Poll);
      attempts++;
      return attempts === 1
        ? { retVal: -1, errVal: EAGAIN }
        : { retVal: 1, errVal: 0 };
    });
    const pollPointer = 1024;
    const pollfd = new DataView(
      harness.processMemory.buffer,
      pollPointer,
      STRUCT_SIZE_WASM_POLL_FD,
    );
    pollfd.setInt32(0, 7, true);
    pollfd.setInt16(4, 0x001, true);
    const args = syscallArgs(pollPointer, 1, 40);

    dispatchSyscall(harness, ABI_SYSCALLS.Poll, args);
    expect(harness.state.pendingPollRetries.get(harness.channel)?.deadlineHintMs)
      .toBeTypeOf("number");
    expect(harness.channel.waitHandle).toBeTypeOf("bigint");

    await vi.advanceTimersByTimeAsync(7);
    harness.worker.notifyPipeReadable(99);
    await Promise.resolve();

    expect(attempts).toBe(2);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]!.slice(4, 6)).toEqual([
      1,
      0,
    ]);
    expect(harness.state.pendingPollRetries.size).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
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
    expect(initialEntry).toMatchObject({ needsSignalSafeWake: true });
    expect(initialEntry?.deadlineHintMs).toBeTypeOf("number");
    const initialHint = initialEntry?.deadlineHintMs;
    await vi.advanceTimersByTimeAsync(20);
    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(
      harness.state.pendingSelectRetries.get(harness.channel),
    ).toBe(initialEntry);
    expect(initialEntry?.deadlineHintMs).toBe(initialHint);
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
    // One nonblocking pass of the kernel's epoll_pwait (it owns the
    // registrations, even an empty list), then the signal boundary -- the
    // same order as with an interest registered.
    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(
      new DataView(harness.processMemory.buffer).getUint32(CH_STATUS, true),
    ).toBe(CHANNEL_STATUS_PENDING);
  });
});


describe("retained epoll fallback probe", () => {
  for (const width of [4, 8] as const) {
    it(`keeps blocked ${width * 8}-bit timer retries off syscall/coherence replay`, async () => {
      vi.useFakeTimers();
      let probeResult = 1;
      let ready = false;
      const harness = createHarness((nr) => nr === ABI_SYSCALLS.EpollPwait
        ? { retVal: ready ? 0 : -1, errVal: ready ? 0 : EAGAIN }
        : { retVal: 7, errVal: 0 }, width, () => probeResult);
      initializeEpoll(harness, false);
      harness.synchronizeSharedMemory.mockClear();
      dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait,
        syscallArgs(7, 4096, 1, -1, 0, SIGNAL_MASK_BYTES));
      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.synchronizeSharedMemory).toHaveBeenCalledOnce();
      const token = harness.channel.epollWaitToken;
      expect(token).toBeTypeOf("bigint");
      await vi.advanceTimersByTimeAsync(30);
      expect(harness.epollRetryState).toHaveBeenCalledTimes(3);
      expect(harness.epollRetryState).toHaveBeenLastCalledWith(PID, PID, token, 0n);
      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.synchronizeSharedMemory).toHaveBeenCalledOnce();
      expect(harness.state.pendingPollRetries.size).toBe(1);
      expect(readRawCompletion(harness.channel).status).toBe(CHANNEL_STATUS_PENDING);
      probeResult = 0;
      ready = true;
      // The kernel mock's zero result is a final nonblocking result only for
      // timeout=0. Use a real error to finish this infinite wait instead.
      harness.setHandlerSignal(15);
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.handleChannel).toHaveBeenCalledTimes(2);
      expect(harness.synchronizeSharedMemory.mock.calls.length).toBeGreaterThan(1);
      expect(readRawCompletion(harness.channel).status).toBe(CHANNEL_STATUS_COMPLETE);
      expect(harness.state.pendingPollRetries.size).toBe(0);
    });
  }

  for (const result of [undefined, 0, -5, 2]) {
    it(`falls back to full replay for unavailable/unknown/error proof ${result}`, async () => {
      vi.useFakeTimers();
      const harness = createHarness(() => ({ retVal: -1, errVal: EAGAIN }),
        4, result === undefined ? undefined : () => result);
      dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, syscallArgs(7, 4096, 1, -1));
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.handleChannel).toHaveBeenCalledTimes(2);
      expect(harness.synchronizeSharedMemory).toHaveBeenCalledTimes(2);
      expect(harness.state.pendingPollRetries.size).toBe(1);
    });
  }

  it("keeps the same finite deadline and replays at its expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness((_, scratch) => {
      const timeout = Number(scratch.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true));
      return timeout === 0 ? { retVal: 0, errVal: 0 } : { retVal: -1, errVal: EAGAIN };
    }, 8, () => 1);
    dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, syscallArgs(7, 4096, 1, 25));
    const handle = harness.channel.waitHandle;
    await vi.advanceTimersByTimeAsync(24);
    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.epollRetryState).toHaveBeenLastCalledWith(PID, PID, 19n, handle);
    expect(harness.channel.waitHandle).toBe(handle);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.handleChannel).toHaveBeenCalledTimes(2);
    expect(readRawCompletion(harness.channel)).toEqual({ retVal: 0, errVal: 0,
      status: CHANNEL_STATUS_COMPLETE });
    expect(harness.channel.waitHandle).toBeUndefined();
    expect(harness.state.pendingPollRetries.size).toBe(0);
  });

  for (const mutation of ["cancel", "argument", "header", "token", "deadline"] as const) {
    it(`does not accept a negative proof after ${mutation} changes`, async () => {
      vi.useFakeTimers();
      const harness = createHarness(() => ({ retVal: -1, errVal: EAGAIN }), 4, () => 1);
      dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, syscallArgs(7, 4096, 1, -1));
      const view = new DataView(harness.processMemory.buffer);
      if (mutation === "cancel") harness.state.pendingCancels.add(harness.channel);
      if (mutation === "argument") view.setBigInt64(CH_ARGS + CH_ARG_SIZE, 8192n, true);
      if (mutation === "header") view.setUint32(CH_SYSCALL, ABI_SYSCALLS.EpollWait, true);
      if (mutation === "token") harness.channel.epollWaitToken = 20n;
      if (mutation === "deadline") harness.channel.waitHandle = 20n;
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.epollRetryState).not.toHaveBeenCalled();
      expect(harness.handleChannel).toHaveBeenCalledTimes(2);
      expect(harness.synchronizeSharedMemory).toHaveBeenCalledTimes(2);
    });
  }

  it("lets targeted readiness bypass the fallback probe and copy events once", async () => {
    vi.useFakeTimers();
    let ready = false;
    const harness = createHarness((_, scratch) => {
      if (!ready) return { retVal: -1, errVal: EAGAIN };
      // The real host scratch copyout path, not a test completion hook.
      scratch.setUint32(CH_DATA + WASM_EPOLL_EVENT_EVENTS_OFFSET, 1, true);
      scratch.setBigUint64(CH_DATA + WASM_EPOLL_EVENT_DATA_OFFSET, 81n, true);
      return { retVal: 1, errVal: 0 };
    }, 4, () => 1);
    harness.epollWakeIndices.mockImplementation((_pid, _epfd, kind, pointer) => {
      if (kind !== 0) return 0; // EPOLL_WAKE_KIND_PIPE
      new DataView(harness.kernelMemory.buffer, Number(pointer), 4).setUint32(0, 99, true);
      return 1;
    });
    dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, syscallArgs(7, 4096, 1, -1));
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.epollRetryState).toHaveBeenCalledOnce();
    ready = true;
    harness.worker.notifyPipeReadable(99);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.handleChannel).toHaveBeenCalledTimes(2);
    expect(harness.epollRetryState).toHaveBeenCalledOnce();
    expect(readRawCompletion(harness.channel).retVal).toBe(1);
    expect(harness.state.pendingPollRetries.size).toBe(0);
    const events = new DataView(harness.processMemory.buffer, 4096);
    expect(events.getUint32(WASM_EPOLL_EVENT_EVENTS_OFFSET, true)).toBe(1);
    expect(events.getBigUint64(WASM_EPOLL_EVENT_DATA_OFFSET, true)).toBe(81n);
    await vi.advanceTimersByTimeAsync(30);
    expect(harness.handleChannel).toHaveBeenCalledTimes(2);
  });

  for (const notificationFirst of [true, false]) {
    it(`keeps the queued wake when notificationFirst=${notificationFirst}`, async () => {
      vi.useFakeTimers();
      let ready = false;
      const harness = createHarness(() => ready
        ? { retVal: -1, errVal: 5 } : { retVal: -1, errVal: EAGAIN }, 4, () => 1);
      harness.epollWakeIndices.mockImplementation((_pid, _epfd, kind, pointer) => {
        if (kind !== 0) return 0;
        new DataView(harness.kernelMemory.buffer, Number(pointer), 4).setUint32(0, 99, true);
        return 1;
      });
      dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, syscallArgs(7, 4096, 1, -1));
      harness.gate.runImmediateVoidIngress("another selected kernel operation", () => {
        ready = true;
        if (notificationFirst) harness.worker.notifyPipeReadable(99);
        vi.advanceTimersByTime(10); // timer also waits behind the same scope
        if (!notificationFirst) harness.worker.notifyPipeReadable(99);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.handleChannel).toHaveBeenCalledTimes(2);
      expect(harness.state.pendingPollRetries.size).toBe(0);
      expect(readRawCompletion(harness.channel).status).toBe(CHANNEL_STATUS_COMPLETE);
      await vi.advanceTimersByTimeAsync(30);
      expect(harness.handleChannel).toHaveBeenCalledTimes(2);
    });
  }

  it("cannot replay or rearm a replaced process registration", async () => {
    vi.useFakeTimers();
    const harness = createHarness(() => ({ retVal: -1, errVal: EAGAIN }), 4, () => 1);
    dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, syscallArgs(7, 4096, 1, -1));
    harness.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: PID, memory: harness.processMemory, channelOffsets: [0], pointerWidth: 4,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(harness.epollRetryState).not.toHaveBeenCalled();
    expect(harness.handleChannel).toHaveBeenCalledOnce();
  });

  it("preserves fatal export failures instead of accepting a blocked proof", async () => {
    vi.useFakeTimers();
    const fault = new Error("probe export failed");
    const harness = createHarness(() => ({ retVal: -1, errVal: EAGAIN }), 4,
      () => { throw fault; });
    dispatchSyscall(harness, ABI_SYSCALLS.EpollPwait, syscallArgs(7, 4096, 1, -1));
    await expect(vi.advanceTimersByTimeAsync(10)).rejects.toThrow();
    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(readRawCompletion(harness.channel).status).toBe(CHANNEL_STATUS_PENDING);
  });

});
