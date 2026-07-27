import { afterEach, describe, expect, it, vi } from "vitest";

import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  KERNEL_CMSGHDR_WIRE_DATA_OFFSET,
  KERNEL_CMSGHDR_WIRE_ALIGN,
  KERNEL_CMSGHDR_WIRE_LEN_OFFSET,
  KERNEL_CMSGHDR_WIRE_LEVEL_OFFSET,
  KERNEL_CMSGHDR_WIRE_TYPE_OFFSET,
  POSIX_IOV_MAX,
  PROCESS_CMSGHDR_WASM64_DATA_OFFSET,
  PROCESS_CMSGHDR_WASM64_LEN_OFFSET,
  PROCESS_CMSGHDR_WASM64_SIZE,
  PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET,
  PROCESS_MSGHDR_WASM32_CONTROL_OFFSET,
  PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET,
  PROCESS_MSGHDR_WASM32_IOV_OFFSET,
  PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET,
  PROCESS_MSGHDR_WASM32_NAME_OFFSET,
  PROCESS_MSGHDR_WASM32_SIZE,
  PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET,
  PROCESS_MSGHDR_WASM64_CONTROL_OFFSET,
  PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET,
  PROCESS_MSGHDR_WASM64_IOV_OFFSET,
  PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET,
  PROCESS_MSGHDR_WASM64_NAME_OFFSET,
  PROCESS_MSGHDR_WASM64_SIZE,
  PROCESS_STATE_EXITED,
  SOCKET_SCM_RIGHTS,
  SOCKET_SOL_SOCKET,
  STRUCT_SIZE_KERNEL_IOVEC_WIRE,
  STRUCT_SIZE_KERNEL_MSGHDR_WIRE,
} from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const EAGAIN = 11;
const ENOMEM = 12;
const EFAULT = 14;
const EINVAL = 22;
const EIO = 5;
const LARGE_LENGTH = CH_DATA_SIZE + 1;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface TestChannel {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

interface TransferHarness {
  worker: Record<string, any>;
  channel: TestChannel;
  processBytes: Uint8Array;
  kernelBytes: Uint8Array;
  kernelExports: Record<string, unknown>;
  transferOffset: number;
  begin: ReturnType<typeof vi.fn>;
  pointer: ReturnType<typeof vi.fn>;
  capacity: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  channelExecute: ReturnType<typeof vi.fn>;
  onKernelFatal: ReturnType<typeof vi.fn>;
  gate: KernelEntryGate;
  scratchRegion: ReturnType<typeof allocateKernelScratchRegion>;
}

function sharedMemory(pages = 4): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  });
}

function kernelPointer(
  pointerWidth: 4 | 8,
  value: number,
): number | bigint {
  return pointerWidth === 8 ? BigInt(value) : value;
}

function makeChannel(pid: number): TestChannel {
  const memory = sharedMemory();
  return {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer),
    consecutiveSyscalls: 0,
    handling: true,
  };
}

