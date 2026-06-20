import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
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

  it("preserves a finite poll deadline across retry wakes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const processMemory = createSharedMemory();
    const worker = createWorkerHarness({});
    const channel = createChannel(42, processMemory);
    worker.processes = new Map([
      [42, { pid: 42, memory: processMemory, channels: [channel], ptrWidth: 4 }],
    ]);
    worker.activeChannels = [channel];

    const origArgs = [1024, 1, 10];
    worker.retrySyscall = vi.fn(() => {
      worker.handleBlockingRetry(channel, ABI_SYSCALLS.Poll, origArgs);
    });

    worker.handleBlockingRetry(channel, ABI_SYSCALLS.Poll, origArgs);
    expect(worker.completeChannel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5);
    worker.wakeAllBlockedRetries();
    expect(worker.completeChannel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4);
    expect(worker.completeChannel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Poll,
      origArgs,
      expect.anything(),
      0,
      0,
    );
    expect(worker.pollRetryDeadlines.size).toBe(0);
  });

  it("interrupts host-side epoll_pwait emulation when a handler signal is pending", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const scratchOffset = 128;
    const handleChannel = vi.fn(() => {
      const kernelView = new DataView(kernelMemory.buffer, scratchOffset);
      kernelView.setBigInt64(CH_RETURN, 0n, true);
      kernelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_handle_channel: handleChannel,
      kernel_get_process_exit_status: () => 0,
    });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = scratchOffset;
    worker.epollInterests = new Map([
      ["42:7", [{ fd: 3, events: 0x001, data: 99n }]],
    ]);
    worker.dequeueSignalForDelivery = vi.fn(() => 15);
    worker.completeChannelRaw = vi.fn();
    worker.relistenChannel = vi.fn();

    const channel = createChannel(42, processMemory);
    worker.processes = new Map([
      [42, { pid: 42, memory: processMemory, channels: [channel], ptrWidth: 4 }],
    ]);
    worker.activeChannels = [channel];

    worker.handleEpollPwait(channel, 241, [7, 4096, 1, 1000, 0, 8]);

    expect(worker.dequeueSignalForDelivery).toHaveBeenCalledWith(channel);
    expect(worker.completeChannelRaw).toHaveBeenCalledWith(channel, -4, 4);
    expect(worker.relistenChannel).toHaveBeenCalledWith(channel);
    expect(worker.pendingPollRetries.size).toBe(0);
  });

  it("interrupts host-side pselect6 retry when a handler signal is pending", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const scratchOffset = 128;
    const handleChannel = vi.fn(() => {
      const kernelView = new DataView(kernelMemory.buffer, scratchOffset);
      kernelView.setBigInt64(CH_RETURN, -1n, true);
      kernelView.setUint32(CH_ERRNO, 11, true);
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_handle_channel: handleChannel,
      kernel_get_process_exit_status: () => 0,
    });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = scratchOffset;
    worker.dequeueSignalForDelivery = vi.fn(() => 10);

    const channel = createChannel(42, processMemory);
    worker.processes = new Map([
      [42, { pid: 42, memory: processMemory, channels: [channel], ptrWidth: 4 }],
    ]);
    worker.activeChannels = [channel];

    const readfdsPtr = 1024;
    const tsPtr = 2048;
    const processView = new DataView(processMemory.buffer);
    processView.setUint8(readfdsPtr, 1);
    processView.setBigInt64(tsPtr, 1n, true);
    processView.setBigInt64(tsPtr + 8, 0n, true);

    const origArgs = [1, readfdsPtr, 0, 0, tsPtr, 0];
    worker.handlePselect6(channel, origArgs);

    expect(worker.dequeueSignalForDelivery).toHaveBeenCalledWith(channel);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      expect.any(Number),
      origArgs,
      undefined,
      -1,
      4,
    );
    expect(worker.pendingSelectRetries.size).toBe(0);
  });

  it("does not truncate multi-kilobyte exec environment strings", () => {
    const worker = createWorkerHarness({});
    const processMemory = createSharedMemory();
    const mem = new Uint8Array(processMemory.buffer);
    const view = new DataView(processMemory.buffer);
    const arrayPtr = 1024;
    const stringPtr = 4096;
    const value = `FPM_SOCKETS=${"x".repeat(9000)}`;
    mem.set(new TextEncoder().encode(value), stringPtr);
    mem[stringPtr + value.length] = 0;
    view.setUint32(arrayPtr, stringPtr, true);
    view.setUint32(arrayPtr + 4, 0, true);

    expect(worker.readStringArrayFromProcess(mem, arrayPtr, 4)).toEqual([value]);
  });

  it("implements times(2) with ptr-width aware tms output", () => {
    const worker = createWorkerHarness({});
    const processMemory = createSharedMemory();
    const processView = new DataView(processMemory.buffer);
    const channel = createChannel(42, processMemory);
    worker.processes = new Map([
      [42, { pid: 42, memory: processMemory, channels: [channel], ptrWidth: 4 }],
    ]);
    worker.activeChannels = [channel];

    const tms32 = 1024;
    worker.handleTimes(channel, [tms32, 0, 0, 0, 0, 0]);

    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Times,
      [tms32, 0, 0, 0, 0, 0],
      undefined,
      expect.any(Number),
      0,
    );
    for (let off = 0; off < 16; off += 4) {
      expect(processView.getInt32(tms32 + off, true)).toBe(0);
    }

    const worker64 = createWorkerHarness({});
    const processMemory64 = createSharedMemory();
    const processView64 = new DataView(processMemory64.buffer);
    const channel64 = createChannel(43, processMemory64);
    worker64.processes = new Map([
      [43, { pid: 43, memory: processMemory64, channels: [channel64], ptrWidth: 8 }],
    ]);
    worker64.activeChannels = [channel64];

    const tms64 = 2048;
    worker64.handleTimes(channel64, [tms64, 0, 0, 0, 0, 0]);

    for (let off = 0; off < 32; off += 8) {
      expect(processView64.getBigInt64(tms64 + off, true)).toBe(0n);
    }
  });

  it("merges disjoint MAP_SHARED writes from live processes", () => {
    const worker = createWorkerHarness({});
    const mem1 = createSharedMemory();
    const mem2 = createSharedMemory();
    const addr = 1024;
    const len = 16;
    const key = "anon:test";
    const backing = {
      key,
      path: "",
      handle: -1,
      anonymous: true,
      writable: true,
      pages: new Map(),
      dirtyPages: new Set(),
      refCount: 2,
      version: 0,
    };
    const makeMapping = () => ({
      fd: -1,
      fileOffset: 0,
      len,
      writable: true,
      backingKey: key,
      snapshot: new Uint8Array(len),
      version: 0,
    });

    new Uint8Array(mem1.buffer)[addr] = "A".charCodeAt(0);
    new Uint8Array(mem2.buffer)[addr + 1] = "B".charCodeAt(0);
    const channel1 = createChannel(1, mem1);
    const channel2 = createChannel(2, mem2);
    worker.processes = new Map([
      [1, { pid: 1, memory: mem1, channels: [channel1], ptrWidth: 4 }],
      [2, { pid: 2, memory: mem2, channels: [channel2], ptrWidth: 4 }],
    ]);
    worker.sharedMmapBackings = new Map([[key, backing]]);
    worker.sharedMappings = new Map([
      [1, new Map([[addr, makeMapping()]])],
      [2, new Map([[addr, makeMapping()]])],
    ]);

    worker.syncSharedMappingsFromProcess(channel1, true);
    worker.syncSharedMappingsFromProcess(channel2, true);
    const latest = worker.readBackingRange(backing, 0, len);
    expect(String.fromCharCode(latest[0], latest[1])).toBe("AB");

    worker.refreshSharedMappingsToProcess(channel1, true);
    expect(String.fromCharCode(
      new Uint8Array(mem1.buffer)[addr],
      new Uint8Array(mem1.buffer)[addr + 1],
    )).toBe("AB");
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
    pollRetryDeadlines: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    socketTimeoutTimers: new Map(),
    pendingCancels: new Set(),
    tcpListeners: new Map(),
    tcpListenerTargets: new Map(),
    tcpListenerRRIndex: new Map(),
    sharedMappings: new Map(),
    sharedMmapBackings: new Map(),
    tcpConnections: new Map(),
    shmMappings: new Map(),
    usePolling: false,
    completeChannel: vi.fn(),
    dequeueSignalForDelivery: vi.fn(),
    bindKernelTidForChannel: vi.fn(),
    assertKernelStackContext: vi.fn(),
    assertKernelStackStage: vi.fn(),
    assertKernelStackBaseline: vi.fn(),
    isKernelStackTraceEnabled: vi.fn(() => false),
    synchronizeSharedMappingsForSyscallBoundary: vi.fn(),
    synchronizeSysvShmMappingsForSyscallBoundary: vi.fn(),
    flushSharedMappingsBeforeFileSyscall: vi.fn(),
    handleSharedMappingsAfterFileSyscall: vi.fn(),
    toKernelPtr(value: number | bigint): number {
      return Number(value);
    },
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
