import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CHANNEL_REQUEST_FLAG_CANCELLATION_POINT,
  CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_REQUEST_FLAGS,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  PROCESS_STATE_EXITED,
  PROCESS_STATE_RUNNING,
} from "../src/generated/abi";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const EAGAIN = 11;
const EINTR = 4;
const ENOLCK = 37;
const F_SETLKW = 7;
const FLOCK_PTR = 512;
const LOCK_EX = 2;
const LOCK_NB = 4;
const WAKE_ADVISORY_LOCK = 64;

describe("Rust-owned advisory-lock retry scheduling", () => {
  it("parks only a conflicting blocking request, not ENOLCK", () => {
    const conflict = createFcntlHarness(EAGAIN);
    conflict.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      conflict.channel,
    );

    const parked = mutableState(conflict.worker)
      .pendingAdvisoryLockRetries.get(conflict.channel);
    expect(parked).toBeDefined();
    expect(conflict.completeChannel).not.toHaveBeenCalled();
    clearTimeout(parked!.timer);

    const exhausted = createFcntlHarness(ENOLCK);
    exhausted.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      exhausted.channel,
    );

    expect(mutableState(exhausted.worker).pendingAdvisoryLockRetries.size)
      .toBe(0);
    expect(exhausted.completeChannel).toHaveBeenCalledWith(
      exhausted.channel,
      ABI_SYSCALLS.Fcntl,
      [3, F_SETLKW, FLOCK_PTR, 0, 0, 0],
      undefined,
      -1,
      ENOLCK,
    );
  });

  it("completes a conflicting blocking request with EINTR for a caught signal", () => {
    const interrupted = createFcntlHarness(EAGAIN, 10);
    const args = [3, F_SETLKW, FLOCK_PTR, 0, 0, 0];

    interrupted.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
      interrupted.channel,
    );

    expect(mutableState(interrupted.worker).pendingAdvisoryLockRetries.size)
      .toBe(0);
    expect(interrupted.completeChannel).toHaveBeenCalledWith(
      interrupted.channel,
      ABI_SYSCALLS.Fcntl,
      args,
      undefined,
      -1,
      EINTR,
    );
  });

  it("retries parked lock requests only from the advisory-lock wake bit", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(9, processMemory);
    const drain = vi.fn((outPtr: number) => {
      const view = new DataView(kernelMemory.buffer);
      view.setUint32(outPtr, 0, true);
      view.setUint8(outPtr + 4, WAKE_ADVISORY_LOCK);
      return 1;
    });
    const worker = createWorker(
      { kernel_drain_wakeup_events: drain },
      kernelMemory,
    );
    const state = mutableState(worker);
    state.processes = new Map([[channel.pid, {
      channels: [channel],
      memory: processMemory,
      ptrWidth: 4,
    }]]);
    state.pendingAdvisoryLockRetries = new Map();
    const scheduleWakeBlockedRetries = vi.fn();
    const retrySyscall = vi.fn();
    worker.testAuthority.configureScratchBoundaryHooksForTest({
      scheduleWakeBlockedRetries,
      retrySyscall,
    });

    const timer = setTimeout(() => undefined, 1_000);
    state.pendingAdvisoryLockRetries.set(channel, {
      cancellationPoint: false,
      cancellationWakeAllowed: false,
      timer,
      channel,
    });

    worker.testAuthority.drainWakeupEventsForTest();

    expect(retrySyscall).toHaveBeenCalledOnce();
    expect(retrySyscall).toHaveBeenCalledWith(channel);
    expect(state.pendingAdvisoryLockRetries.size).toBe(0);
    expect(scheduleWakeBlockedRetries).not.toHaveBeenCalled();
  });

  it("retires a parked lock request when its exact channel is removed", () => {
    const memory = createSharedMemory();
    const channel = createChannel(12, memory);
    const worker = createWorker({});
    const state = mutableState(worker);
    state.processes = new Map([[channel.pid, {
      channels: [channel],
      memory,
      ptrWidth: 4,
    }]]);
    state.activeChannels = [channel];
    state.waitingForChild = [];
    state.pendingAdvisoryLockRetries = new Map();
    const timer = setTimeout(() => undefined, 1_000);
    state.pendingAdvisoryLockRetries.set(channel, {
      cancellationPoint: false,
      cancellationWakeAllowed: false,
      timer,
      channel,
    });

    worker.removeChannel(channel.pid, channel.channelOffset);

    expect(state.pendingAdvisoryLockRetries.size).toBe(0);
  });

  it("drains Rust lock wakes after direct process removal", () => {
    const remove = vi.fn(() => 0);
    const drain = vi.fn(() => 0);
    const worker = createWorker({
      kernel_remove_process: remove,
      kernel_drain_wakeup_events: drain,
    });

    worker.removeFromKernelProcessTable(12);

    expect(remove).toHaveBeenCalledWith(12);
    expect(drain).toHaveBeenCalledOnce();
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      drain.mock.invocationCallOrder[0],
    );
  });

  it("drains Rust lock wakes after normal process exit", () => {
    const memory = createSharedMemory();
    const channel = createChannel(18, memory);
    const commitExit = vi.fn(() => 0);
    const drain = vi.fn(() => 0);
    const worker = createWorker({
      kernel_commit_process_exit: commitExit,
      kernel_drain_wakeup_events: drain,
      kernel_get_process_state: vi.fn(() => PROCESS_STATE_EXITED),
    });
    const state = mutableState(worker);
    state.processes = new Map([[channel.pid, {
      channels: [channel],
      memory,
      ptrWidth: 4,
    }]]);
    state.activeChannels = [channel];
    const completeChannelRaw = vi.fn();
    worker.testAuthority.configureScratchBoundaryHooksForTest({
      completeChannelRaw,
      relistenChannel: vi.fn(),
      scheduleWakeBlockedRetries: vi.fn(),
    });
    setChannelSyscall(channel, ABI_SYSCALLS.ExitGroup, [0]);

    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(completeChannelRaw).toHaveBeenCalledWith(channel, 0, 0);
    expect(drain).toHaveBeenCalledOnce();
    expect(commitExit.mock.invocationCallOrder[0]).toBeLessThan(
      drain.mock.invocationCallOrder[0],
    );
  });

  it("drains Rust lock wakes before signal-termination notifications", () => {
    const memory = createSharedMemory();
    const channel = createChannel(20, memory);
    const onExit = vi.fn();
    let state!: ReturnType<typeof mutableState>;
    const sharedMappingsPresentAtDrain: boolean[] = [];
    const drain = vi.fn(() => {
      sharedMappingsPresentAtDrain.push(state.sharedMappings.has(channel.pid));
      return 0;
    });
    const worker = createWorker({
      kernel_drain_wakeup_events: drain,
      kernel_handle_channel: vi.fn(() => 0),
      kernel_get_process_exit_signal: vi.fn(() => 9),
    }, undefined, { onExit });
    state = mutableState(worker);
    state.processes = new Map([[channel.pid, {
      channels: [channel],
      memory,
      ptrWidth: 4,
    }]]);
    state.activeChannels = [channel];
    // An empty real mapping set is enough to observe the exact release point:
    // releaseAllSharedMemoryForProcess removes the pid before its second drain.
    state.sharedMappings = new Map([[channel.pid, new Map()]]);

    worker.testAuthority.sendSignalForTest(channel.pid, 9);

    expect(sharedMappingsPresentAtDrain).toEqual([true, false]);
    expect(state.sharedMappings.has(channel.pid)).toBe(false);
    expect(onExit).toHaveBeenCalledWith(channel.pid, 137);
    expect(drain.mock.invocationCallOrder[1]).toBeLessThan(
      onExit.mock.invocationCallOrder[0],
    );
  });

  it("drains Rust lock wakes after the atomic target-aware exec commit", () => {
    const commit = vi.fn(() => -5);
    const drain = vi.fn(() => 0);
    const worker = createWorker({
      kernel_drain_wakeup_events: drain,
      kernel_exec_commit: commit,
    });

    expect(worker.kernelExecCommit(19, 19, 23)).toBe(-5);

    expect(drain).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledExactlyOnceWith(19, 19, 23);
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      drain.mock.invocationCallOrder[0],
    );
  });

  it("retires old-image lock retries at exec handoff", () => {
    const memory = createSharedMemory();
    const oldChannel = createChannel(16, memory);
    const peerChannel = createChannel(17, memory);
    const worker = createWorker({});
    const state = mutableState(worker);
    state.processes = new Map([[16, {
      channels: [oldChannel],
      memory,
      ptrWidth: 4,
    }]]);
    state.activeChannels = [oldChannel, peerChannel];
    state.pendingAdvisoryLockRetries = new Map();
    const oldTimer = setTimeout(() => undefined, 1_000);
    const peerTimer = setTimeout(() => undefined, 1_000);
    state.pendingAdvisoryLockRetries.set(oldChannel, {
      cancellationPoint: false,
      cancellationWakeAllowed: false,
      timer: oldTimer,
      channel: oldChannel,
    });
    state.pendingAdvisoryLockRetries.set(peerChannel, {
      cancellationPoint: false,
      cancellationWakeAllowed: false,
      timer: peerTimer,
      channel: peerChannel,
    });
    state.waitingForChild = [];
    state.pendingFutexWaits = new Map();
    state.pendingCancels = new Set();
    state.threadForkContexts = new Map();
    state.posixTimers = new Map();
    state.socketTimeoutTimers = new Map();

    worker.prepareProcessForExec(16);

    expect(state.pendingAdvisoryLockRetries.has(oldChannel)).toBe(false);
    expect(state.pendingAdvisoryLockRetries.has(peerChannel)).toBe(true);
    expect(state.activeChannels).toEqual([peerChannel]);
    expect(state.processes.get(16)!.channels).toEqual([]);
    clearTimeout(peerTimer);
  });

  it("interrupts a parked lock request at a thread cancellation point", () => {
    const {
      caller,
      relistenChannel,
      state,
      syntheticCalls,
      target,
      worker,
    } = createParkedAdvisoryCancellationHarness(true);
    expect(state.pendingAdvisoryLockRetries.get(target)).toMatchObject({
      cancellationPoint: true,
      cancellationWakeAllowed: true,
    });
    setChannelSyscall(caller, ABI_SYSCALLS.ThreadCancel, [99]);

    worker.testAuthority.dispatchScratchBoundarySyscallForTest(caller);

    expect(syntheticCalls).toEqual([{
      syscall: ABI_SYSCALLS.ThreadCancel,
      args: [99, 0, 0, 0, 0, 0],
    }]);
    expect(state.pendingAdvisoryLockRetries.size).toBe(0);
    expect(readChannelResult(caller)).toEqual({ retVal: 0n, errVal: 0 });
    expect(readChannelResult(target)).toEqual({ retVal: -4n, errVal: 4 });
    expect(relistenChannel).toHaveBeenCalledWith(caller);
    expect(relistenChannel).toHaveBeenCalledWith(target);
  });

  it("keeps a cancellation-disabled advisory lock request parked", () => {
    const {
      caller,
      relistenChannel,
      state,
      syntheticCalls,
      target,
      worker,
    } = createParkedAdvisoryCancellationHarness(false);
    const parked = state.pendingAdvisoryLockRetries.get(target);
    expect(parked).toMatchObject({
      cancellationPoint: true,
      cancellationWakeAllowed: false,
    });
    setChannelSyscall(caller, ABI_SYSCALLS.ThreadCancel, [99]);

    worker.testAuthority.dispatchScratchBoundarySyscallForTest(caller);

    expect(syntheticCalls).toEqual([]);
    expect(state.pendingAdvisoryLockRetries.get(target)).toBe(parked);
    expect(state.pendingCancels.has(target)).toBe(true);
    expect(readChannelResult(caller)).toEqual({ retVal: 0n, errVal: 0 });
    expect(Atomics.load(
      target.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    )).toBe(CHANNEL_STATUS_PENDING);
    expect(relistenChannel).toHaveBeenCalledOnce();
    expect(relistenChannel).toHaveBeenCalledWith(caller);
    expect(relistenChannel).not.toHaveBeenCalledWith(target);
    clearTimeout(parked!.timer);
  });

  it("retries a parked lock request so Rust can observe a pending signal", () => {
    const memory = createSharedMemory();
    const channel = createChannel(14, memory);
    const worker = createWorker({
      kernel_pick_signal_target_tid: vi.fn(() => 14),
      kernel_thread_has_deliverable: vi.fn(() => 1),
    });
    const state = mutableState(worker);
    state.processes = new Map([[14, {
      channels: [channel],
      memory,
      ptrWidth: 4,
    }]]);
    state.activeChannels = [channel];
    state.pendingSleeps = new Map();
    state.pendingPollRetries = new Map();
    state.pendingAdvisoryLockRetries = new Map();
    state.pendingSelectRetries = new Map();
    const retrySyscall = vi.fn();
    worker.testAuthority.configureScratchBoundaryHooksForTest({
      retrySyscall,
    });
    const timer = setTimeout(() => undefined, 1_000);
    state.pendingAdvisoryLockRetries.set(channel, {
      cancellationPoint: false,
      cancellationWakeAllowed: false,
      timer,
      channel,
    });

    worker.testAuthority.sendSignalForTest(14, 10, false);

    expect(state.pendingAdvisoryLockRetries.size).toBe(0);
    expect(retrySyscall).toHaveBeenCalledWith(channel);
  });

  it("parks blocking flock but completes LOCK_NB conflicts immediately", () => {
    const memory = createSharedMemory();
    const channel = createChannel(15, memory);
    const kernelMemory = createSharedMemory();
    let deliveredSignal = 0;
    const worker = createWorker({
      kernel_dequeue_signal: vi.fn(() => deliveredSignal),
      kernel_handle_channel: vi.fn((pointer: number) => {
        const view = new DataView(kernelMemory.buffer, pointer);
        view.setBigInt64(CH_RETURN, -1n, true);
        view.setUint32(CH_ERRNO, EAGAIN, true);
        return 0;
      }),
    }, kernelMemory);
    const state = mutableState(worker);
    state.processes = new Map([[channel.pid, {
      channels: [channel],
      memory,
      ptrWidth: 4,
    }]]);
    state.activeChannels = [channel];
    state.pendingAdvisoryLockRetries = new Map();
    const completeChannel = vi.fn();
    worker.testAuthority.configureScratchBoundaryHooksForTest({
      completeChannel,
    });

    setChannelSyscall(
      channel,
      ABI_SYSCALLS.Flock,
      [3, LOCK_EX, 0, 0, 0, 0],
    );
    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
    const parked = state.pendingAdvisoryLockRetries.get(channel);
    expect(parked).toBeDefined();
    expect(completeChannel).not.toHaveBeenCalled();
    clearTimeout(parked!.timer);
    state.pendingAdvisoryLockRetries.clear();

    setChannelSyscall(
      channel,
      ABI_SYSCALLS.Flock,
      [3, LOCK_EX | LOCK_NB, 0, 0, 0, 0],
    );
    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
    expect(state.pendingAdvisoryLockRetries.size).toBe(0);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Flock,
      [3, LOCK_EX | LOCK_NB, 0, 0, 0, 0],
      undefined,
      -1,
      EAGAIN,
    );

    completeChannel.mockClear();
    deliveredSignal = 10;
    setChannelSyscall(
      channel,
      ABI_SYSCALLS.Flock,
      [3, LOCK_EX, 0, 0, 0, 0],
    );
    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
    expect(state.pendingAdvisoryLockRetries.size).toBe(0);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Flock,
      [3, LOCK_EX, 0, 0, 0, 0],
      undefined,
      -1,
      EINTR,
    );
  });

  it("rejects busy advisory test operations without running them later", async () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(23, processMemory);
    const forkProcess = vi.fn(() => 24);
    let worker!: TestWorker;
    let dispatchError: unknown;
    let forkError: unknown;
    let handleCalls = 0;
    const handleChannel = vi.fn((pointer: number) => {
      handleCalls += 1;
      if (handleCalls === 1) {
        try {
          worker.testAuthority
            .dispatchRegisteredMainChannelForAdvisoryLockTest(channel.pid);
        } catch (error) {
          dispatchError = error;
        }
        try {
          worker.testAuthority.forkKernelProcessForAdvisoryLockTest(
            channel.pid,
            channel.pid,
          );
        } catch (error) {
          forkError = error;
        }
      }
      const view = new DataView(kernelMemory.buffer, pointer);
      view.setBigInt64(CH_RETURN, 0n, true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    worker = createWorker({
      kernel_fork_process: forkProcess,
      kernel_handle_channel: handleChannel,
    }, kernelMemory);
    const state = mutableState(worker);
    state.processes = new Map([[channel.pid, {
      channels: [channel],
      memory: processMemory,
      ptrWidth: 4,
    }]]);
    state.activeChannels = [channel];
    worker.testAuthority.configureScratchBoundaryHooksForTest({
      // Keep the caller-owned mailbox pending after the outer dispatch. If a
      // rejected operation were accidentally queued, its later revalidation
      // would still succeed and this regression would observe a second call.
      completeChannel: vi.fn(),
    });
    setChannelSyscall(channel, ABI_SYSCALLS.Getpid, []);
    Atomics.store(
      channel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      CHANNEL_STATUS_PENDING,
    );

    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

    expect(dispatchError).toBeInstanceOf(KernelReentrantEntryError);
    expect(forkError).toBeInstanceOf(KernelReentrantEntryError);
    expect(handleChannel).toHaveBeenCalledOnce();
    expect(forkProcess).not.toHaveBeenCalled();

    // Let the gate's detached-effect/drain microtasks run. Immediate test
    // ingress must reject without retaining either operation for that drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(handleChannel).toHaveBeenCalledOnce();
    expect(forkProcess).not.toHaveBeenCalled();
  });
});

