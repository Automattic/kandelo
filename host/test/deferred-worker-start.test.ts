import { describe, expect, it, vi } from "vitest";
import { createWorkerAbsence, DeferredWorkerHandle } from "../src/deferred-worker-handle";
import type { WorkerAbsence } from "../src/deferred-worker-handle";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import ts from "typescript";
import { createWorkerQuiescence, type WorkerQuiescence, retireWorkerBatch } from "../src/worker-quiescence";
import { removeThreadWorkerRegistryEntry } from "../src/thread-worker-disposition";
import { ThreadExitCoordinator } from "../src/thread-exit-coordinator";
import { isCurrentProcessGeneration } from "../src/kernel-worker";
import { retryKernelEntryResult, retryKernelEntryResultForGeneration } from "../src/kernel-entry-retry";
import { ProcessGenerationObservations, type ProcessGenerationEventData } from "../src/process-generation-observation";
import type { WorkerHandle } from "../src/worker-adapter";
import { ProcessMemoryAllocator, type ProcessMemoryRetirementNotice } from "../src/process-memory";
import { ExactProcessGenerationDetachLedger } from "../src/process-generation-detach";
import {
  type CentralizedKernelCallbacks,
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import { MockWorkerAdapter } from "../src/worker-adapter";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  PROCESS_STATE_EXITED,
  PROCESS_STATE_RUNNING,
  PROCESS_STATE_STOPPED,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

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

  it("drops captured factories and queued handlers after start or cancel", async () => {
    const adapter = new MockWorkerAdapter();
    const started = new DeferredWorkerHandle(() =>
      adapter.createWorker({ pid: 41 }),
    );
    started.on("message", () => {});
    expect(started.start()).toBe(true);

    const canceled = new DeferredWorkerHandle(() =>
      adapter.createWorker({ pid: 42 }),
    );
    canceled.on("message", () => {});
    await canceled.terminate();

    for (const handle of [started, canceled]) {
      const internals = handle as unknown as {
        create: unknown;
        handlers: Map<string, unknown>;
      };
      expect(internals.create).toBeNull();
      expect(internals.handlers.size).toBe(0);
    }
  });
});

