// host/test/multi-worker.test.ts
//
// Tests CentralizedKernelWorker process management and fork flow.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
  shouldDeliverPosixTimerSignal,
} from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import {
  computeProcessMemoryLayout,
  createProcessMemory as createLayoutMemory,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, WASM_PAGE_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
  HOST_INTERCEPTED_SYSCALLS,
  PROCESS_STATE_EXITED,
} from "../src/generated/abi";

const MAX_PAGES = 1024; // 64 MiB: enough to prove initial < maximum.

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(resolveBinary("kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createProcessMemory(): {
  memory: WebAssembly.Memory;
  channelOffset: number;
  layout: ProcessMemoryLayout;
} {
  const layout = computeProcessMemoryLayout({
    ptrWidth: 4,
    heapBase: 0x00120000,
    minPages: 18,
    maxPages: MAX_PAGES,
  });
  const memory = createLayoutMemory(4, layout);
  const channelOffset = layout.channelOffset;
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
  return { memory, channelOffset, layout };
}

function attachProcess(
  kw: CentralizedKernelWorker,
  pid: number,
  entry: ReturnType<typeof createProcessMemory>,
): void {
  kw.registerProcess(pid, entry.memory, [entry.channelOffset], {
    brkBase: entry.layout.brkBase,
    mmapBase: entry.layout.mmapBase,
    maxAddr: entry.layout.maxAddr,
  });
}

function issueThreadAttachment(
  worker: CentralizedKernelWorker,
  pid: number,
  tid: number,
) {
  const channel = (worker as any).processes.get(pid)?.channels[0];
  if (!channel) throw new Error(`No main channel for process ${pid}`);
  const kernelMemory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const kernelView = new DataView(kernelMemory.buffer);
  let attachment: Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0]
    | undefined;
  new DataView(channel.memory.buffer, channel.channelOffset)
    .setUint32(CH_DATA, 0, true);
  new DataView(channel.memory.buffer, channel.channelOffset)
    .setUint32(CH_DATA + 4, 0, true);
  (worker as any).callbacks = {
    onClone: (
      value: Parameters<CentralizedKernelWorker["attachThreadChannel"]>[0],
    ) => {
      attachment = value;
      return new Promise<void>(() => {});
    },
  };
  (worker as any).kernel ??= {
    toKernelPtr: (value: number | bigint) => Number(value),
  };
  (worker as any).kernelMemory = kernelMemory;
  (worker as any).scratchOffset = 0;
  (worker as any).currentHandlePid = 0;
  (worker as any).threadCtidPtrs ??= new Map();
  (worker as any).bindKernelTidForChannel = vi.fn();
  (worker as any).kernelInstance.exports.kernel_handle_channel = vi.fn(() => {
    kernelView.setBigInt64(CH_RETURN, BigInt(tid), true);
    kernelView.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
  (worker as any).handleClone(channel, [0, 0, 0, 0, 0, 0]);
  if (!attachment) throw new Error("clone callback did not receive attachment");
  return attachment;
}

function createAndRegisterProcess(
  kw: CentralizedKernelWorker,
  entry: ReturnType<typeof createProcessMemory>,
): number {
  const pid = kw.createProcess(CAPTURED_STDIO);
  attachProcess(kw, pid, entry);
  return pid;
}

describe("CentralizedKernelWorker Process Management", () => {
  it("does not deliver SIGEV_NONE as a signal-zero wakeup", () => {
    expect(shouldDeliverPosixTimerSignal(0)).toBe(false);
    expect(shouldDeliverPosixTimerSignal(14)).toBe(true);
    expect(shouldDeliverPosixTimerSignal(65)).toBe(false);
  });

  it("uses the kernel-assigned fork PID without host-side retries", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const kernelForkProcess = vi.fn(() => 101);
    const completeChannel = vi.fn();
    const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onFork },
      processes: new Map([[parentPid, { channels: [channel] }]]),
      channelTids: new Map(),
      threadForkContexts: new Map(),
      sharedMappings: new Map(),
      tcpListenerTargets: new Map(),
      epollInterests: new Map(),
      completeChannel,
      kernelInstance: {
        exports: {
          kernel_fork_process: kernelForkProcess,
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_get_process_exit_signal: vi.fn(() => -1),
        },
      },
    }) as CentralizedKernelWorker;

    (kw as any).handleFork(channel, [0]);
    await Promise.resolve();

    expect(kernelForkProcess).toHaveBeenCalledOnce();
    expect(kernelForkProcess).toHaveBeenCalledWith(parentPid, parentPid);
    expect(onFork).toHaveBeenCalledWith(parentPid, 101, memory, undefined);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
      undefined,
      101,
      0,
    );
  });

  it("inherits child fd mirrors when the parent channel becomes stale during fork", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const oldChannel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const replacementChannel = {
      pid: parentPid,
      channelOffset: 2 * WASM_PAGE_SIZE,
      memory,
    };
    const completeChannel = vi.fn();
    let finishFork!: (offsets: number[]) => void;
    const forkLaunch = new Promise<number[]>((resolve) => {
      finishFork = resolve;
    });
    const close = vi.fn();
    const listener = {
      server: { close },
      pid: parentPid,
      port: 8080,
      connections: new Set(),
    };
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onFork: vi.fn(() => forkLaunch) },
      processes: new Map([[parentPid, { channels: [oldChannel] }]]),
      channelTids: new Map(),
      threadForkContexts: new Map(),
      sharedMappings: new Map(),
      tcpListenerTargets: new Map([[8080, [{ pid: parentPid, fd: 4 }]]]),
      tcpListenerRRIndex: new Map([[8080, 0]]),
      tcpVirtualListenerKeys: new Map(),
      tcpListeners: new Map([[`${parentPid}:4`, listener]]),
      tcpConnections: new Map(),
      shmMappings: new Map(),
      io: { network: undefined },
      epollInterests: new Map([[`${parentPid}:6`, [
        { fd: 8, events: 1, data: 11n },
      ]]]),
      completeChannel,
      kernelInstance: {
        exports: {
          kernel_fork_process: vi.fn(() => 100),
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_get_process_exit_signal: vi.fn(() => -1),
        },
      },
    }) as CentralizedKernelWorker;

    (kw as any).handleFork(oldChannel, [0]);
    (kw as any).processes.set(parentPid, { channels: [replacementChannel] });
    expect((kw as any).tcpListenerTargets.get(8080)).toContainEqual({ pid: 100, fd: 4 });
    (kw as any).cleanupTcpListeners(parentPid);
    expect(close).not.toHaveBeenCalled();
    expect((kw as any).tcpListeners.has("100:4")).toBe(true);
    finishFork([WASM_PAGE_SIZE]);
    await Promise.resolve();

    expect((kw as any).tcpListenerTargets.get(8080)).toEqual([{ pid: 100, fd: 4 }]);
    expect((kw as any).epollInterests.get("100:6")).toEqual([
      { fd: 8, events: 1, data: 11n },
    ]);
    expect(completeChannel).not.toHaveBeenCalled();
  });

  it("removes eager child registrations and mirrors when fork worker launch fails", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const completeChannel = vi.fn();
    const deactivateProcess = vi.fn();
    const removeProcess = vi.fn(() => 0);
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onFork: vi.fn(() => Promise.reject(new Error("launch failed"))) },
      processes: new Map([[parentPid, { channels: [channel] }]]),
      channelTids: new Map(),
      threadForkContexts: new Map(),
      tcpListenerTargets: new Map([[8080, [{ pid: parentPid, fd: 4 }]]]),
      epollInterests: new Map(),
      completeChannel,
      deactivateProcess,
      kernelInstance: {
        exports: {
          kernel_fork_process: vi.fn(() => 100),
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_remove_process: removeProcess,
          kernel_get_process_exit_signal: vi.fn(() => -1),
        },
      },
    }) as CentralizedKernelWorker;

    (kw as any).handleFork(channel, [0]);
    await Promise.resolve();
    await Promise.resolve();

    expect(deactivateProcess).toHaveBeenCalledWith(100);
    expect(removeProcess).toHaveBeenCalledWith(100);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
      undefined,
      -1,
      12,
    );
  });

  it("terminates the parent when a failed fork launch cannot remove the child", async () => {
    const parentPid = 77;
    const childPid = 100;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const completeChannel = vi.fn();
    const deactivateProcess = vi.fn();
    const removeProcess = vi.fn(() => -5);
    const notifyHostProcessCrashed = vi.fn();
    const onExit = vi.fn();
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: {
        onFork: vi.fn(() => Promise.reject(new Error("launch failed"))),
        onExit,
      },
      processes: new Map([[parentPid, { channels: [channel] }]]),
      channelTids: new Map(),
      threadForkContexts: new Map(),
      tcpListenerTargets: new Map([[8080, [{ pid: parentPid, fd: 4 }]]]),
      epollInterests: new Map(),
      completeChannel,
      deactivateProcess,
      notifyHostProcessCrashed,
      kernelInstance: {
        exports: {
          kernel_fork_process: vi.fn(() => childPid),
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_remove_process: removeProcess,
          kernel_get_process_exit_signal: vi.fn(() => -1),
        },
      },
    }) as CentralizedKernelWorker;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      (kw as any).handleFork(channel, [0]);
      await Promise.resolve();
      await Promise.resolve();

      expect(deactivateProcess).toHaveBeenCalledWith(childPid);
      expect(removeProcess).toHaveBeenCalledWith(childPid);
      expect(notifyHostProcessCrashed).toHaveBeenCalledWith(parentPid, 11);
      expect(onExit).toHaveBeenCalledWith(parentPid, 139);
      expect(channel.handling).toBe(true);
      expect(completeChannel).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "[handleSyscall] FATAL could not roll back fork child 100: " +
          "Kernel could not remove process 100: errno 5",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("completes pthread SYS_EXIT channels (clearing the exiting guest's atomic-wait waiter) even when the host terminates the worker", () => {
    // Regression guard for the reused-slot notify-steal deadlock. On thread
    // exit the kernel must flip the channel status word off CH_PENDING
    // (completeChannelRaw) so the exiting guest's in-wasm memory.atomic.wait32
    // returns and its waiter is removed *before* the thread slot / channel
    // offset is freed and reused by a later clone(). This holds even in the
    // browser case where onThreadExit reports the host will terminate the
    // backing Worker: an earlier revision abandoned the channel here (leaving
    // status=PENDING with the guest still parked), and once #830 made worker
    // teardown immediate, that stale waiter could outlive the slot and steal a
    // reused thread's memory.atomic.notify(count=1), so the kernel's
    // Atomics.waitAsync never fired and the new thread wedged forever.
    const pid = 123;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const tid = 77;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const channel = {
      pid,
      channelOffset: threadChannelOffset,
      memory,
      handling: true,
    };
    const onThreadExit = vi.fn(() => true);
    const completeChannelRaw = vi.fn((ch: typeof channel) => {
      ch.handling = false;
    });

    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onThreadExit },
      processes: new Map([
        [pid, { channels: [{ channelOffset: mainChannelOffset }] }],
      ]),
      channelTids: new Map([[`${pid}:${threadChannelOffset}`, tid]]),
      threadForkContexts: new Map([
        [`${pid}:${threadChannelOffset}`, { fnPtr: 1, argPtr: 2 }],
      ]),
      threadCtidPtrs: new Map(),
      activeChannels: [channel],
      notifyThreadExit: vi.fn(),
      removeChannel: vi.fn(),
      completeChannelRaw,
    });

    (kw as any).handleExit(channel, ABI_SYSCALLS.Exit, [0]);

    // Still asks the host to tear down the backing thread Worker...
    expect(onThreadExit).toHaveBeenCalledWith(pid, tid, threadChannelOffset);
    // ...but now completes the channel so the guest's wait waiter is cleared.
    expect(completeChannelRaw).toHaveBeenCalledWith(channel, 0, 0);
    expect(channel.handling).toBe(false);
  });

  it("keeps completing pthread SYS_EXIT channels when no host terminator is installed", () => {
    const pid = 124;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const tid = 78;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const channel = {
      pid,
      channelOffset: threadChannelOffset,
      memory,
      handling: true,
    };
    const completeChannelRaw = vi.fn((ch: typeof channel) => {
      ch.handling = false;
    });

    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: {},
      processes: new Map([
        [pid, { channels: [{ channelOffset: mainChannelOffset }] }],
      ]),
      channelTids: new Map([[`${pid}:${threadChannelOffset}`, tid]]),
      threadForkContexts: new Map(),
      threadCtidPtrs: new Map(),
      activeChannels: [channel],
      notifyThreadExit: vi.fn(),
      removeChannel: vi.fn(),
      completeChannelRaw,
      abandonChannel: vi.fn(),
    });

    (kw as any).handleExit(channel, ABI_SYSCALLS.Exit, [0]);

    expect(completeChannelRaw).toHaveBeenCalledWith(channel, 0, 0);
    expect((kw as any).abandonChannel).not.toHaveBeenCalled();
    expect(channel.handling).toBe(false);
  });

  it("rejects pthread exit when the channel lost its kernel-allocated TID", () => {
    const pid = 124;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const mainChannel = {
      pid,
      channelOffset: WASM_PAGE_SIZE,
      memory,
    };
    const threadChannel = {
      pid,
      channelOffset: 2 * WASM_PAGE_SIZE,
      memory,
    };
    const finalizeThreadExit = vi.fn();
    const completeChannelRaw = vi.fn();
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      processes: new Map([
        [pid, { channels: [mainChannel, threadChannel], memory }],
      ]),
      channelTids: new Map(),
      finalizeThreadExit,
      completeChannelRaw,
      callbacks: { onThreadExit: vi.fn() },
    }) as CentralizedKernelWorker;
    const expected =
      `No kernel-validated TID for non-main channel ${threadChannel.channelOffset} ` +
      `of process ${pid}`;

    expect(() => (kw as any).handleExit(
      threadChannel,
      ABI_SYSCALLS.Exit,
      [0],
    )).toThrow(expected);
    expect(finalizeThreadExit).not.toHaveBeenCalled();
    expect(completeChannelRaw).not.toHaveBeenCalled();
  });

  it("clears pthread child TID when forced thread cleanup skips guest SYS_EXIT", () => {
    const pid = 125;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const threadChannelOffset = 2 * WASM_PAGE_SIZE;
    const tid = 79;
    const ctidPtr = 0x00040000;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const channel = {
      pid,
      channelOffset: threadChannelOffset,
      memory,
      i32View: new Int32Array(memory.buffer, threadChannelOffset),
      consecutiveSyscalls: 0,
    };
    new DataView(memory.buffer).setInt32(ctidPtr, tid, true);

    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      processes: new Map([
        [pid, { memory, channels: [{ channelOffset: mainChannelOffset }, channel] }],
      ]),
      activeChannels: [channel],
      pendingSleeps: new Map(),
      channelTids: new Map([[`${pid}:${threadChannelOffset}`, tid]]),
      threadForkContexts: new Map([
        [`${pid}:${threadChannelOffset}`, { fnPtr: 1, argPtr: 2 }],
      ]),
      threadCtidPtrs: new Map([[`${pid}:${tid}`, ctidPtr]]),
      pendingSignalWaits: new Map(),
      signalWaitDeadlines: new Map(),
      notifyThreadExit: vi.fn(),
    }) as CentralizedKernelWorker;

    kw.finalizeThreadExit(pid, tid, threadChannelOffset);

    expect(new DataView(memory.buffer).getInt32(ctidPtr, true)).toBe(0);
    expect((kw as any).threadCtidPtrs.has(`${pid}:${tid}`)).toBe(false);
    expect((kw as any).channelTids.has(`${pid}:${threadChannelOffset}`)).toBe(false);
    expect((kw as any).threadForkContexts.has(`${pid}:${threadChannelOffset}`)).toBe(false);
    expect((kw as any).activeChannels).toEqual([]);
    expect((kw as any).notifyThreadExit).toHaveBeenCalledWith(pid, tid);
  });

  it("registers pthread clear-TID before the host clone callback can complete", async () => {
    const pid = 126;
    const mainChannelOffset = WASM_PAGE_SIZE;
    const tid = 79;
    const stackPtr = 0x00800000;
    const tlsPtr = 0x00900000;
    const ctidPtr = 0x00040000;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const processView = new DataView(memory.buffer, mainChannelOffset);
    processView.setUint32(CH_DATA, 11, true);
    processView.setUint32(CH_DATA + 4, 22, true);

    const kernelMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
    });
    const kernelView = new DataView(kernelMemory.buffer);
    const threadCtidPtrs = new Map<string, number>();
    let resolveClone!: () => void;
    let kw!: CentralizedKernelWorker;
    const onClone = vi.fn((attachment) => {
      expect(threadCtidPtrs.get(`${pid}:${tid}`)).toBe(ctidPtr);
      kw.attachThreadChannel(attachment, 2 * WASM_PAGE_SIZE);
      return new Promise<void>((resolve) => {
        resolveClone = resolve;
      });
    });
    const channel = { pid, channelOffset: mainChannelOffset, memory };

    kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onClone },
      kernel: {
        toKernelPtr(value: number | bigint): number {
          return Number(value);
        },
      },
      kernelMemory,
      scratchOffset: 0,
      currentHandlePid: 0,
      activeChannels: [channel],
      channelTids: new Map<string, number>(),
      execHandoffPids: new Set<number>(),
      hostReaped: new Set<number>(),
      processes: new Map([
        [pid, { channels: [channel], memory, explicitMaxAddr: true }],
      ]),
      threadCtidPtrs,
      threadForkContexts: new Map<string, { fnPtr: number; argPtr: number }>(),
      usePolling: true,
      completeChannel: vi.fn(),
      bindKernelTidForChannel: vi.fn(),
      kernelInstance: {
        exports: {
          kernel_get_process_exit_signal: vi.fn(() => -1),
          kernel_validate_task: vi.fn(() => 0),
          kernel_handle_channel: vi.fn(() => {
            kernelView.setBigInt64(CH_RETURN, BigInt(tid), true);
            kernelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          }),
        },
      },
    });

    (kw as any).handleClone(
      channel,
      [0x00200000, stackPtr, 0, tlsPtr, ctidPtr, 0],
    );

    expect(onClone).toHaveBeenCalledTimes(1);
    expect(threadCtidPtrs.get(`${pid}:${tid}`)).toBe(ctidPtr);
    resolveClone();
    await Promise.resolve();
    expect((kw as any).completeChannel).toHaveBeenCalled();
  });

  it("does not erase replacement clear-TID metadata from a stale clone completion", async () => {
    const pid = 126;
    const tid = 79;
    const oldMemory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const newMemory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const channelOffset = WASM_PAGE_SIZE;
    const oldChannel = { pid, channelOffset, memory: oldMemory };
    const newChannel = { pid, channelOffset, memory: newMemory };
    const processView = new DataView(oldMemory.buffer, channelOffset);
    processView.setUint32(CH_DATA, 11, true);
    processView.setUint32(CH_DATA + 4, 22, true);
    const kernelMemory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const kernelView = new DataView(kernelMemory.buffer);
    const threadCtidPtrs = new Map<string, number>();
    let resolveClone!: () => void;
    const onClone = vi.fn(() => new Promise<void>((resolve) => {
      resolveClone = resolve;
    }));
    const completeChannel = vi.fn();
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onClone },
      kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
      kernelMemory,
      scratchOffset: 0,
      currentHandlePid: 0,
      processes: new Map([[pid, { channels: [oldChannel] }]]),
      threadCtidPtrs,
      completeChannel,
      bindKernelTidForChannel: vi.fn(),
      kernelInstance: {
        exports: {
          kernel_handle_channel: vi.fn(() => {
            kernelView.setBigInt64(CH_RETURN, BigInt(tid), true);
            kernelView.setUint32(CH_ERRNO, 0, true);
            return 0;
          }),
        },
      },
    });

    (kw as any).handleClone(
      oldChannel,
      [0, 0x00800000, 0, 0x00900000, 0x00040000, 0],
    );
    (kw as any).processes.set(pid, { channels: [newChannel] });
    threadCtidPtrs.set(`${pid}:${tid}`, 0x00050000);
    resolveClone();
    await Promise.resolve();

    expect(threadCtidPtrs.get(`${pid}:${tid}`)).toBe(0x00050000);
    expect(completeChannel).not.toHaveBeenCalled();
  });

  it("does not lower compact process max_addr when adding dynamic pthread channels", () => {
    const setMaxAddr = vi.fn(() => 0);
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      initialized: true,
      hostReaped: new Set(),
      processes: new Map(),
      activeChannels: [],
      channelTids: new Map(),
      threadForkContexts: new Map(),
      usePolling: true,
      kernel: {
        toKernelPtr(value: number | bigint): number {
          return Number(value);
        },
      },
      kernelInstance: {
        exports: {
          kernel_get_process_state: vi.fn(() => 0),
          kernel_set_brk_base: vi.fn(() => 0),
          kernel_set_mmap_base: vi.fn(() => 0),
          kernel_set_max_addr: setMaxAddr,
          kernel_validate_task: vi.fn(() => 0),
        },
      },
    }) as CentralizedKernelWorker;
    const highThreadChannelOffset = 0x04000000 + 2 * WASM_PAGE_SIZE;
    const memory = new WebAssembly.Memory({
      initial: highThreadChannelOffset / WASM_PAGE_SIZE + 1,
      maximum: DEFAULT_MAX_PAGES,
      shared: true,
    });
    const maxAddr = 0x20000000;

    kw.registerProcess(321, memory, [4 * WASM_PAGE_SIZE], {
      brkBase: 4 * WASM_PAGE_SIZE,
      mmapBase: 4 * WASM_PAGE_SIZE,
      maxAddr,
    });
    kw.attachThreadChannel(
      issueThreadAttachment(kw, 321, 7),
      highThreadChannelOffset,
    );

    expect(setMaxAddr).toHaveBeenCalledTimes(1);
    expect(setMaxAddr).toHaveBeenCalledWith(321, maxAddr);
  });

  it("rejects attaching host state to an unknown kernel process", () => {
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      initialized: true,
      hostReaped: new Set(),
      processes: new Map(),
      activeChannels: [],
      usePolling: true,
      kernelInstance: {
        exports: {
          kernel_get_process_state: vi.fn(() => -3),
        },
      },
    }) as CentralizedKernelWorker;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });

    expect(() => kw.registerProcess(900, memory, [4 * WASM_PAGE_SIZE])).toThrow(
      "Cannot register unknown kernel process 900",
    );
  });

  it("rejects attaching host state to an exited kernel process", () => {
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      initialized: true,
      hostReaped: new Set(),
      processes: new Map(),
      activeChannels: [],
      usePolling: true,
      kernelInstance: {
        exports: {
          kernel_get_process_state: vi.fn(() => PROCESS_STATE_EXITED),
        },
      },
    }) as CentralizedKernelWorker;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });

    expect(() => kw.registerProcess(900, memory, [4 * WASM_PAGE_SIZE])).toThrow(
      "Cannot register inactive kernel process 900",
    );
  });

  it("rejects attaching a host Worker to the kernel-reserved init PID", () => {
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      initialized: true,
      hostReaped: new Set(),
      processes: new Map(),
      activeChannels: [],
      usePolling: true,
      kernelInstance: {
        exports: {
          kernel_get_process_state: vi.fn(() => 0),
        },
      },
    }) as CentralizedKernelWorker;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });

    expect(() => kw.registerProcess(1, memory, [4 * WASM_PAGE_SIZE])).toThrow(
      "Cannot register the kernel-reserved init process",
    );
  });

  it("rejects a thread channel whose TID is not owned by the kernel process", () => {
    const pid = 321;
    const mainChannelOffset = 4 * WASM_PAGE_SIZE;
    const threadChannelOffset = 8 * WASM_PAGE_SIZE;
    const validateTask = vi.fn(() => -3);
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const mainChannel = {
      pid,
      memory,
      channelOffset: mainChannelOffset,
      i32View: new Int32Array(memory.buffer, mainChannelOffset),
      consecutiveSyscalls: 0,
    };
    const channels = [mainChannel];
    const activeChannels = [mainChannel];
    const channelTids = new Map<string, number>();
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      initialized: true,
      hostReaped: new Set(),
      execHandoffPids: new Set(),
      processes: new Map([[pid, { pid, memory, channels }]]),
      activeChannels,
      channelTids,
      threadForkContexts: new Map(),
      usePolling: true,
      kernelInstance: {
        exports: {
          kernel_validate_task: validateTask,
        },
      },
    }) as CentralizedKernelWorker;

    expect(() => kw.attachThreadChannel(
      issueThreadAttachment(kw, pid, 999),
      threadChannelOffset,
    )).toThrow(
      "Kernel rejected tid 999 for process 321: errno 3",
    );
    expect(validateTask).toHaveBeenCalledWith(pid, 999);
    expect(channels).toHaveLength(1);
    expect(activeChannels).toHaveLength(1);
    expect(channelTids.size).toBe(0);
  });

  it("rejects non-canonical or leader identities before attaching a thread channel", () => {
    const pid = 321;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });
    const mainChannel = {
      pid,
      memory,
      channelOffset: 4 * WASM_PAGE_SIZE,
      i32View: new Int32Array(memory.buffer, 4 * WASM_PAGE_SIZE),
      consecutiveSyscalls: 0,
    };
    const validateTask = vi.fn(() => 0);
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      initialized: true,
      hostReaped: new Set(),
      execHandoffPids: new Set(),
      processes: new Map([[pid, { pid, memory, channels: [mainChannel] }]]),
      activeChannels: [mainChannel],
      channelTids: new Map(),
      threadForkContexts: new Map(),
      usePolling: true,
      kernelInstance: {
        exports: { kernel_validate_task: validateTask },
      },
    }) as CentralizedKernelWorker;

    for (const tid of [pid, 0x8000_0000, 0x1_0000_0001]) {
      expect(() => kw.attachThreadChannel(
        issueThreadAttachment(kw, pid, tid),
        8 * WASM_PAGE_SIZE,
      )).toThrow(
        "requires a positive, non-leader kernel TID",
      );
    }
    expect(validateTask).not.toHaveBeenCalled();
    expect((kw as any).activeChannels).toEqual([mainChannel]);
    expect((kw as any).channelTids.size).toBe(0);
  });

  it("should register and unregister processes", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const proc1 = createProcessMemory();
    const proc2 = createProcessMemory();
    expect(proc1.memory.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);
    expect(proc2.memory.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);

    const firstPid = createAndRegisterProcess(kw, proc1);
    const secondPid = createAndRegisterProcess(kw, proc2);
    expect(firstPid).not.toBe(secondPid);

    // Process teardown must retire every image-owned thread transport record,
    // including metadata for workers that did not reach their own SYS_EXIT.
    (kw as any).channelTids.set(`${firstPid}:1000`, 1001);
    (kw as any).threadForkContexts.set(`${firstPid}:1000`, { fnPtr: 1, argPtr: 2 });
    (kw as any).threadCtidPtrs.set(`${firstPid}:1001`, 2000);
    (kw as any).channelTids.set(`${secondPid}:3000`, 3001);
    (kw as any).threadForkContexts.set(`${secondPid}:3000`, { fnPtr: 3, argPtr: 4 });
    (kw as any).threadCtidPtrs.set(`${secondPid}:3001`, 4000);

    // Unregister both without error
    kw.unregisterProcess(firstPid);
    expect(Array.from((kw as any).channelTids.keys())).toEqual([`${secondPid}:3000`]);
    expect(Array.from((kw as any).threadForkContexts.keys())).toEqual([`${secondPid}:3000`]);
    expect(Array.from((kw as any).threadCtidPtrs.keys())).toEqual([`${secondPid}:3001`]);
    kw.unregisterProcess(secondPid);
    expect((kw as any).processes.has(firstPid)).toBe(false);
    expect((kw as any).processes.has(secondPid)).toBe(false);
    expect(
      (kw as any).activeChannels.some(
        (ch: any) => ch.pid === firstPid || ch.pid === secondPid,
      ),
    ).toBe(false);
    expect((kw as any).channelTids.size).toBe(0);
    expect((kw as any).threadForkContexts.size).toBe(0);
    expect((kw as any).threadCtidPtrs.size).toBe(0);

    // Unregistering non-existent pid should not throw
    kw.unregisterProcess(999);
  });

  it("closes live host file handles when unregistering a process", async () => {
    const io = new NodePlatformIO();
    const open = vi.spyOn(io, "open");
    const close = vi.spyOn(io, "close");
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io,
    );
    await kw.init(loadKernelWasm());

    const procMemory = createProcessMemory();
    const pid = createAndRegisterProcess(kw, procMemory);

    // Issue open(2) directly through the real kernel export so the Rust
    // Process owns the exact host handle that unregisterProcess must release.
    const kernelMemory = (kw as any).kernelMemory as WebAssembly.Memory;
    const scratchOffset = (kw as any).scratchOffset as number;
    const pathPtr = scratchOffset + CH_DATA;
    const path = new TextEncoder().encode(
      `${join(process.cwd(), "../Cargo.toml")}\0`,
    );
    new Uint8Array(kernelMemory.buffer).set(path, pathPtr);
    const channel = new DataView(kernelMemory.buffer, scratchOffset);
    channel.setUint32(CH_SYSCALL, ABI_SYSCALLS.Open, true);
    for (let i = 0; i < 6; i++) {
      channel.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }
    channel.setBigInt64(CH_ARGS, BigInt(pathPtr), true);
    const handleChannel = (kw as any).kernelInstance.exports
      .kernel_handle_channel as (offset: number, pid: number) => number;
    const setCurrentTid = (kw as any).kernelInstance.exports
      .kernel_set_current_tid as (pid: number, tid: number) => number;
    expect(setCurrentTid(pid, pid)).toBe(0);
    handleChannel(kw.toKernelPtr(scratchOffset) as number, pid);

    expect(channel.getUint32(CH_ERRNO, true)).toBe(0);
    expect(Number(channel.getBigInt64(CH_RETURN, true))).toBeGreaterThanOrEqual(
      3,
    );
    expect(open).toHaveBeenCalledOnce();
    const hostHandle = open.mock.results[0].value;
    expect(close).not.toHaveBeenCalledWith(hostHandle);

    kw.unregisterProcess(pid);

    expect(close).toHaveBeenCalledWith(hostHandle);
  });

  it("releases a retained mmap handle before forced descriptor teardown", async () => {
    const io = new NodePlatformIO();
    const open = vi.spyOn(io, "open");
    const close = vi.spyOn(io, "close");
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io,
    );
    await kw.init(loadKernelWasm());

    const procMemory = createProcessMemory();
    const pid = createAndRegisterProcess(kw, procMemory);
    const kernelMemory = (kw as any).kernelMemory as WebAssembly.Memory;
    const scratchOffset = (kw as any).scratchOffset as number;
    const pathPtr = scratchOffset + CH_DATA;
    const path = new TextEncoder().encode(
      `${join(process.cwd(), "../Cargo.toml")}\0`,
    );
    new Uint8Array(kernelMemory.buffer).set(path, pathPtr);
    const channel = new DataView(kernelMemory.buffer, scratchOffset);
    channel.setUint32(CH_SYSCALL, ABI_SYSCALLS.Open, true);
    for (let i = 0; i < 6; i++) {
      channel.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }
    channel.setBigInt64(CH_ARGS, BigInt(pathPtr), true);
    const handleChannel = (kw as any).kernelInstance.exports
      .kernel_handle_channel as (offset: number, pid: number) => number;
    const setCurrentTid = (kw as any).kernelInstance.exports
      .kernel_set_current_tid as (pid: number, tid: number) => number;
    expect(setCurrentTid(pid, pid)).toBe(0);
    handleChannel(kw.toKernelPtr(scratchOffset) as number, pid);
    const guestFd = Number(channel.getBigInt64(CH_RETURN, true));
    expect(channel.getUint32(CH_ERRNO, true)).toBe(0);
    expect(guestFd).toBeGreaterThanOrEqual(3);
    const hostHandle = open.mock.results[0].value;
    const stat = io.fstat(hostHandle);
    const backingKey = io.fileHandleIdentity(
      hostHandle,
      BigInt(stat.dev),
      BigInt(stat.ino),
    )!;

    const retainedKernel = (kw as any).kernel;
    retainedKernel.retainHostFileHandle(hostHandle);
    const release = vi.spyOn(retainedKernel, "releaseHostFileHandle");
    (kw as any).sharedMmapBackings.set(backingKey, {
      key: backingKey,
      handle: hostHandle,
      writable: false,
      size: stat.size,
      sizeValid: true,
      pages: new Map(),
      dirtyPages: new Set(),
      refCount: 1,
      version: 0,
    });
    (kw as any).sharedMappings.set(pid, new Map([[0x1000, {
      fd: guestFd,
      fileOffset: 0,
      len: 4096,
      writable: false,
      writeAllowed: false,
      backingKind: "file",
      backingKey,
      snapshot: new Uint8Array(4096),
      seenVersion: 0,
    }]]));

    kw.unregisterProcess(pid);

    expect(release).toHaveBeenCalledWith(hostHandle);
    expect(close).toHaveBeenCalledWith(hostHandle);
    const hostCloseCall = close.mock.calls.findIndex(([handle]) => handle === hostHandle);
    expect(hostCloseCall).toBeGreaterThanOrEqual(0);
    expect(release.mock.invocationCallOrder[0]!).toBeLessThan(
      close.mock.invocationCallOrder[hostCloseCall]!,
    );
    expect((kw as any).sharedMappings.has(pid)).toBe(false);
    expect((kw as any).sharedMmapBackings.has(backingKey)).toBe(false);
    expect((retainedKernel as any).retainedHostFileHandles.size).toBe(0);
    expect(open).toHaveBeenCalledOnce();
  });

  it("repeated compact-layout launches do not leave process registrations behind", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const pids: number[] = [];
    for (let launch = 0; launch < 40; launch++) {
      const proc = createProcessMemory();
      expect(proc.memory.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);
      const pid = createAndRegisterProcess(kw, proc);
      pids.push(pid);
      kw.unregisterProcess(pid);
    }

    expect((kw as any).activeChannels.length).toBe(0);
    for (const pid of pids) {
      expect((kw as any).processes.has(pid)).toBe(false);
    }
  });

  it("keeps process allocation monotonic after host unregister", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const firstPid = createAndRegisterProcess(kw, createProcessMemory());
    kw.unregisterProcess(firstPid);
    const secondPid = createAndRegisterProcess(kw, createProcessMemory());
    expect(secondPid).toBeGreaterThan(firstPid);
    kw.unregisterProcess(secondPid);
  });

  it("should throw when registering duplicate PID", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const proc1 = createProcessMemory();
    const proc2 = createProcessMemory();

    const pid = createAndRegisterProcess(kw, proc1);
    expect(() => attachProcess(kw, pid, proc2)).toThrow(
      `Process ${pid} is already registered with the host`,
    );

    kw.unregisterProcess(pid);
  });

  it("should throw when registering before init", () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    const proc = createProcessMemory();
    expect(() => attachProcess(kw, 100, proc)).toThrow(
      "Kernel not initialized",
    );
  });
});
