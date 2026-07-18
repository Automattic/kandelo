import { describe, expect, it, vi } from "vitest";
import { DeferredWorkerHandle } from "../src/deferred-worker-handle";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { MockWorkerAdapter } from "../src/worker-adapter";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_SYSCALL,
  PROCESS_STATE_EXITED,
  PROCESS_STATE_RUNNING,
  PROCESS_STATE_STOPPED,
} from "../src/generated/abi";

describe("DeferredWorkerHandle", () => {
  it("does not construct or dispatch to a Worker before start", () => {
    const adapter = new MockWorkerAdapter();
    const handle = new DeferredWorkerHandle(() =>
      adapter.createWorker({ pid: 41 }),
    );
    const messages: unknown[] = [];
    handle.on("message", (message) => messages.push(message));
    handle.postMessage({ type: "queued" });

    expect(adapter.allWorkers).toHaveLength(0);
    expect(handle.start()).toBe(true);
    expect(adapter.allWorkers).toHaveLength(1);
    expect(adapter.lastWorkerData).toEqual({ pid: 41 });
    expect(adapter.lastWorker!.sentMessages).toEqual([{ type: "queued" }]);

    adapter.lastWorker!.simulateMessage({ type: "ready" });
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("permanently cancels construction when terminated before start", async () => {
    const create = vi.fn(() => new MockWorkerAdapter().createWorker({}));
    const handle = new DeferredWorkerHandle(create);

    await handle.terminate();

    expect(handle.start()).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rethrows synchronous construction failure to the lifecycle rollback path", () => {
    const failure = new Error("Worker constructor failed");
    const create = vi.fn(() => {
      throw failure;
    });
    const onError = vi.fn();
    const handle = new DeferredWorkerHandle(create);
    handle.on("error", onError);
    handle.postMessage({ type: "queued" });

    expect(() => handle.start()).toThrow(failure);
    expect(onError).not.toHaveBeenCalled();
    expect(handle.start()).toBe(false);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("stopped process Worker launch gate", () => {
  it("holds construction through STOPPED and releases it on SIGCONT", () => {
    let processState = 1;
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const worker = createWorkerHarness(memory, () => processState);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");
    expect(start).not.toHaveBeenCalled();

    processState = 0;
    worker.resumeStoppedProcess(41);

    expect(start).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(worker.deferredProcessWorkerStarts.has(41)).toBe(false);
  });

  it("cancels an exact deferred generation on exec replacement", () => {
    let processState = 1;
    const oldMemory = createSharedMemory();
    const newMemory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const worker = createWorkerHarness(oldMemory, () => processState);

    expect(
      worker.startProcessWorkerWhenRunnable(41, oldMemory, start, cancel),
    ).toBe("deferred");
    worker.processes.set(41, {
      memory: newMemory,
      channels: [
        {
          pid: 41,
          memory: newMemory,
          channelOffset: 0,
          i32View: new Int32Array(newMemory.buffer),
          consecutiveSyscalls: 0,
        },
      ],
    });
    processState = 0;
    worker.resumeStoppedProcess(41);

    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("ignores a stale continue wake while the current Process is stopped", () => {
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const worker = createWorkerHarness(memory, () => 1);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");
    worker.resumeStoppedProcess(41);

    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(worker.deferredProcessWorkerStarts.has(41)).toBe(true);
  });

  it("never queues a launch for an exited child", () => {
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const worker = createWorkerHarness(memory, () => 2);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("dead");
    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(worker.deferredProcessWorkerStarts.has(41)).toBe(false);
  });

  it("preflights a continuation observed before async child registration", () => {
    let processState = PROCESS_STATE_STOPPED;
    const memory = createSharedMemory();
    const channel = {
      pid: 41,
      memory,
      channelOffset: 0,
      i32View: new Int32Array(memory.buffer),
      consecutiveSyscalls: 0,
    };
    const start = vi.fn();
    const cancel = vi.fn();
    const worker = createWorkerHarness(memory, () => processState);
    // Exec handoff retains the pid registration but temporarily has no exact
    // channel; an async fork/spawn can also have no registration at all.
    worker.processes.set(41, { memory, channels: [] });

    processState = PROCESS_STATE_RUNNING;
    expect(worker.resumeStoppedProcess(41)).toBe(true);
    expect(worker.pendingResumePids.has(41)).toBe(true);

    worker.processes.set(41, { memory, channels: [channel] });
    worker.kernel = { toKernelPtr: (value: number) => value };
    worker.kernelMemory = createSharedMemory();
    worker.scratchOffset = 0;
    worker.channelTids = new Map();
    worker.kernelInstance.exports.kernel_dequeue_signal = vi.fn(() => {
      processState = PROCESS_STATE_EXITED;
      return 0;
    });
    worker.finishSignalTermination = vi.fn(() => {
      if (processState !== PROCESS_STATE_EXITED) return false;
      worker.discardStoppedChannelStateForProcess(41);
      return true;
    });

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("dead");
    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(worker.pendingResumePids.has(41)).toBe(false);
  });

  it("drains a re-stop generated by direct late-registration preflight", () => {
    let processState = PROCESS_STATE_RUNNING;
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const worker = createWorkerHarness(memory, () => processState);
    worker.pendingResumePids.add(41);
    worker.stoppedPids.add(41);
    worker.kernel = { toKernelPtr: (value: number) => value };
    worker.kernelMemory = createSharedMemory();
    worker.scratchOffset = 0;
    worker.kernelInstance.exports.kernel_dequeue_signal = vi.fn(() => {
      processState = PROCESS_STATE_STOPPED;
      return 0;
    });
    worker.finishSignalTermination = vi.fn(() => false);
    worker.drainAndProcessWakeupEvents = vi.fn();

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");

    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(worker.drainAndProcessWakeupEvents).toHaveBeenCalledOnce();
    expect(worker.stoppedPids.has(41)).toBe(true);
  });

  it("cancels pending launches during process teardown", () => {
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const worker = createWorkerHarness(memory, () => 1);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");
    worker.discardStoppedChannelStateForProcess(41);

    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(worker.deferredProcessWorkerStarts.has(41)).toBe(false);
  });

  it("turns deferred constructor failure into process exit and full teardown", () => {
    let processState = 1;
    const memory = createSharedMemory();
    const failure = new Error("Worker constructor failed after SIGCONT");
    const start = vi.fn(() => {
      throw failure;
    });
    const cancel = vi.fn();
    const laterStart = vi.fn();
    const laterCancel = vi.fn();
    const notifyCrash = vi.fn();
    const onExit = vi.fn();
    const worker = createWorkerHarness(memory, () => processState);
    worker.notifyHostProcessCrashed = notifyCrash;
    worker.callbacks = { onExit };

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");
    expect(
      worker.startProcessWorkerWhenRunnable(
        41,
        memory,
        laterStart,
        laterCancel,
      ),
    ).toBe("deferred");

    processState = 0;
    worker.resumeStoppedProcess(41);

    expect(start).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(laterStart).not.toHaveBeenCalled();
    expect(laterCancel).toHaveBeenCalledOnce();
    expect(notifyCrash).toHaveBeenCalledWith(41);
    expect(onExit).toHaveBeenCalledWith(41, 139);
    expect(worker.deferredProcessWorkerStarts.has(41)).toBe(false);
  });

  it("rolls back only a deferred clone when its thread Worker cannot start", () => {
    let processState = 1;
    const memory = createSharedMemory();
    const channel = {
      pid: 41,
      memory,
      channelOffset: 0,
      i32View: new Int32Array(memory.buffer),
      consecutiveSyscalls: 0,
    };
    const ptidPtr = 512;
    const tid = 99;
    const view = new DataView(memory.buffer);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Clone, true);
    view.setBigInt64(CH_ARGS, BigInt(0x00100000), true);
    view.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(ptidPtr), true);
    view.setInt32(ptidPtr, tid, true);

    const start = vi.fn(() => {
      throw new Error("thread Worker failed");
    });
    const cancel = vi.fn();
    const notifyCrash = vi.fn();
    const publish = vi.fn();
    const worker = createWorkerHarness(memory, () => processState);
    worker.processes.set(41, { memory, channels: [channel] });
    worker.notifyHostProcessCrashed = notifyCrash;
    worker.publishPreparedChannelCompletion = publish;
    worker.parkedChannelCompletions.set(channel, {
      prepared: {
        kind: "marshalled",
        outputWrites: [],
        retVal: tid,
        errVal: 0,
        relistenRequested: true,
      },
      relistenRequested: true,
    });

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel, () =>
        worker.failDeferredCloneLaunch(41, tid, 12),
      ),
    ).toBe("deferred");

    processState = 0;
    worker.resumeStoppedProcess(41);

    expect(cancel).toHaveBeenCalledOnce();
    expect(notifyCrash).not.toHaveBeenCalled();
    expect(view.getInt32(ptidPtr, true)).toBe(0);
    expect(publish).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({ retVal: -1, errVal: 12 }),
    );
  });
});

function createWorkerHarness(
  memory: WebAssembly.Memory,
  getProcessState: () => number,
): any {
  const channel = {
    pid: 41,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer),
    consecutiveSyscalls: 0,
  };
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernelInstance: {
      exports: {
        kernel_get_process_state: getProcessState,
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_set_current_tid: vi.fn(() => 0),
      },
    },
    processes: new Map([[41, { memory, channels: [channel] }]]),
    channelTids: new Map(),
    stoppedPids: new Set<number>(),
    pendingResumePids: new Set<number>(),
    deferredProcessWorkerStarts: new Map(),
    parkedChannelCompletions: new Map(),
    deferredStoppedChannels: new Map(),
  });
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}
