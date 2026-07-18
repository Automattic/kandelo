import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_BASE,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const EAGAIN = 11;
const EINTR = 4;

function createSharedMemory(pages = 2): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
}

function createHarness(options: {
  handlerSignal?: number;
  exitSignal?: number;
  returnValue?: number;
  errno?: number;
} = {}) {
  const handlerSignal = options.handlerSignal ?? 0;
  const exitSignal = options.exitSignal ?? -1;
  const returnValue = options.returnValue ?? -1;
  const errno = options.errno ?? EAGAIN;
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();
  const channel: any = {
    pid: 42,
    channelOffset: 0,
    memory: processMemory,
  };
  const handleChannel = vi.fn(() => {
    const view = new DataView(kernelMemory.buffer);
    view.setBigInt64(CH_RETURN, BigInt(returnValue), true);
    view.setUint32(CH_ERRNO, errno, true);
    return 0;
  });
  const dequeueSignal = vi.fn((_pid: number, _tid: number, outPtr: number) => {
    if (handlerSignal > 0) {
      new DataView(kernelMemory.buffer).setUint32(outPtr, handlerSignal, true);
    }
    return handlerSignal;
  });
  const setCurrentTid = vi.fn(() => 0);
  const completeChannel = vi.fn();
  const handleProcessTerminated = vi.fn();
  const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
    kernelInstance: {
      exports: {
        kernel_handle_channel: handleChannel,
        kernel_dequeue_signal: dequeueSignal,
        kernel_get_process_exit_signal: vi.fn(() => exitSignal),
        kernel_set_current_tid: setCurrentTid,
      },
    },
    kernelMemory,
    scratchOffset: 0,
    currentHandlePid: 0,
    processes: new Map([
      [42, { pid: 42, memory: processMemory, channels: [channel], ptrWidth: 4 }],
    ]),
    activeChannels: [channel],
    channelTids: new Map([["42:0", 43]]),
    pendingSelectRetries: new Map(),
    pendingPollRetries: new Map(),
    pendingSleeps: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    completeChannel,
    handleProcessTerminated,
  });

  return {
    channel,
    completeChannel,
    dequeueSignal,
    handleChannel,
    handleProcessTerminated,
    processMemory,
    setCurrentTid,
    worker,
  };
}

describe("select and pselect signal outcomes", () => {
  it("returns EINTR instead of re-parking pselect after a caught signal", () => {
    const harness = createHarness({ handlerSignal: 10 });
    const readfdsPtr = 1024;
    const timespecPtr = 2048;
    const view = new DataView(harness.processMemory.buffer);
    view.setUint8(readfdsPtr, 1);
    view.setBigInt64(timespecPtr, 1n, true);
    view.setBigInt64(timespecPtr + 8, 0n, true);
    const args = [1, readfdsPtr, 0, 0, timespecPtr, 0];

    harness.worker.handlePselect6(harness.channel, args);

    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Pselect6,
      args,
      undefined,
      -1,
      EINTR,
    );
    expect(harness.worker.pendingSelectRetries.size).toBe(0);
    expect(harness.setCurrentTid).toHaveBeenCalledWith(42, 43);
    expect(harness.setCurrentTid.mock.invocationCallOrder.at(-1)).toBeLessThan(
      harness.dequeueSignal.mock.invocationCallOrder[0],
    );
  });

  it("interrupts the pure-sleep select fast path without entering the kernel", () => {
    const harness = createHarness({ handlerSignal: 12 });
    const args = [0, 0, 0, 0, 0];

    harness.worker.handleSelect(harness.channel, args);

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Select,
      args,
      undefined,
      -1,
      EINTR,
    );
    expect(harness.worker.pendingSelectRetries.size).toBe(0);
  });

  it("re-parks pure-sleep select when no caught signal is delivered", () => {
    const harness = createHarness();

    harness.worker.handleSelect(harness.channel, [0, 0, 0, 0, 0]);

    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.worker.pendingSelectRetries.has(harness.channel)).toBe(true);
  });

  it("reaps a default signal death without waking select guest code", () => {
    const harness = createHarness({ exitSignal: 15 });

    harness.worker.handleSelect(harness.channel, [0, 0, 0, 0, 0]);

    expect(harness.handleProcessTerminated).toHaveBeenCalledWith(harness.channel);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.worker.pendingSelectRetries.size).toBe(0);
  });

  it("preserves a ready select result when a handler signal arrives concurrently", () => {
    const harness = createHarness({ handlerSignal: 10, returnValue: 1, errno: 0 });
    const args = [1, 1024, 0, 0, 0];
    new DataView(harness.processMemory.buffer).setUint8(1024, 1);

    harness.worker.handleSelect(harness.channel, args);

    expect(
      new DataView(harness.processMemory.buffer).getUint32(CH_SIG_BASE, true),
    ).toBe(10);
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Select,
      args,
      undefined,
      1,
      0,
    );
  });
});
