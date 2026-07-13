import { beforeAll, describe, expect, it, vi } from "vitest";
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

/** Fake WebGL2 context recording the calls the webgl2-scanout presenter
 *  makes. Compile/link always succeed; constants are inert numbers. */
function makeFakeGl() {
  const calls: {
    texImage2D: number;
    texSubImage2D: number;
    draws: number;
    viewports: number[][];
    mipmaps: number;
    texParams: number[][];
    deletedTextures: number;
  } = {
    texImage2D: 0,
    texSubImage2D: 0,
    draws: 0,
    viewports: [],
    mipmaps: 0,
    texParams: [],
    deletedTextures: 0,
  };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    TEXTURE_2D: 5, TEXTURE_MIN_FILTER: 6, LINEAR_MIPMAP_LINEAR: 7,
    TEXTURE_MAG_FILTER: 8, LINEAR: 9, TEXTURE_WRAP_S: 10, CLAMP_TO_EDGE: 11,
    TEXTURE_WRAP_T: 12, RGBA8: 13, RGBA: 14, UNSIGNED_BYTE: 15,
    COLOR_BUFFER_BIT: 16, TRIANGLES: 17,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniform1i: () => {},
    createTexture: () => ({}),
    deleteTexture: () => { calls.deletedTextures++; },
    bindTexture: () => {},
    texParameteri: (...args: number[]) => { calls.texParams.push(args); },
    texImage2D: () => { calls.texImage2D++; },
    texSubImage2D: () => { calls.texSubImage2D++; },
    generateMipmap: () => { calls.mipmaps++; },
    clearColor: () => {},
    clear: () => {},
    viewport: (...args: number[]) => { calls.viewports.push(args); },
    drawArrays: () => { calls.draws++; },
  };
  return { gl, calls };
}

function makeFakeGlCanvas(gl: unknown): OffscreenCanvas & { getContextCalls: number } {
  const canvas = {
    width: 0,
    height: 0,
    getContextCalls: 0,
    getContext(kind: string) {
      canvas.getContextCalls++;
      return kind === "webgl2" ? gl : null;
    },
  };
  return canvas as unknown as OffscreenCanvas & { getContextCalls: number };
}

