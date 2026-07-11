import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const PID = 100;
const EAGAIN = 11;

function makeChannel(): any {
  return {
    pid: PID,
    memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
    channelOffset: 0,
    i32View: new Int32Array(new SharedArrayBuffer(4)),
    consecutiveSyscalls: 0,
  };
}

function makeWorker(pipeIndices: number[] = [7]): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    processes: new Map([[PID, {}]]),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    resolvePollReadinessIndices: vi.fn(() => ({
      pipeIndices,
      acceptIndices: [],
    })),
    kernelMemory: new WebAssembly.Memory({ initial: 1 }),
    scratchOffset: 1024,
    cachedKernelMem: null,
    cachedKernelBuffer: null,
    clearSocketTimeout: vi.fn(),
    drainAllPtyOutputs: vi.fn(),
    flushTcpSendPipes: vi.fn(),
    drainAndProcessWakeupEvents: vi.fn(),
    relistenChannel: vi.fn(),
  });
}

function pollArgs(_channel: any, timeoutMs: number): number[] {
  return [256, 1, timeoutMs, 0, 0, 0];
}

function ppollArgs(channel: any, timeoutMs: number): number[] {
  const timeoutPtr = 512;
  const view = new DataView(channel.memory.buffer);
  view.setBigInt64(timeoutPtr, BigInt(Math.floor(timeoutMs / 1000)), true);
  view.setBigInt64(timeoutPtr + 8, BigInt(timeoutMs % 1000) * 1_000_000n, true);
  return [256, 1, timeoutPtr, 0, 8, 0];
}

function completeFinalPollRetry(
  worker: any,
  channel: any,
  syscallNr: number,
  args: number[],
): void {
  if (channel.pollTimeoutOverride !== 0) {
    worker.handleBlockingRetry(channel, syscallNr, args);
    return;
  }
  worker.completeChannel(channel, syscallNr, args, undefined, 0, 0);
}

