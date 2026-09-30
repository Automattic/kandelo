import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

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

/** A canvas that records its listeners so a test can fire the WebGL
 *  context-loss pair. `fire` reports whether the handler cancelled the
 *  event — only a cancelled loss opts into restoration. */
function makeListeningCanvas(): {
  canvas: OffscreenCanvas;
  fire: (type: string) => boolean;
} {
  const listeners = new Map<string, (event: Event) => void>();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => null,
    addEventListener: (type: string, fn: (event: Event) => void) => {
      listeners.set(type, fn);
    },
  } as unknown as OffscreenCanvas;
  return {
    canvas,
    fire: (type: string) => {
      let cancelled = false;
      listeners.get(type)?.({
        preventDefault: () => { cancelled = true; },
      } as Event);
      return cancelled;
    },
  };
}

type TestKernel = ReturnType<typeof createCentralizedKernelWorkerTestDouble>;

function makeKernel(
  kernelExports: Readonly<Record<string, unknown>> = {},
): TestKernel {
  const kernel = createCentralizedKernelWorkerTestDouble({
    config: {
      maxWorkers: 1,
      dataBufferSize: 65_536,
      useSharedMemory: true,
    },
    io: new NodePlatformIO(),
  });
  const implementations = {
    kernel_vblank: () => 0,
    ...kernelExports,
  };
  installKernelWorkerTestScratch(
    kernel,
    new WebAssembly.Memory({ initial: 2 }),
    128,
    4,
    {
      kernelExports: implementations,
      kernelExportNames: Object.keys(implementations),
    },
  );
  return kernel;
}

function stubScanout(kernel: TestKernel, w: number, h: number): void {
  const fb = { fb_id: 10, bo_id: 100, width: w, height: h, pixel_format: 0, pitch: w * 4 };
  const pixels = new Uint8Array(w * h * 4);
  (kernel.kms as unknown as { currentFb: (id: number) => unknown }).currentFb = () => fb;
  (kernel.kms as unknown as { scanoutBytes: (id: number) => Uint8Array }).scanoutBytes = () => pixels;
}

