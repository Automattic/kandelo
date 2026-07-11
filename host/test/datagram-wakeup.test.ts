import { afterEach, describe, expect, it, vi } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const WAKE_DATAGRAM_WRITABLE = 8;

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
}

function createWorkerHarness(): any {
  const memory = createSharedMemory();
  const scratchOffset = 128;
  const drain = (outPtr: number): number => {
    const bytes = new Uint8Array(memory.buffer, outPtr, 5);
    bytes.fill(0);
    bytes[4] = WAKE_DATAGRAM_WRITABLE;
    return 1;
  };

  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
    kernelInstance: { exports: { kernel_drain_wakeup_events: drain } },
    kernelMemory: memory,
    scratchOffset,
    processes: new Map(),
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    pendingPipeReaders: new Map(),
    pendingPipeWriters: new Map(),
    wakeScheduled: false,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("datagram send-state wakeups", () => {
  it("retries blocked writes immediately without bypassing signal-safe poll deferral", () => {
    vi.useFakeTimers();
    const worker = createWorkerHarness();
    const channel = { pid: 42, channelOffset: 0, memory: createSharedMemory() };
    const pollChannel = { pid: channel.pid, channelOffset: 64, memory: channel.memory };
    worker.processes.set(channel.pid, { channels: [channel, pollChannel] });

    const fallback = vi.fn();
    const timer = setTimeout(fallback, 1);
    worker.pendingPollRetries.set(channel.channelOffset, {
      timer,
      channel,
      pipeIndices: [],
      deadline: Date.now() + 1,
      isWriteRetry: true,
    });
    worker.pendingPollRetries.set(pollChannel.channelOffset, {
      timer: null,
      channel: pollChannel,
      pipeIndices: [],
      needsSignalSafeWake: true,
    });
    worker.retrySyscall = vi.fn();
    worker.scheduleWakeBlockedRetries = vi.fn();
    worker.scheduleWakeBlockedRetriesDeferred = vi.fn();

    worker.drainAndProcessWakeupEvents();

    expect(worker.retrySyscall).toHaveBeenCalledOnce();
    expect(worker.retrySyscall).toHaveBeenCalledWith(channel);
    expect(worker.pendingPollRetries.has(channel.channelOffset)).toBe(false);
    expect(worker.pendingPollRetries.has(pollChannel.channelOffset)).toBe(true);
    expect(worker.scheduleWakeBlockedRetries).not.toHaveBeenCalled();
    expect(worker.scheduleWakeBlockedRetriesDeferred).toHaveBeenCalledOnce();

    vi.runAllTimers();
    expect(fallback).not.toHaveBeenCalled();
  });
});