function makeTransferHarness(
  pointerWidth: 4 | 8,
  scratchCapacity = CH_TOTAL_SIZE,
): TransferHarness {
  const scratchOffset = 4096;
  const transferOffset = 2 * 65_536;
  const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
  const kernelBytes = new Uint8Array(kernelMemory.buffer);
  const channel = makeChannel(41);
  const processBytes = new Uint8Array(channel.memory.buffer);
  let worker!: Record<string, any>;
  let kernelExports!: Record<string, unknown>;

  let nextToken = 101n;
  let reservedCapacity = 0;
  const begin = vi.fn((minimumCapacity: number | bigint) => {
    reservedCapacity = Number(minimumCapacity);
    return nextToken++;
  });
  const pointer = vi.fn(() =>
    kernelPointer(pointerWidth, transferOffset)
  );
  const capacity = vi.fn(() =>
    kernelPointer(pointerWidth, reservedCapacity)
  );
  const cancel = vi.fn(() => 0);
  const execute = vi.fn((
    _pid: number,
    _tid: number,
    _token: bigint,
    length: number | bigint,
  ) => Number(length));
  const channelExecute = vi.fn(() => {
    const view = new DataView(kernelMemory.buffer, transferOffset);
    const messagePointer = Number(
      view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
    );
    const iovecPointer = new DataView(kernelMemory.buffer).getUint32(
      messagePointer + 8,
      true,
    );
    const length = new DataView(kernelMemory.buffer).getUint32(
      iovecPointer + 4,
      true,
    );
    view.setBigInt64(CH_RETURN, BigInt(length), true);
    view.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  const onKernelFatal = vi.fn();

  const gate = new KernelEntryGate();
  const rawScratchInstance = createKernelScratchTestInstance(
    pointerWidth,
    kernelMemory,
    () => kernelExports,
    () => kernelPointer(pointerWidth, scratchOffset),
  );
  const scratchInstance = createKernelEntryGatedInstance(
    rawScratchInstance,
    gate,
  );
  const scratchRegion = allocateKernelScratchRegion(
    kernelMemory,
    scratchInstance.exports.kernel_alloc_scratch as
      (size: number) => number | bigint,
    scratchCapacity,
    pointerWidth,
    "large transfer protocol test channel scratch",
    scratchInstance,
  );
  kernelExports = {
    kernel_blocking_retry_release: vi.fn(() => 0),
    kernel_blocking_retry_token: vi.fn(() => 701n),
    kernel_handle_channel: () => 0,
    kernel_dequeue_signal: () => 0,
    kernel_drain_wakeup_events: () => 0,
    kernel_get_process_exit_signal: () => 0,
    kernel_get_process_state: () => 0,
    // Large-transfer EAGAIN follows the same blocking retry contract as the
    // ordinary channel path. Model a blocking descriptor unless a focused
    // case replaces this export.
    kernel_is_fd_nonblock: () => 0,
    kernel_get_socket_timeout_ms: () => -1n,
    kernel_set_current_tid: () => 0,
    kernel_transfer_scratch_begin: begin,
    kernel_transfer_scratch_pointer: pointer,
    kernel_transfer_scratch_capacity: capacity,
    kernel_transfer_scratch_cancel: cancel,
    kernel_transfer_channel_execute: channelExecute,
    kernel_transfer_io_execute: execute,
  };

  worker = createCentralizedKernelWorkerTestDouble({
    callbacks: { onKernelFatal },
  }) as unknown as Record<string, any>;
  // WHY: the real worker owns all entry, scratch, and fatal state. Tests may
  // replace ordinary host registries, but they must not recreate private Wasm
  // authority as mutable structural fields.
  Object.assign(worker, {
    currentHandlePid: 0,
    activeChannels: [channel],
    syscallRing: new Map(),
    syscallTraceEnabled: false,
    syscallTraceRing: [],
    syscallTraceCap: 64,
    channelTids: new Map(),
    processes: new Map([[channel.pid, {
      pid: channel.pid,
      memory: channel.memory,
      channels: [channel],
      ptrWidth: pointerWidth,
      explicitMaxAddr: true,
    }]]),
    hostReaped: new Set(),
    sharedMmapBackings: new Map(),
    relistenBatchSize: 64,
    relistenCount: 0,
    // Avoid installing a waitAsync listener in these synchronous protocol
    // tests. Completion still publishes the genuine process mailbox.
    usePolling: true,
    pendingPollRetries: new Map(),
    pendingSelectRetries: new Map(),
    ptyOutputCallbacks: new Map(),
  });
  worker.testAuthority.initializeKernelForTest({
    instance: scratchInstance,
    gate,
    mainScratch: scratchRegion,
    tcpScratch: scratchRegion,
  });

  return {
    worker,
    channel,
    processBytes,
    kernelBytes,
    kernelExports,
    transferOffset,
    begin,
    pointer,
    capacity,
    cancel,
    execute,
    channelExecute,
    onKernelFatal,
    gate,
    scratchRegion,
  };
}

function writeSyscall(
  channel: TestChannel,
  syscall: number,
  args: readonly bigint[],
  status: number = CHANNEL_STATUS_PENDING,
): void {
  const view = new DataView(channel.memory.buffer, channel.channelOffset);
  view.setInt32(CH_STATUS, status, true);
  view.setUint32(CH_SYSCALL, syscall, true);
  for (let index = 0; index < 6; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      args[index] ?? 0n,
      true,
    );
  }
}

function invokeLargeWrite(
  harness: TransferHarness,
  length = LARGE_LENGTH,
  channel = harness.channel,
  source = 1024,
): void {
  const sourceBytes = new Uint8Array(channel.memory.buffer);
  sourceBytes.fill(0x6b, source, source + length);
  writeSyscall(
    channel,
    ABI_SYSCALLS.Write,
    [7n, BigInt(source), BigInt(length)],
  );
  harness.worker.handleSyscall(channel);
}

function readChannelCompletion(channel: TestChannel): {
  readonly status: number;
  readonly retVal: number;
  readonly errno: number;
} {
  const view = new DataView(channel.memory.buffer, channel.channelOffset);
  return {
    status: view.getUint32(CH_STATUS, true),
    retVal: Number(view.getBigInt64(CH_RETURN, true)),
    errno: view.getUint32(CH_ERRNO, true),
  };
}

function writeIovec(
  memory: WebAssembly.Memory,
  pointerWidth: 4 | 8,
  tablePointer: number,
  index: number,
  base: number,
  length: number,
): void {
  const view = new DataView(memory.buffer);
  const offset = tablePointer + index * 2 * pointerWidth;
  if (pointerWidth === 8) {
    view.setBigUint64(offset, BigInt(base), true);
    view.setBigUint64(offset + 8, BigInt(length), true);
  } else {
    view.setUint32(offset, base, true);
    view.setUint32(offset + 4, length, true);
  }
}

function writeLargeSendmsg(
  pointerWidth: 4 | 8,
  channel: TestChannel,
  payloadByte = 0x6b,
): number {
  const messagePointer = 256;
  const iovecPointer = 512;
  const sourcePointer = 1024;
  const length = CH_DATA_SIZE
    - STRUCT_SIZE_KERNEL_MSGHDR_WIRE
    - STRUCT_SIZE_KERNEL_IOVEC_WIRE
    + 1;
  const bytes = new Uint8Array(channel.memory.buffer);
  bytes.fill(payloadByte, sourcePointer, sourcePointer + length);
  writeIovec(
    channel.memory,
    pointerWidth,
    iovecPointer,
    0,
    sourcePointer,
    length,
  );
  const view = new DataView(channel.memory.buffer);
  if (pointerWidth === 8) {
    view.setBigUint64(
      messagePointer + PROCESS_MSGHDR_WASM64_IOV_OFFSET,
      BigInt(iovecPointer),
      true,
    );
    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET,
      1,
      true,
    );
  } else {
    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM32_IOV_OFFSET,
      iovecPointer,
      true,
    );
    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET,
      1,
      true,
    );
  }
  writeSyscall(
    channel,
    ABI_SYSCALLS.Sendmsg,
    [7n, BigInt(messagePointer), 0n],
  );
  return length;
}

function invokeLargeSendmsg(
  harness: TransferHarness,
  pointerWidth: 4 | 8,
  channel = harness.channel,
  payloadByte = 0x6b,
): number {
  const length = writeLargeSendmsg(pointerWidth, channel, payloadByte);
  harness.worker.handleSyscall(channel);
  return length;
}

function addChannel(
  harness: TransferHarness,
  channel: TestChannel,
  pointerWidth: 4 | 8,
): void {
  harness.worker.processes.set(channel.pid, {
    pid: channel.pid,
    memory: channel.memory,
    channels: [channel],
    ptrWidth: pointerWidth,
  });
  harness.worker.activeChannels.push(channel);
}

