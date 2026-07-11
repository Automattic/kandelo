import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const EAGAIN = 11;

function createMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
}

function createChannel(pid: number, channelOffset: number): any {
  return { pid, channelOffset, memory: createMemory() };
}

function createWorkerHarness(
  pid: number,
  kernelHandlesSelectWait = false,
  onKernelCall?: (view: DataView, memory: WebAssembly.Memory) => void,
): any {
  const kernelMemory = createMemory();
  const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => value },
    kernelMemory,
    scratchOffset: 0,
    cachedKernelMem: null,
    cachedKernelBuffer: null,
    currentHandlePid: 0,
    channelTids: new Map(),
    processes: new Map([[pid, { pid, ptrWidth: 4 }]]),
    pendingSleeps: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    completeChannel: vi.fn(),
  });
  worker.kernelInstance = {
    exports: {
      kernel_set_current_tid: () => {},
      kernel_is_signal_blocked: () => 0,
      kernel_handle_channel: () => {
        const view = new DataView(kernelMemory.buffer);
        onKernelCall?.(view, kernelMemory);
        if (!kernelHandlesSelectWait) return 0;
        const timeoutMs = Number(
          view.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true),
        );
        if (timeoutMs > 0) {
          view.setBigInt64(CH_RETURN, -1n, true);
          view.setUint32(CH_ERRNO, EAGAIN, true);
          return 0;
        }

        // Model the kernel's final nonblocking select pass: no descriptors
        // are ready, so each supplied fd_set is cleared and the call returns 0.
        const mem = new Uint8Array(kernelMemory.buffer);
        for (let arg = 1; arg <= 3; arg++) {
          const ptr = Number(
            view.getBigInt64(CH_ARGS + arg * CH_ARG_SIZE, true),
          );
          if (ptr !== 0) mem.fill(0, ptr, ptr + 128);
        }
        view.setBigInt64(CH_RETURN, 0n, true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      },
    },
  };
  return worker;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("select deadline preservation", () => {
  it("finalizes a finite select with timeout zero and clears fd_sets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const pid = 7;
    const timeoutArgs: number[] = [];
    const worker = createWorkerHarness(pid, true, (view) => {
      timeoutArgs.push(Number(view.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true)));
    });
    const channel = createChannel(pid, 1024);
    const timevalPtr = 128;
    const readPtr = 256;
    const timeval = new DataView(channel.memory.buffer, timevalPtr);
    timeval.setInt32(0, 0, true);
    timeval.setInt32(4, 100_000, true);
    new Uint8Array(channel.memory.buffer)[readPtr] = 1;
    const args = [1, readPtr, 0, 0, timevalPtr];

    worker.handleSelect(channel, args);
    expect(worker.pendingSelectRetries.get(channel.channelOffset).deadline).toBe(100);

    vi.advanceTimersByTime(40);
    worker.wakeAllBlockedRetries();
    expect(worker.pendingSelectRetries.get(channel.channelOffset).deadline).toBe(100);

    vi.advanceTimersByTime(59);
    expect(worker.completeChannel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker.completeChannel).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(channel.memory.buffer)[readPtr]).toBe(0);
    expect(timeoutArgs).toEqual([100, 60, 10, 0]);
  });

  it("finalizes pselect6 with timeout zero, clears fd_sets, and restores its mask", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const pid = 8;
    const originalMask = 0x20n;
    const temporaryMask = 0x400n;
    let activeMask = originalMask;
    let savedMask: bigint | null = null;
    const seenMasks: bigint[] = [];
    const timeoutArgs: number[] = [];
    const worker = createWorkerHarness(pid, true, (view, kernelMemory) => {
      const timeoutMs = Number(
        view.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true),
      );
      timeoutArgs.push(timeoutMs);
      const maskPtr = Number(
        view.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
      );
      if (maskPtr !== 0) {
        const mask = new DataView(kernelMemory.buffer).getBigUint64(maskPtr, true);
        seenMasks.push(mask);
        if (savedMask === null) {
          savedMask = activeMask;
          activeMask = mask;
        }
      }
      if (timeoutMs === 0 && savedMask !== null) {
        activeMask = savedMask;
        savedMask = null;
      }
    });
    const channel = createChannel(pid, 2048);
    const timespecPtr = 128;
    const readPtr = 256;
    const maskDataPtr = 400;
    const maskPtr = 416;
    const timespec = new DataView(channel.memory.buffer, timespecPtr);
    timespec.setBigInt64(0, 0n, true);
    timespec.setBigInt64(8, 100_000_000n, true);
    const processView = new DataView(channel.memory.buffer);
    processView.setUint8(readPtr, 1);
    processView.setUint32(maskDataPtr, maskPtr, true);
    processView.setUint32(maskDataPtr + 4, 8, true);
    processView.setBigUint64(maskPtr, temporaryMask, true);
    const args = [1, readPtr, 0, 0, timespecPtr, maskDataPtr];

    worker.handlePselect6(channel, args);
    expect(worker.pendingSelectRetries.get(channel.channelOffset).deadline).toBe(100);
    expect(activeMask).toBe(temporaryMask);

    vi.advanceTimersByTime(40);
    worker.wakeAllBlockedRetries();
    expect(worker.pendingSelectRetries.get(channel.channelOffset).deadline).toBe(100);

    vi.advanceTimersByTime(59);
    expect(worker.completeChannel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker.completeChannel).toHaveBeenCalledTimes(1);
    expect(processView.getUint8(readPtr)).toBe(0);
    expect(activeMask).toBe(originalMask);
    expect(savedMask).toBeNull();
    expect(seenMasks).toEqual([
      temporaryMask,
      temporaryMask,
      temporaryMask,
      temporaryMask,
    ]);
    expect(timeoutArgs).toEqual([100, 60, 10, 0]);
  });

  it("carries select and pselect6 deadlines through signal wakes", () => {
    const pid = 9;
    const worker = createWorkerHarness(pid);
    const selectChannel = createChannel(pid, 1024);
    const pselectChannel = createChannel(pid, 2048);
    const selectArgs = [0, 0, 0, 0, 0];
    const pselectArgs = [0, 0, 0, 0, 0, 0];
    worker.pendingSelectRetries.set(selectChannel.channelOffset, {
      timer: null,
      channel: selectChannel,
      origArgs: selectArgs,
      deadline: 123,
      syscallNr: ABI_SYSCALLS.Select,
    });
    worker.pendingSelectRetries.set(pselectChannel.channelOffset, {
      timer: null,
      channel: pselectChannel,
      origArgs: pselectArgs,
      deadline: 456,
      syscallNr: ABI_SYSCALLS.Pselect6,
    });
    worker.handleSelect = vi.fn();
    worker.handlePselect6 = vi.fn();

    worker.sendSignalToProcess(pid, 17);

    expect(worker.handleSelect).toHaveBeenCalledWith(selectChannel, selectArgs, 123);
    expect(worker.handlePselect6).toHaveBeenCalledWith(pselectChannel, pselectArgs, 456);
  });
});
