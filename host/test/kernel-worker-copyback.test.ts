import { describe, expect, it } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  type SyscallArgDesc,
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

interface CopybackHarnessWorker {
  completeChannel(
    channel: TestChannel,
    syscallNr: number,
    origArgs: number[],
    argDescs: SyscallArgDesc[] | undefined,
    retVal: number,
    errVal: number,
    detachedOutput?: Array<{ ptr: number; bytes: Uint8Array }>,
  ): void;
  handleBlockingRetry(
    channel: TestChannel,
    syscallNr: number,
    origArgs: number[],
    detachedOutput?: Array<{ ptr: number; bytes: Uint8Array }>,
  ): void;
}

function makeCopybackHarness(ptrWidth: 4 | 8 = 4) {
  const pid = 100;
  const kernelMemory = new WebAssembly.Memory({ initial: 2 });
  const processMemory = new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
  const channel: TestChannel = {
    pid,
    memory: processMemory,
    channelOffset: 0,
    i32View: new Int32Array(processMemory.buffer),
    consecutiveSyscalls: 0,
    handling: true,
  };
  const worker = Object.assign(
    Object.create(CentralizedKernelWorker.prototype),
    {
      kernelMemory,
      cachedKernelMem: null,
      cachedKernelBuffer: null,
      processes: new Map([
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
      ]),
      clearSocketTimeout: () => {},
      clearReadinessWait: () => {},
      drainAllPtyOutputs: () => {},
      flushTcpSendPipes: () => {},
      drainAndProcessWakeupEvents: () => {},
      synchronizeSharedMemoryForBoundary: () => {},
      relistenChannel: () => {},
      pendingCancels: new Set(),
    },
  ) as CopybackHarnessWorker;
  const scratchPointer = installKernelWorkerTestScratch(
    worker as unknown as Record<string, unknown>,
    kernelMemory,
  );

  return {
    worker,
    channel,
    kernelMem: new Uint8Array(kernelMemory.buffer, scratchPointer),
    processMem: new Uint8Array(processMemory.buffer),
  };
}

describe("CentralizedKernelWorker syscall copy-back", () => {
  it("leaves the destination unchanged when read reports EOF", () => {
    const { worker, channel, kernelMem, processMem } = makeCopybackHarness();
    const dest = 1024;
    const original = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);

    processMem.set(original, dest);
    kernelMem.fill(0, CH_DATA, CH_DATA + original.length);

    worker.completeChannel(
      channel,
      ABI_SYSCALLS.Read,
      [0, dest, original.length],
      SYSCALL_ARGS[ABI_SYSCALLS.Read],
      0,
      0,
    );

    expect(processMem.slice(dest, dest + original.length)).toEqual(original);
    const channelView = new DataView(processMem.buffer);
    expect(channelView.getBigInt64(CH_RETURN, true)).toBe(0n);
    expect(channelView.getUint32(CH_ERRNO, true)).toBe(0);
    expect(Atomics.load(channel.i32View, CH_STATUS / 4)).toBe(
      CHANNEL_STATUS_COMPLETE,
    );
  });

  it("copies only the byte count reported by read", () => {
    const { worker, channel, kernelMem, processMem } = makeCopybackHarness();
    const dest = 2048;
    const original = Uint8Array.from({ length: 8 }, (_, i) => 0xc0 + i);

    processMem.set(original, dest);
    kernelMem.set([1, 2, 3, 0, 0, 0, 0, 0], CH_DATA);

    worker.completeChannel(
      channel,
      ABI_SYSCALLS.Read,
      [0, dest, original.length],
      SYSCALL_ARGS[ABI_SYSCALLS.Read],
      3,
      0,
      [{ ptr: dest, bytes: Uint8Array.of(1, 2, 3) }],
    );

    expect(Array.from(processMem.slice(dest, dest + original.length))).toEqual([
      1,
      2,
      3,
      ...original.slice(3),
    ]);
  });

  it.each([4, 8] as const)(
    "copies the complete 112-byte stat record for a wasm%s caller",
    (ptrWidth) => {
      const { worker, channel, kernelMem, processMem } =
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
      kernelMem.set(output, CH_DATA);

      worker.completeChannel(
        channel,
        ABI_SYSCALLS.Fstat,
        [3, dest],
        descriptors,
        0,
        0,
        [{ ptr: dest, bytes: output }],
      );

      expect(processMem.slice(dest, dest + size)).toEqual(output);
      expect(processMem[dest - 1]).toBe(canary);
      expect(processMem[dest + size]).toBe(canary);
    },
  );

  it.each([4, 8] as const)(
    "copies the complete initialized 48-byte sched_param for a wasm%s caller",
    (ptrWidth) => {
      const { worker, channel, kernelMem, processMem } =
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
      kernelMem.set(output, CH_DATA);

      worker.completeChannel(
        channel,
        ABI_SYSCALLS.SchedGetparam,
        [0, dest],
        descriptors,
        0,
        0,
        [{ ptr: dest, bytes: output }],
      );

      expect(processMem.slice(dest, dest + size)).toEqual(output);
      expect(processMem[dest - 1]).toBe(canary);
      expect(processMem[dest + size]).toBe(canary);
    },
  );

  it("carries detached poll output through an immediate timeout without rereading scratch", () => {
    const { worker, channel, kernelMem, processMem } = makeCopybackHarness();
    const pollfd = 12_000;
    const detached = Uint8Array.of(
      3, 0, 0, 0,
      1, 0,
      0, 0,
    );
    processMem.fill(0xa5, pollfd, pollfd + detached.byteLength);
    kernelMem.fill(0xee, CH_DATA, CH_DATA + detached.byteLength);

    worker.handleBlockingRetry(
      channel,
      ABI_SYSCALLS.Poll,
      [pollfd, 1, 0],
      [{ ptr: pollfd, bytes: detached }],
    );

    expect(processMem.slice(pollfd, pollfd + detached.byteLength))
      .toEqual(detached);
    expect(processMem[pollfd]).not.toBe(0xee);
  });

});
