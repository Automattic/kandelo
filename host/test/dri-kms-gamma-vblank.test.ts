import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import type { KmsCursor } from "../src/dri/cursor-plane";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

/** The vblank pump presents each CRTC's output: with a color stage (legacy
 * gamma), the cursor plane is blended into the primary and the result
 * passes through the LUT; the cursor overlay then shows nothing. */

beforeAll(() => {
  if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
    (globalThis as { ImageData: unknown }).ImageData = class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    };
  }
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function makeKernel() {
  const kernel = createCentralizedKernelWorkerTestDouble({
    config: { maxWorkers: 1, dataBufferSize: 65_536, useSharedMemory: true },
    io: new NodePlatformIO(),
  });
  const exports = { kernel_vblank: () => 0 };
  installKernelWorkerTestScratch(kernel, new WebAssembly.Memory({ initial: 2 }), 128, 4,
    { kernelExports: exports, kernelExportNames: Object.keys(exports) });
  return kernel;
}

type Kernel = ReturnType<typeof makeKernel>;

/** A 2x1 XRGB8888 scanout: (10,20,30) then (40,50,60). */
function stubScanout(kernel: Kernel, cursor: () => KmsCursor): void {
  const fb = { fb_id: 10, bo_id: 100, width: 2, height: 1, pixel_format: 0x34325258, pitch: 8, x: 0, y: 0, offset: 0 };
  const bytes = new Uint8Array([30, 20, 10, 0, 60, 50, 40, 0]);
  const kms = kernel.kms as unknown as Record<string, unknown>;
  kms.currentFb = () => fb;
  kms.scanoutBytes = () => bytes;
  kms.cursorSnapshot = cursor;
}

function testLut(): Uint16Array {
  const lut = new Uint16Array(768);
  for (let i = 0; i < 256; i++) {
    lut[i] = (255 - i) << 8;
    lut[256 + i] = i << 8;
    lut[512 + i] = 0x8000;
  }
  return lut;
}

function cursor(x: number, version: number): KmsCursor {
  // A one-pixel opaque white cursor (premultiplied = straight).
  const white = new Uint8ClampedArray([255, 255, 255, 255]);
  return { version, x, y: 0, hotX: 0, hotY: 0, width: 1, height: 1, pixels: white, premultiplied: white.slice() };
}

function canvas2d() {
  const painted: number[][] = [];
  const cleared: number[][] = [];
  const canvas = {
    width: 0, height: 0,
    addEventListener() {},
    getContext: () => ({
      putImageData: (image: { data: Uint8ClampedArray }, x: number, y: number) => painted.push([x, y, ...image.data]),
      clearRect: (...rect: number[]) => cleared.push(rect),
    }),
  } as unknown as OffscreenCanvas;
  return { canvas, painted, cleared };
}

it("blends the cursor and applies the LUT in the 2D presenter, standing the overlay down", () => {
  const kernel = makeKernel();
  stubScanout(kernel, () => cursor(1, 1));
  const display = canvas2d(), overlay = canvas2d();
  kernel.attachKmsCanvas(1, display.canvas, undefined, { mode: "2d", cursorCanvas: overlay.canvas });
  vi.advanceTimersByTime(17);
  // No color stage: the primary as it is, the cursor on its overlay.
  expect(display.painted.at(-1)).toEqual([0, 0, 10, 20, 30, 255, 40, 50, 60, 255]);
  expect(overlay.painted).toEqual([[1, 0, 255, 255, 255, 255]]);

  kernel.kms.setGamma(1, testLut());
  vi.advanceTimersByTime(17);
  // Cursor over pixel 1, then red inverted, green kept, blue 0x80.
  expect(display.painted.at(-1)).toEqual([0, 0, 245, 20, 128, 255, 0, 255, 128, 255]);
  expect(overlay.painted.length, "the overlay paints nothing more").toBe(1);
  expect(overlay.cleared).toEqual([[1, 0, 1, 1]]);

  kernel.kms.setGamma(1, null);
  vi.advanceTimersByTime(17);
  expect(display.painted.at(-1)).toEqual([0, 0, 10, 20, 30, 255, 40, 50, 60, 255]);
  expect(overlay.painted.at(-1)).toEqual([1, 0, 255, 255, 255, 255]);
});

it("uploads the CRTC output to the WebGL2 scanout presenter and re-presents a moved cursor", () => {
  const kernel = makeKernel();
  let current = cursor(0, 1);
  stubScanout(kernel, () => current);
  const uploads: Array<{ format: number; pixels: number[] }> = [];
  const gl = new Proxy({
    isContextLost: () => false,
    getError: () => 0,
    getParameter: () => null,
    createShader: () => ({}), getShaderParameter: () => true,
    createProgram: () => ({}), getProgramParameter: () => true,
    createVertexArray: () => ({}), createTexture: () => ({}),
    getUniformLocation: () => ({}),
    RGBA: 0x1908, RGBA8: 0x8058, RGB: 0x1907, RGB565: 0x8d62, UNSIGNED_BYTE: 0x1401,
    UNSIGNED_SHORT_5_6_5: 0x8363, TEXTURE_2D: 0x0de1,
    texImage2D: (_t: number, _l: number, _if: number, _w: number, _h: number, _b: number,
      format: number, _type: number, pixels: Uint8Array) => uploads.push({ format, pixels: [...pixels] }),
    texSubImage2D: (_t: number, _l: number, _x: number, _y: number, _w: number, _h: number,
      format: number, _type: number, pixels: Uint8Array) => uploads.push({ format, pixels: [...pixels] }),
  } as Record<string, unknown>, {
    get: (target, key) => key in target ? target[key as string] : () => {},
  });
  const display = {
    width: 0, height: 0, addEventListener() {},
    getContext: (kind: string) => kind === "webgl2" ? gl : null,
  } as unknown as OffscreenCanvas;
  kernel.attachKmsCanvas(1, display, undefined, { mode: "webgl2-scanout" });
  kernel.kms.setGamma(1, testLut());
  vi.advanceTimersByTime(17);
  // RGBA rows: the white cursor at pixel 0, then the LUT.
  expect(uploads.at(-1)).toEqual({ format: 0x1908, pixels: [0, 255, 128, 255, 215, 50, 128, 255] });
  const count = uploads.length;
  vi.advanceTimersByTime(17);
  expect(uploads.length, "an unchanged output is not uploaded again").toBe(count);
  // Neither fb nor commit count moved; the cursor did.
  current = cursor(1, 2);
  vi.advanceTimersByTime(17);
  expect(uploads.at(-1)).toEqual({ format: 0x1908, pixels: [245, 20, 128, 255, 0, 255, 128, 255] });
});
