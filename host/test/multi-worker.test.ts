// host/test/multi-worker.test.ts
//
// Tests CentralizedKernelWorker process management: register/unregister,
// setNextChildPid, and fork flow.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
  shouldDeliverPosixTimerSignal,
} from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import { SharedLockTable } from "../src/shared-lock-table";
import {
  computeProcessMemoryLayout,
  createProcessMemory as createLayoutMemory,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, WASM_PAGE_SIZE } from "../src/constants";
import {
  ABI_SYSCALLS,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  HOST_INTERCEPTED_SYSCALLS,
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

function registerProcess(
  kw: CentralizedKernelWorker,
  pid: number,
  entry: ReturnType<typeof createProcessMemory>,
): void {
  kw.registerProcess(pid, entry.memory, [entry.channelOffset], {
    brkBase: entry.layout.brkBase,
    mmapBase: entry.layout.mmapBase,
    maxAddr: entry.layout.maxAddr,
    stdio: CAPTURED_STDIO,
  });
}

describe("CentralizedKernelWorker Process Management", () => {
  it("does not deliver SIGEV_NONE as a signal-zero wakeup", () => {
    expect(shouldDeliverPosixTimerSignal(0)).toBe(false);
    expect(shouldDeliverPosixTimerSignal(14)).toBe(true);
    expect(shouldDeliverPosixTimerSignal(65)).toBe(false);
  });

  it("releases host-backed advisory locks when deactivating an exited process", () => {
    const pid = 126;
    const peerPid = 127;
    const pathHash = SharedLockTable.hashPath("/tmp/locked.db");
    const lockTable = SharedLockTable.create();

    expect(lockTable.setLock(pathHash, pid, 1, 0n, 0n)).toBe(true);
    expect(lockTable.setLock(pathHash, peerPid, 1, 0n, 0n)).toBe(false);

    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      activeChannels: [{ pid }, { pid: peerPid }],
      processes: new Map([[pid, {}], [peerPid, {}]]),
      stdinFinite: new Set([pid]),
      stdinBuffers: new Map([[pid, new Uint8Array()]]),
      alarmTimers: new Map(),
      posixTimers: new Map(),
      pendingSleeps: new Map(),
      lockTable,
      cleanupPendingPollRetries: vi.fn(),
      cleanupPendingSelectRetries: vi.fn(),
      cleanupUdpBindings: vi.fn(),
      cleanupTcpListeners: vi.fn(),
      hostReaped: new Set([pid]),
    }) as CentralizedKernelWorker;

    kw.deactivateProcess(pid);

    expect(lockTable.setLock(pathHash, peerPid, 1, 0n, 0n)).toBe(true);
    expect((kw as any).processes.has(pid)).toBe(false);
    expect((kw as any).activeChannels).toEqual([{ pid: peerPid }]);
    expect((kw as any).hostReaped.has(pid)).toBe(false);
  });

  it("retries fork allocation when the kernel still owns a zombie pid", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const kernelForkProcess = vi.fn((_parent: number, child: number) =>
      child === 100 ? -17 : 0,
    );
    const completeChannel = vi.fn();
    const onFork = vi.fn(() => Promise.resolve([WASM_PAGE_SIZE]));
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onFork },
      nextChildPid: 100,
      processes: new Map([[parentPid, { channels: [channel] }]]),
      threadForkContexts: new Map(),
      sharedMappings: new Map(),
      tcpListenerTargets: new Map(),
      epollInterests: new Map(),
      completeChannel,
      kernelInstance: {
        exports: {
          kernel_fork_process: kernelForkProcess,
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_reset_signal_mask: vi.fn(() => 0),
        },
      },
    }) as CentralizedKernelWorker;

    (kw as any).handleFork(channel, [0]);
    await Promise.resolve();

    expect(kernelForkProcess).toHaveBeenNthCalledWith(1, parentPid, 100);
    expect(kernelForkProcess).toHaveBeenNthCalledWith(2, parentPid, 101);
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
      nextChildPid: 100,
      processes: new Map([[parentPid, { channels: [replacementChannel] }]]),
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
          kernel_fork_process: vi.fn(() => 0),
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_reset_signal_mask: vi.fn(() => 0),
        },
      },
    }) as CentralizedKernelWorker;

    (kw as any).handleFork(oldChannel, [0]);
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
      nextChildPid: 100,
      processes: new Map([[parentPid, { channels: [channel] }]]),
      threadForkContexts: new Map(),
      tcpListenerTargets: new Map([[8080, [{ pid: parentPid, fd: 4 }]]]),
      epollInterests: new Map(),
      completeChannel,
      deactivateProcess,
      kernelInstance: {
        exports: {
          kernel_fork_process: vi.fn(() => 0),
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_reset_signal_mask: vi.fn(() => 0),
          kernel_remove_process: removeProcess,
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
    let resolveClone!: (value: number) => void;
    const onClone = vi.fn(() => {
      expect(threadCtidPtrs.get(`${pid}:${tid}`)).toBe(ctidPtr);
      return new Promise<number>((resolve) => {
        resolveClone = resolve;
      });
    });
    const channel = { pid, channelOffset: mainChannelOffset, memory };

    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      callbacks: { onClone },
      kernel: {
        toKernelPtr(value: number | bigint): number {
          return Number(value);
        },
      },
      kernelMemory,
      scratchOffset: 0,
      currentHandlePid: 0,
      processes: new Map([
        [pid, { channels: [channel] }],
      ]),
      threadCtidPtrs,
      completeChannel: vi.fn(),
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
      channel,
      [0, stackPtr, 0, tlsPtr, ctidPtr, 0],
    );

    expect(onClone).toHaveBeenCalledTimes(1);
    expect(threadCtidPtrs.get(`${pid}:${tid}`)).toBe(ctidPtr);
    resolveClone(tid);
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
    let resolveClone!: (value: number) => void;
    const onClone = vi.fn(() => new Promise<number>((resolve) => {
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
    resolveClone(tid);
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
          kernel_create_process_with_stdio: vi.fn(() => 0),
          kernel_set_brk_base: vi.fn(() => 0),
          kernel_set_mmap_base: vi.fn(() => 0),
          kernel_set_max_addr: setMaxAddr,
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
      stdio: CAPTURED_STDIO,
    });
    kw.addChannel(321, highThreadChannelOffset, 7);

    expect(setMaxAddr).toHaveBeenCalledTimes(1);
    expect(setMaxAddr).toHaveBeenCalledWith(321, maxAddr);
  });

  it("requires explicit stdio when creating a kernel process", () => {
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      initialized: true,
      hostReaped: new Set(),
      processes: new Map(),
      activeChannels: [],
      usePolling: true,
      kernelInstance: {
        exports: {
          kernel_create_process_with_stdio: vi.fn(() => 0),
        },
      },
    }) as CentralizedKernelWorker;
    const memory = new WebAssembly.Memory({
      initial: 16,
      maximum: 16,
      shared: true,
    });

    expect(() => kw.registerProcess(900, memory, [4 * WASM_PAGE_SIZE])).toThrow(
      "registerProcess requires explicit stdio",
    );
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

    // Register two processes
    // PID 1 is reserved for the virtual init process; use PIDs >= 100.
    registerProcess(kw, 100, proc1);
    registerProcess(kw, 101, proc2);

    // Unregister both without error
    kw.unregisterProcess(100);
    kw.unregisterProcess(101);
    expect((kw as any).processes.has(100)).toBe(false);
    expect((kw as any).processes.has(101)).toBe(false);
    expect(
      (kw as any).activeChannels.some((ch: any) => ch.pid === 100 || ch.pid === 101),
    ).toBe(false);

    // Unregistering non-existent pid should not throw
    kw.unregisterProcess(999);
  });

  it("repeated compact-layout launches do not leave process registrations behind", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    for (let pid = 200; pid < 240; pid++) {
      const proc = createProcessMemory();
      expect(proc.memory.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);
      registerProcess(kw, pid, proc);
      kw.unregisterProcess(pid);
    }

    expect((kw as any).activeChannels.length).toBe(0);
    for (let pid = 200; pid < 240; pid++) {
      expect((kw as any).processes.has(pid)).toBe(false);
    }
  });

  it("should set next child PID for fork", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    kw.setNextChildPid(42);

    const proc = createProcessMemory();
    registerProcess(kw, 100, proc);
    kw.unregisterProcess(100);
  });

  it("should throw when registering duplicate PID", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const proc1 = createProcessMemory();
    const proc2 = createProcessMemory();

    registerProcess(kw, 100, proc1);
    expect(() => registerProcess(kw, 100, proc2)).toThrow();

    kw.unregisterProcess(100);
  });

  it("should throw when registering before init", () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    const proc = createProcessMemory();
    expect(() => registerProcess(kw, 100, proc)).toThrow(
      "Kernel not initialized",
    );
  });
});
