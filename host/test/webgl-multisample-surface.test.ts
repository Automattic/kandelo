import { describe, expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { copyGbmFront, readGbmFront } from "../src/webgl/gbm-front-copy.js";
import { hasNativeRepair, reserveNativeRetirement } from "../src/webgl/native-recovery.js";
import * as O from "../src/webgl/ops.js";
import { ensurePresentTarget } from "../src/webgl/present-target.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { querySurfaceCapabilities } from "../src/webgl/surface-capabilities.js";
import { prepareSurfaceCreation } from "../src/webgl/surface-create.js";
import { retainSurfaceStorage } from "../src/webgl/surface-resources.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";

/** EGL creation word: RGBA8/D24S8 storage (low byte 1), samples in bits 8..16. */
const config = (samples: number) => 1 | (samples << 8);
const READ = 0x8ca8, DRAW = 0x8ca9, FRAMEBUFFER = 0x8d40, RBO = 0x8d41;
const READ_BINDING = 0x8caa, DRAW_BINDING = 0x8ca6;

type Image = { w: number; h: number; samples: number; format: number; data: Uint8Array };

/** A WebGL 2 stand-in that keeps pixels and enforces the ES 3.0 multisample
 * rules the host must respect: ReadPixels/CopyTex* from a multisampled read
 * framebuffer and a scaled or flipped multisample blit are INVALID_OPERATION,
 * and a resolve writes one value per pixel. Multisampled storage keeps one
 * resolved value per pixel; the test only asserts where values travel. */
function msaaGl(options: { colorSamples?: number[]; depthSamples?: number[]; maxSamples?: number;
  roundSamples?: (requested: number) => number } = {}) {
  const images = new Map<object, Image>();
  const framebuffers = new Map<object, { color: object | null; depth: object | null; readBuffer: number }>();
  const screen: Image = { w: 0, h: 0, samples: 0, format: 0x8058, data: new Uint8Array() };
  const errors: number[] = [];
  const calls: string[] = [];
  const state = new Map<number, unknown>([
    [0x84e0, 0x84c0], [READ_BINDING, null], [DRAW_BINDING, null], [0x8069, null], [0x8ca7, null],
    [0x0c11, false], [0x0d05, 4], [0x0d02, 0], [0x0d04, 0], [0x0d03, 0], [0x88ed, null],
    [0x0d33, 4096], [0x84e8, 4096], [0x8d57, options.maxSamples ?? 8],
  ]);
  const fail = (error: number) => { errors.push(error); };
  const bound = (binding: number) => state.get(binding) as object | null;
  const image = (fbo: object | null): Image | undefined => {
    if (fbo === null) return screen;
    const color = framebuffers.get(fbo)?.color;
    return color ? images.get(color) : undefined;
  };
  const core = {
    errors, calls, images, framebuffers, screen, state, copied: null as Image | null,
    COLOR_BUFFER_BIT: 0x4000, NEAREST: 0x2600, SCISSOR_TEST: 0x0c11,
    isContextLost: () => false,
    getExtension: () => null,
    getError: () => errors.shift() ?? 0,
    getParameter: (p: number) => {
      if (p === 0x0c02) { const fbo = bound(READ_BINDING); return fbo ? framebuffers.get(fbo)!.readBuffer : 0x0405; }
      if (p === 0x80a9 || p === 0x80a8) {
        const samples = image(bound(DRAW_BINDING))?.samples ?? 0;
        return p === 0x80a9 ? samples : samples ? 1 : 0;
      }
      return state.has(p) ? state.get(p) : null;
    },
    getInternalformatParameter: (target: number, format: number, pname: number) => {
      expect([target, pname]).toEqual([RBO, 0x80a9]);
      return new Int32Array(format === 0x8058 ? options.colorSamples ?? [8, 4, 2]
        : format === 0x88f0 ? options.depthSamples ?? [8, 4, 2] : []);
    },
    createTexture: () => ({ texture: true }),
    createRenderbuffer: () => ({ renderbuffer: true }),
    createFramebuffer: () => { const f = { framebuffer: true }; framebuffers.set(f, { color: null, depth: null, readBuffer: 0x8ce0 }); return f; },
    deleteTexture: (t: object) => { images.delete(t); calls.push("deleteTexture"); },
    deleteRenderbuffer: (r: object) => { images.delete(r); calls.push("deleteRenderbuffer"); },
    deleteFramebuffer: (f: object) => { framebuffers.delete(f); calls.push("deleteFramebuffer"); },
    activeTexture: (unit: number) => state.set(0x84e0, unit),
    bindTexture: (_target: number, value: unknown) => state.set(0x8069, value),
    bindRenderbuffer: (_target: number, value: unknown) => state.set(0x8ca7, value),
    bindFramebuffer: (target: number, value: unknown) => {
      if (target === FRAMEBUFFER || target === READ) state.set(READ_BINDING, value);
      if (target === FRAMEBUFFER || target === DRAW) state.set(DRAW_BINDING, value);
    },
    bindBuffer: (target: number, value: unknown) => { if (target === 0x88eb) state.set(0x88ed, value); },
    pixelStorei: (name: number, value: number) => state.set(name, value),
    enable: (name: number) => state.set(name, true),
    disable: (name: number) => state.set(name, false),
    isEnabled: (name: number) => !!state.get(name),
    readBuffer: (mode: number) => { framebuffers.get(bound(READ_BINDING)!)!.readBuffer = mode; },
    texParameteri: () => {},
    texImage2D: (_t: number, _l: number, format: number, w: number, h: number) => {
      images.set(bound(0x8069)!, { w, h, samples: 0, format: format === 0x1908 ? 0x8058 : format, data: new Uint8Array(w * h * 4) });
    },
    renderbufferStorage: (_t: number, format: number, w: number, h: number) => {
      images.set(bound(0x8ca7)!, { w, h, samples: 0, format, data: new Uint8Array(w * h * 4) });
    },
    renderbufferStorageMultisample: (_t: number, samples: number, format: number, w: number, h: number) => {
      calls.push(`storageMultisample:${samples}:${format.toString(16)}:${w}x${h}`);
      if (samples > (options.maxSamples ?? 8)) { fail(0x501); return; }
      images.set(bound(0x8ca7)!, { w, h, samples: options.roundSamples?.(samples) ?? samples, format, data: new Uint8Array(w * h * 4) });
    },
    getRenderbufferParameter: (_t: number, pname: number) => {
      const rb = images.get(bound(0x8ca7)!)!;
      return pname === 0x8cab ? rb.samples : pname === 0x8d42 ? rb.w : pname === 0x8d43 ? rb.h : 0;
    },
    framebufferTexture2D: (target: number, _a: number, _tt: number, tex: object) => {
      framebuffers.get(bound(target === READ ? READ_BINDING : DRAW_BINDING)!)!.color = tex;
    },
    framebufferRenderbuffer: (target: number, attachment: number, _rt: number, rb: object) => {
      const fbo = framebuffers.get(bound(target === READ ? READ_BINDING : DRAW_BINDING)!)!;
      if (attachment === 0x8ce0) fbo.color = rb; else fbo.depth = rb;
    },
    checkFramebufferStatus: (target: number) => {
      const fbo = framebuffers.get(bound(target === READ ? READ_BINDING : DRAW_BINDING)!)!;
      const color = fbo.color && images.get(fbo.color), depth = fbo.depth && images.get(fbo.depth);
      return color && (!depth || depth.samples === color.samples) ? 0x8cd5 : 0x8cd6;
    },
    clearColor: (...value: number[]) => state.set(0x0c22, value),
    clear: () => {
      const target = image(bound(DRAW_BINDING))!, color = state.get(0x0c22) as number[] ?? [0, 0, 0, 0];
      for (let i = 0; i < target.data.length; i++) target.data[i] = color[i & 3] * 255;
    },
    blitFramebuffer: (sx0: number, sy0: number, sx1: number, sy1: number,
      dx0: number, dy0: number, dx1: number, dy1: number, mask: number, filter: number) => {
      calls.push(`blit:${sx0},${sy0},${sx1},${sy1}->${dx0},${dy0},${dx1},${dy1}`);
      const source = image(bound(READ_BINDING)), target = image(bound(DRAW_BINDING));
      if (!source || !target || mask !== 0x4000 || filter !== 0x2600) { fail(0x502); return; }
      if (state.get(0x0c11)) throw new Error("blit under a scissor");
      if (source.samples && (target.samples || sx0 !== dx0 || sy0 !== dy0 || sx1 !== dx1 || sy1 !== dy1
          || source.format !== target.format)) { fail(0x502); return; }
      if (target.samples) { fail(0x502); return; }
      const w = Math.abs(dx1 - dx0), h = Math.abs(dy1 - dy0);
      const step = (from: number, to: number, i: number) => from < to ? from + i : from - 1 - i;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const s = (step(sy0, sy1, j) * source.w + step(sx0, sx1, i)) * 4;
        const d = (step(dy0, dy1, j) * target.w + step(dx0, dx1, i)) * 4;
        target.data.set(source.data.subarray(s, s + 4), d);
      }
    },
    readPixels: (x: number, y: number, w: number, h: number, _f: number, _t: number, out: Uint8Array) => {
      const fbo = bound(READ_BINDING), source = image(fbo);
      calls.push("readPixels");
      if (!source || source.samples || (fbo && framebuffers.get(fbo)!.readBuffer === 0)) { fail(0x502); return; }
      for (let row = 0; row < h; row++) {
        const at = ((y + row) * source.w + x) * 4;
        out.set(source.data.subarray(at, at + w * 4), row * w * 4);
      }
    },
    copyTexSubImage2D: (_t: number, _l: number, xo: number, yo: number, x: number, y: number, w: number, h: number) => {
      const source = image(bound(READ_BINDING)), target = images.get(bound(0x8069)!);
      calls.push("copyTexSubImage2D");
      if (!source || source.samples || !target) { fail(0x502); return; }
      core.copied = target;
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
        const s = ((y + row) * source.w + x + col) * 4, d = ((yo + row) * target.w + xo + col) * 4;
        target.data.set(source.data.subarray(s, s + 4), d);
      }
    },
  };
  const gl = new Proxy(core, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => {},
  });
  /** A single-sampled texture framebuffer, as a GPU BO allocates it. */
  const textureFramebuffer = (w: number, h: number) => {
    const tex = {}, fbo = {};
    images.set(tex, { w, h, samples: 0, format: 0x8058, data: new Uint8Array(w * h * 4) });
    framebuffers.set(fbo, { color: tex, depth: null, readBuffer: 0x8ce0 });
    return fbo as WebGLFramebuffer;
  };
  return { gl: gl as unknown as WebGL2RenderingContext & typeof core, core, textureFramebuffer, image };
}

