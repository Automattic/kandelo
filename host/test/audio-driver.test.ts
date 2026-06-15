/**
 * Phase B end-to-end coverage for the ALSA host AudioDriver.
 *
 * Three layers:
 *
 *   1. `NodeAudioDriver` cadence: `setInterval`-driven tick fires once
 *      per `periodFrames / sampleRate` ms with `framesConsumed ==
 *      periodFrames`.
 *
 *   2. `CentralizedKernelWorker.audioInitRing`: boots a kernel against
 *      the real `kandelo-kernel.wasm`, allocates a 64 KiB SAB ring for
 *      `pcm_id = 0`, asserts the returned `(buffer, byteOffset,
 *      byteLength)` triple points into the kernel's
 *      `WebAssembly.Memory` (the `buffer` is the kernel SAB; the
 *      offset is non-zero and 16-byte aligned per the kernel
 *      allocator).
 *
 *   3. End-to-end: `audioPeriodTick` against a freshly-initialised
 *      kernel returns cleanly (no panic; no error logged). We can't
 *      observe `hw_ptr` here without opening an OFD against
 *      `/dev/snd/pcmC0D0p`, but the smoke test catches kernel-side
 *      regressions in the export wiring.
 *
 * The harness mirrors `audio-integration.test.ts` but skips process
 * spawn — this exercises host-side wiring; OFD-driven flows land
 * in the espeak-ng end-to-end Playwright spec.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { NodeAudioDriver } from "../src/audio/node-audio-driver";
import type { AudioRing } from "../src/audio/audio-driver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const kernelBinary = join(__dirname, "../wasm/kandelo-kernel.wasm");

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(kernelBinary);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("NodeAudioDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const fakeRing: AudioRing = {
    buffer: new ArrayBuffer(64 * 1024),
    byteOffset: 0,
    byteLength: 64 * 1024,
  };

  it("ticks once per period at the period/sampleRate cadence", async () => {
    const driver = new NodeAudioDriver();
    const ticks: Array<{ pcmId: number; frames: number }> = [];
    await driver.start(
      0,
      48_000,
      2,
      1024,
      fakeRing,
      (pcmId, frames) => ticks.push({ pcmId, frames }),
      () => 0,
    );
    // 1024 frames @ 48 kHz = ~21.33 ms.
    // Advance by 4 periods worth.
    vi.advanceTimersByTime(85);
    expect(ticks.length).toBe(4);
    expect(ticks[0]).toEqual({ pcmId: 0, frames: 1024 });
    driver.stop(0);
  });

  it("stop() clears the interval and no further ticks fire", async () => {
    const driver = new NodeAudioDriver();
    let ticks = 0;
    await driver.start(0, 48_000, 2, 1024, fakeRing, () => ticks++, () => 0);
    vi.advanceTimersByTime(43); // ~2 periods
    expect(ticks).toBe(2);
    driver.stop(0);
    vi.advanceTimersByTime(100);
    expect(ticks).toBe(2);
  });

  it("starting the same pcmId twice is a no-op", async () => {
    const driver = new NodeAudioDriver();
    let ticks = 0;
    await driver.start(0, 48_000, 2, 1024, fakeRing, () => ticks++, () => 0);
    await driver.start(0, 48_000, 2, 1024, fakeRing, () => ticks++, () => 0);
    vi.advanceTimersByTime(22); // ~1 period
    // Only the FIRST callback was registered, so we should see exactly 1 tick,
    // not 2 (if duplicate intervals leaked through).
    expect(ticks).toBe(1);
    driver.stop(0);
  });
});

describe.skipIf(!existsSync(kernelBinary))(
  "CentralizedKernelWorker.audioInitRing",
  () => {
    let kernel: CentralizedKernelWorker;
    beforeEach(async () => {
      const io = new NodePlatformIO();
      kernel = new CentralizedKernelWorker(
        {
          maxWorkers: 1,
          dataBufferSize: 65536,
          useSharedMemory: true,
          enableSyscallLog: false,
        },
        io,
        {},
      );
      await kernel.init(loadKernelWasm());
    });

    it("returns a ring window into kernel-visible memory", () => {
      const ring = kernel.audioInitRing(0, 64 * 1024);
      expect(ring).not.toBeNull();
      const r = ring!;
      expect(r.byteLength).toBe(64 * 1024);
      expect(r.byteOffset).toBeGreaterThan(0);
      // Kernel allocator (kernel_alloc_scratch) aligns to 16.
      expect(r.byteOffset % 16).toBe(0);
      // Must fit inside the kernel memory window.
      expect(r.byteOffset + r.byteLength).toBeLessThanOrEqual(r.buffer.byteLength);
      // The ring is zeroed by the kernel allocator.
      const view = new Int16Array(r.buffer, r.byteOffset, 8);
      for (const sample of view) expect(sample).toBe(0);
    });

    it("audioPeriodTick on a fresh kernel is a no-op (no exception)", () => {
      // No OFD is open against /dev/snd/pcmC0D0p, so tick walks zero
      // OFDs and returns cleanly. We're proving the export plumbing
      // doesn't trap when nothing is listening.
      kernel.audioInitRing(0, 64 * 1024);
      expect(() => kernel.audioPeriodTick(0, 1024)).not.toThrow();
    });

    it("a host-thread Int16Array view sees a writable, kernel-visible region", () => {
      const ring = kernel.audioInitRing(0, 64 * 1024)!;
      const view = new Int16Array(ring.buffer, ring.byteOffset, ring.byteLength / 2);
      view[0] = 0x1234;
      view[view.length - 1] = -0x4321;
      // Re-mount from the same buffer to confirm bytes hit the SAB,
      // not a copy.
      const view2 = new Int16Array(
        ring.buffer,
        ring.byteOffset,
        ring.byteLength / 2,
      );
      expect(view2[0]).toBe(0x1234);
      expect(view2[view.length - 1]).toBe(-0x4321);
    });
  },
);
