import { describe, expect, it } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  SYSCALL_ARGS,
} from "../src/generated/abi";

function makeCopybackHarness() {
  const kernelMemory = new WebAssembly.Memory({ initial: 2 });
  const processMemory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const worker = Object.create(CentralizedKernelWorker.prototype) as CentralizedKernelWorker & {
    completeChannel: (
      channel: unknown,
      syscallNr: number,
      origArgs: number[],
      argDescs: unknown,
      retVal: number,
      errVal: number,
    ) => void;
    kernelMemory: WebAssembly.Memory;
    scratchOffset: number;
    cachedKernelMem: Uint8Array | null;
    cachedKernelBuffer: ArrayBuffer | SharedArrayBuffer | null;
    clearSocketTimeout: () => void;
    drainAllPtyOutputs: () => void;
    flushTcpSendPipes: () => void;
    drainAndProcessWakeupEvents: () => void;
    relistenChannel: () => void;
  };

  worker.kernelMemory = kernelMemory;
  worker.scratchOffset = 0;
  worker.cachedKernelMem = null;
  worker.cachedKernelBuffer = null;
  worker.clearSocketTimeout = () => {};
  worker.drainAllPtyOutputs = () => {};
  worker.flushTcpSendPipes = () => {};
  worker.drainAndProcessWakeupEvents = () => {};
  worker.relistenChannel = () => {};

  return {
    worker,
    channel: {
      pid: 1,
      memory: processMemory,
      channelOffset: 0,
      handling: true,
    },
    kernelMem: new Uint8Array(kernelMemory.buffer),
    processMem: new Uint8Array(processMemory.buffer),
  };
}

describe("CentralizedKernelWorker syscall copy-back", () => {
  it("leaves count-sized output buffers unchanged on zero-byte read EOF", () => {
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

    expect(Array.from(processMem.slice(dest, dest + original.length))).toEqual(Array.from(original));
    const view = new DataView(processMem.buffer, 0);
    expect(view.getBigInt64(CH_RETURN, true)).toBe(0n);
    expect(view.getUint32(CH_ERRNO, true)).toBe(0);
    expect(Atomics.load(new Int32Array(processMem.buffer, 0), CH_STATUS / 4)).toBe(
      CHANNEL_STATUS_COMPLETE,
    );
  });

  it("copies only the reported byte count for count-sized output buffers", () => {
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
      ...Array.from(original.slice(3)),
    ]);
  });

  it("preserves copyRetvalAdd bytes for zero-length msgrcv messages", () => {
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
      ...Array.from(original.slice(4)),
    ]);
  });
});