function binding(gl: WebGL2RenderingContext, canvas = { width: 4, height: 2 }) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(4096);
  b.gl = gl; b.canvas = canvas as unknown as HTMLCanvasElement;
  return { reg, b };
}

/** Create and select a surface the way the kernel does, then publish the
 * guest's default framebuffer natively, as the muxer would. */
function createSurface(b: GlBinding, samples: number, kind = 1, width = 4, height = 2) {
  const result = prepareSurfaceCreation(b, { surfaceId: 5, kind, width, height, configId: config(samples), targetBoId: 0 });
  if (!result.prepared) return result.rc;
  result.prepared.commit();
  b.gl!.bindFramebuffer(FRAMEBUFFER, b.shadow.fbo);
  return 0;
}

function query(b: GlBinding, op: number, words: number[], outLength: number) {
  const input = new Uint8Array(words.length * 4), out = new Uint8Array(outLength);
  words.forEach((word, i) => new DataView(input.buffer).setUint32(i * 4, word >>> 0, true));
  return { rc: runGlQuery(b, op, input, out), out };
}
function send(b: GlBinding, op: number, words: number[]) {
  const view = new DataView(b.cmdbufView!.buffer);
  view.setUint16(0, op, true);
  view.setUint16(2, words.length * 4, true);
  words.forEach((word, i) => view.setUint32(4 + i * 4, word >>> 0, true));
  expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
}
const glError = (b: GlBinding) => new DataView(query(b, O.QOP_GET_ERROR, [], 4).out.buffer).getUint32(0, true);
const pattern = (pixels: number) => Uint8Array.from({ length: pixels * 4 }, (_, i) => (i * 37 + 11) & 255);

