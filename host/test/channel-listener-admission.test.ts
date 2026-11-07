import { afterEach, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  CH_STATUS, CH_SYSCALL, CH_RETURN, CH_ERRNO, ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING as PENDING, CHANNEL_STATUS_COMPLETE as COMPLETE,
} from "../src/generated/abi";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

for (const pointerWidth of [4, 8] as const) {
  for (const batchSize of [1, 64]) {
    it(`keeps one exact listener and completes a real guest without retirement rescue (width${pointerWidth}, batch${batchSize})`, async () => {
      const nativeWaitAsync = Atomics.waitAsync.bind(Atomics);
      const nativeNotify = Atomics.notify.bind(Atomics);
      const nativeImmediate = setImmediate.bind(globalThis);
      const nativeMicrotask = queueMicrotask.bind(globalThis);
      const scheduled: Array<ReturnType<typeof deferred<void>>> = [];
      // Observe actual scheduler completion, not a guessed number of turns.
      const wrap = (operation: (...args: any[]) => void, args: any[]) => {
        const done = deferred<void>(); scheduled.push(done);
        return () => { try { operation(...args); } finally { done.resolve(); } };
      };
      vi.spyOn(globalThis, "setImmediate").mockImplementation(((operation: (...args: any[]) => void, ...args: any[]) =>
        nativeImmediate(wrap(operation, args))) as typeof setImmediate);
      vi.spyOn(globalThis, "queueMicrotask").mockImplementation(operation =>
        nativeMicrotask(wrap(operation, [])));
      const errors = vi.spyOn(console, "error");
      // Two pages contain the complete generated channel, including CH_SIG.
      const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
      const words = new Int32Array(memory.buffer);
      const index = CH_STATUS / 4, counterIndex = 256, pid = 41;
      const channel = { pid, memory, channelOffset: 0, i32View: words, consecutiveSyscalls: 0 };
      const host: any = Object.assign(createCentralizedKernelWorkerTestDouble(), {
        processes: new Map([[pid, { pid, execGeneration: 0n, memory, channels: [channel], ptrWidth: pointerWidth }]]),
        activeChannels: [channel], retiredChannelListeners: new Set(), stoppedPids: new Set(),
        pendingResumePids: new Set(), parkedChannelCompletions: new Map(), deferredStoppedChannels: new Map(),
        usePolling: false, relistenBatchSize: batchSize, relistenCount: 0,
      });
      const dispatch = deferred<void>();
      const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
      new DataView(memory.buffer).setUint32(CH_SYSCALL, ABI_SYSCALLS.Getpid, true);
      installKernelWorkerTestScratch(host, kernelMemory, 128, pointerWidth, { kernelExports: {
        kernel_handle_channel: (pointer: number | bigint) => {
          const view = new DataView(kernelMemory.buffer, Number(pointer));
          view.setBigInt64(CH_RETURN, BigInt(pid), true); view.setUint32(CH_ERRNO, 0, true);
          dispatch.resolve(); return 0;
        },
        kernel_set_current_tid: () => 0, kernel_dequeue_signal: () => 0,
        kernel_drain_wakeup_events: () => 0, kernel_get_process_exit_signal: () => -1,
      } });
      const waits: Array<{ expected: number; done: Promise<string> }> = [];
      vi.spyOn(Atomics, "waitAsync").mockImplementation(((view: Int32Array, at: number, expected: number, timeout?: number) => {
        const result = nativeWaitAsync(view, at, expected, timeout);
        if (result.async && view.buffer === memory.buffer && view.byteOffset === 0 && at === index)
          waits.push({ expected, done: result.value });
        return result;
      }) as typeof Atomics.waitAsync);
      let guest: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("actual channel-listener admission deadline")), 5_000);
      }); deadline.catch(() => {});
      try {
        host.listenOnChannel(channel);
        expect(waits).toHaveLength(1);
        // Ordinary completion on the same stack precedes the resolved wait's
        // reaction. Its legitimate relisten must coalesce with that owner.
        Atomics.store(words, index, PENDING); expect(nativeNotify(words, index, 1)).toBe(1);
        host.publishPreparedChannelCompletion(channel, {
          kind: "raw", outputWrites: [], retVal: 0, errVal: 0, materialized: true, relistenRequested: true,
        });
        expect(scheduled).toHaveLength(1);
        await Promise.race([Promise.all([waits[0].done, scheduled[0].promise]), deadline]);
        expect(waits).toHaveLength(2);
        expect(waits[1].expected).toBe(COMPLETE);
        expect(host.pendingChannelListenerCounts.get(channel)).toBe(1);
        const helper = buildSync({
          entryPoints: [fileURLToPath(new URL("../src/channel-completion-wait.ts", import.meta.url))],
          bundle: true, write: false, platform: "node", format: "esm",
        }).outputFiles[0].text;
        const completed = deferred<void>(); const messages: any[] = [];
        guest = new Worker(`
          const {parentPort,workerData}=require('node:worker_threads');
          (async()=>{
            const {waitForChannelCompletion}=await import('data:text/javascript;base64,'+Buffer.from(workerData.helper).toString('base64'));
            const words=new Int32Array(workerData.memory.buffer);
            Atomics.store(words,workerData.index,1);Atomics.notify(words,workerData.index,1);
            waitForChannelCompletion(words,workerData.index);
            Atomics.add(words,workerData.counterIndex,1);
            parentPort.postMessage({type:'completed',status:Atomics.load(words,workerData.index),count:Atomics.load(words,workerData.counterIndex)});
            parentPort.close();
          })().catch(error=>{parentPort.postMessage({type:'error',message:String(error)});parentPort.close();});
        `, { eval: true, workerData: { memory, helper, index, counterIndex } });
        guest.on("message", message => { messages.push(message); completed.resolve(); });
        const exited = new Promise<number>((resolve, reject) => {
          guest!.once("exit", resolve); guest!.once("error", reject);
        }); exited.catch(() => {});
        await Promise.race([Promise.all([completed.promise, dispatch.promise]), deadline]);
        expect(await Promise.race([exited, deadline])).toBe(0);
        expect(messages).toEqual([{ type: "completed", status: COMPLETE, count: 1 }]);
        expect(Atomics.load(words, counterIndex)).toBe(1);
        expect(errors.mock.calls).toEqual([]);
        // No retirement/extra notification occurred before the real guest's
        // completion and realm exit. Remaining host listener custody can now
        // retire independently without pretending it was a guest fence.
        host.retireChannelListener(channel); host.processes.delete(pid); host.activeChannels = [];
        await Promise.race([host.settleRetiredChannelListeners(pid, memory, 0), deadline]);
        expect(host.pendingChannelListenerCounts.has(channel)).toBe(false);
      } finally {
        clearTimeout(timer); if (guest) await guest.terminate();
        host.processes.clear(); host.activeChannels = []; host.retireChannelListener(channel);
        nativeNotify(words, index);
      }
    }, 10_000);
  }
}

