import { describe, expect, it, vi } from "vitest";
import { applyKmsGamma, compositeKmsCursor, kmsCrtcOutput, kmsGammaTable } from "../src/dri/kms-gamma";
import { KmsRegistry } from "../src/dri/kms-registry";
import type { KmsCursor } from "../src/dri/cursor-plane";
import { createWasmPosixKernelTestHarness, getKernelGraphicsAccess, WasmPosixKernel } from "../src/kernel";
import { hasNativeRepair } from "../src/webgl/native-recovery";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { pixelGl } from "./support/kms-color-gl";

/** The CRTC color stage: legacy gamma (kms_color legacy-gamma) applies to
 * the CRTC output, after the cursor plane is blended over the primary. */

// Red inverted, green identity, blue a constant 0x80: no channel is left
// unchecked and the LUT is not the identity.
function testLut(): Uint16Array {
  const lut = new Uint16Array(768);
  for (let i = 0; i < 256; i++) {
    lut[i] = (255 - i) << 8;
    lut[256 + i] = i << 8;
    lut[512 + i] = 0x8000;
  }
  return lut;
}
const corrected = (r: number, g: number, _b: number) => [255 - r, g, 128];

function cursorAt(x: number, y: number, rgba: number[], version = 1): KmsCursor {
  // One premultiplied pixel.
  const premultiplied = new Uint8ClampedArray(rgba);
  const a = rgba[3];
  const pixels = new Uint8ClampedArray([0, 1, 2].map(c => a ? rgba[c] * 255 / a : 0).concat(a));
  return { version, x, y, hotX: 0, hotY: 0, width: 1, height: 1, pixels, premultiplied };
}

describe("CRTC color stage", () => {
  it("reduces 16-bit LUT entries like drm_color_lut_extract(…, 8); identity is no stage", () => {
    const identity = new Uint16Array(768);
    for (let i = 0; i < 768; i++) identity[i] = (i & 255) << 8;
    expect(kmsGammaTable(identity)).toBeNull();
    // kms_color legacy-gamma: entry 0 black, every other entry 0xffff.
    const maxed = new Uint16Array(768).fill(0xffff);
    maxed[0] = maxed[256] = maxed[512] = 0;
    const table = kmsGammaTable(maxed)!;
    expect([table[0], table[1], table[255], table[256], table[257], table[512], table[767]])
      .toEqual([0, 255, 255, 0, 255, 0, 255]);
    // Rounding to nearest, not truncation: 0x0080 -> 1, 0x017f -> 1.
    const rounded = identity.slice();
    rounded[0] = 0x0080; rounded[2] = 0x017f;
    expect([...kmsGammaTable(rounded)!.subarray(0, 3)]).toEqual([1, 1, 1]);
    expect(() => kmsGammaTable(new Uint16Array(3))).toThrow("Invalid KMS gamma LUT size");
  });

  it("keeps the registry's color stage per CRTC and versions only real changes", () => {
    const kms = new KmsRegistry({} as never);
    expect(kms.gamma(1)).toBeNull();
    kms.setGamma(1, testLut());
    const first = kms.gamma(1)!;
    expect([...first.table.subarray(0, 2)]).toEqual([255, 254]);
    expect(kms.gamma(2)).toBeNull();
    kms.setGamma(1, testLut());
    expect(kms.gamma(1)!.version).toBe(first.version);
    const other = testLut(); other[0] = 0;
    kms.setGamma(1, other);
    expect(kms.gamma(1)!.version).toBeGreaterThan(first.version);
    const identity = new Uint16Array(768);
    for (let i = 0; i < 768; i++) identity[i] = (i & 255) << 8;
    kms.setGamma(1, identity);
    expect(kms.gamma(1)).toBeNull();
    kms.setGamma(1, testLut());
    kms.setGamma(1, null);
    expect(kms.gamma(1)).toBeNull();
  });

  it("blends the premultiplied cursor before the LUT, clipped to the CRTC", () => {
    // 2x2 primary, top row first.
    const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    // Half-covered white at (1, 0): c + p * (255 - a) / 255.
    compositeKmsCursor(rgba, 2, 2, cursorAt(1, 0, [128, 128, 128, 128]));
    expect([...rgba.subarray(4, 8)]).toEqual([
      Math.round(128 + 40 * 127 / 255), Math.round(128 + 50 * 127 / 255), Math.round(128 + 60 * 127 / 255), 255,
    ]);
    // GL row order puts CRTC row 0 at the bottom.
    const gl = new Uint8Array(16);
    compositeKmsCursor(gl, 2, 2, cursorAt(0, 0, [255, 0, 0, 255]), true);
    expect([...gl.subarray(8, 12)]).toEqual([255, 0, 0, 0]);
    // Off-CRTC positions touch nothing; a transparent pixel blends nothing.
    const before = rgba.slice();
    compositeKmsCursor(rgba, 2, 2, cursorAt(-1, 0, [255, 255, 255, 255]));
    compositeKmsCursor(rgba, 2, 2, cursorAt(2, 1, [255, 255, 255, 255]));
    compositeKmsCursor(rgba, 2, 2, cursorAt(0, 0, [0, 0, 0, 0]));
    expect(rgba).toEqual(before);
    applyKmsGamma(rgba, kmsGammaTable(testLut())!);
    expect([...rgba.subarray(0, 4)]).toEqual([...corrected(10, 20, 30), 255]);
  });
});

