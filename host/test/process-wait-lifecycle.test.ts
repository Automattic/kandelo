import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_DATA,
  CH_RETURN,
  CH_SIG_FLAGS,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  KERNEL_WAIT_RESULT_CHILD_UID_OFFSET,
  KERNEL_WAIT_RESULT_RUSAGE_OFFSET,
  KERNEL_WAIT_RESULT_SI_CODE_OFFSET,
  KERNEL_WAIT_RESULT_SI_STATUS_OFFSET,
  KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET,
  PROCESS_STATE_RUNNING,
  PROCESS_STATE_STOPPED,
  STRUCT_SIZE_WASM_RUSAGE_WIRE,
  WAIT_CLD_EXITED,
  WAIT_CLD_STOPPED,
  WAIT_EVENT_EXITED,
  WAIT_EVENT_STOPPED,
  WAIT_WEXITED,
  WAIT_WNOHANG,
  WAIT_WNOWAIT,
  WAIT_WSTOPPED,
  WAKE_PROCESS_CONTINUED,
  WAKE_PROCESS_STOPPED,
} from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const SIGCHLD = 17;
const SIGCONT = 18;
const SIGTERM = 15;
const SIGUSR1 = 10;
const SA_RESTART = 0x10000000;

describe("Rust-owned process wait lifecycle", () => {
  it("wait4 atomically consumes a Rust-selected event and copies status+rusage", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const statusPtr = 256;
    const waitStatus = 5 << 8;
    const rusage = Uint8Array.from(
      { length: STRUCT_SIZE_WASM_RUSAGE_WIRE },
      (_, index) => index & 0xff,
    );
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number | bigint,
    ) => {
      writeKernelWaitResult(kernelMemory, Number(resultPtr), {
        waitStatus,
        siCode: 1,
        siStatus: 5,
        childUid: 123,
        rusage,
      });
      return 42;
    });
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_wait_child_poll: waitChildPoll,
      kernel_reap_exited_child: reapExitedChild,
    });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = 128;
    worker.completeWaitpid = vi.fn();

    const rusagePtr = 512;
    worker.handleWaitpid(
      createChannel(7, processMemory),
      [-1, statusPtr, 0, rusagePtr],
    );

    expect(waitChildPoll).toHaveBeenCalledWith(7, -1, WAIT_EVENT_EXITED, 0, 128);
    expect(reapExitedChild).not.toHaveBeenCalled();
    expect(new DataView(processMemory.buffer).getInt32(statusPtr, true)).toBe(waitStatus);
    expect(new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    )).toEqual(rusage);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, statusPtr, 0, rusagePtr],
      42,
      0,
    );
  });

  it("wait4 leaves blocking waits in the host queue when Rust reports a running child", () => {
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    const channel = createChannel(7, createSharedMemory());
    worker.handleWaitpid(channel, [-1, 0, 0, 0]);

    expect(worker.completeWaitpid).not.toHaveBeenCalled();
    expect(worker.waitingForChild).toEqual([
      {
        parentPid: 7,
        channel,
        origArgs: [-1, 0, 0, 0],
        pid: -1,
        options: 0,
        syscallNr: ABI_SYSCALLS.Wait4,
      },
    ]);
  });

  it("honors cancellation that lands before a wait can enqueue", () => {
    const waitChildPoll = vi.fn(() => 0);
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.pendingCancels = new Set([channel]);
    worker.waitingForChild = [];
    worker.completeChannelRaw = vi.fn();
    worker.relistenChannel = vi.fn();

    worker.handleWaitpid(channel, [-1, 0, 0, 0]);

    expect(waitChildPoll).not.toHaveBeenCalled();
    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeChannelRaw).toHaveBeenCalledWith(channel, -4, 4);
    expect(worker.relistenChannel).toHaveBeenCalledWith(channel);
  });

  it("consumes a pre-enqueue cancel only for the exact FIFO open retry", () => {
    const memory = createSharedMemory();
    const channel = createChannel(7, memory);
    const worker = createWorkerHarness({});
    worker.pendingCancels = new Set([channel]);
    worker.cancelParkedFifoOpen = vi.fn(() => true);
    worker.completeChannelRaw = vi.fn();
    worker.relistenChannel = vi.fn();

    expect(worker.interruptPendingFifoOpenCancellation(
      channel,
      ABI_SYSCALLS.Getpid,
    )).toBe(false);
    expect(worker.pendingCancels.has(channel)).toBe(true);
    expect(worker.cancelParkedFifoOpen).not.toHaveBeenCalled();

    expect(worker.interruptPendingFifoOpenCancellation(
      channel,
      ABI_SYSCALLS.Open,
    )).toBe(true);
    expect(worker.pendingCancels.has(channel)).toBe(false);
    expect(worker.cancelParkedFifoOpen).toHaveBeenCalledOnce();
    expect(worker.completeChannelRaw).toHaveBeenCalledOnce();
    expect(worker.completeChannelRaw).toHaveBeenCalledWith(channel, -4, 4);
    expect(worker.relistenChannel).toHaveBeenCalledOnce();

    expect(worker.interruptPendingFifoOpenCancellation(
      channel,
      ABI_SYSCALLS.Open,
    )).toBe(false);
    expect(worker.completeChannelRaw).toHaveBeenCalledOnce();
  });

  it("wait4 WNOHANG completes without queuing when Rust reports no event", () => {
    const worker = createWorkerHarness({ kernel_wait_child_poll: vi.fn(() => 0) });
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, createSharedMemory()), [-1, 0, WAIT_WNOHANG, 0]);

    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, 0, WAIT_WNOHANG, 0],
      0,
      0,
    );
  });

  it("wait4 passes a bigint status pointer for wasm64 kernels", () => {
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll }, 8);
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, createSharedMemory()), [-1, 0, WAIT_WNOHANG, 0]);

    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      -1,
      WAIT_EVENT_EXITED,
      0,
      BigInt(128),
    );
    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, 0, WAIT_WNOHANG, 0],
      0,
      0,
    );
  });

  it("returns EFAULT before polling or consuming an event for invalid wait4 outputs", () => {
    const waitChildPoll = vi.fn(() => 42);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.completeWaitpid = vi.fn();
    const processMemory = createSharedMemory();
    const invalidStatusPtr = processMemory.buffer.byteLength - 2;
    const args = [-1, invalidStatusPtr, 0, 0];

    worker.handleWaitpid(createChannel(7, processMemory), args);

    expect(waitChildPoll).not.toHaveBeenCalled();
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      args,
      -1,
      14,
    );
  });

  it("waitid passes STOPPED+WNOWAIT and writes exact CLD, uid, status, and rusage", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const siginfoPtr = 512;
    const rusagePtr = 1024;
    const rusage = new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE).fill(0x5a);
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number | bigint,
    ) => {
      writeKernelWaitResult(kernelMemory, Number(resultPtr), {
        waitStatus: (19 << 8) | 0x7f,
        siCode: WAIT_CLD_STOPPED,
        siStatus: 19,
        childUid: 4242,
        rusage,
      });
      return 44;
    });
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.kernelMemory = kernelMemory;
    worker.completeWaitid = vi.fn();
    const args = [1, 44, siginfoPtr, WAIT_WSTOPPED | WAIT_WNOWAIT, rusagePtr];

    worker.handleWaitid(createChannel(7, processMemory), args);

    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      44,
      WAIT_EVENT_STOPPED,
      WAIT_WNOWAIT,
      128,
    );
    const siginfo = new DataView(processMemory.buffer);
    expect(siginfo.getInt32(siginfoPtr, true)).toBe(SIGCHLD);
    expect(siginfo.getInt32(siginfoPtr + 8, true)).toBe(WAIT_CLD_STOPPED);
    expect(siginfo.getInt32(siginfoPtr + 12, true)).toBe(44);
    expect(siginfo.getUint32(siginfoPtr + 16, true)).toBe(4242);
    expect(siginfo.getInt32(siginfoPtr + 20, true)).toBe(19);
    expect(new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    )).toEqual(rusage);
    expect(worker.completeWaitid).toHaveBeenCalledWith(
      expect.any(Object),
      args,
      0,
      0,
    );
  });

  it("waitid writes musl's aligned wasm64 siginfo fields", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    const siginfoPtr = 512;
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number | bigint,
    ) => {
      writeKernelWaitResult(kernelMemory, Number(resultPtr), {
        waitStatus: 9 << 8,
        siCode: WAIT_CLD_EXITED,
        siStatus: 9,
        childUid: 5150,
        rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
      });
      return 44;
    });
    const worker = createWorkerHarness(
      { kernel_wait_child_poll: waitChildPoll },
      8,
    );
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
      ptrWidth: 8,
    }]]);
    worker.completeWaitid = vi.fn();
    const args = [1, 44, siginfoPtr, WAIT_WEXITED, 0];

    worker.handleWaitid(channel, args);

    const siginfo = new DataView(processMemory.buffer);
    expect(siginfo.getInt32(siginfoPtr, true)).toBe(SIGCHLD);
    expect(siginfo.getInt32(siginfoPtr + 8, true)).toBe(WAIT_CLD_EXITED);
    expect(siginfo.getUint32(siginfoPtr + 12, true)).toBe(0);
    expect(siginfo.getInt32(siginfoPtr + 16, true)).toBe(44);
    expect(siginfo.getUint32(siginfoPtr + 20, true)).toBe(5150);
    expect(siginfo.getInt32(siginfoPtr + 24, true)).toBe(9);
  });

  it("waitid WNOHANG zeros all siginfo bytes and leaves rusage untouched", () => {
    const processMemory = createSharedMemory();
    const siginfoPtr = 512;
    const rusagePtr = 1024;
    new Uint8Array(processMemory.buffer, siginfoPtr, 128).fill(0xa5);
    new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    ).fill(0x6b);
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.completeWaitid = vi.fn();
    const args = [0, 0, siginfoPtr, WAIT_WEXITED | WAIT_WNOHANG, rusagePtr];

    worker.handleWaitid(createChannel(7, processMemory), args);

    expect(new Uint8Array(processMemory.buffer, siginfoPtr, 128))
      .toEqual(new Uint8Array(128));
    expect(new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    )).toEqual(new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE).fill(0x6b));
    expect(worker.completeWaitid).toHaveBeenCalledWith(
      expect.any(Object),
      args,
      0,
      0,
    );
  });

  it("rejects invalid waitid idtypes and required null siginfo before polling", () => {
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.completeWaitid = vi.fn();
    const channel = createChannel(7, createSharedMemory());

    worker.handleWaitid(channel, [99, 0, 512, WAIT_WEXITED, 0]);
    worker.handleWaitid(channel, [0, 0, 0, WAIT_WEXITED, 0]);

    expect(waitChildPoll).not.toHaveBeenCalled();
    expect(worker.completeWaitid.mock.calls.map((call: unknown[]) => call[3]))
      .toEqual([22, 14]);
  });

  it("owns a drained wake batch before nested SIGCHLD work reuses scratch", () => {
    const kernelMemory = createSharedMemory();
    const drain = vi.fn((outPtr: number, _outLen: number, _max: number) => {
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_STOPPED);
      writeWakeEvent(kernelMemory, outPtr, 1, 43, WAKE_PROCESS_CONTINUED);
      return 2;
    });
    const worker = createWorkerHarness({ kernel_drain_wakeup_events: drain });
    worker.kernelMemory = kernelMemory;
    worker.stoppedPids = new Set();
    worker.notifyParentOfChildStateTransition = vi.fn(() => {
      new Uint8Array(kernelMemory.buffer).fill(0xff);
    });
    worker.resumeStoppedProcess = vi.fn(() => true);

    worker.drainAndProcessWakeupEvents();

    expect(worker.stoppedPids.has(42)).toBe(true);
    expect(worker.resumeStoppedProcess).toHaveBeenCalledWith(43);
    expect(worker.notifyParentOfChildStateTransition).toHaveBeenCalledTimes(2);
  });

  it("does not report CONTINUED when resume preflight stops the process again", () => {
    const kernelMemory = createSharedMemory();
    let drained = false;
    const drain = vi.fn((outPtr: number) => {
      if (drained) return 0;
      drained = true;
      writeWakeEvent(
        kernelMemory,
        outPtr,
        0,
        43,
        WAKE_PROCESS_CONTINUED,
      );
      return 1;
    });
    const worker = createWorkerHarness({ kernel_drain_wakeup_events: drain });
    worker.kernelMemory = kernelMemory;
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.resumeStoppedProcess = vi.fn(() => false);
    worker.notifyParentOfChildStateTransition = vi.fn();
    worker.anyPendingRetryNeedsSignalSafeWake = vi.fn(() => false);
    worker.scheduleWakeBlockedRetries = vi.fn();

    worker.drainAndProcessWakeupEvents();

    expect(worker.resumeStoppedProcess).toHaveBeenCalledWith(43);
    expect(worker.notifyParentOfChildStateTransition).not.toHaveBeenCalled();
  });

  it("drains a STOPPED transition generated while CONTINUED preflight fails", () => {
    const kernelMemory = createSharedMemory();
    let batch = 0;
    const drain = vi.fn((outPtr: number) => {
      if (batch++ === 0) {
        writeWakeEvent(
          kernelMemory,
          outPtr,
          0,
          43,
          WAKE_PROCESS_CONTINUED,
        );
        return 1;
      }
      if (batch === 2) {
        writeWakeEvent(
          kernelMemory,
          outPtr,
          0,
          43,
          WAKE_PROCESS_STOPPED,
        );
        return 1;
      }
      return 0;
    });
    const worker = createWorkerHarness({ kernel_drain_wakeup_events: drain });
    worker.kernelMemory = kernelMemory;
    worker.stoppedPids = new Set();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.resumeStoppedProcess = vi.fn(() => false);
    worker.notifyParentOfChildStateTransition = vi.fn();
    worker.anyPendingRetryNeedsSignalSafeWake = vi.fn(() => false);
    worker.scheduleWakeBlockedRetries = vi.fn();

    worker.drainAndProcessWakeupEvents();

    expect(drain).toHaveBeenCalledTimes(2);
    expect(worker.stoppedPids.has(43)).toBe(true);
    expect(worker.notifyParentOfChildStateTransition).toHaveBeenCalledOnce();
    expect(worker.notifyParentOfChildStateTransition).toHaveBeenCalledWith(43);
  });

  it("drains overflow wake batches until a short batch includes lifecycle events", () => {
    const kernelMemory = createSharedMemory();
    let batch = 0;
    const drain = vi.fn((outPtr: number) => {
      if (batch++ === 0) {
        for (let i = 0; i < 256; i++) {
          writeWakeEvent(kernelMemory, outPtr, i, i + 100, 1);
        }
        return 256;
      }
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_STOPPED);
      return 1;
    });
    const worker = createWorkerHarness({ kernel_drain_wakeup_events: drain });
    worker.kernelMemory = kernelMemory;
    worker.stoppedPids = new Set();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.notifyParentOfChildStateTransition = vi.fn();
    worker.anyPendingRetryNeedsSignalSafeWake = vi.fn(() => false);
    worker.scheduleWakeBlockedRetries = vi.fn();

    worker.drainAndProcessWakeupEvents();

    expect(drain).toHaveBeenCalledTimes(2);
    expect(worker.stoppedPids.has(42)).toBe(true);
  });

  it("finalizes signal death before a stale continue event can notify or reap", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(42, processMemory);
    const drain = vi.fn((outPtr: number) => {
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_CONTINUED);
      return 1;
    });
    let exitSignal = SIGTERM;
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_drain_wakeup_events: drain,
      kernel_get_process_state: vi.fn(() => 2),
      kernel_get_process_exit_signal: vi.fn(() => exitSignal),
    });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[42, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.hostReaped = new Set();
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    worker.pendingSleeps = new Map();
    worker.releaseAllSharedMemoryForProcess = vi.fn();
    worker.notifyParentOfExitedProcess = vi.fn(() => { exitSignal = -3; });
    worker.resumeStoppedProcess = vi.fn();
    worker.notifyParentOfChildStateTransition = vi.fn();
    worker.callbacks = { onExit };

    worker.drainAndProcessWakeupEvents();

    expect(worker.notifyParentOfExitedProcess).toHaveBeenCalledWith(42);
    expect(onExit).toHaveBeenCalledWith(42, 128 + SIGTERM);
    expect(worker.resumeStoppedProcess).not.toHaveBeenCalled();
    expect(worker.notifyParentOfChildStateTransition).not.toHaveBeenCalled();
  });

  it("wakes a matching parent waiter while SA_NOCLDSTOP suppresses only SIGCHLD", () => {
    const worker = createWorkerHarness({
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldstop: vi.fn(() => 1),
    });
    worker.sendSignalToProcess = vi.fn();
    worker.wakeWaitingParent = vi.fn();

    worker.notifyParentOfChildStateTransition(42);

    expect(worker.sendSignalToProcess).not.toHaveBeenCalled();
    expect(worker.wakeWaitingParent).toHaveBeenCalledWith(7);
  });

  it("uses WNOWAIT for process-group waiter rechecks", () => {
    const waitChildPoll = vi.fn(() => 0);
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.processes = new Map([[7, { channels: [channel], memory: processMemory }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [0, 0, 0, 0],
      pid: 0,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];

    worker.recheckDeferredWaitpids();

    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      0,
      WAIT_EVENT_EXITED,
      WAIT_WNOWAIT,
      128,
    );
  });

  it("services status that becomes eligible after a process-group change", () => {
    const channel = createChannel(7, createSharedMemory());
    const worker = createWorkerHarness({});
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: channel.memory,
    }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [0, 0, 0, 0],
      pid: 0,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    worker.pollWaitableChild = vi.fn(() => ({
      kind: "event",
      childPid: 42,
      waitStatus: 0,
      siCode: WAIT_CLD_EXITED,
      siStatus: 0,
      childUid: 0,
      rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
    }));
    worker.wakeWaitingParent = vi.fn();

    worker.recheckDeferredWaitpids();

    expect(worker.wakeWaitingParent).toHaveBeenCalledWith(7);
    expect(worker.waitingForChild).toHaveLength(1);
  });

  it("completes a consuming waiter and a following ECHILD waiter in one wake", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const first = createChannel(7, processMemory, 0);
    const second = createChannel(7, processMemory, 256);
    let pollCount = 0;
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number,
    ) => {
      if (pollCount++ > 0) return -10; // ECHILD after the first wait reaps.
      writeKernelWaitResult(kernelMemory, resultPtr, {
        waitStatus: 3 << 8,
        siCode: WAIT_CLD_EXITED,
        siStatus: 3,
        childUid: 12,
        rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
      });
      return 42;
    });
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[7, {
      channels: [first, second],
      memory: processMemory,
    }]]);
    worker.completeWaitpid = vi.fn();
    worker.waitingForChild = [
      {
        parentPid: 7,
        channel: first,
        origArgs: [42, 1024, 0, 0],
        pid: 42,
        options: 0,
        syscallNr: ABI_SYSCALLS.Wait4,
      },
      {
        parentPid: 7,
        channel: second,
        origArgs: [42, 1280, 0, 0],
        pid: 42,
        options: 0,
        syscallNr: ABI_SYSCALLS.Wait4,
      },
    ];

    worker.wakeWaitingParent(7);

    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeWaitpid.mock.calls.map((call: unknown[]) => call.slice(2)))
      .toEqual([[42, 0], [-1, 10]]);
    expect(new DataView(processMemory.buffer).getInt32(1024, true)).toBe(3 << 8);
  });

  it("completes every matching WNOWAIT waiter while leaving a running waiter blocked", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const first = createChannel(7, processMemory, 0);
    const second = createChannel(7, processMemory, 256);
    const running = createChannel(7, processMemory, 512);
    const waitChildPoll = vi.fn((
      _parentPid: number,
      targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number,
    ) => {
      if (targetPid === 43) return 0;
      writeKernelWaitResult(kernelMemory, resultPtr, {
        waitStatus: 0,
        siCode: WAIT_CLD_EXITED,
        siStatus: 0,
        childUid: 99,
        rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
      });
      return 42;
    });
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[7, {
      channels: [first, second, running],
      memory: processMemory,
    }]]);
    worker.completeWaitid = vi.fn();
    const options = WAIT_WEXITED | WAIT_WNOWAIT;
    const makeWaiter = (channel: any, pid: number, siginfoPtr: number) => ({
      parentPid: 7,
      channel,
      origArgs: [1, pid, siginfoPtr, options, 0],
      pid,
      options,
      syscallNr: ABI_SYSCALLS.Waitid,
    });
    const runningWaiter = makeWaiter(running, 43, 1536);
    worker.waitingForChild = [
      makeWaiter(first, 42, 1024),
      runningWaiter,
      makeWaiter(second, 42, 1280),
    ];

    worker.wakeWaitingParent(7);

    expect(worker.waitingForChild).toEqual([runningWaiter]);
    expect(worker.completeWaitid).toHaveBeenCalledTimes(2);
    expect(waitChildPoll.mock.calls.filter((call: unknown[]) => call[1] === 42))
      .toEqual([
        [7, 42, WAIT_EVENT_EXITED, WAIT_WNOWAIT, 128],
        [7, 42, WAIT_EVENT_EXITED, WAIT_WNOWAIT, 128],
      ]);
    expect(new DataView(processMemory.buffer).getInt32(1024 + 12, true)).toBe(42);
    expect(new DataView(processMemory.buffer).getInt32(1280 + 12, true)).toBe(42);
  });

  it("interrupts the exact host-deferred wait thread with its caught signal", () => {
    const kernelMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const processMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const channel = createChannel(7, processMemory);
    const dequeue = vi.fn((_pid: number, outPtr: number) => {
      const view = new DataView(kernelMemory.buffer);
      view.setUint32(outPtr, SIGUSR1, true);
      view.setUint32(outPtr + 8, SA_RESTART, true);
      return SIGUSR1;
    });
    const worker = createWorkerHarness({
      kernel_pick_signal_target_tid: vi.fn(() => 7),
      kernel_dequeue_signal: dequeue,
    });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [-1, 0, 0, 0],
      pid: -1,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    worker.wakeWaitingParent = vi.fn();
    worker.finishSignalTermination = vi.fn(() => false);
    worker.completeChannel = vi.fn();

    expect(worker.interruptWaitingChildForSignal(7, SIGUSR1)).toBe(true);

    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Wait4,
      [-1, 0, 0, 0],
      undefined,
      -1,
      4,
    );
    const signalView = new DataView(processMemory.buffer);
    expect(signalView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
    expect(signalView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);
  });

  it("removes and wakes an exact wait cancellation point", () => {
    const memory = createSharedMemory();
    const caller = createChannel(7, memory, 0);
    const target = createChannel(7, memory, 256);
    const worker = createWorkerHarness({});
    worker.processes = new Map([[7, {
      channels: [caller, target],
      memory,
    }]]);
    worker.channelTids = new Map([["7:256", 99]]);
    worker.pendingCancels = new Set();
    worker.pendingFutexWaits = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.waitingForChild = [{
      parentPid: 7,
      channel: target,
      origArgs: [-1, 0, 0, 0],
      pid: -1,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    worker.runSyntheticMemorySyscall = vi.fn(() => ({ retVal: 0, errVal: 0 }));
    worker.completeChannelRaw = vi.fn();
    worker.relistenChannel = vi.fn();

    worker.handleThreadCancel(caller, [99]);

    expect(worker.runSyntheticMemorySyscall).toHaveBeenCalledWith(
      caller,
      ABI_SYSCALLS.ThreadCancel,
      [99],
    );
    expect(worker.waitingForChild).toEqual([]);
    expect(worker.pendingCancels.has(target)).toBe(true);
    expect(worker.completeChannelRaw).toHaveBeenNthCalledWith(1, caller, 0, 0);
    expect(worker.completeChannelRaw).toHaveBeenNthCalledWith(
      2,
      target,
      -4,
      4,
    );
    expect(worker.relistenChannel).toHaveBeenCalledWith(target);
  });

  it("retires an interrupted engine futex waiter before a later wake quota", async () => {
    const memory = createSharedMemory();
    const first = createChannel(7, memory, 0);
    const second = createChannel(7, memory, 256);
    const waker = createChannel(7, memory, 512);
    const futexPtr = 4096;
    new Int32Array(memory.buffer)[futexPtr >>> 2] = 0;
    const worker = createWorkerHarness({});
    worker.processes = new Map([[7, {
      channels: [first, second, waker],
      memory,
    }]]);
    worker.pendingFutexWaits = new Map();
    worker.completeChannelRaw = vi.fn();
    worker.relistenChannel = vi.fn();

    worker.handleFutex(first, [futexPtr, 0, 0, 0, 0, 0]);
    worker.handleFutex(second, [futexPtr, 0, 0, 0, 0, 0]);
    expect(worker.pendingFutexWaits.size).toBe(2);

    worker.pendingFutexWaits.get(first).interrupt(-4, 4);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(worker.pendingFutexWaits.size).toBe(0);
    expect(worker.completeChannelRaw).toHaveBeenCalledWith(first, -4, 4);
    expect(worker.completeChannelRaw).toHaveBeenCalledWith(second, 0, 0);

    worker.completeChannelRaw.mockClear();
    worker.handleFutex(second, [futexPtr, 0, 0, 0, 0, 0]);
    expect(worker.pendingFutexWaits.size).toBe(1);
    worker.handleFutex(waker, [futexPtr, 1, 1, 0, 0, 0]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(worker.completeChannelRaw).toHaveBeenCalledWith(waker, 1, 0);
    expect(worker.completeChannelRaw).toHaveBeenCalledWith(second, 0, 0);
    expect(worker.pendingFutexWaits.size).toBe(0);
  });

  it("retires futex and cancel state with an exact thread channel", () => {
    const memory = createSharedMemory();
    const channel = createChannel(7, memory, 256);
    const retire = vi.fn();
    const worker = createWorkerHarness({});
    worker.processes = new Map([[7, { channels: [channel], memory }]]);
    worker.activeChannels = [channel];
    worker.stoppedPids = new Set();
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.resumePreparedSignals = new WeakSet();
    worker.pendingCancels = new Set([channel]);
    worker.waitingForChild = [];
    worker.pendingSleeps = new Map();
    worker.pendingFutexWaits = new Map([[channel, {
      futexIndex: 1024,
      retire,
    }]]);
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.socketTimeoutTimers = new Map();
    worker.channelTids = new Map([["7:256", 99]]);
    worker.threadForkContexts = new Map([["7:256", { fnPtr: 1, argPtr: 2 }]]);

    worker.removeChannel(7, 256);

    expect(retire).toHaveBeenCalledOnce();
    expect(worker.pendingFutexWaits.size).toBe(0);
    expect(worker.pendingCancels.size).toBe(0);
    expect(worker.processes.get(7).channels).toEqual([]);
    expect(worker.activeChannels).toEqual([]);
    expect(worker.channelTids.has("7:256")).toBe(false);
    expect(worker.threadForkContexts.has("7:256")).toBe(false);
  });

  it("parks exact mailbox notifications while materializing completed output", () => {
    const memory = createSharedMemory();
    const first = createChannel(42, memory, 0);
    const second = createChannel(42, memory, 256);
    markPending(first);
    markPending(second);
    const worker = createWorkerHarness({});
    worker.processes = new Map([[42, { channels: [first, second], memory }]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.synchronizeSharedMemoryForBoundary = vi.fn();
    worker.relistenChannel = vi.fn();

    worker.publishOrParkChannelCompletion(first, {
      kind: "marshalled",
      outputWrites: [{ ptr: 2048, bytes: Uint8Array.of(1, 2, 3) }],
      retVal: 7,
      errVal: 0,
      relistenRequested: true,
    });
    worker.publishOrParkChannelCompletion(second, {
      kind: "raw",
      outputWrites: [],
      retVal: 8,
      errVal: 0,
      relistenRequested: false,
    });

    expect(worker.parkedChannelCompletions.size).toBe(2);
    expect(readStatus(first)).toBe(CHANNEL_STATUS_PENDING);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_PENDING);
    // A peer mapping the same SharedArrayBuffer observes completed syscall
    // output even though this stopped process remains parked at CH_PENDING.
    expect(new Uint8Array(memory.buffer, 2048, 3))
      .toEqual(Uint8Array.of(1, 2, 3));
    expect(worker.synchronizeSharedMemoryForBoundary).toHaveBeenCalledTimes(2);

    worker.resumeStoppedProcess(42);

    expect(worker.parkedChannelCompletions.size).toBe(0);
    expect(readStatus(first)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(new DataView(memory.buffer, first.channelOffset).getBigInt64(CH_RETURN, true)).toBe(7n);
    expect(new DataView(memory.buffer, second.channelOffset).getBigInt64(CH_RETURN, true)).toBe(8n);
    expect(new Uint8Array(memory.buffer, 2048, 3)).toEqual(Uint8Array.of(1, 2, 3));
    expect(worker.relistenChannel).toHaveBeenCalledOnce();
    expect(worker.relistenChannel).toHaveBeenCalledWith(first);
  });

  it("delivers a caught SIGCONT before publishing the parked stop boundary", () => {
    const kernelMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const processMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const channel = createChannel(42, processMemory);
    const dequeue = vi.fn((_pid: number, outPtr: number) => {
      new DataView(kernelMemory.buffer).setUint32(outPtr, SIGCONT, true);
      return SIGCONT;
    });
    const worker = createWorkerHarness({
      kernel_dequeue_signal: dequeue,
      kernel_get_process_exit_signal: vi.fn(() => -1),
    });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[42, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.channelTids = new Map();
    worker.hostReaped = new Set();
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map([[channel, {
      prepared: {
        kind: "raw",
        outputWrites: [],
        retVal: 0,
        errVal: 0,
        relistenRequested: false,
      },
      relistenRequested: false,
    }]]);
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    worker.publishPreparedChannelCompletion = vi.fn();

    worker.resumeStoppedProcess(42);

    expect(dequeue).toHaveBeenCalledOnce();
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGCONT);
    expect(worker.publishPreparedChannelCompletion).toHaveBeenCalledOnce();
  });

  it("preflights every pthread before starting or publishing after SIGCONT", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const first = createChannel(42, processMemory, 0);
    const second = createChannel(42, processMemory, 256);
    markPending(first);
    markPending(second);

    let state = PROCESS_STATE_STOPPED;
    let currentTid = 0;
    let secondScans = 0;
    const dequeue = vi.fn((_pid: number, outPtr: number) => {
      if (currentTid === 101) {
        new DataView(kernelMemory.buffer).setUint32(outPtr, SIGCONT, true);
        return SIGCONT;
      }
      secondScans++;
      if (secondScans === 1) state = PROCESS_STATE_STOPPED;
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_get_process_state: vi.fn(() => state),
      kernel_set_current_tid: vi.fn((tid: number) => { currentTid = tid; }),
      kernel_dequeue_signal: dequeue,
      kernel_get_process_exit_signal: vi.fn(() => -1),
    });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[42, {
      channels: [first, second],
      memory: processMemory,
    }]]);
    worker.channelTids = new Map([
      ["42:0", 101],
      ["42:256", 102],
    ]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map([
      [first, parkedRaw(1)],
      [second, parkedRaw(2)],
    ]);
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    worker.pendingSleeps = new Map();
    worker.pendingFutexWaits = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    const start = vi.fn();
    const cancel = vi.fn();
    const publish = vi.fn();
    worker.publishPreparedChannelCompletion = publish;

    expect(worker.startProcessWorkerWhenRunnable(
      42,
      processMemory,
      start,
      cancel,
    )).toBe("deferred");

    state = PROCESS_STATE_RUNNING;
    expect(worker.resumeStoppedProcess(42)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(worker.parkedChannelCompletions.size).toBe(2);
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGCONT);

    state = PROCESS_STATE_RUNNING;
    expect(worker.resumeStoppedProcess(42)).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(dequeue).toHaveBeenCalledTimes(3);
    // The first channel's caught signal was not dequeued/cleared again on the
    // second resume attempt.
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGCONT);
  });

  it("interrupts a stopped exact wait thread with its retained caught signal", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    markPending(channel);
    let state = PROCESS_STATE_STOPPED;
    const dequeue = vi.fn((_pid: number, outPtr: number) => {
      new DataView(kernelMemory.buffer).setUint32(outPtr, SIGUSR1, true);
      return SIGUSR1;
    });
    const worker = createWorkerHarness({
      kernel_get_process_state: vi.fn(() => state),
      kernel_dequeue_signal: dequeue,
      kernel_get_process_exit_signal: vi.fn(() => -1),
    });
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [-1, 0, 0, 0],
      pid: -1,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    worker.stoppedPids = new Set([7]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    worker.pendingSleeps = new Map();
    worker.pendingFutexWaits = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.socketTimeoutTimers = new Map();
    worker.drainAllPtyOutputs = vi.fn();
    worker.flushTcpSendPipes = vi.fn();
    worker.drainAndProcessWakeupEvents = vi.fn();
    worker.synchronizeSharedMemoryForBoundary = vi.fn();
    worker.relistenChannel = vi.fn();
    const sequence: string[] = [];
    const start = vi.fn(() => sequence.push("start"));
    const cancel = vi.fn();
    worker.publishPreparedChannelCompletion = vi.fn((_channel: unknown, prepared: {
      retVal: number;
      errVal: number;
    }) => {
      sequence.push("publish");
      expect(prepared.retVal).toBe(-1);
      expect(prepared.errVal).toBe(4);
    });

    expect(worker.startProcessWorkerWhenRunnable(
      7,
      processMemory,
      start,
      cancel,
    )).toBe("deferred");
    state = PROCESS_STATE_RUNNING;
    expect(worker.resumeStoppedProcess(7)).toBe(true);

    expect(worker.waitingForChild).toEqual([]);
    expect(dequeue).toHaveBeenCalledOnce();
    expect(sequence).toEqual(["start", "publish"]);
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGUSR1);
  });

  it("materializes stopped descriptor output before wake scratch is reused", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(42, processMemory);
    const outputPtr = 2048;
    markPending(channel);
    new Uint8Array(kernelMemory.buffer, 128 + CH_DATA, 4).set([9, 8, 7, 6]);
    const worker = createWorkerHarness({});
    worker.kernelMemory = kernelMemory;
    worker.processes = new Map([[42, { channels: [channel], memory: processMemory }]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.clearSocketTimeout = vi.fn();
    worker.clearReadinessWait = vi.fn();
    worker.drainAllPtyOutputs = vi.fn();
    worker.flushTcpSendPipes = vi.fn();
    const sequence: string[] = [];
    worker.synchronizeSharedMemoryForBoundary = vi.fn(() => {
      sequence.push("sync");
    });
    worker.relistenChannel = vi.fn();
    worker.drainAndProcessWakeupEvents = vi.fn(() => {
      sequence.push("drain");
      expect(new Uint8Array(processMemory.buffer, outputPtr, 4))
        .toEqual(Uint8Array.of(9, 8, 7, 6));
      new Uint8Array(kernelMemory.buffer, 128 + CH_DATA, 4).fill(0xee);
    });

    worker.completeChannel(
      channel,
      ABI_SYSCALLS.Read,
      [0, outputPtr, 4],
      [{
        argIndex: 1,
        direction: "out",
        size: { type: "arg", argIndex: 2 },
      }],
      4,
      0,
    );

    expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
    expect(new Uint8Array(processMemory.buffer, outputPtr, 4))
      .toEqual(Uint8Array.of(9, 8, 7, 6));
    expect(worker.synchronizeSharedMemoryForBoundary).toHaveBeenCalledOnce();
    expect(sequence).toEqual(["sync", "drain"]);
    worker.resumeStoppedProcess(42);
    expect(new Uint8Array(processMemory.buffer, outputPtr, 4))
      .toEqual(Uint8Array.of(9, 8, 7, 6));
  });

  it("synchronizes raw completion before lifecycle wake observers", () => {
    const memory = createSharedMemory();
    const channel = createChannel(42, memory);
    markPending(channel);
    const worker = createWorkerHarness({});
    worker.processes = new Map([[42, { channels: [channel], memory }]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.pendingCancels = new Set();
    worker.clearSocketTimeout = vi.fn();
    worker.clearReadinessWait = vi.fn();
    const sequence: string[] = [];
    worker.synchronizeSharedMemoryForBoundary = vi.fn(() => {
      sequence.push("sync");
    });
    worker.drainAndProcessWakeupEvents = vi.fn(() => {
      sequence.push("drain");
    });

    worker.completeChannelRaw(channel, 0, 0);

    expect(sequence).toEqual(["sync", "drain"]);
    expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
    expect(worker.parkedChannelCompletions.has(channel)).toBe(true);
  });

  it("defers an exact retry while stopped and re-arms it on continuation", () => {
    const channel = createChannel(42, createSharedMemory());
    const worker = createWorkerHarness({});
    worker.processes = new Map([[42, { channels: [channel], memory: channel.memory }]]);
    worker.stoppedPids = new Set([42]);
    worker.deferredStoppedChannels = new Map();
    worker.parkedChannelCompletions = new Map();
    const retrySyscall = worker.retrySyscall.bind(worker);
    worker.handleSyscall = vi.fn();
    worker.relistenChannel = vi.fn();

    retrySyscall(channel);

    expect(worker.handleSyscall).not.toHaveBeenCalled();
    expect(worker.deferredStoppedChannels.has(channel)).toBe(true);
    worker.resumeStoppedProcess(42);
    expect(worker.relistenChannel).toHaveBeenCalledWith(channel);
  });

  it("discards every parked and deferred channel without publication on signal death", () => {
    const memory = createSharedMemory();
    const first = createChannel(42, memory, 0);
    const second = createChannel(42, memory, 256);
    markPending(first);
    markPending(second);
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_get_process_exit_signal: vi.fn(() => 9),
    });
    worker.processes = new Map([[42, { channels: [first, second], memory }]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map([
      [first, {
        prepared: {
          kind: "raw",
          outputWrites: [],
          retVal: 1,
          errVal: 0,
          relistenRequested: false,
        },
        relistenRequested: false,
      }],
    ]);
    worker.deferredStoppedChannels = new Map([[second, true]]);
    worker.hostReaped = new Set();
    worker.releaseAllSharedMemoryForProcess = vi.fn();
    worker.notifyParentOfExitedProcess = vi.fn();
    worker.callbacks = { onExit };

    worker.handleProcessTerminated(first);

    expect(worker.stoppedPids.has(42)).toBe(false);
    expect(worker.parkedChannelCompletions.size).toBe(0);
    expect(worker.deferredStoppedChannels.size).toBe(0);
    expect(readStatus(first)).toBe(CHANNEL_STATUS_PENDING);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_PENDING);
    expect(onExit).toHaveBeenCalledWith(42, 137);
  });

  it("host-observed crashes are marked in Rust before parent notification", () => {
    const calls: string[] = [];
    const markProcessSignaled = vi.fn(() => {
      calls.push("mark");
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: markProcessSignaled,
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldwait: vi.fn(() => 0),
    });
    worker.hostReaped = new Set();
    worker.sharedMappings = new Map([[42, new Map()]]);
    worker.sendSignalToProcess = vi.fn(() => calls.push("signal"));

    worker.notifyHostProcessCrashed(42, 11);

    expect(markProcessSignaled).toHaveBeenCalledWith(42, 11);
    expect(worker.sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD);
    expect(calls).toEqual(["mark", "signal"]);
    expect(worker.sharedMappings.has(42)).toBe(false);
  });

  it("marks a host crash reaped before shared-state teardown can re-enter", () => {
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: vi.fn(() => 0),
    });
    worker.hostReaped = new Set();
    worker.releaseAllSharedMemoryForProcess = vi.fn(() => {
      expect(worker.hostReaped.has(42)).toBe(true);
    });
    worker.notifyParentOfExitedProcess = vi.fn();

    worker.notifyHostProcessCrashed(42, 11);

    expect(worker.releaseAllSharedMemoryForProcess).toHaveBeenCalledWith(42);
    expect(worker.notifyParentOfExitedProcess).toHaveBeenCalledOnce();
  });

  it("does not overwrite signal death discovered during clean-exit writeback", () => {
    let exitSignal = 0;
    const kernelHandle = vi.fn();
    const worker = createWorkerHarness({
      kernel_get_process_exit_signal: vi.fn(() => exitSignal),
      kernel_handle_channel: kernelHandle,
    });
    const channel = createChannel(42, createSharedMemory());
    worker.processes = new Map([[42, { channels: [channel] }]]);
    worker.hostReaped = new Set();
    worker.releaseAllSharedMemoryForProcess = vi.fn(() => {
      exitSignal = SIGTERM;
    });
    worker.handleProcessTerminated = vi.fn();

    worker.handleExit(channel, ABI_SYSCALLS.ExitGroup, [0]);

    expect(worker.handleProcessTerminated).toHaveBeenCalledWith(channel);
    expect(kernelHandle).not.toHaveBeenCalled();
  });

  it("uses the explicit termination signal instead of classifying high exit codes", () => {
    const exitSignals = new Map([[42, 0], [43, 15]]);
    const worker = createWorkerHarness({
      kernel_get_process_exit_signal: vi.fn((pid: number) => exitSignals.get(pid) ?? -1),
    });
    const normalChannel = createChannel(42, createSharedMemory());
    const signaledChannel = createChannel(43, createSharedMemory());
    worker.processes = new Map([
      [42, { channels: [normalChannel] }],
      [43, { channels: [signaledChannel] }],
    ]);
    worker.pendingSleeps = new Map();
    worker.hostReaped = new Set();
    worker.handleProcessTerminated = vi.fn();

    worker.reapKilledProcessesAfterSyscall();

    expect(worker.handleProcessTerminated).toHaveBeenCalledOnce();
    expect(worker.handleProcessTerminated).toHaveBeenCalledWith(signaledChannel);
  });

  it("SA_NOCLDWAIT auto-reaps through Rust without SIGCHLD", () => {
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: vi.fn(() => 0),
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldwait: vi.fn(() => 1),
      kernel_reap_exited_child: reapExitedChild,
    });
    worker.hostReaped = new Set();
    worker.sharedMappings = new Map();
    worker.sendSignalToProcess = vi.fn();
    worker.wakeWaitingParent = vi.fn();

    worker.notifyHostProcessCrashed(42, 11);

    expect(reapExitedChild).toHaveBeenCalledWith(7, 42);
    expect(worker.sendSignalToProcess).not.toHaveBeenCalled();
    expect(worker.wakeWaitingParent).toHaveBeenCalledWith(7);
  });
});

