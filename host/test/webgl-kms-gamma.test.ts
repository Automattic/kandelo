import { describe, expect, it, vi } from "vitest";
import { applyKmsGamma, compositeKmsCursor, kmsGammaTable } from "../src/dri/kms-gamma";
import { KmsRegistry } from "../src/dri/kms-registry";
import type { KmsCursor } from "../src/dri/cursor-plane";
import { createWasmPosixKernelTestHarness, getKernelGraphicsAccess, WasmPosixKernel } from "../src/kernel";
import { drawKmsOutput, readDefaultFramebuffer } from "../src/webgl/kms-scanout";
import { hasNativeRepair } from "../src/webgl/native-recovery";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

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

/** A WebGL2 fake that models pixels: textures, framebuffer color
 * attachments, the default framebuffer (the canvas) and blits. */
function pixelGl(width: number, height: number) {
  type Image = { w: number; h: number; data: Uint8Array };
  const textures = new Map<object, Image>();
  const framebuffers = new Map<object, { color: object | null }>();
  const screen: Image = { w: width, h: height, data: new Uint8Array(width * height * 4) };
  const guestRead = {}, guestDraw = {}, guestTexture = {}, guestUnpack = {}, guestPack = {};
  const state = new Map<number, unknown>([
    [0x84e0, 0x84c0], [0x8caa, guestRead], [0x8ca6, guestDraw], [0x8069, guestTexture],
    [0x88ef, guestUnpack], [0x88ed, guestPack], [0x0c11, true],
    [0x0cf5, 1], [0x0cf2, 7], [0x0cf4, 2], [0x0cf3, 3], [0x9240, true], [0x9241, true],
    [0x0d05, 8], [0x0d02, 5], [0x0d04, 1], [0x0d03, 1],
    [0x0c23, [true, true, true, true]], [0x0c22, [0, 0, 0, 0]],
  ]);
  let defaultReadBuffer = 0x0405;
  const uploads: Uint8Array[] = [];
  let lost = false;
  for (const target of [guestRead, guestDraw]) framebuffers.set(target, { color: null });
  const image = (fbo: unknown): Image => {
    if (fbo === null) return screen;
    const color = framebuffers.get(fbo as object)?.color;
    const found = color && textures.get(color);
    if (!found) throw new Error("framebuffer without color storage");
    return found;
  };
  const core = {
    isContextLost: () => lost,
    getError: () => 0,
    getExtension: () => null,
    getParameter: (p: number) => p === 0x0c02
      ? (state.get(0x8caa) === null ? defaultReadBuffer : 0x8ce0)
      : state.get(p) ?? null,
    createTexture: () => { const t = {}; textures.set(t, { w: 0, h: 0, data: new Uint8Array() }); return t; },
    createFramebuffer: () => { const f = {}; framebuffers.set(f, { color: null }); return f; },
    createRenderbuffer: () => ({}),
    deleteTexture: (t: object) => { textures.delete(t); },
    deleteFramebuffer: (f: object) => { framebuffers.delete(f); },
    bindTexture: (_target: number, value: unknown) => state.set(0x8069, value),
    bindRenderbuffer: (_target: number, value: unknown) => state.set(0x8ca7, value),
    bindFramebuffer: (target: number, value: unknown) => {
      if (target === 0x8d40 || target === 0x8ca8) state.set(0x8caa, value);
      if (target === 0x8d40 || target === 0x8ca9) state.set(0x8ca6, value);
    },
    bindBuffer: (target: number, value: unknown) => {
      state.set(target === 0x88eb ? 0x88ed : target === 0x88ec ? 0x88ef : target, value);
    },
    // WebGL reports the FLIP_Y/PREMULTIPLY_ALPHA flags as booleans.
    pixelStorei: (name: number, value: unknown) =>
      state.set(name, name === 0x9240 || name === 0x9241 ? Boolean(value) : value),
    enable: (name: number) => state.set(name, true),
    disable: (name: number) => state.set(name, false),
    colorMask: (...value: boolean[]) => state.set(0x0c23, value),
    clearColor: (...value: number[]) => state.set(0x0c22, value),
    readBuffer: (value: number) => {
      if (state.get(0x8caa) !== null) throw new Error("test reads only the default read buffer");
      defaultReadBuffer = value;
    },
    clear: () => {
      const mask = state.get(0x0c23) as boolean[], clear = state.get(0x0c22) as number[];
      const target = image(state.get(0x8ca6));
      for (let i = 0; i < target.data.length; i++) if (mask[i & 3]) target.data[i] = clear[i & 3] * 255;
    },
    texImage2D: (_t: number, _l: number, _if: number, w: number, h: number, _b: number,
      _f: number, _ty: number, pixels: Uint8Array | null) => {
      if (pixels) {
        // The upload must not be reshaped by caller unpack state.
        expect(state.get(0x88ef)).toBeNull();
        expect([0x0cf2, 0x0cf4, 0x0cf3, 0x9240, 0x9241].map(p => Number(state.get(p)))).toEqual([0, 0, 0, 0, 0]);
        uploads.push(Uint8Array.from(pixels));
      }
      textures.set(state.get(0x8069) as object, { w, h, data: pixels ? Uint8Array.from(pixels) : new Uint8Array(w * h * 4) });
    },
    framebufferTexture2D: (target: number, _attachment: number, _textarget: number, tex: object) => {
      const fbo = state.get(target === 0x8ca9 || target === 0x8d40 ? 0x8ca6 : 0x8caa) as object;
      framebuffers.get(fbo)!.color = tex;
    },
    checkFramebufferStatus: () => 0x8cd5,
    readPixels: (x: number, y: number, w: number, h: number, _f: number, _t: number, out: Uint8Array) => {
      expect(state.get(0x88ed)).toBeNull();
      expect([0x0d02, 0x0d04, 0x0d03].map(p => state.get(p))).toEqual([0, 0, 0]);
      const read = state.get(0x8caa);
      if (read === null && defaultReadBuffer !== 0x0405) throw new Error("no read buffer");
      const source = image(read);
      for (let row = 0; row < h; row++) {
        const at = ((y + row) * source.w + x) * 4;
        out.set(source.data.subarray(at, at + w * 4), row * w * 4);
      }
    },
    blitFramebuffer: (sx0: number, sy0: number, sx1: number, sy1: number,
      dx0: number, dy0: number, dx1: number, dy1: number) => {
      expect(state.get(0x0c11)).toBe(false);
      const source = image(state.get(0x8caa)), target = image(state.get(0x8ca6));
      const w = Math.abs(dx1 - dx0), h = Math.abs(dy1 - dy0);
      const step = (from: number, to: number, i: number) => from < to ? from + i : from - 1 - i;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const s = (step(sy0, sy1, j) * source.w + step(sx0, sx1, i)) * 4;
        const d = (step(dy0, dy1, j) * target.w + step(dx0, dx1, i)) * 4;
        target.data.set(source.data.subarray(s, s + 4), d);
      }
    },
  };
  const gl = new Proxy(core, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => {},
  }) as unknown as WebGL2RenderingContext;
  /** A texture-backed framebuffer holding `rows` (GL order: bottom first). */
  const framebuffer = (w: number, h: number, data: number[]) => {
    const tex = {}, fbo = {};
    textures.set(tex, { w, h, data: Uint8Array.from(data) });
    framebuffers.set(fbo, { color: tex });
    return fbo as WebGLFramebuffer;
  };
  return {
    gl, state, screen, uploads, textures, framebuffers, framebuffer,
    snapshot: () => new Map(state),
    defaultReadBuffer: () => defaultReadBuffer,
    selectDefaultReadBuffer: (value: number) => { defaultReadBuffer = value; },
    setScreen: (data: number[]) => screen.data.set(data),
    loseContext: () => { lost = true; },
  };
}

