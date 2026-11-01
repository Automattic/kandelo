import { describe, expect, it, vi } from "vitest";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

const SYS_IOCTL = 72;
const SIGUSR1 = 10;

function makeWorker(memory: WebAssembly.Memory) {
  const worker = createCentralizedKernelWorkerTestDouble({
    config: { maxWorkers: 1, dataBufferSize: 65_536, useSharedMemory: true },
    io: new NodePlatformIO(),
  });
  const exports = {
    kernel_handle_channel: vi.fn(() => 0),
    kernel_get_process_exit_signal: vi.fn(() => -1),
  };
  installKernelWorkerTestScratch(worker, new WebAssembly.Memory({ initial: 2 }), 128, 4, {
    kernelExports: exports,
    kernelExportNames: Object.keys(exports),
  });
  const channel = (offset: number) => ({
    pid: 7, memory, channelOffset: offset,
    i32View: new Int32Array(memory.buffer, offset), consecutiveSyscalls: 0,
  });
  return { worker: worker as any, channel };
}

describe("an ioctl interrupted while parked on the blocking-retry path", () => {
  it("publishes its rewritten in/out argument with EINTR", () => {
    // DRM_IOCTL_WAIT_VBLANK parks with EAGAIN after rewriting a RELATIVE
    // request to its ABSOLUTE target; a caught signal then ends it with
    // EINTR. Linux's drm_ioctl copies that argument back, so libdrm's EINTR
    // retry (and an SA_RESTART resubmission) continues the same wait.
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const { worker, channel } = makeWorker(memory);
    const ioctl = channel(0);
    const other = channel(0x800);
    worker.processes.set(7, { channels: [ioctl, other], memory });
    const rewritten = new Uint8Array([0, 0, 0, 0, 0x2a, 0, 0, 0]);
    worker.handleBlockingRetry(ioctl, SYS_IOCTL, [3, 0xc010643a, 0x4000, 16, 0, 0],
      [{ ptr: 0x4000, bytes: rewritten }], undefined, false, SIGUSR1);
    expect([...new Uint8Array(memory.buffer, 0x4000, 8)]).toEqual([...rewritten]);
    expect(worker.pendingPollRetries.has(ioctl)).toBe(false);

    // Other syscalls still publish nothing on EINTR.
    worker.handleBlockingRetry(other, 999, [0, 0, 0, 0, 0, 0],
      [{ ptr: 0x5000, bytes: rewritten }], undefined, false, SIGUSR1);
    expect([...new Uint8Array(memory.buffer, 0x5000, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
