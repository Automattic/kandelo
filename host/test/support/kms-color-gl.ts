/**
 * A WebGL2 fake that models pixels for the KMS presentation paths:
 * textures (RGBA8 and RGB565), framebuffer color attachments, the default
 * framebuffer (the canvas), blits, clears, readPixels, sampler objects and
 * texture completeness, and the two KMS programs' fragment stages:
 *
 * - the CRTC color stage (kms-color-stage.ts), recognized by `u_lut`, is
 *   evaluated per fragment exactly as its GLSL states;
 * - the scanout presenter (kernel-worker.ts), recognized by `u_scanout`, is
 *   evaluated at 1:1 scale (texel centers, so filtering returns the texel).
 *
 * texelFetch on an incomplete texture returns (0, 0, 0, 1), as GLSL ES 3.00
 * specifies, so a missing sampler or mip chain shows in the pixels.
 */
import { expect } from "vitest";

type Image = {
  w: number; h: number; data: Uint8Array; internal: number;
  minFilter: number; mipmaps: boolean;
};
type Program = { fragment: string; uniforms: Map<string, number[]> };

const bytesPerTexel = (internal: number) => internal === 0x8229 ? 1 : internal === 0x8d62 || internal === 0x822b ? 2
  : internal === 0x881a ? 8 : 4;
const halfValue = (bits: number) => {
  const sign = bits & 0x8000 ? -1 : 1, e = (bits >>> 10) & 31, m = bits & 1023;
  return e === 0 ? sign * m * 2 ** -24 : e === 31 ? (m ? NaN : sign * Infinity) : sign * (1 + m / 1024) * 2 ** (e - 15);
};

