// host/test/multi-worker.test.ts
//
// Tests CentralizedKernelWorker process management: register/unregister,
// setNextChildPid, and fork flow.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import {
  computeProcessMemoryLayout,
  createProcessMemory as createLayoutMemory,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, WASM_PAGE_SIZE } from "../src/constants";

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
