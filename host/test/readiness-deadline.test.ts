import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  SIGNAL_MASK_BYTES,
  STRUCT_SIZE_WASM_POLL_FD,
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
  readonly pendingPollRetries: Map<TestChannel, unknown>;
  readonly pendingSelectRetries: Map<TestChannel, unknown>;
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

function createHarness(
  handleResult: (
    syscallNr: number,
    scratch: DataView,
  ) => KernelResult,
) {
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();
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
  const dequeueSignal = vi.fn(() => 0);
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
    // Process registration binds to the Rust image generation (b746c31c64).
    kernel_get_process_exec_generation: (_pid: number, pointer: number | bigint) => {
      new DataView(kernelMemory.buffer).setBigUint64(Number(pointer), 1n, true);
      return 8;
    },
    kernel_get_process_exit_signal: vi.fn(() => -1),
    kernel_get_fd_pipe_idx: vi.fn((_pid: number, fd: number) =>
      fd === 7 ? 99 : -1
    ),
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
        "kernel_get_process_exec_generation",
        "kernel_get_process_exit_signal",
        "kernel_get_fd_pipe_idx",
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
  });
  const [registeredChannel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: PID,
      memory: processMemory,
      channelOffsets: [0],
      pointerWidth: 4,
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
    gate,
    onExit,
    processMemory,
    kernelMemory,
    queueReadableWake(): void {
      readableWakeQueued = true;
    },
    relistenChannel,
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
    // The absolute deadline is kernel state, named by the wait handle. A
    // broad wake must not push the expiry out, so the handle must not move.
    expect(harness.state.pendingPollRetries.has(harness.channel)).toBe(true);
    expect(harness.channel.waitHandle).toBeTypeOf("bigint");
    const waitHandle = harness.channel.waitHandle;

    await vi.advanceTimersByTimeAsync(5);
    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state.pendingPollRetries.has(harness.channel)).toBe(true);
    expect(harness.channel.waitHandle).toBe(waitHandle);

    await vi.advanceTimersByTimeAsync(7);
    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state.pendingPollRetries.has(harness.channel)).toBe(true);
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
    expect(harness.state.pendingPollRetries.has(harness.channel)).toBe(true);
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

  // A ppoll/pselect6 that installs a temporary signal mask is woken by
  // readiness exactly like an unmasked wait. These used to be held back
  // 50 ms after every readiness event; POSIX asks only that the mask swap
  // and the wait be atomic, which the kernel's per-task wait context keeps.
  // Neither test advances a timer before the retry, so a grace period of any
  // length fails them.
  it("retries a masked ppoll as soon as its pipe becomes readable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    let attempts = 0;
    const harness = createHarness((syscallNr) => {
      expect(syscallNr).toBe(ABI_SYSCALLS.Ppoll);
      attempts++;
      return attempts === 1
        ? { retVal: -1, errVal: EAGAIN }
        : { retVal: 1, errVal: 0 };
    });
    const pollPointer = 1024;
    const maskPointer = 3072;
    const processView = new DataView(harness.processMemory.buffer);
    processView.setInt32(pollPointer, 7, true);
    processView.setInt16(pollPointer + 4, 0x001, true);
    processView.setBigUint64(maskPointer, 0n, true);
    // No timeout: only a wake or the safety timer can retry this wait.
    const args = syscallArgs(pollPointer, 1, 0, maskPointer, SIGNAL_MASK_BYTES);

    dispatchSyscall(harness, ABI_SYSCALLS.Ppoll, args);
    expect(attempts).toBe(1);
    expect(harness.state.pendingPollRetries.has(harness.channel)).toBe(true);

    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();
    await Promise.resolve();

    expect(attempts).toBe(2);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]!.slice(4, 6)).toEqual([1, 0]);
    expect(harness.state.pendingPollRetries.size).toBe(0);
  });

  it("retries a masked pselect on the next turn after readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    let attempts = 0;
    const harness = createHarness((syscallNr) => {
      expect(syscallNr).toBe(ABI_SYSCALLS.Pselect6);
      attempts++;
      return attempts === 1
        ? { retVal: -1, errVal: EAGAIN }
        : { retVal: 1, errVal: 0 };
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
    expect(attempts).toBe(1);
    expect(harness.state.pendingSelectRetries.has(harness.channel)).toBe(true);

    await vi.advanceTimersByTimeAsync(20);
    expect(attempts).toBe(1);
    harness.queueReadableWake();
    harness.worker.testAuthority.drainWakeupEventsForTest();
    // select has no pipe identity to target, so readiness reaches it through
    // the broad wake, which runs on the next immediate -- not after a delay.
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts).toBe(2);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]!.slice(4, 6)).toEqual([1, 0]);
    expect(harness.state.pendingSelectRetries.has(harness.channel)).toBe(false);
  });

});
