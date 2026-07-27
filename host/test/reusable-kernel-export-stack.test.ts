import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { WasmPosixKernel } from "../src/kernel";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";

const EXECUTABLE_PATH = "/bin/reusable-kernel-test";
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;

interface ReusableKernelExports extends WebAssembly.Exports {
  kernel_alloc_scratch(size: number): number;
  kernel_create_process(): number;
  kernel_execve(pathPtr: number, pathLen: number): number;
  kernel_execveat(
    dirfd: number,
    pathPtr: number,
    pathLen: number,
    flags: number,
  ): number;
  kernel_get_stack_pointer(): number;
  kernel_set_current_tid(pid: number, tid: number): number;
}

async function reusableKernel(): Promise<{
  exports: ReusableKernelExports;
  memory: WebAssembly.Memory;
}> {
  const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  rootfs.mkdir("/bin", 0o755);
  const executable = rootfs.open(
    EXECUTABLE_PATH,
    O_WRONLY | O_CREAT,
    0o755,
  );
  rootfs.close(executable);
  const kernel = new WasmPosixKernel(
    {
      maxWorkers: 1,
      dataBufferSize: 65_536,
      useSharedMemory: true,
    },
    new VirtualPlatformIO(
      [{ mountPoint: "/", backend: rootfs }],
      new NodeTimeProvider(),
    ),
    {
      onExec: () => 0,
    },
  );
  await kernel.init(readFileSync(resolveBinary("kernel.wasm")));
  const internals = kernel as unknown as {
    instance: WebAssembly.Instance | null;
    memory: WebAssembly.Memory | null;
  };
  expect(internals.instance).not.toBeNull();
  expect(internals.memory).not.toBeNull();
  return {
    exports: internals.instance!.exports as ReusableKernelExports,
    memory: internals.memory!,
  };
}

describe("reusable kernel export shadow-stack lifetime", () => {
  it("restores the stack after repeated successful execve and execveat transactions", async () => {
    const { exports, memory } = await reusableKernel();
    const pid = exports.kernel_create_process();
    expect(pid).toBeGreaterThan(0);

    // This repository-owned VFS fixture satisfies executable-file validation
    // without depending on whichever programs happen to exist on the host.
    const path = new TextEncoder().encode(EXECUTABLE_PATH);
    const pathPtr = exports.kernel_alloc_scratch(path.byteLength);
    expect(pathPtr).toBeGreaterThan(0);
    new Uint8Array(memory.buffer, pathPtr, path.byteLength).set(path);
    const baselineStackPointer = exports.kernel_get_stack_pointer();

    for (let iteration = 0; iteration < 4_096; iteration++) {
      expect(exports.kernel_set_current_tid(pid, pid), `execve bind ${iteration}`)
        .toBe(0);
      expect(
        exports.kernel_execve(pathPtr, path.byteLength),
        `execve ${iteration}`,
      ).toBe(0);
      expect(
        exports.kernel_get_stack_pointer(),
        `execve stack ${iteration}`,
      ).toBe(baselineStackPointer);

      expect(
        exports.kernel_set_current_tid(pid, pid),
        `execveat bind ${iteration}`,
      ).toBe(0);
      expect(
        exports.kernel_execveat(-100, pathPtr, path.byteLength, 0),
        `execveat ${iteration}`,
      ).toBe(0);
      expect(
        exports.kernel_get_stack_pointer(),
        `execveat stack ${iteration}`,
      ).toBe(baselineStackPointer);
    }
  });
});
