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
  ): void;
}

function makeCopybackHarness() {
  const pid = 1;
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
      scratchOffset: 0,
      cachedKernelMem: null,
      cachedKernelBuffer: null,
      processes: new Map([
        [
          pid,
          {
            pid,
            memory: processMemory,
            channels: [channel],
            ptrWidth: 4,
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
    },
  ) as CopybackHarnessWorker;

  return {
    worker,
    channel,
    kernelMem: new Uint8Array(kernelMemory.buffer),
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
    );

    expect(Array.from(processMem.slice(dest, dest + original.length))).toEqual([
      1,
      2,
      3,
      ...original.slice(3),
    ]);
  });

  it("copies fixed prefix metadata when a zero-length msgrcv succeeds", () => {
    const { worker, channel, kernelMem, processMem } = makeCopybackHarness();
    const dest = 3072;
    const original = Uint8Array.from({ length: 12 }, (_, i) => 0xd0 + i);

    processMem.set(original, dest);
    kernelMem.set([0x11, 0x22, 0x33, 0x44, 0, 0, 0, 0], CH_DATA);

    worker.completeChannel(
      channel,
      ABI_SYSCALLS.Msgrcv,
      [0, dest, 8],
      SYSCALL_ARGS[ABI_SYSCALLS.Msgrcv],
      0,
      0,
    );

    expect(Array.from(processMem.slice(dest, dest + original.length))).toEqual([
      0x11,
      0x22,
      0x33,
      0x44,
      ...original.slice(4),
    ]);
  });
});