describe("CRTC output on a GL canvas", () => {
  it("uploads the finished output to a transient texture and restores every changed selector", () => {
    const r = pixelGl(2, 1);
    const before = r.snapshot(), objects = [r.textures.size, r.framebuffers.size];
    expect(drawKmsOutput(r.gl, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1)).toBe(true);
    expect([...r.screen.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.snapshot()).toEqual(before);
    expect([r.textures.size, r.framebuffers.size], "transient objects are deleted").toEqual(objects);
    expect(hasNativeRepair(r.gl)).toBe(false);
    expect(drawKmsOutput(r.gl, new Uint8Array(4), 2, 1)).toBe(false);
  });

  it("reads the default framebuffer through BACK and restores a session's read buffer", () => {
    const r = pixelGl(1, 2);
    r.setScreen([1, 2, 3, 4, 5, 6, 7, 8]);
    r.selectDefaultReadBuffer(0);
    const before = r.snapshot();
    expect([...readDefaultFramebuffer(r.gl, 1, 2)!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.defaultReadBuffer()).toBe(0);
    expect(r.snapshot()).toEqual(before);
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

describe("CRTC color stage in the host presentation paths", () => {
  it("takes the kernel's LUT from kernel memory, and none clears it", () => {
    const r = pixelGl(1, 1);
    const { kernel, setGamma } = kernelHarness(r.gl, { width: 1, height: 1 });
    setGamma(testLut());
    expect([...kernel.kms.gamma(1)!.table.subarray(254, 258)]).toEqual([1, 0, 0, 1]);
    setGamma(null);
    expect(kernel.kms.gamma(1)).toBeNull();
  });

  it("presents a direct GPU scanout through the LUT with the cursor blended, alpha opaque", () => {
    // 2x2 BO, top row first: rows (A B) over (C D), alpha 7.
    const bo = [10, 20, 30, 7, 40, 50, 60, 7, 70, 80, 90, 7, 100, 110, 120, 7];
    const plain = pixelGl(2, 2), corrected2 = pixelGl(2, 2);
    const shown: number[][] = [];
    for (const [r, gamma] of [[plain, false], [corrected2, true]] as const) {
      const { kernel, setGamma } = kernelHarness(r.gl, { width: 2, height: 2 });
      vi.spyOn(kernel.gl, "gpuBo").mockReturnValue({ gl: r.gl, fbo: r.framebuffer(2, 2, bo), w: 2, h: 2 } as any);
      if (gamma) setGamma(testLut());
      vi.spyOn(kernel.kms, "currentCursor").mockReturnValue(cursorAt(1, 0, [255, 255, 255, 255]));
      const before = r.snapshot();
      expect(getKernelGraphicsAccess(kernel).gpuScanout(
        { bo_id: 42, width: 2, height: 2, x: 0, y: 0 } as any, { width: 2, height: 2, getContext: () => r.gl } as any, true, 1,
      )).toEqual({ direct: true });
      expect(r.snapshot()).toEqual(before);
      shown.push([...r.screen.data]);
    }
    // Without a color stage: the BO flipped onto the canvas, opaque, and the
    // cursor is the overlay's (not blended into the primary).
    expect(shown[0]).toEqual([70, 80, 90, 255, 100, 110, 120, 255, 10, 20, 30, 255, 40, 50, 60, 255]);
    // With one: the same frame with the cursor blended at CRTC (1, 0) — the
    // top right, GL row 1 — then every color through the LUT.
    expect(shown[1]).toEqual([
      ...corrected(70, 80, 90), 255, ...corrected(100, 110, 120), 255,
      ...corrected(10, 20, 30), 255, ...corrected(255, 255, 255), 255,
    ]);
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

  it("passes a presented EGL window frame through the CRTC color stage", () => {
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
    expect(hasNativeRepair(s.gl)).toBe(false);
  });

  it("re-presents a static window frame when the LUT or the cursor changes, and ends the stage", () => {
    const s = windowSession();
    const frame = [70, 80, 90, 255, 100, 110, 120, 255, 10, 20, 30, 255, 40, 50, 60, 255];
    s.target().data.set(frame);
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    const access = getKernelGraphicsAccess(s.kernel);
    // No stage, nothing to do.
    access.presentCrtcOutput(1);
    expect(s.uploads).toEqual([]);
    // The guest presents nothing more, but SETGAMMA must still show.
    s.setGamma(testLut());
    access.presentCrtcOutput(1);
    expect([...s.screen.data]).toEqual(frame.map((v, i) => (i & 3) === 3 ? v : corrected(
      frame[i - (i & 3)], frame[i - (i & 3) + 1], frame[i - (i & 3) + 2])[i & 3]));
    const uploads = s.uploads.length;
    access.presentCrtcOutput(1);
    expect(s.uploads.length, "an unchanged stage is not re-presented").toBe(uploads);
    // A moved cursor is blended into the same (cached, uncorrected) frame.
    s.cursor.mockReturnValue(cursorAt(1, 1, [255, 255, 255, 255], 5));
    access.presentCrtcOutput(1);
    expect([...s.screen.data.subarray(4, 8)]).toEqual([...corrected(255, 255, 255), 255]);
    expect([...s.screen.data.subarray(12, 16)]).toEqual([...corrected(40, 50, 60), 255]);
    // The stage ends: the frame as presented, cursor back on its overlay.
    s.setGamma(null);
    access.presentCrtcOutput(1);
    expect([...s.screen.data]).toEqual(frame);
    const settled = s.uploads.length;
    access.presentCrtcOutput(1);
    expect(s.uploads.length).toBe(settled);
  });

  it("corrects a frame drawn straight to the canvas before its present target existed", () => {
    const s = windowSession(1, 1);
    s.setGamma(testLut());
    // The session lost its target (as after EGL window recreation) and drew
    // its frame straight to the canvas.
    s.binding.surface.presentTarget = null;
    s.binding.surface.renderTargetFbo = null;
    s.setScreen([10, 20, 30, 255]);
    expect(s.imports.env.host_gl_present(PID)).toBe(0);
    expect([...s.screen.data]).toEqual([...corrected(10, 20, 30), 255]);
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
  });
});
