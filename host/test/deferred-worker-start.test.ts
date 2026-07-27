import { describe, expect, it, vi } from "vitest";
import { DeferredWorkerHandle } from "../src/deferred-worker-handle";
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

  it("rolls back only a deferred clone when its thread Worker cannot start", async () => {
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

    processState = 0;
    expect(
      worker.testAuthority.resumeStoppedProcessForTest(41),
    ).toBe(true);
    await drainLifecycleGate();

    expect(cancel).toHaveBeenCalledOnce();
    expect(markSignaled).not.toHaveBeenCalled();
    expect(view.getInt32(ptidPtr, true)).toBe(0);
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
