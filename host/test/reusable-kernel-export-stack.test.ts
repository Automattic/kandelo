import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { WasmPosixKernel } from "../src/kernel";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";

interface ReusableKernelExports extends WebAssembly.Exports {
  kernel_create_process(): number;
  kernel_exit(status: number): void;
  kernel_get_stack_pointer(): number;
  kernel_reap_process(pid: number): number;
  kernel_set_current_tid(pid: number, tid: number): number;
}

async function reusableKernel(): Promise<ReusableKernelExports> {
  const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
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
  );
  await kernel.init(readFileSync(resolveBinary("kernel.wasm")));
  const internals = kernel as unknown as {
    instance: WebAssembly.Instance | null;
  };
  expect(internals.instance).not.toBeNull();
  return internals.instance!.exports as ReusableKernelExports;
}

describe("reusable kernel export shadow-stack lifetime", () => {
  it("restores the stack across repeated process exit and reap transactions", async () => {
    const exports = await reusableKernel();
    const baselineStackPointer = exports.kernel_get_stack_pointer();

    for (let iteration = 0; iteration < 4_096; iteration++) {
      const pid = exports.kernel_create_process();
      expect(pid, `create process ${iteration}`).toBeGreaterThan(0);
      expect(
        exports.kernel_get_stack_pointer(),
        `create stack ${iteration}`,
      ).toBe(baselineStackPointer);

      expect(
        exports.kernel_set_current_tid(pid, pid),
        `exit bind ${iteration}`,
      ).toBe(0);
      exports.kernel_exit(0);
      expect(
        exports.kernel_get_stack_pointer(),
        `exit stack ${iteration}`,
      ).toBe(baselineStackPointer);
      expect(exports.kernel_reap_process(pid), `reap ${iteration}`).toBe(0);
      expect(
        exports.kernel_get_stack_pointer(),
        `reap stack ${iteration}`,
      ).toBe(baselineStackPointer);
    }
  });
});
