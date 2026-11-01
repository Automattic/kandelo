import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import type { KmsCursor } from "../src/dri/cursor-plane";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import { pixelGl } from "./support/kms-color-gl";

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

/** A WebGL2 scanout canvas over the pixel-modelling fake GL. */
function canvasGl(width: number, height: number) {
  const r = pixelGl(width, height);
  const canvas = {
    width: 0, height: 0, addEventListener() {},
    getContext: (kind: string) => kind === "webgl2" ? r.gl : null,
  } as unknown as OffscreenCanvas;
  return { ...r, canvas };
}

const lutUploads = (r: ReturnType<typeof pixelGl>) => r.uploads.filter(u => u.byteLength === 1024).length;

it("applies the LUT in the WebGL2 scanout presenter's shader, uploading only the raw scanout", () => {
  const kernel = makeKernel();
  let current = cursor(0, 1);
  stubScanout(kernel, () => current);
  const r = canvasGl(2, 1);
  kernel.attachKmsCanvas(1, r.canvas, undefined, { mode: "webgl2-scanout" });
  vi.advanceTimersByTime(17);
  // No stage: the XRGB bytes swizzled in the shader, cursor on its overlay.
  expect([...r.screen.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  const plainDraws = r.counts.draws;
  expect(plainDraws, "no LUT: one presenter draw").toBe(1);

  kernel.kms.setGamma(1, testLut());
  vi.advanceTimersByTime(17);
  // The white cursor at pixel 0, then red inverted, green kept, blue 0x80.
  expect([...r.screen.data]).toEqual([0, 255, 128, 255, 215, 50, 128, 255]);
  // Every upload is the raw scanout or the LUT: no CPU-corrected frame.
  const raw = [30, 20, 10, 0, 60, 50, 40, 0];
  expect(r.uploads.filter(u => u.byteLength !== 1024 && u.byteLength !== 4).map(u => [...u]))
    .toEqual(r.uploads.filter(u => u.byteLength !== 1024 && u.byteLength !== 4).map(() => raw));
  expect(lutUploads(r)).toBe(1);
  expect(r.counts.readPixels).toBe(0);
  const draws = r.counts.draws;
  vi.advanceTimersByTime(17);
  expect(r.counts.draws, "an unchanged output is not presented again").toBe(draws);
  // Neither fb nor commit count moved; the cursor did.
  current = cursor(1, 2);
  vi.advanceTimersByTime(17);
  expect([...r.screen.data]).toEqual([245, 20, 128, 255, 0, 255, 128, 255]);
  expect(lutUploads(r), "a moved cursor does not upload the LUT again").toBe(1);

  kernel.kms.setGamma(1, null);
  vi.advanceTimersByTime(17);
  expect([...r.screen.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
});

it("expands RGB565 scanout by bit replication before the LUT, as the CPU stage does", () => {
  const kernel = makeKernel();
  // One RGB565 pixel: r=3, g=5, b=1. scanoutRgba gives (24, 20, 8); a
  // normalized-float round would give (25, 20, 8).
  const fb = { fb_id: 10, bo_id: 100, width: 1, height: 1, pixel_format: 0x36314752, pitch: 2, x: 0, y: 0, offset: 0 };
  const word = (3 << 11) | (5 << 5) | 1;
  const kms = kernel.kms as unknown as Record<string, unknown>;
  kms.currentFb = () => fb;
  kms.scanoutBytes = () => new Uint8Array([word & 255, word >> 8]);
  kms.cursorSnapshot = () => cursor(5, 1);
  const r = canvasGl(1, 1);
  kernel.attachKmsCanvas(1, r.canvas, undefined, { mode: "webgl2-scanout" });
  kernel.kms.setGamma(1, testLut());
  vi.advanceTimersByTime(17);
  expect([...r.screen.data]).toEqual([255 - 24, 20, 128, 255]);
  expect(r.counts.readPixels).toBe(0);
});