describe("stopped process Worker launch gate", () => {
  it("holds construction through STOPPED and releases it on SIGCONT", async () => {
    let processState = 1;
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const { worker } = createWorkerHarness(memory, () => processState);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");
    expect(start).not.toHaveBeenCalled();

    processState = 0;
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    await drainLifecycleGate();

    expect(start).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels an exact deferred generation on exec replacement", async () => {
    let processState = 1;
    const oldMemory = createSharedMemory();
    const newMemory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const { worker } = createWorkerHarness(oldMemory, () => processState);

    expect(
      worker.startProcessWorkerWhenRunnable(41, oldMemory, start, cancel),
    ).toBe("deferred");
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 41,
      memory: newMemory,
      channelOffsets: [0],
    });
    processState = 0;
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    await drainLifecycleGate();

    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("ignores a stale continue wake while the current Process is stopped", async () => {
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    let processState = PROCESS_STATE_STOPPED;
    const { worker } = createWorkerHarness(memory, () => processState);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(false);

    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    processState = PROCESS_STATE_RUNNING;
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    await drainLifecycleGate();
    expect(start).toHaveBeenCalledOnce();
  });

  it("rejects reentrant lifecycle test seams without retaining caller values", async () => {
    const memory = createSharedMemory();
    const replacementRead = vi.fn();
    const parkedRead = vi.fn();
    const errors: unknown[] = [];
    let exerciseReentry = true;
    let worker!: ReturnType<
      typeof createCentralizedKernelWorkerTestDouble
    >;
    let registeredChannel!: ReturnType<
      typeof createWorkerHarness
    >["channel"];
    const getProcessState = vi.fn(() => {
      if (exerciseReentry) {
        exerciseReentry = false;
        try {
          worker.testAuthority.resumeStoppedProcessForTest(41);
        } catch (error) {
          errors.push(error);
        }
        const replacement = new Proxy(
          {
            pid: 41,
            memory,
            channelOffsets: [0],
          },
          {
            get(target, property, receiver) {
              replacementRead(property);
              return Reflect.get(target, property, receiver);
            },
          },
        );
        try {
          worker.testAuthority
            .replaceProcessRegistrationForLifecycleTest(replacement);
        } catch (error) {
          errors.push(error);
        }
        const parked = new Proxy(
          {
            channel: registeredChannel,
            tid: 99,
            parentTidPointer: 512,
          },
          {
            get(target, property, receiver) {
              parkedRead(property);
              return Reflect.get(target, property, receiver);
            },
          },
        );
        try {
          worker.testAuthority.installParkedCloneCompletionForTest(
            parked,
          );
        } catch (error) {
          errors.push(error);
        }
      }
      return PROCESS_STATE_STOPPED;
    });
    const harness = createWorkerHarness(memory, getProcessState);
    worker = harness.worker;
    registeredChannel = harness.channel;

    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(false);
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error).toBeInstanceOf(KernelReentrantEntryError);
    }
    expect(replacementRead).not.toHaveBeenCalled();
    expect(parkedRead).not.toHaveBeenCalled();
    const stateReadsAfterReturn = getProcessState.mock.calls.length;
    await drainLifecycleGate();
    expect(getProcessState).toHaveBeenCalledTimes(stateReadsAfterReturn);
    expect(replacementRead).not.toHaveBeenCalled();
    expect(parkedRead).not.toHaveBeenCalled();
  });

  it("rejects a parked clone completion from a replaced memory generation", () => {
    const oldMemory = createSharedMemory();
    const newMemory = createSharedMemory();
    const { worker, channel: oldChannel } = createWorkerHarness(
      oldMemory,
      () => PROCESS_STATE_STOPPED,
    );
    const [currentChannel] =
      worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
        pid: 41,
        memory: newMemory,
        channelOffsets: [0],
      });
    if (currentChannel === undefined) {
      throw new Error("replacement lifecycle channel was not created");
    }

    expect(() =>
      worker.testAuthority.installParkedCloneCompletionForTest({
        channel: oldChannel,
        tid: 99,
        parentTidPointer: 512,
      })
    ).toThrow(/exact registration/);
    expect(() =>
      worker.testAuthority.installParkedCloneCompletionForTest({
        channel: currentChannel,
        tid: 99,
        parentTidPointer: 512,
      })
    ).not.toThrow();
  });

  it("never queues a launch for an exited child", () => {
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const { worker } = createWorkerHarness(memory, () => 2);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("dead");
    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
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
    const { worker } = createWorkerHarness(
      memory,
      () => processState,
      {
        kernelExports: {
          kernel_dequeue_signal: vi.fn(() => {
            processState = PROCESS_STATE_EXITED;
            return 0;
          }),
        },
      },
    );
    // Exec handoff retains the pid registration but temporarily has no exact
    // channel; an async fork/spawn can also have no registration at all.
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 41,
      memory,
      channelOffsets: [],
    });

    processState = PROCESS_STATE_RUNNING;
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    const [registeredChannel] =
      worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
        pid: 41,
        memory,
        channelOffsets: [0],
      });
    expect(registeredChannel).toMatchObject({
      pid: channel.pid,
      memory: channel.memory,
      channelOffset: channel.channelOffset,
    });

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("dead");
    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("drains a re-stop generated by direct late-registration preflight", () => {
    let processState = PROCESS_STATE_RUNNING;
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const drainWakeups = vi.fn(() => 0);
    const { worker } = createWorkerHarness(
      memory,
      () => processState,
      {
        kernelExports: {
          kernel_dequeue_signal: vi.fn(() => {
            processState = PROCESS_STATE_STOPPED;
            return 0;
          }),
          kernel_drain_wakeup_events: drainWakeups,
        },
      },
    );
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 41,
      memory,
      channelOffsets: [],
    });
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 41,
      memory,
      channelOffsets: [0],
    });

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");

    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(drainWakeups).toHaveBeenCalledOnce();
  });

  it("cancels pending launches during process teardown", () => {
    const memory = createSharedMemory();
    const start = vi.fn();
    const cancel = vi.fn();
    const { worker } = createWorkerHarness(memory, () => 1);

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel),
    ).toBe("deferred");
    worker.testAuthority.discardStoppedProcessStateForTest(41);

    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("routes a running constructor failure through its exact launch owner", async () => {
    const memory = createSharedMemory();
    const failure = new Error("replacement Worker construction failed");
    const start = vi.fn(() => {
      throw failure;
    });
    const cancel = vi.fn();
    const onStartError = vi.fn(() => true);
    const { worker } = createWorkerHarness(memory, () => 0);

    expect(
      worker.startProcessWorkerWhenRunnable(
        41,
        memory,
        start,
        cancel,
        onStartError,
      ),
    ).toBe("started");
    await drainLifecycleGate();

    expect(start).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(onStartError).toHaveBeenCalledOnce();
    expect(onStartError).toHaveBeenCalledWith(failure);
  });

  it("turns deferred constructor failure into process exit and full teardown", async () => {
    let processState = 1;
    const memory = createSharedMemory();
    const failure = new Error("Worker constructor failed after SIGCONT");
    const start = vi.fn(() => {
      throw failure;
    });
    const cancel = vi.fn();
    const laterStart = vi.fn();
    const laterCancel = vi.fn();
    const markSignaled = vi.fn(() => 0);
    const onExit = vi.fn();
    const { worker } = createWorkerHarness(
      memory,
      () => processState,
      {
        callbacks: { onExit },
        kernelExports: {
          kernel_mark_process_signaled: markSignaled,
        },
      },
    );

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
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    await drainLifecycleGate();

    expect(start).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(laterStart).not.toHaveBeenCalled();
    expect(laterCancel).toHaveBeenCalledOnce();
    expect(markSignaled).toHaveBeenCalledWith(41, 11);
    expect(onExit).toHaveBeenCalledWith(41, 139);
  });

  it.each([false, true])("rolls back only a deferred clone when its thread Worker cannot start (replaced parent word=%s)", async (replaceParentWord) => {
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
    const replacementPtidPtr = 768;
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
    const markSignaled = vi.fn(() => 0);
    const { worker, channel: registeredChannel } = createWorkerHarness(
      memory,
      () => processState,
      {
        kernelExports: {
          kernel_mark_process_signaled: markSignaled,
        },
      },
    );
    expect(registeredChannel).toMatchObject({
      pid: channel.pid,
      memory: channel.memory,
      channelOffset: channel.channelOffset,
    });
    worker.testAuthority.installParkedCloneCompletionForTest({
      channel: registeredChannel,
      tid,
      parentTidPointer: ptidPtr,
    });

    expect(
      worker.startProcessWorkerWhenRunnable(41, memory, start, cancel, () =>
        worker.failDeferredCloneLaunch(41, tid, 12),
      ),
    ).toBe("deferred");

    // A sibling sharing this process memory may replace mailbox bytes while
    // the stopped completion is parked. Rollback must retain the pointer
    // validated for the original clone instead of trusting this replacement.
    view.setBigInt64(CH_ARGS, BigInt(0x00100000), true);
    view.setBigInt64(
      CH_ARGS + 2 * CH_ARG_SIZE,
      BigInt(replacementPtidPtr),
      true,
    );
    view.setInt32(replacementPtidPtr, 0x12345678, true);
    if (replaceParentWord) view.setInt32(ptidPtr, tid + 1, true);

    processState = 0;
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    await drainLifecycleGate();

    expect(cancel).toHaveBeenCalledOnce();
    expect(markSignaled).not.toHaveBeenCalled();
    expect(view.getInt32(ptidPtr, true)).toBe(replaceParentWord ? tid + 1 : 0);
    expect(view.getInt32(replacementPtidPtr, true)).toBe(0x12345678);
    expect(view.getBigInt64(CH_RETURN, true)).toBe(-1n);
    expect(view.getUint32(CH_ERRNO, true)).toBe(12);
    expect(
      Atomics.load(
        registeredChannel.i32View,
        CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      ),
    ).toBe(CHANNEL_STATUS_COMPLETE);
  });
});

