import { describe, expect, it } from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  SYSCALL_ARGS,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

interface TestChannel {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

type CopybackHarnessWorker =
  ReturnType<typeof createCentralizedKernelWorkerTestDouble>;

interface MutableCopybackWorkerState {
  processes: Map<number, {
    pid: number;
    memory: WebAssembly.Memory;
    channels: TestChannel[];
    ptrWidth: 4 | 8;
    explicitMaxAddr: boolean;
  }>;
  activeChannels: TestChannel[];
  usePolling: boolean;
}

function createTestChannel(
  pid: number,
  memory: WebAssembly.Memory,
): TestChannel {
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer),
    consecutiveSyscalls: 0,
    handling: true,
  };
}

function makeCopybackHarness(ptrWidth: 4 | 8 = 4) {
  const pid = 100;
  const kernelMemory = new WebAssembly.Memory({ initial: 2 });
  const processMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
  const channel = createTestChannel(pid, processMemory);
  const worker = createCentralizedKernelWorkerTestDouble();
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    ptrWidth,
    { kernelExportNames: [] },
  );
  const state = worker as unknown as MutableCopybackWorkerState;
  state.processes = new Map([
    [
      pid,
      {
        pid,
        memory: processMemory,
        channels: [channel],
        ptrWidth,
        explicitMaxAddr: false,
      },
    ],
  ]);
  state.activeChannels = [channel];
  // Completion normally relistens the mailbox. Polling mode keeps this
  // focused harness synchronous without replacing a worker method.
  state.usePolling = true;
  Atomics.store(
    channel.i32View,
    CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    CHANNEL_STATUS_PENDING,
  );

  return {
    worker,
    channel,
    state,
    processMem: new Uint8Array(processMemory.buffer),
  };
}