export function pixelGl(width: number, height: number) {
  const textures = new Map<object, Image>();
  const framebuffers = new Map<object, { color: object | null }>();
  const samplers = new Map<object, { minFilter: number }>();
  const shaders = new Map<object, string>();
  const programs = new Map<object, Program>();
  const screen: Image = { w: width, h: height, data: new Uint8Array(width * height * 4), internal: 0x8058,
    minFilter: 0x2600, mipmaps: false };
  const guestRead = {}, guestDraw = {}, guestTexture = {}, guestUnpack = {}, guestPack = {}, guestProgram = {};
  const state = new Map<number, unknown>([
    [0x84e0, 0x84c0], [0x8caa, guestRead], [0x8ca6, guestDraw], [0x8069, guestTexture],
    [0x88ef, guestUnpack], [0x88ed, guestPack], [0x0c11, true], [0x8b8d, guestProgram],
    [0x0cf5, 1], [0x0cf2, 7], [0x0cf4, 2], [0x0cf3, 3], [0x9240, true], [0x9241, true],
    [0x0d05, 8], [0x0d02, 5], [0x0d04, 1], [0x0d03, 1],
    [0x0c23, [true, true, true, true]], [0x0c22, [0, 0, 0, 0]], [0x0ba2, [0, 0, width, height]],
    // MAX_VERTEX_ATTRIBS and MAX_COMBINED_TEXTURE_IMAGE_UNITS for the muxer's replay.
    [0x8869, 16], [0x8b4d, 32],
  ]);
  // Per-unit TEXTURE_2D and sampler bindings.
  const unitTextures = new Map<number, object | null>();
  const unitSamplers = new Map<number, object | null>();
  let defaultReadBuffer = 0x0405;
  const uploads: Uint8Array[] = [];
  const counts = { readPixels: 0, draws: 0, blits: 0, texUploads: 0 };
  let lost = false;
  for (const target of [guestRead, guestDraw]) framebuffers.set(target, { color: null });
  const image = (fbo: unknown): Image => {
    if (fbo === null) return screen;
    const color = framebuffers.get(fbo as object)?.color;
    const found = color && textures.get(color);
    if (!found) throw new Error("framebuffer without color storage");
    return found;
  };
  const activeUnit = () => (state.get(0x84e0) as number) - 0x84c0;
  const boundTexture = () => {
    const texture = unitTextures.get(activeUnit());
    const found = texture && textures.get(texture);
    if (!found) throw new Error("no texture bound");
    return found;
  };
  /** RGBA bytes of texel (x, y) of a texture, after sampling completeness. */
  const texel = (unit: number, x: number, y: number): number[] => {
    const texture = unitTextures.get(unit);
    const found = texture && textures.get(texture);
    if (!found) throw new Error(`no texture on unit ${unit}`);
    const sampler = unitSamplers.get(unit);
    const minFilter = sampler ? samplers.get(sampler)!.minFilter : found.minFilter;
    const mipmapped = minFilter !== 0x2600 && minFilter !== 0x2601;
    if (mipmapped && !found.mipmaps) return [0, 0, 0, 255];
    if (x < 0 || y < 0 || x >= found.w || y >= found.h) return [0, 0, 0, 0];
    if (found.internal === 0x8229) return [found.data[y * found.w + x], 0, 0, 255];
    if (found.internal === 0x822b) {
      const at = (y * found.w + x) * 2;
      return [found.data[at], found.data[at + 1], 0, 255];
    }
    if (found.internal === 0x8059) {
      // Normalized 10-bit channels and 2-bit alpha, as fractions of 255.
      const at = (y * found.w + x) * 4;
      const word = (found.data[at] | found.data[at + 1] << 8 | found.data[at + 2] << 16 | found.data[at + 3] << 24) >>> 0;
      return [(word & 1023) / 1023 * 255, ((word >>> 10) & 1023) / 1023 * 255, ((word >>> 20) & 1023) / 1023 * 255,
        (word >>> 30) / 3 * 255];
    }
    if (found.internal === 0x881a) {
      const at = (y * found.w + x) * 8;
      return [0, 1, 2, 3].map(c => halfValue(found.data[at + c * 2] | found.data[at + c * 2 + 1] << 8) * 255);
    }
    if (found.internal === 0x8d62) {
      const at = (y * found.w + x) * 2;
      const word = found.data[at] | (found.data[at + 1] << 8);
      // Normalized 5/6/5 channels, carried as exact fractions of 255 for
      // the shader emulation below.
      return [(word >>> 11) / 31 * 255, ((word >>> 5) & 63) / 63 * 255, (word & 31) / 31 * 255, 255];
    }
    const at = (y * found.w + x) * 4;
    return Array.from(found.data.subarray(at, at + 4));
  };
  const uniform = (program: Program, name: string) => program.uniforms.get(name) ?? [0, 0, 0, 0];
  const stageFragment = (program: Program, fx: number, fy: number): number[] => {
    const [, sizeY] = uniform(program, "u_size");
    const flag = (name: string) => uniform(program, name)[0] !== 0;
    const unitOf = (name: string) => uniform(program, name)[0];
    const row = flag("u_target_top_first") ? fy : sizeY - 1 - fy;
    const t = texel(unitOf("u_frame"), fx, flag("u_frame_top_first") ? row : sizeY - 1 - row);
    let color: number[];
    const encoding = uniform(program, "u_encoding")[0];
    if (encoding === 1) {
      const q = [Math.floor(t[0] / 255 * 31 + 0.5), Math.floor(t[1] / 255 * 63 + 0.5), Math.floor(t[2] / 255 * 31 + 0.5)];
      color = [q[0] * 8 + Math.floor(q[0] / 4), q[1] * 4 + Math.floor(q[1] / 16), q[2] * 8 + Math.floor(q[2] / 4)];
    } else if (encoding === 2) {
      color = t.slice(0, 3).map(c => Math.floor((Math.floor(c / 255 * 1023 + 0.5) * 510 + 1023) / 2046));
    } else if (encoding === 3) {
      color = t.slice(0, 3).map(c => Math.floor(Math.min(Math.max(Number.isNaN(c) ? 0 : c / 255, 0), 1) * 255 + 0.5));
    } else {
      color = t.slice(0, 3).map(v => Math.floor(v + 0.5));
    }
    if (flag("u_bgr")) color = [color[2], color[1], color[0]];
    if (flag("u_lut_enabled")) {
      const [cx, cy, cw, ch] = uniform(program, "u_cursor_rect");
      const ax = fx - cx, ay = row - cy;
      if (ax >= 0 && ay >= 0 && ax < cw && ay < ch) {
        const p = texel(unitOf("u_cursor"), ax, ay);
        color = color.map((c, i) => Math.min(255, Math.floor(p[i] + c * (255 - p[3]) / 255 + 0.5)));
      }
      const lut = unitOf("u_lut");
      color = color.map((c, i) => texel(lut, c, 0)[i]);
    }
    return [...color, flag("u_opaque") ? 255 : t[3]];
  };
  const presenterFragment = (program: Program, fx: number, fy: number, vw: number, vh: number): number[] => {
    const unit = uniform(program, "u_scanout")[0];
    const texture = textures.get(unitTextures.get(unit)!)!;
    expect([texture.w, texture.h], "the fake presenter models 1:1 scale only").toEqual([vw, vh]);
    const t = texel(unit, fx, texture.h - 1 - fy).map(v => Math.round(v));
    return uniform(program, "u_bgr")[0] ? [t[2], t[1], t[0], 255] : [t[0], t[1], t[2], 255];
  };
  const core = {
    isContextLost: () => lost,
    getError: () => 0,
    getExtension: () => null,
    getParameter: (p: number) => p === 0x0c02
      ? (state.get(0x8caa) === null ? defaultReadBuffer : 0x8ce0)
      : p === 0x8069 ? unitTextures.get(activeUnit()) ?? null
      : state.get(p) ?? null,
    createTexture: () => {
      const t = {};
      textures.set(t, { w: 0, h: 0, data: new Uint8Array(), internal: 0, minFilter: 0x2702, mipmaps: false });
      return t;
    },
    createFramebuffer: () => { const f = {}; framebuffers.set(f, { color: null }); return f; },
    createRenderbuffer: () => ({}),
    createSampler: () => { const s = {}; samplers.set(s, { minFilter: 0x2702 }); return s; },
    createVertexArray: () => ({}),
    createShader: () => { const s = {}; shaders.set(s, ""); return s; },
    shaderSource: (shader: object, source: string) => shaders.set(shader, source),
    getShaderParameter: () => true,
    createProgram: () => { const p = {}; programs.set(p, { fragment: "", uniforms: new Map() }); return p; },
    attachShader: (program: object, shader: object) => {
      const source = shaders.get(shader)!;
      if (source.includes("out vec4")) programs.get(program)!.fragment = source;
    },
    getProgramParameter: () => true,
    isProgram: (program: object) => programs.has(program),
    getUniformLocation: (program: object, name: string) => ({ program, name }),
    useProgram: (program: unknown) => state.set(0x8b8d, program),
    uniform1i: (at: { program: object; name: string } | null, v: number) => {
      if (at) programs.get(at.program)!.uniforms.set(at.name, [v]);
    },
    uniform2i: (at: { program: object; name: string } | null, ...v: number[]) => {
      if (at) programs.get(at.program)!.uniforms.set(at.name, v);
    },
    uniform4i: (at: { program: object; name: string } | null, ...v: number[]) => {
      if (at) programs.get(at.program)!.uniforms.set(at.name, v);
    },
    deleteTexture: (t: object) => {
      textures.delete(t);
      for (const [unit, bound] of unitTextures) if (bound === t) unitTextures.set(unit, null);
    },
    deleteFramebuffer: (f: object) => { framebuffers.delete(f); },
    deleteSampler: (s: object) => { samplers.delete(s); },
    deleteProgram: (p: object) => { programs.delete(p); },
    activeTexture: (unit: number) => state.set(0x84e0, unit),
    bindTexture: (_target: number, value: object | null) => unitTextures.set(activeUnit(), value),
    bindSampler: (unit: number, value: object | null) => unitSamplers.set(unit, value),
    samplerParameteri: (sampler: object, pname: number, value: number) => {
      if (pname === 0x2801) samplers.get(sampler)!.minFilter = value;
    },
    texParameteri: (_target: number, pname: number, value: number) => {
      if (pname === 0x2801) boundTexture().minFilter = value;
    },
    generateMipmap: () => { boundTexture().mipmaps = true; },
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
    viewport: (...value: number[]) => state.set(0x0ba2, value),
    readBuffer: (value: number) => {
      if (state.get(0x8caa) !== null) throw new Error("test reads only the default read buffer");
      defaultReadBuffer = value;
    },
    clear: () => {
      const mask = state.get(0x0c23) as boolean[], clear = state.get(0x0c22) as number[];
      const target = image(state.get(0x8ca6));
      for (let i = 0; i < target.data.length; i++) if (mask[i & 3]) target.data[i] = clear[i & 3] * 255;
    },
    texImage2D: (_t: number, _l: number, internal: number, w: number, h: number, _b: number,
      _f: number, _ty: number, pixels: ArrayBufferView | null) => {
      const bytes = pixels ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) : null;
      if (bytes) {
        // The upload must not be reshaped by caller unpack state.
        expect(state.get(0x88ef)).toBeNull();
        expect([0x0cf2, 0x0cf4, 0x0cf3, 0x9240, 0x9241].map(p => Number(state.get(p)))).toEqual([0, 0, 0, 0, 0]);
        uploads.push(Uint8Array.from(bytes));
        counts.texUploads++;
      }
      const bpp = bytesPerTexel(internal);
      Object.assign(boundTexture(), { w, h, internal, mipmaps: false,
        data: bytes ? Uint8Array.from(bytes) : new Uint8Array(w * h * bpp) });
    },
    texSubImage2D: (_t: number, _l: number, x: number, y: number, w: number, h: number,
      _f: number, _ty: number, pixels: ArrayBufferView) => {
      const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      uploads.push(Uint8Array.from(bytes));
      counts.texUploads++;
      const target = boundTexture(), bpp = bytesPerTexel(target.internal);
      for (let row = 0; row < h; row++) {
        target.data.set(bytes.subarray(row * w * bpp, (row + 1) * w * bpp), ((y + row) * target.w + x) * bpp);
      }
      target.mipmaps = false;
    },
    framebufferTexture2D: (target: number, _attachment: number, _textarget: number, tex: object) => {
      const fbo = state.get(target === 0x8ca9 || target === 0x8d40 ? 0x8ca6 : 0x8caa) as object;
      framebuffers.get(fbo)!.color = tex;
    },
    checkFramebufferStatus: () => 0x8cd5,
    readPixels: (x: number, y: number, w: number, h: number, format: number, type: number, out: ArrayBufferView) => {
      counts.readPixels++;
      expect(state.get(0x88ed)).toBeNull();
      expect([0x0d02, 0x0d04, 0x0d03].map(p => state.get(p))).toEqual([0, 0, 0]);
      const read = state.get(0x8caa);
      if (read === null && defaultReadBuffer !== 0x0405) throw new Error("no read buffer");
      const source = image(read);
      expect(format).toBe(0x1908);
      // The pairs WebGL 2 accepts: RGB10_A2 as packed words, RGBA16F as floats.
      if (source.internal === 0x8059) {
        expect(type).toBe(0x8368);
        const words = out as Uint32Array;
        for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
          const at = ((y + row) * source.w + x + col) * 4;
          words[row * w + col] = (source.data[at] | source.data[at + 1] << 8 | source.data[at + 2] << 16
            | source.data[at + 3] << 24) >>> 0;
        }
        return;
      }
      if (source.internal === 0x881a) {
        expect(type).toBe(0x1406);
        const floats = out as Float32Array;
        for (let row = 0; row < h; row++) for (let col = 0; col < w * 4; col++) {
          const at = ((y + row) * source.w + x) * 8 + col * 2;
          floats[row * w * 4 + col] = halfValue(source.data[at] | source.data[at + 1] << 8);
        }
        return;
      }
      expect(type).toBe(0x1401);
      const bytes = out as Uint8Array;
      for (let row = 0; row < h; row++) {
        const at = ((y + row) * source.w + x) * 4;
        bytes.set(source.data.subarray(at, at + w * 4), row * w * 4);
      }
    },
    blitFramebuffer: (sx0: number, sy0: number, sx1: number, sy1: number,
      dx0: number, dy0: number, dx1: number, dy1: number) => {
      counts.blits++;
      expect(state.get(0x0c11)).toBe(false);
      const read = state.get(0x8caa);
      if (read === null && defaultReadBuffer !== 0x0405) throw new Error("no read buffer");
      const source = image(read), target = image(state.get(0x8ca6));
      // A 10-bit or float source would be rounded (or, for floats, refused)
      // by a blit into 8-bit storage: only an identical format copies it.
      const wide = (internal: number) => internal === 0x8059 || internal === 0x881a;
      if ((wide(source.internal) || wide(target.internal)) && source.internal !== target.internal)
        throw new Error(`blit ${source.internal.toString(16)} -> ${target.internal.toString(16)} changes precision`);
      const bpp = bytesPerTexel(source.internal);
      const w = Math.abs(dx1 - dx0), h = Math.abs(dy1 - dy0);
      const step = (from: number, to: number, i: number) => from < to ? from + i : from - 1 - i;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const s = (step(sy0, sy1, j) * source.w + step(sx0, sx1, i)) * bpp;
        const d = (step(dy0, dy1, j) * target.w + step(dx0, dx1, i)) * bpp;
        target.data.set(source.data.subarray(s, s + bpp), d);
      }
    },
    drawArrays: (_mode: number, _first: number, count: number) => {
      counts.draws++;
      expect(count).toBe(3);
      expect(state.get(0x0c11), "a scissor would clip the fullscreen draw").toBe(false);
      expect(state.get(0x0be2), "blending would mix the output with the target").toBe(false);
      const program = programs.get(state.get(0x8b8d) as object);
      if (!program) throw new Error("draw without a program");
      const target = image(state.get(0x8ca6));
      const [vx, vy, vw, vh] = state.get(0x0ba2) as number[];
      const stage = program.fragment.includes("u_lut");
      if (stage) expect(state.get(0x0bd0), "dithering may alter written values").toBe(false);
      const out: Array<[number, number[]]> = [];
      for (let fy = vy; fy < vy + vh; fy++) for (let fx = vx; fx < vx + vw; fx++) {
        if (fx < 0 || fy < 0 || fx >= target.w || fy >= target.h) continue;
        const color = stage ? stageFragment(program, fx, fy) : presenterFragment(program, fx - vx, fy - vy, vw, vh);
        out.push([(fy * target.w + fx) * 4, color]);
      }
      // Fragments read their sources before any is written.
      for (const [at, color] of out) target.data.set(color, at);
    },
  };
  const gl = new Proxy(core, {
    get: (target, key) => key in target ? target[key as keyof typeof target]
      : typeof key === "string" && /^[A-Z0-9_]+$/.test(key) ? GL_CONSTANTS[key] ?? (() => { throw new Error(`fake GL constant ${key}`); })()
      : () => {},
  }) as unknown as WebGL2RenderingContext;
  /** A texture-backed framebuffer holding `data` bytes in `internal`
   *  storage (GL order: bottom row first). */
  const framebuffer = (w: number, h: number, data: number[], internal = 0x8058) => {
    const tex = {}, fbo = {};
    textures.set(tex, { w, h, data: Uint8Array.from(data), internal, minFilter: 0x2600, mipmaps: false });
    framebuffers.set(fbo, { color: tex });
    return fbo as WebGLFramebuffer;
  };
  return {
    gl, state, screen, uploads, counts, textures, framebuffers, framebuffer, samplers, unitSamplers,
    snapshot: () => new Map(state),
    defaultReadBuffer: () => defaultReadBuffer,
    selectDefaultReadBuffer: (value: number) => { defaultReadBuffer = value; },
    setScreen: (data: number[]) => screen.data.set(data),
    loseContext: () => { lost = true; },
  };
}