interface LifecycleWorkerHarnessOptions {
  readonly callbacks?: CentralizedKernelCallbacks;
  readonly kernelExports?: Readonly<Record<string, unknown>>;
}

function createWorkerHarness(
  memory: WebAssembly.Memory,
  getProcessState: () => number,
  options: LifecycleWorkerHarnessOptions = {},
): {
  readonly worker: ReturnType<
    typeof createCentralizedKernelWorkerTestDouble
  >;
  readonly channel: {
    readonly pid: number;
    readonly memory: WebAssembly.Memory;
    readonly channelOffset: number;
    readonly i32View: Int32Array;
    consecutiveSyscalls: number;
  };
} {
  const implementations: Record<string, unknown> = {
    kernel_dequeue_signal: vi.fn(() => 0),
    kernel_drain_wakeup_events: vi.fn(() => 0),
    kernel_get_parent_pid: vi.fn(() => -1),
    kernel_get_process_exit_signal: vi.fn(() =>
      getProcessState() === PROCESS_STATE_EXITED ? 11 : -1
    ),
    kernel_get_process_state: getProcessState,
    kernel_mark_process_signaled: vi.fn(() => 0),
    kernel_set_current_tid: vi.fn(() => 0),
    ...(options.kernelExports ?? {}),
  };
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks: options.callbacks,
  });
  const kernelMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
  });
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    1024,
    4,
    { kernelExports: implementations },
  );
  const [channel] =
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 41,
      memory,
      channelOffsets: [0],
    });
  if (channel === undefined) {
    throw new Error("lifecycle harness did not create its main channel");
  }
  return { worker, channel };
}

