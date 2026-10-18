import { describe, expect, it, vi } from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
  type DispatchOrderTap,
} from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";

const EAGAIN = 11;

type Turn = { pid: number; tid: number; retry?: true };

describe("CentralizedKernelWorker dispatch order under a replay", () => {
  function replayTap(
    turns: Turn[],
    deliver: (turn: Turn) => boolean = () => false,
  ): DispatchOrderTap {
    return {
      mode: "replay",
      next: () => turns[0] ?? "wait",
      nextIsRetry: (pid, tid) => {
        const turn = turns.find((t) => t.pid === pid && t.tid === tid);
        return turn === undefined ? null : turn.retry === true;
      },
      holdsEntry: () => true,
      ranAhead: () => {},
      abandon: () => {},
      take: () => deliver(turns.shift()!),
      arrival: () => new Promise(() => {}),
    };
  }

  function makeWorker(
    kernelMemory: WebAssembly.Memory,
    kernelExports: Readonly<Record<string, unknown>>,
  ) {
    const worker = createCentralizedKernelWorkerTestDouble({
      config: { maxWorkers: 1, dataBufferSize: 65_536, useSharedMemory: true },
      io: new NodePlatformIO(),
    });
    const implementations = {
      kernel_blocking_retry_release: () => 0,
      kernel_blocking_retry_token: () => 1n,
      kernel_dequeue_signal: () => 0,
      kernel_get_process_exit_signal: () => -1,
      kernel_get_socket_timeout_ms: () => -1n,
      kernel_is_fd_nonblock: () => 0,
      kernel_set_current_tid: () => 0,
      ...kernelExports,
    };
    installKernelWorkerTestScratch(worker, kernelMemory, 128, 4, {
      kernelExports: implementations,
      kernelExportNames: Object.keys(implementations),
    });
    worker.testAuthority.configureScratchBoundaryHooksForTest({
      completeChannel: vi.fn(),
      completeChannelRaw: vi.fn(),
      handleBlockingRetry: vi.fn(),
      relistenChannel: vi.fn(),
      synchronizeSharedMemoryForBoundary: vi.fn(),
    });
    return worker;
  }

  function pendingGetpid(worker: ReturnType<typeof makeWorker>) {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const [channel] =
      worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
        pid: 7,
        memory,
        channelOffsets: [0],
        pointerWidth: 4,
      });
    const view = new DataView(memory.buffer);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getpid, true);
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    return channel!;
  }

  it("serves a retry the primary did not need without the next syscall's turn", () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 2 });
    const handleChannel = vi.fn((pointer: number) => {
      const view = new DataView(kernelMemory.buffer, pointer);
      view.setBigInt64(CH_RETURN, -1n, true);
      view.setUint32(CH_ERRNO, EAGAIN, true);
      return 0;
    });
    const worker = makeWorker(kernelMemory, { kernel_handle_channel: handleChannel });
    const turns: Turn[] = [{ pid: 7, tid: 7 }, { pid: 7, tid: 7 }];
    worker.setDispatchOrderTap(replayTap(turns));
    const channel = pendingGetpid(worker);

    worker.handleSyscall(channel);
    expect(turns).toHaveLength(1);
    // The kernel answered EAGAIN, so this dispatch is the syscall's retry.
    // The primary's syscall finished in one try, and the turn left is its
    // next syscall's.
    worker.handleSyscall(channel);

    expect(handleChannel).toHaveBeenCalledTimes(2);
    expect(turns).toEqual([{ pid: 7, tid: 7 }]);
  });

  it("serves a dispatch after the keystroke its turn delivered", async () => {
    const served: string[] = [];
    const worker = makeWorker(new WebAssembly.Memory({ initial: 2 }), {
      kernel_handle_channel: () => {
        served.push("getpid");
        return 0;
      },
      kernel_input_event: () => {
        served.push("keystroke");
      },
    });
    // The primary injected the keystroke between two kernel entries, so its
    // guest read it in the syscall after.
    worker.setDispatchOrderTap(replayTap([{ pid: 7, tid: 7 }], () => {
      worker.injectInputEventBatch([{ device: 0, ev_type: 1, code: 37, value: 1 }]);
      return true;
    }));

    worker.handleSyscall(pendingGetpid(worker));

    await vi.waitFor(() => expect(served).toHaveLength(2));
    expect(served).toEqual(["keystroke", "getpid"]);
  });

  it("serves a dispatch after the keystroke a passed-over retry delivered", async () => {
    const served: string[] = [];
    const worker = makeWorker(new WebAssembly.Memory({ initial: 2 }), {
      kernel_handle_channel: () => {
        served.push("getpid");
        return 0;
      },
      kernel_input_event: () => {
        served.push("keystroke");
      },
    });
    const turns: Turn[] = [{ pid: 7, tid: 7 }];
    worker.setDispatchOrderTap(replayTap(turns, (turn) => {
      if (turn.retry !== true) return false;
      worker.injectInputEventBatch([{ device: 0, ev_type: 1, code: 37, value: 1 }]);
      return true;
    }));
    const channel = pendingGetpid(worker);

    worker.handleSyscall(channel);
    await vi.waitFor(() => expect(served).toHaveLength(1));
    // The log grows: the primary's first getpid needed a retry this replica
    // did not, and the keystroke landed before that retry.
    turns.push({ pid: 7, tid: 7, retry: true }, { pid: 7, tid: 7 });
    new DataView(channel.memory.buffer).setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    worker.handleSyscall(channel);

    await vi.waitFor(() => expect(served).toHaveLength(3));
    expect(served).toEqual(["getpid", "keystroke", "getpid"]);
    expect(turns).toEqual([]);
  });
});
