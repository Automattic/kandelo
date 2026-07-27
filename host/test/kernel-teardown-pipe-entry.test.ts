import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import {
  allocateKernelScratchRegion,
} from "../src/kernel-scratch";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SIG_HANDLER,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
} from "../src/generated/abi";
import {
  createKernelScratchTestInstance,
} from "./support/kernel-scratch-instance";

const PID = 41;
const PIPE_INDEX = 17;
const SCRATCH_OFFSET = 4096;

interface TestChannel {
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

interface EntryHarness {
  readonly worker: ReturnType<typeof createCentralizedKernelWorkerTestDouble>;
  readonly gate: KernelEntryGate;
  readonly gatedInstance: WebAssembly.Instance;
  readonly implementations: Record<string, unknown>;
  readonly channel: TestChannel;
  readonly channelView: DataView;
  readonly handleChannel: ReturnType<typeof vi.fn>;
  readonly completeChannel: ReturnType<typeof vi.fn>;
}

function makeHarness(): EntryHarness {
  const kernelMemory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const processMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
  const channel: TestChannel = {
    pid: PID,
    memory: processMemory,
    channelOffset: 0,
    i32View: new Int32Array(
      processMemory.buffer,
      0,
      CH_TOTAL_SIZE / Int32Array.BYTES_PER_ELEMENT,
    ),
    consecutiveSyscalls: 0,
    handling: true,
  };
  const channelView = new DataView(processMemory.buffer);
  channelView.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
  channelView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getpid, true);
  for (let index = 0; index < CH_ARGS_COUNT; index++) {
    channelView.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, 0n, true);
  }

  const kernelBytes = new Uint8Array(kernelMemory.buffer);
  const handleChannel = vi.fn((pointer: number | bigint) => {
    const view = new DataView(kernelMemory.buffer, Number(pointer));
    view.setBigInt64(CH_RETURN, BigInt(PID), true);
    view.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  const implementations: Record<string, unknown> = {
    kernel_dequeue_signal: () => 0,
    kernel_get_process_exit_signal: () => 0,
    kernel_get_process_exit_status: () => -1,
    kernel_handle_channel: handleChannel,
    kernel_inject_mouse_event: () => 0,
    kernel_set_current_tid: () => 0,
  };
  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    4,
    kernelMemory,
    () => implementations,
    () => SCRATCH_OFFSET,
  );
  const gatedInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const scratch = allocateKernelScratchRegion(
    kernelMemory,
    gatedInstance.exports.kernel_alloc_scratch as
      (capacity: number) => number,
    CH_TOTAL_SIZE,
    4,
    "teardown/pipe entry test scratch",
    gatedInstance,
  );
  const worker = createCentralizedKernelWorkerTestDouble();
  worker.testAuthority.initializeKernelForTest({
    instance: gatedInstance,
    gate,
    mainScratch: scratch,
    tcpScratch: scratch,
  });
  const completeChannel = vi.fn();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannel,
  });

  const state = worker as unknown as {
    processes: Map<number, {
      pid: number;
      memory: WebAssembly.Memory;
      channels: TestChannel[];
      ptrWidth: 4 | 8;
    }>;
    activeChannels: TestChannel[];
    pendingPipeReaders: Map<
      number,
      Array<{ channel: TestChannel; pid: number }>
    >;
    pendingPipeWriters: Map<
      number,
      Array<{ channel: TestChannel; pid: number }>
    >;
    pendingPollRetries: Map<
      TestChannel,
      {
        timer: null;
        channel: TestChannel;
        pipeIndices: number[];
        acceptIndices: number[];
      }
    >;
  };
  state.processes = new Map([[
    PID,
    {
      pid: PID,
      memory: processMemory,
      channels: [channel],
      ptrWidth: 4,
    },
  ]]);
  state.activeChannels = [channel];

  // Ensure the kernel scratch was not accidentally aliased to process state.
  expect(kernelBytes.buffer).not.toBe(processMemory.buffer);
  return {
    worker,
    gate,
    gatedInstance,
    implementations,
    channel,
    channelView,
    handleChannel,
    completeChannel,
  };
}

