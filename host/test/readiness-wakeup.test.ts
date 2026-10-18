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
  pendingSelectRetries: Map<TestChannel, PendingPollRetry>;
  wakeScheduled: boolean;
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
  ptyReadinessChanged = false,
): {
  channels: TestChannel[];
  retrySyscall: ReturnType<typeof vi.fn>;
  takePtyReadiness: ReturnType<typeof vi.fn>;
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
  const takePtyReadiness = vi.fn(() => Number(ptyReadinessChanged));
  installKernelWorkerTestScratch(worker, kernelMemory, 128, 4, {
    kernelExports: {
      kernel_drain_wakeup_events: drainWakeupEvents,
      kernel_take_pty_readiness_changed: takePtyReadiness,
      kernel_pty_master_write: (_idx: number, _pointer: number, length: number) => length,
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
    takePtyReadiness,
    scheduleWakeBlockedRetries,
    state: mutableState(worker),
    worker,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readiness wakeup targeting", () => {
  it("retains coalesced PTY readiness until a retry queue has a waiter", () => {
    const harness = createWakeHarness(0, 0, [11], true);
    harness.worker.testAuthority.drainWakeupEventsForTest();
    expect(harness.takePtyReadiness).not.toHaveBeenCalled();
    const [channel] = harness.channels;
    harness.state.pendingPollRetries.set(channel!, {
      timer: null, channel: channel!, pipeIndices: [],
    });

    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(harness.takePtyReadiness).toHaveBeenCalledOnce();
    expect(harness.retrySyscall).toHaveBeenCalledWith(channel);
  });
  it("retries guest PTYs without a pipe event or output callback", () => {
    const harness = createWakeHarness(0, 0, [11], true);
    const [channel] = harness.channels;
    harness.state.pendingPollRetries.set(channel!, {
      timer: null,
      channel: channel!,
      pipeIndices: [],
    });

    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(harness.retrySyscall).toHaveBeenCalledWith(channel);
  });

  it("does not park PTY input behind an already scheduled broad wake", () => {
    const harness = createWakeHarness(0, 0, [11], true);
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      retrySyscall: harness.retrySyscall,
    });
    const [channel] = harness.channels;
    harness.state.wakeScheduled = true;
    harness.state.pendingPollRetries.set(channel!, {
      timer: null, channel: channel!, pipeIndices: [],
    });

    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(harness.retrySyscall).toHaveBeenCalledOnce();
    expect(harness.retrySyscall).toHaveBeenCalledWith(channel);
    expect(harness.state.pendingPollRetries.has(channel!)).toBe(false);
  });

  it("wakes host keyboard input without an observer despite a scheduled broad wake", () => {
    const harness = createWakeHarness(0, 0, [11]);
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      retrySyscall: harness.retrySyscall,
    });
    const [channel] = harness.channels;
    harness.state.wakeScheduled = true;
    harness.state.pendingPollRetries.set(channel!, {
      timer: null, channel: channel!, pipeIndices: [],
    });

    harness.worker.ptyMasterWrite(3, new Uint8Array([0x61]));

    expect(harness.retrySyscall).toHaveBeenCalledOnce();
    expect(harness.retrySyscall).toHaveBeenCalledWith(channel);
    expect(harness.state.pendingPollRetries.has(channel!)).toBe(false);
  });

  it.each([
    ["pendingPollRetries", "pendingPollRetries"],
    ["pendingPollRetries", "pendingSelectRetries"],
    ["pendingSelectRetries", "pendingPollRetries"],
    ["pendingSelectRetries", "pendingSelectRetries"],
  ] as const)("wakes ordinary PTY %s before masked %s's grace period", (terminalQueue, maskedQueue) => {
    vi.useFakeTimers();
    const harness = createWakeHarness(0, 0, [11, 12], true);
    const [terminal, masked] = harness.channels;
    harness.state[terminalQueue].set(terminal!, {
      timer: null, channel: terminal!, pipeIndices: [],
    });
    const maskedEntry: PendingPollRetry = {
      timer: null, channel: masked!, pipeIndices: [], needsSignalSafeWake: true,
    };
    harness.state[maskedQueue].set(masked!, maskedEntry);

    harness.worker.testAuthority.drainWakeupEventsForTest();

    expect(harness.retrySyscall).toHaveBeenCalledOnce();
    expect(harness.retrySyscall).toHaveBeenCalledWith(terminal);
    expect(harness.state[maskedQueue].get(masked!)).toBe(maskedEntry);
    expect(harness.scheduleWakeBlockedRetries).not.toHaveBeenCalled();
  });
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