async function drainLifecycleGate(): Promise<void> {
  // Resume publishes Worker construction and any crash rollback only after
  // the exact kernel-entry scope is revoked.
  for (let turn = 0; turn < 24; turn++) {
    await Promise.resolve();
  }
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}


describe("sealed absence of a never-constructed Worker", () => {
  it("seals before reporting absence, drops init roots and blocks a later continue", async () => {
    const create = vi.fn(() => new MockWorkerAdapter().createWorker({}));
    const worker = new DeferredWorkerHandle(create);
    worker.postMessage({ memory: new WebAssembly.Memory({ initial: 1 }) });
    worker.on("message", () => {});
    const onProven = vi.fn(() => { expect(worker.start()).toBe(false); });
    const absent = createWorkerAbsence(worker, onProven);
    expect(absent.proven).toBe(false);
    expect(absent.seal()).toBe(true);
    expect(absent.seal()).toBe(true);
    await worker.terminate();
    expect(create).not.toHaveBeenCalled();
    expect(onProven).toHaveBeenCalledOnce();
    expect(worker.start()).toBe(false);
    const roots = worker as unknown as { create: unknown; handlers: Map<string, unknown>; pendingMessages: unknown[] };
    expect(roots.create).toBeNull();
    expect(roots.handlers.size).toBe(0);
    expect(roots.pendingMessages).toEqual([]);
  });

  it.each(["started", "constructor-failure", "unknown"] as const)(
    "does not turn %s or termination into absence", async (mode) => {
      const backing = new MockWorkerAdapter().createWorker({});
      const worker: WorkerHandle = mode === "unknown" ? backing : new DeferredWorkerHandle(() => {
        if (mode === "constructor-failure") throw Error("constructor published then threw");
        return backing;
      });
      if (worker instanceof DeferredWorkerHandle) {
        if (mode === "constructor-failure") expect(() => worker.start()).toThrow("published then threw");
        else expect(worker.start()).toBe(true);
      }
      const reported = vi.fn(), absent = createWorkerAbsence(worker, reported);
      expect(absent.seal()).toBe(false);
      await worker.terminate();
      expect(absent.seal()).toBe(false);
      expect(absent.proven).toBe(false);
      expect(reported).not.toHaveBeenCalled();
    },
  );

  it("rejects prototype claims, proxies and derived implementations without calling their seal claim", async () => {
    const claimed = vi.fn(() => true), onProven = vi.fn();
    const forged = Object.assign(Object.create(DeferredWorkerHandle.prototype), { sealNeverStarted: claimed });
    const actual = new DeferredWorkerHandle(() => new MockWorkerAdapter().createWorker({}));
    class DerivedWorker extends DeferredWorkerHandle {
      sealNeverStarted() { return claimed(); }
    }
    const derived = new DerivedWorker(() => new MockWorkerAdapter().createWorker({}));
    for (const unknown of [forged, new Proxy(actual, {}), derived]) {
      const absent = createWorkerAbsence(unknown, onProven);
      expect(absent.seal()).toBe(false);
      expect(absent.proven).toBe(false);
    }
    expect(claimed).not.toHaveBeenCalled();
    expect(onProven).not.toHaveBeenCalled();
    await actual.terminate(); await derived.terminate();
  });

  it("reports backing completion only after the exact returned terminate promise fulfills", async () => {
    let finish!: (code: number) => void;
    const stopped = new Promise<number>(resolve => { finish = resolve; });
    const backing = new MockWorkerAdapter().createWorker({});
    vi.spyOn(backing, "terminate").mockReturnValue(stopped);
    const worker = new DeferredWorkerHandle(() => backing);
    worker.start();
    const termination = worker.terminate();
    expect(DeferredWorkerHandle.hasCompletedBackingTermination(worker)).toBe(false);
    finish(7); await expect(termination).resolves.toBe(7);
    expect(DeferredWorkerHandle.hasCompletedBackingTermination(worker)).toBe(true);
    expect(createWorkerAbsence(worker, () => {}).seal()).toBe(false);
  });

  it("never reports a rejected backing termination as a completed join", async () => {
    const backing = new MockWorkerAdapter().createWorker({});
    vi.spyOn(backing, "terminate").mockRejectedValue(Error("native termination failed"));
    const worker = new DeferredWorkerHandle(() => backing);
    worker.start();
    await expect(worker.terminate()).rejects.toThrow("native termination failed");
    expect(DeferredWorkerHandle.hasCompletedBackingTermination(worker)).toBe(false);
    expect(createWorkerAbsence(worker, () => {}).seal()).toBe(false);
  });

  it("marks construction attempted before the factory can reenter absence checking", () => {
    let absent!: WorkerAbsence;
    const worker = new DeferredWorkerHandle(() => {
      expect(absent.seal()).toBe(false);
      return new MockWorkerAdapter().createWorker({});
    });
    absent = createWorkerAbsence(worker, () => { throw Error("false absence"); });
    expect(worker.start()).toBe(true);
    expect(absent.seal()).toBe(false);
  });
});