function createWorkerHarness(exports: Record<string, unknown>, kernelPtrWidth: 4 | 8 = 4): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: {
      toKernelPtr(value: number | bigint): number | bigint {
        const numberValue = typeof value === "bigint" ? Number(value) : value;
        return kernelPtrWidth === 8 ? BigInt(numberValue) : numberValue;
      },
    },
    kernelInstance: {
      exports: {
        kernel_get_process_exit_signal: vi.fn(() => -1),
        kernel_get_process_state: vi.fn(() => PROCESS_STATE_RUNNING),
        ...exports,
      },
    },
    kernelMemory: createSharedMemory(),
    scratchOffset: 128,
    processes: new Map(),
    channelTids: new Map(),
    pendingCancels: new Set(),
    deferredProcessWorkerStarts: new Map(),
  });
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}

function createChannel(pid: number, memory: WebAssembly.Memory, channelOffset = 0): any {
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer, channelOffset),
    consecutiveSyscalls: 0,
  };
}

function writeKernelWaitResult(
  memory: WebAssembly.Memory,
  ptr: number,
  result: {
    waitStatus: number;
    siCode: number;
    siStatus: number;
    childUid: number;
    rusage: Uint8Array;
  },
): void {
  const view = new DataView(memory.buffer);
  view.setInt32(ptr + KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET, result.waitStatus, true);
  view.setInt32(ptr + KERNEL_WAIT_RESULT_SI_CODE_OFFSET, result.siCode, true);
  view.setInt32(ptr + KERNEL_WAIT_RESULT_SI_STATUS_OFFSET, result.siStatus, true);
  view.setUint32(ptr + KERNEL_WAIT_RESULT_CHILD_UID_OFFSET, result.childUid, true);
  new Uint8Array(memory.buffer, ptr + KERNEL_WAIT_RESULT_RUSAGE_OFFSET, result.rusage.length)
    .set(result.rusage);
}

function writeWakeEvent(
  memory: WebAssembly.Memory,
  ptr: number,
  index: number,
  wakeIdx: number,
  wakeType: number,
): void {
  const offset = ptr + index * 5;
  const view = new DataView(memory.buffer);
  view.setUint32(offset, wakeIdx, true);
  view.setUint8(offset + 4, wakeType);
}

function markPending(channel: any): void {
  Atomics.store(
    new Int32Array(channel.memory.buffer, channel.channelOffset),
    CH_STATUS / 4,
    CHANNEL_STATUS_PENDING,
  );
}

function parkedRaw(retVal: number): any {
  return {
    prepared: {
      kind: "raw",
      outputWrites: [],
      retVal,
      errVal: 0,
      relistenRequested: false,
    },
    relistenRequested: false,
  };
}

function readStatus(channel: any): number {
  return Atomics.load(
    new Int32Array(channel.memory.buffer, channel.channelOffset),
    CH_STATUS / 4,
  );
}