function createFcntlHarness(
  errno: number,
  caughtSignal = 0,
): {
  worker: TestWorker;
  channel: TestChannel;
  completeChannel: ReturnType<typeof vi.fn>;
} {
  const kernelMemory = createSharedMemory();
  const processMemory = createSharedMemory();
  const channel = createChannel(7, processMemory);
  const worker = createWorker({
    kernel_handle_channel: vi.fn((offset: number) => {
      const view = new DataView(kernelMemory.buffer, offset);
      view.setBigInt64(CH_RETURN, -1n, true);
      view.setUint32(CH_ERRNO, errno, true);
      return 0;
    }),
    kernel_dequeue_signal: vi.fn(() => caughtSignal),
  }, kernelMemory);
  const state = mutableState(worker);
  state.processes = new Map([[channel.pid, {
    channels: [channel],
    memory: processMemory,
    ptrWidth: 4,
  }]]);
  state.activeChannels = [channel];
  state.pendingAdvisoryLockRetries = new Map();
  const completeChannel = vi.fn();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel,
  });
  setChannelSyscall(
    channel,
    ABI_SYSCALLS.Fcntl,
    [3, F_SETLKW, FLOCK_PTR, 0, 0, 0],
  );
  return { worker, channel, completeChannel };
}

type TestWorker = ReturnType<typeof createCentralizedKernelWorkerTestDouble>;

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