interface CloneThreadRetirementControl {
  worker: DeferredWorkerHandle;
  workerAbsence: WorkerAbsence;
  workerQuiescence: WorkerQuiescence;
  execRetirement: WorkerQuiescence;
  termination?: Promise<void>;
}

/** Executes the actual entry functions without importing an auto-starting
 * kernel realm. Only platform dependencies are doubled; function bodies and
 * the DeferredWorkerHandle/ownership observers are the production sources. */
function actualCloneRetirementControl(
  host: "node" | "browser", ptrWidth: 4 | 8,
  disposition: "stale" | "deferred" | "started-stale" | "constructor-failure" | "termination-failure" | "started",
  factory?: () => WorkerHandle,
) {
  const entryRoot = process.env.KANDELO_WORKER_ABSENCE_ENTRY_ROOT;
  const url = entryRoot ? new URL(`file://${entryRoot}/host/src/${host}-kernel-worker-entry.ts`)
    : new URL(`../src/${host}-kernel-worker-entry.ts`, import.meta.url);
  const source = ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
  const functions = ["handleClone", "terminateTrackedWorker", "terminateThreadWorkers"].map(name => {
    const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!fn) throw Error(`missing actual ${host} ${name}`);
    return fn.getText(source);
  }).join("\n");
  const code = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pid = 41, tid = 73;
  const retirementNotices: ProcessMemoryRetirementNotice[] = [];
  let observeRetirement!: () => void;
  const retirementObserved = new Promise<void>(resolve => { observeRetirement = resolve; });
  const allocator = new ProcessMemoryAllocator({ maxMemories: 1, maxTotalBytes: 4 * 65536,
    retirementPressureHook: notice => { retirementNotices.push(notice); observeRetirement(); } });
  const memoryLease = allocator.acquire({ ptrWidth, initialPages: 4, maximumPages: 4 });
  const memory = memoryLease.memory;
  const slots = new Set<number>(), events: ProcessGenerationEventData[] = [];
  const info = { memory, memoryLease, workerQuiescence: createWorkerQuiescence(), programBytes: new ArrayBuffer(0), ptrWidth, channelOffset: 0,
    externrefGeneration: { id: 1 }, memoryRetirementSafe: true,
    threadAllocator: {
      allocate() { slots.add(1); return { basePage: 1, slotStartPage: 1, channelOffset: 65536, tlsOffset: 0, tlsAllocAddr: 0 }; },
      free(page: number) { expect(slots.delete(page)).toBe(true); },
    },
  };
  const processes = new Map([[pid, info]]), threadWorkers = new Map<number, CloneThreadRetirementControl[]>();
  const observations = new ProcessGenerationObservations(event => events.push(event));
  observations.enable(); observations.admit(pid, info, 1);
  const createWorker = vi.fn(factory ?? (() => new MockWorkerAdapter().createWorker({})));
  const settleRetiredChannelListeners = vi.fn(async () => {});
  const waitForWorkerQuiescence = vi.fn(async (fence: WorkerQuiescence) => fence.settled);
  const waitForExecRetirement = vi.fn(async (exec: WorkerQuiescence, memory: WorkerQuiescence) => exec.settled && memory.settled);
  let start!: () => void, cancel!: () => void, admitted!: CloneThreadRetirementControl;
  const originalAdmission = observations.threadAdmitted.bind(observations);
  observations.threadAdmitted = (generation, thread) => {
    admitted = thread as CloneThreadRetirementControl; originalAdmission(generation, thread);
  };
  const deps = {
    processes, threadWorkers, threadedProcessPids: new Set(), threadModuleCache: new Map([[pid, {}]]),
    kernelWorker: {
      isExecHandoffActive: () => false, isProcessExecutionActive: () => true,
      attachThreadChannel() {}, getKernelAbiVersion: () => 56, getKernelAbiContractDigest: () => "source-control",
      startProcessWorkerWhenRunnable(_pid: number, _memory: WebAssembly.Memory, launch: () => void, stop: () => void) {
        start = launch; cancel = stop;
        if (disposition === "started-stale" || disposition === "termination-failure" || disposition === "started") { launch(); return disposition === "started" ? "started" : "stale"; }
        if (disposition === "constructor-failure") { launch(); throw Error("constructor must throw"); }
        return disposition;
      },
      settleRetiredChannelListeners, finalizeThreadExit() {}, failDeferredCloneLaunch: () => true,
    },
    isCurrentProcessGeneration, retryKernelEntryResult, retryKernelEntryResultForGeneration,
    DeferredWorkerHandle, createWorkerAbsence, createWorkerQuiescence, removeThreadWorkerRegistryEntry,
    retireWorkerBatch, waitForWorkerQuiescence, waitForExecRetirement,
    terminateExitedThreadWorkers: async () => {},
    PROCESS_WORKER_QUIESCENCE_WAIT_MS: 100, EXEC_WORKER_RETIREMENT_WAIT_MS: 5000,
    threadExits: new ThreadExitCoordinator(),
    forkHostImportOwnerRuntime: { createWorker: () => ({ init: {}, close() {} }) }, bindForkHostImports() {},
    workerAdapter: { createWorker }, generationObservations: observations,
    intentionallyTerminated: new WeakSet(), forkHostImportsByWorker: new WeakMap(), workerTeardowns: new Set(),
    delay: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    THREADED_WORKER_TERMINATION_SETTLE_MS: 250,
    exitedThreadWorkersOutliveThreads: false,
  };
  const actual = new Function(...Object.keys(deps), code + "\nreturn {clone:handleClone,batch:terminateThreadWorkers};")(...Object.values(deps));
  const clone = actual.clone;
  const pending: Promise<void> = clone({ pid, tid, fnPtr: 1, argPtr: 0, stackPtr: 0, tlsPtr: 0, ctidPtr: 0, memory });
  const ledger = new ExactProcessGenerationDetachLedger(
    (pid: number) => processes.get(pid), (pid: number) => { processes.delete(pid); },
    (generation, result) => observations.retired(generation, result),
  );
  return { pending, info, slots, threadWorkers, observations, events, createWorker, settleRetiredChannelListeners,
    waitForWorkerQuiescence, waitForExecRetirement, retirementNotices,
    retireBatch: (exec = false): Promise<boolean> => actual.batch(pid, exec),
    get admitted() { return admitted; }, start: () => start(), cancel: () => cancel(),
    async retire(memorySafe = info.memoryRetirementSafe) {
      const result = await ledger.detach({ pid, generation: info, memory, detach: () => true, settle: () => {},
        retire: commit => {
          if (memorySafe) memoryLease.release(); else memoryLease.releaseAfterForcedTermination();
          commit(memorySafe ? "quiescent" : "forced");
        },
      });
      if (result.status === "released") {
        // The diagnostic hook intentionally runs on a later timer turn.
        // Await its event rather than assuming lease commit ran the timer.
        await retirementObserved;
        expect(memoryLease.executionOwner.snapshot()).toMatchObject({ retired: true, forced: !memorySafe });
        expect(allocator.getRetirementStats()).toMatchObject({ liveMemories: 0, liveAliases: 0, observedRetirements: 1 });
      }
      return result;
    },
  };
}

