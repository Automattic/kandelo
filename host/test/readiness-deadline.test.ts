import { afterEach, describe, expect, it, vi } from "vitest";
import { ABI_SYSCALLS, CH_SIG_BASE } from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

function createSharedMemory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("finite readiness deadlines", () => {
  it("keeps one poll deadline and performs a final readiness retry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const channel: any = {
      pid: 42,
      channelOffset: 0,
      memory: createSharedMemory(),
    };
    const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      processes: new Map([[channel.pid, { channels: [channel] }]]),
      pendingPollRetries: new Map(),
      pendingSelectRetries: new Map(),
      pendingPipeReaders: new Map(),
      pendingPipeWriters: new Map(),
    });
    worker.resolvePollReadinessIndices = () => ({ pipeIndices: [], acceptIndices: [] });
    worker.completeChannel = vi.fn();

    const args = [0, 1, 120, 0, 0, 0];
    const observedDeadlines: number[] = [];
    let finalChecks = 0;
    worker.retrySyscall = vi.fn(() => {
      observedDeadlines.push(channel.readinessDeadline);
      if (channel.readinessFinalCheck) {
        // Model the zero-time kernel dispatch returning 0 after its final
        // readiness check (and, for ppoll, restoring the temporary mask).
        finalChecks++;
        channel.readinessFinalCheck = false;
        worker.completeChannel(channel, ABI_SYSCALLS.Poll, args, undefined, 0, 0);
        return;
      }
      // Model the kernel's next nonblocking check returning EAGAIN again.
      worker.handleBlockingRetry(channel, ABI_SYSCALLS.Poll, args);
    });

    worker.handleBlockingRetry(channel, ABI_SYSCALLS.Poll, args);
    expect(channel.readinessDeadline).toBe(1_120);

    vi.advanceTimersByTime(119);
    expect(worker.completeChannel).not.toHaveBeenCalled();
    expect(observedDeadlines).toEqual([1_120, 1_120]);

    vi.advanceTimersByTime(1);
    expect(observedDeadlines).toEqual([1_120, 1_120, 1_120, 1_120]);
    expect(finalChecks).toBe(1);
    expect(worker.completeChannel).toHaveBeenCalledOnce();
    expect(worker.completeChannel.mock.calls[0].slice(-2)).toEqual([0, 0]);
  });

  it("postpones a signal-safe pselect fallback until the deferred wake", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const channel: any = {
      pid: 42,
      channelOffset: 64,
      memory: createSharedMemory(),
    };
    const earlyFallback = vi.fn();
    const entry: any = {
      timer: setTimeout(earlyFallback, 1),
      channel,
      origArgs: [1, 0, 0, 0, 0, 0],
      deadline: 2_100,
      needsSignalSafeWake: true,
      syscallNr: ABI_SYSCALLS.Pselect6,
    };
    const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      processes: new Map([[channel.pid, { channels: [channel] }]]),
      pendingPollRetries: new Map(),
      pendingSelectRetries: new Map([[channel, entry]]),
      pendingPipeReaders: new Map(),
      pendingPipeWriters: new Map(),
      wakeScheduled: false,
    });
    worker.handlePselect6 = vi.fn();
    worker.wakeAllBlockedRetries = vi.fn();

    worker.scheduleWakeBlockedRetriesDeferred();

    expect(entry.deadline).toBe(2_100);
    vi.advanceTimersByTime(49);
    expect(earlyFallback).not.toHaveBeenCalled();
    expect(worker.handlePselect6).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(earlyFallback).not.toHaveBeenCalled();
    expect(worker.handlePselect6).toHaveBeenCalledOnce();
    expect(worker.handlePselect6).toHaveBeenCalledWith(channel, entry.origArgs);
    expect(worker.pendingSelectRetries.has(channel)).toBe(false);
    expect(worker.wakeAllBlockedRetries).toHaveBeenCalledOnce();
  });
});

describe("host-emulated epoll signal delivery", () => {
  it("interrupts epoll with EINTR after copying a caught handler signal", () => {
    const harness = createEpollSignalHarness(15, 0);

    harness.worker.handleEpollPwait(
      harness.channel,
      ABI_SYSCALLS.EpollPwait,
      [7, 4096, 1, 1000, 0, 8],
    );

    expect(harness.dequeueSignal).toHaveBeenCalledWith(harness.channel.pid, CH_SIG_BASE);
    expect(
      new DataView(harness.processMemory.buffer).getUint32(CH_SIG_BASE, true),
    ).toBe(15);
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(harness.channel, -4, 4);
    expect(harness.relistenChannel).toHaveBeenCalledWith(harness.channel);
    expect(harness.handleProcessTerminated).not.toHaveBeenCalled();
  });

  it("reaps a default signal death without waking guest epoll code", () => {
    const harness = createEpollSignalHarness(0, 11, false);

    harness.worker.handleEpollPwait(
      harness.channel,
      ABI_SYSCALLS.EpollPwait,
      [7, 4096, 1, 1000, 0, 8],
    );

    expect(harness.handleProcessTerminated).toHaveBeenCalledWith(harness.channel);
    expect(harness.completeChannelRaw).not.toHaveBeenCalled();
    expect(harness.relistenChannel).not.toHaveBeenCalled();
    expect(harness.worker.pendingPollRetries.size).toBe(0);
    expect(harness.handleChannel).not.toHaveBeenCalled();
  });
});

function createEpollSignalHarness(
  handlerSignal: number,
  exitSignal: number,
  hasInterest = true,
) {
  const kernelMemory = createSharedMemory(2);
  const processMemory = createSharedMemory(2);
  const channel: any = {
    pid: 42,
    channelOffset: 0,
    memory: processMemory,
  };
  const dequeueSignal = vi.fn((_pid: number, outPtr: number) => {
    if (handlerSignal > 0) {
      new DataView(kernelMemory.buffer).setUint32(outPtr, handlerSignal, true);
    }
    return handlerSignal;
  });
  const completeChannelRaw = vi.fn();
  const relistenChannel = vi.fn();
  const handleProcessTerminated = vi.fn();
  const handleChannel = vi.fn(() => 0);
  const worker: any = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
    kernelInstance: {
      exports: {
        kernel_handle_channel: handleChannel,
        kernel_dequeue_signal: dequeueSignal,
        kernel_get_process_exit_signal: vi.fn(() => exitSignal),
      },
    },
    kernelMemory,
    scratchOffset: 0,
    currentHandlePid: 0,
    epollInterests: new Map([
      ["42:7", hasInterest ? [{ fd: 3, events: 0x001, data: 99n }] : []],
    ]),
    pendingPollRetries: new Map(),
    bindKernelTidForChannel: vi.fn(),
    completeChannelRaw,
    relistenChannel,
    handleProcessTerminated,
  });
  return {
    channel,
    completeChannelRaw,
    dequeueSignal,
    handleChannel,
    handleProcessTerminated,
    processMemory,
    relistenChannel,
    worker,
  };
}
