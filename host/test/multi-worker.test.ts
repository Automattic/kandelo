// host/test/multi-worker.test.ts
//
// Tests CentralizedKernelWorker process management: register/unregister,
// setNextChildPid, and fork flow.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_PAGES = 256; // small for tests
const CH_TOTAL_SIZE = 72 + 65536;

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(join(__dirname, "../wasm/wasm_posix_kernel.wasm"));
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
    kw.registerProcess(1, mem1, [ch1]);
    kw.registerProcess(2, mem2, [ch2]);

    // Unregister both without error
    kw.unregisterProcess(1);
    kw.unregisterProcess(2);

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
    kw.registerProcess(1, memory, [channelOffset]);
    kw.unregisterProcess(1);
  });

  it("should throw when registering duplicate PID", async () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    await kw.init(loadKernelWasm());

    const { memory: mem1, channelOffset: ch1 } = createProcessMemory();
    const { memory: mem2, channelOffset: ch2 } = createProcessMemory();

    kw.registerProcess(1, mem1, [ch1]);
    expect(() => kw.registerProcess(1, mem2, [ch2])).toThrow();

    kw.unregisterProcess(1);
  });

  it("should throw when registering before init", () => {
    const kw = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    const { memory, channelOffset } = createProcessMemory();
    expect(() => kw.registerProcess(1, memory, [channelOffset])).toThrow(
      "Kernel not initialized",
    );
  });
});
