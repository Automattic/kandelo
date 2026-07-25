import { CH_TOTAL_SIZE } from "../src/generated/abi";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

/**
 * Install the same capacity-carrying main scratch contract that worker.init()
 * creates, for white-box tests that intentionally bypass the constructor and
 * Wasm allocator.
 */
export function installKernelWorkerTestScratch(
  worker: Record<string, unknown>,
  memory: WebAssembly.Memory,
  pointer = 128,
  pointerWidth: 4 | 8 = 4,
): number {
  worker.kernelMemory = memory;
  const scratchTestInstance = createKernelScratchTestInstance(
    pointerWidth,
    memory,
    () => (
      worker.kernelInstance as { exports?: Record<string, unknown> } | undefined
    )?.exports ?? {},
    () => pointerWidth === 8 ? BigInt(pointer) : pointer,
  );
  worker.scratchTestInstance = scratchTestInstance;
  worker.scratchRegion = allocateKernelScratchRegion(
    memory,
    scratchTestInstance.exports.kernel_alloc_scratch as
      (size: number) => number | bigint,
    CH_TOTAL_SIZE,
    pointerWidth,
    "test kernel syscall scratch",
    scratchTestInstance,
  );
  return pointer;
}
