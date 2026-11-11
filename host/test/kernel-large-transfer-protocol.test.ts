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
  CHANNEL_REQUEST_FLAG_CANCELLATION_POINT,
  CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA_SIZE,
  ENTROPY_READ_PENDING,
  CH_ERRNO,
  CH_REQUEST_FLAGS,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
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
  WAKEUP_EVENT_RECORD_BYTES,
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
  guestExecute: ReturnType<typeof vi.fn>;
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
  const guestExecute = vi.fn((pointer: number | bigint) => {
    const view = new DataView(kernelMemory.buffer, Number(pointer));
    const random = view.getUint32(CH_SYSCALL, true) === ABI_SYSCALLS.Getrandom;
    const length = view.getBigInt64(CH_ARGS + (random ? 1 : 2) * CH_ARG_SIZE, true);
    view.setBigInt64(CH_RETURN, length, true);
    view.setUint32(CH_ERRNO, 0, true);
    return Number(length);
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
    kernel_handle_guest_io: guestExecute,
    kernel_dequeue_signal: () => 0,
    kernel_drain_wakeup_events: () => 0,
    kernel_get_process_exit_signal: () => 0,
    kernel_get_process_state: () => 0,
    kernel_rootfs_take_compaction_request: () => 0,
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
    guestExecute,
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
  // One byte past the ordinary channel mailbox. The figure used to subtract
  // the fixed msghdr and iovec wires the host staged beside the payload; the
  // kernel walks the caller's own header now, so nothing but the payload has
  // ever to fit, and "too large for the mailbox" is the whole property.
  const length = CH_DATA_SIZE + 1;
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
      // PTY input also drains kernel wakeup events through this same region
      // (256 records), so that buffer is the smallest faithful capacity.
      const capacity = 256 * WAKEUP_EVENT_RECORD_BYTES;
      const harness = makeTransferHarness(pointerWidth, capacity);
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
      const input = Uint8Array.from({ length: capacity + 1 }, (_, index) => index + 1);

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
        Array.from({ length: capacity }, (_, index) => (index + 1) & 0xff),
        [(capacity + 1) & 0xff],
      ]);
      expect(order).toEqual([
        `write:${capacity}`,
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





  // The sendmsg/recvmsg cases that stood here died with their subject. They
  // proved the HOST's staging of a caller-native `msghdr` into the fixed
  // kernel wire: token reuse across reserved sendmsg channels, zero-length
  // name/control/iov pointers being ignored, the ABI padding musl leaves
  // after its 32-bit `msg_iovlen`/`msg_controllen` on wasm64, and a
  // high-word `cmsg_len`. The kernel walks the caller's header directly now,
  // so none of that crosses a channel. The equivalent proofs live in
  // `crates/runtime-core/src/msghdr.rs`, which tests both caller widths and
  // poisons the wasm64 padding explicitly.





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
      harness.kernelExports.kernel_handle_guest_io = execute;
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => {},
      );

      expect(() => harness.worker.handleSyscall(harness.channel))
        .toThrow(/kernel export kernel_handle_guest_io failed/);
      await Promise.resolve();

      expect(execute).toHaveBeenCalledOnce();
      expect(harness.cancel).not.toHaveBeenCalled();
      expect(harness.worker.isKernelInitialized()).toBe(false);
      expect(harness.onKernelFatal).toHaveBeenCalledOnce();
      const failure = harness.onKernelFatal.mock.calls[0]?.[0] as Error & { cause?: unknown };
      expect(failure.message).toContain("kernel export kernel_handle_guest_io failed");
      expect(failure.cause).toBe(transferTrap);
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

});

