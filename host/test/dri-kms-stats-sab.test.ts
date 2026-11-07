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

  it("a dark CRTC shows black once and reports no scanout; lighting it presents again", () => {
    const kernel = makeKernel();
    const calls: string[] = [];
    const context = {
      fillStyle: "",
      fillRect: (_x: number, _y: number, w: number, h: number) => { calls.push(`fill ${context.fillStyle} ${w}x${h}`); },
      putImageData: () => { calls.push("put"); },
    };
    const canvas = { width: 32, height: 24, getContext: () => context } as unknown as OffscreenCanvas;
    const stats = new Int32Array(new SharedArrayBuffer(64));
    kernel.attachKmsCanvas(1, canvas, stats.buffer as SharedArrayBuffer, { mode: "2d" });
    stubScanout(kernel, 32, 24);
    const kms = kernel.kms as unknown as Record<string, unknown>;
    let dark = false;
    const lit = kms.currentFb as (id: number) => unknown;
    kms.isDark = () => dark;
    kms.currentFb = (id: number) => (dark ? undefined : lit(id));
    vi.advanceTimersByTime(17);
    expect(calls).toEqual(["put"]);
    expect(Atomics.load(stats, 9)).toBe(1);
    dark = true; // ACTIVE 0 or DPMS Off: the kernel latched no framebuffer
    vi.advanceTimersByTime(17);
    vi.advanceTimersByTime(17);
    expect(calls).toEqual(["put", "fill #000 32x24"]); // cleared once, not the last frame
    expect(Atomics.load(stats, 9)).toBe(0);
    dark = false;
    vi.advanceTimersByTime(17);
    expect(calls).toEqual(["put", "fill #000 32x24", "put"]);
    expect(Atomics.load(stats, 9)).toBe(1);
  });

  it("stats-only consumers (Node) see the same scanout state", () => {
    const kernel = makeKernel();
    const stats = new Int32Array(new SharedArrayBuffer(64));
    kernel.attachKmsStats(1, stats.buffer as SharedArrayBuffer);
    stubScanout(kernel, 16, 16);
    const kms = kernel.kms as unknown as Record<string, unknown>;
    let dark = false;
    const lit = kms.currentFb as (id: number) => unknown;
    kms.isDark = () => dark;
    kms.currentFb = (id: number) => (dark ? undefined : lit(id));
    vi.advanceTimersByTime(17);
    expect(Atomics.load(stats, 9)).toBe(1);
    dark = true;
    vi.advanceTimersByTime(17);
    expect(Atomics.load(stats, 9)).toBe(0);
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

  it("tickVblank wakes blocked retries on a tick whose vblank released a waiter or queued an event", () => {
    // kernel_vblank reaches a parked DRM_IOCTL_WAIT_VBLANK's target (or a
    // DRM_VBLANK_EVENT's) without any host-side flip latch; the kernel
    // reports that through kernel_kms_take_vblank_wake, consumed once.
    let pending = 0;
    const kernel = makeKernel({
      kernel_kms_take_vblank_wake: () => {
        const taken = pending;
        pending = 0;
        return taken;
      },
    });
    (kernel.kms as unknown as { flipCount: () => number }).flipCount = () => 0;
    const wake = vi.fn();
    kernel.testAuthority.configureScratchBoundaryHooksForTest({
      scheduleWakeBlockedRetries: wake,
    });
    kernel.attachKmsStats(0, new SharedArrayBuffer(5 * 4));

    vi.advanceTimersByTime(17);
    expect(wake).not.toHaveBeenCalled();

    pending = 1;
    vi.advanceTimersByTime(17);
    expect(wake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(17 * 3);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("ticks on display frames where the worker animates, passing each frame's age to the kernel", () => {
    // A browser kernel worker has requestAnimationFrame; Node does not. The
    // worker captures it at construction, like its timers.
    const frames: Array<(time: number) => void> = [];
    const scope = globalThis as {
      requestAnimationFrame?: (cb: (time: number) => void) => number;
      cancelAnimationFrame?: (handle: number) => void;
    };
    scope.requestAnimationFrame = (cb) => frames.push(cb);
    scope.cancelAnimationFrame = () => {};
    try {
      const ages: number[] = [];
      const kernel = makeKernel({
        kernel_vblank_elapsed: (elapsedUs: number) => { ages.push(elapsedUs); return 0; },
      });
      const stats = new Int32Array(new SharedArrayBuffer(64));
      kernel.attachKmsStats(1, stats.buffer as SharedArrayBuffer);
      stubScanout(kernel, 16, 16);
      const frame = (lagMs: number) => {
        vi.advanceTimersByTime(17);
        const cb = frames.shift()!;
        cb(performance.now() - lagMs);
      };
      frame(2);
      frame(0.5);
      expect(ages).toEqual([2000, 500]);
      expect(Atomics.load(stats, 9)).toBe(1);
      // Frames stop (a hidden page): the timer keeps 60 Hz with age 0.
      vi.advanceTimersByTime(1000);
      expect(ages.length).toBeGreaterThanOrEqual(58);
      expect(ages.slice(2).every((age) => age === 0)).toBe(true);
    } finally {
      delete scope.requestAnimationFrame;
      delete scope.cancelAnimationFrame;
    }
  });

  it("keeps the timer on WebKit, whose worker animation frames do not follow the display", () => {
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        + "(KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    });
    try {
      const ages: number[] = [];
      const kernel = makeKernel({
        kernel_vblank_elapsed: (elapsedUs: number) => { ages.push(elapsedUs); return 0; },
      });
      kernel.attachKmsStats(1, new SharedArrayBuffer(5 * 4));
      vi.advanceTimersByTime(1000);
      expect(frames).toHaveLength(0);
      expect(ages).toHaveLength(60);
      expect(ages.every((age) => age === 0)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stamps with the kernel's own time through kernel_vblank on a kernel without kernel_vblank_elapsed", () => {
    let ticks = 0;
    const kernel = makeKernel({ kernel_vblank: () => { ticks++; return 0; } });
    kernel.attachKmsStats(1, new SharedArrayBuffer(5 * 4));
    vi.advanceTimersByTime(1000);
    expect(ticks).toBe(60);
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
    const record = (x: number, bo = 1) => {
      pending = new Uint8Array(40);
      const view = new DataView(pending.buffer);
      [bo, 2, 2, x, 4, 0, 0, bo ? 25 : 0].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    };
    kernel.bos.create({ pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8 });
    kernel.bos.pixelView(1)!.set([0, 0, 255, 255]);
    kernel.kms.setMaster(7, 1n, 1n);
    const sync = vi.spyOn(kernel.bos, "syncToSab");
    const put = vi.fn();
    const cursorCanvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, putImageData: put }),
      addEventListener() {} } as unknown as OffscreenCanvas;
    kernel.attachKmsCanvas(1, makeFakeCanvas(), undefined, { mode: "2d", cursorCanvas });
    record(3);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(put.mock.calls.at(-1)![0].data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
    // A tick without a record still samples live storage: no commit/version
    // cache is allowed to hide writes through an already-mapped BO.
    kernel.bos.pixelView(1)!.set([255, 0, 0, 255]);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.at(-1)![0].data.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 0, 255, 255]));
    record(19);
    vi.advanceTimersByTime(17);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(put.mock.calls.at(-1)!.slice(1)).toEqual([19, 4]);
  });

  it("presents the device cursor plane unchanged across a master handoff", () => {
    // Linux plane state is not master state: DROP_MASTER does not hide the
    // cursor, and the next master inherits it until it changes it. Drive
    // the real vblank tick with the kernel's cursor records.
    const memory = new WebAssembly.Memory({ initial: 2 });
    let pending: Uint8Array | undefined;
    const kernel = makeKernel({ kernel_kms_cursor_read: (pointer: number) => {
      if (!pending) return 0;
      new Uint8Array(memory.buffer, pointer, pending.length).set(pending);
      pending = undefined;
      return 40;
    } }, memory);
    const record = (x: number, y: number, bo = 1) => {
      pending = new Uint8Array(40);
      const view = new DataView(pending.buffer);
      [bo, 2, 2, x, y, 0, 0, bo ? 25 : 0].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    };
    kernel.bos.create({ pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8 });
    kernel.bos.pixelView(1)!.set([0, 0, 255, 255]);
    const put = vi.fn(), clear = vi.fn();
    const cursorCanvas = { width: 0, height: 0,
      getContext: () => ({ clearRect: clear, putImageData: put }),
      addEventListener() {} } as unknown as OffscreenCanvas;
    kernel.attachKmsCanvas(1, makeFakeCanvas(), undefined, { mode: "2d", cursorCanvas });
    kernel.kms.setMaster(7, 1n, 1n);
    record(30, 40);
    vi.advanceTimersByTime(17);
    expect(put.mock.calls.at(-1)!.slice(1)).toEqual([30, 40]);
    const painted = put.mock.calls.length;

    // Handoff: the first master drops, a second file takes master. No
    // record arrives (the kernel plane is unchanged) and nothing is cleared.
    kernel.kms.dropMaster(1n, 1n);
    vi.advanceTimersByTime(17);
    kernel.kms.setMaster(8, 2n, 2n);
    vi.advanceTimersByTime(17);
    expect(clear).not.toHaveBeenCalled();
    expect(put.mock.calls.length).toBe(painted);
    expect(kernel.kms.cursorSnapshot()).toMatchObject({ x: 30, y: 40, width: 2, height: 2 });
    expect(kernel.kms.cursorSnapshot().pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));

    // The new master moves the inherited image; the presented cursor is the
    // same image at the new position.
    record(5, 6);
    vi.advanceTimersByTime(17);
    expect(put.mock.calls.at(-1)!.slice(1)).toEqual([5, 6]);
    expect(put.mock.calls.at(-1)![0].data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
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
