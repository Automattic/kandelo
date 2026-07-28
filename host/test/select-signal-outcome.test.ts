import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_BASE,
  CH_STATUS,
  CH_SYSCALL,
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

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
}

interface SelectState {
  readonly hostReaped: Set<number>;
  readonly pendingSelectRetries: Map<TestChannel, unknown>;
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
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

function createHarness(options: {
  readonly handlerSignal?: number;
  readonly exitSignal?: number;
  readonly returnValue?: number;
  readonly errno?: number;
} = {}) {
  const handlerSignal = options.handlerSignal ?? 0;
  const exitSignal = options.exitSignal ?? -1;
  const returnValue = options.returnValue ?? -1;
  const errno = options.errno ?? EAGAIN;
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();

  const handleChannel = vi.fn((pointer: number | bigint) => {
    const view = new DataView(kernelMemory.buffer, Number(pointer));
    view.setBigInt64(CH_RETURN, BigInt(returnValue), true);
    view.setUint32(CH_ERRNO, errno, true);
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
  const setCurrentTid = vi.fn(() => 0);
  const implementations: Record<string, unknown> = {
    kernel_blocking_retry_release: () => 0,
    kernel_blocking_retry_token: () => 0n,
    kernel_dequeue_signal: dequeueSignal,
    kernel_drain_wakeup_events: vi.fn(() => 0),
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
    channel,
    completeChannel,
    dequeueSignal,
    handleChannel,
    onExit,
    processMemory,
    setCurrentTid,
    state: worker as unknown as SelectState,
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

function expectCompletion(
  harness: ReturnType<typeof createHarness>,
  syscallNr: number,
  args: readonly number[],
  retVal: number,
  errVal: number,
): void {
  expect(harness.completeChannel).toHaveBeenCalledOnce();
  const completion = harness.completeChannel.mock.calls[0]!;
  expect(completion.slice(0, 3)).toEqual([
    harness.channel,
    syscallNr,
    args,
  ]);
  expect(completion.slice(4, 6)).toEqual([retVal, errVal]);
}

describe("select and pselect signal outcomes", () => {
  it("returns EINTR instead of re-parking pselect after a caught signal", () => {
    const harness = createHarness({ handlerSignal: 10 });
    const readfdsPointer = 1024;
    const timespecPointer = 2048;
    const view = new DataView(harness.processMemory.buffer);
    view.setUint8(readfdsPointer, 1);
    view.setBigInt64(timespecPointer, 1n, true);
    view.setBigInt64(timespecPointer + 8, 0n, true);
    const args = syscallArgs(
      1,
      readfdsPointer,
      0,
      0,
      timespecPointer,
      0,
    );

    dispatchSyscall(harness, ABI_SYSCALLS.Pselect6, args);

    expectCompletion(
      harness,
      ABI_SYSCALLS.Pselect6,
      args,
      -1,
      EINTR,
    );
    expect(harness.state.pendingSelectRetries.size).toBe(0);
    expect(harness.setCurrentTid).toHaveBeenCalledWith(PID, PID);
    expect(harness.setCurrentTid.mock.invocationCallOrder.at(-1)).toBeLessThan(
      harness.dequeueSignal.mock.invocationCallOrder[0]!,
    );
  });

  it("interrupts the pure-sleep select fast path without entering the kernel", () => {
    const harness = createHarness({ handlerSignal: 12 });
    const args = syscallArgs(0, 0, 0, 0, 0);

    dispatchSyscall(harness, ABI_SYSCALLS.Select, args);

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expectCompletion(
      harness,
      ABI_SYSCALLS.Select,
      args,
      -1,
      EINTR,
    );
    expect(harness.state.pendingSelectRetries.size).toBe(0);
  });

  it("re-parks pure-sleep select when no caught signal is delivered", () => {
    const harness = createHarness();
    const args = syscallArgs(0, 0, 0, 0, 0);

    dispatchSyscall(harness, ABI_SYSCALLS.Select, args);

    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(
      harness.state.pendingSelectRetries.has(harness.channel),
    ).toBe(true);
  });

  it("reaps a default signal death without waking select guest code", () => {
    const harness = createHarness({ exitSignal: 15 });
    const args = syscallArgs(0, 0, 0, 0, 0);

    dispatchSyscall(harness, ABI_SYSCALLS.Select, args);

    expect(harness.onExit).toHaveBeenCalledWith(PID, 128 + 15);
    expect(harness.state.hostReaped.has(PID)).toBe(true);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.state.pendingSelectRetries.size).toBe(0);
    expect(
      new DataView(harness.processMemory.buffer).getUint32(CH_STATUS, true),
    ).toBe(CHANNEL_STATUS_PENDING);
  });

  it("preserves a ready select result when a handler signal arrives concurrently", () => {
    const harness = createHarness({
      handlerSignal: 10,
      returnValue: 1,
      errno: 0,
    });
    const readfdsPointer = 1024;
    const args = syscallArgs(1, readfdsPointer, 0, 0, 0);
    new DataView(harness.processMemory.buffer).setUint8(readfdsPointer, 1);

    dispatchSyscall(harness, ABI_SYSCALLS.Select, args);

    expect(
      new DataView(harness.processMemory.buffer).getUint32(CH_SIG_BASE, true),
    ).toBe(10);
    expectCompletion(
      harness,
      ABI_SYSCALLS.Select,
      args,
      1,
      0,
    );
  });
});