describe("vector I/O never reserves host transfer scratch", () => {
  // Vector I/O used to be flattened by the host: it walked the caller's iovec
  // table, bounded the count, proved every nested range, and staged the whole
  // payload into a reserved kernel allocation. That reservation is what these
  // cases guarded -- "reject before reserving" mattered because a reservation
  // had already been taken out on the caller's word.
  //
  // The kernel walks the caller's table itself now, into memory it owns, so
  // there is no host reservation to protect and no host-side count or range
  // bound to run early. `IOV_MAX`, aggregate SSIZE_MAX and per-buffer EFAULT
  // are proven where they are now enforced: `msghdr::read_iovecs` and
  // `syscalls::sys_vector_io` in `runtime-core`, and end to end on both caller
  // widths by `examples/kernel_scratch_browser_test.c` via
  // `test/kernel-scratch-runtime.test.ts`.
  //
  // What is worth pinning here is the property those cases were really about,
  // stated positively: a vector syscall must reach `kernel_handle_channel`
  // without touching the reserved-transfer protocol at all, however large or
  // however malformed its table.
  it.each([
    ["wasm32 writev", 4, ABI_SYSCALLS.Writev],
    ["wasm32 readv", 4, ABI_SYSCALLS.Readv],
    ["wasm64 writev", 8, ABI_SYSCALLS.Writev],
    ["wasm64 readv", 8, ABI_SYSCALLS.Readv],
  ] as const)(
    "%s dispatches through the ordinary channel, reserving nothing",
    (_name, pointerWidth, syscall) => {
      const harness = makeTransferHarness(pointerWidth);
      const handleChannel = vi.fn(() => 0);
      harness.kernelExports.kernel_handle_channel = handleChannel;
      const tablePointer = 256;
      writeIovec(
        harness.channel.memory,
        pointerWidth,
        tablePointer,
        0,
        4096,
        LARGE_LENGTH,
      );

      writeSyscall(
        harness.channel,
        syscall,
        [7n, BigInt(tablePointer), 1n, 0n, 0n, 0n],
      );
      harness.worker.handleSyscall(harness.channel);

      expect(harness.begin).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect(harness.channelExecute).not.toHaveBeenCalled();
      expect(handleChannel).toHaveBeenCalled();
    },
  );

  it.each([
    ["wasm32 writev", 4, ABI_SYSCALLS.Writev],
    ["wasm32 readv", 4, ABI_SYSCALLS.Readv],
    ["wasm64 writev", 8, ABI_SYSCALLS.Writev],
    ["wasm64 readv", 8, ABI_SYSCALLS.Readv],
  ] as const)(
    "%s reserves nothing even for a count past IOV_MAX",
    (_name, pointerWidth, syscall) => {
      const harness = makeTransferHarness(pointerWidth);
      const handleChannel = vi.fn(() => 0);
      harness.kernelExports.kernel_handle_channel = handleChannel;
      writeSyscall(
        harness.channel,
        syscall,
        [7n, 256n, BigInt(POSIX_IOV_MAX + 1), 0n, 0n, 0n],
      );
      harness.worker.handleSyscall(harness.channel);

      expect(harness.begin).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect(handleChannel).toHaveBeenCalled();
    },
  );
});

describe("ignored vector and message pointers", () => {
  it.each([
    ["wasm32", 4, 0xffff_ffffn],
    ["wasm64", 8, 1n << 60n],
  ] as const)(
    "%s canonicalizes an iovec pointer a zero count makes meaningless",
    (_name, pointerWidth, ignoredPointer) => {
      // POSIX does not inspect `iov` when `iovcnt` is zero, so the caller may
      // leave bits there that no pointer of its data model could hold. The
      // host normalizes them away before the generated process-address
      // contract can reject a value that names nothing. The count itself is no
      // longer the host's to bound: the kernel owns the table walk, so IOV_MAX
      // is its EINVAL to report.
      const harness = makeTransferHarness(pointerWidth);
      const rawArgs = [7n, ignoredPointer, 0n, 0n, 0n, 0n];
      harness.worker.normalizeIgnoredVectorTablePointer(
        ABI_SYSCALLS.Writev,
        rawArgs,
      );
      expect(rawArgs[1]).toBe(0n);

      const keptArgs = [7n, ignoredPointer, 1n, 0n, 0n, 0n];
      harness.worker.normalizeIgnoredVectorTablePointer(
        ABI_SYSCALLS.Readv,
        keptArgs,
      );
      expect(keptArgs[1]).toBe(ignoredPointer);
    },
  );



});