interface MutableWorkerState {
  processes: Map<number, {
    channels: TestChannel[];
    memory: WebAssembly.Memory;
    ptrWidth: 4 | 8;
  }>;
  activeChannels: TestChannel[];
  channelTids: Map<string, number>;
  hostReaped: Set<number>;
  waitingForChild: unknown[];
  pendingSleeps: Map<TestChannel, unknown>;
  pendingFutexWaits: Map<TestChannel, unknown>;
  pendingPollRetries: Map<TestChannel, unknown>;
  pendingAdvisoryLockRetries: Map<TestChannel, {
    cancellationPoint: boolean;
    cancellationWakeAllowed: boolean;
    timer: ReturnType<typeof setTimeout>;
    channel: TestChannel;
  }>;
  pendingSelectRetries: Map<TestChannel, unknown>;
  pendingPipeReaders: Map<number, unknown[]>;
  pendingPipeWriters: Map<number, unknown[]>;
  pendingCancels: Set<TestChannel>;
  threadForkContexts: Map<string, unknown>;
  posixTimers: Map<unknown, unknown>;
  socketTimeoutTimers: Map<TestChannel, ReturnType<typeof setTimeout>>;
  sharedMappings: Map<number, Map<number, unknown>>;
}

function mutableState(worker: TestWorker): MutableWorkerState {
  // These are existing writable value fields on a sealed test instance. Tests
  // may arrange inert host state, but never replace entry-taking methods or
  // install a raw instance/export namespace on the worker.
  return worker as unknown as MutableWorkerState;
}