function makeKernel(): CentralizedKernelWorker {
  return new CentralizedKernelWorker(
    { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
    new NodePlatformIO(),
  );
}

function stubScanout(kernel: CentralizedKernelWorker, w: number, h: number): Uint8Array {
  const fb = { fb_id: 10, bo_id: 100, width: w, height: h, pixel_format: 0, pitch: w * 4 };
  const pixels = new Uint8Array(w * h * 4);
  (kernel.kms as unknown as { currentFb: (id: number) => unknown }).currentFb = () => fb;
  (kernel.kms as unknown as { scanoutBytes: (id: number) => Uint8Array }).scanoutBytes = () => pixels;
  return pixels;
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
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => {
          throw new Error("should not be called for a 5-slot SAB");
        },
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

  it("webgl2-scanout presenter uploads + draws on content change and reports renderer id in slot 7", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 32, 24);
    const { gl, calls } = makeFakeGl();
    const canvas = makeFakeGlCanvas(gl);
    // Present-on-change gate reads the kernel-side commit count; bump
    // `commits` to simulate a PAGE_FLIP landing between ticks.
    let commits = 0;
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => BigInt(commits),
        kernel_kms_last_frame_us: (_crtc: number) => 0n,
      },
    };

    const statsSab = new SharedArrayBuffer(8 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsCanvas(1, canvas, statsSab, { mode: "webgl2-scanout" });

    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 0)).toBe(1);
    expect(Atomics.load(view, 2)).toBe(32);
    expect(Atomics.load(view, 3)).toBe(24);
    expect(Atomics.load(view, 7)).toBe(2);
    // First frame allocates the texture; no display size reported yet →
    // drawing buffer tracks the framebuffer.
    expect(calls.texImage2D).toBe(1);
    expect(calls.texSubImage2D).toBe(0);
    expect(calls.draws).toBe(1);
    expect(canvas.width).toBe(32);
    expect(canvas.height).toBe(24);

    // No flip since the last present → identical frame → skipped
    // entirely (no upload, no draw, no pump-frame count).
    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 0)).toBe(1);
    expect(calls.draws).toBe(1);

    // A flip landed → steady-state re-present via texSubImage2D.
    commits++;
    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 0)).toBe(2);
    expect(calls.texImage2D).toBe(1);
    expect(calls.texSubImage2D).toBe(1);

    // A reported display size forces a re-present (same content, new
    // size), resizes the drawing buffer and letterboxes the 4:3 fb
    // inside the 16:9 target: scale = min(640/32, 360/24) = 15 →
    // 480×360 content centered at x = 80.
    kernel.setKmsDisplaySize(1, 640, 360);
    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(Atomics.load(view, 0)).toBe(3);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(calls.viewports.at(-1)).toEqual([80, 0, 480, 360]);
  });

  it("webgl2-scanout content probe re-presents when the scanout mutates without a flip", () => {
    const kernel = makeKernel();
    const pixels = stubScanout(kernel, 32, 24);
    const { gl, calls } = makeFakeGl();
    const canvas = makeFakeGlCanvas(gl);
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => 0n,
        kernel_kms_last_frame_us: (_crtc: number) => 0n,
      },
    };
    const statsSab = new SharedArrayBuffer(8 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsCanvas(1, canvas, statsSab, { mode: "webgl2-scanout" });
    const tick = () => (kernel as unknown as { tickVblank: () => void }).tickVblank();

    tick();
    expect(Atomics.load(view, 0)).toBe(1);
    // Static content, static commit count: four skipped ticks include
    // one probe (every 4th), which sees an unchanged checksum.
    for (let i = 0; i < 4; i++) tick();
    expect(Atomics.load(view, 0)).toBe(1);

    // Mutate the bound bo without flipping — the pinned-scanout /
    // no-flip-renderer case. The next probe tick catches it.
    pixels.fill(0xa5, 0, 4096);
    for (let i = 0; i < 4; i++) tick();
    expect(Atomics.load(view, 0)).toBe(2);
    expect(calls.draws).toBe(2);
  });

  it("presentKms2d swizzles XRGB8888 → RGBA (R/B swap, opaque alpha)", () => {
    const kernel = makeKernel();
    const pixels = stubScanout(kernel, 2, 1);
    let painted: { data: Uint8ClampedArray } | null = null;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        putImageData: (img: { data: Uint8ClampedArray }) => { painted = img; },
      }),
    } as unknown as OffscreenCanvas;
    // DRM XRGB8888 is little-endian [B,G,R,X] per pixel.
    pixels.set([0xee, 0x88, 0x44, 0x00, 0x11, 0x22, 0x33, 0x00]);
    kernel.attachKmsCanvas(1, canvas, new SharedArrayBuffer(8 * 4), { mode: "2d" });
    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    expect(painted).not.toBeNull();
    // The regression this pins: a raw memcpy renders R and B swapped
    // (wlpaint's blue painted orange).
    expect([...painted!.data.subarray(0, 8)]).toEqual([
      0x44, 0x88, 0xee, 0xff,
      0x33, 0x22, 0x11, 0xff,
    ]);
  });

  it("GL claim/release hands the canvas between the pump presenter and a program context", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 32, 24);
    const { gl, calls } = makeFakeGl();
    const canvas = makeFakeGlCanvas(gl);
    let commits = 0;
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => BigInt(commits),
        kernel_kms_last_frame_us: (_crtc: number) => 0n,
      },
    };
    const statsSab = new SharedArrayBuffer(8 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsCanvas(1, canvas, statsSab, { mode: "webgl2-scanout" });
    const tick = () => (kernel as unknown as { tickVblank: () => void }).tickVblank();
    const cbs = (kernel as unknown as {
      kernel: { callbacks: {
        markKmsCanvasGlOwned: (crtc: number) => void;
        markKmsCanvasGlReleased: (crtc: number) => void;
      } };
    }).kernel.callbacks;

    tick();
    expect(Atomics.load(view, 7)).toBe(2);
    const frames = Atomics.load(view, 0);

    // A program GL context claims the canvas: the presenter stands down
    // (scanout texture freed), slot 7 reports 3, the pump stops painting.
    cbs.markKmsCanvasGlOwned(1);
    expect(Atomics.load(view, 7)).toBe(3);
    expect(calls.deletedTextures).toBe(1);
    commits++;
    tick();
    expect(Atomics.load(view, 0)).toBe(frames);

    // Release (the program degraded or exited): the pre-claim mode
    // resumes and the next tick rebuilds a presenter — a degrading GPU
    // compositor must never freeze the canvas.
    cbs.markKmsCanvasGlReleased(1);
    expect(Atomics.load(view, 7)).toBe(0);
    commits++;
    tick();
    expect(Atomics.load(view, 0)).toBe(frames + 1);
    expect(Atomics.load(view, 7)).toBe(2);
  });

  it("webgl2-scanout degrades to bilinear when a steady-state present overruns the frame budget", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 32, 24);
    const { gl, calls } = makeFakeGl();
    const canvas = makeFakeGlCanvas(gl);
    let commits = 0;
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => BigInt(commits),
        kernel_kms_last_frame_us: (_crtc: number) => 0n,
      },
    };
    kernel.attachKmsCanvas(1, canvas, new SharedArrayBuffer(8 * 4), { mode: "webgl2-scanout" });
    const tick = () => (kernel as unknown as { tickVblank: () => void }).tickVblank();
    const isBilinearMin = (p: number[]) =>
      p[1] === (gl as { TEXTURE_MIN_FILTER: number }).TEXTURE_MIN_FILTER &&
      p[2] === (gl as { LINEAR: number }).LINEAR;

    // Every performance.now() call advances 20 ms, so any measured
    // present exceeds the 16 ms budget (SwiftShader-style software GL).
    let fakeNow = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (fakeNow += 20));
    try {
      tick(); // warmup present is exempt from the budget
      expect(calls.mipmaps).toBe(1);
      expect(calls.texParams.filter(isBilinearMin)).toHaveLength(0);
      commits++;
      tick(); // steady-state present trips the budget → bilinear
      expect(calls.texParams.filter(isBilinearMin)).toHaveLength(1);
      commits++;
      tick(); // degraded presents skip the mip chain
      expect(calls.mipmaps).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("webgl2-scanout degrades to stats-only when WebGL2 is unavailable (Node host)", () => {
    const kernel = makeKernel();
    stubScanout(kernel, 16, 16);
    const canvas = makeFakeGlCanvas(null);
    const statsSab = new SharedArrayBuffer(8 * 4);
    const view = new Int32Array(statsSab);
    kernel.attachKmsCanvas(1, canvas, statsSab, { mode: "webgl2-scanout" });

    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    (kernel as unknown as { tickVblank: () => void }).tickVblank();
    // No pump frames, no renderer id — but scanout dims still publish.
    expect(Atomics.load(view, 0)).toBe(0);
    expect(Atomics.load(view, 7)).toBe(0);
    expect(Atomics.load(view, 2)).toBe(16);
    expect(Atomics.load(view, 3)).toBe(16);
    // The failed acquisition is cached — getContext isn't retried at 60 Hz.
    expect(canvas.getContextCalls).toBe(1);
  });

  it("attachKmsStats leaves slots 5/6 untouched when the SAB is too small", () => {
    const kernel = makeKernel();
    (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
      exports: {
        kernel_kms_commit_count: (_crtc: number) => {
          throw new Error("should not be called for a 5-slot SAB");
        },
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