function setGuestResult(h: TransferHarness, result: bigint, errno = 0): void {
  h.kernelExports.kernel_handle_guest_io = vi.fn((pointer: number | bigint) => {
    const view = new DataView(h.kernelBytes.buffer, Number(pointer));
    view.setBigInt64(CH_RETURN, result, true);
    view.setUint32(CH_ERRNO, errno, true);
    return errno ? -errno : Number(result);
  });
}

function setEntropyPending(h: TransferHarness, token: bigint): void {
  setGuestResult(h, token, ENTROPY_READ_PENDING >>> 0);
  h.worker.processes.get(h.channel.pid).execGeneration = 0n;
}

describe("guest-address scalar I/O transport", () => {
  it.each([4, 8] as const)("passes arguments once without allocating a payload at width %i", width => {
    const h = makeTransferHarness(width);
    invokeLargeWrite(h);
    expect(h.guestExecute).toHaveBeenCalledOnce();
    const pointer = Number(h.guestExecute.mock.calls[0][0]);
    const view = new DataView(h.kernelBytes.buffer, pointer);
    expect(view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true)).toBe(1024n);
    expect(view.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true)).toBe(BigInt(LARGE_LENGTH));
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: LARGE_LENGTH, errno: 0 });
  });

  it.each([4, 8] as const)("keeps the original getrandom size at width %i", width => {
    const h = makeTransferHarness(width);
    writeSyscall(h.channel, ABI_SYSCALLS.Getrandom, [1024n, BigInt(LARGE_LENGTH), 0n]);
    h.worker.handleSyscall(h.channel);
    expect(h.guestExecute).toHaveBeenCalledOnce();
    expect(h.begin).not.toHaveBeenCalled();
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: LARGE_LENGTH, errno: 0 });
  });

  it.each([4, 8] as const)("propagates in-dispatch admission failure at width %i", width => {
    const h = makeTransferHarness(width);
    setGuestResult(h, -1n, ENOMEM);
    invokeLargeWrite(h);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: ENOMEM });
  });

  it.each([4, 8] as const)("rejects counts above the captured request at width %i", width => {
    const h = makeTransferHarness(width);
    setGuestResult(h, BigInt(LARGE_LENGTH + 1));
    invokeLargeWrite(h);
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: EIO });
  });

  it.each([4, 8] as const)("replays captured scalar arguments and token without host payload at width %i", async width => {
    vi.useFakeTimers();
    const h = makeTransferHarness(width);
    const attempts: bigint[][] = [];
    h.kernelExports.kernel_handle_guest_io = vi.fn((pointer: number | bigint, _capacity: number, _pid: number, token: bigint) => {
      const view = new DataView(h.kernelBytes.buffer, Number(pointer));
      attempts.push([view.getBigInt64(CH_ARGS, true), view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
        view.getBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, true), token]);
      view.setBigInt64(CH_RETURN, attempts.length === 1 ? -1n : BigInt(LARGE_LENGTH), true);
      view.setUint32(CH_ERRNO, attempts.length === 1 ? EAGAIN : 0, true);
      return 0;
    });
    invokeLargeWrite(h);
    expect(readChannelCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
    const snapshot = h.worker.blockingRetrySnapshots.get(h.channel);
    expect(snapshot.kind).toBe("guest-io");
    expect(snapshot.request.adjustedArgs.slice(0, 3)).toEqual([7, 1024n, BigInt(LARGE_LENGTH)]);
    // Retrying must use frozen metadata. Rust retains bytes and the OFD.
    writeSyscall(h.channel, ABI_SYSCALLS.Write, [99n, 2048n, BigInt(LARGE_LENGTH + 1)]);
    h.worker.retrySyscall(h.channel);
    expect(attempts).toEqual([[7n, 1024n, BigInt(LARGE_LENGTH), 0n], [7n, 1024n, BigInt(LARGE_LENGTH), 701n]]);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: LARGE_LENGTH, errno: 0 });
    vi.clearAllTimers();
  });
});

