import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryGroupImageStore } from "../src/memory-group-image-store";
import { GroupProcessAddressSpace } from "../src/process-address-space";
import { prepareProcessNativeObservationI32, type ProcessMemorySource } from "../src/process-memory-views";
import { CH_STATUS } from "../src/generated/abi";
import {
  CentralizedKernelWorker,
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";

type ChannelFixture = {
  pid: number;
  memory: WebAssembly.Memory;
  source: ProcessMemorySource;
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
    expectedSource?: ProcessMemorySource,
  ): Promise<void>;
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
    source: memory,
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
        memory: channel.memory, source: channel.source,
        channels: [channel],
      });
    }
  }

  return Object.assign(createCentralizedKernelWorkerTestDouble(), {
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

function groupedChannels() {
  const store = new MemoryGroupImageStore(7, 32, 32), offset = 128;
  const task = { group: 7, pid: 100, tid: 100, serial: 1n, generation: 0n };
  const a = store.prepareImage(task, { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 });
  const oldLaunch = store.publish(a, task), oldSource = store.imageSource(a);
  const next = { ...task, serial: 2n, generation: 1n };
  const b = store.prepareImage(next, { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 });
  const newLaunch = store.publish(b, next), newSource = store.imageSource(b);
  const old = { ...createChannel(100, oldLaunch.envelope.memory, offset), source: oldSource };
  const replacement = { ...createChannel(100, newLaunch.envelope.memory, offset), source: newSource };
  return { store, a, b, old, replacement, oldLaunch, oldSource, newSource };
}

describe("retired syscall-channel listener reclamation", () => {
  it("keeps same-PID same-offset grouped images separate after source revocation", async () => {
    const { store, a, b, old, replacement, oldSource, newSource } = groupedChannels();
    const worker = createHarness([old]), waits = observeWaits();
    try {
      worker.listenOnChannel(old); worker.retireChannelListener(old);
      store.revokeImageAccess(a);
      worker.processes.set(100, { pid: 100, memory: replacement.memory, source: newSource, channels: [replacement] } as any);
      worker.activeChannels = [replacement]; worker.listenOnChannel(replacement);
      expect(old.memory).toBe(replacement.memory); expect(waits).toHaveLength(2);
      expect(store.snapshot().nativeObservers).toBe(2);
      expect(() => worker.settleRetiredChannelListeners(100, old.memory, old.channelOffset)).toThrow("exact image source");
      await worker.settleRetiredChannelListeners(100, old.memory, old.channelOffset, newSource);
      expect(waits.map(wait => wait.settled)).toEqual([false, false]);
      const charged = store.snapshot().allocatedPages;
      const done = worker.settleRetiredChannelListeners(100, old.memory, old.channelOffset, oldSource);
      expect(store.snapshot().nativeObservers).toBe(2);
      expect(worker.retiredChannelListeners.has(old)).toBe(true);
      await done;
      expect(waits.map(wait => wait.settled)).toEqual([true, false]);
      expect(waits).toHaveLength(2); expect(store.snapshot().nativeObservers).toBe(1);
      expect(store.snapshot().allocatedPages).toBe(charged);
      worker.retireChannelListener(replacement); store.revokeImageAccess(b);
      await worker.settleRetiredChannelListeners(100, replacement.memory, replacement.channelOffset, newSource);
      expect(store.snapshot().nativeObservers).toBe(0);
    } finally { store.close(); }
  });

  it("wakes the captured physical word after a virtual PTE changes", async () => {
    const { store, old, oldLaunch, oldSource } = groupedChannels();
    const worker = createHarness([old]);
    const ptes = new Uint32Array(old.memory.buffer, oldLaunch.expectation.root + 64, 16);
    let control: { async: true; value: Promise<string> } | undefined;
    let fresh: Int32Array | undefined;
    const originalWord = new Int32Array(old.memory.buffer, (ptes[0] & 0xffff0000) + old.channelOffset, 1);
    try {
      worker.listenOnChannel(old); worker.retireChannelListener(old);
      [ptes[0], ptes[1]] = [ptes[1], ptes[0]];
      fresh = new Int32Array(old.memory.buffer, (ptes[0] & 0xffff0000) + old.channelOffset, 1);
      const wait = originalWaitAsync(fresh, 0, 0);
      expect(wait.async).toBe(true);
      if (!wait.async) throw Error("control waiter was not armed");
      control = wait;
      let incorrectlyWoken = false; void wait.value.then(() => { incorrectlyWoken = true; });
      await worker.settleRetiredChannelListeners(100, old.memory, old.channelOffset, oldSource);
      expect(incorrectlyWoken).toBe(false); expect(store.snapshot().nativeObservers).toBe(0);
    } finally {
      Atomics.notify(originalWord, 0);
      if (fresh) Atomics.notify(fresh, 0);
      if (control) await control.value;
      await waitForMicrotasks();
      store.close();
    }
  });

  it("keeps a failed wake charged and retries without acknowledging retirement", async () => {
    const { store, old, oldSource } = groupedChannels(), worker = createHarness([old]);
    try {
      worker.listenOnChannel(old); worker.retireChannelListener(old);
      const notify = vi.spyOn(Atomics, "notify").mockImplementationOnce(() => { throw Error("injected wake failure"); });
      expect(() => worker.settleRetiredChannelListeners(100, old.memory, old.channelOffset, oldSource)).toThrow("injected wake failure");
      expect(worker.retiredChannelListeners.has(old)).toBe(true);
      expect(store.snapshot().nativeObservers).toBe(1); notify.mockRestore();
      await worker.settleRetiredChannelListeners(100, old.memory, old.channelOffset, oldSource);
      expect(store.snapshot().nativeObservers).toBe(0);
    } finally { store.close(); }
  });

  it("does not acknowledge an observer whose continuation could not be registered", async () => {
    const { store, old, oldSource } = groupedChannels(), worker = createHarness([old]);
    const wait = vi.spyOn(Atomics, "waitAsync").mockReturnValueOnce({ async: true, value: {} as Promise<"ok"> });
    worker.listenOnChannel(old); wait.mockRestore(); worker.retireChannelListener(old);
    let acknowledged = false;
    void worker.settleRetiredChannelListeners(100, old.memory, old.channelOffset, oldSource).then(() => { acknowledged = true; });
    await waitForMicrotasks();
    expect(acknowledged).toBe(false); expect(worker.retiredChannelListeners.has(old)).toBe(true);
    expect(store.snapshot().nativeObservers).toBe(1);
    store.close(); expect(store.snapshot().nativeObservers).toBe(1);
  });

  it("requires kernel image custody and releases unarmed or not-equal observations exactly once", () => {
    const { store, oldLaunch, oldSource } = groupedChannels();
    try {
      expect(() => prepareProcessNativeObservationI32(oldLaunch.source, 0)).toThrow("metadata");
      const unarmed = prepareProcessNativeObservationI32(oldSource, 0);
      expect(store.snapshot().nativeObservers).toBe(1);
      unarmed.cancelUnarmed(); expect(store.snapshot().nativeObservers).toBe(0);
      expect(() => unarmed.arm(0)).toThrow();
      const mismatch = prepareProcessNativeObservationI32(oldSource, 0);
      expect(mismatch.arm(1)).toEqual({ async: false, value: "not-equal" });
      expect(mismatch.settled).toBe(true); expect(store.snapshot().nativeObservers).toBe(0);
      mismatch.wake(); expect(() => mismatch.cancelUnarmed()).toThrow();
    } finally { store.close(); }
  });

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
      memory: newMemory, source: newMemory,
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