function bareListenerHarness(onKernelFatal?: (error: Error) => void) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const channel = { pid: 73, memory, channelOffset: 0, i32View: new Int32Array(memory.buffer), consecutiveSyscalls: 0 };
  const host: any = Object.assign(createCentralizedKernelWorkerTestDouble({ callbacks: { onKernelFatal } }), {
    processes: new Map([[73, { pid: 73, execGeneration: 0n, memory, channels: [channel] }]]),
    activeChannels: [channel], retiredChannelListeners: new Set(), stoppedPids: new Set(),
    pendingResumePids: new Set(), parkedChannelCompletions: new Map(), deferredStoppedChannels: new Map(),
    usePolling: false, relistenBatchSize: 1, relistenCount: 0,
  });
  return { host, channel, memory };
}

it("does not claim an async listener when the real native wait returns not-equal synchronously", async () => {
  const nativeImmediate = setImmediate.bind(globalThis), nativeWait = Atomics.waitAsync.bind(Atomics);
  const rechecked = deferred<void>();
  vi.spyOn(globalThis, "setImmediate").mockImplementation(((operation: (...args: any[]) => void, ...args: any[]) =>
    nativeImmediate(() => { try { operation(...args); } finally { rechecked.resolve(); } })) as typeof setImmediate);
  const { host, channel, memory } = bareListenerHarness();
  const outcomes: boolean[] = [];
  vi.spyOn(Atomics, "waitAsync").mockImplementation(((view: Int32Array, index: number, expected: number, timeout?: number) => {
    // The value changes between the actual listener's load and native arm.
    // Delegate to the real primitive; do not invent its synchronous result.
    if (outcomes.length === 0) Atomics.store(view, index, COMPLETE);
    const result = nativeWait(view, index, expected, timeout); outcomes.push(result.async); return result;
  }) as typeof Atomics.waitAsync);
  try {
    host.listenOnChannel(channel);
    expect(outcomes).toEqual([false]); expect(host.pendingChannelListenerCounts?.has(channel) ?? false).toBe(false);
    await rechecked.promise;
    expect(outcomes).toEqual([false, true]); expect(host.pendingChannelListenerCounts.get(channel)).toBe(1);
  } finally {
    host.retireChannelListener(channel); host.processes.clear(); host.activeChannels = [];
    await host.settleRetiredChannelListeners(73, memory, 0);
  }
});

it("settles exact retired ownership before reporting a failed wait continuation as fatal", async () => {
  const fatal = deferred<Error>();
  const { host, channel, memory } = bareListenerHarness(error => { fatal.resolve(error); });
  let reject!: (error: Error) => void;
  const waiting = new Promise<"ok">((_, fail) => { reject = fail; });
  const wait = vi.spyOn(Atomics, "waitAsync").mockReturnValue({ async: true, value: waiting });
  host.listenOnChannel(channel); expect(host.pendingChannelListenerCounts.get(channel)).toBe(1);
  host.retireChannelListener(channel); host.processes.clear(); host.activeChannels = [];
  const settlement = host.settleRetiredChannelListeners(73, memory, 0);
  // A controlled rejected continuation tests failure custody, not a claim
  // that an actual native Atomics.waitAsync promise rejects on this runtime.
  reject(new Error("controlled waiter continuation failure"));
  await settlement;
  const error = await fatal.promise;
  expect(error.message).toContain("wait failed");
  expect(host.pendingChannelListenerCounts.has(channel)).toBe(false);
  expect(host.retiredChannelListeners.has(channel)).toBe(false);
  const calls = wait.mock.calls.length; host.listenOnChannel(channel);
  expect(wait.mock.calls).toHaveLength(calls);
});