describe("CentralizedKernelWorker KMS stats SAB", () => {
  beforeEach(() => {
    // The worker captures its scheduler during construction, so install fake
    // timers before makeKernel and exercise the real registered interval.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("tickVblank writes [count, ts_ms, width, height, tick_us] when a statsSab is attached", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 32, 24);

    const statsSab = new SharedArrayBuffer(20);
    const view = new Int32Array(statsSab);
    // mode: "2d" opts into the legacy CPU-blit path — the default
    // "auto" mode skips the blit branch and slots 0/1/4 stay 0.
    kernel.attachKmsCanvas(1, makeFakeCanvas(), statsSab, { mode: "2d" });

    vi.advanceTimersByTime(17);
    expect(Atomics.load(view, 0)).toBe(1);
    expect(Atomics.load(view, 2)).toBe(32);
    expect(Atomics.load(view, 3)).toBe(24);
    expect(Atomics.load(view, 1)).toBeGreaterThanOrEqual(0);
    expect(Atomics.load(view, 4)).toBeGreaterThanOrEqual(0);

    vi.advanceTimersByTime(17);
    expect(Atomics.load(view, 0)).toBe(2);
  });

  it("tickVblank is a no-op for the stats slots when no SAB is attached", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 8, 8);
    kernel.attachKmsCanvas(1, makeFakeCanvas());
    expect(() => vi.advanceTimersByTime(17)).not.toThrow();
  });

  it("tickVblank fills slots 5/6 from kernel kms_commit_count + kms_last_frame_us when SAB is sized for them", () => {
    const kernel = makeKernel({
      kernel_kms_commit_count: (_crtc: number) => 42n,
      kernel_kms_last_frame_us: (_crtc: number) => 16_667n,
    });
    stubScanout(kernel, 16, 16);
    const statsSab = new SharedArrayBuffer(7 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsCanvas(1, makeFakeCanvas(), statsSab);
    vi.advanceTimersByTime(17);
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
    vi.advanceTimersByTime(17);
    expect(Atomics.load(view, 2)).toBe(1920);
    expect(Atomics.load(view, 3)).toBe(1080);
    expect(Atomics.load(view, 0)).toBe(0);
    expect(Atomics.load(view, 4)).toBe(0);
  });

  it("tickVblank leaves slots 5/6 alone when the SAB is the legacy 5-slot size", () => {
    const kernel = makeKernel({
      kernel_kms_commit_count: (_crtc: number) => {
        throw new Error("should not be called for a 5-slot SAB");
      },
      kernel_kms_last_frame_us: (_crtc: number) => {
        throw new Error("should not be called for a 5-slot SAB");
      },
    });
    stubScanout(kernel, 16, 16);
    const statsSab = new SharedArrayBuffer(5 * 4);
    kernel.attachKmsCanvas(1, makeFakeCanvas(), statsSab);
    expect(() => vi.advanceTimersByTime(17)).not.toThrow();
  });

  it("attachKmsStats publishes slots 5/6 without a canvas attachment", () => {
    const kernel = makeKernel({
      kernel_kms_commit_count: (_crtc: number) => 7n,
      kernel_kms_last_frame_us: (_crtc: number) => 16_500n,
    });
    const statsSab = new SharedArrayBuffer(7 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsStats(0, statsSab);

    vi.advanceTimersByTime(17);
    expect(Atomics.load(view, 5)).toBe(7);
    expect(Atomics.load(view, 6)).toBe(16_500);
    expect(Atomics.load(view, 0)).toBe(0);
    expect(Atomics.load(view, 2)).toBe(0);
    expect(Atomics.load(view, 3)).toBe(0);
  });

  it("tickVblank wakes blocked retries only on a tick that latched a flip", () => {
    const kernel = makeKernel();
    let flips = 0;
    (kernel.kms as unknown as { flipCount: () => number }).flipCount = () => flips;
    const wake = vi.fn();
    kernel.testAuthority.configureScratchBoundaryHooksForTest({
      scheduleWakeBlockedRetries: wake,
    });
    kernel.attachKmsStats(0, new SharedArrayBuffer(5 * 4));

    vi.advanceTimersByTime(17);
    expect(wake).not.toHaveBeenCalled();

    flips = 1;
    vi.advanceTimersByTime(17);
    expect(wake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(17 * 4);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("a webgl2-scanout attach stands the presenter down on loss and rebuilds on restore", () => {
    const kernel = makeKernel();
    const statsSab = new SharedArrayBuffer(8 * 4);
    const view = new Int32Array(statsSab);
    const { canvas, fire } = makeListeningCanvas();
    kernel.attachKmsCanvas(1, canvas, statsSab, { mode: "webgl2-scanout" });

    const presenters = (kernel as unknown as {
      kmsGlPresenters: Map<number, unknown>;
    }).kmsGlPresenters;
    presenters.set(1, { gl: {}, tex: {} });
    Atomics.store(view, 7, 1);

    expect(fire("webglcontextlost"), "an uncancelled loss is never restored")
      .toBe(true);
    expect(presenters.get(1)).toBeNull();
    expect(Atomics.load(view, 7)).toBe(0);

    fire("webglcontextrestored");
    expect(presenters.has(1)).toBe(false);
  });

  it("attachKmsStats leaves slots 5/6 untouched when the SAB is too small", () => {
    const kernel = makeKernel({
      kernel_kms_commit_count: (_crtc: number) => {
        throw new Error("should not be called for a 5-slot SAB");
      },
      kernel_kms_last_frame_us: (_crtc: number) => {
        throw new Error("should not be called for a 5-slot SAB");
      },
    });
    const statsSab = new SharedArrayBuffer(5 * 4);
    kernel.attachKmsStats(0, statsSab);
    expect(() => vi.advanceTimersByTime(17)).not.toThrow();
  });
});