const PID = 101;
const lutPointer = 0x2000;

function kernelHarness(gl: WebGL2RenderingContext, canvas: { width: number; height: number }) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const presentCanvas = { ...canvas, getContext: () => gl };
  const kernel = createWasmPosixKernelTestHarness({
    io: {} as any,
    callbacks: {
      getKmsCanvas: () => presentCanvas,
      getKmsCrtcIds: () => [1],
      markKmsCanvasGlOwned: () => {},
      getKmsDisplaySize: () => ({ width: canvas.width, height: canvas.height }),
    } as any,
    memory,
    pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
  }) as WasmPosixKernel & Record<string, any>;
  const imports = kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
  const setGamma = (lut: Uint16Array | null) => {
    if (lut) new Uint16Array(memory.buffer, lutPointer, 768).set(lut);
    imports.env.host_kms_set_gamma(1, lut ? lutPointer : 0, lut ? 256 : 0);
  };
  return { kernel, imports, memory, canvas: presentCanvas, setGamma };
}

const lutUploads = (r: ReturnType<typeof pixelGl>) => r.uploads.filter(u => u.byteLength === 1024).length;

describe("CRTC color stage in the host presentation paths", () => {
  it("takes the kernel's LUT from kernel memory, and none clears it", () => {
    const r = pixelGl(1, 1);
    const { kernel, setGamma } = kernelHarness(r.gl, { width: 1, height: 1 });
    setGamma(testLut());
    expect([...kernel.kms.gamma(1)!.table.subarray(254, 258)]).toEqual([1, 0, 0, 1]);
    setGamma(null);
    expect(kernel.kms.gamma(1)).toBeNull();
  });

  it("presents a direct GPU scanout through the LUT on the GPU, cursor blended, alpha opaque", () => {
    // 2x2 BO, top row first: rows (A B) over (C D), alpha 7.
    const bo = [10, 20, 30, 7, 40, 50, 60, 7, 70, 80, 90, 7, 100, 110, 120, 7];
    const plain = pixelGl(2, 2), corrected2 = pixelGl(2, 2);
    const shown: number[][] = [];
    for (const [r, gamma] of [[plain, false], [corrected2, true]] as const) {
      const { kernel, setGamma } = kernelHarness(r.gl, { width: 2, height: 2 });
      vi.spyOn(kernel.gl, "gpuBo").mockReturnValue({ gl: r.gl, fbo: r.framebuffer(2, 2, bo), w: 2, h: 2 } as any);
      if (gamma) setGamma(testLut());
      vi.spyOn(kernel.kms, "currentCursor").mockReturnValue(cursorAt(1, 0, [255, 255, 255, 255]));
      for (let tick = 0; tick < 3; tick++) {
        expect(getKernelGraphicsAccess(kernel).gpuScanout(
          { bo_id: 42, width: 2, height: 2, x: 0, y: 0 } as any, { width: 2, height: 2, getContext: () => r.gl } as any, true, 1,
        )).toEqual({ direct: true });
      }
      expect(r.counts.readPixels, "no frame is read back to the CPU").toBe(0);
      shown.push([...r.screen.data]);
    }
    // Without a color stage: the BO flipped onto the canvas, opaque, and the
    // cursor is the overlay's (not blended into the primary). No stage draw.
    expect(shown[0]).toEqual([70, 80, 90, 255, 100, 110, 120, 255, 10, 20, 30, 255, 40, 50, 60, 255]);
    expect(plain.counts.draws, "no LUT, no added work").toBe(0);
    // With one: the same frame with the cursor blended at CRTC (1, 0) — the
    // top right, GL row 1 — then every color through the LUT.
    expect(shown[1]).toEqual([
      ...corrected(70, 80, 90), 255, ...corrected(100, 110, 120), 255,
      ...corrected(10, 20, 30), 255, ...corrected(255, 255, 255), 255,
    ]);
    expect(lutUploads(corrected2), "the LUT is uploaded once per change, not per present").toBe(1);
  });

  it("presents immediate flips and vblank with identical opaque RGB, without changing BO alpha or native state", () => {
    const r = pixelGl(2, 2);
    const h = kernelHarness(r.gl, { width: 2, height: 2 });
    h.kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 128, cmdbufLen: 0 });
    const binding = h.kernel.gl.get(PID)!;
    binding.gl = r.gl; binding.canvas = h.canvas as HTMLCanvasElement;
    binding.claimedKmsCrtc = 1;
    // Every channel and BO row differs. Alpha must survive in the shared BO
    // for image consumers even though neither scanout route may expose it.
    const pixels = [10, 20, 30, 0, 40, 50, 60, 7, 70, 80, 90, 128, 100, 110, 120, 254];
    const fbo = r.framebuffer(2, 2, pixels);
    const storage = { gl: r.gl, fbo, w: 2, h: 2 };
    const boPixels = r.textures.get(r.framebuffers.get(fbo)!.color!)!.data;
    vi.spyOn(h.kernel.gl, "gpuBo").mockReturnValue(storage as any);
    h.imports.env.host_kms_addfb(PID, 9, 99, 2, 2, 0x34325258, 8, 0);
    r.state.set(0x0c23, [true, false, true, false]);
    r.state.set(0x0c22, [0.25, 0.5, 0.75, 0.125]);
    const before = r.snapshot();
    const expected = [70, 80, 90, 255, 100, 110, 120, 255, 10, 20, 30, 255, 40, 50, 60, 255];
    for (let frame = 0; frame < 2; frame++) {
      r.screen.data.fill(0);
      h.imports.env.host_kms_set_fb(PID, 1, 9, 0, 0, 2, 2);
      expect([...r.screen.data], "the immediate page flip is opaque, not just the later pump").toEqual(expected);
      expect(r.state).toEqual(before);
      expect([...boPixels]).toEqual(pixels);
      r.screen.data.fill(0);
      expect(getKernelGraphicsAccess(h.kernel).gpuScanout(
        h.kernel.kms.currentFb(1)!, h.canvas as any, true, 1, frame + 1,
      )).toEqual({ direct: true });
      expect([...r.screen.data], "vblank presents exactly the same RGB and alpha").toEqual(expected);
      expect(r.state).toEqual(before);
      expect([...boPixels]).toEqual(pixels);
    }
    expect(r.counts.readPixels).toBe(0);
    expect(hasNativeRepair(r.gl)).toBe(false);
  });

  it.each([
    // 2x1 BO pixels (one row): 10-bit words, or half floats R,G,B,A.
    ["RGB10_A2", 0x8059, [0xff, 0x03, 0x08, 0x00, 0x02, 0x00, 0xf0, 0xff], [255, 128, 0, 0, 0, 255]],
    ["RGBA16F", 0x881a, [0x00, 0x3c, 0x00, 0x38, 0x00, 0x7e, 0x00, 0x3c, 0x00, 0x40, 0x00, 0x1c, 0x00, 0xbc, 0x00, 0x3c],
      [255, 128, 0, 255, 1, 0]],
  ])("reduces a %s GPU scanout to 8 bits through the output stage, directly and by readback", (_name, internal, bo, rgb) => {
    for (const gamma of [false, true]) {
      const r = pixelGl(2, 1);
      const { kernel, setGamma } = kernelHarness(r.gl, { width: 2, height: 1 });
      vi.spyOn(kernel.gl, "gpuBo").mockReturnValue(
        { gl: r.gl, fbo: r.framebuffer(2, 1, bo, internal), w: 2, h: 1, internalFormat: internal } as any);
      vi.spyOn(kernel.kms, "currentCursor").mockReturnValue(cursorAt(5, 0, [255, 255, 255, 255]));
      if (gamma) setGamma(testLut());
      const fb = { bo_id: 42, width: 2, height: 1, x: 0, y: 0 } as any;
      const canvas = { width: 2, height: 1, getContext: () => r.gl } as any;
      expect(getKernelGraphicsAccess(kernel).gpuScanout(fb, canvas, true, 1)).toEqual({ direct: true });
      const expected = [rgb.slice(0, 3), rgb.slice(3)].flatMap(([red, green, blue]) =>
        gamma ? [...corrected(red, green, blue), 255] : [red, green, blue, 255]);
      expect([...r.screen.data], gamma ? "through the LUT" : "reduced").toEqual(expected);
      expect(r.counts.readPixels).toBe(0);
      // Another display context reads the BO back and gets the same bytes.
      const frame = getKernelGraphicsAccess(kernel).gpuScanout(fb, canvas, false, 1);
      expect(frame && !frame.direct && [...frame.pixels]).toEqual([...rgb.slice(0, 3), 255, ...rgb.slice(3), 255]);
    }
  });

  it("re-presents an unchanged staged GPU scanout only when its LUT, cursor or content changes", () => {
    const bo = [10, 20, 30, 7, 40, 50, 60, 7, 70, 80, 90, 7, 100, 110, 120, 7];
    const r = pixelGl(2, 2);
    // The canvas keeps its frame (kernel contexts request preserveDrawingBuffer).
    (r.gl as any).getContextAttributes = () => ({ preserveDrawingBuffer: true });
    const { kernel, setGamma } = kernelHarness(r.gl, { width: 2, height: 2 });
    vi.spyOn(kernel.gl, "gpuBo").mockReturnValue({ gl: r.gl, fbo: r.framebuffer(2, 2, bo), w: 2, h: 2 } as any);
    setGamma(testLut());
    const cursor = vi.spyOn(kernel.kms, "currentCursor").mockReturnValue(cursorAt(1, 0, [255, 255, 255, 255]));
    const canvas = { width: 2, height: 2, getContext: () => r.gl } as any;
    const fb = { fb_id: 3, bo_id: 42, width: 2, height: 2, x: 0, y: 0 } as any;
    const present = () => expect(getKernelGraphicsAccess(kernel).gpuScanout(fb, canvas, true, 1, 1)).toEqual({ direct: true });
    for (let tick = 0; tick < 3; tick++) present();
    const presented = r.counts.draws, frame = [...r.screen.data];
    expect(presented).toBeGreaterThan(0);
    present(); present();
    expect(r.counts.draws, "an unchanged stage is not drawn again").toBe(presented);
    cursor.mockReturnValue(cursorAt(0, 0, [255, 255, 255, 255], 2));
    present();
    expect(r.counts.draws, "a moved cursor is blended again").toBeGreaterThan(presented);
    expect([...r.screen.data]).not.toEqual(frame);
    const moved = r.counts.draws;
    setGamma(new Uint16Array(768).fill(0xffff));
    present();
    expect(r.counts.draws, "a new LUT is applied").toBeGreaterThan(moved);
    expect([...r.screen.data]).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    const relut = r.counts.draws;
    present();
    expect(r.counts.draws).toBe(relut);
  });

  /** A KMS-master GL session presenting its EGL window on CRTC 1's canvas. */
  function windowSession(width = 2, height = 2) {
    const r = pixelGl(width, height);
    const h = kernelHarness(r.gl, { width, height });
    h.kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 128, cmdbufLen: 0 });
    const binding = h.kernel.gl.get(PID)!;
    binding.cmdbufView = new Uint8Array(h.memory.buffer, 128, 0);
    h.imports.env.host_kms_set_master(PID, 1n, 1n);
    // Modeset order: the CRTC scans a width x height mode, which sizes the
    // canvas the session claims.
    h.imports.env.host_kms_addfb(PID, 9, 99, width, height, 0x34325258, width * 4, 0);
    h.imports.env.host_kms_set_fb(PID, 1, 9, 0, 0, width, height);
    expect(h.imports.env.host_gl_create_context(PID, 1, 0, 0)).toBe(0);
    expect([h.canvas.width, h.canvas.height]).toEqual([width, height]);
    expect(binding.claimedKmsCrtc).toBe(1);
    const target = () => {
      const color = r.framebuffers.get(binding.presentTarget!.fbo as object)!.color!;
      return r.textures.get(color)!;
    };
    const cursor = vi.spyOn(h.kernel.kms, "currentCursor").mockReturnValue(
      { version: 0, x: 0, y: 0, hotX: 0, hotY: 0, width: 0, height: 0, pixels: null, premultiplied: null });
    return { ...r, ...h, binding, target, cursor };
  }

  it("passes a presented EGL window frame through the CRTC color stage without a readback", () => {
    const s = windowSession();
    // GL order: bottom row (C D), top row (A B); the window keeps its alpha.
    s.target().data.set([70, 80, 90, 9, 100, 110, 120, 9, 10, 20, 30, 9, 40, 50, 60, 9]);
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    expect([...s.screen.data]).toEqual([70, 80, 90, 9, 100, 110, 120, 9, 10, 20, 30, 9, 40, 50, 60, 9]);
    s.setGamma(testLut());
    s.cursor.mockReturnValue(cursorAt(0, 0, [255, 0, 0, 255]));
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    expect([...s.screen.data]).toEqual([
      ...corrected(70, 80, 90), 9, ...corrected(100, 110, 120), 9,
      ...corrected(255, 0, 0), 9, ...corrected(40, 50, 60), 9,
    ]);
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    expect(s.counts.readPixels, "no frame is read back to the CPU").toBe(0);
    expect(lutUploads(s)).toBe(1);
    expect([...s.unitSamplers.values()].every(sampler => sampler === null), "no sampler object is left bound").toBe(true);
    expect(hasNativeRepair(s.gl)).toBe(false);
  });

  it("matches the CPU color stage bit for bit: partial cursor alpha, every channel, arbitrary LUT", () => {
    const s = windowSession(4, 3);
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 16 & 255;
    const frame = Array.from({ length: 4 * 3 * 4 }, (_, i) => (i & 3) === 3 ? 255 : next());
    const lut = new Uint16Array(768).map(() => next() << 8 | next());
    // A 2x2 premultiplied cursor straddling the right edge, with alphas
    // 0 (but colored), 1, 128 and 254.
    const premultiplied = new Uint8ClampedArray([9, 0, 3, 0, 1, 0, 1, 1, 100, 50, 7, 128, 200, 254, 13, 254]);
    const cursor: KmsCursor = { version: 3, x: 3, y: 1, hotX: 0, hotY: 0, width: 2, height: 2,
      pixels: premultiplied.slice(), premultiplied };
    s.target().data.set(frame);
    s.setGamma(lut);
    s.cursor.mockReturnValue(cursor);
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    const expected = Uint8Array.from(frame);
    kmsCrtcOutput(expected, 4, 3, s.kernel.kms.gamma(1), cursor, true);
    expect([...s.screen.data]).toEqual([...expected]);
    expect(s.counts.readPixels).toBe(0);
  });

  it("re-presents a static window frame when the LUT or the cursor changes, and restores it when the stage ends", () => {
    const s = windowSession();
    const frame = [70, 80, 90, 255, 100, 110, 120, 255, 10, 20, 30, 255, 40, 50, 60, 255];
    s.target().data.set(frame);
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    const access = getKernelGraphicsAccess(s.kernel);
    // No stage, nothing to do.
    const idle = { ...s.counts };
    access.presentCrtcOutput(1);
    expect(s.counts).toEqual(idle);
    // The guest presents nothing more, but SETGAMMA must still show.
    s.setGamma(testLut());
    access.presentCrtcOutput(1);
    expect([...s.screen.data]).toEqual(frame.map((v, i) => (i & 3) === 3 ? v : corrected(
      frame[i - (i & 3)], frame[i - (i & 3) + 1], frame[i - (i & 3) + 2])[i & 3]));
    const draws = s.counts.draws;
    access.presentCrtcOutput(1);
    expect(s.counts.draws, "an unchanged stage is not re-presented").toBe(draws);
    // A moved cursor is blended into the same (retained, uncorrected) frame.
    s.cursor.mockReturnValue(cursorAt(1, 1, [255, 255, 255, 255], 5));
    access.presentCrtcOutput(1);
    expect([...s.screen.data.subarray(4, 8)]).toEqual([...corrected(255, 255, 255), 255]);
    expect([...s.screen.data.subarray(12, 16)]).toEqual([...corrected(40, 50, 60), 255]);
    // The stage ends: the frame as presented, cursor back on its overlay.
    s.setGamma(null);
    access.presentCrtcOutput(1);
    expect([...s.screen.data]).toEqual(frame);
    const settled = { ...s.counts };
    access.presentCrtcOutput(1);
    expect(s.counts).toEqual(settled);
    expect(s.counts.readPixels, "no frame is read back to the CPU").toBe(0);
  });

  it("corrects a frame drawn straight to the canvas before its present target existed", () => {
    const s = windowSession(1, 1);
    s.setGamma(testLut());
    // The session lost its target (as after EGL window recreation) and drew
    // its frame straight to the canvas.
    s.binding.surface.presentTarget = null;
    s.binding.surface.renderTargetFbo = null;
    s.setScreen([10, 20, 30, 255]);
    s.selectDefaultReadBuffer(0);
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    expect([...s.screen.data]).toEqual([...corrected(10, 20, 30), 255]);
    expect(s.counts.readPixels, "no frame is read back to the CPU").toBe(0);
    expect(s.defaultReadBuffer(), "the session's read buffer selection is restored").toBe(0);
  });

  it("corrects a GPU framebuffer flipped onto the session's own canvas at SETCRTC", () => {
    const s = windowSession();
    const fbo = s.framebuffer(2, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    vi.spyOn(s.kernel.gl, "gpuBo").mockReturnValue({ gl: s.gl, fbo, w: 2, h: 2 } as any);
    s.setGamma(testLut());
    s.imports.env.host_kms_addfb(PID, 10, 100, 2, 2, 0x34325258, 8, 0);
    s.imports.env.host_kms_set_fb(PID, 1, 10, 0, 0, 2, 2);
    expect([...s.screen.data]).toEqual([
      ...corrected(9, 10, 11), 255, ...corrected(13, 14, 15), 255,
      ...corrected(1, 2, 3), 255, ...corrected(5, 6, 7), 255,
    ]);
    expect(s.counts.readPixels, "no frame is read back to the CPU").toBe(0);
  });
});
