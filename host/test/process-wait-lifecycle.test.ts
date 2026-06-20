import { describe, expect, it, vi } from "vitest";
import { ABI_SYSCALLS } from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const SIGCHLD = 17;
const WNOHANG = 1;
const WUNTRACED = 2;
const SIGSTOP = 19;
const PROCESS_STATE_STOPPED = -2;

describe("Rust-owned process wait lifecycle", () => {
  it("wait4 consumes Rust-selected zombies and writes the Rust wait status", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const statusPtr = 256;
    const waitStatus = 5 << 8;
    const wait4Poll = vi.fn((_parentPid: number, _targetPid: number, statusPtr: number | bigint) => {
      new DataView(kernelMemory.buffer).setInt32(Number(statusPtr), waitStatus, true);
      return 42;
    });
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_wait4_poll: wait4Poll,
      kernel_reap_exited_child: reapExitedChild,
    });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = 128;
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, processMemory), [-1, statusPtr, 0, 0]);

    expect(wait4Poll).toHaveBeenCalledWith(7, -1, 128);
    expect(reapExitedChild).toHaveBeenCalledWith(7, 42);
    expect(new DataView(processMemory.buffer).getInt32(statusPtr, true)).toBe(waitStatus);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, statusPtr, 0, 0],
      42,
      0,
    );
  });

  it("wait4 leaves blocking waits in the host queue when Rust reports a running child", () => {
    const wait4Poll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait4_poll: wait4Poll });
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

  it("wait4 WNOHANG completes without queuing when Rust reports a running child", () => {
    const worker = createWorkerHarness({ kernel_wait4_poll: vi.fn(() => 0) });
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, createSharedMemory()), [-1, 0, WNOHANG, 0]);

    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, 0, WNOHANG, 0],
      0,
      0,
    );
  });

  it("wait4 reports stopped children for WUNTRACED without reaping and writes rusage", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const statusPtr = 256;
    const rusagePtr = 512;
    new Uint8Array(processMemory.buffer, rusagePtr, 144).fill(0xaa);
    const stoppedStatus = (SIGSTOP << 8) | 0x7f;
    const wait4PollWithOptions = vi.fn((
      _parentPid: number,
      _targetPid: number,
      _options: number,
      statusPtr: number | bigint,
    ) => {
      new DataView(kernelMemory.buffer).setInt32(Number(statusPtr), stoppedStatus, true);
      return 42;
    });
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_wait4_poll_with_options: wait4PollWithOptions,
      kernel_reap_exited_child: reapExitedChild,
    });
    worker.kernelMemory = kernelMemory;
    worker.scratchOffset = 128;
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, processMemory), [-1, statusPtr, WUNTRACED, rusagePtr]);

    expect(wait4PollWithOptions).toHaveBeenCalledWith(7, -1, WUNTRACED, 128);
    expect(reapExitedChild).not.toHaveBeenCalled();
    expect(new DataView(processMemory.buffer).getInt32(statusPtr, true)).toBe(stoppedStatus);
    expect(Array.from(new Uint8Array(processMemory.buffer, rusagePtr, 144))).toEqual(
      Array(144).fill(0),
    );
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, statusPtr, WUNTRACED, rusagePtr],
      42,
      0,
    );
  });

  it("wait4 passes a bigint status pointer for wasm64 kernels", () => {
    const wait4Poll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait4_poll: wait4Poll }, 8);
    worker.kernelMemory = createSharedMemory();
    worker.waitingForChild = [];
    worker.completeWaitpid = vi.fn();

    worker.handleWaitpid(createChannel(7, createSharedMemory()), [-1, 0, WNOHANG, 0]);

    expect(wait4Poll).toHaveBeenCalledWith(7, -1, BigInt(128));
    expect(worker.waitingForChild).toEqual([]);
    expect(worker.completeWaitpid).toHaveBeenCalledWith(
      expect.any(Object),
      [-1, 0, WNOHANG, 0],
      0,
      0,
    );
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
    worker.wakeWaitingParent = vi.fn(() => calls.push("wake"));

    worker.notifyHostProcessCrashed(42, 11);

    expect(markProcessSignaled).toHaveBeenCalledWith(42, 11);
    expect(worker.sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD);
    expect(worker.wakeWaitingParent).toHaveBeenCalledWith(7);
    expect(calls).toEqual(["mark", "signal", "wake"]);
    expect(worker.sharedMappings.has(42)).toBe(false);
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
    expect(worker.wakeWaitingParent).not.toHaveBeenCalled();
  });

  it("SIGCONT resumes a parked stopped syscall with its stored result", () => {
    const worker = createWorkerHarness({
      kernel_get_process_exit_status: vi.fn(() => -1),
      kernel_dequeue_signal: vi.fn(() => 0),
    });
    const channel = createChannel(42, createSharedMemory());
    worker.stoppedChannels = new Map([
      [42, {
        kind: "complete",
        channel,
        syscallNr: ABI_SYSCALLS.Kill,
        origArgs: [42, SIGSTOP, 0, 0, 0, 0],
        argDescs: undefined,
        retVal: 0,
        errVal: 0,
      }],
    ]);
    worker.completeChannel = vi.fn();

    worker.resumeStoppedProcess(42);

    expect(worker.stoppedChannels.has(42)).toBe(false);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Kill,
      [42, SIGSTOP, 0, 0, 0, 0],
      undefined,
      0,
      0,
    );
  });

  it("exit parks as a retry when pending SIGSTOP is delivered before exit", () => {
    const kernelHandleChannel = vi.fn();
    const worker = createWorkerHarness({
      kernel_deliver_pending_default_signals: vi.fn(() => -2),
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_handle_channel: kernelHandleChannel,
    });
    const channel = createChannel(42, createSharedMemory());
    worker.processes = new Map([[42, { channels: [channel] }]]);
    worker.sendSignalToProcess = vi.fn();
    worker.wakeWaitingParent = vi.fn();

    worker.handleExit(channel, ABI_SYSCALLS.ExitGroup, [42, 0, 0, 0, 0, 0]);

    expect(kernelHandleChannel).not.toHaveBeenCalled();
    expect(worker.stoppedChannels.get(42)).toEqual({ kind: "retry", channel });
    expect(channel.handling).toBe(true);
    expect(worker.sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD);
    expect(worker.wakeWaitingParent).toHaveBeenCalledWith(7);
  });

  it("SIGCONT resumes a retry-style stopped syscall by retrying it", () => {
    const worker = createWorkerHarness({
      kernel_get_process_exit_status: vi.fn(() => -1),
    });
    const channel = createChannel(42, createSharedMemory());
    worker.stoppedChannels = new Map([[42, { kind: "retry", channel }]]);
    worker.retrySyscall = vi.fn();

    worker.resumeStoppedProcess(42);

    expect(worker.stoppedChannels.has(42)).toBe(false);
    expect(worker.retrySyscall).toHaveBeenCalledWith(channel);
  });

  it("guest SIGCONT resumes parked children whose kernel state is running", () => {
    const worker = createWorkerHarness({
      kernel_get_process_exit_status: vi.fn((pid: number) =>
        pid === 42 ? -1 : PROCESS_STATE_STOPPED,
      ),
      kernel_dequeue_signal: vi.fn(() => 0),
    });
    const resumedChannel = createChannel(42, createSharedMemory());
    const stillStoppedChannel = createChannel(43, createSharedMemory());
    worker.stoppedChannels = new Map([
      [42, {
        kind: "complete",
        channel: resumedChannel,
        syscallNr: ABI_SYSCALLS.Kill,
        origArgs: [42, SIGSTOP, 0, 0, 0, 0],
        argDescs: undefined,
        retVal: 0,
        errVal: 0,
      }],
      [43, {
        kind: "complete",
        channel: stillStoppedChannel,
        syscallNr: ABI_SYSCALLS.Kill,
        origArgs: [43, SIGSTOP, 0, 0, 0, 0],
        argDescs: undefined,
        retVal: 0,
        errVal: 0,
      }],
    ]);
    worker.completeChannel = vi.fn();

    worker.resumeContinuedStoppedProcesses(0);

    expect(worker.stoppedChannels.has(42)).toBe(false);
    expect(worker.stoppedChannels.has(43)).toBe(true);
    expect(worker.completeChannel).toHaveBeenCalledTimes(1);
    expect(worker.completeChannel).toHaveBeenCalledWith(
      resumedChannel,
      ABI_SYSCALLS.Kill,
      [42, SIGSTOP, 0, 0, 0, 0],
      undefined,
      0,
      0,
    );
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
    kernelInstance: { exports },
    kernelMemory: createSharedMemory(),
    scratchOffset: 128,
    stoppedChannels: new Map(),
    channelTids: new Map(),
  });
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}

function createChannel(pid: number, memory: WebAssembly.Memory): any {
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer, 0),
    consecutiveSyscalls: 0,
  };
}
