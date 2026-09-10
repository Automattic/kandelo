import { describe, expect, it, vi } from "vitest";

import {
  CentralizedKernelWorker,
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";
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
  KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
  KERNEL_SCRATCH_SOCKET_OPTION_MAX_BYTES,
  POSIX_IOV_MAX,
  POSIX_NAME_MAX_BYTES,
  POSIX_NGROUPS_MAX,
  POSIX_PATH_MAX_BYTES,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
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
  STRUCT_SIZE_WASM_DIRENT,
  STRUCT_SIZE_WASM_EPOLL_EVENT,
  STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER,
  SYSCALL_ARGS,
  WASM_DIRENT_NAME_LENGTH_OFFSET,
  WASM_EPOLL_EVENT_DATA_OFFSET,
  WASM_EPOLL_EVENT_EVENTS_OFFSET,
  WASM_EPOLL_EVENT_PAD_OFFSET,
} from "../src/generated/abi";

const EFAULT = 14;
const EIO = 5;
const ENOMEM = 12;
const EINVAL = 22;
const ENOTDIR = 20;
const EOVERFLOW = 75;
const ERANGE = 34;
const EAGAIN = 11;
const EMSGSIZE = 90;
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
  kernelExports: Record<string, unknown>;
  scratchTestInstance: WebAssembly.Instance;
  kernelMemory: WebAssembly.Memory;
  scratchRegion: ReturnType<typeof allocateKernelScratchRegion>;
  allocateScratchRegionAt: (
    pointer: number,
    capacity: number,
    label: string,
  ) => ReturnType<typeof allocateKernelScratchRegion>;
  scratchOffset: number;
  scratchEnd: number;
  transferOffset: number;
  handleChannel: ReturnType<typeof vi.fn>;
  blockingRetryToken: ReturnType<typeof vi.fn>;
  blockingRetryRelease: ReturnType<typeof vi.fn>;
  handleBlockingRetry: ReturnType<typeof vi.fn>;
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

function makeScratchHarness(
  ptrWidth: 4 | 8 = 4,
  excludedExports: readonly string[] = [],
): ScratchHarness {
  const pid = 41;
  const scratchOffset = 4096;
  const scratchEnd = scratchOffset + CH_TOTAL_SIZE;
  const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
  // Keep the mailbox disjoint from caller address zero and ordinary test
  // buffers. The production layout likewise reserves channel storage outside
  // application pointer ranges; overlapping them here would make a genuine
  // dispatch overwrite the very caller bytes a boundary test is inspecting.
  const processMemory = sharedMemory(8);
  const channelOffset = 6 * 65_536;
  const kernelBytes = new Uint8Array(kernelMemory.buffer);
  const processBytes = new Uint8Array(processMemory.buffer);
  let worker!: CentralizedKernelWorker & Record<string, any>;
  let kernelExports!: Record<string, unknown>;
  const transferOffset = 2 * 65_536;
  let transferCapacity = 0;
  let nextTransferToken = 1n;
  let nextScratchAllocationPointer = scratchOffset;
  const gate = new KernelEntryGate();
  const rawScratchTestInstance = createKernelScratchTestInstance(
    ptrWidth,
    kernelMemory,
    () => kernelExports,
    () =>
      ptrWidth === 8
        ? BigInt(nextScratchAllocationPointer)
        : nextScratchAllocationPointer,
    4,
    undefined,
    excludedExports,
  );
  const scratchTestInstance = createKernelEntryGatedInstance(
    rawScratchTestInstance,
    gate,
  );
  const allocateScratchRegionAt = (
    pointer: number,
    capacity: number,
    label: string,
  ): ReturnType<typeof allocateKernelScratchRegion> => {
    nextScratchAllocationPointer = pointer;
    try {
      return allocateKernelScratchRegion(
        kernelMemory,
        scratchTestInstance.exports.kernel_alloc_scratch as (
          size: number,
        ) => number | bigint,
        capacity,
        ptrWidth,
        label,
        scratchTestInstance,
      );
    } finally {
      nextScratchAllocationPointer = scratchOffset;
    }
  };
  const scratchRegion = allocateScratchRegionAt(
    scratchOffset,
    CH_TOTAL_SIZE,
    "test kernel syscall scratch",
  );
  const channel: TestChannel = {
    pid,
    memory: processMemory,
    channelOffset,
    i32View: new Int32Array(
      processMemory.buffer,
      channelOffset,
      CH_TOTAL_SIZE / Int32Array.BYTES_PER_ELEMENT,
    ),
    consecutiveSyscalls: 0,
    handling: true,
  };
  const completeChannelRaw = vi.fn();
  const completeChannel = vi.fn();
  const handleBlockingRetry = vi.fn();
  const blockingRetryToken = vi.fn(
    (_pid: number, _tid: number, _syscallNr: number) => 1n,
  );
  const blockingRetryRelease = vi.fn(
    (_pid: number, _tid: number, _token: bigint) => 0,
  );
  const handleChannel = vi.fn(
    (
      pointer: number | bigint = scratchOffset,
      _capacity: number = CH_TOTAL_SIZE,
      _pid: number = pid,
      _retryToken: bigint = 0n,
    ) => {
      const view = new DataView(kernelMemory.buffer, Number(pointer));
      const syscall = view.getUint32(CH_SYSCALL, true);
      const iovPtr = Number(view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true));
      const transferred =
        syscall === ABI_SYSCALLS.Read ||
        syscall === ABI_SYSCALLS.Write ||
        syscall === ABI_SYSCALLS.Pread ||
        syscall === ABI_SYSCALLS.Pwrite
          ? Number(view.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true))
          : iovPtr === 0
            ? 0
            : new DataView(kernelMemory.buffer).getUint32(iovPtr + 4, true);
      view.setBigInt64(CH_RETURN, BigInt(transferred), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    },
  );
  kernelExports = {
    kernel_handle_channel: handleChannel,
    kernel_blocking_retry_token: blockingRetryToken,
    kernel_blocking_retry_release: blockingRetryRelease,
    kernel_dequeue_signal: () => 0,
    kernel_get_socket_timeout_ms: () => -1n,
    kernel_is_fd_nonblock: () => 0,
    kernel_get_process_exit_signal: () => 0,
    kernel_pick_signal_target_tid: () => 0,
    kernel_set_current_tid: () => 0,
    kernel_thread_has_deliverable: () => 0,
    kernel_transfer_scratch_begin: (minimumCapacity: number | bigint) => {
      transferCapacity = Number(minimumCapacity);
      return nextTransferToken++;
    },
    kernel_transfer_scratch_pointer: () =>
      ptrWidth === 8 ? BigInt(transferOffset) : transferOffset,
    kernel_transfer_scratch_capacity: () =>
      ptrWidth === 8 ? BigInt(transferCapacity) : transferCapacity,
    kernel_transfer_scratch_cancel: () => 0,
    kernel_transfer_channel_execute: (
      transferPid: number,
      _tid: number,
      _token: bigint,
      retryToken: bigint,
    ) =>
      handleChannel(
        ptrWidth === 8 ? BigInt(transferOffset) : transferOffset,
        transferCapacity,
        transferPid,
        retryToken,
      ),
    kernel_transfer_io_execute: (
      _pid: number,
      _tid: number,
      _token: bigint,
      length: number | bigint,
      _originalSyscall: number,
      _fd: number,
      _offset: bigint,
      _retryToken: bigint,
    ) => Number(length),
  };
  worker =
    createCentralizedKernelWorkerTestDouble() as CentralizedKernelWorker &
      Record<string, any>;
  worker.testAuthority.initializeKernelForTest({
    instance: scratchTestInstance,
    gate,
    mainScratch: scratchRegion,
    tcpScratch: scratchRegion,
  });
  worker.testAuthority.configureScratchBoundaryHooksForTest({
    getPtrWidth: () => ptrWidth,
    guestTidForChannel: () => pid,
    handleBlockingRetry: (...args: any[]) => {
      // Scratch bytes and the lexical entry token are worker-internal retry
      // state. Boundary assertions retain the historical channel/syscall/args
      // contract.
      handleBlockingRetry(...args.slice(0, 3));
    },
    deferChannelWhileStopped: () => false,
    getReadinessDeadline: () => 0,
    isRegisteredChannel: () => true,
    handleSharedMappingsAfterFileSyscall: () => {},
    synchronizeSharedMemoryForBoundary: () => {},
    completeChannel: (...args: any[]) => {
      // The suite observes the syscall completion contract, not the private
      // lexical entry token threaded through the production implementation.
      const semanticArgs = args.slice(0, 7);
      if (
        args.length >= 9 &&
        Array.isArray(args[6]) &&
        args[6].length === 0 &&
        (args[4] === -1 || args[3] === undefined)
      ) {
        // Error-only completion sites now spell the empty detached-output
        // slot solely to reach the trailing entry token. Preserve the former
        // six-argument observable completion shape.
        semanticArgs.length = 6;
      }
      completeChannel(...semanticArgs);
    },
    completeChannelRaw: (...args: any[]) => {
      // Likewise, relisten policy and entry authority are internal to the
      // worker and must not become assertion inputs.
      completeChannelRaw(...args.slice(0, 3));
    },
    relistenChannel: vi.fn(),
  });
  worker.currentHandlePid = 0;
  worker.processes = new Map([
    [
      pid,
      {
        pid,
        memory: processMemory,
        channels: [channel],
        ptrWidth,
      },
    ],
  ]);
  worker.pendingSelectRetries = new Map();
  worker.pendingPollRetries = new Map();
  worker.epollInterests = new Map();

  kernelBytes.fill(0xa5, scratchEnd, scratchEnd + 16_384);
  return {
    worker,
    channel,
    kernelBytes,
    processBytes,
    kernelExports,
    scratchTestInstance,
    kernelMemory,
    scratchRegion,
    allocateScratchRegionAt,
    scratchOffset,
    scratchEnd,
    transferOffset,
    handleChannel,
    blockingRetryToken,
    blockingRetryRelease,
    handleBlockingRetry,
    completeChannel,
    completeChannelRaw,
  };
}

function useTransferScratchInstance(harness: ScratchHarness): void {
  // The harness is always bound to this genuine gated instance. Reservation
  // imports remain late-bound through harness.kernelExports.
  expect(harness.scratchTestInstance).toBeDefined();
}

function prepareGenericSyscallHarness(
  harness: ScratchHarness,
  ptrWidth: 4 | 8,
): void {
  harness.worker.config = {};
  harness.worker.syscallRing = new Map();
  harness.worker.syscallTraceEnabled = false;
  harness.worker.syscallTraceRing = [];
  harness.worker.syscallTraceCap = 64;
  harness.worker.channelTids = new Map();
  harness.worker.processes = new Map([
    [
      harness.channel.pid,
      {
        pid: harness.channel.pid,
        memory: harness.channel.memory,
        channels: [harness.channel],
        ptrWidth,
      },
    ],
  ]);
  harness.worker.sharedMmapBackings = new Map();
  harness.worker.hostReaped = new Set();
}

function dispatchScratchBoundarySyscall(harness: ScratchHarness): void {
  harness.worker.testAuthority.dispatchScratchBoundarySyscallForTest(
    harness.channel,
  );
}

function writeChannelSyscall(
  harness: ScratchHarness,
  syscall: number,
  args: bigint[],
): void {
  const request = new DataView(
    harness.channel.memory.buffer,
    harness.channel.channelOffset,
    CH_TOTAL_SIZE,
  );
  request.setUint32(CH_SYSCALL, syscall, true);
  for (let index = 0; index < 6; index++) {
    request.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, args[index] ?? 0n, true);
  }
}

function dispatchScratchBoundarySyscallWithArgs(
  harness: ScratchHarness,
  syscall: number,
  args: readonly number[] | readonly bigint[],
): void {
  writeChannelSyscall(
    harness,
    syscall,
    args.map((value) => BigInt(value)),
  );
  dispatchScratchBoundarySyscall(harness);
}

function invokeNetworkIoctlHandler(
  harness: ScratchHarness,
  handler: string,
  pointer: number,
): void {
  const path = NETWORK_IFREQ_HANDLERS.find(
    (candidate) => candidate.handler === handler,
  );
  const request = path?.request;
  if (request === undefined) {
    throw new Error(`unknown network ioctl test handler ${handler}`);
  }
  writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
    7n,
    BigInt(request),
    BigInt(pointer),
  ]);
  dispatchScratchBoundarySyscall(harness);
}

