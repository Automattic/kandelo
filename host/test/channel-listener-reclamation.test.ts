import { afterEach, describe, expect, it, vi } from "vitest";

import { CH_STATUS } from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

type ChannelFixture = {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
};

type ListenerHarness = CentralizedKernelWorker & {
  processes: Map<
    number,
    {
      pid: number;
      memory: WebAssembly.Memory;
      channels: ChannelFixture[];
    }
  >;
  activeChannels: ChannelFixture[];
  retiredChannelListeners: Set<ChannelFixture>;
  listenOnChannel(channel: ChannelFixture): void;
  retireChannelListener(channel: ChannelFixture): void;
  settleRetiredChannelListeners(
    pid: number,
    expectedMemory?: WebAssembly.Memory,
    expectedChannelOffset?: number,
  ): void;
};

type WaitObservation = {
  buffer: SharedArrayBuffer;
  byteOffset: number;
  index: number;
  settled: boolean;
};

const originalWaitAsync = Atomics.waitAsync.bind(Atomics);

function createMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 4,
    maximum: 4,
    shared: true,
  });
}

function createChannel(
  pid: number,
  memory: WebAssembly.Memory,
  channelOffset: number,
): ChannelFixture {
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer, channelOffset),
    consecutiveSyscalls: 0,
  };
}

function createHarness(channels: ChannelFixture[]): ListenerHarness {
  const processes = new Map<
    number,
    {
      pid: number;
      memory: WebAssembly.Memory;
      channels: ChannelFixture[];
    }
  >();
  for (const channel of channels) {
    const registration = processes.get(channel.pid);
    if (registration) {
      registration.channels.push(channel);
    } else {
      processes.set(channel.pid, {
        pid: channel.pid,
        memory: channel.memory,
        channels: [channel],
      });
    }
  }

  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    processes,
    activeChannels: [...channels],
    retiredChannelListeners: new Set<ChannelFixture>(),
    stoppedPids: new Set<number>(),
    pendingResumePids: new Set<number>(),
    parkedChannelCompletions: new Map(),
    deferredStoppedChannels: new Map(),
    usePolling: false,
    relistenBatchSize: 64,
    relistenCount: 0,
  }) as ListenerHarness;
}

function observeWaits(): WaitObservation[] {
  const observations: WaitObservation[] = [];
  vi.spyOn(Atomics, "waitAsync").mockImplementation(((
    view: Int32Array,
    index: number,
    value: number,
    timeout?: number,
  ) => {
    const result = originalWaitAsync(view, index, value, timeout);
    if (result.async) {
      const observation: WaitObservation = {
        buffer: view.buffer as SharedArrayBuffer,
        byteOffset: view.byteOffset,
        index,
        settled: false,
      };
      observations.push(observation);
      void result.value.then(() => {
        observation.settled = true;
      });
    }
    return result;
  }) as typeof Atomics.waitAsync);
  return observations;
}

async function waitForMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retired syscall-channel listener reclamation", () => {
  it("marks without waking, then settles exactly once after the worker-stop boundary", async () => {
    const memory = createMemory();
    const channel = createChannel(41, memory, 2 * 65_536);
    const worker = createHarness([channel]);
    const waits = observeWaits();
    const notify = vi.spyOn(Atomics, "notify");

    worker.listenOnChannel(channel);
    expect(waits).toHaveLength(1);
    expect(waits[0]?.settled).toBe(false);

    // WHY: retirement and settlement are deliberately separate. Exec and
    // pthread teardown invalidate a channel before the old guest Worker has
    // stopped; notifying at that point could wake the guest on the same word.
    worker.retireChannelListener(channel);
    expect(worker.retiredChannelListeners.has(channel)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(waits[0]?.settled).toBe(false);

    const settlement = worker.settleRetiredChannelListeners(
      channel.pid,
      channel.memory,
      channel.channelOffset,
    );
    // The ownership token stays retired until the waitAsync reaction itself
    // observes that exact generation as stale.
    expect(worker.retiredChannelListeners.has(channel)).toBe(true);
    await settlement;
    await waitForMicrotasks();

    expect(worker.retiredChannelListeners.has(channel)).toBe(false);
    expect(waits[0]?.settled).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.any(Int32Array),
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    );

    worker.settleRetiredChannelListeners(
      channel.pid,
      channel.memory,
      channel.channelOffset,
    );
    await waitForMicrotasks();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("keeps a mismatched generation retired and never relistens it after replacement", async () => {
    const pid = 52;
    const oldMemory = createMemory();
    const oldChannel = createChannel(pid, oldMemory, 2 * 65_536);
    const worker = createHarness([oldChannel]);
    const waits = observeWaits();
    const notify = vi.spyOn(Atomics, "notify");

    worker.listenOnChannel(oldChannel);
    worker.retireChannelListener(oldChannel);

    const newMemory = createMemory();
    const newChannel = createChannel(pid, newMemory, 2 * 65_536);
    worker.processes.set(pid, {
      pid,
      memory: newMemory,
      channels: [newChannel],
    });
    worker.activeChannels = [newChannel];
    worker.listenOnChannel(newChannel);

    expect(waits).toHaveLength(2);
    worker.settleRetiredChannelListeners(pid, newMemory);
    await waitForMicrotasks();

    expect(worker.retiredChannelListeners.has(oldChannel)).toBe(true);
    expect(waits[0]?.settled).toBe(false);
    expect(waits[1]?.settled).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    worker.settleRetiredChannelListeners(
      pid,
      oldMemory,
      oldChannel.channelOffset,
    );
    await waitForMicrotasks();

    expect(worker.retiredChannelListeners.has(oldChannel)).toBe(false);
    expect(waits[0]?.settled).toBe(true);
    expect(waits[1]?.settled).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    // The old wait callback ran, but the exact-generation guard rejected it.
    // Only the original old/new waits exist; no listener was rearmed on the
    // replacement or the discarded memory.
    expect(waits).toHaveLength(2);

    worker.retireChannelListener(newChannel);
    worker.processes.delete(pid);
    worker.settleRetiredChannelListeners(
      pid,
      newMemory,
      newChannel.channelOffset,
    );
    await waitForMicrotasks();
    expect(waits[1]?.settled).toBe(true);
  });

  it("settles only the requested pthread mailbox and leaves peers live", async () => {
    const pid = 63;
    const memory = createMemory();
    const main = createChannel(pid, memory, 2 * 65_536);
    const firstThread = createChannel(pid, memory, 65_536);
    const secondThread = createChannel(pid, memory, 0);
    const worker = createHarness([main, firstThread, secondThread]);
    const waits = observeWaits();

    for (const channel of [main, firstThread, secondThread]) {
      worker.listenOnChannel(channel);
      worker.retireChannelListener(channel);
    }
    expect(waits).toHaveLength(3);

    worker.settleRetiredChannelListeners(
      pid,
      memory,
      firstThread.channelOffset,
    );
    await waitForMicrotasks();

    expect(waits.map((wait) => wait.settled)).toEqual([false, true, false]);
    expect(worker.retiredChannelListeners).toEqual(
      new Set([main, secondThread]),
    );

    worker.settleRetiredChannelListeners(pid, memory);
    await waitForMicrotasks();
    expect(waits.map((wait) => wait.settled)).toEqual([true, true, true]);
    expect(worker.retiredChannelListeners.size).toBe(0);
  });
});