function createWorker(
  exports: Record<string, unknown>,
  suppliedMemory?: WebAssembly.Memory,
  callbacks: { onExit?: (pid: number, status: number) => void } = {},
): TestWorker {
  const kernelMemory = suppliedMemory ?? createSharedMemory();
  const kernelExports: Record<string, unknown> = {
    kernel_blocking_retry_release: () => 0,
    kernel_blocking_retry_token: () => 1n,
    kernel_dequeue_signal: () => 0,
    kernel_drain_wakeup_events: () => 0,
    kernel_generate_host_signal: () => 0,
    kernel_get_parent_pid: () => 0,
    kernel_get_process_exit_signal: () => -1,
    kernel_get_process_exit_status: () => -1,
    kernel_get_process_state: () => PROCESS_STATE_RUNNING,
    kernel_has_sa_nocldstop: () => 0,
    kernel_has_sa_nocldwait: () => 0,
    kernel_pick_signal_target_tid: () => 0,
    kernel_set_current_tid: () => 0,
    kernel_thread_has_deliverable: () => 0,
    ...exports,
  };
  const worker = createCentralizedKernelWorkerTestDouble({
    callbacks,
  });
  installKernelWorkerTestScratch(worker, kernelMemory, 128, 4, {
    kernelExports,
  });
  return worker;
}