describe("bounded entropy continuations", () => {
  it.each([ABI_SYSCALLS.Getpid, ABI_SYSCALLS.Read, ABI_SYSCALLS.Write])(
    "keeps ordinary syscall %i off the entropy and guest-address paths", syscallNr => {
      const h = makeTransferHarness(4);
      const lookup = vi.spyOn(h.worker.pendingEntropyReads, "get");
      const ordinary = vi.fn((pointer: number | bigint) => {
        const view = new DataView(h.kernelBytes.buffer, Number(pointer));
        view.setBigInt64(CH_RETURN, 0n, true);
        view.setUint32(CH_ERRNO, 0, true);
        return 0;
      });
      h.kernelExports.kernel_handle_channel = ordinary;
      writeSyscall(h.channel, syscallNr, [7n, 1024n, 32n]);
      h.worker.handleSyscall(h.channel);
      expect(ordinary).toHaveBeenCalledTimes(1);
      expect(h.kernelExports.kernel_handle_guest_io).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      expect(readChannelCompletion(h.channel).status).toBe(CHANNEL_STATUS_COMPLETE);
    },
  );

  it.each(["handleSyscall", "retrySyscall"])(
    "resumes the active entropy read through %s without reparsing a changed mailbox", ingress => {
      vi.useFakeTimers();
      const h = makeTransferHarness(4);
      setEntropyPending(h, 904n);
      const dispatch = h.kernelExports.kernel_handle_guest_io;
      const step = vi.fn(() => 65536);
      h.kernelExports.kernel_entropy_read_step = step;
      writeSyscall(h.channel, ABI_SYSCALLS.Read, [7n, 1024n, BigInt(LARGE_LENGTH)]);
      h.worker.handleSyscall(h.channel);
      writeSyscall(h.channel, ABI_SYSCALLS.Getpid, [99n, 0n, 0n]);
      h.worker[ingress](h.channel);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(step).toHaveBeenCalledWith(h.channel.pid, h.channel.pid, 904n, 0);
      expect(readChannelCompletion(h.channel)).toEqual({
        status: CHANNEL_STATUS_COMPLETE, retVal: 65536, errno: 0,
      });
      expect(h.worker.pendingEntropyReads.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([4, 8] as const)("publishes one syscall after bounded turns at width %i", async width => {
    vi.useFakeTimers();
    const h = makeTransferHarness(width);
    setEntropyPending(h, 901n);
    const step = vi.fn().mockReturnValueOnce(ENTROPY_READ_PENDING).mockReturnValueOnce(LARGE_LENGTH);
    h.kernelExports.kernel_entropy_read_step = step;
    writeSyscall(h.channel, ABI_SYSCALLS.Read, [7n, 1024n, BigInt(LARGE_LENGTH)]);
    h.worker.handleSyscall(h.channel);
    expect(step).not.toHaveBeenCalled();
    expect(readChannelCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
    expect(h.begin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(step).toHaveBeenCalledTimes(2);
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: LARGE_LENGTH, errno: 0 });
    expect(h.worker.pendingEntropyReads.size).toBe(0);
  });

  it("cancels a stale registration without writing its mailbox", async () => {
    vi.useFakeTimers();
    const h = makeTransferHarness(4);
    setEntropyPending(h, 902n);
    const step = vi.fn(() => ENTROPY_READ_PENDING), cancel = vi.fn(() => 0);
    h.kernelExports.kernel_entropy_read_step = step;
    h.kernelExports.kernel_entropy_read_cancel = cancel;
    writeSyscall(h.channel, ABI_SYSCALLS.Read, [7n, 1024n, BigInt(LARGE_LENGTH)]);
    h.worker.handleSyscall(h.channel);
    h.worker.processes.set(h.channel.pid, { ...h.worker.processes.get(h.channel.pid) });
    await vi.advanceTimersByTimeAsync(1);
    expect(step).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(h.channel.pid, h.channel.pid, 902n);
    expect(readChannelCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
    expect(h.worker.pendingEntropyReads.size).toBe(0);
  });

  it("returns the delivered prefix on cancellation between batches", async () => {
    vi.useFakeTimers();
    const h = makeTransferHarness(4);
    setEntropyPending(h, 903n);
    const step = vi.fn(() => 65536);
    h.kernelExports.kernel_entropy_read_step = step;
    writeSyscall(h.channel, ABI_SYSCALLS.Read, [7n, 1024n, BigInt(LARGE_LENGTH)]);
    new DataView(h.channel.memory.buffer).setUint32(CH_REQUEST_FLAGS,
      CHANNEL_REQUEST_FLAG_CANCELLATION_POINT | CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED, true);
    h.worker.handleSyscall(h.channel);
    h.worker.pendingCancels.add(h.channel);
    await vi.advanceTimersByTimeAsync(1);
    expect(step.mock.calls[0][3]).toBe(1);
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: 65536, errno: 0 });
    expect(h.worker.pendingCancels.has(h.channel)).toBe(false);
  });
});
function invokeWidenedSend(h: TransferHarness): void {
  h.processBytes.fill(0x5b, 1024, 1024 + LARGE_LENGTH);
  writeSyscall(h.channel, ABI_SYSCALLS.Send, [7n, 1024n, BigInt(LARGE_LENGTH), 0n]);
  h.worker.handleSyscall(h.channel);
}

describe("remaining widened-channel reservation failures", () => {
  it.each([4, 8] as const)("propagates admission failure without querying a token at width %i", width => {
    const h = makeTransferHarness(width);
    h.kernelExports.kernel_transfer_scratch_begin = vi.fn(() => -BigInt(ENOMEM));
    invokeWidenedSend(h);
    expect(h.pointer).not.toHaveBeenCalled();
    expect(h.capacity).not.toHaveBeenCalled();
    expect(h.channelExecute).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(readChannelCompletion(h.channel)).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: ENOMEM });
  });

  it.each([4, 8] as const)("settles invalid allocation descriptions before dispatch at width %i", width => {
    for (const kind of ["null", "short", "outside-memory"] as const) {
      const h = makeTransferHarness(width);
      if (kind === "null") h.kernelExports.kernel_transfer_scratch_pointer = () => kernelPointer(width, 0);
      if (kind === "short") h.kernelExports.kernel_transfer_scratch_capacity = () => kernelPointer(width, CH_TOTAL_SIZE - 1);
      if (kind === "outside-memory") h.kernelExports.kernel_transfer_scratch_pointer = () => kernelPointer(width, h.kernelBytes.length - 8);
      invokeWidenedSend(h);
      expect(h.channelExecute, kind).not.toHaveBeenCalled();
      expect(h.cancel, kind).toHaveBeenCalledExactlyOnceWith(101n);
      expect(readChannelCompletion(h.channel), kind).toEqual({ status: CHANNEL_STATUS_COMPLETE, retVal: -1, errno: EIO });
    }
  });

  it.each([4, 8] as const)("fail-stops execute traps without another cleanup export at width %i", async width => {
    const h = makeTransferHarness(width);
    const trap = new Error("widened channel execute trap");
    h.kernelExports.kernel_transfer_channel_execute = vi.fn(() => { throw trap; });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => invokeWidenedSend(h)).toThrow();
    await Promise.resolve();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.onKernelFatal).toHaveBeenCalledOnce();
    expect(h.worker.isKernelInitialized()).toBe(false);
    expect(readChannelCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
  });

  it.each([4, 8] as const)("fail-stops a refused cancellation before publication at width %i", async width => {
    const h = makeTransferHarness(width);
    const execute = vi.fn(() => {
      const view = new DataView(h.kernelBytes.buffer, h.transferOffset);
      view.setBigInt64(CH_RETURN, BigInt(LARGE_LENGTH), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    h.kernelExports.kernel_transfer_channel_execute = execute;
    h.kernelExports.kernel_transfer_scratch_cancel = vi.fn(() => -EINVAL);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => invokeWidenedSend(h)).toThrow(/could not be settled/);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();
    expect(h.onKernelFatal).toHaveBeenCalledOnce();
    expect(h.worker.isKernelInitialized()).toBe(false);
    expect(readChannelCompletion(h.channel).status).toBe(CHANNEL_STATUS_PENDING);
  });
});