describe("kernel-owned large transfer reservation protocol", () => {
  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s accepts the exact owned capacity and rejects capacity + 1",
    (_name, pointerWidth) => {
      const ownedCapacity = LARGE_LENGTH;
      const exact = makeTransferHarness(pointerWidth);
      exact.kernelExports.kernel_transfer_scratch_capacity = () =>
        kernelPointer(pointerWidth, ownedCapacity);

      invokeLargeWrite(exact, ownedCapacity);

      expect(exact.begin).toHaveBeenCalledWith(
        kernelPointer(pointerWidth, ownedCapacity),
      );
      expect(exact.execute).toHaveBeenCalledOnce();
      expect(exact.cancel).toHaveBeenCalledOnce();
      expect(readChannelCompletion(exact.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: ownedCapacity,
        errno: 0,
      });

      const over = makeTransferHarness(pointerWidth);
      over.kernelExports.kernel_transfer_scratch_capacity = () =>
        kernelPointer(pointerWidth, ownedCapacity);

      invokeLargeWrite(over, ownedCapacity + 1);

      expect(over.begin).toHaveBeenCalledWith(
        kernelPointer(pointerWidth, ownedCapacity + 1),
      );
      expect(over.execute).not.toHaveBeenCalled();
      expect(over.cancel).toHaveBeenCalledOnce();
      expect(readChannelCompletion(over.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: EIO,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s completes a real FUTEX_WAKE channel while draining kernel wake events through its scope",
    (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const futexAddress = 4096;
      const wakeDrain = vi.fn((
        pointer: number | bigint,
        capacity: number,
      ) => {
        expect(capacity).toBeGreaterThanOrEqual(5);
        const offset = Number(pointer);
        const view = new DataView(harness.kernelBytes.buffer);
        view.setUint32(offset, 77, true);
        harness.kernelBytes[offset + 4] = 1;
        return 1;
      });
      harness.kernelExports.kernel_drain_wakeup_events = wakeDrain;
      writeSyscall(
        harness.channel,
        ABI_SYSCALLS.Futex,
        [
          BigInt(futexAddress),
          1n, // FUTEX_WAKE
          1n,
          0n,
          0n,
          0n,
        ],
      );

      harness.worker.handleSyscall(harness.channel);

      const channelView = new DataView(harness.channel.memory.buffer);
      expect(channelView.getUint32(CH_STATUS, true))
        .toBe(CHANNEL_STATUS_COMPLETE);
      expect(channelView.getBigInt64(CH_RETURN, true)).toBe(0n);
      expect(channelView.getUint32(CH_ERRNO, true)).toBe(0);
      expect(wakeDrain).toHaveBeenCalledOnce();
      expect(harness.onKernelFatal).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wasm32 immediate", 4, false],
    ["wasm32 deferred", 4, true],
    ["wasm64 immediate", 8, false],
    ["wasm64 deferred", 8, true],
  ] as const)(
    "%s snapshots PTY output before channel publication and queues callback reentry behind it",
    async (_name, pointerWidth, deferChannel) => {
      const harness = makeTransferHarness(pointerWidth);
      const order: string[] = [];
      harness.worker.activePtyIndices.add(7);
      harness.kernelExports.kernel_drain_wakeup_events = vi.fn(() => 0);
      harness.kernelExports.kernel_inject_mouse_event = vi.fn(() => {
        order.push("mouse");
      });
      let readCount = 0;
      harness.kernelExports.kernel_pty_master_read = vi.fn((
        _pty: number,
        pointer: number | bigint,
      ) => {
        order.push("read");
        if (readCount++ !== 0) return 0;
        harness.kernelBytes[Number(pointer)] = 0x5a;
        return 1;
      });
      harness.worker.ptyOutputCallbacks.set(7, (data: Uint8Array) => {
        order.push("callback");
        expect(Array.from(data)).toEqual([0x5a]);
        expect(new DataView(harness.channel.memory.buffer).getUint32(
          CH_STATUS,
          true,
        )).toBe(CHANNEL_STATUS_PENDING);
        harness.worker.injectMouseEvent(1, 2, 3);
      });
      writeSyscall(harness.channel, ABI_SYSCALLS.Getpid, []);

      if (deferChannel) {
        harness.gate.invokeKernelExport("outer", () => {
          harness.worker.handleSyscall(harness.channel);
        });
        expect(order).toEqual([]);
        expect(new DataView(harness.channel.memory.buffer).getUint32(
          CH_STATUS,
          true,
        )).toBe(CHANNEL_STATUS_PENDING);
        await Promise.resolve();
      } else {
        harness.worker.handleSyscall(harness.channel);
      }

      expect(order.slice(0, 3)).toEqual([
        "read",
        "read",
        "callback",
      ]);
      expect(new DataView(harness.channel.memory.buffer).getUint32(
        CH_STATUS,
        true,
      )).toBe(CHANNEL_STATUS_COMPLETE);
      if (!deferChannel) {
        expect(order).not.toContain("mouse");
        await Promise.resolve();
      }
      expect(order).toEqual([
        "read",
        "read",
        "callback",
        "mouse",
      ]);
      expect(harness.onKernelFatal).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s drains all deferred PTY chunks before followers without lending callback authority",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth, 16);
      const order: string[] = [];
      const writtenBytes: number[][] = [];
      let readCount = 0;
      harness.kernelExports.kernel_inject_mouse_event = vi.fn(() => {
        order.push("mouse");
      });
      harness.worker.ptyOutputCallbacks.set(7, () => {
        order.push("callback");
        harness.worker.injectMouseEvent(1, 2, 3);
      });
      harness.kernelExports.kernel_pty_master_write = vi.fn((
        _pty: number,
        pointer: number | bigint,
        length: number,
      ) => {
        order.push(`write:${length}`);
        writtenBytes.push(Array.from(
          harness.kernelBytes.slice(
            Number(pointer),
            Number(pointer) + length,
          ),
        ));
        return length;
      });
      harness.kernelExports.kernel_pty_master_read = vi.fn((
        _pty: number,
        pointer: number | bigint,
        _length: number,
      ) => {
        order.push("read");
        if (readCount++ !== 0) return 0;
        harness.kernelBytes[Number(pointer)] = 0x7a;
        return 1;
      });
      const input = Uint8Array.from({ length: 17 }, (_, index) => index + 1);

      harness.gate.invokeKernelExport("outer", () => {
        harness.worker.ptyMasterWrite(7, input);
        harness.gate.runOrDeferVoidIngress(
          "follower",
          () => {
            order.push("follower");
          },
        );
        input.fill(0xff);
      });
      await Promise.resolve();

      expect(writtenBytes).toEqual([
        Array.from({ length: 16 }, (_, index) => index + 1),
        [17],
      ]);
      expect(order).toEqual([
        "write:16",
        "write:1",
        "read",
        "callback",
        "follower",
        "mouse",
        "read",
      ]);
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s preserves FIFO order and owned bytes for PTY, UDP, and mouse events",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const order: string[] = [];
      const ptyBytes: number[][] = [];
      const udpBytes: number[][] = [];
      harness.kernelExports.kernel_inject_mouse_event = vi.fn(() => {
        order.push("mouse");
      });
      harness.kernelExports.kernel_pty_master_write = vi.fn((
        _pty: number,
        pointer: number | bigint,
        length: number,
      ) => {
        order.push("pty");
        ptyBytes.push(Array.from(
          harness.kernelBytes.slice(
            Number(pointer),
            Number(pointer) + length,
          ),
        ));
        return length;
      });
      harness.kernelExports.kernel_inject_datagram = vi.fn((
        ...args: Array<number | bigint>
      ) => {
        const pointer = Number(args[11]);
        const length = Number(args[12]);
        order.push("udp");
        udpBytes.push(Array.from(
          harness.kernelBytes.slice(pointer, pointer + length),
        ));
        return 0;
      });
      const ptyInput = new Uint8Array([1, 2, 3]);
      const udpInput = new Uint8Array([4, 5, 6]);

      harness.gate.invokeKernelExport("kernel_handle_channel", () => {
        harness.worker.ptyMasterWrite(7, ptyInput);
        expect(harness.worker.injectUdpDatagram(harness.channel.pid, {
          srcAddr: new Uint8Array([10, 0, 0, 1]),
          srcPort: 1000,
          dstAddr: new Uint8Array([10, 0, 0, 2]),
          dstPort: 2000,
          data: udpInput,
        })).toBe(0);
        harness.worker.injectMouseEvent(1, 2, 3);
        ptyInput.fill(9);
        udpInput.fill(9);
        expect(order).toEqual([]);
      });

      await Promise.resolve();
      expect(order).toEqual(["pty", "udp", "mouse"]);
      expect(ptyBytes).toEqual([[1, 2, 3]]);
      expect(udpBytes).toEqual([[4, 5, 6]]);
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s gates retry queries during an ordinary kernel_handle_channel call",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const nestedChannel = makeChannel(42);
      addChannel(harness, nestedChannel, pointerWidth);
      new Uint8Array(nestedChannel.memory.buffer)[1024] = 0x61;
      writeSyscall(
        nestedChannel,
        ABI_SYSCALLS.Write,
        [7n, 1024n, 1n],
      );
      const getProcessExitSignal = vi.fn(() => 0);
      harness.kernelExports.kernel_get_process_exit_signal =
        getProcessExitSignal;
      let handleCount = 0;
      const handleChannel = vi.fn((pointer: number | bigint) => {
        handleCount++;
        if (handleCount === 1) {
          harness.worker.retrySyscall(nestedChannel);
          harness.worker.retrySyscall(nestedChannel);
          expect(getProcessExitSignal).not.toHaveBeenCalled();
          expect(readChannelCompletion(nestedChannel).status)
            .toBe(CHANNEL_STATUS_PENDING);
          return 0;
        }
        const view = new DataView(
          harness.kernelBytes.buffer,
          Number(pointer),
        );
        view.setBigInt64(CH_RETURN, 1n, true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      harness.kernelExports.kernel_handle_channel = handleChannel;

      harness.scratchRegion.withLease((lease) => {
        expect(lease.invokeKernelExport("kernel_handle_channel", [
          lease.exportPointer(0, CH_TOTAL_SIZE),
          CH_TOTAL_SIZE,
          pointerWidth,
          0n,
        ])).toBe(0);
      });

      expect(getProcessExitSignal).not.toHaveBeenCalled();
      expect(handleChannel).toHaveBeenCalledOnce();
      await Promise.resolve();
      // The selected retry checks for an already-fatal process before
      // dispatch and again after signal dequeue. Both queries must happen
      // only after the outer export has released the gate.
      expect(getProcessExitSignal).toHaveBeenCalledTimes(2);
      expect(handleChannel).toHaveBeenCalledTimes(2);
      expect(readChannelCompletion(nestedChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: 1,
        errno: 0,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s keeps nested channel imports behind followers while a selected handler makes sequential exports",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const selected = makeChannel(42);
      const nested = makeChannel(43);
      addChannel(harness, selected, pointerWidth);
      addChannel(harness, nested, pointerWidth);
      new Uint8Array(selected.memory.buffer).fill(
        0x42,
        1024,
        1024 + LARGE_LENGTH,
      );
      new Uint8Array(nested.memory.buffer)[2048] = 0x43;
      writeSyscall(
        selected,
        ABI_SYSCALLS.Write,
        [7n, 1024n, BigInt(LARGE_LENGTH)],
      );
      writeSyscall(nested, ABI_SYSCALLS.Write, [8n, 2048n, 1n]);
      const order: string[] = [];
      harness.kernelExports.kernel_transfer_scratch_begin = vi.fn((
        minimumCapacity: number | bigint,
      ) => {
        order.push("begin");
        return harness.begin(minimumCapacity);
      });
      harness.kernelExports.kernel_transfer_scratch_pointer = vi.fn((
        token: bigint,
      ) => {
        order.push("pointer");
        return harness.pointer(token);
      });
      harness.kernelExports.kernel_transfer_scratch_capacity = vi.fn((
        token: bigint,
      ) => {
        order.push("capacity");
        return harness.capacity(token);
      });
      harness.kernelExports.kernel_transfer_io_execute = vi.fn(() => {
        order.push("execute");
        harness.worker.handleSyscall(nested);
        expect(order).not.toContain("nested");
        expect(() => harness.worker.ptyMasterRead(7))
          .toThrow(/PTY master read/);
        return LARGE_LENGTH;
      });
      harness.kernelExports.kernel_transfer_scratch_cancel = vi.fn((
        token: bigint,
      ) => {
        order.push("cancel");
        return harness.cancel(token);
      });
      harness.kernelExports.kernel_handle_channel = vi.fn((
        pointer: number | bigint,
      ) => {
        order.push("nested");
        const view = new DataView(
          harness.kernelBytes.buffer,
          Number(pointer),
        );
        view.setBigInt64(CH_RETURN, 1n, true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      harness.kernelExports.kernel_pty_master_read = vi.fn(() => {
        order.push("stolen");
        return 0;
      });

      harness.gate.invokeKernelExport("outer", () => {
        harness.worker.retrySyscall(selected);
        harness.gate.runOrDeferVoidIngress(
          "follower",
          () => {
            order.push("follower");
          },
        );
      });
      await Promise.resolve();

      expect(order).toEqual([
        "begin",
        "pointer",
        "capacity",
        "execute",
        "cancel",
        "follower",
        "nested",
      ]);
      expect(readChannelCompletion(selected).status)
        .toBe(CHANNEL_STATUS_COMPLETE);
      expect(readChannelCompletion(nested).status)
        .toBe(CHANNEL_STATUS_COMPLETE);
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s propagates begin ENOMEM without consulting or cancelling a token",
    (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      harness.kernelExports.kernel_transfer_scratch_begin =
        vi.fn(() => -BigInt(ENOMEM));

      invokeLargeWrite(harness);

      expect(harness.pointer).not.toHaveBeenCalled();
      expect(harness.capacity).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect(harness.cancel).not.toHaveBeenCalled();
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: ENOMEM,
      });
    },
  );

  it.each([
    ["wasm32 null pointer", 4, 0, LARGE_LENGTH],
    ["wasm32 zero capacity", 4, 2 * 65_536, 0],
    ["wasm32 end-of-memory range", 4, 4 * 65_536 - 8, LARGE_LENGTH],
    ["wasm64 null pointer", 8, 0, LARGE_LENGTH],
    ["wasm64 zero capacity", 8, 2 * 65_536, 0],
    ["wasm64 end-of-memory range", 8, 4 * 65_536 - 8, LARGE_LENGTH],
  ] as const)(
    "%s is cancelled exactly once before any execute",
    (_name, pointerWidth, pointerValue, capacityValue) => {
      const harness = makeTransferHarness(pointerWidth);
      harness.kernelExports.kernel_transfer_scratch_pointer = () =>
        kernelPointer(pointerWidth, pointerValue);
      harness.kernelExports.kernel_transfer_scratch_capacity = () =>
        kernelPointer(pointerWidth, capacityValue);

      invokeLargeWrite(harness);

      expect(harness.execute).not.toHaveBeenCalled();
      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(harness.cancel).toHaveBeenCalledWith(101n);
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: EIO,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s uses and settles a fresh token for sequential operations",
    (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);

      invokeLargeWrite(harness);
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: LARGE_LENGTH,
        errno: 0,
      });
      invokeLargeWrite(harness);

      expect(harness.execute.mock.calls.map((call) => call[2]))
        .toEqual([101n, 102n]);
      expect(harness.cancel.mock.calls.map((call) => call[0]))
        .toEqual([101n, 102n]);
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: LARGE_LENGTH,
        errno: 0,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s uses and settles a fresh token for sequential reserved sendmsg channels",
    (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);

      const length = invokeLargeSendmsg(harness, pointerWidth);
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: length,
        errno: 0,
      });
      invokeLargeSendmsg(harness, pointerWidth);

      expect(harness.channelExecute.mock.calls.map((call) => call[2]))
        .toEqual([101n, 102n]);
      expect(harness.cancel.mock.calls.map((call) => call[0]))
        .toEqual([101n, 102n]);
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: length,
        errno: 0,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s defers a reentrant reserved sendmsg without replacing outer bytes",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const nestedChannel = makeChannel(42);
      addChannel(harness, nestedChannel, pointerWidth);
      const messageLength = writeLargeSendmsg(
        pointerWidth,
        nestedChannel,
        0x42,
      );
      const channelExecute = vi.fn(() => {
        const channelView = new DataView(
          harness.kernelBytes.buffer,
          harness.transferOffset,
        );
        const messagePointer = Number(
          channelView.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        );
        const kernelView = new DataView(harness.kernelBytes.buffer);
        const iovecPointer = kernelView.getUint32(
          messagePointer + 8,
          true,
        );
        const dataPointer = kernelView.getUint32(iovecPointer, true);
        const length = kernelView.getUint32(iovecPointer + 4, true);
        const expectedByte = channelExecute.mock.calls.length === 1
          ? 0x41
          : 0x42;
        expect(length).toBe(messageLength);
        expect(
          harness.kernelBytes.slice(dataPointer, dataPointer + length),
        ).toEqual(new Uint8Array(length).fill(expectedByte));

        if (channelExecute.mock.calls.length === 1) {
          harness.worker.handleSyscall(nestedChannel);
          harness.worker.handleSyscall(nestedChannel);
          expect(readChannelCompletion(nestedChannel).status)
            .toBe(CHANNEL_STATUS_PENDING);
          // WHY: the global reservation remains owned by the outer entry
          // until execute and settlement finish. Reentrant ingress must wait,
          // or it could replace bytes the kernel is still synchronously using.
          expect(
            harness.kernelBytes.slice(dataPointer, dataPointer + length),
          ).toEqual(new Uint8Array(length).fill(0x41));
        }
        channelView.setBigInt64(CH_RETURN, BigInt(length), true);
        channelView.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      harness.kernelExports.kernel_transfer_channel_execute =
        channelExecute;

      const outerLength = invokeLargeSendmsg(
        harness,
        pointerWidth,
        harness.channel,
        0x41,
      );

      expect(channelExecute).toHaveBeenCalledOnce();
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: outerLength,
        errno: 0,
      });
      expect(readChannelCompletion(nestedChannel).status)
        .toBe(CHANNEL_STATUS_PENDING);

      await Promise.resolve();

      expect(channelExecute.mock.calls.map((call) => call[2]))
        .toEqual([101n, 102n]);
      expect(harness.cancel.mock.calls.map((call) => call[0]))
        .toEqual([101n, 102n]);
      expect(readChannelCompletion(nestedChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: messageLength,
        errno: 0,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s defers a reentrant channel without replacing its mailbox or outer bytes",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const nestedChannel = makeChannel(42);
      addChannel(harness, nestedChannel, pointerWidth);
      writeSyscall(
        nestedChannel,
        ABI_SYSCALLS.Write,
        [7n, 2048n, BigInt(LARGE_LENGTH)],
      );
      const outerPayload = Uint8Array.from(
        { length: LARGE_LENGTH },
        (_, index) => (index * 17 + 3) % 251,
      );
      harness.processBytes.set(outerPayload, 1024);
      const execute = vi.fn(() => {
        if (execute.mock.calls.length === 1) {
          expect(harness.worker.currentHandlePid).toBe(harness.channel.pid);
          harness.worker.handleSyscall(nestedChannel);
          harness.worker.handleSyscall(nestedChannel);
          expect(readChannelCompletion(nestedChannel).status)
            .toBe(CHANNEL_STATUS_PENDING);
          expect(
            harness.kernelBytes.slice(
              harness.transferOffset,
              harness.transferOffset + LARGE_LENGTH,
            ),
          ).toEqual(outerPayload);
        }
        return LARGE_LENGTH;
      });
      harness.kernelExports.kernel_transfer_io_execute = execute;

      writeSyscall(
        harness.channel,
        ABI_SYSCALLS.Write,
        [7n, 1024n, BigInt(LARGE_LENGTH)],
      );
      harness.worker.handleSyscall(harness.channel);

      expect(harness.begin).toHaveBeenCalledOnce();
      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: LARGE_LENGTH,
        errno: 0,
      });
      expect(readChannelCompletion(nestedChannel).status)
        .toBe(CHANNEL_STATUS_PENDING);

      await Promise.resolve();

      expect(execute).toHaveBeenCalledTimes(2);
      expect(readChannelCompletion(nestedChannel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: LARGE_LENGTH,
        errno: 0,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s converts a result above the requested length to EIO and settles",
    (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      harness.kernelExports.kernel_transfer_io_execute =
        vi.fn(() => LARGE_LENGTH + 1);

      invokeLargeWrite(harness);

      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: EIO,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s cancels EAGAIN scratch before parking the retry",
    (_name, pointerWidth) => {
      vi.useFakeTimers();
      const harness = makeTransferHarness(pointerWidth);
      const order: string[] = [];
      class RecordingRetryMap extends Map<unknown, unknown> {
        override set(key: unknown, value: unknown): this {
          order.push("retry");
          return super.set(key, value);
        }
      }
      harness.worker.pendingPollRetries = new RecordingRetryMap();
      harness.kernelExports.kernel_transfer_io_execute =
        vi.fn(() => -EAGAIN);
      harness.kernelExports.kernel_transfer_scratch_cancel =
        vi.fn(() => {
          order.push("cancel");
          return 0;
        });

      invokeLargeWrite(harness);

      expect(order).toEqual(["cancel", "retry"]);
      expect(readChannelCompletion(harness.channel).status)
        .toBe(CHANNEL_STATUS_PENDING);
      expect(harness.worker.pendingPollRetries.has(harness.channel)).toBe(true);
      vi.clearAllTimers();
    },
  );
});

describe("kernel transfer fatal latch", () => {
  it("keeps every channel inert when Rust returns a mismatched committed exit status", async () => {
    const harness = makeTransferHarness(4);
    harness.kernelExports.kernel_commit_process_exit = vi.fn(() => 6);
    harness.kernelExports.kernel_get_process_state = vi.fn(
      () => PROCESS_STATE_EXITED,
    );

    writeSyscall(
      harness.channel,
      ABI_SYSCALLS.ExitGroup,
      [7n],
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => harness.worker.handleSyscall(harness.channel)).toThrow(
      "kernel committed exit status 6 for process 41; expected 7",
    );
    await Promise.resolve();
    expect(harness.onKernelFatal).toHaveBeenCalledOnce();
    expect(harness.onKernelFatal.mock.calls[0]?.[0]).toMatchObject({
      name: "KernelExitCommitProtocolError",
    });
    expect(harness.worker.isKernelInitialized()).toBe(false);
    expect(harness.channel.handling).toBe(true);
    expect(readChannelCompletion(harness.channel).status)
      .toBe(CHANNEL_STATUS_PENDING);
    expect(error).toHaveBeenCalledWith(
      "[handleSyscall] KERNEL-FATAL "
        + "kernel committed exit status 6 for process 41; expected 7",
    );
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s export trap never completes the channel with recoverable EIO",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const fatal = new Error("synthetic ordinary kernel export trap");
      harness.kernelExports.kernel_handle_channel = () => {
        throw fatal;
      };
      writeSyscall(
        harness.channel,
        ABI_SYSCALLS.Write,
        [7n, 1024n, 1n],
      );

      expect(() => harness.worker.handleSyscall(harness.channel))
        .toThrow(/kernel export kernel_handle_channel failed/);
      await Promise.resolve();

      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      const failure = harness.onKernelFatal.mock.calls[0]?.[0] as
        (Error & { cause?: unknown }) | undefined;
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.cause).toBe(fatal);
      expect(harness.worker.isKernelInitialized()).toBe(false);
      expect(harness.channel.handling).toBe(true);
      expect(readChannelCompletion(harness.channel).status)
        .toBe(CHANNEL_STATUS_PENDING);
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s execute trap latches once and makes queued and direct dispatch inert",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      const deferredChannel = makeChannel(42);
      addChannel(harness, deferredChannel, pointerWidth);
      writeSyscall(
        deferredChannel,
        ABI_SYSCALLS.Write,
        [7n, 1024n, 1n],
      );

      harness.processBytes.fill(0x3a, 1024, 1024 + LARGE_LENGTH);
      writeSyscall(
        harness.channel,
        ABI_SYSCALLS.Write,
        [7n, 1024n, BigInt(LARGE_LENGTH)],
      );
      const deferredBeforeTrap = vi.fn(() => 0);
      harness.kernelExports.kernel_handle_channel = deferredBeforeTrap;
      harness.worker.currentHandlePid = 777;
      const transferTrap = new Error("synthetic transfer import trap");
      const execute = vi.fn(() => {
        expect(harness.worker.currentHandlePid).toBe(harness.channel.pid);
        harness.worker.handleSyscall(deferredChannel);
        expect(deferredBeforeTrap).not.toHaveBeenCalled();
        throw transferTrap;
      });
      harness.kernelExports.kernel_transfer_io_execute = execute;
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => {},
      );

      expect(() => harness.worker.handleSyscall(harness.channel))
        .toThrow(/kernel export kernel_transfer_io_execute failed/);
      await Promise.resolve();

      expect(execute).toHaveBeenCalledOnce();
      expect(harness.cancel).not.toHaveBeenCalled();
      expect(harness.worker.currentHandlePid).toBe(777);
      expect(harness.worker.isKernelInitialized()).toBe(false);
      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      const failure = harness.onKernelFatal.mock.calls[0]?.[0] as
        (Error & { trappedCause?: unknown }) | undefined;
      expect(failure).toMatchObject({
        name: "KernelTransferExecuteTrapError",
        message:
          "kernel transfer execute trapped with a global reservation active",
      });
      const trappedExport = failure?.trappedCause as
        (Error & { cause?: unknown }) | undefined;
      expect(trappedExport).toMatchObject({
        message: "kernel export kernel_transfer_io_execute failed",
      });
      expect(trappedExport?.cause).toBe(transferTrap);
      expect(harness.channel.handling).toBe(true);
      expect(deferredChannel.handling).toBe(true);
      expect(readChannelCompletion(harness.channel).status)
        .toBe(CHANNEL_STATUS_PENDING);
      expect(readChannelCompletion(deferredChannel).status)
        .toBe(CHANNEL_STATUS_PENDING);

      harness.worker.handleSyscall(harness.channel);
      harness.worker.retrySyscall(harness.channel);
      harness.worker.listenOnChannel(harness.channel);

      expect(execute).toHaveBeenCalledOnce();
      expect(deferredBeforeTrap).not.toHaveBeenCalled();
      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      expect(readChannelCompletion(harness.channel).status)
        .toBe(CHANNEL_STATUS_PENDING);
      consoleError.mockRestore();
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s cancel failure is kernel-fatal after restoring the selected pid",
    async (_name, pointerWidth) => {
      const harness = makeTransferHarness(pointerWidth);
      harness.processBytes.fill(0x72, 1024, 1024 + LARGE_LENGTH);
      writeSyscall(
        harness.channel,
        ABI_SYSCALLS.Write,
        [7n, 1024n, BigInt(LARGE_LENGTH)],
      );
      harness.worker.currentHandlePid = 888;
      const execute = vi.fn(() => {
        expect(harness.worker.currentHandlePid).toBe(harness.channel.pid);
        return LARGE_LENGTH;
      });
      const cancel = vi.fn(() => -EINVAL);
      harness.kernelExports.kernel_transfer_io_execute = execute;
      harness.kernelExports.kernel_transfer_scratch_cancel = cancel;
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => {},
      );

      expect(() => harness.worker.handleSyscall(harness.channel))
        .toThrow(/kernel transfer reservation could not be settled/);
      harness.worker.handleSyscall(harness.channel);
      await Promise.resolve();

      expect(execute).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(harness.worker.currentHandlePid).toBe(888);
      expect(harness.worker.isKernelInitialized()).toBe(false);
      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      expect(readChannelCompletion(harness.channel).status)
        .toBe(CHANNEL_STATUS_PENDING);
      consoleError.mockRestore();
    },
  );
});

describe("large vector validation precedes reservation", () => {
  it.each([
    ["wasm32 writev", 4, ABI_SYSCALLS.Writev],
    ["wasm32 readv", 4, ABI_SYSCALLS.Readv],
    ["wasm64 writev", 8, ABI_SYSCALLS.Writev],
    ["wasm64 readv", 8, ABI_SYSCALLS.Readv],
  ] as const)(
    "%s rejects IOV_MAX + 1 without beginning a reservation",
    (_name, pointerWidth, syscall) => {
      const harness = makeTransferHarness(pointerWidth);
      const tablePointer = 256;

      writeSyscall(
        harness.channel,
        syscall,
        [
          7n,
          BigInt(tablePointer),
          BigInt(POSIX_IOV_MAX + 1),
          0n,
          0n,
          0n,
        ],
      );
      harness.worker.handleSyscall(harness.channel);

      expect(harness.begin).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: EINVAL,
      });
    },
  );

  it.each([
    ["wasm32 writev", 4, ABI_SYSCALLS.Writev],
    ["wasm32 readv", 4, ABI_SYSCALLS.Readv],
    ["wasm64 writev", 8, ABI_SYSCALLS.Writev],
    ["wasm64 readv", 8, ABI_SYSCALLS.Readv],
  ] as const)(
    "%s rejects a later invalid nested range without beginning a reservation",
    (_name, pointerWidth, syscall) => {
      const harness = makeTransferHarness(pointerWidth);
      const tablePointer = 256;
      writeIovec(
        harness.channel.memory,
        pointerWidth,
        tablePointer,
        0,
        4096,
        LARGE_LENGTH,
      );
      writeIovec(
        harness.channel.memory,
        pointerWidth,
        tablePointer,
        1,
        harness.processBytes.byteLength - 1,
        2,
      );

      writeSyscall(
        harness.channel,
        syscall,
        [7n, BigInt(tablePointer), 2n, 0n, 0n, 0n],
      );
      harness.worker.handleSyscall(harness.channel);

      expect(harness.begin).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect(readChannelCompletion(harness.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE,
        retVal: -1,
        errno: EFAULT,
      });
    },
  );
});

describe("ignored vector and message pointers", () => {
  it.each([
    ["wasm32", 4, 0xffff_ffffn],
    ["wasm64", 8, 1n << 60n],
  ] as const)(
    "%s validates iovcnt before the pointer and canonicalizes zero-count iov",
    (_name, pointerWidth, ignoredPointer) => {
      const harness = makeTransferHarness(pointerWidth);
      const zeroArgs = [7, Number(ignoredPointer), 0, 0, 0, 0];
      expect(() => harness.worker.checkHandwrittenProcessAddressArguments(
        harness.channel,
        ABI_SYSCALLS.Writev,
        zeroArgs,
        [7n, ignoredPointer, 0n, 0n, 0n, 0n],
        [7n, ignoredPointer, 0n, 0n, 0n, 0n],
      )).not.toThrow();
      expect(zeroArgs[1]).toBe(0);
      expect(zeroArgs[2]).toBe(0);

      const invalidCountArgs = [7, 0, 0, 0, 0, 0];
      expect(() => harness.worker.checkHandwrittenProcessAddressArguments(
        harness.channel,
        ABI_SYSCALLS.Readv,
        invalidCountArgs,
        [7n, ignoredPointer, BigInt(POSIX_IOV_MAX + 1), 0n, 0n, 0n],
        [
          7n,
          ignoredPointer,
          BigInt(POSIX_IOV_MAX + 1),
          0n,
          0n,
          0n,
        ],
      )).toThrow(/iovec count/);
    },
  );

  it.each([
    ["wasm32", 4, 0xffff_ffffn],
    ["wasm64", 8, 1n << 60n],
  ] as const)(
    "%s ignores msg_name, msg_control, and iov pointers with zero lengths",
    (_name, pointerWidth, ignoredPointer) => {
      const harness = makeTransferHarness(pointerWidth);
      const messagePointer = 512;
      const view = new DataView(harness.channel.memory.buffer);
      const layout = pointerWidth === 8
        ? {
            size: PROCESS_MSGHDR_WASM64_SIZE,
            name: PROCESS_MSGHDR_WASM64_NAME_OFFSET,
            nameLength: PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET,
            iov: PROCESS_MSGHDR_WASM64_IOV_OFFSET,
            iovCount: PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET,
            control: PROCESS_MSGHDR_WASM64_CONTROL_OFFSET,
            controlLength: PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET,
          }
        : {
            size: PROCESS_MSGHDR_WASM32_SIZE,
            name: PROCESS_MSGHDR_WASM32_NAME_OFFSET,
            nameLength: PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET,
            iov: PROCESS_MSGHDR_WASM32_IOV_OFFSET,
            iovCount: PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET,
            control: PROCESS_MSGHDR_WASM32_CONTROL_OFFSET,
            controlLength: PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET,
          };
      new Uint8Array(
        harness.channel.memory.buffer,
        messagePointer,
        layout.size,
      ).fill(0);
      if (pointerWidth === 8) {
        view.setBigUint64(messagePointer + layout.name, ignoredPointer, true);
        view.setBigUint64(messagePointer + layout.iov, ignoredPointer, true);
        view.setBigUint64(
          messagePointer + layout.control,
          ignoredPointer,
          true,
        );
        view.setBigUint64(messagePointer + layout.iovCount, 0n, true);
        view.setBigUint64(messagePointer + layout.controlLength, 0n, true);
      } else {
        view.setUint32(
          messagePointer + layout.name,
          Number(ignoredPointer),
          true,
        );
        view.setUint32(
          messagePointer + layout.iov,
          Number(ignoredPointer),
          true,
        );
        view.setUint32(
          messagePointer + layout.control,
          Number(ignoredPointer),
          true,
        );
        view.setUint32(messagePointer + layout.iovCount, 0, true);
        view.setUint32(messagePointer + layout.controlLength, 0, true);
      }
      view.setUint32(messagePointer + layout.nameLength, 0, true);

      const message = harness.worker.checkedProcessMessage(
        harness.channel,
        kernelPointer(pointerWidth, messagePointer),
      );
      expect(message.name).toEqual({ pointer: 0, length: 0 });
      expect(message.control).toEqual({ pointer: 0, length: 0 });
      expect(message.iovecs).toEqual({ entries: [], totalData: 0 });
    },
  );

  it("wasm64 ignores the ABI padding after 32-bit msghdr counts", () => {
    const harness = makeTransferHarness(8);
    const messagePointer = 512;
    const bytes = new Uint8Array(
      harness.channel.memory.buffer,
      messagePointer,
      PROCESS_MSGHDR_WASM64_SIZE,
    );
    bytes.fill(0);
    const view = new DataView(harness.channel.memory.buffer);

    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET + 4,
      1,
      true,
    );
    let message = harness.worker.checkedProcessMessage(
      harness.channel,
      BigInt(messagePointer),
    );
    expect(message.iovecs).toEqual({ entries: [], totalData: 0 });

    view.setUint32(
      messagePointer + PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET + 4,
      1,
      true,
    );
    message = harness.worker.checkedProcessMessage(
      harness.channel,
      BigInt(messagePointer),
    );
    expect(message.control).toEqual({ pointer: 0, length: 0 });
  });

  it("wasm64 rejects a high-word cmsg_len and emits native size_t fields", () => {
    const harness = makeTransferHarness(8);
    const controlPointer = 1024;
    const controlLength = Math.max(
      PROCESS_CMSGHDR_WASM64_SIZE,
      PROCESS_CMSGHDR_WASM64_DATA_OFFSET + 8,
    );
    const processView = new DataView(harness.channel.memory.buffer);
    processView.setBigUint64(
      controlPointer + PROCESS_CMSGHDR_WASM64_LEN_OFFSET,
      (1n << 32n) + BigInt(PROCESS_CMSGHDR_WASM64_DATA_OFFSET + 4),
      true,
    );
    const message = {
      pointerWidth: 8,
      messagePointer: 0,
      namePresent: false,
      name: { pointer: 0, length: 0 },
      control: { pointer: controlPointer, length: controlLength },
      iovecs: { entries: [], totalData: 0 },
    };
    expect(() => harness.worker.nativeControlToKernelWire(
      new Uint8Array(harness.channel.memory.buffer),
      message,
    )).toThrow(/control message exceeds|cmsg_len/);

    const wireLength = KERNEL_CMSGHDR_WIRE_DATA_OFFSET + 4;
    const wireSpace = Math.ceil(
      wireLength / KERNEL_CMSGHDR_WIRE_ALIGN,
    ) * KERNEL_CMSGHDR_WIRE_ALIGN;
    const wire = new Uint8Array(wireSpace);
    const wireView = new DataView(wire.buffer);
    wireView.setUint32(KERNEL_CMSGHDR_WIRE_LEN_OFFSET, wireLength, true);
    wireView.setUint32(
      KERNEL_CMSGHDR_WIRE_LEVEL_OFFSET,
      SOCKET_SOL_SOCKET,
      true,
    );
    wireView.setUint32(
      KERNEL_CMSGHDR_WIRE_TYPE_OFFSET,
      SOCKET_SCM_RIGHTS,
      true,
    );
    wireView.setInt32(KERNEL_CMSGHDR_WIRE_DATA_OFFSET, 7, true);

    const native = harness.worker.kernelControlToNative(wire, message);
    expect(new DataView(
      native.bytes.buffer,
      native.bytes.byteOffset,
      native.bytes.byteLength,
    ).getBigUint64(PROCESS_CMSGHDR_WASM64_LEN_OFFSET, true)).toBe(
      BigInt(PROCESS_CMSGHDR_WASM64_DATA_OFFSET + 4),
    );

    const sizeField = new DataView(new ArrayBuffer(8));
    harness.worker.writeProcessUsize(
      sizeField,
      0,
      0x1_0000_0001,
      8,
      "test msg_controllen",
    );
    expect(sizeField.getBigUint64(0, true)).toBe(0x1_0000_0001n);
  });
});
