import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";

describe("CentralizedKernelWorker", () => {
  it("drains queued PTY output when a listener registers", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const queued = [
      encoder.encode("spidermonkey-node$ "),
      encoder.encode("ready\n"),
    ];
    const received: string[] = [];
    const kernelWorker = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
      ptyOutputCallbacks: new Map<number, (data: Uint8Array) => void>(),
      ptyMasterRead: () => queued.shift() ?? null,
    }) as CentralizedKernelWorker;

    kernelWorker.onPtyOutput(3, (data) => {
      received.push(decoder.decode(data));
    });

    expect(received).toEqual(["spidermonkey-node$ ", "ready\n"]);
  });

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
    kernelWorker.registerProcess(100, memory, [channelOffset], { stdio: CAPTURED_STDIO });

    // Unregister to clean up
    kernelWorker.unregisterProcess(100);
  });
});