describe("multisampled surface capabilities", () => {
  it("reports the sample counts both RGBA8 color and DEPTH24_STENCIL8 support, capped by MAX_SAMPLES", () => {
    const { gl } = msaaGl({ colorSamples: [16, 8, 4, 2], depthSamples: [8, 4], maxSamples: 8 });
    const out = new Uint8Array(20);
    expect(querySurfaceCapabilities(gl, new Uint8Array(), out)).toBe(20);
    expect([...new Uint32Array(out.buffer)]).toEqual([4096, 4096, 4096 * 4096, (1 << 4) | (1 << 8), 0x47514c33]);
    // The original reply is unchanged for callers that do not ask for counts.
    const legacy = new Uint8Array(16);
    expect(querySurfaceCapabilities(gl, new Uint8Array(), legacy)).toBe(16);
    expect([...new Uint32Array(legacy.buffer)]).toEqual([4096, 4096, 4096 * 4096, 0x47514c33]);
  });

  it("answers the extended reply through the kernel's query import", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const kernel = createWasmPosixKernelTestHarness({
      io: {} as any, callbacks: { getProcessMemory: () => memory }, memory, pointerWidth: 4,
      instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
    });
    const imports = (kernel.testAuthority.buildImportObject(memory) as { env: Record<string, (...args: any[]) => any> }).env;
    const { gl } = msaaGl({ colorSamples: [4, 2], depthSamples: [4] });
    kernel.gl.bind({ displayFileId: 1n, pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
    kernel.gl.attachCanvas(7, { width: 4, height: 3, getContext: () => gl } as unknown as OffscreenCanvas);
    expect(imports.host_gl_query(7, O.QOP_SURFACE_CAPABILITIES, 0, 0, 512, 20, 11)).toBe(20);
    expect([...new Uint32Array(memory.buffer, 512, 5)]).toEqual([4096, 4096, 4096 * 4096, 1 << 4, 0x47514c33]);
    expect(imports.host_gl_query(7, O.QOP_SURFACE_CAPABILITIES, 0, 0, 512, 24, 11)).toBe(-22);
  });
});

describe("multisampled EGL surfaces", () => {
  it("renders a window into exact multisampled storage and keeps only color in its resolve target", () => {
    const { gl, core } = msaaGl();
    const { b } = binding(gl);
    expect(createSurface(b, 4)).toBe(0);
    expect(b.surface.multisample?.samples).toBe(4);
    const ms = b.surface.multisample!;
    expect(b.renderTargetFbo).toBe(ms.fbo);
    expect(b.shadow.fbo).toBe(ms.fbo);
    expect(core.calls.filter(call => call.startsWith("storageMultisample"))).toEqual([
      "storageMultisample:4:8058:4x2", "storageMultisample:4:88f0:4x2"]);
    // The resolve target is single-sampled color, without another depth buffer.
    const target = core.framebuffers.get(b.presentTarget!.fbo as object)!;
    expect(core.images.get(target.color!)!.samples).toBe(0);
    expect(target.depth).toBeNull();
    // A single-sampled config keeps the existing allocation exactly.
    const plain = binding(msaaGl().gl).b;
    expect(createSurface(plain, 0)).toBe(0);
    expect(plain.surface.multisample).toBeNull();
    expect(plain.renderTargetFbo).toBe(plain.presentTarget!.fbo);
  });

  it("rejects sample counts the renderer cannot allocate exactly", () => {
    const unsupported = binding(msaaGl({ colorSamples: [4], depthSamples: [4] }).gl).b;
    expect(createSurface(unsupported, 2)).toBe(-22);
    expect(unsupported.surfaceId).toBeNull();
    // A renderer that rounds a request up would make EGL_SAMPLES untrue.
    const { gl, core } = msaaGl({ roundSamples: n => n * 2 });
    const rounded = binding(gl).b;
    expect(createSurface(rounded, 4)).toBeLessThan(0);
    expect(rounded.surface.multisample ?? null).toBeNull();
    expect(core.calls.filter(call => call.startsWith("delete")).length).toBeGreaterThan(0);
    expect(hasNativeRepair(gl)).toBe(false);
  });

  it("resolves the default framebuffer for ReadPixels without changing guest state", () => {
    const { gl, core, image } = msaaGl();
    const { b } = binding(gl);
    expect(createSurface(b, 4)).toBe(0);
    const ms = b.surface.multisample!;
    const pixels = pattern(8);
    image(ms.fbo as object)!.data.set(pixels);
    const read = query(b, O.QOP_READ_PIXELS, [0, 0, 4, 2, 0x1908, 0x1401], 32);
    expect(read.rc).toBe(32);
    expect([...read.out]).toEqual([...pixels]);
    expect(glError(b)).toBe(0);
    expect(core.state.get(READ_BINDING)).toBe(ms.fbo);
    expect(core.state.get(DRAW_BINDING)).toBe(ms.fbo);
    expect(core.state.get(0x0c11)).toBe(false);
    expect(core.calls).toContain("blit:0,0,4,2->0,0,4,2");
    expect(hasNativeRepair(gl)).toBe(false);
  });

  it("keeps a guest ReadPixels error the guest's own", () => {
    const { gl, core } = msaaGl();
    const { b } = binding(gl);
    expect(createSurface(b, 4)).toBe(0);
    core.errors.push(0x500);
    const read = query(b, O.QOP_READ_PIXELS, [0, 0, 4, 2, 0x1908, 0x1401], 32);
    expect(read.rc).toBe(32);
    expect(glError(b)).toBe(0x500);
    expect(glError(b)).toBe(0);
  });

  it("copies resolved default-framebuffer pixels into a texture", () => {
    const { gl, core, image } = msaaGl();
    const { b } = binding(gl);
    expect(createSurface(b, 4)).toBe(0);
    const pixels = pattern(8);
    image(b.surface.multisample!.fbo as object)!.data.set(pixels);
    send(b, O.OP_BIND_TEXTURE, [0x0de1, 71]);
    send(b, O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 4, 2, 0, 0x1908, 0x1401, 0]);
    send(b, O.OP_COPY_TEX_SUB_IMAGE_2D, [0x0de1, 0, 0, 0, 0, 0, 4, 2]);
    expect(glError(b)).toBe(0);
    expect(core.copied && [...core.copied.data]).toEqual([...pixels]);
    expect(gl.getParameter(READ_BINDING)).toBe(b.surface.multisample!.fbo);
  });

  it("resolves a pbuffer for reads and leaves single-sampled reads untouched", () => {
    const { gl, image } = msaaGl();
    const { b } = binding(gl);
    expect(createSurface(b, 2, 2, 3, 3)).toBe(0);
    const pixels = pattern(9);
    image(b.surface.multisample!.fbo as object)!.data.set(pixels);
    expect([...query(b, O.QOP_READ_PIXELS, [0, 0, 3, 3, 0x1908, 0x1401], 36).out]).toEqual([...pixels]);
    const plain = msaaGl();
    const single = binding(plain.gl).b;
    expect(createSurface(single, 0)).toBe(0);
    query(single, O.QOP_READ_PIXELS, [0, 0, 4, 2, 0x1908, 0x1401], 32);
    expect(plain.core.calls.some(call => call.startsWith("blit"))).toBe(false);
  });

  it("resizes multisampled storage with its resolve target and retires the old allocation", () => {
    const { gl, core } = msaaGl();
    const { b } = binding(gl);
    expect(createSurface(b, 4)).toBe(0);
    const old = b.surface.multisample!;
    b.surface.fixedSize = false; (b.canvas as { width: number }).width = 8;
    expect(ensurePresentTarget(b)).toBe(true);
    const next = b.surface.multisample!;
    expect(next).not.toBe(old);
    expect([next.w, next.h, b.presentTarget!.w]).toEqual([8, 2, 8]);
    expect(b.renderTargetFbo).toBe(next.fbo);
    expect(b.shadow.fbo).toBe(next.fbo);
    expect(core.framebuffers.has(old.fbo as object)).toBe(false);
  });

  it("captures the resolve target with retained execution storage", () => {
    const { gl } = msaaGl();
    const { b } = binding(gl);
    expect(createSurface(b, 4)).toBe(0);
    const lease = retainSurfaceStorage(b.surface)!;
    expect(lease.framebuffer).toBe(b.surface.multisample!.fbo);
    expect(lease.resolveFramebuffer).toBe(b.presentTarget!.fbo);
    // Retirement waits for the lease on both allocations.
    const ms = b.surface.multisample!, present = b.presentTarget!;
    b.surface.fixedSize = false; (b.canvas as { width: number }).width = 6;
    expect(ensurePresentTarget(b)).toBe(true);
    expect(ms.retirement.complete).toBe(false);
    expect(present.retirement.complete).toBe(false);
    expect(lease.release(null)).toBe(true);
    expect(ms.retirement.complete).toBe(true);
    expect(present.retirement.complete).toBe(true);
  });
});

