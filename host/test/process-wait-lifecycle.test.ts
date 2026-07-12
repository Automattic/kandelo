import { describe, expect, it, vi } from "vitest";
import { ABI_SYSCALLS } from "../src/generated/abi";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const SIGCHLD = 17;
const SIGTERM = 15;
const WNOHANG = 1;

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
    expect(worker.wakeWaitingParent).not.toHaveBeenCalled();
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
        ...exports,
      },
    },
    kernelMemory: createSharedMemory(),
    scratchOffset: 128,
  });
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
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
