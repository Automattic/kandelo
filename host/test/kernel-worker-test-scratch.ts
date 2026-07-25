import { CH_TOTAL_SIZE } from "../src/generated/abi";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";

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
  worker.scratchRegion = allocateKernelScratchRegion(
    memory,
    () => pointerWidth === 8 ? BigInt(pointer) : pointer,
    CH_TOTAL_SIZE,
    pointerWidth,
    "test kernel syscall scratch",
  );
  return pointer;
}
