// host/test/multi-worker.test.ts
//
// Tests CentralizedKernelWorker process management: register/unregister,
// setNextChildPid, and fork flow.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";

const MAX_PAGES = 256; // small for tests
const CH_TOTAL_SIZE = 72 + 65536;

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(resolveBinary("kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createProcessMemory(): { memory: WebAssembly.Memory; channelOffset: number } {
  const memory = new WebAssembly.Memory({
    initial: 17,
    maximum: MAX_PAGES,
    shared: true,
  });
  const channelOffset = (MAX_PAGES - 2) * 65536;
  memory.grow(MAX_PAGES - 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
  return { memory, channelOffset };
}

describe("CentralizedKernelWorker Process Management", () => {
  it("should register and unregister processes", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const { memory: mem1, channelOffset: ch1 } = createProcessMemory();
    const { memory: mem2, channelOffset: ch2 } = createProcessMemory();

    // Register two processes
    // PID 1 is reserved for the virtual init process; use PIDs >= 100.
    kw.registerProcess(100, mem1, [ch1]);
    kw.registerProcess(101, mem2, [ch2]);

    // Unregister both without error
    kw.unregisterProcess(100);
    kw.unregisterProcess(101);

    // Unregistering non-existent pid should not throw
    kw.unregisterProcess(999);
  });

  it("should set next child PID for fork", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    kw.setNextChildPid(42);

    const { memory, channelOffset } = createProcessMemory();
    kw.registerProcess(100, memory, [channelOffset]);
    kw.unregisterProcess(100);
  });

  it("should throw when registering duplicate PID", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const { memory: mem1, channelOffset: ch1 } = createProcessMemory();
    const { memory: mem2, channelOffset: ch2 } = createProcessMemory();

    kw.registerProcess(100, mem1, [ch1]);
    expect(() => kw.registerProcess(100, mem2, [ch2])).toThrow();

    kw.unregisterProcess(100);
  });

  it("should throw when registering before init", () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    const { memory, channelOffset } = createProcessMemory();
    expect(() => kw.registerProcess(100, memory, [channelOffset])).toThrow(
      "Kernel not initialized",
    );
  });
});
