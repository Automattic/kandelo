import { describe, expect, it, vi } from "vitest";

import { CentralizedKernelWorker } from "../src/kernel-worker";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { WasmPosixKernel } from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
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
  PRCTL_NAME_BYTES,
  PR_GET_NAME,
  PR_SET_NAME,
  IOCTL_REQUESTS,
  KERNEL_CMSGHDR_WIRE_ALIGN,
  KERNEL_CMSGHDR_WIRE_DATA_OFFSET,
  KERNEL_CMSGHDR_WIRE_LEN_OFFSET,
  KERNEL_CMSGHDR_WIRE_LEVEL_OFFSET,
  KERNEL_CMSGHDR_WIRE_TYPE_OFFSET,
  KERNEL_IOVEC_WIRE_BASE_OFFSET,
  KERNEL_IOVEC_WIRE_LEN_OFFSET,
  KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT,
  KERNEL_MSGHDR_WIRE_CONTROL_OFFSET,
  KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
  KERNEL_MSGHDR_WIRE_FLAGS_OFFSET,
  KERNEL_MSGHDR_WIRE_IOV_OFFSET,
  KERNEL_MSGHDR_WIRE_IOVLEN_OFFSET,
  KERNEL_MSGHDR_WIRE_NAME_OFFSET,
  KERNEL_MSGHDR_WIRE_NAMELEN_OFFSET,
  POSIX_IOV_MAX,
  POSIX_PATH_MAX_BYTES,
  PROCESS_CMSGHDR_WASM32_ALIGN,
  PROCESS_CMSGHDR_WASM32_DATA_OFFSET,
  PROCESS_CMSGHDR_WASM32_LEN_OFFSET,
  PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET,
  PROCESS_CMSGHDR_WASM32_TYPE_OFFSET,
  PROCESS_CMSGHDR_WASM64_ALIGN,
  PROCESS_CMSGHDR_WASM64_DATA_OFFSET,
  PROCESS_CMSGHDR_WASM64_LEN_OFFSET,
  PROCESS_CMSGHDR_WASM64_LEVEL_OFFSET,
  PROCESS_CMSGHDR_WASM64_TYPE_OFFSET,
  PROCESS_MSGHDR_WASM32_CONTROL_OFFSET,
  PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET,
  PROCESS_MSGHDR_WASM32_FLAGS_OFFSET,
  PROCESS_MSGHDR_WASM32_IOV_OFFSET,
  PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET,
  PROCESS_MSGHDR_WASM32_NAME_OFFSET,
  PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET,
  PROCESS_MSGHDR_WASM64_CONTROL_OFFSET,
  PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET,
  PROCESS_MSGHDR_WASM64_FLAGS_OFFSET,
  PROCESS_MSGHDR_WASM64_IOV_OFFSET,
  PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET,
  PROCESS_MSGHDR_WASM64_NAME_OFFSET,
  PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET,
  PROCESS_MSGHDR_WASM64_SIZE,
  SCM_RIGHTS_FD_BYTES,
  SOCKET_MSG_TRUNC,
  SOCKET_SCM_RIGHTS,
  SOCKET_SOL_SOCKET,
  STRUCT_SIZE_KERNEL_IOVEC_WIRE,
  STRUCT_SIZE_KERNEL_MSGHDR_WIRE,
  STRUCT_SIZE_WASM_EPOLL_EVENT,
  STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER,
  SYSCALL_ARGS,
  WASM_EPOLL_EVENT_DATA_OFFSET,
  WASM_EPOLL_EVENT_EVENTS_OFFSET,
  WASM_EPOLL_EVENT_PAD_OFFSET,
} from "../src/generated/abi";

const EFAULT = 14;
const EIO = 5;
const EINVAL = 22;
const EOVERFLOW = 75;
const EAGAIN = 11;
const IPC_NOWAIT = 0x800;
const IOV_MAX = POSIX_IOV_MAX;
const MSG_CTRUNC = 0x08;
const PR_SET_NO_NEW_PRIVS = 38;
const SCALAR_IOCTL_REQUESTS = Object.entries(IOCTL_REQUESTS)
  .filter(([, contract]) => contract.argKind === "scalar-i32")
  .map(([request]) => Number(request));
const SIOCGIFNAME = 0x8910;
const SIOCGIFADDR = 0x8915;
const SIOCGIFHWADDR = 0x8927;
const SIOCGIFINDEX = 0x8933;
const NETWORK_IFREQ_HANDLERS = [
  {
    request: SIOCGIFNAME,
    handler: "handleIoctlIfname",
    prepare(bytes: Uint8Array, pointer: number): void {
      new DataView(bytes.buffer).setInt32(pointer + 16, 1, true);
    },
  },
  {
    request: SIOCGIFHWADDR,
    handler: "handleIoctlIfhwaddr",
    prepare(bytes: Uint8Array, pointer: number): void {
      bytes.set(new TextEncoder().encode("lo\0"), pointer);
    },
  },
  {
    request: SIOCGIFADDR,
    handler: "handleIoctlIfaddr",
    prepare(bytes: Uint8Array, pointer: number): void {
      bytes.set(new TextEncoder().encode("lo\0"), pointer);
    },
  },
  {
    request: SIOCGIFINDEX,
    handler: "handleIoctlIfindex",
    prepare(bytes: Uint8Array, pointer: number): void {
      bytes.set(new TextEncoder().encode("lo\0"), pointer);
    },
  },
] as const;
const IOVEC_HANDLER_PATHS = [
  {
    name: "writev",
    handler: "handleWritev",
    syscall: ABI_SYSCALLS.Writev,
    message: false,
    input: true,
  },
  {
    name: "readv",
    handler: "handleReadv",
    syscall: ABI_SYSCALLS.Readv,
    message: false,
    input: false,
  },
  {
    name: "sendmsg",
    handler: "handleSendmsg",
    syscall: ABI_SYSCALLS.Sendmsg,
    message: true,
    input: true,
  },
  {
    name: "recvmsg",
    handler: "handleRecvmsg",
    syscall: ABI_SYSCALLS.Recvmsg,
    message: true,
    input: false,
  },
] as const;

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

function hostileBytes(length: number, reportedLength: number): Uint8Array {
  class HostileBytes extends Uint8Array {}
  const bytes = new HostileBytes(length);
  Object.defineProperties(bytes, {
    buffer: { get: () => new ArrayBuffer(reportedLength) },
    byteOffset: { get: () => 0 },
    byteLength: { get: () => reportedLength },
    length: { get: () => reportedLength },
    subarray: { value: () => bytes },
  });
  return bytes;
}