const GL_CONSTANTS: Record<string, number> = {
  FRAMEBUFFER: 0x8d40, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, TRANSFORM_FEEDBACK: 0x8e22,
  SCISSOR_TEST: 0x0c11, BLEND: 0x0be2, CULL_FACE: 0x0b44, DEPTH_TEST: 0x0b71, STENCIL_TEST: 0x0b90,
  POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809e, SAMPLE_COVERAGE: 0x80a0,
  RASTERIZER_DISCARD: 0x8c89, DITHER: 0x0bd0, TEXTURE0: 0x84c0, PIXEL_UNPACK_BUFFER: 0x88ec,
  UNPACK_ALIGNMENT: 0x0cf5, UNPACK_ROW_LENGTH: 0x0cf2, UNPACK_IMAGE_HEIGHT: 0x806e, UNPACK_SKIP_ROWS: 0x0cf3,
  UNPACK_SKIP_PIXELS: 0x0cf4, UNPACK_SKIP_IMAGES: 0x806d, UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, TEXTURE_2D: 0x0de1, TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, NEAREST: 0x2600,
  LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, CLAMP_TO_EDGE: 0x812f, RGBA8: 0x8058, RGBA: 0x1908,
  RGB: 0x1907, RGB565: 0x8d62, UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT_5_6_5: 0x8363,
  COLOR_ATTACHMENT0: 0x8ce0, FRAMEBUFFER_COMPLETE: 0x8cd5, READ_BUFFER: 0x0c02, BACK: 0x0405,
  COLOR_BUFFER_BIT: 0x4000, TRIANGLES: 0x0004, TEXTURE_BINDING_2D: 0x8069, RENDERBUFFER_BINDING: 0x8ca7,
  RENDERBUFFER: 0x8d41, ACTIVE_TEXTURE: 0x84e0, READ_FRAMEBUFFER_BINDING: 0x8caa,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6, VIEWPORT: 0x0ba2, CURRENT_PROGRAM: 0x8b8d, NO_ERROR: 0,
};
