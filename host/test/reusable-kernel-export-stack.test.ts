import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { createWasmPosixKernelTestHarness } from "../src/kernel";
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
  const capture: { instance: WebAssembly.Instance | null } = {
    instance: null,
  };
  const kernel = createWasmPosixKernelTestHarness({
    config: {
      maxWorkers: 1,
      dataBufferSize: 65_536,
      useSharedMemory: true,
    },
    io: new VirtualPlatformIO(
      [{ mountPoint: "/", backend: rootfs }],
      new NodeTimeProvider(),
    ),
    engine: {
      compile: (bytes) => WebAssembly.compile(bytes),
      instantiate: async (module, imports) => {
        const instance = await WebAssembly.instantiate(module, imports);
        capture.instance = instance;
        return instance;
      },
    },
  });
  await kernel.init(readFileSync(resolveBinary("kernel.wasm")));
  // WHY: the module-secret harness engine owns this raw instance only inside
  // the test. Production still installs and exposes only its gated facade, but
  // this regression must call the real returning export directly to observe
  // whether the Wasm shadow-stack epilogue restores its stack pointer.
  const instance = capture.instance;
  expect(instance).not.toBeNull();
  if (instance === null) throw new Error("test engine did not instantiate");
  return instance.exports as ReusableKernelExports;
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
