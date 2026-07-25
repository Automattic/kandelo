import { describe, expect, it, vi } from "vitest";

import { CentralizedKernelWorker } from "../src/kernel-worker";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_DATA_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  POSIX_IOV_MAX,
} from "../src/generated/abi";

const EFAULT = 14;
const EINVAL = 22;
const IOV_MAX = POSIX_IOV_MAX;
const MSG_TRUNC = 0x20;

interface TestChannel {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

interface ScratchHarness {
  worker: CentralizedKernelWorker & Record<string, any>;
  channel: TestChannel;
  kernelBytes: Uint8Array;
  processBytes: Uint8Array;
  scratchOffset: number;
  scratchEnd: number;
  handleChannel: ReturnType<typeof vi.fn>;
  completeChannel: ReturnType<typeof vi.fn>;
  completeChannelRaw: ReturnType<typeof vi.fn>;
}

function sharedMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

function makeScratchHarness(ptrWidth: 4 | 8 = 4): ScratchHarness {
  const pid = 41;
  const scratchOffset = 4096;
  const scratchEnd = scratchOffset + CH_TOTAL_SIZE;
  const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
  const processMemory = sharedMemory(4);
  const kernelBytes = new Uint8Array(kernelMemory.buffer);
  const processBytes = new Uint8Array(processMemory.buffer);
  const scratchRegion = allocateKernelScratchRegion(
    kernelMemory,
    () => scratchOffset,
    CH_TOTAL_SIZE,
    4,
    "test kernel syscall scratch",
  );
  const channel: TestChannel = {
    pid,
    memory: processMemory,
    channelOffset: 0,
    i32View: new Int32Array(processMemory.buffer),
    consecutiveSyscalls: 0,
    handling: true,
  };
  const completeChannelRaw = vi.fn();
  const completeChannel = vi.fn();
  const handleChannel = vi.fn(() => {
    const view = new DataView(kernelMemory.buffer, scratchOffset);
    const iovPtr = Number(view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true));
    const iovLen = iovPtr === 0
      ? 0
      : new DataView(kernelMemory.buffer).getUint32(iovPtr + 4, true);
    view.setBigInt64(CH_RETURN, BigInt(iovLen), true);
    view.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  const worker = Object.assign(
    Object.create(CentralizedKernelWorker.prototype),
    {
      kernel: { toKernelPtr: (value: number | bigint) => value },
      kernelInstance: {
        exports: {
          kernel_handle_channel: handleChannel,
          kernel_prepare_write_operation: (
            _pid: number,
            _tid: number,
            _fd: number,
            _offset: bigint,
            len: number,
          ) => BigInt(len),
        },
      },
      kernelMemory,
      scratchOffset,
      scratchRegion,
      cachedKernelMem: null,
      cachedKernelBuffer: null,
      currentHandlePid: 0,
      getPtrWidth: () => ptrWidth,
      guestTidForChannel: () => pid,
      bindKernelTidForChannel: () => {},
      finishSignalTermination: () => false,
      dequeueSignalForDelivery: () => 0,
      handleBlockingRetry: vi.fn(),
      deferChannelWhileStopped: () => false,
      getReadinessDeadline: () => 0,
      pendingSelectRetries: new Map(),
      pendingPollRetries: new Map(),
      epollInterests: new Map(),
      isRegisteredChannel: () => true,
      handleSharedMappingsAfterFileSyscall: () => {},
      synchronizeSharedMemoryForBoundary: () => {},
      completeChannel,
      completeChannelRaw,
      relistenChannel: vi.fn(),
    },
  ) as CentralizedKernelWorker & Record<string, any>;

  kernelBytes.fill(0xa5, scratchEnd, scratchEnd + 16_384);
  return {
    worker,
    channel,
    kernelBytes,
    processBytes,
    scratchOffset,
    scratchEnd,
    handleChannel,
    completeChannel,
    completeChannelRaw,
  };
}

function writeWasm32Iovecs(
  processBytes: Uint8Array,
  iovPtr: number,
  entries: Array<{ base: number; len: number }>,
): void {
  const view = new DataView(processBytes.buffer);
  entries.forEach(({ base, len }, index) => {
    view.setUint32(iovPtr + index * 8, base, true);
    view.setUint32(iovPtr + index * 8 + 4, len, true);
  });
}

function expectScratchTailUntouched(harness: ScratchHarness): void {
  const tail = harness.kernelBytes.subarray(
    harness.scratchEnd,
    harness.scratchEnd + 16_384,
  );
  expect(tail.every((byte) => byte === 0xa5)).toBe(true);
}

describe("kernel scratch transfer capacity regressions", () => {
  it("chunks PTY input at the exact scratch capacity and capacity + 1", () => {
    for (const length of [CH_TOTAL_SIZE, CH_TOTAL_SIZE + 1]) {
      const harness = makeScratchHarness();
      const ptyWrite = vi.fn((
        _ptyIdx: number,
        _pointer: number,
        chunkLength: number,
      ) => chunkLength);
      Object.assign(harness.worker, {
        kernelInstance: {
          exports: { kernel_pty_master_write: ptyWrite },
        },
        drainPtyOutput: () => {},
        scheduleWakeBlockedRetries: () => {},
      });

      harness.worker.ptyMasterWrite(3, new Uint8Array(length).fill(0x31));

      expect(ptyWrite.mock.calls.map((call) => call[2])).toEqual(
        length === CH_TOTAL_SIZE ? [CH_TOTAL_SIZE] : [CH_TOTAL_SIZE, 1],
      );
      expectScratchTailUntouched(harness);
    }
  });

  it("rejects an oversized initial cwd before copying it", () => {
    const harness = makeScratchHarness();
    const setCwd = vi.fn(() => -36);
    Object.assign(harness.worker, {
      initialized: true,
      kernelInstance: { exports: { kernel_set_cwd: setCwd } },
    });

    expect(() => harness.worker.setCwd(41, "x".repeat(CH_TOTAL_SIZE + 1)))
      .toThrow(/cwd|PATH_MAX|too long/i);

    expect(setCwd).not.toHaveBeenCalled();
    expectScratchTailUntouched(harness);
  });

  it("accounts for every writev table and alignment byte", () => {
    const harness = makeScratchHarness();
    const iovPtr = 256;
    const dataPtr = 16_384;
    const entries = Array.from(
      { length: IOV_MAX },
      (_, index) => ({
        base: dataPtr,
        len: index === IOV_MAX - 1 ? 56_321 : 1,
      }),
    );
    writeWasm32Iovecs(harness.processBytes, iovPtr, entries);
    harness.processBytes.fill(0x5c, dataPtr, dataPtr + 56_321);

    harness.worker.handleWritev(
      harness.channel,
      ABI_SYSCALLS.Writev,
      [7, iovPtr, entries.length, 0, 0, 0],
    );

    expectScratchTailUntouched(harness);
    for (const call of harness.handleChannel.mock.calls) {
      const view = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const kernelIov = Number(view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true));
      expect(kernelIov).toBeGreaterThanOrEqual(harness.scratchOffset + CH_DATA);
      expect(kernelIov + 8).toBeLessThanOrEqual(harness.scratchEnd);
    }
  });

  it("accepts a caller-owned iovec table at Wasm address zero", () => {
    const harness = makeScratchHarness();
    const dataPtr = 1024;
    writeWasm32Iovecs(harness.processBytes, 0, [{
      base: dataPtr,
      len: 4,
    }]);
    harness.processBytes.set([1, 2, 3, 4], dataPtr);

    harness.worker.handleWritev(
      harness.channel,
      ABI_SYSCALLS.Writev,
      [1, 0, 1, 0, 0, 0],
    );

    expect(harness.handleChannel).toHaveBeenCalledTimes(1);
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Writev,
      [1, 0, 1, 0, 0, 0],
      undefined,
      4,
      0,
    );
    expectScratchTailUntouched(harness);
  });

  it("subtracts the complete readv iovec table from data capacity", () => {
    const harness = makeScratchHarness();
    const iovPtr = 256;
    const destination = 24_576;
    const entries = Array.from(
      { length: IOV_MAX },
      (_, index) => ({
        base: destination,
        len: index === IOV_MAX - 1 ? 56 : 64,
      }),
    );
    writeWasm32Iovecs(harness.processBytes, iovPtr, entries);
    harness.handleChannel.mockImplementation(() => {
      const view = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      view.setBigInt64(CH_RETURN, 0n, true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleReadv(
      harness.channel,
      ABI_SYSCALLS.Readv,
      [7, iovPtr, entries.length, 0, 0, 0],
    );

    expectScratchTailUntouched(harness);
  });

  it.each([
    ["sendmsg", "handleSendmsg", ABI_SYSCALLS.Sendmsg],
    ["recvmsg", "handleRecvmsg", ABI_SYSCALLS.Recvmsg],
  ] as const)(
    "rejects %s iovec counts above IOV_MAX before building a kernel table",
    (_name, method, _syscallNr) => {
      const harness = makeScratchHarness();
      const msgPtr = 128;
      const iovPtr = 1024;
      const view = new DataView(harness.processBytes.buffer);
      view.setUint32(msgPtr + 8, iovPtr, true);
      view.setUint32(msgPtr + 12, IOV_MAX + 1, true);
      writeWasm32Iovecs(
        harness.processBytes,
        iovPtr,
        Array.from({ length: IOV_MAX + 1 }, () => ({ base: 0, len: 0 })),
      );

      harness.worker[method](
        harness.channel,
        [7, msgPtr, 0, 0, 0, 0],
      );

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        EINVAL,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["sendmsg", "handleSendmsg"],
    ["recvmsg", "handleRecvmsg"],
  ] as const)(
    "does not let an oversized %s iovec table cross the scratch allocation",
    (_name, method) => {
      const harness = makeScratchHarness();
      const msgPtr = 128;
      const iovPtr = 1024;
      const countThatFillsTheDataArea = 8192;
      const view = new DataView(harness.processBytes.buffer);
      view.setUint32(msgPtr + 8, iovPtr, true);
      view.setUint32(msgPtr + 12, countThatFillsTheDataArea, true);
      writeWasm32Iovecs(
        harness.processBytes,
        iovPtr,
        Array.from(
          { length: countThatFillsTheDataArea },
          () => ({ base: 0, len: 0 }),
        ),
      );

      harness.worker[method](
        harness.channel,
        [7, msgPtr, 0, 0, 0, 0],
      );

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expectScratchTailUntouched(harness);
    },
  );

  it("accepts recvmsg MSG_TRUNC lengths larger than bounded iovec data", () => {
    const harness = makeScratchHarness();
    const msgPtr = 128;
    const iovPtr = 1024;
    const destination = 2048;
    const payloadLength = 13;
    const view = new DataView(harness.processBytes.buffer);
    view.setUint32(msgPtr + 8, iovPtr, true);
    view.setUint32(msgPtr + 12, 1, true);
    writeWasm32Iovecs(
      harness.processBytes,
      iovPtr,
      [{ base: destination, len: 4 }],
    );
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const kernelMessagePointer = Number(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      const kernelView = new DataView(harness.kernelBytes.buffer);
      const kernelIovecPointer = kernelView.getUint32(
        kernelMessagePointer + 8,
        true,
      );
      const kernelDataPointer = kernelView.getUint32(
        kernelIovecPointer,
        true,
      );
      harness.kernelBytes.set(new TextEncoder().encode("recv"), kernelDataPointer);
      channelView.setBigInt64(CH_RETURN, BigInt(payloadLength), true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleRecvmsg(
      harness.channel,
      [7, msgPtr, MSG_TRUNC, 0, 0, 0],
    );

    expect(harness.processBytes.slice(destination, destination + 4)).toEqual(
      new TextEncoder().encode("recv"),
    );
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Recvmsg,
      [7, msgPtr, MSG_TRUNC, 0, 0, 0],
      undefined,
      payloadLength,
      0,
    );
    expectScratchTailUntouched(harness);
  });

  it("rejects a wasm64 iovec pointer that cannot be represented losslessly", () => {
    const harness = makeScratchHarness(8);
    const iovPtr = 256;
    const view = new DataView(harness.processBytes.buffer);
    view.setBigUint64(iovPtr, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    view.setBigUint64(iovPtr + 8, 1n, true);

    harness.worker.handleWritev(
      harness.channel,
      ABI_SYSCALLS.Writev,
      [7, iovPtr, 1, 0, 0, 0],
    );

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["writev", "handleWritev", ABI_SYSCALLS.Writev],
    ["readv", "handleReadv", ABI_SYSCALLS.Readv],
  ] as const)(
    "rejects an out-of-range nested buffer in the %s slow path",
    (_name, method, syscallNr) => {
      const harness = makeScratchHarness();
      const iovPtr = 256;
      writeWasm32Iovecs(harness.processBytes, iovPtr, [{
        base: harness.processBytes.byteLength - 8,
        len: CH_DATA_SIZE + 1,
      }]);

      harness.worker[method](
        harness.channel,
        syscallNr,
        [7, iovPtr, 1, 0, 0, 0],
      );

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it("preserves an unsigned low offset word in the preadv slow path", () => {
    const harness = makeScratchHarness();
    const iovPtr = 256;
    const destination = 65_536;
    writeWasm32Iovecs(harness.processBytes, iovPtr, [{
      base: destination,
      len: CH_DATA_SIZE + 1,
    }]);
    const offsets: Array<{ low: number; high: number }> = [];
    harness.handleChannel.mockImplementation(() => {
      const view = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      offsets.push({
        low: Number(BigInt.asUintN(
          32,
          view.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
        )),
        high: Number(view.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true)),
      });
      view.setBigInt64(CH_RETURN, 0n, true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleReadv(
      harness.channel,
      ABI_SYSCALLS.Preadv,
      [7, iovPtr, 1, 0x8000_0000, 0, 0],
    );

    expect(offsets).toEqual([{ low: 0x8000_0000, high: 0 }]);
    expectScratchTailUntouched(harness);
  });

  it("rejects an out-of-range source before a large write kernel call", () => {
    const harness = makeScratchHarness();
    const source = harness.processBytes.byteLength - 8;

    harness.worker.handleLargeWrite(
      harness.channel,
      ABI_SYSCALLS.Write,
      [7, source, CH_DATA_SIZE + 1, 0, 0, 0],
    );

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it("rejects an out-of-range destination before a large read kernel call", () => {
    const harness = makeScratchHarness();
    const destination = harness.processBytes.byteLength - 8;

    harness.worker.handleLargeRead(
      harness.channel,
      ABI_SYSCALLS.Read,
      [7, destination, CH_DATA_SIZE + 1, 0, 0, 0],
    );

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["select", "handleSelect", ABI_SYSCALLS.Select],
    ["pselect6", "handlePselect6", ABI_SYSCALLS.Pselect6],
  ] as const)(
    "rejects an out-of-range %s fd_set before copying it",
    (_name, method, _syscall) => {
      const harness = makeScratchHarness();
      const invalidSet = harness.processBytes.byteLength - 4;

      expect(() => harness.worker[method](
        harness.channel,
        [1, invalidSet, 0, 0, 0, 0],
      )).not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it("rejects an out-of-range epoll_ctl event before copying it", () => {
    const harness = makeScratchHarness();
    const invalidEvent = harness.processBytes.byteLength - 4;

    expect(() => harness.worker.handleEpollCtl(
      harness.channel,
      [3, 1, 7, invalidEvent, 0, 0],
    )).not.toThrow();

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it("rejects an out-of-range epoll output array before polling", () => {
    const harness = makeScratchHarness();
    const invalidEvents = harness.processBytes.byteLength - 4;
    harness.worker.epollInterests.set("41:3", [{
      fd: 7,
      events: 1,
      data: 9n,
    }]);

    expect(() => harness.worker.handleEpollPwait(
      harness.channel,
      ABI_SYSCALLS.EpollPwait,
      [3, invalidEvents, 1, 0, 0, 0],
    )).not.toThrow();

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["IPC_STAT output", 2, 72],
    ["GETALL output", 13, 64],
    ["SETALL input", 17, 64],
  ] as const)(
    "rejects an out-of-range semctl %s before touching kernel scratch",
    (_name, command, bytes) => {
      const harness = makeScratchHarness();
      const invalidBuffer = harness.processBytes.byteLength - bytes + 1;
      const arrayBytes = vi.fn(() => bytes);
      Object.assign(harness.worker.kernelInstance.exports, {
        kernel_semctl_array_bytes: arrayBytes,
      });

      expect(() => harness.worker.handleSemctl(
        harness.channel,
        [3, 0, command, invalidBuffer, 0, 0],
      )).not.toThrow();

      if (command === 2) {
        expect(arrayBytes).not.toHaveBeenCalled();
      } else {
        expect(arrayBytes).toHaveBeenCalledWith(
          harness.channel.pid,
          harness.channel.pid,
          3,
          command,
        );
      }
      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it("sizes semctl arrays safely through an older ABI-42 kernel", () => {
    const harness = makeScratchHarness();
    const outputPointer = 4096;
    const semaphoreCount = 32;
    const outputBytes = semaphoreCount * 2;
    const expected = new Uint8Array(outputBytes).map(
      (_, index) => index & 0xff,
    );
    let dispatch = 0;
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const command = Number(
        channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
      ) & ~0x100;
      const dataPointer = Number(
        channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
      );
      if (dispatch++ === 0) {
        expect(command).toBe(2);
        new DataView(harness.kernelBytes.buffer).setUint16(
          dataPointer + 56,
          semaphoreCount,
          true,
        );
      } else {
        expect(command).toBe(13);
        harness.kernelBytes.set(expected, dataPointer);
      }
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleSemctl(
      harness.channel,
      [3, 0, 13, outputPointer, 0, 0],
    );

    expect(harness.handleChannel).toHaveBeenCalledTimes(2);
    expect(
      harness.processBytes.slice(
        outputPointer,
        outputPointer + outputBytes,
      ),
    ).toEqual(expected);
    expectScratchTailUntouched(harness);
  });

  it("rejects a negative generic descriptor length before scratch mutation", () => {
    const harness = makeScratchHarness();
    Object.assign(harness.worker, {
      config: {},
      syscallRing: new Map(),
      syscallTraceEnabled: false,
      channelTids: new Map(),
      processes: new Map([[harness.channel.pid, {
        pid: harness.channel.pid,
        memory: harness.channel.memory,
        channels: [harness.channel],
        ptrWidth: 4,
      }]]),
      synchronizeSharedMemoryForBoundary: () => {},
      sharedMmapBackings: new Map(),
      getProcessExitSignal: () => 0,
    });
    const request = new DataView(harness.channel.memory.buffer);
    request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Read, true);
    request.setBigInt64(CH_ARGS, 7n, true);
    request.setBigInt64(CH_ARGS + CH_ARG_SIZE, 1024n, true);
    request.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, -1n, true);

    expect(() => harness.worker._handleSyscallInner(harness.channel))
      .not.toThrow();

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Read,
      [7, 1024, -1, 0, 0, 0],
      undefined,
      -1,
      EINVAL,
    );
    expectScratchTailUntouched(harness);
  });

  it("checks ppoll scalar-conversion sources before scratch mutation", () => {
    for (const [ptrWidth, timespecPointer, maskPointer] of [
      [4, BigInt(4 * 65_536 - 8), 0n],
      [4, 0n, BigInt(4 * 65_536 - 4)],
      [8, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0n],
    ] as const) {
      const harness = makeScratchHarness(ptrWidth);
      Object.assign(harness.worker, {
        config: {},
        syscallRing: new Map(),
        syscallTraceEnabled: false,
        channelTids: new Map(),
        processes: new Map([[harness.channel.pid, {
          pid: harness.channel.pid,
          memory: harness.channel.memory,
          channels: [harness.channel],
          ptrWidth,
        }]]),
        synchronizeSharedMemoryForBoundary: () => {},
        sharedMmapBackings: new Map(),
        hostReaped: new Set(),
        getProcessExitSignal: () => 0,
      });
      const request = new DataView(harness.channel.memory.buffer);
      request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Ppoll, true);
      request.setBigInt64(CH_ARGS, 0n, true);
      request.setBigInt64(CH_ARGS + CH_ARG_SIZE, 0n, true);
      request.setBigInt64(
        CH_ARGS + 2 * CH_ARG_SIZE,
        timespecPointer,
        true,
      );
      request.setBigInt64(
        CH_ARGS + 3 * CH_ARG_SIZE,
        maskPointer,
        true,
      );
      request.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, 8n, true);

      expect(() => harness.worker._handleSyscallInner(harness.channel))
        .not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    }
  });

  it("stages generic descriptor input only in the lease that dispatches it", () => {
    const harness = makeScratchHarness();
    const inputPointer = 8192;
    const input = Uint8Array.from([0x4b, 0x61, 0x6e, 0x64, 0x65, 0x6c, 0x6f]);
    harness.processBytes.set(input, inputPointer);
    Object.assign(harness.worker, {
      config: {},
      syscallRing: new Map(),
      syscallTraceEnabled: false,
      channelTids: new Map(),
      processes: new Map([[harness.channel.pid, {
        pid: harness.channel.pid,
        memory: harness.channel.memory,
        channels: [harness.channel],
        ptrWidth: 4,
      }]]),
      synchronizeSharedMemoryForBoundary: () => {},
      sharedMmapBackings: new Map(),
      hostReaped: new Set(),
      getProcessExitSignal: () => 0,
    });

    const observed: Uint8Array[] = [];
    harness.worker.bindKernelTidForChannel = () => {
      // Model a synchronous nested host operation that reused main scratch
      // after descriptor planning but before this syscall's dispatch.
      harness.worker.scratchRegion.withLease((lease: any) => {
        lease.fill(0xcc, CH_DATA, input.byteLength);
      });
      harness.processBytes.fill(
        0xee,
        inputPointer,
        inputPointer + input.byteLength,
      );
    };
    harness.handleChannel.mockImplementation((offset: number) => {
      const channelView = new DataView(harness.kernelBytes.buffer, offset);
      const dataPointer = Number(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      observed.push(
        new Uint8Array(
          harness.kernelBytes.buffer,
          dataPointer,
          input.byteLength,
        ).slice(),
      );
      channelView.setBigInt64(CH_RETURN, BigInt(input.byteLength), true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    const request = new DataView(harness.channel.memory.buffer);
    request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Write, true);
    request.setBigInt64(CH_ARGS, 7n, true);
    request.setBigInt64(CH_ARGS + CH_ARG_SIZE, BigInt(inputPointer), true);
    request.setBigInt64(
      CH_ARGS + 2 * CH_ARG_SIZE,
      BigInt(input.byteLength),
      true,
    );

    expect(() => harness.worker._handleSyscallInner(harness.channel))
      .not.toThrow();

    expect(observed).toEqual([input]);
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Write,
      [7, inputPointer, input.byteLength, 0, 0, 0],
      expect.any(Array),
      input.byteLength,
      0,
      [],
    );
    expectScratchTailUntouched(harness);
  });
});
