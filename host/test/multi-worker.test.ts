// host/test/multi-worker.test.ts
//
// Tests CentralizedKernelWorker process management: register/unregister,
// setNextChildPid, and fork flow.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CentralizedKernelWorker } from "../src/kernel-worker";
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
  });
}

describe("CentralizedKernelWorker Process Management", () => {
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
      sharedMappings: new Map(),
      sharedMmapBackings: new Map(),
      shmMappings: new Map(),
      hostReaped: new Set([pid]),
    }) as CentralizedKernelWorker;

    kw.deactivateProcess(pid);

    expect(lockTable.setLock(pathHash, peerPid, 1, 0n, 0n)).toBe(true);
    expect((kw as any).processes.has(pid)).toBe(false);
    expect((kw as any).activeChannels).toEqual([{ pid: peerPid }]);
    expect((kw as any).hostReaped.has(pid)).toBe(false);
  });

  it("marks selected stdio descriptors as host-backed pipes", () => {
    const setStdioPipe = vi.fn(() => 0);
    const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      kernelInstance: {
        exports: {
          kernel_set_stdio_pipe: setStdioPipe,
        },
      },
    });

    kw.setStdioPipes(321, [0, 1, 2, -1, 3]);

    expect(setStdioPipe).toHaveBeenCalledTimes(3);
    expect(setStdioPipe).toHaveBeenNthCalledWith(1, 321, 0);
    expect(setStdioPipe).toHaveBeenNthCalledWith(2, 321, 1);
    expect(setStdioPipe).toHaveBeenNthCalledWith(3, 321, 2);
  });

  it("lets the host terminate pthread workers without waking SYS_EXIT back into guest code", () => {
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
    const completeChannelRaw = vi.fn();
    const abandonChannel = vi.fn((ch: typeof channel) => {
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
      abandonChannel,
    });

    (kw as any).handleExit(channel, ABI_SYSCALLS.Exit, [0]);

    expect(onThreadExit).toHaveBeenCalledWith(pid, tid, threadChannelOffset);
    expect(abandonChannel).toHaveBeenCalledWith(channel);
    expect(completeChannelRaw).not.toHaveBeenCalled();
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

  it("registers pthread clear-TID before the host clone callback can complete", async () => {
    const pid = 125;
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
      activeChannels: [channel],
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
          kernel_create_process: vi.fn(() => 0),
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
    });
    kw.addChannel(321, highThreadChannelOffset, 7);

    expect(setMaxAddr).toHaveBeenCalledTimes(1);
    expect(setMaxAddr).toHaveBeenCalledWith(321, maxAddr);
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

  it("retries fork pid allocation when the kernel still owns a zombie pid", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({
      initial: 4,
      maximum: 4,
      shared: true,
    });
    const channel = {
      pid: parentPid,
      channelOffset: WASM_PAGE_SIZE,
      memory,
    };
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
      tcpListenerTargets: new Map(),
      epollInterests: new Map(),
      inheritSharedMappings: vi.fn(),
      completeChannel,
      kernelInstance: {
        exports: {
          kernel_fork_process: kernelForkProcess,
          kernel_clear_fork_child: vi.fn(() => 0),
          kernel_reset_signal_mask: vi.fn(() => 0),
        },
      },
    });

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