describe("CentralizedKernelWorker syscall copy-back", () => {
  it("leaves the destination unchanged when read reports EOF", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const dest = 1024;
    const original = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);

    processMem.set(original, dest);
    worker.testAuthority.completeDetachedCopybackForTest({
      pid: channel.pid,
      registrationWitness: channel,
      operation: "read",
      fd: 0,
      destination: dest,
      requestedLength: original.length,
      returnValue: 0,
    });

    expect(processMem.slice(dest, dest + original.length)).toEqual(original);
    const channelView = new DataView(processMem.buffer);
    expect(channelView.getBigInt64(CH_RETURN, true)).toBe(0n);
    expect(channelView.getUint32(CH_ERRNO, true)).toBe(0);
    expect(Atomics.load(channel.i32View, CH_STATUS / 4)).toBe(
      CHANNEL_STATUS_COMPLETE,
    );
  });

  it("copies only the byte count reported by read", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const dest = 2048;
    const original = Uint8Array.from({ length: 8 }, (_, i) => 0xc0 + i);

    processMem.set(original, dest);
    worker.testAuthority.completeDetachedCopybackForTest({
      pid: channel.pid,
      registrationWitness: channel,
      operation: "read",
      fd: 0,
      destination: dest,
      requestedLength: original.length,
      returnValue: 3,
      outputBytes: Uint8Array.of(1, 2, 3),
    });

    expect(Array.from(processMem.slice(dest, dest + original.length))).toEqual([
      1,
      2,
      3,
      ...original.slice(3),
    ]);
  });

  it("rejects a stale registered-channel generation witness", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const destination = 3072;
    processMem.fill(0x7c, destination, destination + 4);

    expectEntryCause(
      () => worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid,
        registrationWitness: { ...channel },
        operation: "read",
        fd: 0,
        destination,
        requestedLength: 4,
        returnValue: 0,
      }),
      "requires one exact process-owned main channel",
    );
    expect(Array.from(processMem.slice(destination, destination + 4)))
      .toEqual([0x7c, 0x7c, 0x7c, 0x7c]);
  });

  it.each([4, 8] as const)(
    "copies the complete 112-byte stat record for a wasm%s caller",
    (ptrWidth) => {
      const { worker, channel, processMem } =
        makeCopybackHarness(ptrWidth);
      const dest = 4096;
      const size = 112;
      const canary = 0x5a;
      const output = Uint8Array.from(
        { length: size },
        (_, index) => (index * 29 + 7) & 0xff,
      );
      const descriptors = SYSCALL_ARGS[ABI_SYSCALLS.Fstat];
      const statOutput = descriptors?.find((desc) => desc.argIndex === 1);

      expect(statOutput?.size).toEqual({ type: "fixed", size });
      expect(statOutput?.required).toBe(true);
      processMem.fill(canary, dest - 1, dest + size + 1);
      worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid,
        registrationWitness: channel,
        operation: "fstat",
        fd: 3,
        destination: dest,
        outputBytes: output,
      });

      expect(processMem.slice(dest, dest + size)).toEqual(output);
      expect(processMem[dest - 1]).toBe(canary);
      expect(processMem[dest + size]).toBe(canary);
    },
  );

  it.each([4, 8] as const)(
    "copies the complete initialized 48-byte sched_param for a wasm%s caller",
    (ptrWidth) => {
      const { worker, channel, processMem } =
        makeCopybackHarness(ptrWidth);
      const dest = 8192;
      const size = 48;
      const canary = 0xa6;
      const output = Uint8Array.from(
        { length: size },
        (_, index) => (index * 17 + 3) & 0xff,
      );
      const descriptors = SYSCALL_ARGS[ABI_SYSCALLS.SchedGetparam];
      const schedOutput = descriptors?.find((desc) => desc.argIndex === 1);

      expect(schedOutput?.size).toEqual({ type: "fixed", size });
      expect(schedOutput?.required).toBe(true);
      processMem.fill(canary, dest - 1, dest + size + 1);
      worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid,
        registrationWitness: channel,
        operation: "sched-getparam",
        targetPid: 0,
        destination: dest,
        outputBytes: output,
      });

      expect(processMem.slice(dest, dest + size)).toEqual(output);
      expect(processMem[dest - 1]).toBe(canary);
      expect(processMem[dest + size]).toBe(canary);
    },
  );

  it("carries detached poll output through an immediate timeout without rereading scratch", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const pollfd = 12_000;
    const detached = Uint8Array.of(
      3, 0, 0, 0,
      1, 0,
      0, 0,
    );
    processMem.fill(0xa5, pollfd, pollfd + detached.byteLength);
    worker.testAuthority.completeImmediatePollTimeoutForCopybackTest({
      pid: channel.pid,
      registrationWitness: channel,
      pollfdPointer: pollfd,
      outputBytes: detached,
    });

    expect(processMem.slice(pollfd, pollfd + detached.byteLength))
      .toEqual(detached);
    expect(processMem[pollfd]).not.toBe(0xee);
  });

  it("rejects a busy copy-back operation without reading or replaying it", async () => {
    const { worker, channel, state } = makeCopybackHarness();
    const nestedPid = 101;
    const nestedMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const nestedChannel = createTestChannel(nestedPid, nestedMemory);
    state.processes.set(nestedPid, {
      pid: nestedPid,
      memory: nestedMemory,
      channels: [nestedChannel],
      ptrWidth: 4,
      explicitMaxAddr: false,
    });
    state.activeChannels.push(nestedChannel);
    Atomics.store(
      nestedChannel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      CHANNEL_STATUS_PENDING,
    );
    const nestedPollfd = 4096;
    const nestedProcessBytes = new Uint8Array(nestedMemory.buffer);
    nestedProcessBytes.fill(
      0xa5,
      nestedPollfd,
      nestedPollfd + 8,
    );
    let nestedOptionsRead = false;
    const nestedOptions = {
      get pid(): number {
        nestedOptionsRead = true;
        return nestedPid;
      },
      registrationWitness: nestedChannel,
      pollfdPointer: nestedPollfd,
      outputBytes: Uint8Array.of(3, 0, 0, 0, 1, 0, 0, 0),
    };
    let reentrantError: unknown;
    const statOutput = Uint8Array.from(
      { length: 112 },
      (_, index) => index,
    );

    worker.testAuthority.completeDetachedCopybackForTest({
      pid: channel.pid,
      registrationWitness: channel,
      operation: "fstat",
      fd: 3,
      destination: 8192,
      get outputBytes(): Uint8Array {
        try {
          worker.testAuthority
            .completeImmediatePollTimeoutForCopybackTest(nestedOptions);
        } catch (error) {
          reentrantError = error;
        }
        return statOutput;
      },
    });

    expect(reentrantError).toBeInstanceOf(KernelReentrantEntryError);
    expect(nestedOptionsRead).toBe(false);
    expect(Atomics.load(
      nestedChannel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    )).toBe(CHANNEL_STATUS_PENDING);

    // Allow any gate drain microtasks to run. The rejected options must never
    // be retained for a later turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(nestedOptionsRead).toBe(false);
    expect(Array.from(
      nestedProcessBytes.slice(nestedPollfd, nestedPollfd + 8),
    )).toEqual(new Array(8).fill(0xa5));
  });
});

function expectEntryCause(
  operation: () => unknown,
  expectedMessage: string,
): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const cause = (thrown as { cause?: unknown }).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain(expectedMessage);
}
