import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

describe("browser channel-listener scheduling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers every batch-1 relisten through setImmediate, not queueMicrotask", () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler();
    const waitAsync = vi.spyOn(Atomics, "waitAsync").mockReturnValue({
      async: true,
      value: new Promise<"ok">(() => {}),
    } as any);

    worker.relistenChannel(channel);

    expect(worker.relistenBatchSize).toBe(1);
    expect(tasks.setImmediate).toHaveBeenCalledOnce();
    expect(tasks.queueMicrotask).not.toHaveBeenCalled();
    expect(waitAsync).not.toHaveBeenCalled();

    tasks.runNextImmediate();
    expect(waitAsync).toHaveBeenCalledOnce();
  });

  it("defers an already-pending batch-1 dispatch", () => {
    const tasks = controlTaskQueues();
    const { handleChannel, worker, channel } =
      createScheduler(CHANNEL_STATUS_PENDING);

    worker.listenOnChannel(channel);

    expect(tasks.setImmediate).toHaveBeenCalledOnce();
    expect(tasks.queueMicrotask).not.toHaveBeenCalled();
    expect(handleChannel).not.toHaveBeenCalled();

    tasks.runNextImmediate();
    expect(handleChannel).toHaveBeenCalledOnce();
    expect(Atomics.load(
      channel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    )).toBe(CHANNEL_STATUS_COMPLETE);
  });

  it("arms Atomics.waitAsync for an idle channel instead of polling", async () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler(CHANNEL_STATUS_IDLE);
    let wake!: (value: "ok") => void;
    const waited = new Promise<"ok">((resolve) => {
      wake = resolve;
    });
    const waitAsync = vi.spyOn(Atomics, "waitAsync")
      .mockReturnValueOnce({
        async: true,
        value: waited,
      } as any)
      .mockReturnValueOnce({
        async: true,
        value: new Promise<"ok">(() => {}),
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

    wake("ok");
    await waited;
    await Promise.resolve();

    expect(waitAsync).toHaveBeenCalledTimes(2);
  });

  it("drops an already-pending dispatch when exec replaces its channel", () => {
    const tasks = controlTaskQueues();
    const { handleChannel, worker, channel } =
      createScheduler(CHANNEL_STATUS_PENDING);

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

    expect(handleChannel).not.toHaveBeenCalled();
  });

  it("makes a queued relisten a no-op after unregister", () => {
    const tasks = controlTaskQueues();
    const { worker, channel } = createScheduler(CHANNEL_STATUS_IDLE);
    const waitAsync = vi.spyOn(Atomics, "waitAsync");

    worker.relistenChannel(channel);
    worker.processes.delete(channel.pid);
    worker.activeChannels = [];
    tasks.runNextImmediate();

    expect(waitAsync).not.toHaveBeenCalled();
  });
});

function createScheduler(status = CHANNEL_STATUS_IDLE): {
  worker: any;
  channel: any;
  handleChannel: ReturnType<typeof vi.fn>;
} {
  const pid = 7;
  const memory = createMemory();
  const channel = createChannel(pid, memory);
  Atomics.store(channel.i32View, CH_STATUS / Int32Array.BYTES_PER_ELEMENT, status);
  new DataView(memory.buffer).setUint32(
    CH_SYSCALL,
    ABI_SYSCALLS.Getpid,
    true,
  );
  const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const handleChannel = vi.fn((scratchPtr: number) => {
    const view = new DataView(kernelMemory.buffer, scratchPtr);
    view.setBigInt64(CH_RETURN, BigInt(pid), true);
    view.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  const worker = Object.assign(createCentralizedKernelWorkerTestDouble(), {
    processes: new Map([[pid, { pid, memory, channels: [channel] }]]),
    activeChannels: [channel],
    stoppedPids: new Set(),
    parkedChannelCompletions: new Map(),
    deferredStoppedChannels: new Map(),
    usePolling: false,
    relistenBatchSize: 1,
    relistenCount: 0,
  });
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    4,
    {
      kernelExports: {
        kernel_dequeue_signal: vi.fn(() => 0),
        kernel_drain_wakeup_events: vi.fn(() => 0),
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_handle_channel: handleChannel,
        kernel_set_current_tid: vi.fn(() => 0),
      },
    },
  );
  return { handleChannel, worker, channel };
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
