import { beforeAll, describe, expect, it } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";

beforeAll(() => {
  if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
    (globalThis as { ImageData: unknown }).ImageData = class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    };
  }
});

function makeFakeCanvas(): OffscreenCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ putImageData: () => {} }),
  } as unknown as OffscreenCanvas;
}

function makeKernel(): CentralizedKernelWorker {
  return new CentralizedKernelWorker(
    { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
    new NodePlatformIO(),
  );
}

function stubScanout(kernel: CentralizedKernelWorker, w: number, h: number): void {
  const fb = { fb_id: 10, bo_id: 100, width: w, height: h, pixel_format: 0, pitch: w * 4 };
  const pixels = new Uint8Array(w * h * 4);
  (kernel.kms as unknown as { currentFb: (id: number) => unknown }).currentFb = () => fb;
  (kernel.kms as unknown as { scanoutBytes: (id: number) => Uint8Array }).scanoutBytes = () => pixels;
}

describe("CentralizedKernelWorker KMS stats SAB", () => {
  it("tickVblank writes [count, ts_ms, width, height, tick_us] when a statsSab is attached", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 32, 24);

    const statsSab = new SharedArrayBuffer(20);
    const view = new Int32Array(statsSab);
    // mode: "2d" opts into the legacy CPU-blit path — the default
    // "auto" mode skips the blit branch and slots 0/1/4 stay 0.
    kernel.attachKmsCanvas(1, makeFakeCanvas(), statsSab, { mode: "2d" });

    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 0)).toBe(1);
    expect(Atomics.load(view, 2)).toBe(32);
    expect(Atomics.load(view, 3)).toBe(24);
    expect(Atomics.load(view, 1)).toBeGreaterThanOrEqual(0);
    expect(Atomics.load(view, 4)).toBeGreaterThanOrEqual(0);

    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 0)).toBe(2);
  });

  it("tickVblank is a no-op for the stats slots when no SAB is attached", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 8, 8);
    kernel.attachKmsCanvas(1, makeFakeCanvas());
    expect(() => (kernel as unknown as { tickVblank: () => void }).tickVblank()).not.toThrow();
  });

  it("tickVblank fills slots 5/6 from kernel kms_commit_count + kms_last_frame_us when SAB is sized for them", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 16, 16);
    // Stub the kernel-wasm exports the way the production tickVblank
    // path will read them, so the test exercises the real wire-up
    // rather than the "no kernel instance → 0" defensive fallback.
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => 42n,
        kernel_kms_last_frame_us: (_crtc: number) => 16_667n,
      },
    };
    const statsSab = new SharedArrayBuffer(7 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsCanvas(1, makeFakeCanvas(), statsSab);
    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 5)).toBe(42);
    expect(Atomics.load(view, 6)).toBe(16_667);
  });

  it("tickVblank populates slots 2/3 from the current FB in auto mode (no 2D blit)", () => {
    // Regression guard: scanout w/h must publish whenever a stats SAB is
    // attached, even when the canvas isn't owned by the CPU-blit path.
    const kernel = makeKernel();
    stubScanout(kernel, 1920, 1080);
    const statsSab = new SharedArrayBuffer(5 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsCanvas(1, makeFakeCanvas(), statsSab);
    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 2)).toBe(1920);
    expect(Atomics.load(view, 3)).toBe(1080);
    expect(Atomics.load(view, 0)).toBe(0);
    expect(Atomics.load(view, 4)).toBe(0);
  });

  it("tickVblank leaves slots 5/6 alone when the SAB is the legacy 5-slot size", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 16, 16);
    // kernel_kms_commit_count is read on EVERY tick now (it gates the
    // vblank broad wake on real page-flip activity), so it can't be a
    // throwing sentinel anymore. kernel_kms_last_frame_us is only read
    // by the slots-5/6 stats branch — keep it throwing to prove the
    // branch is skipped for an undersized SAB.
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => 42n,
        kernel_kms_last_frame_us: (_crtc: number) => {
          throw new Error("should not be called for a 5-slot SAB");
        },
      },
    };
    const statsSab = new SharedArrayBuffer(5 * 4);
    kernel.attachKmsCanvas(1, makeFakeCanvas(), statsSab);
    expect(() => (kernel as unknown as { tickVblank: () => void }).tickVblank()).not.toThrow();
  });

  it("attachKmsStats publishes slots 5/6 without a canvas attachment", () => {
    const kernel = makeKernel();
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => 7n,
        kernel_kms_last_frame_us: (_crtc: number) => 16_500n,
      },
    };
    const statsSab = new SharedArrayBuffer(7 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsStats(0, statsSab);

    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 5)).toBe(7);
    expect(Atomics.load(view, 6)).toBe(16_500);
    expect(Atomics.load(view, 0)).toBe(0);
    expect(Atomics.load(view, 2)).toBe(0);
    expect(Atomics.load(view, 3)).toBe(0);
  });

  it("attachKmsStats leaves slots 5/6 untouched when the SAB is too small", () => {
    const kernel = makeKernel();
    // See above: kernel_kms_commit_count now feeds the vblank wake gate
    // on every tick; kernel_kms_last_frame_us stays the throwing
    // sentinel for the slots-5/6 branch.
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => 42n,
        kernel_kms_last_frame_us: (_crtc: number) => {
          throw new Error("should not be called for a 5-slot SAB");
        },
      },
    };
    const statsSab = new SharedArrayBuffer(5 * 4);
    kernel.attachKmsStats(0, statsSab);
    expect(() => (kernel as unknown as { tickVblank: () => void }).tickVblank()).not.toThrow();
  });
});
