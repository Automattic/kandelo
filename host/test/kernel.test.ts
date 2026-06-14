import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { WasmPosixKernel } from "../src/kernel";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import {
  ABI_SYSCALLS,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
} from "../src/generated/abi";

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

  it("returns ESRCH instead of trapping for a syscall on a reaped pid", async () => {
    const wasmBytes = readFileSync(resolveBinary("kernel.wasm"));
    const kernel = new WasmPosixKernel(
      { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );

    await kernel.init(
      wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ),
    );

    const instance = kernel.getInstance();
    const memory = kernel.getMemory();
    expect(instance).not.toBeNull();
    expect(memory).not.toBeNull();

    const exports = instance!.exports as {
      kernel_alloc_scratch: (size: number) => number | bigint;
      kernel_handle_channel: (offset: number | bigint, pid: number) => number;
      kernel_remove_process: (pid: number) => number;
    };
    const missingPid = 0x7fffff00;
    exports.kernel_remove_process(missingPid);

    const scratch = Number(exports.kernel_alloc_scratch(CH_TOTAL_SIZE));
    expect(scratch).toBeGreaterThan(0);
    const view = new DataView(memory!.buffer);
    view.setUint32(scratch + CH_SYSCALL, ABI_SYSCALLS.Munmap, true);

    const result = exports.kernel_handle_channel(
      kernel.toKernelPtr(scratch),
      missingPid,
    );

    expect(result).toBe(-3);
    expect(Number(view.getBigInt64(scratch + CH_RETURN, true))).toBe(-1);
    expect(view.getUint32(scratch + CH_ERRNO, true)).toBe(3);
  });
});