function makeScratchHarness(ptrWidth: 4 | 8 = 4): ScratchHarness {
  const pid = 41;
  const scratchOffset = 4096;
  const scratchEnd = scratchOffset + CH_TOTAL_SIZE;
  const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
  const processMemory = sharedMemory(4);
  const kernelBytes = new Uint8Array(kernelMemory.buffer);
  const processBytes = new Uint8Array(processMemory.buffer);
  let worker!: CentralizedKernelWorker & Record<string, any>;
  let kernelExports!: Record<string, unknown>;
  const scratchTestInstance = createKernelScratchTestInstance(
    ptrWidth,
    kernelMemory,
    () => worker?.kernelInstance?.exports ?? kernelExports,
    () => ptrWidth === 8 ? BigInt(scratchOffset) : scratchOffset,
  );
  const scratchRegion = allocateKernelScratchRegion(
    kernelMemory,
    scratchTestInstance.exports.kernel_alloc_scratch as (size: number) => number,
    CH_TOTAL_SIZE,
    ptrWidth,
    "test kernel syscall scratch",
    scratchTestInstance,
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
  kernelExports = {
    kernel_handle_channel: handleChannel,
    kernel_prepare_write_operation: (
      _pid: number,
      _tid: number,
      _fd: number,
      _offset: bigint,
      len: number,
    ) => BigInt(len),
  };
  worker = Object.assign(
    Object.create(CentralizedKernelWorker.prototype),
    {
      kernel: { toKernelPtr: (value: number | bigint) => value },
      kernelInstance: {
        exports: kernelExports,
      },
      scratchTestInstance,
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

function prepareGenericSyscallHarness(
  harness: ScratchHarness,
  ptrWidth: 4 | 8,
): void {
  Object.assign(harness.worker, {
    config: {},
    syscallRing: new Map(),
    syscallTraceEnabled: false,
    syscallTraceRing: [],
    syscallTraceCap: 64,
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
}

function writeChannelSyscall(
  harness: ScratchHarness,
  syscall: number,
  args: bigint[],
): void {
  const request = new DataView(harness.channel.memory.buffer);
  request.setUint32(CH_SYSCALL, syscall, true);
  for (let index = 0; index < 6; index++) {
    request.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      args[index] ?? 0n,
      true,
    );
  }
}

function writeIfconf(
  bytes: Uint8Array,
  pointerWidth: 4 | 8,
  pointer: number,
  capacity: number,
  outputPointer: number | bigint,
): void {
  const view = new DataView(bytes.buffer);
  view.setInt32(pointer, capacity, true);
  if (pointerWidth === 8) {
    view.setBigUint64(pointer + 8, BigInt(outputPointer), true);
  } else {
    view.setUint32(pointer + 4, Number(outputPointer), true);
  }
}

function invokeNetworkIoctlHandler(
  harness: ScratchHarness,
  handler: string,
  pointer: number,
): void {
  harness.worker[handler](
    harness.channel,
    [7, 0, pointer, 0, 0, 0],
  );
}

function writeNativeIovec(
  processBytes: Uint8Array,
  pointerWidth: 4 | 8,
  iovPointer: number,
  base: number,
  length: number,
): void {
  const view = new DataView(processBytes.buffer);
  if (pointerWidth === 8) {
    view.setBigUint64(iovPointer, BigInt(base), true);
    view.setBigUint64(iovPointer + 8, BigInt(length), true);
  } else {
    view.setUint32(iovPointer, base, true);
    view.setUint32(iovPointer + 4, length, true);
  }
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function writeNativeMessage(
  processBytes: Uint8Array,
  pointerWidth: 4 | 8,
  messagePointer: number,
  fields: {
    namePointer?: number | bigint;
    nameLength?: number;
    iovecPointer?: number | bigint;
    iovecCount?: number | bigint;
    controlPointer?: number | bigint;
    controlLength?: number | bigint;
    flags?: number;
  },
): void {
  const view = new DataView(processBytes.buffer);
  if (pointerWidth === 8) {
    view.setBigUint64(
      messagePointer + PROCESS_MSGHDR_WASM64_NAME_OFFSET,
      BigInt(fields.namePointer ?? 0),
      true,
    );
    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET,
      fields.nameLength ?? 0,
      true,
    );
    view.setBigUint64(
      messagePointer + PROCESS_MSGHDR_WASM64_IOV_OFFSET,
      BigInt(fields.iovecPointer ?? 0),
      true,
    );
    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET,
      Number(fields.iovecCount ?? 0),
      true,
    );
    view.setBigUint64(
      messagePointer + PROCESS_MSGHDR_WASM64_CONTROL_OFFSET,
      BigInt(fields.controlPointer ?? 0),
      true,
    );
    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET,
      Number(fields.controlLength ?? 0),
      true,
    );
    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM64_FLAGS_OFFSET,
      fields.flags ?? 0,
      true,
    );
    return;
  }
  view.setUint32(
    messagePointer + PROCESS_MSGHDR_WASM32_NAME_OFFSET,
    Number(fields.namePointer ?? 0),
    true,
  );
  view.setUint32(
    messagePointer + PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET,
    fields.nameLength ?? 0,
    true,
  );
  view.setUint32(
    messagePointer + PROCESS_MSGHDR_WASM32_IOV_OFFSET,
    Number(fields.iovecPointer ?? 0),
    true,
  );
  view.setUint32(
    messagePointer + PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET,
    Number(fields.iovecCount ?? 0),
    true,
  );
  view.setUint32(
    messagePointer + PROCESS_MSGHDR_WASM32_CONTROL_OFFSET,
    Number(fields.controlPointer ?? 0),
    true,
  );
  view.setUint32(
    messagePointer + PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET,
    Number(fields.controlLength ?? 0),
    true,
  );
  view.setUint32(
    messagePointer + PROCESS_MSGHDR_WASM32_FLAGS_OFFSET,
    fields.flags ?? 0,
    true,
  );
}

function writeNativeRightsRecords(
  processBytes: Uint8Array,
  pointerWidth: 4 | 8,
  controlPointer: number,
  records: number[][],
  paddingByte = 0x7b,
): number {
  const layout = pointerWidth === 8
    ? {
        alignment: PROCESS_CMSGHDR_WASM64_ALIGN,
        lengthOffset: PROCESS_CMSGHDR_WASM64_LEN_OFFSET,
        levelOffset: PROCESS_CMSGHDR_WASM64_LEVEL_OFFSET,
        typeOffset: PROCESS_CMSGHDR_WASM64_TYPE_OFFSET,
        dataOffset: PROCESS_CMSGHDR_WASM64_DATA_OFFSET,
      }
    : {
        alignment: PROCESS_CMSGHDR_WASM32_ALIGN,
        lengthOffset: PROCESS_CMSGHDR_WASM32_LEN_OFFSET,
        levelOffset: PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET,
        typeOffset: PROCESS_CMSGHDR_WASM32_TYPE_OFFSET,
        dataOffset: PROCESS_CMSGHDR_WASM32_DATA_OFFSET,
      };
  const view = new DataView(processBytes.buffer);
  let offset = 0;
  for (const descriptors of records) {
    const length = layout.dataOffset +
      descriptors.length * SCM_RIGHTS_FD_BYTES;
    const space = alignUp(length, layout.alignment);
    processBytes.fill(
      paddingByte,
      controlPointer + offset,
      controlPointer + offset + space,
    );
    view.setUint32(
      controlPointer + offset + layout.lengthOffset,
      length,
      true,
    );
    view.setUint32(
      controlPointer + offset + layout.levelOffset,
      SOCKET_SOL_SOCKET,
      true,
    );
    view.setUint32(
      controlPointer + offset + layout.typeOffset,
      SOCKET_SCM_RIGHTS,
      true,
    );
    descriptors.forEach((descriptor, index) => {
      view.setInt32(
        controlPointer + offset + layout.dataOffset +
          index * SCM_RIGHTS_FD_BYTES,
        descriptor,
        true,
      );
    });
    offset += space;
  }
  return offset;
}

function canonicalRightsBytes(records: number[][]): Uint8Array {
  const lengths = records.map((descriptors) =>
    KERNEL_CMSGHDR_WIRE_DATA_OFFSET +
      descriptors.length * SCM_RIGHTS_FD_BYTES
  );
  const output = new Uint8Array(
    lengths.reduce(
      (total, length) =>
        total + alignUp(length, KERNEL_CMSGHDR_WIRE_ALIGN),
      0,
    ),
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  records.forEach((descriptors, recordIndex) => {
    const length = lengths[recordIndex];
    view.setUint32(
      offset + KERNEL_CMSGHDR_WIRE_LEN_OFFSET,
      length,
      true,
    );
    view.setUint32(
      offset + KERNEL_CMSGHDR_WIRE_LEVEL_OFFSET,
      SOCKET_SOL_SOCKET,
      true,
    );
    view.setUint32(
      offset + KERNEL_CMSGHDR_WIRE_TYPE_OFFSET,
      SOCKET_SCM_RIGHTS,
      true,
    );
    descriptors.forEach((descriptor, descriptorIndex) => {
      view.setInt32(
        offset + KERNEL_CMSGHDR_WIRE_DATA_OFFSET +
          descriptorIndex * SCM_RIGHTS_FD_BYTES,
        descriptor,
        true,
      );
    });
    offset += alignUp(length, KERNEL_CMSGHDR_WIRE_ALIGN);
  });
  return output;
}

function invokeIovecHandler(
  harness: ScratchHarness,
  pointerWidth: 4 | 8,
  path: (typeof IOVEC_HANDLER_PATHS)[number],
  iovPointer: number,
): void {
  if (path.message) {
    const messagePointer = 128;
    writeNativeMessage(
      harness.processBytes,
      pointerWidth,
      messagePointer,
      { iovecPointer: iovPointer, iovecCount: 1 },
    );
    harness.worker[path.handler](
      harness.channel,
      [7, messagePointer, 0, 0, 0, 0],
    );
    return;
  }
  harness.worker[path.handler](
    harness.channel,
    path.syscall,
    [7, iovPointer, 1, 0, 0, 0],
  );
}

function respondToSingleKernelIovec(
  harness: ScratchHarness,
  path: (typeof IOVEC_HANDLER_PATHS)[number],
  payload: Uint8Array,
): void {
  harness.handleChannel.mockImplementation((offset: number | bigint) => {
    const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
    const argumentPointer = Number(
      channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
    );
    const kernelView = new DataView(harness.kernelBytes.buffer);
    const kernelIovecPointer = path.message
      ? kernelView.getUint32(argumentPointer + 8, true)
      : argumentPointer;
    const kernelDataPointer = kernelView.getUint32(
      kernelIovecPointer,
      true,
    );
    expect(
      kernelView.getUint32(kernelIovecPointer + 4, true),
      path.name,
    ).toBe(payload.byteLength);
    if (path.input) {
      expect(
        harness.kernelBytes.slice(
          kernelDataPointer,
          kernelDataPointer + payload.byteLength,
        ),
        path.name,
      ).toEqual(payload);
    } else {
      harness.kernelBytes.set(payload, kernelDataPointer);
    }
    channelView.setBigInt64(CH_RETURN, BigInt(payload.byteLength), true);
    channelView.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
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
  it("binds allocator authority to the same shared kernel memory", () => {
    const kernelMemory = sharedMemory(2);
    const instance = createKernelScratchTestInstance(
      4,
      kernelMemory,
      () => ({}),
      () => 4096,
    );
    const region = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "shared test kernel scratch",
      instance,
    );

    region.withLease((scratch) => {
      scratch.copyFrom(new Uint8Array([1, 2, 3, 4]));
    });

    expect(instance.exports.memory).toBe(kernelMemory);
    expect(new Uint8Array(kernelMemory.buffer, 4096, 4))
      .toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("fails closed when the mqueue notification drain returns an errno", () => {
    const harness = makeScratchHarness();
    const wakePendingSignalWaits = vi.fn();
    const sendSignalToProcess = vi.fn();
    Object.assign(harness.worker, {
      wakePendingSignalWaits,
      sendSignalToProcess,
    });
    Object.assign(harness.worker.kernelInstance.exports, {
      kernel_mq_drain_notification: vi.fn(() => -EINVAL),
    });

    // Seed a plausible stale record. A negative kernel return must not make
    // these reusable bytes observable as a fresh notification.
    const stale = new DataView(
      harness.kernelBytes.buffer,
      harness.scratchOffset,
      8,
    );
    stale.setUint32(0, 123, true);
    stale.setUint32(4, 10, true);

    expect(() => harness.worker.drainMqueueNotification()).toThrow(
      /kernel mqueue notification drain returned invalid result -22/,
    );
    expect(wakePendingSignalWaits).not.toHaveBeenCalled();
    expect(sendSignalToProcess).not.toHaveBeenCalled();
  });

  it("captures fstat handles and releases capture after handleChannel throws", () => {
    const harness = makeScratchHarness();
    const kernelMemory = harness.worker.kernelMemory as WebAssembly.Memory;
    const fstat = vi.fn(() => ({
      dev: 11n,
      ino: 22n,
      mode: 0o100644,
      nlink: 1,
      uid: 2,
      gid: 3,
      size: 4096,
      atimeMs: 1000,
      mtimeMs: 2000,
      ctimeMs: 3000,
    }));
    const kernel = Object.assign(
      Object.create(WasmPosixKernel.prototype),
      {
        memory: kernelMemory,
        kernelPtrWidth: 4,
        io: { fstat },
        fstatHandleCapture: null,
      },
    ) as WasmPosixKernel & Record<string, any>;
    harness.worker.kernel = kernel;

    let hostHandle = 501;
    harness.handleChannel.mockImplementation((
      offset: number | bigint,
    ) => {
      const channelView = new DataView(
        kernelMemory.buffer,
        Number(offset),
        CH_TOTAL_SIZE,
      );
      expect(channelView.getUint32(CH_SYSCALL, true))
        .toBe(ABI_SYSCALLS.Fstat);
      const statPointer = channelView.getBigUint64(
        CH_ARGS + CH_ARG_SIZE,
        true,
      );
      expect(kernel.hostFstat(
        BigInt(hostHandle),
        kernel.toKernelPtr(statPointer),
      )).toBe(0);
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    const capture = () =>
      harness.worker.getFdStatForSharedMapping(harness.channel, 7);

    expect(capture()).toEqual({
      kind: "ok",
      value: {
        dev: 11n,
        ino: 22n,
        mode: 0o100644,
        size: 4096,
        hostHandle: 501,
      },
    });
    expect(harness.worker.currentHandlePid).toBe(0);

    harness.handleChannel.mockImplementationOnce(() => {
      throw new Error("synthetic handleChannel failure");
    });
    expect(capture()).toEqual({ kind: "error", errno: EIO });
    expect(harness.worker.currentHandlePid).toBe(0);

    hostHandle = 502;
    expect(capture()).toEqual({
      kind: "ok",
      value: {
        dev: 11n,
        ino: 22n,
        mode: 0o100644,
        size: 4096,
        hostHandle: 502,
      },
    });
    expect(fstat).toHaveBeenNthCalledWith(1, 501);
    expect(fstat).toHaveBeenNthCalledWith(2, 502);
  });

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

  it("does not lend stale PTY scratch bytes when input spoofs its length", () => {
    const harness = makeScratchHarness();
    const input = hostileBytes(1, 4);
    Uint8Array.prototype.set.call(input, [0x31]);
    harness.kernelBytes.fill(
      0xa5,
      harness.scratchOffset,
      harness.scratchOffset + 8,
    );
    const ptyWrite = vi.fn((
      _ptyIdx: number,
      pointer: number,
      length: number,
    ) => {
      expect(pointer).toBe(harness.scratchOffset);
      expect(length).toBe(1);
      expect(harness.kernelBytes.slice(pointer, pointer + length))
        .toEqual(new Uint8Array([0x31]));
      return length;
    });
    Object.assign(harness.worker, {
      kernelInstance: {
        exports: { kernel_pty_master_write: ptyWrite },
      },
      drainPtyOutput: () => {},
      scheduleWakeBlockedRetries: () => {},
    });

    harness.worker.ptyMasterWrite(3, input);

    expect(ptyWrite).toHaveBeenCalledOnce();
    expect(
      harness.kernelBytes.slice(
        harness.scratchOffset,
        harness.scratchOffset + 4,
      ),
    ).toEqual(new Uint8Array([0x31, 0xa5, 0xa5, 0xa5]));
    expectScratchTailUntouched(harness);
  });

  it("uses intrinsic source spans for System V and pipe chunk staging", () => {
    const harness = makeScratchHarness();
    const input = hostileBytes(1, 4);
    Uint8Array.prototype.set.call(input, [0x42]);
    harness.kernelBytes.fill(
      0xa5,
      harness.scratchOffset,
      harness.scratchOffset + 8,
    );
    const writeShm = vi.fn((
      _segment: number,
      _offset: number,
      pointer: number,
      length: number,
    ) => {
      expect(length).toBe(1);
      expect(harness.kernelBytes[pointer]).toBe(0x42);
      return length;
    });
    const writePipe = vi.fn((
      _pid: number,
      _pipe: number,
      pointer: number,
      length: number,
    ) => {
      expect(length).toBe(1);
      expect(harness.kernelBytes[pointer]).toBe(0x42);
      return length;
    });
    Object.assign(harness.worker, {
      tcpScratchRegion: (harness.worker as any).scratchRegion,
      kernelInstance: {
        exports: {
          kernel_ipc_shm_write_chunk: writeShm,
          kernel_pipe_write: writePipe,
        },
      },
    });

    expect((harness.worker as any).writeSysvShmRange(7, 0, input)).toBe(true);
    expect((harness.worker as any).writePipeChunked(
      41,
      9,
      input,
    )).toBe(1);

    expect(writeShm).toHaveBeenCalledOnce();
    expect(writePipe).toHaveBeenCalledOnce();
    expectScratchTailUntouched(harness);
  });

  it("does not lend stale UDP scratch bytes when a router spoofs length", () => {
    const harness = makeScratchHarness();
    const input = hostileBytes(1, 4);
    Uint8Array.prototype.set.call(input, [0x55]);
    harness.kernelBytes.fill(
      0xa5,
      harness.scratchOffset,
      harness.scratchOffset + 8,
    );
    const inject = vi.fn((...args: number[]) => {
      const pointer = args[11];
      const length = args[12];
      expect(pointer).toBe(harness.scratchOffset);
      expect(length).toBe(1);
      expect(harness.kernelBytes.slice(pointer, pointer + length))
        .toEqual(new Uint8Array([0x55]));
      return 0;
    });
    Object.assign(harness.worker, {
      tcpScratchRegion: (harness.worker as any).scratchRegion,
      processes: new Map([[41, {}]]),
      scheduleWakeBlockedRetries: vi.fn(),
      kernelInstance: {
        exports: { kernel_inject_datagram: inject },
      },
    });

    expect((harness.worker as any).injectUdpDatagram(41, {
      srcAddr: new Uint8Array([10, 0, 0, 1]),
      srcPort: 1000,
      dstAddr: new Uint8Array([10, 0, 0, 2]),
      dstPort: 2000,
      data: input,
    })).toBe(0);

    expect(inject).toHaveBeenCalledOnce();
    expect(
      harness.kernelBytes.slice(
        harness.scratchOffset,
        harness.scratchOffset + 4,
      ),
    ).toEqual(new Uint8Array([0x55, 0xa5, 0xa5, 0xa5]));
    expectScratchTailUntouched(harness);
  });

  it("accepts exact TCP scratch capacity and rejects capacity plus one", () => {
    const harness = makeScratchHarness();
    const tcpScratchOffset = 96_000;
    const tcpCapacity = 65_536;
    const tcpTail = harness.kernelBytes.subarray(
      tcpScratchOffset + tcpCapacity,
      tcpScratchOffset + tcpCapacity + 16,
    );
    tcpTail.fill(0xa5);
    const inject = vi.fn((...args: number[]) => {
      const pointer = args[11];
      const length = args[12];
      expect(pointer).toBe(tcpScratchOffset);
      expect(length).toBe(tcpCapacity);
      expect(harness.kernelBytes[pointer]).toBe(0x55);
      expect(harness.kernelBytes[pointer + length - 1]).toBe(0x55);
      return 0;
    });
    const tcpScratchInstance = createKernelScratchTestInstance(
      4,
      (harness.worker as any).kernelMemory,
      () => ({ kernel_inject_datagram: inject }),
      () => tcpScratchOffset,
    );
    const tcpScratchRegion = allocateKernelScratchRegion(
      (harness.worker as any).kernelMemory,
      tcpScratchInstance.exports.kernel_alloc_scratch as
        (size: number) => number,
      tcpCapacity,
      4,
      "test kernel TCP scratch",
      tcpScratchInstance,
    );
    Object.assign(harness.worker, {
      tcpScratchRegion,
      processes: new Map([[41, {}]]),
      scheduleWakeBlockedRetries: vi.fn(),
      kernelInstance: {
        exports: { kernel_inject_datagram: inject },
      },
    });
    const datagram = (data: Uint8Array) => ({
      srcAddr: new Uint8Array([10, 0, 0, 1]),
      srcPort: 1000,
      dstAddr: new Uint8Array([10, 0, 0, 2]),
      dstPort: 2000,
      data,
    });

    expect((harness.worker as any).injectUdpDatagram(
      41,
      datagram(new Uint8Array(tcpCapacity).fill(0x55)),
    )).toBe(0);
    expect((harness.worker as any).injectUdpDatagram(
      41,
      datagram(new Uint8Array(tcpCapacity + 1).fill(0x66)),
    )).toBe(90);

    expect(inject).toHaveBeenCalledOnce();
    expect(tcpTail).toEqual(new Uint8Array(16).fill(0xa5));
    expectScratchTailUntouched(harness);
  });

  it("accepts PATH_MAX minus one cwd bytes and rejects PATH_MAX before copying", () => {
    const exact = makeScratchHarness();
    const exactPath = "x".repeat(POSIX_PATH_MAX_BYTES - 1);
    const exactSetCwd = vi.fn((
      pid: number,
      pointer: number,
      length: number,
    ) => {
      expect(pid).toBe(41);
      expect(pointer).toBe(exact.scratchOffset);
      expect(length).toBe(POSIX_PATH_MAX_BYTES - 1);
      expect(
        exact.kernelBytes.slice(pointer, pointer + length),
      ).toEqual(new TextEncoder().encode(exactPath));
      return 0;
    });
    Object.assign(exact.worker, {
      initialized: true,
      kernelInstance: { exports: { kernel_set_cwd: exactSetCwd } },
    });

    exact.worker.setCwd(41, exactPath);

    expect(exactSetCwd).toHaveBeenCalledOnce();
    expectScratchTailUntouched(exact);

    const oversized = makeScratchHarness();
    const oversizedSetCwd = vi.fn(() => -36);
    Object.assign(oversized.worker, {
      initialized: true,
      kernelInstance: { exports: { kernel_set_cwd: oversizedSetCwd } },
    });
    const scratchBeforeRejection = oversized.kernelBytes.slice(
      oversized.scratchOffset,
      oversized.scratchEnd,
    );

    expect(() =>
      oversized.worker.setCwd(41, "x".repeat(POSIX_PATH_MAX_BYTES))
    )
      .toThrow(/cwd|PATH_MAX|too long/i);

    expect(oversizedSetCwd).not.toHaveBeenCalled();
    expect(
      oversized.kernelBytes.slice(
        oversized.scratchOffset,
        oversized.scratchEnd,
      ),
    ).toEqual(scratchBeforeRejection);
    expectScratchTailUntouched(oversized);
  });

  it("fails loudly when the required bounded cwd export is absent", () => {
    const harness = makeScratchHarness();
    Object.assign(harness.worker, {
      initialized: true,
      kernelInstance: { exports: {} },
    });
    const scratchBefore = harness.kernelBytes.slice(
      harness.scratchOffset,
      harness.scratchEnd,
    );

    expect(() => harness.worker.setCwd(41, "/tmp"))
      .toThrow("Kernel missing required kernel_set_cwd export");
    expect(
      harness.kernelBytes.slice(
        harness.scratchOffset,
        harness.scratchEnd,
      ),
    ).toEqual(scratchBefore);
    expectScratchTailUntouched(harness);
  });

  it("lends getgroups exactly one gid slot and snapshots it before reuse", () => {
    const harness = makeScratchHarness();
    const destination = harness.processBytes.byteLength - 4;
    const gid = 0x1234_5678;
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const outputPointer = Number(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      const outputCapacity = Number(
        channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
      );
      expect(outputPointer).toBeGreaterThanOrEqual(
        harness.scratchOffset + CH_DATA,
      );
      expect(outputCapacity).toBe(4);
      new DataView(harness.kernelBytes.buffer).setUint32(
        outputPointer,
        gid,
        true,
      );
      channelView.setBigInt64(CH_RETURN, 1n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleGetgroups(
      harness.channel,
      [1, destination, 0, 0, 0, 0],
      [1n, BigInt(destination), 0n, 0n, 0n, 0n],
    );

    expect(harness.completeChannel).toHaveBeenCalledTimes(1);
    const completion = harness.completeChannel.mock.calls[0];
    expect(completion.slice(4, 6)).toEqual([1, 0]);
    expect(completion[6]).toEqual([{
      ptr: destination,
      bytes: new Uint8Array([0x78, 0x56, 0x34, 0x12]),
    }]);
    expectScratchTailUntouched(harness);
  });

  it("keeps a getgroups count query pointer-free", () => {
    const harness = makeScratchHarness(8);
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      expect(channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true)).toBe(0n);
      expect(channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true)).toBe(0n);
      channelView.setBigInt64(CH_RETURN, 1n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleGetgroups(
      harness.channel,
      [0, Number.MAX_SAFE_INTEGER, 0, 0, 0, 0],
      [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0n, 0n, 0n, 0n],
    );

    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Getgroups,
      [0, Number.MAX_SAFE_INTEGER, 0, 0, 0, 0],
      undefined,
      1,
      0,
      undefined,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["negative size", -1n, 1n, EINVAL],
    ["oversized size", 0x8000_0000n, 1n, EINVAL],
    ["null output", 1n, 0n, EFAULT],
  ] as const)(
    "rejects an invalid getgroups %s before kernel dispatch",
    (_name, size, pointer, errno) => {
      const harness = makeScratchHarness(8);
      harness.worker.handleGetgroups(
        harness.channel,
        [Number(size), Number(pointer), 0, 0, 0, 0],
        [size, pointer, 0n, 0n, 0n, 0n],
      );

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        errno,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it("accepts exact setgroups scratch capacity and rejects capacity plus one", () => {
    const exactCount = CH_DATA_SIZE / 4;
    for (const count of [exactCount, exactCount + 1]) {
      const harness = makeScratchHarness(8);
      prepareGenericSyscallHarness(harness, 8);
      const source = 4096;
      harness.processBytes.fill(
        0x4d,
        source,
        source + count * 4,
      );
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
        const scratchPointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        expect(scratchPointer).toBe(harness.scratchOffset + CH_DATA);
        expect(
          harness.kernelBytes.slice(
            scratchPointer,
            scratchPointer + CH_DATA_SIZE,
          ),
        ).toEqual(
          harness.processBytes.slice(source, source + CH_DATA_SIZE),
        );
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Setgroups, [
        BigInt(count),
        BigInt(source),
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).toHaveBeenCalledTimes(
        count === exactCount ? 1 : 0,
      );
      if (count === exactCount) {
        expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
          0,
          0,
        ]);
      } else {
        expect(harness.completeChannel).toHaveBeenCalledWith(
          harness.channel,
          ABI_SYSCALLS.Setgroups,
          [count, source, 0, 0, 0, 0],
          undefined,
          -1,
          EINVAL,
        );
      }
      expectScratchTailUntouched(harness);
    }
  });

  it("replaces an ignored zero-count pointer with checked non-null scratch", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    const ignoredPointer = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
      expect(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      ).toBe(BigInt(harness.scratchOffset + CH_DATA));
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    writeChannelSyscall(harness, ABI_SYSCALLS.Setgroups, [
      0n,
      ignoredPointer,
    ]);

    harness.worker._handleSyscallInner(harness.channel);

    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
      0,
      0,
    ]);
    expectScratchTailUntouched(harness);
  });

  it("rejects a null positive-count setgroups source before kernel dispatch", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    writeChannelSyscall(harness, ABI_SYSCALLS.Setgroups, [1n, 0n]);

    harness.worker._handleSyscallInner(harness.channel);

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Setgroups,
      [1, 0, 0, 0, 0, 0],
      undefined,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["wasm32", 4, "pipe", ABI_SYSCALLS.Pipe],
    ["wasm32", 4, "uname", ABI_SYSCALLS.Uname],
    ["wasm64", 8, "pipe", ABI_SYSCALLS.Pipe],
    ["wasm64", 8, "uname", ABI_SYSCALLS.Uname],
  ] as const)(
    "rejects a null positive-size fixed %s %s output before kernel dispatch",
    (_pointerKind, pointerWidth, _name, syscallNr) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      writeChannelSyscall(harness, syscallNr, [0n]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        syscallNr,
        [0, 0, 0, 0, 0, 0],
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", 4, "read", ABI_SYSCALLS.Read],
    ["wasm32", 4, "write", ABI_SYSCALLS.Write],
    ["wasm64", 8, "read", ABI_SYSCALLS.Read],
    ["wasm64", 8, "write", ABI_SYSCALLS.Write],
  ] as const)(
    "rejects a null positive-count %s %s buffer before kernel dispatch",
    (_pointerKind, pointerWidth, _name, syscallNr) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      writeChannelSyscall(harness, syscallNr, [7n, 0n, 1n]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        syscallNr,
        [7, 0, 1, 0, 0, 0],
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", 4, "read", ABI_SYSCALLS.Read],
    ["wasm32", 4, "write", ABI_SYSCALLS.Write],
    ["wasm64", 8, "read", ABI_SYSCALLS.Read],
    ["wasm64", 8, "write", ABI_SYSCALLS.Write],
  ] as const)(
    "maps a null zero-count %s %s buffer to owned empty scratch",
    (_pointerKind, pointerWidth, _name, syscallNr) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        expect(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        ).toBe(BigInt(harness.scratchOffset + CH_DATA));
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, syscallNr, [7n, 0n, 0n]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0,
        0,
      ]);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", 4, 1n],
    ["wasm64", 8, 0x7fff_ffff_0000_0001n],
  ] as const)(
    "keeps a scalar %s prctl argument out of scratch",
    (_pointerKind, pointerWidth, rawScalar) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        expect(channelView.getBigInt64(CH_ARGS, true)).toBe(
          BigInt(PR_SET_NO_NEW_PRIVS),
        );
        expect(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        ).toBe(1n);
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Prctl, [
        BigInt(PR_SET_NO_NEW_PRIVS),
        rawScalar,
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0,
        0,
      ]);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", "set", 4, PR_SET_NAME, "in"],
    ["wasm32", "get", 4, PR_GET_NAME, "out"],
    ["wasm64", "set", 8, PR_SET_NAME, "in"],
    ["wasm64", "get", 8, PR_GET_NAME, "out"],
  ] as const)(
    "stages only the exact %s prctl %s-name buffer",
    (_pointerKind, _operation, pointerWidth, option, direction) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const processPointer = 4096;
      const input = Uint8Array.from(
        { length: PRCTL_NAME_BYTES },
        (_, index) => 0x20 + index,
      );
      const output = Uint8Array.from(
        { length: PRCTL_NAME_BYTES },
        (_, index) => 0x70 + index,
      );
      if (direction === "in") {
        harness.processBytes.set(input, processPointer);
      }
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        const scratchPointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        expect(scratchPointer).toBe(harness.scratchOffset + CH_DATA);
        if (direction === "in") {
          expect(
            harness.kernelBytes.slice(
              scratchPointer,
              scratchPointer + PRCTL_NAME_BYTES,
            ),
          ).toEqual(input);
        } else {
          harness.kernelBytes.set(output, scratchPointer);
        }
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Prctl, [
        BigInt(option),
        BigInt(processPointer),
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      if (direction === "out") {
        const writes = harness.completeChannel.mock.calls[0]?.[6] as
          Array<{ ptr: number; bytes: Uint8Array }>;
        expect(writes).toEqual([{ ptr: processPointer, bytes: output }]);
      }
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", 4, PR_SET_NAME],
    ["wasm32", 4, PR_GET_NAME],
    ["wasm64", 8, PR_SET_NAME],
    ["wasm64", 8, PR_GET_NAME],
  ] as const)(
    "rejects a null %s prctl name buffer before kernel dispatch",
    (_pointerKind, pointerWidth, option) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      writeChannelSyscall(harness, ABI_SYSCALLS.Prctl, [
        BigInt(option),
        0n,
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Prctl,
        [option, 0, 0, 0, 0, 0],
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

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
    const kernelIovPointers: number[] = [];
    const defaultHandleChannel = harness.handleChannel.getMockImplementation()!;
    harness.handleChannel.mockImplementation((...args: unknown[]) => {
      const view = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      kernelIovPointers.push(
        Number(view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true)),
      );
      return defaultHandleChannel(...args);
    });

    harness.worker.handleWritev(
      harness.channel,
      ABI_SYSCALLS.Writev,
      [7, iovPtr, entries.length, 0, 0, 0],
    );

    expectScratchTailUntouched(harness);
    for (const kernelIov of kernelIovPointers) {
      expect(kernelIov).toBeGreaterThanOrEqual(harness.scratchOffset + CH_DATA);
      expect(kernelIov + 8).toBeLessThanOrEqual(harness.scratchEnd);
    }
  });

  it.each([
    ["writev", "handleWritev", ABI_SYSCALLS.Writev, true],
    ["readv", "handleReadv", ABI_SYSCALLS.Readv, false],
  ] as const)(
    "%s switches from one exact-capacity call to bounded chunks at capacity plus one",
    (_name, method, syscallNr, input) => {
      const exactDataCapacity = CH_DATA_SIZE - 8;
      expect(exactDataCapacity).toBe(65_528);

      for (const length of [exactDataCapacity, exactDataCapacity + 1]) {
        const harness = makeScratchHarness();
        const iovPointer = 256;
        const dataPointer = 65_536;
        const payload = Uint8Array.from(
          { length },
          (_, index) => (index * 17 + 3) % 251,
        );
        const callerCanary = 0x7e;
        writeNativeIovec(
          harness.processBytes,
          4,
          iovPointer,
          dataPointer,
          length,
        );
        if (input) {
          harness.processBytes.set(payload, dataPointer);
        } else {
          harness.processBytes.fill(
            0x6d,
            dataPointer,
            dataPointer + length,
          );
        }
        harness.processBytes[dataPointer + length] = callerCanary;

        let transferred = 0;
        const chunkLengths: number[] = [];
        harness.handleChannel.mockImplementation((offset: number | bigint) => {
          const channelView = new DataView(
            harness.kernelBytes.buffer,
            offset,
          );
          const kernelIovecPointer = Number(
            channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
          );
          const kernelView = new DataView(harness.kernelBytes.buffer);
          const kernelDataPointer = kernelView.getUint32(
            kernelIovecPointer,
            true,
          );
          const chunkLength = kernelView.getUint32(
            kernelIovecPointer + 4,
            true,
          );
          expect(kernelIovecPointer).toBe(
            harness.scratchOffset + CH_DATA,
          );
          expect(kernelDataPointer).toBe(kernelIovecPointer + 8);
          expect(kernelDataPointer + chunkLength)
            .toBeLessThanOrEqual(harness.scratchEnd);
          chunkLengths.push(chunkLength);
          const chunk = payload.subarray(
            transferred,
            transferred + chunkLength,
          );
          if (input) {
            expect(
              harness.kernelBytes.slice(
                kernelDataPointer,
                kernelDataPointer + chunkLength,
              ),
            ).toEqual(chunk);
          } else {
            harness.kernelBytes.set(chunk, kernelDataPointer);
          }
          transferred += chunkLength;
          channelView.setBigInt64(CH_RETURN, BigInt(chunkLength), true);
          channelView.setUint32(CH_ERRNO, 0, true);
          return 0;
        });

        harness.worker[method](
          harness.channel,
          syscallNr,
          [7, iovPointer, 1, 0, 0, 0],
        );

        expect(chunkLengths).toEqual(
          length === exactDataCapacity
            ? [exactDataCapacity]
            : [exactDataCapacity, 1],
        );
        expect(transferred).toBe(length);
        expect(
          harness.processBytes.slice(
            dataPointer,
            dataPointer + length,
          ),
        ).toEqual(payload);
        expect(harness.processBytes[dataPointer + length])
          .toBe(callerCanary);
        if (length === exactDataCapacity) {
          expect(harness.completeChannel.mock.calls[0]?.slice(4, 6))
            .toEqual([length, 0]);
          expect(harness.completeChannelRaw).not.toHaveBeenCalled();
        } else if (input) {
          expect(harness.completeChannel).not.toHaveBeenCalled();
          expect(harness.completeChannelRaw).toHaveBeenCalledWith(
            harness.channel,
            length,
            0,
          );
        } else {
          expect(harness.completeChannel.mock.calls[0]?.slice(4, 6))
            .toEqual([length, 0]);
          expect(harness.completeChannelRaw).not.toHaveBeenCalled();
        }
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "accepts a bounded wasm%s iovec table at caller address zero",
    (pointerWidth) => {
      const dataPointer = 2048;
      const payload = Uint8Array.from([1, 2, 3, 4]);
      for (const path of IOVEC_HANDLER_PATHS) {
        const harness = makeScratchHarness(pointerWidth);
        writeNativeIovec(
          harness.processBytes,
          pointerWidth,
          0,
          dataPointer,
          payload.byteLength,
        );
        if (path.input) {
          harness.processBytes.set(payload, dataPointer);
        } else {
          harness.processBytes.fill(
            0x6d,
            dataPointer,
            dataPointer + payload.byteLength,
          );
        }
        respondToSingleKernelIovec(harness, path, payload);

        invokeIovecHandler(harness, pointerWidth, path, 0);

        expect(harness.handleChannel, path.name).toHaveBeenCalledOnce();
        expect(
          harness.completeChannel.mock.calls[0]?.slice(4, 6),
          path.name,
        ).toEqual([payload.byteLength, 0]);
        if (!path.input) {
          expect(
            harness.processBytes.slice(
              dataPointer,
              dataPointer + payload.byteLength,
            ),
            path.name,
          ).toEqual(payload);
        }
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "accepts bounded positive-length wasm%s iovec data at caller address zero",
    (pointerWidth) => {
      const iovPointer = 512;
      const payload = Uint8Array.from([5, 6, 7, 8]);
      for (const path of IOVEC_HANDLER_PATHS) {
        const harness = makeScratchHarness(pointerWidth);
        writeNativeIovec(
          harness.processBytes,
          pointerWidth,
          iovPointer,
          0,
          payload.byteLength,
        );
        if (path.input) {
          harness.processBytes.set(payload, 0);
        } else {
          harness.processBytes.fill(0x6d, 0, payload.byteLength);
        }
        respondToSingleKernelIovec(harness, path, payload);

        invokeIovecHandler(harness, pointerWidth, path, iovPointer);

        expect(harness.handleChannel, path.name).toHaveBeenCalledOnce();
        expect(
          harness.completeChannel.mock.calls[0]?.slice(4, 6),
          path.name,
        ).toEqual([payload.byteLength, 0]);
        if (!path.input) {
          expect(
            harness.processBytes.slice(0, payload.byteLength),
            path.name,
          ).toEqual(payload);
        }
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "accepts a zero-length wasm%s iovec with base address zero",
    (pointerWidth) => {
      const iovPointer = 512;
      for (const path of IOVEC_HANDLER_PATHS) {
        const harness = makeScratchHarness(pointerWidth);
        harness.processBytes.fill(0x6d, 0, 16);
        const addressZeroBefore = harness.processBytes.slice(0, 16);
        writeNativeIovec(
          harness.processBytes,
          pointerWidth,
          iovPointer,
          0,
          0,
        );
        respondToSingleKernelIovec(harness, path, new Uint8Array(0));

        invokeIovecHandler(harness, pointerWidth, path, iovPointer);

        expect(harness.handleChannel, path.name).toHaveBeenCalledOnce();
        expect(
          harness.completeChannel.mock.calls[0]?.slice(4, 6),
          path.name,
        ).toEqual([0, 0]);
        expect(harness.processBytes.slice(0, 16), path.name)
          .toEqual(addressZeroBefore);
        expectScratchTailUntouched(harness);
      }
    },
  );

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
    ["sendmsg", "handleSendmsg", true],
    ["recvmsg", "handleRecvmsg", false],
  ] as const)(
    "accepts an exact-capacity one-entry %s layout and rejects capacity plus one",
    (_name, method, input) => {
      const exactDataCapacity = CH_DATA_SIZE -
        STRUCT_SIZE_KERNEL_MSGHDR_WIRE -
        STRUCT_SIZE_KERNEL_IOVEC_WIRE;
      expect(exactDataCapacity).toBe(65_500);

      for (const length of [exactDataCapacity, exactDataCapacity + 1]) {
        const harness = makeScratchHarness();
        const messagePointer = 128;
        const iovecPointer = 512;
        const dataPointer = 65_536;
        const payload = Uint8Array.from(
          { length },
          (_, index) => (index * 19 + 5) % 251,
        );
        const callerCanary = 0x7e;
        const processView = new DataView(harness.processBytes.buffer);
        processView.setUint32(messagePointer + 8, iovecPointer, true);
        processView.setUint32(messagePointer + 12, 1, true);
        writeNativeIovec(
          harness.processBytes,
          4,
          iovecPointer,
          dataPointer,
          length,
        );
        if (input) {
          harness.processBytes.set(payload, dataPointer);
        } else {
          harness.processBytes.fill(
            0x6d,
            dataPointer,
            dataPointer + length,
          );
        }
        harness.processBytes[dataPointer + length] = callerCanary;
        const scratchBeforeRejection = harness.kernelBytes.slice(
          harness.scratchOffset,
          harness.scratchEnd,
        );

        harness.handleChannel.mockImplementation((offset: number | bigint) => {
          const channelView = new DataView(
            harness.kernelBytes.buffer,
            offset,
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
          expect(kernelMessagePointer).toBe(
            harness.scratchOffset + CH_DATA,
          );
          expect(kernelIovecPointer).toBe(
            kernelMessagePointer + STRUCT_SIZE_KERNEL_MSGHDR_WIRE,
          );
          expect(
            kernelView.getUint32(kernelMessagePointer + 12, true),
          ).toBe(1);
          expect(
            kernelView.getUint32(kernelIovecPointer + 4, true),
          ).toBe(length);
          expect(kernelDataPointer).toBe(kernelIovecPointer + 8);
          expect(kernelDataPointer + length).toBe(harness.scratchEnd);
          if (input) {
            expect(
              harness.kernelBytes.slice(
                kernelDataPointer,
                kernelDataPointer + length,
              ),
            ).toEqual(payload);
          } else {
            harness.kernelBytes.set(payload, kernelDataPointer);
          }
          channelView.setBigInt64(CH_RETURN, BigInt(length), true);
          channelView.setUint32(CH_ERRNO, 0, true);
          return 0;
        });

        harness.worker[method](
          harness.channel,
          [7, messagePointer, 0, 0, 0, 0],
        );

        if (length === exactDataCapacity) {
          expect(harness.handleChannel).toHaveBeenCalledOnce();
          expect(harness.completeChannel.mock.calls[0]?.slice(4, 6))
            .toEqual([length, 0]);
          if (!input) {
            expect(
              harness.processBytes.slice(
                dataPointer,
                dataPointer + length,
              ),
            ).toEqual(payload);
          }
        } else {
          expect(harness.handleChannel).not.toHaveBeenCalled();
          expect(harness.completeChannelRaw).toHaveBeenCalledWith(
            harness.channel,
            -1,
            90,
          );
          expect(
            harness.kernelBytes.slice(
              harness.scratchOffset,
              harness.scratchEnd,
            ),
          ).toEqual(scratchBeforeRejection);
        }
        expect(harness.processBytes[dataPointer + length])
          .toBe(callerCanary);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([
    ["sendmsg", "handleSendmsg"],
    ["recvmsg", "handleRecvmsg"],
  ] as const)(
    "flattens exactly IOV_MAX zero-length %s entries to one empty wire iovec",
    (_name, method) => {
      const harness = makeScratchHarness();
      const messagePointer = 128;
      const iovecPointer = 1024;
      const processView = new DataView(harness.processBytes.buffer);
      processView.setUint32(messagePointer + 8, iovecPointer, true);
      processView.setUint32(messagePointer + 12, IOV_MAX, true);
      writeWasm32Iovecs(
        harness.processBytes,
        iovecPointer,
        Array.from({ length: IOV_MAX }, () => ({ base: 0, len: 0 })),
      );
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          offset,
        );
        const kernelMessagePointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const kernelView = new DataView(harness.kernelBytes.buffer);
        const kernelIovecPointer = kernelView.getUint32(
          kernelMessagePointer + 8,
          true,
        );
        expect(kernelMessagePointer).toBe(
          harness.scratchOffset + CH_DATA,
        );
        expect(kernelIovecPointer).toBe(
          kernelMessagePointer + STRUCT_SIZE_KERNEL_MSGHDR_WIRE,
        );
        expect(
          kernelView.getUint32(
            kernelMessagePointer + KERNEL_MSGHDR_WIRE_IOVLEN_OFFSET,
            true,
          ),
        ).toBe(KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT);
        expect(
          kernelIovecPointer + STRUCT_SIZE_KERNEL_IOVEC_WIRE,
        ).toBeLessThanOrEqual(harness.scratchEnd);
        expect(
          harness.kernelBytes.slice(
            kernelIovecPointer,
            kernelIovecPointer + STRUCT_SIZE_KERNEL_IOVEC_WIRE,
          ),
        ).toEqual(new Uint8Array(STRUCT_SIZE_KERNEL_IOVEC_WIRE));
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker[method](
        harness.channel,
        [7, messagePointer, 0, 0, 0, 0],
      );

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6))
        .toEqual([0, 0]);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    [4, "sendmsg", "handleSendmsg", true],
    [8, "sendmsg", "handleSendmsg", true],
    [4, "recvmsg", "handleRecvmsg", false],
    [8, "recvmsg", "handleRecvmsg", false],
  ] as const)(
    "uses one canonical wire iovec for wasm%s multi-iovec %s",
    (pointerWidth, _name, method, input) => {
      const harness = makeScratchHarness(pointerWidth);
      const messagePointer = 128;
      const iovecPointer = 512;
      const firstPointer = 4096;
      const secondPointer = 8192;
      const payload = Uint8Array.from([1, 2, 3, 4, 5]);
      const entrySize = pointerWidth === 8 ? 16 : 8;
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        iovecPointer,
        firstPointer,
        2,
      );
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        iovecPointer + entrySize,
        0,
        0,
      );
      writeNativeIovec(
        harness.processBytes,
        pointerWidth,
        iovecPointer + 2 * entrySize,
        secondPointer,
        3,
      );
      writeNativeMessage(
        harness.processBytes,
        pointerWidth,
        messagePointer,
        { iovecPointer, iovecCount: 3 },
      );
      if (input) {
        harness.processBytes.set(payload.subarray(0, 2), firstPointer);
        harness.processBytes.set(payload.subarray(2), secondPointer);
      } else {
        harness.processBytes.fill(0x61, firstPointer, firstPointer + 2);
        harness.processBytes.fill(0x62, secondPointer, secondPointer + 3);
      }
      harness.processBytes[firstPointer + 2] = 0x91;
      harness.processBytes[secondPointer + 3] = 0x92;

      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
        const kernelMessagePointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const kernelView = new DataView(harness.kernelBytes.buffer);
        expect(
          kernelView.getUint32(
            kernelMessagePointer + KERNEL_MSGHDR_WIRE_IOVLEN_OFFSET,
            true,
          ),
        ).toBe(KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT);
        const kernelIovecPointer = kernelView.getUint32(
          kernelMessagePointer + KERNEL_MSGHDR_WIRE_IOV_OFFSET,
          true,
        );
        const kernelDataPointer = kernelView.getUint32(
          kernelIovecPointer + KERNEL_IOVEC_WIRE_BASE_OFFSET,
          true,
        );
        expect(
          kernelView.getUint32(
            kernelIovecPointer + KERNEL_IOVEC_WIRE_LEN_OFFSET,
            true,
          ),
        ).toBe(payload.length);
        if (input) {
          expect(
            harness.kernelBytes.slice(
              kernelDataPointer,
              kernelDataPointer + payload.length,
            ),
          ).toEqual(payload);
        } else {
          harness.kernelBytes.set(payload, kernelDataPointer);
        }
        channelView.setBigInt64(CH_RETURN, BigInt(payload.length), true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker[method](
        harness.channel,
        [7, messagePointer, 0, 0, 0, 0],
      );

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6))
        .toEqual([payload.length, 0]);
      if (!input) {
        expect(
          harness.processBytes.slice(firstPointer, firstPointer + 2),
        ).toEqual(payload.subarray(0, 2));
        expect(
          harness.processBytes.slice(secondPointer, secondPointer + 3),
        ).toEqual(payload.subarray(2));
      }
      expect(harness.processBytes[firstPointer + 2]).toBe(0x91);
      expect(harness.processBytes[secondPointer + 3]).toBe(0x92);
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
      [7, msgPtr, SOCKET_MSG_TRUNC, 0, 0, 0],
    );

    expect(harness.processBytes.slice(destination, destination + 4)).toEqual(
      new TextEncoder().encode("recv"),
    );
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Recvmsg,
      [7, msgPtr, SOCKET_MSG_TRUNC, 0, 0, 0],
      undefined,
      payloadLength,
      0,
    );
    expectScratchTailUntouched(harness);
  });

  it("does not publish staged recvmsg output while an EAGAIN retry is parked", () => {
    const harness = makeScratchHarness();
    const msgPtr = 128;
    const iovPtr = 1024;
    const dataPtr = 2048;
    const namePtr = 4096;
    const controlPtr = 8192;
    const view = new DataView(harness.processBytes.buffer);
    view.setUint32(msgPtr, namePtr, true);
    view.setUint32(msgPtr + 4, 16, true);
    view.setUint32(msgPtr + 8, iovPtr, true);
    view.setUint32(msgPtr + 12, 1, true);
    view.setUint32(msgPtr + 16, controlPtr, true);
    view.setUint32(msgPtr + 20, 16, true);
    writeWasm32Iovecs(
      harness.processBytes,
      iovPtr,
      [{ base: dataPtr, len: 16 }],
    );
    harness.processBytes.fill(0x5a, dataPtr, dataPtr + 16);
    harness.processBytes.fill(0x6b, namePtr, namePtr + 16);
    harness.processBytes.fill(0x7c, controlPtr, controlPtr + 16);
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      channelView.setBigInt64(CH_RETURN, -1n, true);
      channelView.setUint32(CH_ERRNO, EAGAIN, true);
      return 0;
    });

    harness.worker.handleRecvmsg(
      harness.channel,
      [7, msgPtr, 0, 0, 0, 0],
    );

    expect(harness.processBytes.slice(dataPtr, dataPtr + 16))
      .toEqual(new Uint8Array(16).fill(0x5a));
    expect(harness.processBytes.slice(namePtr, namePtr + 16))
      .toEqual(new Uint8Array(16).fill(0x6b));
    expect(harness.processBytes.slice(controlPtr, controlPtr + 16))
      .toEqual(new Uint8Array(16).fill(0x7c));
    expect(view.getUint32(msgPtr + 4, true)).toBe(16);
    expect(view.getUint32(msgPtr + 20, true)).toBe(16);
    expect(harness.worker.handleBlockingRetry).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Recvmsg,
      [7, msgPtr, 0, 0, 0, 0],
    );
    expectScratchTailUntouched(harness);
  });

  it("rejects a wrapped wasm32 ancillary length before scratch mutation", () => {
    const harness = makeScratchHarness(4);
    const messagePointer = 128;
    const controlPointer = 2048;
    const controlLength = 28;
    const secondRecordOffset = alignUp(
      PROCESS_CMSGHDR_WASM32_DATA_OFFSET,
      PROCESS_CMSGHDR_WASM32_ALIGN,
    );
    const view = new DataView(harness.processBytes.buffer);
    view.setUint32(
      controlPointer + PROCESS_CMSGHDR_WASM32_LEN_OFFSET,
      PROCESS_CMSGHDR_WASM32_DATA_OFFSET,
      true,
    );
    view.setUint32(
      controlPointer + secondRecordOffset +
        PROCESS_CMSGHDR_WASM32_LEN_OFFSET,
      0xffff_fff8,
      true,
    );
    view.setUint32(
      controlPointer + secondRecordOffset +
        PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET,
      SOCKET_SOL_SOCKET,
      true,
    );
    view.setUint32(
      controlPointer + secondRecordOffset +
        PROCESS_CMSGHDR_WASM32_TYPE_OFFSET,
      SOCKET_SCM_RIGHTS,
      true,
    );
    writeNativeMessage(harness.processBytes, 4, messagePointer, {
      controlPointer,
      controlLength,
    });
    const scratchBefore = harness.kernelBytes.slice(
      harness.scratchOffset,
      harness.scratchEnd,
    );

    harness.worker.handleSendmsg(
      harness.channel,
      [7, messagePointer, 0, 0, 0, 0],
    );

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EINVAL,
    );
    expect(
      harness.kernelBytes.slice(
        harness.scratchOffset,
        harness.scratchEnd,
      ),
    ).toEqual(scratchBefore);
    expectScratchTailUntouched(harness);
  });

  it.each([4, 8] as const)(
    "translates wasm%s SCM_RIGHTS records to canonical wire bytes across sequential reuse",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      const messagePointer = 128;
      const controlPointer = 2048;
      const calls = [
        [[17], [23, 24]],
        [[31]],
      ];
      let callIndex = 0;
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const expected = canonicalRightsBytes(calls[callIndex]);
        const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
        const kernelMessagePointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const kernelView = new DataView(harness.kernelBytes.buffer);
        const kernelControlPointer = kernelView.getUint32(
          kernelMessagePointer + KERNEL_MSGHDR_WIRE_CONTROL_OFFSET,
          true,
        );
        expect(
          kernelView.getUint32(
            kernelMessagePointer +
              KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
            true,
          ),
        ).toBe(expected.length);
        expect(
          harness.kernelBytes.slice(
            kernelControlPointer,
            kernelControlPointer + expected.length,
          ),
        ).toEqual(expected);
        expect(
          kernelView.getUint32(
            kernelMessagePointer + KERNEL_MSGHDR_WIRE_IOVLEN_OFFSET,
            true,
          ),
        ).toBe(0);
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        callIndex += 1;
        return 0;
      });

      for (const records of calls) {
        const controlLength = writeNativeRightsRecords(
          harness.processBytes,
          pointerWidth,
          controlPointer,
          records,
        );
        writeNativeMessage(
          harness.processBytes,
          pointerWidth,
          messagePointer,
          { controlPointer, controlLength },
        );
        if (pointerWidth === 8) {
          new DataView(harness.processBytes.buffer).setUint32(
            messagePointer + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET + 4,
            0xa5a5_a5a5,
            true,
          );
        }
        harness.worker.handleSendmsg(
          harness.channel,
          [7, messagePointer, 0, 0, 0, 0],
        );
      }

      expect(harness.handleChannel).toHaveBeenCalledTimes(calls.length);
      expect(harness.completeChannel).toHaveBeenCalledTimes(calls.length);
      if (pointerWidth === 8) {
        expect(
          new DataView(harness.processBytes.buffer).getUint32(
            messagePointer + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET + 4,
            true,
          ),
        ).toBe(0xa5a5_a5a5);
      }
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    {
      pointerWidth: 4 as const,
      capacity: 15,
      wireCapacity: 0,
      descriptors: [] as number[],
      reportedLength: 0,
      flags: MSG_CTRUNC,
    },
    {
      pointerWidth: 4 as const,
      capacity: 16,
      wireCapacity: 16,
      descriptors: [61],
      reportedLength: 16,
      flags: 0,
    },
    {
      pointerWidth: 4 as const,
      capacity: 19,
      wireCapacity: 16,
      descriptors: [62],
      reportedLength: 16,
      flags: 0,
    },
    {
      pointerWidth: 4 as const,
      capacity: 20,
      wireCapacity: 20,
      descriptors: [63, 64],
      reportedLength: 20,
      flags: 0,
    },
    {
      pointerWidth: 8 as const,
      capacity: 19,
      wireCapacity: 0,
      descriptors: [] as number[],
      reportedLength: 0,
      flags: MSG_CTRUNC,
    },
    {
      pointerWidth: 8 as const,
      capacity: 20,
      wireCapacity: 16,
      descriptors: [71],
      reportedLength: 20,
      flags: 0,
    },
    {
      pointerWidth: 8 as const,
      capacity: 23,
      wireCapacity: 16,
      descriptors: [72],
      reportedLength: 23,
      flags: 0,
    },
    {
      pointerWidth: 8 as const,
      capacity: 24,
      wireCapacity: 20,
      descriptors: [73],
      reportedLength: 24,
      flags: 0,
    },
    {
      pointerWidth: 8 as const,
      capacity: 24,
      wireCapacity: 20,
      descriptors: [74, 75],
      reportedLength: 24,
      flags: 0,
    },
  ])(
    "maps wasm$pointerWidth recvmsg control capacity $capacity to $wireCapacity canonical bytes",
    ({
      pointerWidth,
      capacity,
      wireCapacity,
      descriptors,
      reportedLength,
      flags,
    }) => {
      const harness = makeScratchHarness(pointerWidth);
      const messagePointer = 128;
      const controlPointer = 2048;
      const controlCanary = 0x6d;
      const native = pointerWidth === 8
        ? {
            dataOffset: PROCESS_CMSGHDR_WASM64_DATA_OFFSET,
            lengthOffset: PROCESS_CMSGHDR_WASM64_LEN_OFFSET,
            levelOffset: PROCESS_CMSGHDR_WASM64_LEVEL_OFFSET,
            typeOffset: PROCESS_CMSGHDR_WASM64_TYPE_OFFSET,
          }
        : {
            dataOffset: PROCESS_CMSGHDR_WASM32_DATA_OFFSET,
            lengthOffset: PROCESS_CMSGHDR_WASM32_LEN_OFFSET,
            levelOffset: PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET,
            typeOffset: PROCESS_CMSGHDR_WASM32_TYPE_OFFSET,
          };
      const messageControlLengthOffset = pointerWidth === 8
        ? PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET
        : PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET;
      const messageFlagsOffset = pointerWidth === 8
        ? PROCESS_MSGHDR_WASM64_FLAGS_OFFSET
        : PROCESS_MSGHDR_WASM32_FLAGS_OFFSET;
      harness.processBytes.fill(
        controlCanary,
        controlPointer,
        controlPointer + capacity + 1,
      );
      writeNativeMessage(harness.processBytes, pointerWidth, messagePointer, {
        controlPointer,
        controlLength: capacity,
      });
      const processView = new DataView(harness.processBytes.buffer);
      if (pointerWidth === 8) {
        processView.setUint32(
          messagePointer + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET + 4,
          0xa5a5_a5a5,
          true,
        );
      }

      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
        const kernelMessagePointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const kernelView = new DataView(harness.kernelBytes.buffer);
        const kernelControlPointer = kernelView.getUint32(
          kernelMessagePointer + KERNEL_MSGHDR_WIRE_CONTROL_OFFSET,
          true,
        );
        expect(
          kernelView.getUint32(
            kernelMessagePointer +
              KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
            true,
          ),
        ).toBe(wireCapacity);
        expect(kernelControlPointer === 0).toBe(wireCapacity === 0);
        const wire = descriptors.length > 0
          ? canonicalRightsBytes([descriptors])
          : new Uint8Array(0);
        if (wire.length > 0) {
          harness.kernelBytes.set(wire, kernelControlPointer);
        }
        kernelView.setUint32(
          kernelMessagePointer +
            KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
          wire.length,
          true,
        );
        kernelView.setUint32(
          kernelMessagePointer + KERNEL_MSGHDR_WIRE_FLAGS_OFFSET,
          flags,
          true,
        );
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker.handleRecvmsg(
        harness.channel,
        [7, messagePointer, 0, 0, 0, 0],
      );

      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6))
        .toEqual([0, 0]);
      expect(
        processView.getUint32(
          messagePointer + messageControlLengthOffset,
          true,
        ),
      ).toBe(reportedLength);
      if (pointerWidth === 8) {
        expect(
          processView.getUint32(
            messagePointer + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET + 4,
            true,
          ),
        ).toBe(0xa5a5_a5a5);
      }
      expect(
        processView.getUint32(
          messagePointer + messageFlagsOffset,
          true,
        ),
      ).toBe(flags);
      if (descriptors.length === 0) {
        expect(
          harness.processBytes.slice(
            controlPointer,
            controlPointer + capacity,
          ),
        ).toEqual(new Uint8Array(capacity).fill(controlCanary));
      } else {
        const nativeLength = native.dataOffset +
          descriptors.length * SCM_RIGHTS_FD_BYTES;
        expect(
          processView.getUint32(
            controlPointer + native.lengthOffset,
            true,
          ),
        ).toBe(nativeLength);
        expect(
          processView.getUint32(
            controlPointer + native.levelOffset,
            true,
          ),
        ).toBe(SOCKET_SOL_SOCKET);
        expect(
          processView.getUint32(
            controlPointer + native.typeOffset,
            true,
          ),
        ).toBe(SOCKET_SCM_RIGHTS);
        if (pointerWidth === 8) {
          expect(
            harness.processBytes.slice(
              controlPointer + PROCESS_CMSGHDR_WASM64_LEN_OFFSET + 4,
              controlPointer + PROCESS_CMSGHDR_WASM64_LEVEL_OFFSET,
            ),
          ).toEqual(new Uint8Array(4));
        }
        descriptors.forEach((descriptor, index) => {
          expect(
            processView.getInt32(
              controlPointer + native.dataOffset +
                index * SCM_RIGHTS_FD_BYTES,
              true,
            ),
          ).toBe(descriptor);
        });
        expect(
          harness.processBytes.slice(
            controlPointer + nativeLength,
            controlPointer + reportedLength,
          ),
        ).toEqual(new Uint8Array(reportedLength - nativeLength));
      }
      expect(harness.processBytes[controlPointer + reportedLength])
        .toBe(controlCanary);
      expectScratchTailUntouched(harness);
    },
  );

  it("rejects recvmsg canonical control capacity plus one without guest writes", () => {
    const harness = makeScratchHarness(8);
    const messagePointer = 128;
    const iovecPointer = 512;
    const namePointer = 1024;
    const controlPointer = 2048;
    const dataPointer = 4096;
    const controlCapacity = 20;
    writeNativeIovec(
      harness.processBytes,
      8,
      iovecPointer,
      dataPointer,
      4,
    );
    writeNativeMessage(harness.processBytes, 8, messagePointer, {
      namePointer,
      nameLength: 4,
      iovecPointer,
      iovecCount: 1,
      controlPointer,
      controlLength: controlCapacity,
      flags: 0x1122_3344,
    });
    harness.processBytes.fill(0x51, namePointer, namePointer + 4);
    harness.processBytes.fill(
      0x52,
      controlPointer,
      controlPointer + controlCapacity,
    );
    harness.processBytes.fill(0x53, dataPointer, dataPointer + 4);
    const messageBefore = harness.processBytes.slice(
      messagePointer,
      messagePointer + PROCESS_MSGHDR_WASM64_SIZE,
    );
    const nameBefore = harness.processBytes.slice(namePointer, namePointer + 4);
    const controlBefore = harness.processBytes.slice(
      controlPointer,
      controlPointer + controlCapacity,
    );
    const dataBefore = harness.processBytes.slice(dataPointer, dataPointer + 4);

    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
      const kernelMessagePointer = Number(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      const kernelView = new DataView(harness.kernelBytes.buffer);
      const kernelNamePointer = kernelView.getUint32(
        kernelMessagePointer + KERNEL_MSGHDR_WIRE_NAME_OFFSET,
        true,
      );
      const kernelControlPointer = kernelView.getUint32(
        kernelMessagePointer + KERNEL_MSGHDR_WIRE_CONTROL_OFFSET,
        true,
      );
      const kernelIovecPointer = kernelView.getUint32(
        kernelMessagePointer + KERNEL_MSGHDR_WIRE_IOV_OFFSET,
        true,
      );
      const kernelDataPointer = kernelView.getUint32(
        kernelIovecPointer + KERNEL_IOVEC_WIRE_BASE_OFFSET,
        true,
      );
      harness.kernelBytes.set(
        new TextEncoder().encode("name"),
        kernelNamePointer,
      );
      harness.kernelBytes.set(
        canonicalRightsBytes([[81]]),
        kernelControlPointer,
      );
      harness.kernelBytes.set(
        new TextEncoder().encode("data"),
        kernelDataPointer,
      );
      kernelView.setUint32(
        kernelMessagePointer + KERNEL_MSGHDR_WIRE_NAMELEN_OFFSET,
        4,
        true,
      );
      kernelView.setUint32(
        kernelMessagePointer + KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
        17,
        true,
      );
      kernelView.setUint32(
        kernelMessagePointer + KERNEL_MSGHDR_WIRE_FLAGS_OFFSET,
        0x40,
        true,
      );
      channelView.setBigInt64(CH_RETURN, 4n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleRecvmsg(
      harness.channel,
      [7, messagePointer, 0, 0, 0, 0],
    );

    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EIO,
    );
    expect(
      harness.processBytes.slice(
        messagePointer,
        messagePointer + PROCESS_MSGHDR_WASM64_SIZE,
      ),
    ).toEqual(messageBefore);
    expect(harness.processBytes.slice(namePointer, namePointer + 4))
      .toEqual(nameBefore);
    expect(
      harness.processBytes.slice(
        controlPointer,
        controlPointer + controlCapacity,
      ),
    ).toEqual(controlBefore);
    expect(harness.processBytes.slice(dataPointer, dataPointer + 4))
      .toEqual(dataBefore);
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
    ["sendmsg", "handleSendmsg"],
    ["recvmsg", "handleRecvmsg"],
  ] as const)(
    "validates the complete 56-byte wasm64 %s msghdr",
    (_name, method) => {
      const harness = makeScratchHarness(8);
      const msgPtr = harness.processBytes.byteLength - 48;

      harness.worker[method](
        harness.channel,
        [7, msgPtr, 0, 0, 0, 0],
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

  it("writes wasm64 recvmsg flags after musl's msg_controllen padding", () => {
    const harness = makeScratchHarness(8);
    const msgPtr = 128;
    const controlPtr = 2048;
    const view = new DataView(harness.processBytes.buffer);
    writeNativeMessage(harness.processBytes, 8, msgPtr, {
      controlPointer: controlPtr,
      controlLength: 8,
    });
    view.setUint32(
      msgPtr + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET + 4,
      0xa5a5_a5a5,
      true,
    );
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const kernelMessagePointer = Number(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      const kernelMessage = new DataView(
        harness.kernelBytes.buffer,
        kernelMessagePointer,
        STRUCT_SIZE_KERNEL_MSGHDR_WIRE,
      );
      kernelMessage.setUint32(
        KERNEL_MSGHDR_WIRE_CONTROLLEN_OFFSET,
        0,
        true,
      );
      kernelMessage.setUint32(KERNEL_MSGHDR_WIRE_FLAGS_OFFSET, 0x40, true);
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleRecvmsg(
      harness.channel,
      [7, msgPtr, 0, 0, 0, 0],
    );

    expect(
      view.getUint32(
        msgPtr + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET,
        true,
      ),
    ).toBe(0);
    expect(
      view.getUint32(
        msgPtr + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET + 4,
        true,
      ),
    ).toBe(0xa5a5_a5a5);
    expect(
      view.getUint32(msgPtr + PROCESS_MSGHDR_WASM64_FLAGS_OFFSET, true),
    ).toBe(0x40);
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

  it.each([
    ["pwritev", "handleWritev", ABI_SYSCALLS.Pwritev],
    ["preadv", "handleReadv", ABI_SYSCALLS.Preadv],
  ] as const)(
    "preserves a %s slow-path offset above Number.MAX_SAFE_INTEGER",
    (_name, method, syscallNr) => {
      const harness = makeScratchHarness();
      const iovPtr = 256;
      const buffer = 65_536;
      writeWasm32Iovecs(harness.processBytes, iovPtr, [{
        base: buffer,
        len: CH_DATA_SIZE + 1,
      }]);
      const offsets: bigint[] = [];
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        const low = channelView.getBigInt64(
          CH_ARGS + 3 * CH_ARG_SIZE,
          true,
        );
        const high = channelView.getBigInt64(
          CH_ARGS + 4 * CH_ARG_SIZE,
          true,
        );
        offsets.push((high << 32n) | BigInt.asUintN(32, low));
        const kernelIovec = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const len = new DataView(harness.kernelBytes.buffer).getUint32(
          kernelIovec + 4,
          true,
        );
        channelView.setBigInt64(CH_RETURN, BigInt(len), true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker[method](
        harness.channel,
        syscallNr,
        [7, iovPtr, 1, 1, 0x0020_0000, 0],
      );

      const initialOffset = 9_007_199_254_740_993n;
      expect(offsets).toEqual([
        initialOffset,
        initialOffset + BigInt(CH_DATA_SIZE - 8),
      ]);
      expectScratchTailUntouched(harness);
    },
  );

  it("normalizes the wasm64 preadv low word before Number conversion", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    const iovPtr = 256;
    const destination = 65_536;
    writeNativeIovec(
      harness.processBytes,
      8,
      iovPtr,
      destination,
      CH_DATA_SIZE + 1,
    );
    const offsets: bigint[] = [];
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const low = channelView.getBigInt64(
        CH_ARGS + 3 * CH_ARG_SIZE,
        true,
      );
      const high = channelView.getBigInt64(
        CH_ARGS + 4 * CH_ARG_SIZE,
        true,
      );
      offsets.push((high << 32n) | BigInt.asUintN(32, low));
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const offset = 9_007_199_254_740_993n;
    writeChannelSyscall(harness, ABI_SYSCALLS.Preadv, [
      7n,
      BigInt(iovPtr),
      1n,
      offset,
      offset >> 32n,
    ]);

    harness.worker._handleSyscallInner(harness.channel);

    expect(offsets).toEqual([offset]);
    expectScratchTailUntouched(harness);
  });

  it("rejects a writev result larger than the staged caller data", () => {
    const harness = makeScratchHarness();
    const iovPtr = 256;
    const source = 1024;
    writeWasm32Iovecs(harness.processBytes, iovPtr, [{
      base: source,
      len: 4,
    }]);
    harness.processBytes.set([1, 2, 3, 4], source);
    harness.handleChannel.mockImplementation(() => {
      const view = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      view.setBigInt64(CH_RETURN, 5n, true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleWritev(
      harness.channel,
      ABI_SYSCALLS.Writev,
      [7, iovPtr, 1, 0, 0, 0],
    );

    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Writev,
      [7, iovPtr, 1, 0, 0, 0],
      undefined,
      -1,
      EIO,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["pwritev2", "handleWritev", ABI_SYSCALLS.Pwritev2],
    ["preadv2", "handleReadv", ABI_SYSCALLS.Preadv2],
  ] as const)(
    "preserves %s offset words and flags on the fast path",
    (_name, method, syscallNr) => {
      const harness = makeScratchHarness();
      const iovPtr = 256;
      const buffer = 1024;
      const flags = 0x8000_0000;
      writeWasm32Iovecs(harness.processBytes, iovPtr, [{
        base: buffer,
        len: 4,
      }]);
      harness.processBytes.set([1, 2, 3, 4], buffer);
      const calls: Array<{
        syscall: number;
        low: bigint;
        high: bigint;
        flags: bigint;
      }> = [];
      harness.handleChannel.mockImplementation(() => {
        const view = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        calls.push({
          syscall: view.getUint32(CH_SYSCALL, true),
          low: view.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
          high: view.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true),
          flags: view.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
        });
        view.setBigInt64(CH_RETURN, 4n, true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker[method](
        harness.channel,
        syscallNr,
        [7, iovPtr, 1, 0x8000_0000, 1, flags],
      );

      expect(calls).toEqual([{
        syscall: syscallNr,
        low: 0x8000_0000n,
        high: 1n,
        flags: BigInt(flags),
      }]);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["pwritev2", "handleWritev", ABI_SYSCALLS.Pwritev2],
    ["preadv2", "handleReadv", ABI_SYSCALLS.Preadv2],
  ] as const)(
    "preserves %s flags across every capacity-bounded slow-path chunk",
    (_name, method, syscallNr) => {
      const harness = makeScratchHarness();
      const iovPtr = 256;
      const buffer = 65_536;
      const flags = 0x4000_0000;
      writeWasm32Iovecs(harness.processBytes, iovPtr, [{
        base: buffer,
        len: CH_DATA_SIZE + 1,
      }]);
      const calls: Array<{ syscall: number; flags: bigint }> = [];
      harness.handleChannel.mockImplementation(() => {
        const view = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        calls.push({
          syscall: view.getUint32(CH_SYSCALL, true),
          flags: view.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
        });
        const kernelIovec = Number(
          view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const len = new DataView(harness.kernelBytes.buffer).getUint32(
          kernelIovec + 4,
          true,
        );
        view.setBigInt64(CH_RETURN, BigInt(len), true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker[method](
        harness.channel,
        syscallNr,
        [7, iovPtr, 1, 0, 0, flags],
      );

      expect(calls.length).toBeGreaterThan(1);
      expect(calls).toEqual(calls.map(() => ({
        syscall: syscallNr,
        flags: BigInt(flags),
      })));
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", 4, "pwrite", ABI_SYSCALLS.Pwrite],
    ["wasm32", 4, "pread", ABI_SYSCALLS.Pread],
    ["wasm64", 8, "pwrite", ABI_SYSCALLS.Pwrite],
    ["wasm64", 8, "pread", ABI_SYSCALLS.Pread],
  ] as const)(
    "preserves a %s %s offset above Number.MAX_SAFE_INTEGER on the ordinary path",
    (_widthName, pointerWidth, _name, syscallNr) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const buffer = 65_536;
      const offset = 9_007_199_254_740_993n;
      const offsets: bigint[] = [];
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        offsets.push(
          channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
        );
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, syscallNr, [
        7n,
        BigInt(buffer),
        4n,
        offset,
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(offsets).toEqual([offset]);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", 4, "pwrite", ABI_SYSCALLS.Pwrite],
    ["wasm32", 4, "pread", ABI_SYSCALLS.Pread],
    ["wasm64", 8, "pwrite", ABI_SYSCALLS.Pwrite],
    ["wasm64", 8, "pread", ABI_SYSCALLS.Pread],
  ] as const)(
    "preserves and increments a %s large %s offset above Number.MAX_SAFE_INTEGER",
    (_widthName, pointerWidth, _name, syscallNr) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const buffer = 65_536;
      const totalLength = CH_DATA_SIZE + 1;
      const initialOffset = 9_007_199_254_740_993n;
      const preparedOffsets: bigint[] = [];
      Object.assign(harness.worker.kernelInstance.exports, {
        kernel_prepare_write_operation: vi.fn((
          _pid: number,
          _tid: number,
          _fd: number,
          offset: bigint,
          len: number,
        ) => {
          preparedOffsets.push(offset);
          return BigInt(len);
        }),
      });
      const offsets: bigint[] = [];
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        offsets.push(
          channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
        );
        const chunkLength = Number(
          channelView.getBigInt64(
            CH_ARGS + 2 * CH_ARG_SIZE,
            true,
          ),
        );
        channelView.setBigInt64(CH_RETURN, BigInt(chunkLength), true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, syscallNr, [
        7n,
        BigInt(buffer),
        BigInt(totalLength),
        initialOffset,
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(offsets).toEqual([
        initialOffset,
        initialOffset + BigInt(CH_DATA_SIZE),
      ]);
      expect(preparedOffsets).toEqual(
        syscallNr === ABI_SYSCALLS.Pwrite ? [initialOffset] : [],
      );
      expectScratchTailUntouched(harness);
    },
  );

  it("rejects an out-of-range source before a large write kernel call", () => {
    const harness = makeScratchHarness();
    const source = harness.processBytes.byteLength - 8;

    harness.worker.handleLargeWrite(
      harness.channel,
      ABI_SYSCALLS.Write,
      [7, source, CH_DATA_SIZE + 1, 0, 0, 0],
      [7n, BigInt(source), BigInt(CH_DATA_SIZE + 1), 0n, 0n, 0n],
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
      [7n, BigInt(destination), BigInt(CH_DATA_SIZE + 1), 0n, 0n, 0n],
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
    const invalidEvent =
      harness.processBytes.byteLength - STRUCT_SIZE_WASM_EPOLL_EVENT + 1;

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

  it("copies an exact-size epoll_ctl record with data at offset eight", () => {
    const harness = makeScratchHarness();
    const eventPointer =
      harness.processBytes.byteLength - STRUCT_SIZE_WASM_EPOLL_EVENT;
    const processView = new DataView(harness.processBytes.buffer);
    const expectedData = 0x0102_0304_0506_0708n;
    processView.setUint32(
      eventPointer + WASM_EPOLL_EVENT_EVENTS_OFFSET,
      0x1234,
      true,
    );
    processView.setUint32(
      eventPointer + WASM_EPOLL_EVENT_PAD_OFFSET,
      0xa5a5_a5a5,
      true,
    );
    processView.setBigUint64(
      eventPointer + WASM_EPOLL_EVENT_DATA_OFFSET,
      expectedData,
      true,
    );
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const kernelEvent = Number(
        channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
      );
      expect(
        harness.kernelBytes.slice(
          kernelEvent,
          kernelEvent + STRUCT_SIZE_WASM_EPOLL_EVENT,
        ),
      ).toEqual(
        harness.processBytes.slice(
          eventPointer,
          eventPointer + STRUCT_SIZE_WASM_EPOLL_EVENT,
        ),
      );
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleEpollCtl(
      harness.channel,
      [3, 1, 7, eventPointer, 0, 0],
      [3n, 1n, 7n, BigInt(eventPointer), 0n, 0n],
    );

    expect(harness.handleChannel).toHaveBeenCalledTimes(1);
    expect(harness.worker.epollInterests.get("41:3")).toEqual([{
      fd: 7,
      events: 0x1234,
      data: expectedData,
    }]);
    expectScratchTailUntouched(harness);
  });

  it("rejects an out-of-range epoll output array before polling", () => {
    const harness = makeScratchHarness();
    const invalidEvents =
      harness.processBytes.byteLength - STRUCT_SIZE_WASM_EPOLL_EVENT + 1;
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

  it("writes one exact-size epoll result with zero padding and data at offset eight", () => {
    const harness = makeScratchHarness();
    const eventsPointer =
      harness.processBytes.byteLength - STRUCT_SIZE_WASM_EPOLL_EVENT;
    const expectedData = 0x1122_3344_5566_7788n;
    harness.processBytes.fill(
      0xa5,
      eventsPointer,
      eventsPointer + STRUCT_SIZE_WASM_EPOLL_EVENT,
    );
    harness.worker.epollInterests.set("41:3", [{
      fd: 7,
      events: 1,
      data: expectedData,
    }]);
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const pollfdsPointer = Number(
        channelView.getBigInt64(CH_ARGS, true),
      );
      new DataView(harness.kernelBytes.buffer).setInt16(
        pollfdsPointer + 6,
        1,
        true,
      );
      channelView.setBigInt64(CH_RETURN, 1n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleEpollPwait(
      harness.channel,
      ABI_SYSCALLS.EpollPwait,
      [3, eventsPointer, 1, 0, 0, 0],
      [3n, BigInt(eventsPointer), 1n, 0n, 0n, 0n],
    );

    const output = new DataView(
      harness.processBytes.buffer,
      eventsPointer,
      STRUCT_SIZE_WASM_EPOLL_EVENT,
    );
    expect(output.getUint32(WASM_EPOLL_EVENT_EVENTS_OFFSET, true)).toBe(1);
    expect(output.getUint32(WASM_EPOLL_EVENT_PAD_OFFSET, true)).toBe(0);
    expect(output.getBigUint64(WASM_EPOLL_EVENT_DATA_OFFSET, true))
      .toBe(expectedData);
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      1,
      0,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    [4, 0x1020_3040n],
    [8, 0x0102_0304_0506_0708n],
  ] as const)(
    "translates an exact-end wasm%s msgsnd buffer to the canonical i64 header",
    (pointerWidth, mtype) => {
      const harness = makeScratchHarness(pointerWidth);
      const text = Uint8Array.of(0x61, 0x62, 0x63);
      const messagePointer =
        harness.processBytes.byteLength - pointerWidth - text.byteLength;
      const processView = new DataView(harness.processBytes.buffer);
      if (pointerWidth === 8) {
        processView.setBigInt64(messagePointer, mtype, true);
      } else {
        processView.setInt32(messagePointer, Number(mtype), true);
      }
      harness.processBytes.set(text, messagePointer + pointerWidth);
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        const kernelMessage = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const kernelView = new DataView(harness.kernelBytes.buffer);
        expect(kernelView.getBigInt64(kernelMessage, true)).toBe(mtype);
        expect(
          harness.kernelBytes.slice(
            kernelMessage + STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER,
            kernelMessage + STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER
              + text.byteLength,
          ),
        ).toEqual(text);
        expect(
          Number(channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true)),
        ).toBe(pointerWidth);
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker.handleSysvMessage(
        harness.channel,
        ABI_SYSCALLS.Msgsnd,
        [3, messagePointer, text.byteLength, 0, 0, 0],
        [
          3n,
          BigInt(messagePointer),
          BigInt(text.byteLength),
          0n,
          0n,
          0n,
        ],
      );

      expect(harness.handleChannel).toHaveBeenCalledTimes(1);
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Msgsnd,
        [3, messagePointer, text.byteLength, 0, 0, 0],
        undefined,
        0,
        0,
        undefined,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    [4, "msgsnd", ABI_SYSCALLS.Msgsnd],
    [8, "msgsnd", ABI_SYSCALLS.Msgsnd],
    [4, "msgrcv", ABI_SYSCALLS.Msgrcv],
    [8, "msgrcv", ABI_SYSCALLS.Msgrcv],
  ] as const)(
    "rejects a one-byte-short wasm%s %s caller message range",
    (pointerWidth, _name, syscallNr) => {
      const harness = makeScratchHarness(pointerWidth);
      const textBytes = 3;
      const pointer =
        harness.processBytes.byteLength - pointerWidth - textBytes + 1;
      const origArgs = syscallNr === ABI_SYSCALLS.Msgsnd
        ? [3, pointer, textBytes, 0, 0, 0]
        : [3, pointer, textBytes, 0, 0, 0];

      harness.worker.handleSysvMessage(
        harness.channel,
        syscallNr,
        origArgs,
        [3n, BigInt(pointer), BigInt(textBytes), 0n, 0n, 0n],
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

  it.each([
    [4, 0x1234_5678n],
    [8, 0x0102_0304_0506_0708n],
  ] as const)(
    "translates canonical msgrcv output to a wasm%s native-long prefix",
    (pointerWidth, mtype) => {
      const harness = makeScratchHarness(pointerWidth);
      const messagePointer = 4096;
      const text = Uint8Array.of(0x71, 0x72, 0x73);
      const selectedType =
        pointerWidth === 8 ? 0x0102_0304_0506_0708n : 7n;
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        expect(
          channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true),
        ).toBe(selectedType);
        const kernelMessage = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const kernelView = new DataView(harness.kernelBytes.buffer);
        kernelView.setBigInt64(kernelMessage, mtype, true);
        harness.kernelBytes.set(
          text,
          kernelMessage + STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER,
        );
        channelView.setBigInt64(CH_RETURN, BigInt(text.byteLength), true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker.handleSysvMessage(
        harness.channel,
        ABI_SYSCALLS.Msgrcv,
        [3, messagePointer, text.byteLength, Number(selectedType), 0, 0],
        [
          3n,
          BigInt(messagePointer),
          BigInt(text.byteLength),
          selectedType,
          0n,
          0n,
        ],
      );

      const outputWrites = harness.completeChannel.mock.calls[0]?.[6] as
        | Array<{ ptr: number; bytes: Uint8Array }>
        | undefined;
      expect(outputWrites).toHaveLength(1);
      expect(outputWrites?.[0]?.ptr).toBe(messagePointer);
      const output = outputWrites![0]!.bytes;
      const outputView = new DataView(
        output.buffer,
        output.byteOffset,
        output.byteLength,
      );
      expect(
        pointerWidth === 8
          ? outputView.getBigInt64(0, true)
          : BigInt(outputView.getInt32(0, true)),
      ).toBe(mtype);
      expect(output.subarray(pointerWidth)).toEqual(text);
      expectScratchTailUntouched(harness);
    },
  );

  it("accepts exact SysV scratch capacity and rejects capacity plus one", () => {
    const exact = CH_DATA_SIZE - STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER;
    for (const messageSize of [exact, exact + 1]) {
      const harness = makeScratchHarness(8);
      const messagePointer = 4096;
      new DataView(harness.processBytes.buffer).setBigInt64(
        messagePointer,
        1n,
        true,
      );
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker.handleSysvMessage(
        harness.channel,
        ABI_SYSCALLS.Msgsnd,
        [3, messagePointer, messageSize, 0, 0, 0],
        [3n, BigInt(messagePointer), BigInt(messageSize), 0n, 0n, 0n],
      );

      expect(harness.handleChannel).toHaveBeenCalledTimes(
        messageSize === exact ? 1 : 0,
      );
      if (messageSize !== exact) {
        expect(harness.completeChannelRaw).toHaveBeenCalledWith(
          harness.channel,
          -1,
          EINVAL,
        );
      }
      expectScratchTailUntouched(harness);
    }
  });

  it("returns IPC_NOWAIT EAGAIN instead of parking a SysV message retry", () => {
    const harness = makeScratchHarness(8);
    const messagePointer = 4096;
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      channelView.setBigInt64(CH_RETURN, -1n, true);
      channelView.setUint32(CH_ERRNO, EAGAIN, true);
      return 0;
    });

    harness.worker.handleSysvMessage(
      harness.channel,
      ABI_SYSCALLS.Msgrcv,
      [3, messagePointer, 0, 0, IPC_NOWAIT, 0],
      [3n, BigInt(messagePointer), 0n, 0n, BigInt(IPC_NOWAIT), 0n],
    );

    expect(harness.worker.handleBlockingRetry).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Msgrcv,
      [3, messagePointer, 0, 0, IPC_NOWAIT, 0],
      undefined,
      -1,
      EAGAIN,
      undefined,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["msgctl wasm32", ABI_SYSCALLS.Msgctl, "kernel_msqid_ds_bytes", 4, 96],
    ["msgctl wasm64", ABI_SYSCALLS.Msgctl, "kernel_msqid_ds_bytes", 8, 120],
    ["shmctl wasm32", ABI_SYSCALLS.Shmctl, "kernel_shmid_ds_bytes", 4, 88],
    ["shmctl wasm64", ABI_SYSCALLS.Shmctl, "kernel_shmid_ds_bytes", 8, 112],
  ] as const)(
    "rejects a one-byte-short %s IPC_STAT destination before scratch use",
    (_name, syscallNr, exportName, pointerWidth, bytes) => {
      const harness = makeScratchHarness(pointerWidth);
      const invalidBuffer = harness.processBytes.byteLength - bytes + 1;
      const statBytes = vi.fn(() => bytes);
      Object.assign(harness.worker.kernelInstance.exports, {
        [exportName]: statBytes,
      });

      harness.worker.handleIpcControl(
        harness.channel,
        syscallNr,
        [3, 2, invalidBuffer, 0, 0, 0],
        [3n, 2n, BigInt(invalidBuffer), 0n, 0n, 0n],
      );

      expect(statBytes).toHaveBeenCalledWith(pointerWidth);
      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["msgctl wasm32", ABI_SYSCALLS.Msgctl, "kernel_msqid_ds_bytes", 4, 96],
    ["msgctl wasm64", ABI_SYSCALLS.Msgctl, "kernel_msqid_ds_bytes", 8, 120],
    ["shmctl wasm32", ABI_SYSCALLS.Shmctl, "kernel_shmid_ds_bytes", 4, 88],
    ["shmctl wasm64", ABI_SYSCALLS.Shmctl, "kernel_shmid_ds_bytes", 8, 112],
  ] as const)(
    "copies the exact kernel-sized %s IPC_STAT result",
    (_name, syscallNr, exportName, pointerWidth, bytes) => {
      const harness = makeScratchHarness(pointerWidth);
      const outputPointer = 4096;
      const expected = Uint8Array.from(
        { length: bytes },
        (_, index) => (index * 13) & 0xff,
      );
      const statBytes = vi.fn(() => bytes);
      Object.assign(harness.worker.kernelInstance.exports, {
        [exportName]: statBytes,
      });
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        expect(channelView.getUint32(CH_SYSCALL, true)).toBe(syscallNr);
        expect(
          Number(
            channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
          ),
        ).toBe(pointerWidth);
        const dataPointer = Number(
          channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
        );
        harness.kernelBytes.set(expected, dataPointer);
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      harness.worker.handleIpcControl(
        harness.channel,
        syscallNr,
        [3, 2, outputPointer, 0, 0, 0],
        [3n, 2n, BigInt(outputPointer), 0n, 0n, 0n],
      );

      expect(statBytes).toHaveBeenCalledWith(pointerWidth);
      expect(
        harness.processBytes.slice(
          outputPointer,
          outputPointer + bytes,
        ),
      ).toEqual(expected);
      expectScratchTailUntouched(harness);
    },
  );

  it("stages IPC_SET input without copying scratch back to the caller", () => {
    const harness = makeScratchHarness(8);
    const inputPointer = 4096;
    const bytes = 120;
    const input = Uint8Array.from(
      { length: bytes },
      (_, index) => (index * 7) & 0xff,
    );
    harness.processBytes.set(input, inputPointer);
    Object.assign(harness.worker.kernelInstance.exports, {
      kernel_msqid_ds_bytes: vi.fn(() => bytes),
    });
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const dataPointer = Number(
        channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
      );
      expect(
        harness.kernelBytes.slice(dataPointer, dataPointer + bytes),
      ).toEqual(input);
      harness.kernelBytes.fill(0xee, dataPointer, dataPointer + bytes);
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleIpcControl(
      harness.channel,
      ABI_SYSCALLS.Msgctl,
      [3, 1, inputPointer, 0, 0, 0],
      [3n, 1n, BigInt(inputPointer), 0n, 0n, 0n],
    );

    expect(
      harness.processBytes.slice(inputPointer, inputPointer + bytes),
    ).toEqual(input);
    expectScratchTailUntouched(harness);
  });

  it("rejects invalid or missing IPC control sizing exports", () => {
    for (const configuredSize of [undefined, CH_DATA_SIZE + 1]) {
      const harness = makeScratchHarness();
      if (configuredSize !== undefined) {
        Object.assign(harness.worker.kernelInstance.exports, {
          kernel_msqid_ds_bytes: vi.fn(() => configuredSize),
        });
      }

      harness.worker.handleIpcControl(
        harness.channel,
        ABI_SYSCALLS.Msgctl,
        [3, 2, 4096, 0, 0, 0],
        [3n, 2n, 4096n, 0n, 0n, 0n],
      );

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -1,
        EIO,
      );
      expectScratchTailUntouched(harness);
    }
  });

  it("does not pass an unsafe wasm64 IPC control pointer to Rust", () => {
    const harness = makeScratchHarness(8);
    Object.assign(harness.worker.kernelInstance.exports, {
      kernel_shmid_ds_bytes: vi.fn(() => 112),
    });
    const unsafePointer = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    harness.worker.handleIpcControl(
      harness.channel,
      ABI_SYSCALLS.Shmctl,
      [3, 2, Number(unsafePointer), 0, 0, 0],
      [3n, 2n, unsafePointer, 0n, 0n, 0n],
    );

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it("dispatches IPC_RMID without a pointer or sizing query", () => {
    const harness = makeScratchHarness(8);
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      expect(
        channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
      ).toBe(0n);
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleIpcControl(
      harness.channel,
      ABI_SYSCALLS.Shmctl,
      [3, 0, 0, 0, 0, 0],
      [3n, 0n, 0n, 0n, 0n, 0n],
    );

    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      0,
      0,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["wasm32 IPC_STAT output", 2, 72, 4],
    ["wasm64 IPC_STAT output", 2, 88, 8],
    ["GETALL output", 13, 64, 4],
    ["SETALL input", 17, 64, 4],
  ] as const)(
    "rejects an out-of-range semctl %s before touching kernel scratch",
    (_name, command, bytes, pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      const invalidBuffer = harness.processBytes.byteLength - bytes + 1;
      const arrayBytes = vi.fn(() => bytes);
      const statBytes = vi.fn(() => bytes);
      Object.assign(harness.worker.kernelInstance.exports, {
        kernel_semctl_array_bytes: arrayBytes,
        kernel_semid_ds_bytes: statBytes,
      });

      expect(() => harness.worker.handleSemctl(
        harness.channel,
        [3, 0, command, invalidBuffer, 0, 0],
      )).not.toThrow();

      if (command === 2) {
        expect(arrayBytes).not.toHaveBeenCalled();
        expect(statBytes).toHaveBeenCalledWith(pointerWidth);
      } else {
        expect(statBytes).not.toHaveBeenCalled();
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

  it("uses the permission-aware kernel export to size semctl arrays", () => {
    const harness = makeScratchHarness();
    const outputPointer = 4096;
    const semaphoreCount = 32;
    const outputBytes = semaphoreCount * 2;
    const expected = new Uint8Array(outputBytes).map(
      (_, index) => index & 0xff,
    );
    const arrayBytes = vi.fn(() => outputBytes);
    Object.assign(harness.worker.kernelInstance.exports, {
      kernel_semctl_array_bytes: arrayBytes,
      kernel_semid_ds_bytes: vi.fn(() => 72),
    });
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
      expect(command).toBe(13);
      expect(
        Number(
          channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
        ),
      ).toBe(4);
      harness.kernelBytes.set(expected, dataPointer);
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    harness.worker.handleSemctl(
      harness.channel,
      [3, 0, 13, outputPointer, 0, 0],
    );

    expect(arrayBytes).toHaveBeenCalledWith(
      harness.channel.pid,
      harness.channel.pid,
      3,
      13,
    );
    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(
      harness.processBytes.slice(
        outputPointer,
        outputPointer + outputBytes,
      ),
    ).toEqual(expected);
    expectScratchTailUntouched(harness);
  });

  it("fails closed when a required semctl sizing export is absent", () => {
    const harness = makeScratchHarness();

    harness.worker.handleSemctl(
      harness.channel,
      [3, 0, 13, 4096, 0, 0],
    );

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EIO,
    );
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

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "rejects a non-null %s recvfrom address with no capacity pointer",
    (_pointerKind, pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const addressPointer = 4096;
      writeChannelSyscall(harness, ABI_SYSCALLS.Recvfrom, [
        7n,
        0n,
        0n,
        0n,
        BigInt(addressPointer),
        0n,
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Recvfrom,
        [7, 0, 0, 0, addressPointer, 0],
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it("uses one captured socklen for recvfrom sizing and staging", () => {
    const harness = makeScratchHarness();
    prepareGenericSyscallHarness(harness, 4);
    const dataPointer = 72_000;
    const dataLength = 65_520;
    const addressPointer = 180_000;
    const lengthPointer = 220_000;
    const initialAddressCapacity = 4;
    const mutatedAddressCapacity = 28;
    const nativeDataView = globalThis.DataView;
    new nativeDataView(harness.processBytes.buffer).setUint32(
      lengthPointer,
      initialAddressCapacity,
      true,
    );

    let capturedReads = 0;
    class MutatingDataView extends nativeDataView {
      getUint32(byteOffset: number, littleEndian?: boolean): number {
        const value = super.getUint32(byteOffset, littleEndian);
        if (
          this.buffer === harness.channel.memory.buffer
          && byteOffset === lengthPointer
          && capturedReads++ === 0
        ) {
          // Model a second guest thread changing socklen_t after the sizing
          // read. Before the fix, the later byte copy staged 28 even though
          // only four address bytes had been reserved at the scratch tail.
          new nativeDataView(harness.processBytes.buffer).setUint32(
            lengthPointer,
            mutatedAddressCapacity,
            true,
          );
        }
        return value;
      }
    }

    const observedLengths: number[] = [];
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new nativeDataView(
        harness.kernelBytes.buffer,
        Number(offset),
      );
      const stagedAddressPointer = Number(
        channelView.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true),
      );
      const stagedLengthPointer = Number(
        channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
      );
      const stagedLength = new nativeDataView(
        harness.kernelBytes.buffer,
      ).getUint32(stagedLengthPointer, true);
      observedLengths.push(stagedLength);
      expect(stagedAddressPointer).toBe(
        harness.scratchOffset + CH_DATA + dataLength,
      );
      expect(stagedLengthPointer).toBe(
        harness.scratchOffset + CH_DATA + dataLength + 8,
      );
      harness.kernelBytes.fill(
        0x5a,
        stagedAddressPointer,
        stagedAddressPointer + stagedLength,
      );
      new nativeDataView(harness.kernelBytes.buffer).setUint32(
        stagedLengthPointer,
        mutatedAddressCapacity,
        true,
      );
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    writeChannelSyscall(harness, ABI_SYSCALLS.Recvfrom, [
      7n,
      BigInt(dataPointer),
      BigInt(dataLength),
      0n,
      BigInt(addressPointer),
      BigInt(lengthPointer),
    ]);

    vi.stubGlobal("DataView", MutatingDataView);
    try {
      expect(() => harness.worker._handleSyscallInner(harness.channel))
        .not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(capturedReads).toBe(1);
    expect(observedLengths).toEqual([initialAddressCapacity]);
    expect(
      new nativeDataView(harness.processBytes.buffer).getUint32(
        lengthPointer,
        true,
      ),
    ).toBe(mutatedAddressCapacity);
    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expectScratchTailUntouched(harness);
  });

  it("captures socklen before planning even when generated descriptors reorder", () => {
    const harness = makeScratchHarness();
    prepareGenericSyscallHarness(harness, 4);
    const addressPointer = 4096;
    const lengthPointer = 8192;
    const stagedCapacity = 28;
    const plannedCapacity = 4;
    const nativeDataView = globalThis.DataView;
    const processView = new nativeDataView(harness.processBytes.buffer);
    processView.setUint32(lengthPointer, stagedCapacity, true);

    const originalDescriptors = SYSCALL_ARGS[ABI_SYSCALLS.Recvfrom]!;
    const reorderedDescriptors = [
      originalDescriptors[0]!,
      originalDescriptors[2]!,
      originalDescriptors[1]!,
    ];
    const stagedAddressPointer = harness.scratchOffset + CH_DATA + 8;
    harness.kernelBytes.fill(
      0xa5,
      stagedAddressPointer + plannedCapacity,
      stagedAddressPointer + stagedCapacity,
    );

    let sizingReads = 0;
    class MutatingDataView extends nativeDataView {
      getUint32(byteOffset: number, littleEndian?: boolean): number {
        if (
          this.buffer === harness.channel.memory.buffer
          && byteOffset === lengthPointer
          && sizingReads++ === 0
        ) {
          // With the old order-dependent planner, the preceding fixed
          // descriptor had already staged 28. This mutation then planned only
          // four address bytes, allowing Rust to observe the larger value.
          new nativeDataView(harness.processBytes.buffer).setUint32(
            lengthPointer,
            plannedCapacity,
            true,
          );
        }
        return super.getUint32(byteOffset, littleEndian);
      }
    }

    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new nativeDataView(
        harness.kernelBytes.buffer,
        Number(offset),
      );
      const addressScratch = Number(
        channelView.getBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, true),
      );
      const lengthScratch = Number(
        channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true),
      );
      expect(addressScratch).toBe(stagedAddressPointer);
      expect(lengthScratch).toBe(harness.scratchOffset + CH_DATA);
      const rustVisibleCapacity = new nativeDataView(
        harness.kernelBytes.buffer,
      ).getUint32(lengthScratch, true);
      expect(rustVisibleCapacity).toBe(plannedCapacity);
      harness.kernelBytes.fill(
        0x5a,
        addressScratch,
        addressScratch + rustVisibleCapacity,
      );
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    writeChannelSyscall(harness, ABI_SYSCALLS.Recvfrom, [
      7n,
      0n,
      0n,
      0n,
      BigInt(addressPointer),
      BigInt(lengthPointer),
    ]);

    SYSCALL_ARGS[ABI_SYSCALLS.Recvfrom] = reorderedDescriptors;
    vi.stubGlobal("DataView", MutatingDataView);
    try {
      harness.worker._handleSyscallInner(harness.channel);
    } finally {
      vi.unstubAllGlobals();
      SYSCALL_ARGS[ABI_SYSCALLS.Recvfrom] = originalDescriptors;
    }

    expect(sizingReads).toBe(1);
    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(
      harness.kernelBytes.slice(
        stagedAddressPointer + plannedCapacity,
        stagedAddressPointer + stagedCapacity,
      ),
    ).toEqual(
      new Uint8Array(stagedCapacity - plannedCapacity).fill(0xa5),
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
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
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

  it("copies only getaddrinfo's four-byte result before the caller canary", () => {
    const harness = makeScratchHarness();
    const namePointer = 4096;
    const resultPointer = 8192;
    const result = Uint8Array.from([10, 88, 0, 7]);
    const canary = new Uint8Array(252).fill(0x6d);
    harness.processBytes.set(
      new TextEncoder().encode("example.test\0"),
      namePointer,
    );
    harness.processBytes.set(canary, resultPointer + result.byteLength);

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
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
      const outputPointer = Number(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      harness.kernelBytes.set(result, outputPointer);
      channelView.setBigInt64(CH_RETURN, 4n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    harness.completeChannel.mockImplementation(
      (
        _channel: TestChannel,
        _syscallNr: number,
        _origArgs: number[],
        _argDescs: unknown,
        _retVal: number,
        _errVal: number,
        writes: Array<{ ptr: number; bytes: Uint8Array }>,
      ) => {
        for (const write of writes) {
          harness.processBytes.set(write.bytes, write.ptr);
        }
      },
    );

    const request = new DataView(harness.channel.memory.buffer);
    request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getaddrinfo, true);
    request.setBigInt64(CH_ARGS, BigInt(namePointer), true);
    request.setBigInt64(
      CH_ARGS + CH_ARG_SIZE,
      BigInt(resultPointer),
      true,
    );

    expect(() => harness.worker._handleSyscallInner(harness.channel))
      .not.toThrow();

    expect(
      harness.processBytes.slice(resultPointer, resultPointer + result.length),
    ).toEqual(result);
    expect(
      harness.processBytes.slice(
        resultPointer + result.length,
        resultPointer + result.length + canary.length,
      ),
    ).toEqual(canary);
    const detachedWrites = harness.completeChannel.mock.calls[0]?.[6] as
      Array<{ ptr: number; bytes: Uint8Array }>;
    expect(detachedWrites).toHaveLength(1);
    expect(detachedWrites[0]?.bytes).toHaveLength(4);
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["sendfile offset", ABI_SYSCALLS.Sendfile, 2, 8, [7n, 8n, 0n, 1n]],
    [
      "copy_file_range input offset",
      ABI_SYSCALLS.CopyFileRange,
      1,
      8,
      [7n, 0n, 8n, 0n, 1n, 0n],
    ],
    [
      "copy_file_range output offset",
      ABI_SYSCALLS.CopyFileRange,
      3,
      8,
      [7n, 0n, 8n, 0n, 1n, 0n],
    ],
    [
      "splice input offset",
      ABI_SYSCALLS.Splice,
      1,
      8,
      [7n, 0n, 8n, 0n, 1n, 0n],
    ],
    [
      "splice output offset",
      ABI_SYSCALLS.Splice,
      3,
      8,
      [7n, 0n, 8n, 0n, 1n, 0n],
    ],
    ["getcpu cpu output", ABI_SYSCALLS.Getcpu, 0, 4, [0n, 0n]],
    ["getcpu node output", ABI_SYSCALLS.Getcpu, 1, 4, [0n, 0n]],
  ] as const)(
    "rejects a one-byte-short %s caller range before kernel dispatch",
    (_name, syscallNr, argIndex, size, originalArgs) => {
      const harness = makeScratchHarness(8);
      prepareGenericSyscallHarness(harness, 8);
      const invalidPointer =
        harness.processBytes.byteLength - size + 1;
      const args = [...originalArgs];
      args[argIndex] = BigInt(invalidPointer);
      writeChannelSyscall(harness, syscallNr, args);

      expect(() => harness.worker._handleSyscallInner(harness.channel))
        .not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        syscallNr,
        Array.from(
          { length: 6 },
          (_, index) => Number(args[index] ?? 0n),
        ),
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["memfd_create name", ABI_SYSCALLS.MemfdCreate, [0n, 0n]],
    [
      "renameat2 old path",
      ABI_SYSCALLS.Renameat2,
      [-100n, 0n, -100n, 4096n, 0n],
    ],
    [
      "renameat2 new path",
      ABI_SYSCALLS.Renameat2,
      [-100n, 4096n, -100n, 0n, 0n],
    ],
  ] as const)(
    "rejects a null required %s before kernel dispatch",
    (_name, syscallNr, args) => {
      const harness = makeScratchHarness(8);
      prepareGenericSyscallHarness(harness, 8);
      harness.processBytes.set(
        new TextEncoder().encode("valid\0"),
        4096,
      );
      writeChannelSyscall(harness, syscallNr, [...args]);

      expect(() => harness.worker._handleSyscallInner(harness.channel))
        .not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        syscallNr,
        Array.from(
          { length: 6 },
          (_, index) => Number(args[index] ?? 0n),
        ),
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    [4, 312],
    [8, 368],
  ] as const)(
    "stages an exact-end wasm%s sysinfo output with its native capacity",
    (pointerWidth, nativeSize) => {
      const harness = makeScratchHarness(pointerWidth);
      const outputPointer = harness.processBytes.byteLength - nativeSize;
      Object.assign(harness.worker, {
        config: {},
        syscallRing: new Map(),
        syscallTraceEnabled: false,
        channelTids: new Map(),
        processes: new Map([[harness.channel.pid, {
          pid: harness.channel.pid,
          memory: harness.channel.memory,
          channels: [harness.channel],
          ptrWidth: pointerWidth,
        }]]),
        synchronizeSharedMemoryForBoundary: () => {},
        sharedMmapBackings: new Map(),
        hostReaped: new Set(),
        getProcessExitSignal: () => 0,
      });
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
        const scratchPointer = Number(
          channelView.getBigInt64(CH_ARGS, true),
        );
        expect(
          Number(channelView.getBigInt64(
            CH_ARGS + 5 * CH_ARG_SIZE,
            true,
          )),
        ).toBe(pointerWidth);
        harness.kernelBytes.fill(
          0x6b,
          scratchPointer,
          scratchPointer + nativeSize,
        );
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      const request = new DataView(harness.channel.memory.buffer);
      request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Sysinfo, true);
      request.setBigInt64(CH_ARGS, BigInt(outputPointer), true);

      expect(() => harness.worker._handleSyscallInner(harness.channel))
        .not.toThrow();

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      const writes = harness.completeChannel.mock.calls[0]?.[6] as
        | Array<{ ptr: number; bytes: Uint8Array }>
        | undefined;
      expect(writes).toHaveLength(1);
      expect(writes?.[0]?.ptr).toBe(outputPointer);
      expect(writes?.[0]?.bytes).toHaveLength(nativeSize);
      expect(writes?.[0]?.bytes.every((byte) => byte === 0x6b)).toBe(true);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    [4, 312],
    [8, 368],
  ] as const)(
    "rejects a one-byte-short wasm%s sysinfo caller range",
    (pointerWidth, nativeSize) => {
      const harness = makeScratchHarness(pointerWidth);
      Object.assign(harness.worker, {
        config: {},
        syscallRing: new Map(),
        syscallTraceEnabled: false,
        channelTids: new Map(),
        processes: new Map([[harness.channel.pid, {
          pid: harness.channel.pid,
          memory: harness.channel.memory,
          channels: [harness.channel],
          ptrWidth: pointerWidth,
        }]]),
        synchronizeSharedMemoryForBoundary: () => {},
        sharedMmapBackings: new Map(),
        hostReaped: new Set(),
        getProcessExitSignal: () => 0,
      });
      const invalidPointer =
        harness.processBytes.byteLength - nativeSize + 1;
      const request = new DataView(harness.channel.memory.buffer);
      request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Sysinfo, true);
      request.setBigInt64(CH_ARGS, BigInt(invalidPointer), true);

      expect(() => harness.worker._handleSyscallInner(harness.channel))
        .not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Sysinfo,
        [invalidPointer, 0, 0, 0, 0, 0],
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([4, 8] as const)(
    "rejects a null wasm%s sysinfo output before kernel dispatch",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      writeChannelSyscall(harness, ABI_SYSCALLS.Sysinfo, [0n]);

      expect(() => harness.worker._handleSyscallInner(harness.channel))
        .not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Sysinfo,
        [0, 0, 0, 0, 0, 0],
        undefined,
        -1,
        EFAULT,
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([4, 8] as const)(
    "rejects a null wasm%s outer ifconf without touching address zero",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      const ifconfSize = pointerWidth === 8 ? 16 : 8;
      harness.processBytes.fill(0x6d, 0, ifconfSize + 16);
      writeIfconf(harness.processBytes, pointerWidth, 0, 0, 0);
      const before = harness.processBytes.slice(0, ifconfSize + 16);

      invokeNetworkIoctlHandler(harness, "handleIoctlIfconf", 0);

      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -EFAULT,
        EFAULT,
      );
      expect(harness.processBytes.slice(0, ifconfSize + 16)).toEqual(before);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([4, 8] as const)(
    "rejects null wasm%s outer ifreq objects for every network handler",
    (pointerWidth) => {
      const ifreqSize = pointerWidth === 8 ? 40 : 32;
      for (const entry of NETWORK_IFREQ_HANDLERS) {
        const harness = makeScratchHarness(pointerWidth);
        harness.processBytes.fill(0x6d, 0, ifreqSize + 16);
        entry.prepare(harness.processBytes, 0);
        const before = harness.processBytes.slice(0, ifreqSize + 16);

        invokeNetworkIoctlHandler(harness, entry.handler, 0);

        expect(
          harness.completeChannelRaw,
          `ioctl 0x${entry.request.toString(16)}`,
        ).toHaveBeenCalledWith(harness.channel, -EFAULT, EFAULT);
        expect(harness.processBytes.slice(0, ifreqSize + 16)).toEqual(before);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "accepts an exact wasm%s outer ifconf and rejects one byte short",
    (pointerWidth) => {
      const ifconfSize = pointerWidth === 8 ? 16 : 8;
      const ifreqSize = pointerWidth === 8 ? 40 : 32;

      const exact = makeScratchHarness(pointerWidth);
      const exactPointer = exact.processBytes.byteLength - ifconfSize;
      exact.processBytes.fill(0x6d, exactPointer - 16, exactPointer);
      writeIfconf(
        exact.processBytes,
        pointerWidth,
        exactPointer,
        0,
        0,
      );
      const exactPrefix = exact.processBytes.slice(
        exactPointer - 16,
        exactPointer,
      );

      invokeNetworkIoctlHandler(
        exact,
        "handleIoctlIfconf",
        exactPointer,
      );

      expect(exact.completeChannelRaw).toHaveBeenCalledWith(
        exact.channel,
        0,
        0,
      );
      expect(
        new DataView(exact.processBytes.buffer).getInt32(exactPointer, true),
      ).toBe(2 * ifreqSize);
      expect(
        exact.processBytes.slice(exactPointer - 16, exactPointer),
      ).toEqual(exactPrefix);
      expectScratchTailUntouched(exact);

      const short = makeScratchHarness(pointerWidth);
      const shortPointer = short.processBytes.byteLength - ifconfSize + 1;
      short.processBytes.fill(0x6d, shortPointer - 16);
      const shortBefore = short.processBytes.slice(shortPointer - 16);

      invokeNetworkIoctlHandler(
        short,
        "handleIoctlIfconf",
        shortPointer,
      );

      expect(short.completeChannelRaw).toHaveBeenCalledWith(
        short.channel,
        -EFAULT,
        EFAULT,
      );
      expect(short.processBytes.slice(shortPointer - 16)).toEqual(shortBefore);
      expectScratchTailUntouched(short);
    },
  );

  it.each([4, 8] as const)(
    "accepts exact wasm%s outer ifreq objects and rejects one byte short",
    (pointerWidth) => {
      const ifreqSize = pointerWidth === 8 ? 40 : 32;
      for (const entry of NETWORK_IFREQ_HANDLERS) {
        const exact = makeScratchHarness(pointerWidth);
        const exactPointer = exact.processBytes.byteLength - ifreqSize;
        exact.processBytes.fill(0x6d, exactPointer - 16, exactPointer);
        exact.processBytes.fill(0, exactPointer);
        entry.prepare(exact.processBytes, exactPointer);
        const exactPrefix = exact.processBytes.slice(
          exactPointer - 16,
          exactPointer,
        );

        invokeNetworkIoctlHandler(exact, entry.handler, exactPointer);

        expect(
          exact.completeChannelRaw,
          `ioctl 0x${entry.request.toString(16)}`,
        ).toHaveBeenCalledWith(exact.channel, 0, 0);
        expect(
          exact.processBytes.slice(exactPointer - 16, exactPointer),
        ).toEqual(exactPrefix);
        expectScratchTailUntouched(exact);

        const short = makeScratchHarness(pointerWidth);
        const shortPointer = short.processBytes.byteLength - ifreqSize + 1;
        short.processBytes.fill(0x6d, shortPointer - 16);
        entry.prepare(short.processBytes, shortPointer);
        const shortBefore = short.processBytes.slice(shortPointer - 16);

        invokeNetworkIoctlHandler(short, entry.handler, shortPointer);

        expect(
          short.completeChannelRaw,
          `ioctl 0x${entry.request.toString(16)}`,
        ).toHaveBeenCalledWith(short.channel, -EFAULT, EFAULT);
        expect(short.processBytes.slice(shortPointer - 16)).toEqual(shortBefore);
        expectScratchTailUntouched(short);
      }
    },
  );

  it.each([4, 8] as const)(
    "bounds wasm%s nested ifconf output at exact capacity and capacity + 1",
    (pointerWidth) => {
      const ifreqSize = pointerWidth === 8 ? 40 : 32;
      for (const extraCapacity of [0, 1]) {
        const harness = makeScratchHarness(pointerWidth);
        const ifconfPointer = 4096;
        const outputPointer = 8192;
        const guardStart = outputPointer - 16;
        const guardEnd = outputPointer + ifreqSize + extraCapacity + 16;
        harness.processBytes.fill(0x6d, guardStart, guardEnd);
        writeIfconf(
          harness.processBytes,
          pointerWidth,
          ifconfPointer,
          ifreqSize + extraCapacity,
          outputPointer,
        );
        const prefix = harness.processBytes.slice(guardStart, outputPointer);
        const suffix = harness.processBytes.slice(
          outputPointer + ifreqSize,
          guardEnd,
        );

        invokeNetworkIoctlHandler(
          harness,
          "handleIoctlIfconf",
          ifconfPointer,
        );

        expect(harness.completeChannelRaw).toHaveBeenCalledWith(
          harness.channel,
          0,
          0,
        );
        expect(
          new DataView(harness.processBytes.buffer).getInt32(
            ifconfPointer,
            true,
          ),
        ).toBe(ifreqSize);
        expect(
          new TextDecoder().decode(
            harness.processBytes.slice(outputPointer, outputPointer + 2),
          ),
        ).toBe("lo");
        expect(harness.processBytes.slice(guardStart, outputPointer))
          .toEqual(prefix);
        expect(
          harness.processBytes.slice(outputPointer + ifreqSize, guardEnd),
        ).toEqual(suffix);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "rejects a one-byte-short wasm%s nested ifconf output without mutation",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      const ifreqSize = pointerWidth === 8 ? 40 : 32;
      const ifconfPointer = 4096;
      const outputPointer = harness.processBytes.byteLength - ifreqSize + 1;
      harness.processBytes.fill(0x6d, outputPointer - 16);
      const outputBefore = harness.processBytes.slice(outputPointer - 16);
      writeIfconf(
        harness.processBytes,
        pointerWidth,
        ifconfPointer,
        ifreqSize,
        outputPointer,
      );

      invokeNetworkIoctlHandler(
        harness,
        "handleIoctlIfconf",
        ifconfPointer,
      );

      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -EFAULT,
        EFAULT,
      );
      expect(harness.processBytes.slice(outputPointer - 16))
        .toEqual(outputBefore);
      expect(
        new DataView(harness.processBytes.buffer).getInt32(
          ifconfPointer,
          true,
        ),
      ).toBe(ifreqSize);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["high", 0x1_0000_2000n],
    ["unsafe", 0x20_0000_0000_2000n],
  ] as const)(
    "rejects wasm64 nested ifconf pointer class %s without a low-address alias",
    (_kind, nestedPointer) => {
      const harness = makeScratchHarness(8);
      const ifconfPointer = 4096;
      const lowAlias = Number(nestedPointer & 0xffff_ffffn);
      const ifreqSize = 40;
      harness.processBytes.fill(
        0x6d,
        lowAlias - 16,
        lowAlias + ifreqSize + 16,
      );
      const lowBefore = harness.processBytes.slice(
        lowAlias - 16,
        lowAlias + ifreqSize + 16,
      );
      writeIfconf(
        harness.processBytes,
        8,
        ifconfPointer,
        ifreqSize,
        nestedPointer,
      );

      invokeNetworkIoctlHandler(
        harness,
        "handleIoctlIfconf",
        ifconfPointer,
      );

      expect(harness.completeChannelRaw).toHaveBeenCalledWith(
        harness.channel,
        -EFAULT,
        EFAULT,
      );
      expect(
        harness.processBytes.slice(
          lowAlias - 16,
          lowAlias + ifreqSize + 16,
        ),
      ).toEqual(lowBefore);
      expectScratchTailUntouched(harness);
    },
  );

  it("copies exactly four FIONREAD bytes and preserves the caller canary", () => {
    const harness = makeScratchHarness(4);
    prepareGenericSyscallHarness(harness, 4);
    const outputPointer = 8192;
    const result = Uint8Array.from([4, 3, 2, 1]);
    const canary = new Uint8Array(32).fill(0x6d);
    harness.processBytes.set(canary, outputPointer + result.byteLength);
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
      const scratchPointer = Number(
        channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
      );
      expect(
        Number(channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true)),
      ).toBe(4);
      expect(
        Number(channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true)),
      ).toBe(4);
      harness.kernelBytes.set(result, scratchPointer);
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    harness.completeChannel.mockImplementation((
      _channel: TestChannel,
      _syscallNr: number,
      _origArgs: number[],
      _argDescs: unknown,
      _retVal: number,
      _errVal: number,
      writes: Array<{ ptr: number; bytes: Uint8Array }>,
    ) => {
      for (const write of writes) {
        harness.processBytes.set(write.bytes, write.ptr);
      }
    });
    writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
      7n,
      0x541bn,
      BigInt(outputPointer),
    ]);

    harness.worker._handleSyscallInner(harness.channel);

    expect(
      harness.processBytes.slice(outputPointer, outputPointer + result.length),
    ).toEqual(result);
    expect(
      harness.processBytes.slice(
        outputPointer + result.length,
        outputPointer + result.length + canary.length,
      ),
    ).toEqual(canary);
    const writes = harness.completeChannel.mock.calls[0]?.[6] as
      Array<{ ptr: number; bytes: Uint8Array }>;
    expect(writes[0]?.bytes).toHaveLength(4);
    expectScratchTailUntouched(harness);
  });

  it.each([
    [4, 0x8004_5430, 4, 0x00],
    [4, 0xc024_6400, 36, 0x4b],
    [8, 0xc040_6400, 64, 0x4b],
  ] as const)(
    "stages the exact wasm%s ioctl request 0x%s capacity",
    (pointerWidth, request, size, expectedInputByte) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const processPointer = harness.processBytes.byteLength - size;
      harness.processBytes.fill(
        0x4b,
        processPointer,
        processPointer + size,
      );
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
        const scratchPointer = Number(
          channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
        );
        expect(
          Number(channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true)),
        ).toBe(size);
        expect(
          Number(channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true)),
        ).toBe(pointerWidth);
        expect(
          harness.kernelBytes.slice(scratchPointer, scratchPointer + size),
        ).toEqual(new Uint8Array(size).fill(expectedInputByte));
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
        7n,
        BigInt(request),
        BigInt(processPointer),
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0,
        0,
      ]);
      expectScratchTailUntouched(harness);
    },
  );

  it("rejects a one-byte-short ioctl caller range before scratch mutation", () => {
    const harness = makeScratchHarness(4);
    prepareGenericSyscallHarness(harness, 4);
    const invalidPointer = harness.processBytes.byteLength - 3;
    writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
      7n,
      0x541bn,
      BigInt(invalidPointer),
    ]);

    harness.worker._handleSyscallInner(harness.channel);

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Ioctl,
      [7, 0x541b, invalidPointer, 0, 0, 0],
      undefined,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it("rejects a null pointer for a pointer-valued ioctl", () => {
    const harness = makeScratchHarness(4);
    prepareGenericSyscallHarness(harness, 4);
    writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
      7n,
      0x541bn,
      0n,
    ]);

    harness.worker._handleSyscallInner(harness.channel);

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannel).toHaveBeenCalledWith(
      harness.channel,
      ABI_SYSCALLS.Ioctl,
      [7, 0x541b, 0, 0, 0, 0],
      undefined,
      -1,
      EFAULT,
    );
    expectScratchTailUntouched(harness);
  });

  it("passes scalar and no-argument ioctls without staging a pointer", () => {
    for (const [request, argument, expectedArgument] of [
      [0x540b, 2n, 2],
      [0x5451, 0x2000_0000_0000n, 0],
    ] as const) {
      const harness = makeScratchHarness(8);
      prepareGenericSyscallHarness(harness, 8);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
        expect(
          Number(channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true)),
        ).toBe(expectedArgument);
        expect(
          Number(channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true)),
        ).toBe(0);
        expect(
          Number(channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true)),
        ).toBe(8);
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
        7n,
        BigInt(request),
        argument,
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0,
        0,
      ]);
      expectScratchTailUntouched(harness);
    }
  });

  it.each(SCALAR_IOCTL_REQUESTS)(
    "normalizes every scalar ioctl 0x%s from its low i32 transport bits",
    (request) => {
      for (const [argument, expectedArgument] of [
        // Reproduces wasm64 musl's unspecified upper vararg slot bytes for an
        // intended zero-valued scalar.
        [0x4_0000_0000n, 0],
        [0x5_7fff_ffffn, 0x7fff_ffff],
        [0x6_8000_0000n, 0x8000_0000],
        [0x7_ffff_ffffn, 0xffff_ffff],
        [-0x8000_0000n, 0x8000_0000],
        [-1n, 0xffff_ffff],
      ] as const) {
        const harness = makeScratchHarness(8);
        prepareGenericSyscallHarness(harness, 8);
        harness.handleChannel.mockImplementation((offset: number | bigint) => {
          const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
          expect(
            Number(channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true)),
          ).toBe(expectedArgument);
          expect(
            Number(channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true)),
          ).toBe(0);
          expect(
            Number(channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true)),
          ).toBe(8);
          channelView.setBigInt64(CH_RETURN, 0n, true);
          channelView.setUint32(CH_ERRNO, 0, true);
          return 0;
        });
        writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
          7n,
          BigInt(request),
          argument,
        ]);

        harness.worker._handleSyscallInner(harness.channel);

        expect(harness.handleChannel).toHaveBeenCalledOnce();
        expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
          0,
          0,
        ]);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it("stages no pointer for an unknown ioctl request", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(harness.kernelBytes.buffer, Number(offset));
      expect(
        Number(channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true)),
      ).toBe(0);
      expect(
        Number(channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true)),
      ).toBe(0);
      channelView.setBigInt64(CH_RETURN, -1n, true);
      channelView.setUint32(CH_ERRNO, 25, true);
      return 0;
    });
    writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
      7n,
      0xdeadn,
      0x2000_0000_0000n,
    ]);

    harness.worker._handleSyscallInner(harness.channel);

    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
      -1,
      25,
    ]);
    expectScratchTailUntouched(harness);
  });

  it.each([
    [0x49, 24],
    [0xc024_6400, 36],
  ] as const)(
    "rejects wasm64 ioctl 0x%s before a lossy layout conversion",
    (request, _wasm32Size) => {
      const harness = makeScratchHarness(8);
      prepareGenericSyscallHarness(harness, 8);
      writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
        7n,
        BigInt(request),
        4096n,
      ]);

      harness.worker._handleSyscallInner(harness.channel);

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Ioctl,
        [7, request, 4096, 0, 0, 0],
        undefined,
        -1,
        EOVERFLOW,
      );
      expectScratchTailUntouched(harness);
    },
  );
});
