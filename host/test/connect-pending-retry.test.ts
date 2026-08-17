import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const EINPROGRESS = 115;
const EALREADY = 114;
const ECONNREFUSED = 111;

type KernelResult = { retVal: number; errVal: number };

function createSharedMemory(pages = 2): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
}

function createConnectHarness(
  results: KernelResult[],
  options: { nonblock?: boolean; family?: number } = {},
) {
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();
  const channel: any = {
    pid: 42,
    channelOffset: 0,
    memory: processMemory,
    i32View: new Int32Array(processMemory.buffer),
  };
  const fd = 7;
  const addrPtr = 1024;
  const addrLen = 16;
  const args = [fd, addrPtr, addrLen, 0, 0, 0];
  const processView = new DataView(processMemory.buffer);
  processView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Connect, true);
  args.forEach((arg, index) => {
    processView.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, BigInt(arg), true);
  });
  processView.setUint16(addrPtr, options.family ?? 2, true);
  processView.setUint16(addrPtr + 2, 80, false);
  new Uint8Array(processMemory.buffer, addrPtr + 4, 4).set([203, 0, 113, 9]);

  let resultIndex = 0;
  const handleChannel = vi.fn(() => {
    const result = results[Math.min(resultIndex, results.length - 1)];
    resultIndex++;
    const kernelView = new DataView(kernelMemory.buffer);
    kernelView.setBigInt64(CH_RETURN, BigInt(result.retVal), true);
    kernelView.setUint32(CH_ERRNO, result.errVal, true);
    return 0;
  });
  const completeChannel = vi.fn();
  const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
    kernelInstance: {
      exports: {
        kernel_handle_channel: handleChannel,
        kernel_is_fd_nonblock: vi.fn(() => options.nonblock ? 1 : 0),
      },
    },
    kernelMemory,
    scratchOffset: 0,
    currentHandlePid: 0,
    config: {},
    syscallRing: new Map(),
    channelTids: new Map(),
    syscallTraceEnabled: false,
    sharedMmapBackings: new Map(),
    hostReaped: new Set(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingSleeps: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    socketTimeoutTimers: new Map(),
    isRegisteredChannel: vi.fn(() => true),
    isAsyncChannelProcessActive: vi.fn(() => true),
    deferChannelWhileStopped: vi.fn(() => false),
    synchronizeSharedMemoryForBoundary: vi.fn(),
    bindKernelTidForChannel: vi.fn(),
    highControlFloorForProcess: vi.fn(() => null),
    getProcessExitSignal: vi.fn(() => 0),
    dequeueSignalForDelivery: vi.fn(() => 0),
    finishSignalTermination: vi.fn(() => false),
    completeChannel,
    completeChannelRaw: vi.fn(),
    relistenChannel: vi.fn(),
  });

  return { args, channel, completeChannel, handleChannel, worker };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pending AF_INET connect routing", () => {
  it("preserves EINPROGRESS and EALREADY for a non-blocking socket", () => {
    const harness = createConnectHarness(
      [
        { retVal: -1, errVal: EINPROGRESS },
        { retVal: -1, errVal: EALREADY },
      ],
      { nonblock: true },
    );

    harness.worker.handleSyscall(harness.channel);
    harness.worker.handleSyscall(harness.channel);

    expect(harness.completeChannel).toHaveBeenCalledTimes(2);
    expect(harness.completeChannel.mock.calls[0].slice(-2)).toEqual([-1, EINPROGRESS]);
    expect(harness.completeChannel.mock.calls[1].slice(-2)).toEqual([-1, EALREADY]);
    expect(harness.worker.pendingPollRetries.size).toBe(0);
  });

  it("retries a blocking connect until success", () => {
    vi.useFakeTimers();
    const harness = createConnectHarness([
      { retVal: -1, errVal: EINPROGRESS },
      { retVal: 0, errVal: 0 },
    ]);

    harness.worker.handleSyscall(harness.channel);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(true);

    vi.advanceTimersByTime(10);

    expect(harness.handleChannel).toHaveBeenCalledTimes(2);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0].slice(-2)).toEqual([0, 0]);
    expect(harness.worker.pendingPollRetries.size).toBe(0);
  });

  it("keeps a blocking EALREADY retry parked and then returns the failure", () => {
    vi.useFakeTimers();
    const harness = createConnectHarness([
      { retVal: -1, errVal: EINPROGRESS },
      { retVal: -1, errVal: EALREADY },
      { retVal: -1, errVal: ECONNREFUSED },
    ]);

    harness.worker.handleSyscall(harness.channel);
    vi.advanceTimersByTime(10);
    expect(harness.handleChannel).toHaveBeenCalledTimes(2);
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(true);

    vi.advanceTimersByTime(10);

    expect(harness.handleChannel).toHaveBeenCalledTimes(3);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0].slice(-2)).toEqual([-1, ECONNREFUSED]);
    expect(harness.worker.pendingPollRetries.size).toBe(0);
  });

  it("does not apply the host-delegated AF_INET retry rule to AF_UNIX", () => {
    const harness = createConnectHarness(
      [{ retVal: -1, errVal: EINPROGRESS }],
      { family: 1 },
    );

    harness.worker.handleSyscall(harness.channel);

    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0].slice(-2)).toEqual([-1, EINPROGRESS]);
    expect(harness.worker.pendingPollRetries.size).toBe(0);
  });

  it("names EALREADY in syscall diagnostics", () => {
    const worker: any = Object.create(CentralizedKernelWorker.prototype);

    expect(worker.formatSyscallReturn(ABI_SYSCALLS.Connect, -1, EALREADY))
      .toBe(" = -1 (EALREADY)");
  });
});
