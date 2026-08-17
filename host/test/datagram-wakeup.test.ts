import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const WAKE_DATAGRAM_WRITABLE = 8;

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
}

function createWorkerHarness(): any {
  const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const drain = (outPtr: number): number => {
    const bytes = new Uint8Array(kernelMemory.buffer, outPtr, 5);
    bytes.fill(0);
    bytes[4] = WAKE_DATAGRAM_WRITABLE;
    return 1;
  };
  const handleChannel = vi.fn((outPtr: number) => {
    const view = new DataView(kernelMemory.buffer, outPtr);
    view.setBigInt64(CH_RETURN, 42n, true);
    view.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  const worker = Object.assign(createCentralizedKernelWorkerTestDouble(), {
    activeChannels: [],
    processes: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    wakeScheduled: false,
    usePolling: true,
  });
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    4,
    {
      kernelExports: {
        kernel_dequeue_signal: vi.fn(() => 0),
        kernel_drain_wakeup_events: drain,
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_handle_channel: handleChannel,
        kernel_set_current_tid: vi.fn(() => 0),
      },
    },
  );
  return { handleChannel, worker };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("datagram send-state wakeups", () => {
  it("retries blocked writes immediately without bypassing signal-safe poll deferral", async () => {
    vi.useFakeTimers();
    const { handleChannel, worker } = createWorkerHarness();
    const processMemory = createSharedMemory();
    const channel = {
      pid: 42,
      channelOffset: 0,
      memory: processMemory,
      i32View: new Int32Array(processMemory.buffer),
      consecutiveSyscalls: 0,
    };
    const pollChannel = {
      pid: channel.pid,
      channelOffset: 64,
      memory: channel.memory,
      i32View: new Int32Array(processMemory.buffer, 64),
      consecutiveSyscalls: 0,
    };
    worker.processes.set(channel.pid, {
      pid: channel.pid,
      memory: processMemory,
      channels: [channel, pollChannel],
      explicitMaxAddr: true,
    });
    worker.activeChannels = [channel, pollChannel];
    const channelView = new DataView(processMemory.buffer);
    channelView.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    channelView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getpid, true);

    const fallback = vi.fn();
    const timer = setTimeout(fallback, 1);
    worker.pendingPollRetries.set(channel, {
      timer,
      channel,
      pipeIndices: [],
      deadline: Date.now() + 1,
      isWriteRetry: true,
    });
    worker.pendingPollRetries.set(pollChannel, {
      timer: null,
      channel: pollChannel,
      pipeIndices: [],
      needsSignalSafeWake: true,
    });

    worker.drainAndProcessWakeupEvents();
    for (let index = 0; index < 8; index++) await Promise.resolve();

    expect(handleChannel).toHaveBeenCalledOnce();
    expect(channelView.getUint32(CH_STATUS, true))
      .toBe(CHANNEL_STATUS_COMPLETE);
    expect(Number(channelView.getBigInt64(CH_RETURN, true))).toBe(42);
    expect(channelView.getUint32(CH_ERRNO, true)).toBe(0);
    expect(worker.pendingPollRetries.has(channel)).toBe(false);
    expect(worker.pendingPollRetries.has(pollChannel)).toBe(true);

    vi.advanceTimersByTime(49);
    expect(worker.pendingPollRetries.has(pollChannel)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });
});
