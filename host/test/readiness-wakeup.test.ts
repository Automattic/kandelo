import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WAKEUP_EVENT_FIELDS,
  WAKEUP_EVENT_TYPES,
} from "../src/generated/abi";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

type TestWorker = ReturnType<typeof createCentralizedKernelWorkerTestDouble>;
type TestChannel = ReturnType<
  TestWorker["testAuthority"]["replaceProcessRegistrationForLifecycleTest"]
>[number];

interface PendingPollRetry {
  timer: ReturnType<typeof setTimeout> | null;
  channel: TestChannel;
  pipeIndices: number[];
  needsSignalSafeWake?: boolean;
  deadline?: number;
}

interface MutableWorkerState {
  pendingPollRetries: Map<TestChannel, PendingPollRetry>;
}

function mutableState(worker: TestWorker): MutableWorkerState {
  // Arrange existing inert retry state without exposing or replacing any
  // authority-bearing worker method.
  return worker as unknown as MutableWorkerState;
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}

function createWakeHarness(
  wakeIdx: number,
  wakeType: number,
  pids: readonly number[],
): {
  channels: TestChannel[];
  retrySyscall: ReturnType<typeof vi.fn>;
  scheduleWakeBlockedRetries: ReturnType<typeof vi.fn>;
  state: MutableWorkerState;
  worker: TestWorker;
} {
  const kernelMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
  });
  let drained = false;
  const drainWakeupEvents = vi.fn((outPointer: number | bigint): number => {
    if (drained) return 0;
    drained = true;
    const output = new DataView(kernelMemory.buffer);
    output.setUint32(
      Number(outPointer) + WAKEUP_EVENT_FIELDS.idx.offset,
      wakeIdx,
      true,
    );
    output.setUint8(
      Number(outPointer) + WAKEUP_EVENT_FIELDS.wakeType.offset,
      wakeType,
    );
    return 1;
  });
  const worker = createCentralizedKernelWorkerTestDouble();
  installKernelWorkerTestScratch(worker, kernelMemory, 128, 4, {
    kernelExports: {
      kernel_drain_wakeup_events: drainWakeupEvents,
    },
  });
  const channels = pids.map((pid) => {
    const [channel] =
      worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
        pid,
        memory: createSharedMemory(),
        channelOffsets: [0],
      });
    return channel!;
  });
  const retrySyscall = vi.fn();
  const scheduleWakeBlockedRetries = vi.fn();
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    retrySyscall,
    scheduleWakeBlockedRetries,
  });
  return {
    channels,
    retrySyscall,
    scheduleWakeBlockedRetries,
    state: mutableState(worker),
    worker,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readiness wakeup targeting", () => {
  it("retries only poll waiters that watch the kernel-woken pipe", () => {
    const harness = createWakeHarness(
      7,
      WAKEUP_EVENT_TYPES.readable,
      [11, 12],
    );
    const [matching, unrelated] = harness.channels;
    harness.state.pendingPollRetries.set(matching!, {
      timer: null,
      channel: matching!,
      pipeIndices: [7],
    });
    harness.state.pendingPollRetries.set(unrelated!, {
      timer: null,
      channel: unrelated!,
      pipeIndices: [9],
    });

    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(harness.retrySyscall).toHaveBeenCalledOnce();
    expect(harness.retrySyscall).toHaveBeenCalledWith(matching);
    expect(harness.state.pendingPollRetries.has(matching!)).toBe(false);
    expect(harness.state.pendingPollRetries.has(unrelated!)).toBe(true);
    expect(harness.scheduleWakeBlockedRetries).toHaveBeenCalledOnce();
  });

  it("keeps matching signal-safe ppoll deferred while retrying poll", () => {
    vi.useFakeTimers();
    const harness = createWakeHarness(
      7,
      WAKEUP_EVENT_TYPES.writable,
      [11, 12],
    );
    const [signalSafe, normal] = harness.channels;
    const signalSafeEntry: PendingPollRetry = {
      timer: null,
      channel: signalSafe!,
      pipeIndices: [7],
      needsSignalSafeWake: true,
    };
    harness.state.pendingPollRetries.set(signalSafe!, signalSafeEntry);
    harness.state.pendingPollRetries.set(normal!, {
      timer: null,
      channel: normal!,
      pipeIndices: [7],
    });

    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(harness.retrySyscall).toHaveBeenCalledOnce();
    expect(harness.retrySyscall).toHaveBeenCalledWith(normal);
    expect(harness.state.pendingPollRetries.get(signalSafe!))
      .toBe(signalSafeEntry);
    expect(harness.state.pendingPollRetries.has(normal!)).toBe(false);
    expect(signalSafeEntry.timer).not.toBeNull();
    expect(harness.scheduleWakeBlockedRetries).not.toHaveBeenCalled();
  });

  it("targets writable pollers before a host bridge broad wake", () => {
    const harness = createWakeHarness(0, 0, [11]);
    const [channel] = harness.channels;
    harness.state.pendingPollRetries.set(channel!, {
      timer: null,
      channel: channel!,
      pipeIndices: [7],
    });

    harness.worker.notifyPipeWritable(7);

    expect(harness.retrySyscall).toHaveBeenCalledOnce();
    expect(harness.retrySyscall).toHaveBeenCalledWith(channel);
    expect(harness.state.pendingPollRetries.has(channel!)).toBe(false);
    expect(harness.scheduleWakeBlockedRetries).toHaveBeenCalledOnce();
  });
});