function mutableState(harness: EntryHarness) {
  return harness.worker as unknown as {
    pendingPipeReaders: Map<
      number,
      Array<{ channel: TestChannel; pid: number }>
    >;
    pendingPipeWriters: Map<
      number,
      Array<{ channel: TestChannel; pid: number }>
    >;
    pendingPollRetries: Map<
      TestChannel,
      {
        timer: null;
        channel: TestChannel;
        pipeIndices: number[];
        acceptIndices: number[];
      }
    >;
  };
}

describe("teardown and pipe notifications at the kernel entry gate", () => {
  it("defers teardown behind an active export and resolves after its wake publication", async () => {
    const harness = makeHarness();
    const getExitStatus = vi.fn(() => -1);
    harness.implementations.kernel_get_process_exit_status = getExitStatus;
    let teardown!: Promise<Set<number>>;

    harness.implementations.kernel_inject_mouse_event = () => {
      teardown = harness.worker.killAllBlockedForTeardown();
      expect(getExitStatus).not.toHaveBeenCalled();
      expect(harness.completeChannel).not.toHaveBeenCalled();
      expect(harness.channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(0);
      return 0;
    };
    const outer = harness.gatedInstance.exports.kernel_inject_mouse_event as
      (dx: number, dy: number, buttons: number) => number;

    expect(outer(0, 0, 0)).toBe(0);
    expect(getExitStatus).not.toHaveBeenCalled();
    const woken = await teardown;

    expect(getExitStatus).toHaveBeenCalledOnce();
    expect(getExitStatus).toHaveBeenCalledWith(PID);
    expect(woken).toEqual(new Set([PID]));
    expect(harness.channelView.getUint32(CH_SIG_SIGNUM, true)).toBe(9);
    expect(harness.channelView.getUint32(CH_SIG_HANDLER, true)).toBe(0);
    expect(harness.completeChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Getpid,
      [0, 0, 0, 0, 0, 0],
      undefined,
      -1,
      4,
    );
  });

  it("serializes interleaved readable and sequential writable retries", async () => {
    const harness = makeHarness();
    const state = mutableState(harness);
    state.pendingPipeReaders.set(PIPE_INDEX, [{
      channel: harness.channel,
      pid: PID,
    }]);
    state.pendingPollRetries.set(harness.channel, {
      timer: null,
      channel: harness.channel,
      pipeIndices: [PIPE_INDEX],
      acceptIndices: [],
    });

    harness.implementations.kernel_inject_mouse_event = () => {
      harness.worker.notifyPipeReadable(PIPE_INDEX);
      expect(state.pendingPipeReaders.has(PIPE_INDEX)).toBe(true);
      expect(state.pendingPollRetries.has(harness.channel)).toBe(true);
      expect(harness.handleChannel).not.toHaveBeenCalled();
      return 0;
    };
    const outer = harness.gatedInstance.exports.kernel_inject_mouse_event as
      (dx: number, dy: number, buttons: number) => number;

    expect(outer(0, 0, 0)).toBe(0);
    expect(harness.handleChannel).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(state.pendingPipeReaders.has(PIPE_INDEX)).toBe(false);
    expect(state.pendingPollRetries.has(harness.channel)).toBe(false);
    // The same mailbox appeared in both targeted collections. The gate's
    // exact-channel dedupe permits one retry, never two overlapping dispatches.
    expect(harness.handleChannel).toHaveBeenCalledOnce();

    harness.handleChannel.mockClear();
    harness.completeChannel.mockClear();
    state.pendingPipeWriters.set(PIPE_INDEX, [{
      channel: harness.channel,
      pid: PID,
    }]);
    harness.worker.notifyPipeWritable(PIPE_INDEX);
    expect(state.pendingPipeWriters.has(PIPE_INDEX)).toBe(false);
    expect(harness.handleChannel).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel).toHaveBeenCalledOnce();
  });
});