function createParkedAdvisoryCancellationHarness(
  cancellationWakeAllowed: boolean,
): {
  worker: TestWorker;
  state: MutableWorkerState;
  caller: TestChannel;
  target: TestChannel;
  syntheticCalls: Array<{ syscall: number; args: number[] }>;
  relistenChannel: ReturnType<typeof vi.fn>;
} {
  const memory = createSharedMemory();
  const caller = createChannel(13, memory);
  const target = createChannel(13, memory, 256);
  const kernelMemory = createSharedMemory();
  const syntheticCalls: Array<{ syscall: number; args: number[] }> = [];
  const worker = createWorker({
    kernel_handle_channel: vi.fn((pointer: number) => {
      const view = new DataView(kernelMemory.buffer, pointer);
      const syscall = view.getUint32(CH_SYSCALL, true);
      if (syscall === ABI_SYSCALLS.Fcntl) {
        view.setBigInt64(CH_RETURN, -1n, true);
        view.setUint32(CH_ERRNO, EAGAIN, true);
        return 0;
      }
      syntheticCalls.push({
        syscall,
        args: Array.from(
          { length: CH_ARGS_COUNT },
          (_, index) => Number(view.getBigInt64(
            CH_ARGS + index * CH_ARG_SIZE,
            true,
          )),
        ),
      });
      view.setBigInt64(CH_RETURN, 0n, true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    }),
  }, kernelMemory);
  const state = mutableState(worker);
  state.processes = new Map([[13, {
    channels: [caller, target],
    memory,
    ptrWidth: 4,
  }]]);
  state.activeChannels = [caller, target];
  state.channelTids = new Map([["13:256", 99]]);
  state.pendingCancels = new Set();
  state.pendingFutexWaits = new Map();
  state.pendingPollRetries = new Map();
  state.pendingAdvisoryLockRetries = new Map();
  state.pendingSelectRetries = new Map();
  state.pendingPipeReaders = new Map();
  state.pendingPipeWriters = new Map();
  state.waitingForChild = [];
  const relistenChannel = vi.fn();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    relistenChannel,
  });
  Atomics.store(
    target.i32View,
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    CHANNEL_STATUS_PENDING,
  );
  setChannelSyscall(
    target,
    ABI_SYSCALLS.Fcntl,
    [3, F_SETLKW, FLOCK_PTR, 0, 0, 0],
    CHANNEL_REQUEST_FLAG_CANCELLATION_POINT
      | (cancellationWakeAllowed
        ? CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
        : 0),
  );
  worker.testAuthority.dispatchScratchBoundarySyscallForTest(target);
  return {
    worker,
    state,
    caller,
    target,
    syntheticCalls,
    relistenChannel,
  };
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}

function createChannel(
  pid: number,
  memory: WebAssembly.Memory,
  channelOffset = 0,
): TestChannel {
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(
      memory.buffer,
      channelOffset,
      CH_TOTAL_SIZE / Int32Array.BYTES_PER_ELEMENT,
    ),
    consecutiveSyscalls: 0,
    handling: true,
  };
}

function setChannelSyscall(
  channel: TestChannel,
  syscallNr: number,
  args: readonly number[],
  requestFlags = 0,
): void {
  const view = new DataView(channel.memory.buffer, channel.channelOffset);
  view.setUint32(CH_SYSCALL, syscallNr, true);
  view.setUint32(CH_REQUEST_FLAGS, requestFlags, true);
  for (let index = 0; index < CH_ARGS_COUNT; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }
}

function readChannelResult(
  channel: TestChannel,
): { retVal: bigint; errVal: number } {
  const view = new DataView(channel.memory.buffer, channel.channelOffset);
  return {
    retVal: view.getBigInt64(CH_RETURN, true),
    errVal: view.getUint32(CH_ERRNO, true),
  };
}