describe("multisampled GBM and Wayland windows", () => {
  function gbmSurface(samples: number) {
    const r = msaaGl();
    const { b } = binding(r.gl, { width: 0, height: 0 });
    const back = r.textureFramebuffer(4, 2);
    const retirement = reserveNativeRetirement({ gl: r.gl, errors: [] }, [])!;
    const result = prepareSurfaceCreation(b, { surfaceId: 6, kind: 1, width: 4, height: 2, configId: config(samples), targetBoId: 40 },
      { gl: r.gl, fbo: back, w: 4, h: 2, retirement });
    if (!result.prepared) throw new Error(`surface creation failed: ${result.rc}`);
    result.prepared.commit();
    r.gl.bindFramebuffer(FRAMEBUFFER, b.shadow.fbo);
    return { ...r, b, back };
  }

  it("renders into multisampled storage and resolves before the top-row-first front copy", () => {
    const s = gbmSurface(4);
    expect(s.b.renderTargetFbo).toBe(s.b.surface.multisample!.fbo);
    const pixels = pattern(8);
    s.image(s.b.surface.multisample!.fbo as object)!.data.set(pixels);
    const front = s.textureFramebuffer(4, 2);
    expect(copyGbmFront(s.b.surface, { gl: s.gl, fbo: front, w: 4, h: 2 }, () => {})).toBe(0);
    const rows = s.image(front as object)!.data;
    // Row zero of the front is the top (last GL) row of the resolved image.
    expect([...rows.subarray(0, 16)]).toEqual([...pixels.subarray(16, 32)]);
    expect([...rows.subarray(16, 32)]).toEqual([...pixels.subarray(0, 16)]);
    const read = readGbmFront(s.b.surface, () => {});
    expect(read.rc).toBe(0);
    expect([...read.pixels!]).toEqual([...pixels]);
    expect(s.core.state.get(READ_BINDING)).toBe(s.b.surface.multisample!.fbo);
    expect(hasNativeRepair(s.gl)).toBe(false);
  });
});