describe("CentralizedKernelWorker finite poll deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["poll", ABI_SYSCALLS.Poll, pollArgs],
    ["ppoll", ABI_SYSCALLS.Ppoll, ppollArgs],
  ] as const)("times out %s at its original deadline across safety retries", async (
    _name,
    syscallNr,
    makeArgs,
  ) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const worker = makeWorker();
    const channel = makeChannel();
    const args = makeArgs(channel, 25) as number[];
    const complete = vi.spyOn(worker, "completeChannel");
    worker.retrySyscall = vi.fn((retryChannel: any) => {
      completeFinalPollRetry(worker, retryChannel, syscallNr, args);
    });

    worker.handleBlockingRetry(channel, syscallNr, args);

    await vi.advanceTimersByTimeAsync(24);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(channel.pollDeadline).toBeUndefined();
    expect(channel.pollTimeoutOverride).toBeUndefined();
  });

  it("does not extend an nfds=0 deadline across broad wakes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const worker = makeWorker([]);
    const channel = makeChannel();
    const args = [0, 0, 30, 0, 0, 0];
    const complete = vi.spyOn(worker, "completeChannel");
    worker.retrySyscall = vi.fn((retryChannel: any) => {
      completeFinalPollRetry(worker, retryChannel, ABI_SYSCALLS.Poll, args);
    });

    worker.handleBlockingRetry(channel, ABI_SYSCALLS.Poll, args);
    await vi.advanceTimersByTimeAsync(5);
    worker.wakeAllBlockedRetries();
    await vi.advanceTimersByTimeAsync(7);
    worker.wakeAllBlockedRetries();
    await vi.advanceTimersByTimeAsync(17);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(channel.pollDeadline).toBeUndefined();
    expect(channel.pollTimeoutOverride).toBeUndefined();
  });

  it("cancels the timeout when targeted readiness arrives before the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const worker = makeWorker([7]);
    const channel = makeChannel();
    const args = pollArgs(channel, 40);
    const complete = vi.spyOn(worker, "completeChannel");
    worker.retrySyscall = vi.fn((retryChannel: any) => {
      expect(retryChannel.pollDeadline).toBe(3_040);
      worker.completeChannel(
        retryChannel,
        ABI_SYSCALLS.Poll,
        args,
        undefined,
        1,
        0,
      );
    });

    worker.handleBlockingRetry(channel, ABI_SYSCALLS.Poll, args);
    await vi.advanceTimersByTimeAsync(7);
    worker.wakeBlockedPoll(PID, 7);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(channel.pollDeadline).toBeUndefined();
    expect(channel.pollTimeoutOverride).toBeUndefined();
    expect(worker.pendingPollRetries.size).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("finalizes ppoll in the kernel with timeout zero and copies cleared revents", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const processMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const kernelMemory = new WebAssembly.Memory({ initial: 2 });
    const channelOffset = 65_536;
    const channel: any = {
      pid: PID,
      memory: processMemory,
      channelOffset,
      i32View: new Int32Array(processMemory.buffer, channelOffset),
      consecutiveSyscalls: 0,
    };
    const originalMask = 0x20n;
    const temporaryMask = 0x400n;
    let activeMask = originalMask;
    let savedMask: bigint | null = null;
    const timeoutArgs: number[] = [];

    const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      kernel: { toKernelPtr: (value: number | bigint) => value },
      kernelMemory,
      scratchOffset: 0,
      cachedKernelMem: null,
      cachedKernelBuffer: null,
      currentHandlePid: 0,
      channelTids: new Map(),
      processes: new Map([[PID, {
        pid: PID,
        ptrWidth: 4,
        channels: [channel],
        explicitMaxAddr: true,
      }]]),
      pendingPollRetries: new Map(),
      pendingSelectRetries: new Map(),
      pendingPipeReaders: new Map(),
      pendingPipeWriters: new Map(),
      pendingCancels: new Set(),
      pendingSleeps: new Map(),
      sharedMappings: new Map(),
      syscallRing: new Map(),
      syscallTraceEnabled: false,
      syscallTraceRing: [],
      config: {},
      usePolling: false,
      schedulingDeferredChannels: new Set(),
      schedulingDeferredRelistens: new Set(),
      resolvePollReadinessIndices: vi.fn(() => ({
        pipeIndices: [],
        acceptIndices: [],
      })),
      clearSocketTimeout: vi.fn(),
      drainAllPtyOutputs: vi.fn(),
      flushTcpSendPipes: vi.fn(),
      drainAndProcessWakeupEvents: vi.fn(),
      relistenChannel: vi.fn(),
    });

    worker.kernelInstance = {
      exports: {
        kernel_set_current_tid: () => {},
        kernel_handle_channel: () => {
          const view = new DataView(kernelMemory.buffer);
          const timeoutMs = Number(
            view.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
          );
          timeoutArgs.push(timeoutMs);

          const hasMask = Number(
            view.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
          );
          if (hasMask !== 0 && savedMask === null) {
            const lo = BigInt(Number(
              view.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true),
            ) >>> 0);
            const hi = BigInt(Number(
              view.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
            ) >>> 0);
            savedMask = activeMask;
            activeMask = lo | (hi << 32n);
          }

          const fdsPtr = Number(view.getBigInt64(CH_ARGS, true));
          new DataView(kernelMemory.buffer).setInt16(fdsPtr + 6, 0, true);
          if (timeoutMs === 0) {
            if (savedMask !== null) {
              activeMask = savedMask;
              savedMask = null;
            }
            view.setBigInt64(CH_RETURN, 0n, true);
            view.setUint32(CH_ERRNO, 0, true);
          } else {
            view.setBigInt64(CH_RETURN, -1n, true);
            view.setUint32(CH_ERRNO, EAGAIN, true);
          }
          return 0;
        },
      },
    };

    const pollfdPtr = 256;
    const timespecPtr = 512;
    const maskPtr = 544;
    const processView = new DataView(processMemory.buffer);
    processView.setInt32(pollfdPtr, 0, true);
    processView.setInt16(pollfdPtr + 4, 1, true);
    processView.setInt16(pollfdPtr + 6, 0x20, true);
    processView.setBigInt64(timespecPtr, 0n, true);
    processView.setBigInt64(timespecPtr + 8, 25_000_000n, true);
    processView.setBigUint64(maskPtr, temporaryMask, true);
    const originalTimespec = new Uint8Array(
      processMemory.buffer,
      timespecPtr,
      16,
    ).slice();

    const channelView = new DataView(processMemory.buffer, channelOffset);
    channelView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Ppoll, true);
    const args = [pollfdPtr, 1, timespecPtr, maskPtr, 8, 0];
    for (let i = 0; i < args.length; i++) {
      channelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, BigInt(args[i]), true);
    }

    worker.handleSyscall(channel);
    expect(channel.pollDeadline).toBe(25);
    expect(activeMask).toBe(temporaryMask);

    await vi.advanceTimersByTimeAsync(5);
    worker.wakeAllBlockedRetries();
    expect(channel.pollDeadline).toBe(25);
    await vi.advanceTimersByTimeAsync(20);

    expect(timeoutArgs).toEqual([25, 25, 0]);
    expect(processView.getInt16(pollfdPtr + 6, true)).toBe(0);
    expect(new Uint8Array(processMemory.buffer, timespecPtr, 16)).toEqual(originalTimespec);
    expect(activeMask).toBe(originalMask);
    expect(savedMask).toBeNull();
    expect(channel.pollDeadline).toBeUndefined();
    expect(channel.pollTimeoutOverride).toBeUndefined();
  });
});