for (const host of ["node", "browser"] as const) for (const ptrWidth of [4, 8] as const) {
  it(`${host} actual clone stale-before-launch reclaims a sealed absent realm (${ptrWidth})`, async () => {
    const r = actualCloneRetirementControl(host, ptrWidth, "stale");
    await expect(r.pending).rejects.toThrow("changed generation before thread Worker launch");
    await r.admitted.termination;
    expect(r.createWorker).not.toHaveBeenCalled();
    expect(r.info.memoryRetirementSafe).toBe(true);
    expect(r.slots.size).toBe(0);
    expect(r.admitted.workerAbsence?.proven).toBe(true);
    expect(r.admitted.workerQuiescence.settled).toBe(false);
    expect(r.admitted.execRetirement.settled).toBe(false);
    expect(r.threadWorkers.size).toBe(0);
    expect(r.settleRetiredChannelListeners).toHaveBeenCalledExactlyOnceWith(41, r.info.memory, 65536);
    expect(r.admitted.worker.start()).toBe(false);
    r.start(); expect(r.createWorker).not.toHaveBeenCalled();
    await r.retire();
    expect(r.events.at(-1)).toMatchObject({ threads: 1, acknowledgedThreads: 0, absentThreads: 1,
      threadFences: "acknowledged-or-absent", leaseDisposition: "quiescent" });
    expect(r.retirementNotices).toMatchObject([{ retirementMode: "quiescent", ptrWidth }]);
  });

  it(`${host} actual deferred clone cancellation seals before a later continue (${ptrWidth})`, async () => {
    const r = actualCloneRetirementControl(host, ptrWidth, "deferred");
    await r.pending;
    expect(r.createWorker).not.toHaveBeenCalled();
    r.cancel(); await r.admitted.termination;
    expect(r.slots.size).toBe(0);
    expect(r.admitted.workerAbsence?.proven).toBe(true);
    r.start(); expect(r.createWorker).not.toHaveBeenCalled();
    expect(r.admitted.workerQuiescence.settled).toBe(false);
    await r.retire();
  });

  it.each(["started-stale", "constructor-failure", "termination-failure"] as const)(
    `${host} actual clone %s cannot be reported as absence (${ptrWidth})`, async mode => {
      const r = actualCloneRetirementControl(host, ptrWidth, mode, mode === "constructor-failure"
        ? () => { throw Error("published then threw"); }
        : mode === "termination-failure" ? () => {
            const backing = new MockWorkerAdapter().createWorker({});
            vi.spyOn(backing, "terminate").mockRejectedValue(Error("native termination failed"));
            return backing;
          } : undefined);
      await expect(r.pending).rejects.toThrow(mode === "constructor-failure" ? "published then threw" : "changed generation");
      await r.admitted.termination;
      expect(r.createWorker).toHaveBeenCalledOnce();
      expect(r.admitted.workerAbsence?.proven ?? false).toBe(false);
      expect(r.admitted.workerQuiescence.settled).toBe(false);
      expect(r.admitted.execRetirement.settled).toBe(false);
      if (host === "browser") {
        expect(r.info.memoryRetirementSafe).toBe(false);
        expect(r.slots.size).toBe(1);
      } else if (mode !== "started-stale") {
        expect(r.slots.size).toBe(1);
        expect(r.threadWorkers.get(41)).toContain(r.admitted);
        expect(DeferredWorkerHandle.hasCompletedBackingTermination(r.admitted.worker)).toBe(false);
      }
      const contained = host === "node" && mode !== "started-stale" ? await r.retireBatch() : r.info.memoryRetirementSafe;
      await r.retire(contained); expect(r.events.at(-1)).toMatchObject({ acknowledgedThreads: 0, absentThreads: 0, threadFences: "missing" });
    },
  );

  it(`${host} actual clone listener accepts a real Worker terminal ACK without absence (${ptrWidth})`, async () => {
    let realm!: Worker;
    let release!: () => void;
    // This is a real disposable Node realm for both source listeners; it does
    // not claim to exercise a real browser or the normal guest/kernel build.
    const r = actualCloneRetirementControl(host, ptrWidth, "started", () => {
      realm = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.once('message',()=>{parentPort.postMessage({type:'memory_quiescent',pid:41,tid:73});parentPort.close();});`, { eval: true });
      release = () => realm.postMessage("return from worker-main control");
      return realm as unknown as WorkerHandle;
    });
    try {
      await r.pending;
      const exited = once(realm, "exit");
      const ack = once(realm, "message");
      release(); await ack;
      await r.admitted.termination; await exited;
      expect(r.createWorker).toHaveBeenCalledOnce();
      expect(r.admitted.workerAbsence?.proven ?? false).toBe(false);
      expect(r.admitted.workerQuiescence.settled).toBe(true);
      expect(r.slots.size).toBe(0);
      await r.retire(); expect(r.events.at(-1)).toMatchObject({ acknowledgedThreads: 1, absentThreads: 0,
        threadFences: "acknowledged", leaseDisposition: "quiescent" });
    } finally { await realm?.terminate(); }
  });

  it.each([false, true])(`${host} actual batch seals a deferred clone without forging exec or memory ACKs (${ptrWidth}, exec=%s)`, async requireExec => {
    const r = actualCloneRetirementControl(host, ptrWidth, "deferred");
    await r.pending;
    // The main realm proof is a controlled boundary input. This fixture tests
    // the actual thread-batch body, not a normal main-worker activation.
    r.info.workerQuiescence.settle();
    const safe = await r.retireBatch(requireExec);
    expect(safe).toBe(true);
    expect(r.createWorker).not.toHaveBeenCalled();
    expect(r.waitForWorkerQuiescence).not.toHaveBeenCalled();
    expect(r.waitForExecRetirement).not.toHaveBeenCalled();
    expect(r.admitted.workerAbsence.proven).toBe(true);
    expect(r.admitted.workerQuiescence.settled).toBe(false);
    expect(r.admitted.execRetirement.settled).toBe(false);
    r.start(); expect(r.createWorker).not.toHaveBeenCalled();
    await r.retire(safe);
    expect(r.retirementNotices).toMatchObject([{ retirementMode: "quiescent", ptrWidth }]);
    expect(r.events.at(-1)).toMatchObject({ threads: 1, acknowledgedThreads: 0, absentThreads: 1,
      threadFences: "acknowledged-or-absent", leaseDisposition: "quiescent" });
  });

  it(`${host} actual batch retains forced retirement after a started realm has no ACK (${ptrWidth})`, async () => {
    const r = actualCloneRetirementControl(host, ptrWidth, "started");
    await r.pending;
    r.info.workerQuiescence.settle();
    const safe = await r.retireBatch(true);
    expect(safe).toBe(false);
    expect(r.waitForExecRetirement).toHaveBeenCalledOnce();
    expect(r.admitted.workerAbsence.proven).toBe(false);
    expect(r.admitted.workerQuiescence.settled).toBe(false);
    expect(r.admitted.execRetirement.settled).toBe(false);
    await r.retire(safe);
    expect(r.retirementNotices).toMatchObject([{ retirementMode: "forced", ptrWidth }]);
    expect(r.events.at(-1)).toMatchObject({ threads: 1, acknowledgedThreads: 0, absentThreads: 0,
      threadFences: "missing", leaseDisposition: "forced" });
  });

}
