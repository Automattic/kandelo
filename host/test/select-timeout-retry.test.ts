import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CH_ERRNO,
  CH_RETURN,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

describe("centralized select/pselect timeout retries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves a finite pselect6 deadline across retry wakes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const scratchOffset = 128;
    const handleChannel = vi.fn(() => {
      const kernelView = new DataView(kernelMemory.buffer, scratchOffset);
      kernelView.setBigInt64(CH_RETURN, -1n, true);
      kernelView.setUint32(CH_ERRNO, 11, true);
      return 0;
    });
    const worker = createWorkerHarness({ kernel_handle_channel: handleChannel });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = scratchOffset;

    const channel = createChannel(42, processMemory);
    worker.processes = new Map([
      [42, { pid: 42, memory: processMemory, channels: [channel], ptrWidth: 4 }],
    ]);
    worker.activeChannels = [channel];

    const readfdsPtr = 1024;
    const tsPtr = 2048;
    const processView = new DataView(processMemory.buffer);
    processView.setUint8(readfdsPtr, 1);
    processView.setBigInt64(tsPtr, 0n, true);
    processView.setBigInt64(tsPtr + 8, 10_000_000n, true);

    const origArgs = [1, readfdsPtr, 0, 0, tsPtr, 0];
    worker.handlePselect6(channel, origArgs);
    expect(worker.completeChannel).not.toHaveBeenCalled();
    expect(handleChannel).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5);
    worker.wakeAllBlockedRetries();
    expect(worker.completeChannel).not.toHaveBeenCalled();
    expect(handleChannel).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(4);
    expect(worker.completeChannel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      expect.any(Number),
      origArgs,
      undefined,
      0,
      0,
    );
  });
});

function createWorkerHarness(exports: Record<string, unknown>): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernelInstance: { exports },
    kernel: {
      toKernelPtr(value: number | bigint): number {
        return Number(value);
      },
    },
    kernelMemory: createSharedMemory(),
    scratchOffset: 128,
    config: {},
    callbacks: {},
    processes: new Map(),
    activeChannels: [],
    syscallRing: new Map(),
    channelTids: new Map(),
    threadForkContexts: new Map(),
    stdinFinite: new Set(),
    stdinBuffers: new Map(),
    alarmTimers: new Map(),
    posixTimers: new Map(),
    pendingSleeps: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    socketTimeoutTimers: new Map(),
    pendingCancels: new Set(),
    tcpListeners: new Map(),
    tcpListenerTargets: new Map(),
    tcpListenerRRIndex: new Map(),
    sharedMappings: new Map(),
    tcpConnections: new Map(),
    shmMappings: new Map(),
    usePolling: false,
    completeChannel: vi.fn(),
    dequeueSignalForDelivery: vi.fn(),
    bindKernelTidForChannel: vi.fn(),
    assertKernelStackContext: vi.fn(),
  });
}

function createSharedMemory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

function createChannel(pid: number, memory: WebAssembly.Memory): any {
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer, 0),
    handling: false,
  };
}
