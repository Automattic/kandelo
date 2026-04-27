import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";

describe("CentralizedKernelWorker", () => {
  it("should initialize the kernel from wasm bytes", async () => {
    const wasmBytes = readFileSync(resolveBinary("kernel.wasm"));

    const kernelWorker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    await kernelWorker.init(
      wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ),
    );

    // If init doesn't throw, the kernel loaded and initialized successfully
    // Verify we can register a process without error
    const memory = new WebAssembly.Memory({
      initial: 17,
      maximum: 256,
      shared: true,
    });
    const channelOffset = (256 - 2) * 65536;
    memory.grow(256 - 17);

    // PID 1 is reserved for the virtual init process; use PIDs >= 100.
    kernelWorker.registerProcess(100, memory, [channelOffset]);

    // Unregister to clean up
    kernelWorker.unregisterProcess(100);
  });
});
