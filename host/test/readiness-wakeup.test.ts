import { describe, expect, it } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";

describe("readiness wakeup targeting", () => {
  it("retries only poll waiters that watch the woken pipe", () => {
    const worker = createWorkerHarness([11, 12]);
    const channel11 = createChannel(11);
    const channel12 = createChannel(12);

    worker.pendingPollRetries.set(100, {
      timer: null,
      channel: channel11,
      pipeIndices: [7],
    });
    worker.pendingPollRetries.set(200, {
      timer: null,
      channel: channel12,
      pipeIndices: [9],
    });

    const deferred = worker.wakeBlockedPollRetriesForPipe(7);

    expect(deferred).toBe(false);
    expect(worker.retried).toEqual([channel11]);
    expect(worker.pendingPollRetries.has(100)).toBe(false);
    expect(worker.pendingPollRetries.has(200)).toBe(true);
  });

  it("leaves signal-safe ppoll retries deferred when requested", () => {
    const worker = createWorkerHarness([11, 12]);
    const signalSafeChannel = createChannel(11);
    const normalChannel = createChannel(12);

    worker.pendingPollRetries.set(100, {
      timer: null,
      channel: signalSafeChannel,
      pipeIndices: [7],
      needsSignalSafeWake: true,
    });
    worker.pendingPollRetries.set(200, {
      timer: null,
      channel: normalChannel,
      pipeIndices: [7],
    });

    const deferred = worker.wakeBlockedPollRetriesForPipe(7, undefined, {
      deferSignalSafe: true,
    });

    expect(deferred).toBe(true);
    expect(worker.retried).toEqual([normalChannel]);
    expect(worker.pendingPollRetries.has(100)).toBe(true);
    expect(worker.pendingPollRetries.has(200)).toBe(false);
  });
});

function createWorkerHarness(pids: number[]): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    pendingPollRetries: new Map(),
    processes: new Map(pids.map((pid) => [pid, {}])),
    retried: [],
    retrySyscall(channel: unknown) {
      this.retried.push(channel);
    },
  });
}

function createChannel(pid: number): any {
  return { pid };
}
