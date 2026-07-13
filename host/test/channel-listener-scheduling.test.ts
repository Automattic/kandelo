import { afterEach, describe, expect, it, vi } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import {
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_STATUS,
} from "../src/generated/abi";

describe("browser channel-listener scheduling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers every batch-1 relisten through setImmediate, not queueMicrotask", () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler();
    const listenOnChannel = vi.fn();
    worker.listenOnChannel = listenOnChannel;

    worker.relistenChannel(channel);

    expect(worker.relistenBatchSize).toBe(1);
    expect(tasks.setImmediate).toHaveBeenCalledOnce();
    expect(tasks.queueMicrotask).not.toHaveBeenCalled();
    expect(listenOnChannel).not.toHaveBeenCalled();

    tasks.runNextImmediate();
    expect(listenOnChannel).toHaveBeenCalledOnce();
    expect(listenOnChannel).toHaveBeenCalledWith(channel);
  });

  it("defers an already-pending batch-1 dispatch", () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler(CHANNEL_STATUS_PENDING);
    const handleSyscall = vi.fn();
    worker.handleSyscall = handleSyscall;

    worker.listenOnChannel(channel);

    expect(tasks.setImmediate).toHaveBeenCalledOnce();
    expect(tasks.queueMicrotask).not.toHaveBeenCalled();
    expect(handleSyscall).not.toHaveBeenCalled();

    tasks.runNextImmediate();
    expect(handleSyscall).toHaveBeenCalledOnce();
    expect(handleSyscall).toHaveBeenCalledWith(channel);
  });

  it("arms Atomics.waitAsync for an idle channel instead of polling", async () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler(CHANNEL_STATUS_IDLE);
    let wake!: (value: "ok") => void;
    const waited = new Promise<"ok">((resolve) => {
      wake = resolve;
    });
    const waitAsync = vi.spyOn(Atomics, "waitAsync").mockReturnValue({
      async: true,
      value: waited,
    } as any);

    worker.listenOnChannel(channel);

    expect(worker.usePolling).toBe(false);
    expect(waitAsync).toHaveBeenCalledOnce();
    expect(waitAsync).toHaveBeenCalledWith(
      channel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      CHANNEL_STATUS_IDLE,
    );
    expect(tasks.setImmediate).not.toHaveBeenCalled();
    expect(tasks.queueMicrotask).not.toHaveBeenCalled();

    const listenAgain = vi.fn();
    worker.listenOnChannel = listenAgain;
    wake("ok");
    await waited;
    await Promise.resolve();

    expect(listenAgain).toHaveBeenCalledOnce();
    expect(listenAgain).toHaveBeenCalledWith(channel);
  });

  it("drops an already-pending dispatch when exec replaces its channel", () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler(CHANNEL_STATUS_PENDING);
    const handleSyscall = vi.fn();
    worker.handleSyscall = handleSyscall;

    worker.listenOnChannel(channel);

    const replacementMemory = createMemory();
    const replacement = createChannel(channel.pid, replacementMemory);
    worker.processes.set(channel.pid, {
      pid: channel.pid,
      memory: replacementMemory,
      channels: [replacement],
    });
    worker.activeChannels = [replacement];
    tasks.runNextImmediate();

    expect(handleSyscall).not.toHaveBeenCalled();
  });

  it("makes a queued relisten a no-op after unregister", () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler(CHANNEL_STATUS_IDLE);
    const waitAsync = vi.spyOn(Atomics, "waitAsync");
    const handleSyscall = vi.fn();
    worker.handleSyscall = handleSyscall;

    worker.relistenChannel(channel);
    worker.processes.delete(channel.pid);
    worker.activeChannels = [];
    tasks.runNextImmediate();

    expect(waitAsync).not.toHaveBeenCalled();
    expect(handleSyscall).not.toHaveBeenCalled();
  });
});

function createScheduler(status = CHANNEL_STATUS_IDLE): {
  worker: any;
  channel: any;
} {
  const pid = 7;
  const memory = createMemory();
  const channel = createChannel(pid, memory);
  Atomics.store(channel.i32View, CH_STATUS / Int32Array.BYTES_PER_ELEMENT, status);
  const worker = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    processes: new Map([[pid, { pid, memory, channels: [channel] }]]),
    activeChannels: [channel],
    stoppedPids: new Set(),
    parkedChannelCompletions: new Map(),
    deferredStoppedChannels: new Map(),
    usePolling: false,
    relistenBatchSize: 1,
    relistenCount: 0,
  });
  return { worker, channel };
}

function createMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
}

function createChannel(pid: number, memory: WebAssembly.Memory): any {
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer),
    consecutiveSyscalls: 0,
  };
}

function controlTaskQueues(): {
  setImmediate: ReturnType<typeof vi.spyOn>;
  queueMicrotask: ReturnType<typeof vi.spyOn>;
  runNextImmediate(): void;
} {
  const immediateCallbacks: Array<() => void> = [];
  const setImmediate = vi.spyOn(globalThis, "setImmediate").mockImplementation(
    ((callback: (...args: any[]) => void, ...args: any[]) => {
      immediateCallbacks.push(() => callback(...args));
      return 0 as any;
    }) as typeof globalThis.setImmediate,
  );
  const queueMicrotask = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(
    (callback: VoidFunction) => {
      throw new Error(`unexpected queueMicrotask callback: ${String(callback)}`);
    },
  );

  return {
    setImmediate,
    queueMicrotask,
    runNextImmediate(): void {
      const callback = immediateCallbacks.shift();
      expect(callback, "expected a queued setImmediate callback").toBeDefined();
      callback!();
    },
  };
}