function installCompletePathProducer(
  harness: ScratchHarness,
  path: Uint8Array,
  fd: number | null,
  directoryOnly = false,
): ReturnType<typeof vi.fn> {
  const copy = (
    pointer: number | bigint,
    capacity: number,
  ): number => {
    if (capacity === 0) return path.byteLength;
    if (capacity < path.byteLength) return -ERANGE;
    harness.kernelBytes.set(path, Number(pointer));
    return path.byteLength;
  };
  const producer = fd === null
    ? vi.fn((
      _pid: number,
      pointer: number | bigint,
      capacity: number,
    ) => copy(pointer, capacity))
    : vi.fn((
      _pid: number,
      actualFd: number,
      pointer: number | bigint,
      capacity: number,
    ) => {
      expect(actualFd).toBe(fd);
      return copy(pointer, capacity);
    });
  harness.kernelExports[
    fd === null
      ? "kernel_get_cwd"
      : directoryOnly
        ? "kernel_get_dirfd_path"
        : "kernel_get_fd_path"
  ] = producer;
  return producer;
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
  const layout =
    pointerWidth === 8
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
    const length = layout.dataOffset + descriptors.length * SCM_RIGHTS_FD_BYTES;
    const space = alignUp(length, layout.alignment);
    processBytes.fill(
      paddingByte,
      controlPointer + offset,
      controlPointer + offset + space,
    );
    if (pointerWidth === 8) {
      view.setBigUint64(
        controlPointer + offset + layout.lengthOffset,
        BigInt(length),
        true,
      );
    } else {
      view.setUint32(
        controlPointer + offset + layout.lengthOffset,
        length,
        true,
      );
    }
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
        controlPointer +
          offset +
          layout.dataOffset +
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
  const lengths = records.map(
    (descriptors) =>
      PROCESS_CMSGHDR_WASM32_DATA_OFFSET +
      descriptors.length * SCM_RIGHTS_FD_BYTES,
  );
  const output = new Uint8Array(
    lengths.reduce(
      (total, length) => total + alignUp(length, PROCESS_CMSGHDR_WASM32_ALIGN),
      0,
    ),
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  records.forEach((descriptors, recordIndex) => {
    const length = lengths[recordIndex];
    view.setUint32(offset + PROCESS_CMSGHDR_WASM32_LEN_OFFSET, length, true);
    view.setUint32(
      offset + PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET,
      SOCKET_SOL_SOCKET,
      true,
    );
    view.setUint32(
      offset + PROCESS_CMSGHDR_WASM32_TYPE_OFFSET,
      SOCKET_SCM_RIGHTS,
      true,
    );
    descriptors.forEach((descriptor, descriptorIndex) => {
      view.setInt32(
        offset +
          PROCESS_CMSGHDR_WASM32_DATA_OFFSET +
          descriptorIndex * SCM_RIGHTS_FD_BYTES,
        descriptor,
        true,
      );
    });
    offset += alignUp(length, PROCESS_CMSGHDR_WASM32_ALIGN);
  });
  return output;
}

function expectScratchTailUntouched(harness: ScratchHarness): void {
  const tail = harness.kernelBytes.subarray(
    harness.scratchEnd,
    harness.scratchEnd + 16_384,
  );
  expect(tail.every((byte) => byte === 0xa5)).toBe(true);
}

describe("complete kernel-owned path transfers", () => {
  it.each([
    [4, null],
    [8, null],
    [4, 17],
    [8, 17],
  ] as const)(
    "copies the exact main allocation capacity for wasm%s fd=%s",
    (pointerWidth, fd) => {
      const harness = makeScratchHarness(pointerWidth);
      const path = new Uint8Array(CH_TOTAL_SIZE).fill(0x61);
      path[0] = 0x2f;
      const producer = installCompletePathProducer(harness, path, fd);
      const begin = vi.spyOn(
        harness.kernelExports,
        "kernel_transfer_scratch_begin",
      );

      const result = harness.worker.testAuthority.readKernelOwnedPathForTest(
        harness.channel,
        fd,
      );

      expect(result).toEqual({ kind: "ok", value: path });
      expect(producer).toHaveBeenCalledOnce();
      expect(producer.mock.calls[0]?.at(-1)).toBe(CH_TOTAL_SIZE);
      expect(begin).not.toHaveBeenCalled();
      expect(
        harness.kernelBytes.slice(harness.scratchOffset, harness.scratchEnd),
      ).toEqual(path);
      expect(
        harness.kernelBytes.slice(harness.scratchEnd, harness.scratchEnd + 32),
      ).toEqual(new Uint8Array(32).fill(0xa5));
    },
  );

  it.each([
    [4, null],
    [8, null],
    [4, 23],
    [8, 23],
  ] as const)(
    "queries and reserves main capacity plus one for wasm%s fd=%s",
    (pointerWidth, fd) => {
      const harness = makeScratchHarness(pointerWidth);
      const path = new Uint8Array(CH_TOTAL_SIZE + 1).fill(0x62);
      path[0] = 0x2f;
      const producer = installCompletePathProducer(harness, path, fd);
      const begin = vi.spyOn(
        harness.kernelExports,
        "kernel_transfer_scratch_begin",
      );
      const cancel = vi.spyOn(
        harness.kernelExports,
        "kernel_transfer_scratch_cancel",
      );
      harness.kernelBytes[harness.transferOffset + path.byteLength] = 0x5a;

      const result = harness.worker.testAuthority.readKernelOwnedPathForTest(
        harness.channel,
        fd,
      );

      expect(result).toEqual({ kind: "ok", value: path });
      expect(
        producer.mock.calls.map((call) => call.at(-1)),
      ).toEqual([CH_TOTAL_SIZE, 0, CH_TOTAL_SIZE + 1]);
      expect(begin).toHaveBeenCalledWith(
        pointerWidth === 8 ? BigInt(path.byteLength) : path.byteLength,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        harness.kernelBytes.slice(
          harness.transferOffset,
          harness.transferOffset + path.byteLength,
        ),
      ).toEqual(path);
      expect(
        harness.kernelBytes[harness.transferOffset + path.byteLength],
      ).toBe(0x5a);
    },
  );

  it.each([4, 8] as const)(
    "propagates allocation failure without publishing a partial wasm%s path",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      const path = new Uint8Array(CH_TOTAL_SIZE + 1).fill(0x63);
      path[0] = 0x2f;
      installCompletePathProducer(harness, path, null);
      harness.kernelExports.kernel_transfer_scratch_begin = vi.fn(
        () => BigInt(-ENOMEM),
      );
      const beforeMain = harness.kernelBytes.slice(
        harness.scratchOffset,
        harness.scratchEnd,
      );

      expect(
        harness.worker.testAuthority.readKernelOwnedPathForTest(
          harness.channel,
          null,
        ),
      ).toEqual({ kind: "error", errno: ENOMEM });
      expect(
        harness.kernelBytes.slice(harness.scratchOffset, harness.scratchEnd),
      ).toEqual(beforeMain);
    },
  );

  it.each([4, 8] as const)(
    "cancels an invalid wasm%s allocator range and fails closed",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      const path = new Uint8Array(CH_TOTAL_SIZE + 1).fill(0x64);
      path[0] = 0x2f;
      installCompletePathProducer(harness, path, null);
      const token = 91n;
      harness.kernelExports.kernel_transfer_scratch_begin = vi.fn(
        () => token,
      );
      harness.kernelExports.kernel_transfer_scratch_pointer = vi.fn(
        () => pointerWidth === 8
          ? BigInt(harness.kernelMemory.buffer.byteLength - path.byteLength + 1)
          : harness.kernelMemory.buffer.byteLength - path.byteLength + 1,
      );
      harness.kernelExports.kernel_transfer_scratch_capacity = vi.fn(
        () => pointerWidth === 8
          ? BigInt(path.byteLength)
          : path.byteLength,
      );
      const cancel = vi.fn(() => 0);
      harness.kernelExports.kernel_transfer_scratch_cancel = cancel;

      expect(
        harness.worker.testAuthority.readKernelOwnedPathForTest(
          harness.channel,
          null,
        ),
      ).toEqual({ kind: "error", errno: EIO });
      expect(cancel).toHaveBeenCalledWith(token);
    },
  );

  it.each([4, 8] as const)(
    "rejects a mismatched exact retry and permits the next wasm%s transfer",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      let path = new Uint8Array(CH_TOTAL_SIZE + 1).fill(0x65);
      path[0] = 0x2f;
      const producer = installCompletePathProducer(harness, path, null);
      producer.mockImplementationOnce((
        _pid: number,
        _pointer: number | bigint,
        _capacity: number,
      ) => -ERANGE);
      producer.mockImplementationOnce((
        _pid: number,
        _pointer: number | bigint,
        _capacity: number,
      ) => path.byteLength);
      producer.mockImplementationOnce((
        _pid: number,
        _pointer: number | bigint,
        _capacity: number,
      ) => path.byteLength - 1);

      expect(
        harness.worker.testAuthority.readKernelOwnedPathForTest(
          harness.channel,
          null,
        ),
      ).toEqual({ kind: "error", errno: EIO });

      path = new TextEncoder().encode("/next");
      installCompletePathProducer(harness, path, null);
      expect(
        harness.worker.testAuthority.readKernelOwnedPathForTest(
          harness.channel,
          null,
        ),
      ).toEqual({ kind: "ok", value: path });
    },
  );

  it.each([4, 8] as const)(
    "uses the directory-only wasm%s producer for a relative dirfd base",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      const fd = 23;
      const ordinary = installCompletePathProducer(
        harness,
        new TextEncoder().encode("/regular"),
        fd,
      );
      const directory = vi.fn(() => -ENOTDIR);
      harness.kernelExports.kernel_get_dirfd_path = directory;

      expect(
        harness.worker.testAuthority.readKernelOwnedPathForTest(
          harness.channel,
          fd,
          true,
        ),
      ).toEqual({ kind: "error", errno: ENOTDIR });
      expect(directory).toHaveBeenCalledOnce();
      expect(ordinary).not.toHaveBeenCalled();
      expectScratchTailUntouched(harness);
    },
  );
});

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
    expect(new Uint8Array(kernelMemory.buffer, 4096, 4)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("fails closed when the mqueue notification drain returns an errno", () => {
    const harness = makeScratchHarness();
    const wakePendingSignalWaits = vi.fn();
    const sendSignalToProcess = vi.fn();
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      wakePendingSignalWaits,
      sendSignalToProcess,
    });
    harness.kernelExports.kernel_mq_drain_notification = vi.fn(() => -EINVAL);

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

  it("releases fstat capture and preserves a fatal export failure", () => {
    const harness = makeScratchHarness();
    const kernelMemory = harness.kernelMemory;
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
    const kernel = createWasmPosixKernelTestHarness({
      io: { fstat } as never,
      memory: kernelMemory,
      pointerWidth: 4,
    }) as WasmPosixKernel & Record<string, any>;
    harness.worker.testAuthority.replaceKernelForScratchBoundaryTest(kernel);

    let hostHandle = 501;
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(
        kernelMemory.buffer,
        Number(offset),
        CH_TOTAL_SIZE,
      );
      expect(channelView.getUint32(CH_SYSCALL, true)).toBe(ABI_SYSCALLS.Fstat);
      const statPointer = channelView.getBigUint64(CH_ARGS + CH_ARG_SIZE, true);
      expect(
        kernel.testAuthority.hostFstat(
          BigInt(hostHandle),
          kernel.toKernelPtr(statPointer),
        ),
      ).toBe(0);
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

    const cause = new Error("synthetic handleChannel failure");
    harness.handleChannel.mockImplementationOnce(() => {
      throw cause;
    });
    let exportFailure: unknown;
    try {
      capture();
    } catch (error) {
      exportFailure = error;
    }
    expect(exportFailure).toMatchObject({
      message: "kernel export kernel_handle_channel failed",
    });
    expect((exportFailure as { cause?: unknown }).cause).toBe(cause);
    expect(harness.worker.currentHandlePid).toBe(0);

    // A thrown kernel export poisons this generation. Capture cleanup restores
    // host state, but the exact fatal value must escape this catch and every
    // later entry instead of being downgraded to a recoverable EIO.
    hostHandle = 502;
    let repeatedFailure: unknown;
    try {
      capture();
    } catch (error) {
      repeatedFailure = error;
    }
    expect(repeatedFailure).toBe(exportFailure);
    expect(fstat).toHaveBeenNthCalledWith(1, 501);
    expect(fstat).toHaveBeenCalledTimes(1);
  });

  it("chunks PTY input at the exact scratch capacity and capacity + 1", () => {
    for (const length of [CH_TOTAL_SIZE, CH_TOTAL_SIZE + 1]) {
      const harness = makeScratchHarness();
      const ptyWrite = vi.fn(
        (_ptyIdx: number, _pointer: number, chunkLength: number) => chunkLength,
      );
      harness.kernelExports.kernel_pty_master_write = ptyWrite;
      harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
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
    const ptyWrite = vi.fn(
      (_ptyIdx: number, pointer: number, length: number) => {
        expect(pointer).toBe(harness.scratchOffset);
        expect(length).toBe(1);
        expect(harness.kernelBytes.slice(pointer, pointer + length)).toEqual(
          new Uint8Array([0x31]),
        );
        return length;
      },
    );
    harness.kernelExports.kernel_pty_master_write = ptyWrite;
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
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

  // This used to cover the System V segment path too, through
  // `writeSysvShmRange`. The host no longer stages segment bytes at all: the
  // SysV byte mirror is Rust-owned and the kernel reads and writes its own
  // `IpcTable` segments directly, so there is no host scratch staging left on
  // that path to defend. The pipe path keeps the identical defence.
  it("uses intrinsic source spans for pipe chunk staging", () => {
    const harness = makeScratchHarness();
    const input = hostileBytes(1, 4);
    Uint8Array.prototype.set.call(input, [0x42]);
    harness.kernelBytes.fill(
      0xa5,
      harness.scratchOffset,
      harness.scratchOffset + 8,
    );
    const writePipe = vi.fn(
      (_pid: number, _pipe: number, pointer: number, length: number) => {
        expect(length).toBe(1);
        expect(harness.kernelBytes[pointer]).toBe(0x42);
        return length;
      },
    );
    harness.kernelExports.kernel_pipe_write = writePipe;

    expect((harness.worker as any).writePipeChunked(41, 9, input)).toBe(1);

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
      expect(harness.kernelBytes.slice(pointer, pointer + length)).toEqual(
        new Uint8Array([0x55]),
      );
      return 0;
    });
    harness.worker.processes = new Map([[41, {}]]);
    harness.kernelExports.kernel_inject_datagram = inject;
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      scheduleWakeBlockedRetries: vi.fn(),
    });

    expect(
      (harness.worker as any).injectUdpDatagram(41, {
        srcAddr: new Uint8Array([10, 0, 0, 1]),
        srcPort: 1000,
        dstAddr: new Uint8Array([10, 0, 0, 2]),
        dstPort: 2000,
        data: input,
      }),
    ).toBe(0);

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
    const tcpScratchRegion = harness.allocateScratchRegionAt(
      tcpScratchOffset,
      tcpCapacity,
      "test kernel TCP scratch",
    );
    harness.worker.testAuthority.replaceTcpScratchForScratchBoundaryTest(
      tcpScratchRegion,
    );
    harness.worker.processes = new Map([[41, {}]]);
    harness.kernelExports.kernel_inject_datagram = inject;
    harness.worker.testAuthority.configureScratchBoundaryHooksForTest({
      scheduleWakeBlockedRetries: vi.fn(),
    });
    const datagram = (data: Uint8Array) => ({
      srcAddr: new Uint8Array([10, 0, 0, 1]),
      srcPort: 1000,
      dstAddr: new Uint8Array([10, 0, 0, 2]),
      dstPort: 2000,
      data,
    });

    expect(
      (harness.worker as any).injectUdpDatagram(
        41,
        datagram(new Uint8Array(tcpCapacity).fill(0x55)),
      ),
    ).toBe(0);
    expect(
      (harness.worker as any).injectUdpDatagram(
        41,
        datagram(new Uint8Array(tcpCapacity + 1).fill(0x66)),
      ),
    ).toBe(90);

    expect(inject).toHaveBeenCalledOnce();
    expect(tcpTail).toEqual(new Uint8Array(16).fill(0xa5));
    expectScratchTailUntouched(harness);
  });

  it("accepts PATH_MAX minus one cwd bytes and rejects PATH_MAX before copying", () => {
    const exact = makeScratchHarness();
    const exactPath = "x".repeat(POSIX_PATH_MAX_BYTES - 1);
    const exactSetCwd = vi.fn(
      (pid: number, pointer: number, length: number) => {
        expect(pid).toBe(41);
        expect(pointer).toBe(exact.scratchOffset);
        expect(length).toBe(POSIX_PATH_MAX_BYTES - 1);
        expect(exact.kernelBytes.slice(pointer, pointer + length)).toEqual(
          new TextEncoder().encode(exactPath),
        );
        return 0;
      },
    );
    exact.kernelExports.kernel_set_cwd = exactSetCwd;

    exact.worker.setCwd(41, exactPath);

    expect(exactSetCwd).toHaveBeenCalledOnce();
    expectScratchTailUntouched(exact);

    const oversized = makeScratchHarness();
    const oversizedSetCwd = vi.fn(() => -36);
    oversized.kernelExports.kernel_set_cwd = oversizedSetCwd;
    const scratchBeforeRejection = oversized.kernelBytes.slice(
      oversized.scratchOffset,
      oversized.scratchEnd,
    );

    expect(() =>
      oversized.worker.setCwd(41, "x".repeat(POSIX_PATH_MAX_BYTES)),
    ).toThrow(/cwd|PATH_MAX|too long/i);

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
    const harness = makeScratchHarness(4, ["kernel_set_cwd"]);
    const scratchBefore = harness.kernelBytes.slice(
      harness.scratchOffset,
      harness.scratchEnd,
    );

    expect(() => harness.worker.setCwd(41, "/tmp")).toThrow(
      "Kernel missing required kernel_set_cwd export",
    );
    expect(
      harness.kernelBytes.slice(harness.scratchOffset, harness.scratchEnd),
    ).toEqual(scratchBefore);
    expectScratchTailUntouched(harness);
  });

  it("lends the complete getgroups capacity and copies back only returned groups", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    const destination = harness.processBytes.byteLength - 20;
    const originalTail = Uint8Array.of(0xa1, 0xa2, 0xa3, 0xa4, 0xb1, 0xb2, 0xb3, 0xb4);
    harness.processBytes.set(originalTail, destination + 12);
    const groups = [0x1234_5678, 0x89ab_cdef, 0x1020_3040];
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const outputPointer = Number(
        channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      expect(outputPointer).toBeGreaterThanOrEqual(
        harness.scratchOffset + CH_DATA,
      );
      const output = new DataView(harness.kernelBytes.buffer);
      groups.forEach((gid, index) => output.setUint32(outputPointer + index * 4, gid, true));
      channelView.setBigInt64(CH_RETURN, BigInt(groups.length), true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    writeChannelSyscall(harness, ABI_SYSCALLS.Getgroups, [
      5n,
      BigInt(destination),
    ]);
    dispatchScratchBoundarySyscall(harness);

    expect(harness.completeChannel).toHaveBeenCalledTimes(1);
    const completion = harness.completeChannel.mock.calls[0];
    expect(completion.slice(4, 6)).toEqual([groups.length, 0]);
    expect(completion[6]).toEqual([
      {
        ptr: destination,
        bytes: new Uint8Array([
          0x78, 0x56, 0x34, 0x12,
          0xef, 0xcd, 0xab, 0x89,
          0x40, 0x30, 0x20, 0x10,
        ]),
      },
    ]);
    expect(harness.processBytes.slice(destination + 12, destination + 20))
      .toEqual(originalTail);
    expectScratchTailUntouched(harness);
  });

  it.each([4, 8] as const)(
    "keeps a valid wasm%s getgroups count query pointer-free",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        expect(channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true)).toBe(
          BigInt(harness.scratchOffset + CH_DATA),
        );
        channelView.setBigInt64(CH_RETURN, 3n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      writeChannelSyscall(harness, ABI_SYSCALLS.Getgroups, [
        0n,
        0n,
      ]);
      dispatchScratchBoundarySyscall(harness);

      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Getgroups,
        // A count query names no destination in either process data model.
        [0, 0, 0, 0, 0, 0],
        SYSCALL_ARGS[ABI_SYSCALLS.Getgroups],
        3,
        0,
        [],
      );
      expectScratchTailUntouched(harness);
    },
  );

  it.each([4, 8] as const)(
    "rejects a wasm%s getgroups zero-query over-report without publication",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      harness.handleChannel.mockImplementation(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.scratchOffset,
        );
        channelView.setBigInt64(
          CH_RETURN,
          BigInt(POSIX_NGROUPS_MAX + 1),
          true,
        );
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });

      writeChannelSyscall(harness, ABI_SYSCALLS.Getgroups, [0n, 0n]);
      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        -1,
        EIO,
      ]);
      expect(harness.completeChannel.mock.calls[0]?.[6] ?? []).toEqual([]);
      expectScratchTailUntouched(harness);
    },
  );

  it("generates the logical getgroups return bound", () => {
    expect(SYSCALL_ARGS[ABI_SYSCALLS.Getgroups][0]?.copyOutLength).toEqual({
      type: "return-value",
      multiplier: 4,
      maxValue: POSIX_NGROUPS_MAX,
    });
  });

  it.each([
    ["oversized count", BigInt(POSIX_NGROUPS_MAX + 1), 1n, EINVAL],
    ["multiplication overflow", BigInt(Number.MAX_SAFE_INTEGER), 1n, EINVAL],
    ["null output", 1n, 0n, EFAULT],
  ] as const)(
    "rejects an invalid getgroups %s before kernel dispatch",
    (_name, size, pointer, errno) => {
      const harness = makeScratchHarness(8);
      prepareGenericSyscallHarness(harness, 8);
      writeChannelSyscall(harness, ABI_SYSCALLS.Getgroups, [
        size,
        pointer,
      ]);
      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).not.toHaveBeenCalled();
      if (_name === "oversized count") {
        expect(harness.completeChannel).not.toHaveBeenCalled();
        expect(harness.completeChannelRaw).toHaveBeenCalledWith(
          harness.channel,
          -1,
          errno,
        );
      } else {
        expect(harness.completeChannel).toHaveBeenCalledWith(
          harness.channel,
          ABI_SYSCALLS.Getgroups,
          expect.any(Array),
          undefined,
          -1,
          errno,
        );
      }
      expectScratchTailUntouched(harness);
    },
  );

  it("accepts exact setgroups NGROUPS_MAX and rejects NGROUPS_MAX plus one", () => {
    const exactCount = POSIX_NGROUPS_MAX;
    for (const count of [exactCount, exactCount + 1]) {
      const harness = makeScratchHarness(8);
      prepareGenericSyscallHarness(harness, 8);
      const source = 4096;
      harness.processBytes.fill(0x4d, source, source + count * 4);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        const scratchPointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        expect(scratchPointer).toBe(harness.scratchOffset + CH_DATA);
        expect(
          harness.kernelBytes.slice(scratchPointer, scratchPointer + count * 4),
        ).toEqual(harness.processBytes.slice(source, source + count * 4));
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Setgroups, [
        BigInt(count),
        BigInt(source),
      ]);

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledTimes(
        count === exactCount ? 1 : 0,
      );
      if (count === exactCount) {
        expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
          0, 0,
        ]);
      } else {
        expect(harness.completeChannel).not.toHaveBeenCalled();
        expect(harness.completeChannelRaw).toHaveBeenCalledWith(
          harness.channel,
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
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        Number(offset),
      );
      expect(channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true)).toBe(
        BigInt(harness.scratchOffset + CH_DATA),
      );
      channelView.setBigInt64(CH_RETURN, 0n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    writeChannelSyscall(harness, ABI_SYSCALLS.Setgroups, [0n, ignoredPointer]);

    dispatchScratchBoundarySyscall(harness);

    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([0, 0]);
    expectScratchTailUntouched(harness);
  });

  it("rejects a null positive-count setgroups source before kernel dispatch", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    writeChannelSyscall(harness, ABI_SYSCALLS.Setgroups, [1n, 0n]);

    dispatchScratchBoundarySyscall(harness);

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

      dispatchScratchBoundarySyscall(harness);

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

      dispatchScratchBoundarySyscall(harness);

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
        expect(channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true)).toBe(
          BigInt(harness.scratchOffset + CH_DATA),
        );
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, syscallNr, [7n, 0n, 0n]);

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0, 0,
      ]);
      expectScratchTailUntouched(harness);
    },
  );

  it("rejects a u64-wide output capacity that cannot be converted losslessly", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    const destination = 4096;
    const callerCapacity = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    harness.processBytes.fill(0x7d, destination, destination + 16);
    writeChannelSyscall(harness, ABI_SYSCALLS.Getcwd, [
      BigInt(destination),
      callerCapacity,
    ]);

    dispatchScratchBoundarySyscall(harness);

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EINVAL,
    );
    expect(harness.processBytes.slice(destination, destination + 16)).toEqual(
      new Uint8Array(16).fill(0x7d),
    );
    expectScratchTailUntouched(harness);
  });

  it.each([
    ["getcwd", ABI_SYSCALLS.Getcwd, 0],
    ["realpath", ABI_SYSCALLS.Realpath, 1],
  ] as const)(
    "preserves a complete %s result beyond PATH_MAX when the caller owns a widened buffer",
    (_name, syscallNr, outputArgIndex) => {
      for (const pointerWidth of [4, 8] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        const pathPointer = 1024;
        const destination = 8192;
        const callerCapacity = CH_DATA_SIZE + 1;
        const result = new Uint8Array(POSIX_PATH_MAX_BYTES + 1).fill(0x72);
        if (syscallNr === ABI_SYSCALLS.Getcwd) {
          result[0] = 0x2f;
          result[result.length - 1] = 0;
        } else {
          harness.processBytes.set(new Uint8Array([0x2e, 0]), pathPointer);
          result[0] = 0x2f;
        }
        harness.handleChannel.mockImplementation((offset: number | bigint) => {
          expect(Number(offset)).toBe(harness.transferOffset);
          const channelView = new DataView(
            harness.kernelBytes.buffer,
            Number(offset),
          );
          const stagedPointer = Number(
            channelView.getBigInt64(
              CH_ARGS + outputArgIndex * CH_ARG_SIZE,
              true,
            ),
          );
          const capacityArgIndex =
            syscallNr === ABI_SYSCALLS.Getcwd ? 1 : 2;
          expect(
            channelView.getBigInt64(
              CH_ARGS + capacityArgIndex * CH_ARG_SIZE,
              true,
            ),
          ).toBe(BigInt(callerCapacity));
          harness.kernelBytes.set(result, stagedPointer);
          channelView.setBigInt64(CH_RETURN, BigInt(result.length), true);
          channelView.setUint32(CH_ERRNO, 0, true);
          return 0;
        });
        writeChannelSyscall(
          harness,
          syscallNr,
          syscallNr === ABI_SYSCALLS.Getcwd
            ? [BigInt(destination), BigInt(callerCapacity)]
            : [
                BigInt(pathPointer),
                BigInt(destination),
                BigInt(callerCapacity),
              ],
        );

        dispatchScratchBoundarySyscall(harness);

        expect(harness.handleChannel).toHaveBeenCalledOnce();
        const writes = harness.completeChannel.mock.calls[0]?.[6] as Array<{
          ptr: number;
          bytes: Uint8Array;
        }>;
        expect(writes).toEqual([{ ptr: destination, bytes: result }]);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "copies a complete wasm%s legacy readdir name from a channel-capacity-plus-one caller",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const direntPointer = 4096;
      const namePointer = 8192;
      const name = new Uint8Array(POSIX_NAME_MAX_BYTES - 1).fill(0x6e);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        const stagedDirentPointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const stagedNamePointer = Number(
          channelView.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true),
        );
        expect(channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true))
          .toBe(BigInt(POSIX_NAME_MAX_BYTES));
        new DataView(harness.kernelBytes.buffer).setUint32(
          stagedDirentPointer + WASM_DIRENT_NAME_LENGTH_OFFSET,
          name.byteLength,
          true,
        );
        harness.kernelBytes.set(name, stagedNamePointer);
        channelView.setBigInt64(CH_RETURN, 1n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Readdir, [
        7n,
        BigInt(direntPointer),
        BigInt(namePointer),
        BigInt(CH_DATA_SIZE + 1),
      ]);

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      const writes = harness.completeChannel.mock.calls[0]?.[6] as Array<{
        ptr: number;
        bytes: Uint8Array;
      }>;
      expect(writes).toHaveLength(2);
      expect(writes[0]?.ptr).toBe(direntPointer);
      expect(writes[0]?.bytes).toHaveLength(STRUCT_SIZE_WASM_DIRENT);
      expect(writes[1]).toEqual({ ptr: namePointer, bytes: name });
      expectScratchTailUntouched(harness);
    },
  );

  it.each([4, 8] as const)(
    "rejects a wasm%s readdir name length beyond its owned capacity atomically",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const direntPointer = 4096;
      const namePointer = 8192;
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        const stagedDirentPointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        new DataView(harness.kernelBytes.buffer).setUint32(
          stagedDirentPointer + WASM_DIRENT_NAME_LENGTH_OFFSET,
          POSIX_NAME_MAX_BYTES + 1,
          true,
        );
        channelView.setBigInt64(CH_RETURN, 1n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Readdir, [
        7n,
        BigInt(direntPointer),
        BigInt(namePointer),
        BigInt(CH_DATA_SIZE + 1),
      ]);

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        -1,
        EIO,
      ]);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([4, 8] as const)(
    "rejects a wasm%s readdir name over-report against zero caller capacity atomically",
    (pointerWidth) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      const direntPointer = 4096;
      const beforeDirent = new Uint8Array(STRUCT_SIZE_WASM_DIRENT).fill(0x5a);
      harness.processBytes.set(beforeDirent, direntPointer);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        const stagedDirentPointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        new DataView(harness.kernelBytes.buffer).setUint32(
          stagedDirentPointer + WASM_DIRENT_NAME_LENGTH_OFFSET,
          1,
          true,
        );
        channelView.setBigInt64(CH_RETURN, 1n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Readdir, [
        7n,
        BigInt(direntPointer),
        pointerWidth === 8 ? -1n : 0xffff_ffffn,
        0n,
      ]);

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        -1,
        EIO,
      ]);
      expect(harness.completeChannel.mock.calls[0]?.[6] ?? []).toEqual([]);
      expect(
        harness.processBytes.slice(
          direntPointer,
          direntPointer + STRUCT_SIZE_WASM_DIRENT,
        ),
      ).toEqual(beforeDirent);
      expectScratchTailUntouched(harness);
    },
  );

  // The three mq_timedsend/mq_timedreceive EMSGSIZE cases that stood here died
  // with their subject. They proved the HOST resolved the queue's own
  // `mq_msgsize` — through a dedicated kernel export — before reserving space
  // for the caller's bytes, so an oversized `msg_len` reported EMSGSIZE rather
  // than the ENOMEM a failed reservation would have produced. The caller's
  // buffer is a kernel-dereferenced guest address now, so that ordering lives
  // inside the kernel's own dispatch and the export is gone. The equivalent
  // proof is `mqueue_zero_length_message_never_constructs_a_null_raw_slice` in
  // `crates/kernel/tests/wasm_api_channel_pointer_contract.rs`, which pins
  // that `mq_msgsize` is resolved and compared BEFORE any caller memory is
  // read.

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
        expect(channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true)).toBe(1n);
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, ABI_SYSCALLS.Prctl, [
        BigInt(PR_SET_NO_NEW_PRIVS),
        rawScalar,
      ]);

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0, 0,
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

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      if (direction === "out") {
        const writes = harness.completeChannel.mock.calls[0]?.[6] as Array<{
          ptr: number;
          bytes: Uint8Array;
        }>;
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
      writeChannelSyscall(harness, ABI_SYSCALLS.Prctl, [BigInt(option), 0n]);

      dispatchScratchBoundarySyscall(harness);

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

  // ---------------------------------------------------------------------
  // RETIRED: the host's iovec marshaller, and the cases that pinned it.
  //
  // These drove `handleWritev` / `handleReadv` -- methods that walked the
  // caller's `struct iovec` table in TypeScript, bounded `iovcnt`, proved
  // every nested range, flattened the payload into kernel scratch, rewrote the
  // syscall to its scalar twin, and scattered the result back by hand. None of
  // that exists. Argument 1 of writev/readv/preadv/pwritev/preadv2/pwritev2 is
  // `SyscallArgSize::KernelDereferenced`, so the host passes the caller's raw
  // guest address through and the kernel walks the table itself.
  //
  // Every property they held is still proven, where it is now enforced:
  //
  // * `IOV_MAX`, aggregate `SSIZE_MAX`, a negative count, and a zero count
  //   ignoring the table pointer -- `msghdr::read_iovecs` and its tests in
  //   `crates/runtime-core/src/msghdr.rs`.
  // * PIPE_BUF atomicity, datagram boundaries, eventfd record atomicity,
  //   RLIMIT_FSIZE, EBADF by direction, ESPIPE, and offset-before-access
  //   ordering -- `syscalls::sys_vector_io` and its tests in
  //   `crates/runtime-core/src/syscalls.rs`, each staging a real guest table.
  // * A zero-length entry whose base is unrepresentable, an `IOV_MAX`-wide
  //   table at the capacity edge, large multi-entry vectors, positioned
  //   offsets, and cursor neutrality -- end to end on BOTH caller widths by
  //   `examples/kernel_scratch_browser_test.c`, run from
  //   `test/kernel-scratch-runtime.test.ts`.
  // * That no vector syscall touches the reserved-transfer protocol --
  //   `test/kernel-large-transfer-protocol.test.ts`.
  //
  // ONE PROPERTY DELIBERATELY CHANGED, and it is not a silent one. The
  // marshaller accepted a caller table or buffer at guest address zero,
  // arguing that byte 0 of a guest's linear memory is addressable and that the
  // range proof, not a null-pointer convention, establishes ownership. The
  // cross-memory primitives these arguments now travel through refuse it --
  // see "rejects null positive-length process transfer ranges" in
  // `test/kernel-public-scratch.test.ts`, which pins that deliberately. Linux
  // agrees: `iov_base == NULL` with a positive `iov_len`, or a null `iov`
  // itself, is EFAULT. So the vector family now reports EFAULT there, as every
  // other kernel-dereferenced argument already did after K6. Recorded in
  // `docs/abi-versioning.md`.
  // ---------------------------------------------------------------------


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
        offsets.push(channelView.getBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, true));
        channelView.setBigInt64(CH_RETURN, 0n, true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      writeChannelSyscall(harness, syscallNr, [7n, BigInt(buffer), 4n, offset]);

      dispatchScratchBoundarySyscall(harness);

      expect(offsets).toEqual([offset]);
      expectScratchTailUntouched(harness);
    },
  );

  it.each([
    ["wasm32", 4, "write", ABI_SYSCALLS.Write, false, null],
    ["wasm32", 4, "read", ABI_SYSCALLS.Read, true, null],
    ["wasm32", 4, "pwrite", ABI_SYSCALLS.Pwrite, false, 9_007_199_254_740_993n],
    ["wasm32", 4, "pread", ABI_SYSCALLS.Pread, true, 9_007_199_254_740_993n],
    ["wasm64", 8, "write", ABI_SYSCALLS.Write, false, null],
    ["wasm64", 8, "read", ABI_SYSCALLS.Read, true, null],
    ["wasm64", 8, "pwrite", ABI_SYSCALLS.Pwrite, false, 9_007_199_254_740_993n],
    ["wasm64", 8, "pread", ABI_SYSCALLS.Pread, true, 9_007_199_254_740_993n],
  ] as const)(
    "%s large %s uses one reservation and preserves its exact offset",
    (_widthName, pointerWidth, _name, syscallNr, readOperation, offset) => {
      const harness = makeScratchHarness(pointerWidth);
      prepareGenericSyscallHarness(harness, pointerWidth);
      useTransferScratchInstance(harness);
      const buffer = 65_536;
      const length = CH_DATA_SIZE + 1;
      const payload = Uint8Array.from(
        { length },
        (_, index) => (index * 29 + 5) % 251,
      );
      if (!readOperation) {
        harness.processBytes.set(payload, buffer);
      }
      const returned = readOperation ? 3 : length;
      const execute = vi.fn(
        (
          pid: number,
          _tid: number,
          _token: bigint,
          offered: number | bigint,
          originalSyscall: number,
          _fd: number,
          exactOffset: bigint,
          retryToken: bigint,
        ) => {
          expect(pid).toBe(harness.channel.pid);
          expect(harness.worker.currentHandlePid).toBe(harness.channel.pid);
          expect(Number(offered)).toBe(length);
          expect(originalSyscall).toBe(syscallNr);
          expect(exactOffset).toBe(offset ?? 0n);
          expect(retryToken).toBe(0n);
          if (readOperation) {
            harness.kernelBytes.set(
              payload.subarray(0, returned),
              harness.transferOffset,
            );
          } else {
            expect(
              harness.kernelBytes.slice(
                harness.transferOffset,
                harness.transferOffset + length,
              ),
            ).toEqual(payload);
          }
          return returned;
        },
      );
      harness.kernelExports.kernel_transfer_io_execute = execute;
      writeChannelSyscall(harness, syscallNr, [
        7n,
        BigInt(buffer),
        BigInt(length),
        offset ?? 0n,
      ]);

      dispatchScratchBoundarySyscall(harness);

      expect(execute).toHaveBeenCalledOnce();
      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.worker.currentHandlePid).toBe(0);
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        returned,
        0,
      ]);
      if (readOperation) {
        expect(harness.processBytes.slice(buffer, buffer + returned)).toEqual(
          payload.subarray(0, returned),
        );
      }
      expectScratchTailUntouched(harness);
    },
  );

  it("rejects an out-of-range source before a large write kernel call", () => {
    const harness = makeScratchHarness();
    const source = harness.processBytes.byteLength - 8;

    dispatchScratchBoundarySyscallWithArgs(harness, ABI_SYSCALLS.Write, [
      7n,
      BigInt(source),
      BigInt(CH_DATA_SIZE + 1),
      0n,
      0n,
      0n,
    ]);

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

    dispatchScratchBoundarySyscallWithArgs(harness, ABI_SYSCALLS.Read, [
      7n,
      BigInt(destination),
      BigInt(CH_DATA_SIZE + 1),
      0n,
      0n,
      0n,
    ]);

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
    (_name, _method, syscall) => {
      const harness = makeScratchHarness();
      const invalidSet = harness.processBytes.byteLength - 4;

      expect(() =>
        dispatchScratchBoundarySyscallWithArgs(harness, syscall, [
          1,
          invalidSet,
          0,
          0,
          0,
          0,
        ]),
      ).not.toThrow();

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

    expect(() =>
      dispatchScratchBoundarySyscallWithArgs(harness, ABI_SYSCALLS.EpollCtl, [
        3,
        1,
        7,
        invalidEvent,
        0,
        0,
      ]),
    ).not.toThrow();

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

    dispatchScratchBoundarySyscallWithArgs(harness, ABI_SYSCALLS.EpollCtl, [
      3n,
      1n,
      7n,
      BigInt(eventPointer),
      0n,
      0n,
    ]);

    expect(harness.handleChannel).toHaveBeenCalledTimes(1);
    expect(harness.worker.epollInterests.get("41:3")).toEqual([
      {
        fd: 7,
        events: 0x1234,
        data: expectedData,
      },
    ]);
    expectScratchTailUntouched(harness);
  });

  it("rejects an out-of-range epoll output array before polling", () => {
    const harness = makeScratchHarness();
    const invalidEvents =
      harness.processBytes.byteLength - STRUCT_SIZE_WASM_EPOLL_EVENT + 1;
    harness.worker.epollInterests.set("41:3", [
      {
        fd: 7,
        events: 1,
        data: 9n,
      },
    ]);

    expect(() =>
      dispatchScratchBoundarySyscallWithArgs(harness, ABI_SYSCALLS.EpollPwait, [
        3,
        invalidEvents,
        1,
        0,
        0,
        0,
      ]),
    ).not.toThrow();

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
    harness.worker.epollInterests.set("41:3", [
      {
        fd: 7,
        events: 1,
        data: expectedData,
      },
    ]);
    harness.handleChannel.mockImplementation(() => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        harness.scratchOffset,
      );
      const pollfdsPointer = Number(channelView.getBigInt64(CH_ARGS, true));
      new DataView(harness.kernelBytes.buffer).setInt16(
        pollfdsPointer + 6,
        1,
        true,
      );
      channelView.setBigInt64(CH_RETURN, 1n, true);
      channelView.setUint32(CH_ERRNO, 0, true);
      return 0;
    });

    dispatchScratchBoundarySyscallWithArgs(harness, ABI_SYSCALLS.EpollPwait, [
      3n,
      BigInt(eventsPointer),
      1n,
      0n,
      0n,
      0n,
    ]);

    const output = new DataView(
      harness.processBytes.buffer,
      eventsPointer,
      STRUCT_SIZE_WASM_EPOLL_EVENT,
    );
    expect(output.getUint32(WASM_EPOLL_EVENT_EVENTS_OFFSET, true)).toBe(1);
    expect(output.getUint32(WASM_EPOLL_EVENT_PAD_OFFSET, true)).toBe(0);
    expect(output.getBigUint64(WASM_EPOLL_EVENT_DATA_OFFSET, true)).toBe(
      expectedData,
    );
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      1,
      0,
    );
    expectScratchTailUntouched(harness);
  });

  // The SysV msgsnd/msgrcv/msgctl/shmctl/semctl scratch-boundary cases that
  // stood here died with their subject. They proved the HOST's translation of
  // caller-native structures into the fixed kernel scratch wire: the
  // native-`long` msgbuf prefix, the cmd-dependent IPC_STAT/IPC_SET direction,
  // and the permission-aware semctl array sizing. None of that crosses the
  // scratch channel any more — those arguments are declared
  // KernelDereferenced, so the kernel reads and writes the caller's memory
  // itself. The equivalent proofs now live in Rust beside the layouts:
  // `crates/runtime-core/src/ipc_wire.rs` and
  // `crates/runtime-core/src/guest_ptr.rs`.

  it("rejects a negative generic descriptor length before scratch mutation", () => {
    const harness = makeScratchHarness();
    prepareGenericSyscallHarness(harness, 4);
    const request = new DataView(
      harness.channel.memory.buffer,
      harness.channel.channelOffset,
      CH_TOTAL_SIZE,
    );
    request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Read, true);
    request.setBigInt64(CH_ARGS, 7n, true);
    request.setBigInt64(CH_ARGS + CH_ARG_SIZE, 1024n, true);
    request.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, -1n, true);

    expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

    expect(harness.handleChannel).not.toHaveBeenCalled();
    expect(harness.completeChannel).not.toHaveBeenCalled();
    expect(harness.completeChannelRaw).toHaveBeenCalledWith(
      harness.channel,
      -1,
      EINVAL,
    );
    expectScratchTailUntouched(harness);
  });

  it.each([4, 8] as const)(
    "rejects wasm%s generic byte-output over-reports without publishing partial bytes",
    (pointerWidth) => {
      const capacity = 31;
      const destination = 8192;
      const callerCanary = 0x6d;
      for (const testCase of [
        {
          name: "read",
          syscall: ABI_SYSCALLS.Read,
          args: [7n, BigInt(destination), BigInt(capacity)],
          pointerArgIndex: 1,
        },
        {
          name: "getrandom",
          syscall: ABI_SYSCALLS.Getrandom,
          args: [BigInt(destination), BigInt(capacity), 0n],
          pointerArgIndex: 0,
        },
        {
          name: "getdents64",
          syscall: ABI_SYSCALLS.Getdents64,
          args: [7n, BigInt(destination), BigInt(capacity)],
          pointerArgIndex: 1,
        },
      ] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.processBytes.fill(
          callerCanary,
          destination,
          destination + capacity + 1,
        );
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            const stagedPointer = Number(
              channelView.getBigInt64(
                CH_ARGS + testCase.pointerArgIndex * CH_ARG_SIZE,
                true,
              ),
            );
            harness.kernelBytes.fill(
              0x3c,
              stagedPointer,
              stagedPointer + capacity,
            );
            channelView.setBigInt64(CH_RETURN, BigInt(capacity + 1), true);
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        writeChannelSyscall(
          harness,
          testCase.syscall,
          [...testCase.args],
        );

        dispatchScratchBoundarySyscall(harness);

        expect(
          harness.completeChannel,
          testCase.name,
        ).toHaveBeenCalledOnce();
        const completion = harness.completeChannel.mock.calls[0]!;
        expect(completion[4], testCase.name).toBe(-1);
        expect(completion[5], testCase.name).toBe(EIO);
        // The test adapter drops an empty detached-output slot on errors. A
        // prefix-clamping implementation would leave a non-empty write here.
        expect(completion[6], testCase.name).toBeUndefined();
        expect(
          harness.processBytes.slice(
            destination,
            destination + capacity + 1,
          ),
          testCase.name,
        ).toEqual(new Uint8Array(capacity + 1).fill(callerCanary));
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "uses capacity-carrying scratch for wasm%s readlink outputs at the remaining mailbox capacity and capacity plus one",
    (pointerWidth) => {
      const pathPointer = 256;
      const destination = 65_536;
      const path = Uint8Array.of(0x78, 0);
      // The two-byte path occupies one aligned eight-byte subregion before
      // the output. These are therefore the exact largest ordinary output and
      // its first widened successor, not merely the raw CH_DATA_SIZE values.
      const exactOutputCapacity = CH_DATA_SIZE - 8;
      const target = Uint8Array.from(
        { length: exactOutputCapacity + 1 },
        (_, index) => (index * 37 + 11) % 251,
      );

      for (const testCase of [
        {
          name: "readlink",
          syscall: ABI_SYSCALLS.Readlink,
          pathArgIndex: 0,
          outputArgIndex: 1,
          args: (capacity: number) => [
            BigInt(pathPointer),
            BigInt(destination),
            BigInt(capacity),
          ],
        },
        {
          name: "readlinkat",
          syscall: ABI_SYSCALLS.Readlinkat,
          pathArgIndex: 1,
          outputArgIndex: 2,
          args: (capacity: number) => [
            9n,
            BigInt(pathPointer),
            BigInt(destination),
            BigInt(capacity),
          ],
        },
      ] as const) {
        for (
          const capacity of [
            exactOutputCapacity,
            exactOutputCapacity + 1,
          ]
        ) {
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          harness.processBytes.set(path, pathPointer);
          // The exact-capacity call returns the complete widened target. The
          // one-byte-short call models readlink's caller-controlled prefix
          // truncation at the last fixed-mailbox capacity.
          const payload = target.slice(0, capacity);
          const begin = vi.spyOn(
            harness.kernelExports,
            "kernel_transfer_scratch_begin",
          );
          harness.handleChannel.mockImplementation(
            (offset: number | bigint) => {
              const channelBase = Number(offset);
              const reserved = capacity > exactOutputCapacity;
              expect(channelBase, testCase.name).toBe(
                reserved ? harness.transferOffset : harness.scratchOffset,
              );
              const channelView = new DataView(
                harness.kernelBytes.buffer,
                channelBase,
              );
              expect(channelView.getUint32(CH_SYSCALL, true)).toBe(
                testCase.syscall,
              );
              const stagedPath = Number(
                channelView.getBigInt64(
                  CH_ARGS + testCase.pathArgIndex * CH_ARG_SIZE,
                  true,
                ),
              );
              const stagedOutput = Number(
                channelView.getBigInt64(
                  CH_ARGS + testCase.outputArgIndex * CH_ARG_SIZE,
                  true,
                ),
              );
              expect(
                harness.kernelBytes.slice(
                  stagedPath,
                  stagedPath + path.byteLength,
                ),
                testCase.name,
              ).toEqual(path);
              expect(stagedOutput, testCase.name).toBe(
                channelBase + CH_DATA + 8,
              );
              harness.kernelBytes.set(payload, stagedOutput);
              channelView.setBigInt64(CH_RETURN, BigInt(capacity), true);
              channelView.setUint32(CH_ERRNO, 0, true);
              return 0;
            },
          );
          writeChannelSyscall(
            harness,
            testCase.syscall,
            testCase.args(capacity),
          );

          dispatchScratchBoundarySyscall(harness);

          expect(begin, testCase.name).toHaveBeenCalledTimes(
            capacity === exactOutputCapacity ? 0 : 1,
          );
          expect(
            harness.completeChannel.mock.calls[0]?.slice(4, 6),
            testCase.name,
          ).toEqual([capacity, 0]);
          expect(
            harness.completeChannel.mock.calls[0]?.[6],
            testCase.name,
          ).toEqual([{ ptr: destination, bytes: payload }]);
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([4, 8] as const)(
    "preserves the complete wasm%s maximum environment value and one-short ERANGE atomically",
    (pointerWidth) => {
      const namePointer = 256;
      const destination = 65_536;
      const name = Uint8Array.of(0x58, 0);
      // An admitted `X=<value>` entry may consume the complete metadata-entry
      // ceiling. The returned value excludes `X=`.
      const value = new Uint8Array(
        PROCESS_METADATA_ENTRY_MAX_BYTES - 2,
      ).fill(0x76);
      const callerCanary = 0x6d;

      for (const capacity of [value.byteLength, value.byteLength - 1]) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.processBytes.set(name, namePointer);
        harness.processBytes.fill(
          callerCanary,
          destination,
          destination + value.byteLength + 1,
        );
        const plannedCapacity = alignUp(
          CH_DATA + 8 + capacity,
          8,
        );
        const transferTail = harness.transferOffset + plannedCapacity;
        harness.kernelBytes.fill(0xc7, transferTail, transferTail + 16);
        const begin = vi.spyOn(
          harness.kernelExports,
          "kernel_transfer_scratch_begin",
        );
        harness.completeChannel.mockImplementation(
          (
            _channel: TestChannel,
            _syscall: number,
            _origArgs: number[],
            _descs: unknown,
            _retVal: number,
            _errno: number,
            writes: Array<{ ptr: number; bytes: Uint8Array }> = [],
          ) => {
            for (const write of writes) {
              harness.processBytes.set(write.bytes, write.ptr);
            }
          },
        );
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelBase = Number(offset);
            expect(channelBase).toBe(harness.transferOffset);
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              channelBase,
            );
            const stagedName = Number(
              channelView.getBigInt64(CH_ARGS, true),
            );
            const stagedOutput = Number(
              channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
            );
            expect(
              harness.kernelBytes.slice(
                stagedName,
                stagedName + name.byteLength,
              ),
            ).toEqual(name);
            expect(stagedOutput).toBe(channelBase + CH_DATA + 8);
            expect(
              Number(
                channelView.getBigInt64(
                  CH_ARGS + 2 * CH_ARG_SIZE,
                  true,
                ),
              ),
            ).toBe(capacity);
            if (capacity === value.byteLength) {
              harness.kernelBytes.set(value, stagedOutput);
              channelView.setBigInt64(
                CH_RETURN,
                BigInt(value.byteLength),
                true,
              );
              channelView.setUint32(CH_ERRNO, 0, true);
            } else {
              // Even hostile scratch bytes must not become an observable
              // prefix when the complete value does not fit.
              harness.kernelBytes.fill(
                0x3c,
                stagedOutput,
                stagedOutput + capacity,
              );
              channelView.setBigInt64(CH_RETURN, -1n, true);
              channelView.setUint32(CH_ERRNO, ERANGE, true);
            }
            return 0;
          },
        );
        writeChannelSyscall(harness, ABI_SYSCALLS.GetEnv, [
          BigInt(namePointer),
          BigInt(destination),
          BigInt(capacity),
        ]);

        dispatchScratchBoundarySyscall(harness);

        expect(begin).toHaveBeenCalledOnce();
        expect(Number(begin.mock.calls[0]?.[0])).toBe(plannedCapacity);
        expect(
          harness.completeChannel.mock.calls[0]?.slice(4, 6),
        ).toEqual(
          capacity === value.byteLength
            ? [value.byteLength, 0]
            : [-1, ERANGE],
        );
        if (capacity === value.byteLength) {
          expect(
            harness.processBytes.slice(
              destination,
              destination + value.byteLength,
            ),
          ).toEqual(value);
          expect(
            harness.processBytes[destination + value.byteLength],
          ).toBe(callerCanary);
        } else {
          expect(
            harness.processBytes.slice(
              destination,
              destination + value.byteLength + 1,
            ),
          ).toEqual(
            new Uint8Array(value.byteLength + 1).fill(callerCanary),
          );
        }
        expect(
          harness.kernelBytes.slice(transferTail, transferTail + 16),
        ).toEqual(new Uint8Array(16).fill(0xc7));
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "caps only short-safe wasm%s outputs at channel capacity and capacity plus one",
    (pointerWidth) => {
      const destination = 65_536;
      const randomBytes = Uint8Array.from(
        { length: CH_DATA_SIZE },
        (_, index) => (index * 43 + 17) % 251,
      );
      const direntRecordBytes = 24;
      const direntBytes = new Uint8Array(
        Math.floor(CH_DATA_SIZE / direntRecordBytes)
          * direntRecordBytes,
      );
      const direntView = new DataView(direntBytes.buffer);
      for (
        let offset = 0, record = 0;
        offset < direntBytes.byteLength;
        offset += direntRecordBytes, record++
      ) {
        direntView.setBigUint64(offset, BigInt(record + 1), true);
        direntView.setBigInt64(offset + 8, BigInt(record + 1), true);
        direntView.setUint16(offset + 16, direntRecordBytes, true);
        direntView.setUint8(offset + 18, 8);
        direntView.setUint8(offset + 19, 0x61 + (record % 26));
        direntView.setUint8(offset + 20, 0);
      }

      for (const testCase of [
        {
          name: "getrandom",
          syscall: ABI_SYSCALLS.Getrandom,
          pointerArgIndex: 0,
          countArgIndex: 1,
          payload: randomBytes,
          args: (capacity: number) => [
            BigInt(destination),
            BigInt(capacity),
            0n,
          ],
        },
        {
          name: "getdents64",
          syscall: ABI_SYSCALLS.Getdents64,
          pointerArgIndex: 1,
          countArgIndex: 2,
          payload: direntBytes,
          args: (capacity: number) => [
            7n,
            BigInt(destination),
            BigInt(capacity),
          ],
        },
      ] as const) {
        for (
          const callerCapacity of [
            CH_DATA_SIZE,
            CH_DATA_SIZE + 1,
          ]
        ) {
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          const callerCanary = 0x6d;
          harness.processBytes.fill(
            callerCanary,
            destination,
            destination + callerCapacity + 1,
          );
          const begin = vi.spyOn(
            harness.kernelExports,
            "kernel_transfer_scratch_begin",
          );
          harness.completeChannel.mockImplementation(
            (
              _channel: TestChannel,
              _syscall: number,
              _origArgs: number[],
              _descs: unknown,
              _retVal: number,
              _errno: number,
              writes: Array<{ ptr: number; bytes: Uint8Array }> = [],
            ) => {
              for (const write of writes) {
                harness.processBytes.set(write.bytes, write.ptr);
              }
            },
          );
          harness.handleChannel.mockImplementation(
            (offset: number | bigint) => {
              const channelBase = Number(offset);
              expect(channelBase, testCase.name).toBe(
                harness.scratchOffset,
              );
              const channelView = new DataView(
                harness.kernelBytes.buffer,
                channelBase,
              );
              expect(
                Number(
                  channelView.getBigInt64(
                    CH_ARGS + testCase.countArgIndex * CH_ARG_SIZE,
                    true,
                  ),
                ),
                testCase.name,
              ).toBe(CH_DATA_SIZE);
              const stagedOutput = Number(
                channelView.getBigInt64(
                  CH_ARGS + testCase.pointerArgIndex * CH_ARG_SIZE,
                  true,
                ),
              );
              expect(stagedOutput, testCase.name).toBe(
                channelBase + CH_DATA,
              );
              harness.kernelBytes.set(testCase.payload, stagedOutput);
              channelView.setBigInt64(
                CH_RETURN,
                BigInt(testCase.payload.byteLength),
                true,
              );
              channelView.setUint32(CH_ERRNO, 0, true);
              return 0;
            },
          );
          writeChannelSyscall(
            harness,
            testCase.syscall,
            testCase.args(callerCapacity),
          );

          dispatchScratchBoundarySyscall(harness);

          expect(begin, testCase.name).not.toHaveBeenCalled();
          expect(
            harness.completeChannel.mock.calls[0]?.slice(4, 6),
            testCase.name,
          ).toEqual([testCase.payload.byteLength, 0]);
          expect(
            harness.processBytes.slice(
              destination,
              destination + testCase.payload.byteLength,
            ),
            testCase.name,
          ).toEqual(testCase.payload);
          expect(
            harness.processBytes.slice(
              destination + testCase.payload.byteLength,
              destination + callerCapacity + 1,
            ),
            testCase.name,
          ).toEqual(
            new Uint8Array(
              callerCapacity + 1 - testCase.payload.byteLength,
            ).fill(callerCanary),
          );
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([4, 8] as const)(
    "preserves wasm%s MSG_TRUNC scalar receive semantics within owned capacity",
    (pointerWidth) => {
      const capacity = 4;
      const reportedLength = 13;
      const destination = 8192;
      const expected = new TextEncoder().encode("recv");
      for (const testCase of [
        {
          name: "recv",
          syscall: ABI_SYSCALLS.Recv,
          args: [
            7n,
            BigInt(destination),
            BigInt(capacity),
            BigInt(SOCKET_MSG_TRUNC),
          ],
        },
        {
          name: "recvfrom",
          syscall: ABI_SYSCALLS.Recvfrom,
          args: [
            7n,
            BigInt(destination),
            BigInt(capacity),
            BigInt(SOCKET_MSG_TRUNC),
            0n,
            0n,
          ],
        },
      ] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            const stagedPointer = Number(
              channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
            );
            harness.kernelBytes.set(expected, stagedPointer);
            channelView.setBigInt64(
              CH_RETURN,
              BigInt(reportedLength),
              true,
            );
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        writeChannelSyscall(
          harness,
          testCase.syscall,
          [...testCase.args],
        );

        dispatchScratchBoundarySyscall(harness);

        expect(
          harness.completeChannel,
          testCase.name,
        ).toHaveBeenCalledOnce();
        const completion = harness.completeChannel.mock.calls[0]!;
        expect(completion[4], testCase.name).toBe(reportedLength);
        expect(completion[5], testCase.name).toBe(0);
        expect(completion[6], testCase.name).toEqual([
          {
            ptr: destination,
            bytes: expected,
          },
        ]);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "uses capacity-carrying scratch for wasm%s scalar socket data at channel capacity and capacity plus one",
    (pointerWidth) => {
      for (const testCase of [
        {
          name: "send",
          syscall: ABI_SYSCALLS.Send,
          input: true,
          args: [7n, 0n, 0n, 0n],
        },
        {
          name: "recv",
          syscall: ABI_SYSCALLS.Recv,
          input: false,
          args: [7n, 0n, 0n, 0n],
        },
        {
          name: "sendto",
          syscall: ABI_SYSCALLS.Sendto,
          input: true,
          args: [7n, 0n, 0n, 0n, 0n, 0n],
        },
        {
          name: "recvfrom",
          syscall: ABI_SYSCALLS.Recvfrom,
          input: false,
          args: [7n, 0n, 0n, 0n, 0n, 0n],
        },
      ] as const) {
        for (const length of [CH_DATA_SIZE, CH_DATA_SIZE + 1]) {
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          const processPointer = harness.processBytes.byteLength - length;
          const payload = Uint8Array.from(
            { length },
            (_, index) => (index * 31 + 7) % 251,
          );
          if (testCase.input) {
            harness.processBytes.set(payload, processPointer);
          } else {
            harness.processBytes.fill(
              0x6d,
              processPointer,
              processPointer + length,
            );
          }
          const begin = vi.spyOn(
            harness.kernelExports,
            "kernel_transfer_scratch_begin",
          );
          harness.handleChannel.mockImplementation(
            (offset: number | bigint) => {
              expect(Number(offset), testCase.name).toBe(
                length === CH_DATA_SIZE
                  ? harness.scratchOffset
                  : harness.transferOffset,
              );
              const channelView = new DataView(
                harness.kernelBytes.buffer,
                Number(offset),
              );
              const stagedPointer = Number(
                channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
              );
              if (testCase.input) {
                expect(
                  harness.kernelBytes.slice(
                    stagedPointer,
                    stagedPointer + length,
                  ),
                  testCase.name,
                ).toEqual(payload);
              } else {
                harness.kernelBytes.set(payload, stagedPointer);
              }
              channelView.setBigInt64(CH_RETURN, BigInt(length), true);
              channelView.setUint32(CH_ERRNO, 0, true);
              return 0;
            },
          );
          const args = [...testCase.args];
          args[1] = BigInt(processPointer);
          args[2] = BigInt(length);
          writeChannelSyscall(harness, testCase.syscall, args);

          dispatchScratchBoundarySyscall(harness);

          expect(
            harness.handleChannel,
            testCase.name,
          ).toHaveBeenCalledOnce();
          expect(begin, testCase.name).toHaveBeenCalledTimes(
            length === CH_DATA_SIZE ? 0 : 1,
          );
          expect(
            harness.completeChannel.mock.calls[0]?.slice(4, 6),
            testCase.name,
          ).toEqual([length, 0]);
          if (!testCase.input) {
            const writes = harness.completeChannel.mock.calls[0]?.[6] as
              Array<{ ptr: number; bytes: Uint8Array }>;
            expect(writes, testCase.name).toEqual([
              { ptr: processPointer, bytes: payload },
            ]);
          }
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([4, 8] as const)(
    "maps null zero-length wasm%s scalar socket data to owned empty scratch",
    (pointerWidth) => {
      for (const testCase of [
        ["send", ABI_SYSCALLS.Send],
        ["recv", ABI_SYSCALLS.Recv],
        ["sendto", ABI_SYSCALLS.Sendto],
        ["recvfrom", ABI_SYSCALLS.Recvfrom],
      ] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            expect(
              channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
              testCase[0],
            ).toBe(BigInt(harness.scratchOffset + CH_DATA));
            channelView.setBigInt64(CH_RETURN, 0n, true);
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        writeChannelSyscall(harness, testCase[1], [
          7n,
          0n,
          0n,
          0n,
          0n,
          0n,
        ]);

        dispatchScratchBoundarySyscall(harness);

        expect(harness.handleChannel, testCase[0]).toHaveBeenCalledOnce();
        expect(
          harness.completeChannel.mock.calls[0]?.slice(4, 6),
          testCase[0],
        ).toEqual([0, 0]);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "validates wasm%s zero-capacity scalar byte-count results",
    (pointerWidth) => {
      for (const testCase of [
        ["write", ABI_SYSCALLS.Write, [7n, 0n, 0n]],
        ["pwrite", ABI_SYSCALLS.Pwrite, [7n, 0n, 0n, 0n]],
        ["send", ABI_SYSCALLS.Send, [7n, 0n, 0n, 0n]],
        ["recv", ABI_SYSCALLS.Recv, [7n, 0n, 0n, 0n]],
        ["sendto", ABI_SYSCALLS.Sendto, [7n, 0n, 0n, 0n, 0n, 0n]],
        ["recvfrom", ABI_SYSCALLS.Recvfrom, [7n, 0n, 0n, 0n, 0n, 0n]],
      ] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            channelView.setBigInt64(CH_RETURN, 1n, true);
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        writeChannelSyscall(harness, testCase[1], [...testCase[2]]);

        dispatchScratchBoundarySyscall(harness);

        expect(harness.handleChannel, testCase[0]).toHaveBeenCalledOnce();
        const completion = harness.completeChannel.mock.calls[0]!;
        expect(completion[4], testCase[0]).toBe(-1);
        expect(completion[5], testCase[0]).toBe(EIO);
        expect(completion[6], testCase[0]).toBeUndefined();
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "permits wasm%s zero-capacity MSG_TRUNC receive lengths without copying",
    (pointerWidth) => {
      const completeDatagramLength = 73;
      for (const testCase of [
        ["recv", ABI_SYSCALLS.Recv, [7n, 0n, 0n, BigInt(SOCKET_MSG_TRUNC)]],
        [
          "recvfrom",
          ABI_SYSCALLS.Recvfrom,
          [7n, 0n, 0n, BigInt(SOCKET_MSG_TRUNC), 0n, 0n],
        ],
      ] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            channelView.setBigInt64(
              CH_RETURN,
              BigInt(completeDatagramLength),
              true,
            );
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        writeChannelSyscall(harness, testCase[1], [...testCase[2]]);

        dispatchScratchBoundarySyscall(harness);

        expect(harness.handleChannel, testCase[0]).toHaveBeenCalledOnce();
        const completion = harness.completeChannel.mock.calls[0]!;
        expect(completion[4], testCase[0]).toBe(completeDatagramLength);
        expect(completion[5], testCase[0]).toBe(0);
        expect(completion[6], testCase[0]).toEqual([]);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "rejects invalid positive-length wasm%s scalar socket data ranges before dispatch",
    (pointerWidth) => {
      const length = 16;
      for (const testCase of [
        ["send", ABI_SYSCALLS.Send],
        ["recv", ABI_SYSCALLS.Recv],
        ["sendto", ABI_SYSCALLS.Sendto],
        ["recvfrom", ABI_SYSCALLS.Recvfrom],
      ] as const) {
        for (const pointerKind of [
          "null",
          "one-byte-short",
          "negative",
          "unsafe-high",
        ] as const) {
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          const rawPointer = pointerKind === "null"
            ? 0n
            : pointerKind === "one-byte-short"
              ? BigInt(harness.processBytes.byteLength - length + 1)
              : pointerKind === "negative"
                ? -1n
                : 1n << 60n;
          writeChannelSyscall(harness, testCase[1], [
            7n,
            rawPointer,
            BigInt(length),
            0n,
            0n,
            0n,
          ]);

          dispatchScratchBoundarySyscall(harness);

          expect(harness.handleChannel, testCase[0]).not.toHaveBeenCalled();
          const completedErrnos = [
            ...harness.completeChannel.mock.calls.map((call) => call[5]),
            ...harness.completeChannelRaw.mock.calls.map((call) => call[2]),
          ];
          expect(completedErrnos, testCase[0]).toEqual([EFAULT]);
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([4, 8] as const)(
    "rejects wasm%s generic byte-input over-reports as producer failures",
    (pointerWidth) => {
      const capacity = 31;
      const source = 8192;
      for (const testCase of [
        ["write", ABI_SYSCALLS.Write, [7n, 0n, 0n]],
        ["pwrite", ABI_SYSCALLS.Pwrite, [7n, 0n, 0n, 0n]],
        ["send", ABI_SYSCALLS.Send, [7n, 0n, 0n, 0n]],
        ["sendto", ABI_SYSCALLS.Sendto, [7n, 0n, 0n, 0n, 0n, 0n]],
      ] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.processBytes.fill(0x4d, source, source + capacity);
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            channelView.setBigInt64(CH_RETURN, BigInt(capacity + 1), true);
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        const args = [...testCase[2]];
        args[1] = BigInt(source);
        args[2] = BigInt(capacity);
        writeChannelSyscall(harness, testCase[1], args);

        dispatchScratchBoundarySyscall(harness);

        expect(harness.completeChannel, testCase[0]).toHaveBeenCalledOnce();
        const completion = harness.completeChannel.mock.calls[0]!;
        expect(completion[4], testCase[0]).toBe(-1);
        expect(completion[5], testCase[0]).toBe(EIO);
        expect(completion[6], testCase[0]).toBeUndefined();
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "rejects wasm%s scalar socket receive over-reports without partial data or address publication",
    (pointerWidth) => {
      const capacity = 31;
      const destination = 8192;
      const addressCapacity = 16;
      const address = 12_288;
      const lengthPointer = 16_384;
      for (const testCase of [
        ["recv", ABI_SYSCALLS.Recv, false],
        ["recvfrom", ABI_SYSCALLS.Recvfrom, true],
      ] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        harness.processBytes.fill(
          0x6d,
          destination,
          destination + capacity,
        );
        harness.processBytes.fill(
          0x7e,
          address,
          address + addressCapacity,
        );
        new DataView(harness.processBytes.buffer).setUint32(
          lengthPointer,
          addressCapacity,
          true,
        );
        harness.completeChannel.mockImplementation(
          (
            _channel: TestChannel,
            _syscall: number,
            _origArgs: number[],
            _descs: unknown,
            _retVal: number,
            _errno: number,
            writes: Array<{ ptr: number; bytes: Uint8Array }> = [],
          ) => {
            for (const write of writes) {
              harness.processBytes.set(write.bytes, write.ptr);
            }
          },
        );
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            const stagedData = Number(
              channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
            );
            harness.kernelBytes.fill(
              0x3c,
              stagedData,
              stagedData + capacity,
            );
            if (testCase[2]) {
              const stagedAddress = Number(
                channelView.getBigInt64(
                  CH_ARGS + 4 * CH_ARG_SIZE,
                  true,
                ),
              );
              const stagedLength = Number(
                channelView.getBigInt64(
                  CH_ARGS + 5 * CH_ARG_SIZE,
                  true,
                ),
              );
              harness.kernelBytes.fill(
                0x2a,
                stagedAddress,
                stagedAddress + addressCapacity,
              );
              new DataView(harness.kernelBytes.buffer).setUint32(
                stagedLength,
                addressCapacity,
                true,
              );
            }
            channelView.setBigInt64(CH_RETURN, BigInt(capacity + 1), true);
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        writeChannelSyscall(
          harness,
          testCase[1],
          testCase[2]
            ? [
                7n,
                BigInt(destination),
                BigInt(capacity),
                0n,
                BigInt(address),
                BigInt(lengthPointer),
              ]
            : [7n, BigInt(destination), BigInt(capacity), 0n],
        );

        dispatchScratchBoundarySyscall(harness);

        const completion = harness.completeChannel.mock.calls[0]!;
        expect(completion[4], testCase[0]).toBe(-1);
        expect(completion[5], testCase[0]).toBe(EIO);
        expect(completion[6], testCase[0]).toBeUndefined();
        expect(
          harness.processBytes.slice(
            destination,
            destination + capacity,
          ),
          testCase[0],
        ).toEqual(new Uint8Array(capacity).fill(0x6d));
        expect(
          harness.processBytes.slice(
            address,
            address + addressCapacity,
          ),
          testCase[0],
        ).toEqual(new Uint8Array(addressCapacity).fill(0x7e));
        expect(
          new DataView(harness.processBytes.buffer).getUint32(
            lengthPointer,
            true,
          ),
          testCase[0],
        ).toBe(addressCapacity);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "carries wasm%s setsockopt layout width independently of bounded optlen",
    (pointerWidth) => {
      const optionPointer = 8192;
      const maximum = 264;
      for (const optionLength of [maximum, maximum + 1]) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        const option = Uint8Array.from(
          { length: optionLength },
          (_, index) => (index * 17 + 5) & 0xff,
        );
        harness.processBytes.set(option, optionPointer);
        harness.handleChannel.mockImplementation(
          (offset: number | bigint) => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              Number(offset),
            );
            const stagedPointer = Number(
              channelView.getBigInt64(
                CH_ARGS + 3 * CH_ARG_SIZE,
                true,
              ),
            );
            expect(
              channelView.getBigInt64(
                CH_ARGS + 5 * CH_ARG_SIZE,
                true,
              ),
            ).toBe(BigInt(pointerWidth));
            expect(
              harness.kernelBytes.slice(
                stagedPointer,
                stagedPointer + optionLength,
              ),
            ).toEqual(option);
            channelView.setBigInt64(CH_RETURN, 0n, true);
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          },
        );
        writeChannelSyscall(harness, ABI_SYSCALLS.Setsockopt, [
          7n,
          0n,
          0n,
          BigInt(optionPointer),
          BigInt(optionLength),
          99n,
        ]);

        dispatchScratchBoundarySyscall(harness);

        const accepted = optionLength === maximum;
        expect(harness.handleChannel).toHaveBeenCalledTimes(accepted ? 1 : 0);
        if (!accepted) {
          expect(harness.completeChannelRaw).toHaveBeenCalledWith(
            harness.channel,
            -1,
            EINVAL,
          );
        }
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([
    ["bind", ABI_SYSCALLS.Bind, 1, [7n, 0n, 0n]],
    ["connect", ABI_SYSCALLS.Connect, 1, [7n, 0n, 0n]],
    ["sendto", ABI_SYSCALLS.Sendto, 4, [7n, 0n, 0n, 0n, 0n, 0n]],
  ] as const)(
    "%s accepts a full sockaddr_storage and rejects one byte more",
    (_syscallName, syscallNumber, addressArgIndex, syscallArgs) => {
      for (const pointerWidth of [4, 8]) {
        const addressPointer = 4096;
        for (const addressLength of [
          KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES + 1,
        ]) {
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          harness.processBytes.fill(
            0,
            addressPointer,
            addressPointer + addressLength,
          );
          harness.handleChannel.mockImplementation(() => {
            const channelView = new DataView(
              harness.kernelBytes.buffer,
              harness.scratchOffset,
            );
            const stagedPointer = Number(
              channelView.getBigInt64(
                CH_ARGS + addressArgIndex * CH_ARG_SIZE,
                true,
              ),
            );
            expect(
              harness.kernelBytes.slice(
                stagedPointer,
                stagedPointer + addressLength,
              ),
            ).toEqual(
              harness.processBytes.slice(
                addressPointer,
                addressPointer + addressLength,
              ),
            );
            channelView.setBigInt64(CH_RETURN, 0n, true);
            channelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          });
          const args = [...syscallArgs];
          args[addressArgIndex] = BigInt(addressPointer);
          args[addressArgIndex + 1] = BigInt(addressLength);
          writeChannelSyscall(harness, syscallNumber, args);

          dispatchScratchBoundarySyscall(harness);

          const accepted =
            addressLength === KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES;
          expect(harness.handleChannel).toHaveBeenCalledTimes(accepted ? 1 : 0);
          if (!accepted) {
            expect(harness.completeChannelRaw).toHaveBeenCalledWith(
              harness.channel,
              -1,
              EINVAL,
            );
          }
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([
    ["accept", ABI_SYSCALLS.Accept, 1, [7n, 0n, 0n]],
    ["accept4", ABI_SYSCALLS.Accept4, 1, [7n, 0n, 0n, 0n]],
    ["getsockname", ABI_SYSCALLS.Getsockname, 1, [7n, 0n, 0n]],
    ["getpeername", ABI_SYSCALLS.Getpeername, 1, [7n, 0n, 0n]],
    [
      "getsockopt",
      ABI_SYSCALLS.Getsockopt,
      3,
      [7n, 1n, 2n, 0n, 0n],
    ],
    [
      "recvfrom",
      ABI_SYSCALLS.Recvfrom,
      4,
      [7n, 0n, 0n, 0n, 0n, 0n],
    ],
  ] as const)(
    "%s rejects an active address with no capacity pointer",
    (_name, syscall, addressArgIndex, baseArgs) => {
      for (const pointerWidth of [4, 8] as const) {
        const harness = makeScratchHarness(pointerWidth);
        prepareGenericSyscallHarness(harness, pointerWidth);
        const addressPointer = 4096;
        const args = [...baseArgs];
        args[addressArgIndex] = BigInt(addressPointer);
        writeChannelSyscall(harness, syscall, args);

        dispatchScratchBoundarySyscall(harness);

        expect(harness.handleChannel).not.toHaveBeenCalled();
        expect(harness.completeChannel).toHaveBeenCalledWith(
          harness.channel,
          syscall,
          Array.from(
            { length: 6 },
            (_, index) => Number(args[index] ?? 0n),
          ),
          undefined,
          -1,
          EFAULT,
        );
        expectScratchTailUntouched(harness);
      }
    },
  );

  it.each([4, 8] as const)(
    "rejects invalid active wasm%s scalar socket value-result ranges before dispatch",
    (pointerWidth) => {
      for (const testCase of [
        {
          name: "accept",
          syscall: ABI_SYSCALLS.Accept,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          nullable: true,
          args: [7n, 0n, 0n],
        },
        {
          name: "accept4",
          syscall: ABI_SYSCALLS.Accept4,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          nullable: true,
          args: [7n, 0n, 0n, 0n],
        },
        {
          name: "getsockname",
          syscall: ABI_SYSCALLS.Getsockname,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          nullable: false,
          args: [7n, 0n, 0n],
        },
        {
          name: "getpeername",
          syscall: ABI_SYSCALLS.Getpeername,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          nullable: false,
          args: [7n, 0n, 0n],
        },
        {
          name: "getsockopt",
          syscall: ABI_SYSCALLS.Getsockopt,
          addressArgIndex: 3,
          lengthArgIndex: 4,
          maximum: KERNEL_SCRATCH_SOCKET_OPTION_MAX_BYTES,
          nullable: false,
          args: [7n, 1n, 2n, 0n, 0n],
        },
        {
          name: "recvfrom",
          syscall: ABI_SYSCALLS.Recvfrom,
          addressArgIndex: 4,
          lengthArgIndex: 5,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          nullable: true,
          args: [7n, 0n, 0n, 0n, 0n, 0n],
        },
      ] as const) {
        for (const pointerKind of [
          "null",
          "one-byte-short",
          "negative",
          "unsafe-high",
        ] as const) {
          if (testCase.nullable && pointerKind === "null") continue;
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          const lengthPointer = 4096;
          new DataView(harness.processBytes.buffer).setUint32(
            lengthPointer,
            testCase.maximum,
            true,
          );
          harness.processBytes.fill(
            0x6d,
            harness.processBytes.byteLength - testCase.maximum,
            harness.processBytes.byteLength,
          );
          const invalidAddress = pointerKind === "null"
            ? 0n
            : pointerKind === "one-byte-short"
              ? BigInt(
                  harness.processBytes.byteLength - testCase.maximum + 1,
                )
              : pointerKind === "negative"
                ? -1n
                : 1n << 60n;
          const args = [...testCase.args];
          args[testCase.addressArgIndex] = invalidAddress;
          args[testCase.lengthArgIndex] = BigInt(lengthPointer);
          writeChannelSyscall(harness, testCase.syscall, args);

          dispatchScratchBoundarySyscall(harness);

          expect(
            harness.handleChannel,
            `${testCase.name}/${pointerKind}`,
          ).not.toHaveBeenCalled();
          const completedErrnos = [
            ...harness.completeChannel.mock.calls.map((call) => call[5]),
            ...harness.completeChannelRaw.mock.calls.map((call) => call[2]),
          ];
          expect(
            completedErrnos,
            `${testCase.name}/${pointerKind}`,
          ).toEqual([EFAULT]);
          expect(
            new DataView(harness.processBytes.buffer).getUint32(
              lengthPointer,
              true,
            ),
          ).toBe(testCase.maximum);
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([4, 8] as const)(
    "rejects invalid active wasm%s scalar socket length-result ranges before dispatch",
    (pointerWidth) => {
      for (const testCase of [
        [
          "accept",
          ABI_SYSCALLS.Accept,
          1,
          2,
          [7n, 0n, 0n],
        ],
        [
          "accept4",
          ABI_SYSCALLS.Accept4,
          1,
          2,
          [7n, 0n, 0n, 0n],
        ],
        [
          "getsockname",
          ABI_SYSCALLS.Getsockname,
          1,
          2,
          [7n, 0n, 0n],
        ],
        [
          "getpeername",
          ABI_SYSCALLS.Getpeername,
          1,
          2,
          [7n, 0n, 0n],
        ],
        [
          "getsockopt",
          ABI_SYSCALLS.Getsockopt,
          3,
          4,
          [7n, 1n, 2n, 0n, 0n],
        ],
        [
          "recvfrom",
          ABI_SYSCALLS.Recvfrom,
          4,
          5,
          [7n, 0n, 0n, 0n, 0n, 0n],
        ],
      ] as const) {
        for (const pointerKind of [
          "one-byte-short",
          "negative",
          "unsafe-high",
        ] as const) {
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          const addressPointer = 8192;
          const invalidLengthPointer = pointerKind === "one-byte-short"
            ? BigInt(harness.processBytes.byteLength - 3)
            : pointerKind === "negative"
              ? -1n
              : 1n << 60n;
          const args = [...testCase[4]];
          args[testCase[2]] = BigInt(addressPointer);
          args[testCase[3]] = invalidLengthPointer;
          writeChannelSyscall(harness, testCase[1], args);

          dispatchScratchBoundarySyscall(harness);

          expect(
            harness.handleChannel,
            `${testCase[0]}/${pointerKind}`,
          ).not.toHaveBeenCalled();
          const completedErrnos = [
            ...harness.completeChannel.mock.calls.map((call) => call[5]),
            ...harness.completeChannelRaw.mock.calls.map((call) => call[2]),
          ];
          expect(
            completedErrnos,
            `${testCase[0]}/${pointerKind}`,
          ).toEqual([EFAULT]);
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([
    ["accept", ABI_SYSCALLS.Accept, 1, 2, [7n, 0n, 0n]],
    ["accept4", ABI_SYSCALLS.Accept4, 1, 2, [7n, 0n, 0n, 0n]],
    [
      "recvfrom",
      ABI_SYSCALLS.Recvfrom,
      4,
      5,
      [7n, 0n, 0n, 0n, 0n, 0n],
    ],
  ] as const)(
    "%s ignores the address-length pointer when the address is absent",
    (_name, syscall, addressArgIndex, lengthArgIndex, baseArgs) => {
      for (const pointerWidth of [4, 8] as const) {
        const validLengthPointer = 4096;
        for (
          const pointerKind of [
            "valid",
            "out-of-range",
            "negative",
            "unsafe-high",
          ] as const
        ) {
          const harness = makeScratchHarness(pointerWidth);
          prepareGenericSyscallHarness(harness, pointerWidth);
          const ignoredLengthPointer = pointerKind === "valid"
            ? BigInt(validLengthPointer)
            : pointerKind === "out-of-range"
              ? BigInt(harness.processBytes.byteLength + 4096)
              : pointerKind === "negative"
                ? -1n
                : 1n << 60n;
          const preservedValue = pointerKind === "valid"
            ? 0x6d5a_4321
            : undefined;
          if (preservedValue !== undefined) {
            new DataView(harness.processBytes.buffer).setUint32(
              validLengthPointer,
              preservedValue,
              true,
            );
          }
          harness.handleChannel.mockImplementation(
            (offset: number | bigint) => {
              const channelView = new DataView(
                harness.kernelBytes.buffer,
                Number(offset),
              );
              expect(
                channelView.getBigInt64(
                  CH_ARGS + addressArgIndex * CH_ARG_SIZE,
                  true,
                ),
              ).toBe(0n);
              expect(
                channelView.getBigInt64(
                  CH_ARGS + lengthArgIndex * CH_ARG_SIZE,
                  true,
                ),
              ).toBe(0n);
              channelView.setBigInt64(
                CH_RETURN,
                syscall === ABI_SYSCALLS.Recvfrom ? 0n : 17n,
                true,
              );
              channelView.setUint32(CH_ERRNO, 0, true);
              return 0;
            },
          );
          const args = [...baseArgs];
          args[addressArgIndex] = 0n;
          args[lengthArgIndex] = ignoredLengthPointer;
          writeChannelSyscall(harness, syscall, args);

          dispatchScratchBoundarySyscall(harness);

          expect(harness.handleChannel).toHaveBeenCalledOnce();
          if (preservedValue !== undefined) {
            expect(
              new DataView(harness.processBytes.buffer).getUint32(
                validLengthPointer,
                true,
              ),
            ).toBe(preservedValue);
          }
          expectScratchTailUntouched(harness);
        }
      }
    },
  );

  it.each([4, 8] as const)(
    "bounds every wasm%s scalar socket value-result output at zero, exact capacity, and capacity plus one",
    (pointerWidth) => {
      for (const testCase of [
        {
          name: "accept",
          syscall: ABI_SYSCALLS.Accept,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          args: [7n, 0n, 0n],
          returnValue: 17,
        },
        {
          name: "accept4",
          syscall: ABI_SYSCALLS.Accept4,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          args: [7n, 0n, 0n, 0n],
          returnValue: 17,
        },
        {
          name: "getsockname",
          syscall: ABI_SYSCALLS.Getsockname,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          args: [7n, 0n, 0n],
          returnValue: 0,
        },
        {
          name: "getpeername",
          syscall: ABI_SYSCALLS.Getpeername,
          addressArgIndex: 1,
          lengthArgIndex: 2,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          args: [7n, 0n, 0n],
          returnValue: 0,
        },
        {
          name: "getsockopt",
          syscall: ABI_SYSCALLS.Getsockopt,
          addressArgIndex: 3,
          lengthArgIndex: 4,
          maximum: KERNEL_SCRATCH_SOCKET_OPTION_MAX_BYTES,
          args: [7n, 1n, 2n, 0n, 0n],
          returnValue: 0,
        },
        {
          name: "recvfrom",
          syscall: ABI_SYSCALLS.Recvfrom,
          addressArgIndex: 4,
          lengthArgIndex: 5,
          maximum: KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES,
          args: [7n, 0n, 0n, 0n, 0n, 0n],
          returnValue: 0,
        },
      ] as const) {
        for (const callerCapacity of [
          0,
          testCase.maximum,
          testCase.maximum + 1,
        ]) {
          for (const reportedLength of [
            testCase.maximum,
            testCase.maximum + 1,
          ]) {
            const harness = makeScratchHarness(pointerWidth);
            prepareGenericSyscallHarness(harness, pointerWidth);
            const stagedCapacity = Math.min(
              callerCapacity,
              testCase.maximum,
            );
            const addressPointer =
              harness.processBytes.byteLength - stagedCapacity;
            const lengthPointer = 4096;
            const callerCanary = 0x6d;
            const expected = Uint8Array.from(
              { length: stagedCapacity },
              (_, index) => (index * 29 + 3) % 251,
            );
            harness.processBytes.fill(
              callerCanary,
              addressPointer,
              harness.processBytes.byteLength,
            );
            new DataView(harness.processBytes.buffer).setUint32(
              lengthPointer,
              callerCapacity,
              true,
            );
            harness.completeChannel.mockImplementation(
              (
                _channel: TestChannel,
                _syscallNr: number,
                _origArgs: number[],
                _argDescs: unknown,
                _retVal: number,
                _errVal: number,
                writes: Array<{ ptr: number; bytes: Uint8Array }> = [],
              ) => {
                for (const write of writes) {
                  harness.processBytes.set(write.bytes, write.ptr);
                }
              },
            );
            harness.handleChannel.mockImplementation(
              (offset: number | bigint) => {
                const channelView = new DataView(
                  harness.kernelBytes.buffer,
                  Number(offset),
                );
                const stagedAddressPointer = Number(
                  channelView.getBigInt64(
                    CH_ARGS + testCase.addressArgIndex * CH_ARG_SIZE,
                    true,
                  ),
                );
                const stagedLengthPointer = Number(
                  channelView.getBigInt64(
                    CH_ARGS + testCase.lengthArgIndex * CH_ARG_SIZE,
                    true,
                  ),
                );
                const kernelView = new DataView(harness.kernelBytes.buffer);
                expect(
                  kernelView.getUint32(stagedLengthPointer, true),
                  testCase.name,
                ).toBe(stagedCapacity);
                if (stagedCapacity > 0) {
                  harness.kernelBytes.set(expected, stagedAddressPointer);
                }
                kernelView.setUint32(
                  stagedLengthPointer,
                  reportedLength,
                  true,
                );
                channelView.setBigInt64(
                  CH_RETURN,
                  BigInt(testCase.returnValue),
                  true,
                );
                channelView.setUint32(CH_ERRNO, 0, true);
                return 0;
              },
            );
            const args = [...testCase.args];
            args[testCase.addressArgIndex] = BigInt(addressPointer);
            args[testCase.lengthArgIndex] = BigInt(lengthPointer);
            writeChannelSyscall(harness, testCase.syscall, args);

            dispatchScratchBoundarySyscall(harness);

            expect(
              harness.completeChannel,
              testCase.name,
            ).toHaveBeenCalledOnce();
            if (reportedLength === testCase.maximum) {
              expect(
                harness.processBytes.slice(
                  addressPointer,
                  harness.processBytes.byteLength,
                ),
                testCase.name,
              ).toEqual(expected);
              expect(
                new DataView(harness.processBytes.buffer).getUint32(
                  lengthPointer,
                  true,
                ),
                testCase.name,
              ).toBe(reportedLength);
            } else {
              const completion = harness.completeChannel.mock.calls[0]!;
              expect(completion[4], testCase.name).toBe(-1);
              expect(completion[5], testCase.name).toBe(EIO);
              expect(completion[6], testCase.name).toBeUndefined();
              expect(
                harness.processBytes.slice(
                  addressPointer,
                  harness.processBytes.byteLength,
                ),
                testCase.name,
              ).toEqual(
                new Uint8Array(stagedCapacity).fill(callerCanary),
              );
              expect(
                new DataView(harness.processBytes.buffer).getUint32(
                  lengthPointer,
                  true,
                ),
                testCase.name,
              ).toBe(callerCapacity);
            }
            expectScratchTailUntouched(harness);
          }
        }
      }
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
          this.buffer === harness.channel.memory.buffer &&
          byteOffset === lengthPointer &&
          capturedReads++ === 0
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
      expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();
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
          this.buffer === harness.channel.memory.buffer &&
          byteOffset === lengthPointer &&
          sizingReads++ === 0
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
      dispatchScratchBoundarySyscall(harness);
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
    ).toEqual(new Uint8Array(stagedCapacity - plannedCapacity).fill(0xa5));
    expectScratchTailUntouched(harness);
  });

  it("checks ppoll scalar-conversion sources before scratch mutation", () => {
    for (const [ptrWidth, invalidSource] of [
      [4, "timespec"],
      [4, "mask"],
      [8, "unsafe"],
    ] as const) {
      const harness = makeScratchHarness(ptrWidth);
      prepareGenericSyscallHarness(harness, ptrWidth);
      const processEnd = BigInt(harness.processBytes.byteLength);
      const timespecPointer =
        invalidSource === "timespec"
          ? processEnd - 8n
          : invalidSource === "unsafe"
            ? BigInt(Number.MAX_SAFE_INTEGER) + 1n
            : 0n;
      const maskPointer = invalidSource === "mask" ? processEnd - 4n : 0n;
      const request = new DataView(
        harness.channel.memory.buffer,
        harness.channel.channelOffset,
        CH_TOTAL_SIZE,
      );
      request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Ppoll, true);
      request.setBigInt64(CH_ARGS, 0n, true);
      request.setBigInt64(CH_ARGS + CH_ARG_SIZE, 0n, true);
      request.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, timespecPointer, true);
      request.setBigInt64(CH_ARGS + 3 * CH_ARG_SIZE, maskPointer, true);
      request.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, 8n, true);

      expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

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
    prepareGenericSyscallHarness(harness, 4);

    const observed: Uint8Array[] = [];
    harness.kernelExports.kernel_set_current_tid = () => {
      // Model a synchronous nested host operation that reused main scratch
      // after descriptor planning but before this syscall's dispatch.
      harness.scratchRegion.withLease((lease: any) => {
        lease.fill(0xcc, CH_DATA, input.byteLength);
      });
      harness.processBytes.fill(
        0xee,
        inputPointer,
        inputPointer + input.byteLength,
      );
      return 0;
    };
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        Number(offset),
      );
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

    const request = new DataView(
      harness.channel.memory.buffer,
      harness.channel.channelOffset,
      CH_TOTAL_SIZE,
    );
    request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Write, true);
    request.setBigInt64(CH_ARGS, 7n, true);
    request.setBigInt64(CH_ARGS + CH_ARG_SIZE, BigInt(inputPointer), true);
    request.setBigInt64(
      CH_ARGS + 2 * CH_ARG_SIZE,
      BigInt(input.byteLength),
      true,
    );

    expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

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

    prepareGenericSyscallHarness(harness, 4);
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        Number(offset),
      );
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

    const request = new DataView(
      harness.channel.memory.buffer,
      harness.channel.channelOffset,
      CH_TOTAL_SIZE,
    );
    request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getaddrinfo, true);
    request.setBigInt64(CH_ARGS, BigInt(namePointer), true);
    request.setBigInt64(CH_ARGS + CH_ARG_SIZE, BigInt(resultPointer), true);

    expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

    expect(
      harness.processBytes.slice(resultPointer, resultPointer + result.length),
    ).toEqual(result);
    expect(
      harness.processBytes.slice(
        resultPointer + result.length,
        resultPointer + result.length + canary.length,
      ),
    ).toEqual(canary);
    const detachedWrites = harness.completeChannel.mock.calls[0]?.[6] as Array<{
      ptr: number;
      bytes: Uint8Array;
    }>;
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
      const invalidPointer = harness.processBytes.byteLength - size + 1;
      const args = [...originalArgs];
      args[argIndex] = BigInt(invalidPointer);
      writeChannelSyscall(harness, syscallNr, args);

      expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        syscallNr,
        Array.from({ length: 6 }, (_, index) => Number(args[index] ?? 0n)),
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
      harness.processBytes.set(new TextEncoder().encode("valid\0"), 4096);
      writeChannelSyscall(harness, syscallNr, [...args]);

      expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        syscallNr,
        Array.from({ length: 6 }, (_, index) => Number(args[index] ?? 0n)),
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
      prepareGenericSyscallHarness(harness, pointerWidth);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
        const scratchPointer = Number(channelView.getBigInt64(CH_ARGS, true));
        expect(
          Number(channelView.getBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, true)),
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

      const request = new DataView(
        harness.channel.memory.buffer,
        harness.channel.channelOffset,
        CH_TOTAL_SIZE,
      );
      request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Sysinfo, true);
      request.setBigInt64(CH_ARGS, BigInt(outputPointer), true);

      expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      const writes = harness.completeChannel.mock.calls[0]?.[6] as
        Array<{ ptr: number; bytes: Uint8Array }> | undefined;
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
      prepareGenericSyscallHarness(harness, pointerWidth);
      const invalidPointer = harness.processBytes.byteLength - nativeSize + 1;
      const request = new DataView(
        harness.channel.memory.buffer,
        harness.channel.channelOffset,
        CH_TOTAL_SIZE,
      );
      request.setUint32(CH_SYSCALL, ABI_SYSCALLS.Sysinfo, true);
      request.setBigInt64(CH_ARGS, BigInt(invalidPointer), true);

      expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

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

      expect(() => dispatchScratchBoundarySyscall(harness)).not.toThrow();

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
    // SIOCGIFNAME/SIOCGIFHWADDR/SIOCGIFADDR/SIOCGIFINDEX are plain
    // fixed-size `struct ifreq` requests and, since Workstream H4, are no
    // longer host-intercepted at all: they flow through the same generic
    // ioctl-contract marshal path as every other pointer-valued ioctl (see
    // "rejects a null pointer for a pointer-valued ioctl" below), so a null
    // pointer is rejected by `completeChannel` before `kernel_handle_channel`
    // is ever reached, not by a bespoke `completeChannelRaw` call.
    "rejects null wasm%s outer ifreq objects for every network handler",
    (pointerWidth) => {
      const ifreqSize = pointerWidth === 8 ? 40 : 32;
      for (const entry of NETWORK_IFREQ_HANDLERS) {
        const harness = makeScratchHarness(pointerWidth);
        harness.processBytes.fill(0x6d, 0, ifreqSize + 16);
        entry.prepare(harness.processBytes, 0);
        const before = harness.processBytes.slice(0, ifreqSize + 16);

        invokeNetworkIoctlHandler(harness, entry.handler, 0);

        expect(harness.handleChannel, `ioctl 0x${entry.request.toString(16)}`)
          .not.toHaveBeenCalled();
        expect(
          harness.completeChannel,
          `ioctl 0x${entry.request.toString(16)}`,
        ).toHaveBeenCalledWith(
          harness.channel,
          ABI_SYSCALLS.Ioctl,
          [7, entry.request, 0, 0, 0, 0],
          undefined,
          -1,
          EFAULT,
        );
        expect(harness.processBytes.slice(0, ifreqSize + 16)).toEqual(before);
        expectScratchTailUntouched(harness);
      }
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

        exact.handleChannel.mockImplementation((offset: number | bigint) => {
          const channelView = new DataView(
            exact.kernelBytes.buffer,
            Number(offset),
          );
          channelView.setBigInt64(CH_RETURN, 0n, true);
          channelView.setUint32(CH_ERRNO, 0, true);
          return 0;
        });

        invokeNetworkIoctlHandler(exact, entry.handler, exactPointer);

        expect(exact.handleChannel, `ioctl 0x${entry.request.toString(16)}`)
          .toHaveBeenCalledOnce();
        expect(
          exact.completeChannel.mock.calls[0]?.slice(4, 6),
          `ioctl 0x${entry.request.toString(16)}`,
        ).toEqual([0, 0]);
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

        expect(short.handleChannel, `ioctl 0x${entry.request.toString(16)}`)
          .not.toHaveBeenCalled();
        expect(
          short.completeChannel,
          `ioctl 0x${entry.request.toString(16)}`,
        ).toHaveBeenCalledWith(
          short.channel,
          ABI_SYSCALLS.Ioctl,
          [7, entry.request, shortPointer, 0, 0, 0],
          undefined,
          -1,
          EFAULT,
        );
        expect(short.processBytes.slice(shortPointer - 16)).toEqual(
          shortBefore,
        );
        expectScratchTailUntouched(short);
      }
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
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        Number(offset),
      );
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
    writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [
      7n,
      0x541bn,
      BigInt(outputPointer),
    ]);

    dispatchScratchBoundarySyscall(harness);

    expect(
      harness.processBytes.slice(outputPointer, outputPointer + result.length),
    ).toEqual(result);
    expect(
      harness.processBytes.slice(
        outputPointer + result.length,
        outputPointer + result.length + canary.length,
      ),
    ).toEqual(canary);
    const writes = harness.completeChannel.mock.calls[0]?.[6] as Array<{
      ptr: number;
      bytes: Uint8Array;
    }>;
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
      harness.processBytes.fill(0x4b, processPointer, processPointer + size);
      harness.handleChannel.mockImplementation((offset: number | bigint) => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
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

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0, 0,
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

    dispatchScratchBoundarySyscall(harness);

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
    writeChannelSyscall(harness, ABI_SYSCALLS.Ioctl, [7n, 0x541bn, 0n]);

    dispatchScratchBoundarySyscall(harness);

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
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          Number(offset),
        );
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

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).toHaveBeenCalledOnce();
      expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
        0, 0,
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
          const channelView = new DataView(
            harness.kernelBytes.buffer,
            Number(offset),
          );
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

        dispatchScratchBoundarySyscall(harness);

        expect(harness.handleChannel).toHaveBeenCalledOnce();
        expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
          0, 0,
        ]);
        expectScratchTailUntouched(harness);
      }
    },
  );

  it("stages no pointer for an unknown ioctl request", () => {
    const harness = makeScratchHarness(8);
    prepareGenericSyscallHarness(harness, 8);
    harness.handleChannel.mockImplementation((offset: number | bigint) => {
      const channelView = new DataView(
        harness.kernelBytes.buffer,
        Number(offset),
      );
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

    dispatchScratchBoundarySyscall(harness);

    expect(harness.handleChannel).toHaveBeenCalledOnce();
    expect(harness.completeChannel.mock.calls[0]?.slice(4, 6)).toEqual([
      -1, 25,
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

      dispatchScratchBoundarySyscall(harness);

      expect(harness.handleChannel).not.toHaveBeenCalled();
      expect(harness.completeChannel).toHaveBeenCalledWith(
        harness.channel,
        ABI_SYSCALLS.Ioctl,
        [7, Number(BigInt.asIntN(32, BigInt(request))), 4096, 0, 0, 0],
        undefined,
        -1,
        EOVERFLOW,
      );
      expectScratchTailUntouched(harness);
    },
  );
});
