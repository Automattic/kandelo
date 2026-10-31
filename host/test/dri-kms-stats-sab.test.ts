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
  memory = new WebAssembly.Memory({ initial: 2 }),
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
    memory,
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
  const fb = { fb_id: 10, bo_id: 100, width: w, height: h, pixel_format: 0x34325258, pitch: w * 4 };
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

  it("publishes ownership and release without requiring a framebuffer or a scene flip", () => {
    const kernel = makeKernel();
    const stats = new Int32Array(new SharedArrayBuffer(64));
    kernel.attachKmsStats(1, stats.buffer as SharedArrayBuffer);
    kernel.kms.setMaster(123, 1n, 1n);
    vi.advanceTimersByTime(17);
    expect(Atomics.load(stats, 8)).toBe(123);
    expect(Atomics.load(stats, 0)).toBe(0);
    kernel.kms.dropMaster(1n, 1n);
    vi.advanceTimersByTime(17);
    expect(Atomics.load(stats, 8)).toBe(0);
    kernel.kms.setMaster(456, 2n, 2n);
    vi.advanceTimersByTime(17);
    expect(Atomics.load(stats, 8)).toBe(456);
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

  it("tickVblank samples cursor storage once per tick while accepting records and live writes", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    let pending: Uint8Array | undefined;
    const kernel = makeKernel({ kernel_kms_cursor_read: (pointer: number) => {
      if (!pending) return 0;
      new Uint8Array(memory.buffer, pointer, pending.length).set(pending);
      pending = undefined;
      return 40;
    } }, memory);
    const record = (lease: bigint, x: number, bo = 1) => {
      pending = new Uint8Array(40);
      const view = new DataView(pending.buffer);
      view.setBigUint64(0, lease, true);
      [bo, 2, 2, x, 4, 0, 0].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    };
    kernel.bos.create({ pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8 });
    kernel.bos.pixelView(1)!.set([0, 0, 255, 255]);
    kernel.kms.setMaster(7, 1n, 1n);
    const sync = vi.spyOn(kernel.bos, "syncToSab");
    const put = vi.fn();
    const cursorCanvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, putImageData: put }),
      addEventListener() {} } as unknown as OffscreenCanvas;
    kernel.attachKmsCanvas(1, makeFakeCanvas(), undefined, { mode: "2d", cursorCanvas });
    record(1n, 3);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(put.mock.calls.at(-1)![0].data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
    // A tick without a record still samples live storage: no commit/version
    // cache is allowed to hide writes through an already-mapped BO.
    kernel.bos.pixelView(1)!.set([255, 0, 0, 255]);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.at(-1)![0].data.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 0, 255, 255]));
    record(1n, 19);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(put.mock.calls.at(-1)!.slice(1)).toEqual([19, 4]);
    // A stale record cannot select a retired/unknown BO, but the retained
    // current cursor still receives its one live observation this tick.
    record(0n, 77, 999);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(4);
    expect(put.mock.calls.at(-1)!.slice(1)).toEqual([19, 4]);
    kernel.kms.dropMaster(1n, 1n);
    record(1n, 99, 999);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(4);
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
