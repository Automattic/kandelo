import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
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
  PROCESS_STATE_RUNNING,
} from "../src/generated/abi";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

// A blocking fcntl(F_SETLKW)/flock() is a kernel park re-executed by Rust
// when advisory-lock state changes (crates/runtime-core/src/wait_retry.rs);
// its scheduling is covered by the wait_retry/wait_park unit tests and
// examples/lock-kernel-wait.c (host/test/lock-kernel-wait.test.ts). What is
// left here is the host's advisory-lock test ingress, which must reject while
// a kernel entry is busy instead of queueing the operation for later.
describe("advisory-lock test ingress", () => {
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

type TestWorker = ReturnType<typeof createCentralizedKernelWorkerTestDouble>;

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

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
