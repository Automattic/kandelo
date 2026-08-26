import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_BASE,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const EINPROGRESS = 115;
const EALREADY = 114;
const ECONNREFUSED = 111;
const EINTR = 4;

type KernelResult = { retVal: number; errVal: number };

function createSharedMemory(pages = 2): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
}

function createConnectHarness(
  results: KernelResult[],
  options: {
    nonblock?: boolean;
    family?: number;
    handlerSignal?: number;
  } = {},
) {
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();
  const pid = 42;
  const fd = 7;
  const addrPtr = 1024;
  const addrLen = 16;
  const args = [fd, addrPtr, addrLen, 0, 0, 0];

  let resultIndex = 0;
  const handleChannel = vi.fn((offset: number) => {
    const result = results[Math.min(resultIndex, results.length - 1)];
    resultIndex++;
    const kernelView = new DataView(kernelMemory.buffer, offset);
    kernelView.setBigInt64(CH_RETURN, BigInt(result.retVal), true);
    kernelView.setUint32(CH_ERRNO, result.errVal, true);
    return 0;
  });
  const completeChannel = vi.fn();
  const isFdNonblock = vi.fn(() => options.nonblock ? 1 : 0);
  const getSocketTimeout = vi.fn(() => 0n);
  const worker = createCentralizedKernelWorkerTestDouble();
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    4,
    {
      kernelExports: {
        kernel_blocking_retry_release: () => 0,
        kernel_blocking_retry_token: () => 1n,
        kernel_dequeue_signal: (
          _pid: number,
          _tid: number,
          rawPointer: number | bigint,
        ) => {
          const signal = options.handlerSignal ?? 0;
          if (signal <= 0) return 0;
          new DataView(kernelMemory.buffer).setUint32(
            Number(rawPointer) + CH_SIG_SIGNUM - CH_SIG_BASE,
            signal,
            true,
          );
          return signal;
        },
        kernel_get_process_exit_signal: () => -1,
        kernel_get_socket_timeout_ms: getSocketTimeout,
        kernel_handle_channel: handleChannel,
        kernel_is_fd_nonblock: isFdNonblock,
        kernel_set_current_tid: () => 0,
        kernel_vblank: () => 0,
      },
    },
  );
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel,
    completeChannelRaw: vi.fn(),
    relistenChannel: vi.fn(),
    synchronizeSharedMemoryForBoundary: vi.fn(),
  });
  const [channel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory: processMemory,
      channelOffsets: [0],
      pointerWidth: 4,
    });
  const processView = new DataView(processMemory.buffer);
  processView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Connect, true);
  processView.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  args.forEach((arg, index) => {
    processView.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, BigInt(arg), true);
  });
  processView.setUint16(addrPtr, options.family ?? 2, true);
  processView.setUint16(addrPtr + 2, 80, false);
  new Uint8Array(processMemory.buffer, addrPtr + 4, 4).set([203, 0, 113, 9]);

  return {
    args,
    channel,
    completeChannel,
    getSocketTimeout,
    handleChannel,
    isFdNonblock,
    worker,
  };
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
    expect(harness.isFdNonblock).toHaveBeenCalledTimes(2);
    expect(harness.getSocketTimeout).not.toHaveBeenCalled();
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
    expect(harness.completeChannel.mock.calls[0].slice(4, 6)).toEqual([0, 0]);
    expect(harness.worker.pendingPollRetries.size).toBe(0);
    expect(harness.isFdNonblock).toHaveBeenCalledOnce();
    expect(harness.getSocketTimeout).toHaveBeenCalledOnce();
  });

  it("interrupts a blocking pending connect for a caught signal", () => {
    const harness = createConnectHarness(
      [{ retVal: -1, errVal: EINPROGRESS }],
      { handlerSignal: 10 },
    );

    harness.worker.handleSyscall(harness.channel);

    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0].slice(4, 6))
      .toEqual([-1, EINTR]);
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
    expect(harness.completeChannel.mock.calls[0].slice(4, 6)).toEqual([-1, ECONNREFUSED]);
    expect(harness.worker.pendingPollRetries.size).toBe(0);
    expect(harness.isFdNonblock).toHaveBeenCalledOnce();
    expect(harness.getSocketTimeout).toHaveBeenCalledOnce();
  });

  it("does not apply the host-delegated AF_INET retry rule to AF_UNIX", () => {
    const harness = createConnectHarness(
      [{ retVal: -1, errVal: EINPROGRESS }],
      { family: 1 },
    );

    harness.worker.handleSyscall(harness.channel);

    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0].slice(4, 6)).toEqual([-1, EINPROGRESS]);
    expect(harness.worker.pendingPollRetries.size).toBe(0);
    expect(harness.isFdNonblock).not.toHaveBeenCalled();
    expect(harness.getSocketTimeout).not.toHaveBeenCalled();
  });

  it("names EALREADY in syscall diagnostics", () => {
    const worker = createCentralizedKernelWorkerTestDouble();

    expect(worker.formatSyscallReturn(ABI_SYSCALLS.Connect, -1, EALREADY))
      .toBe(" = -1 (EALREADY)");
  });
});