describe("posting a multisampled window", () => {
  it("resolves before the present blit reaches the canvas", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const kernel = createWasmPosixKernelTestHarness({
      io: {} as any, callbacks: { getProcessMemory: () => memory }, memory, pointerWidth: 4,
      instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
    });
    const imports = (kernel.testAuthority.buildImportObject(memory) as { env: Record<string, (...args: any[]) => any> }).env;
    const r = msaaGl();
    r.core.screen.w = 4; r.core.screen.h = 2; r.core.screen.data = new Uint8Array(32);
    kernel.gl.bind({ displayFileId: 1n, pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
    kernel.gl.attachCanvas(7, { width: 4, height: 2, getContext: () => r.gl } as unknown as OffscreenCanvas);
    expect(imports.host_gl_create_context(7, 21, 0, 0, 11)).toBe(0);
    const attrs = new DataView(memory.buffer, 256, 36);
    for (let i = 0; i < 36; i += 4) attrs.setUint32(i, 0, true);
    attrs.setUint32(0, 1, true); attrs.setUint32(4, 4, true); attrs.setUint32(8, 2, true);
    attrs.setUint32(12, config(4), true);
    expect(imports.host_gl_create_surface(7, 31, 256, 36, 11)).toBe(0);
    expect(imports.host_gl_make_current(7, 21, 31, 31, 11)).toBe(0);
    const b = kernel.gl.get(7, 11)!;
    const pixels = pattern(8);
    r.image(b.surface.multisample!.fbo as object)!.data.set(pixels);
    expect(imports.host_gl_present(7, 11)).toBe(0);
    expect([...r.core.screen.data]).toEqual([...pixels]);
    expect(hasNativeRepair(r.gl)).toBe(false);
  });
});
