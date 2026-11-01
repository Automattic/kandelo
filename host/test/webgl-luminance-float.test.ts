import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * OES_texture_float and OES_texture_half_float define LUMINANCE, ALPHA and
 * LUMINANCE_ALPHA textures of type FLOAT and HALF_FLOAT_OES. WebGL 2's
 * texImage2D accepts those unsized formats only with UNSIGNED_BYTE (ES 3.0
 * table 3.3), so the host must store them as RGBA32F/RGBA16F with the
 * sampling-equivalent expansion L->(L,L,L,1), A->(0,0,0,A), LA->(L,L,L,A).
 *
 * The fake renderer below enforces WebGL 2's internalformat/format/type
 * table for texImage2D and texSubImage2D, its typed-array rules and its
 * unpack-alignment source size, so a host that sends the GLES 2 triple
 * unchanged fails exactly as a browser would.
 */

const TEX = 0x0de1, FBO = 0x8d40, COLOR0 = 0x8ce0;
const RGBA = 0x1908, RGB = 0x1907, ALPHA = 0x1906, L = 0x1909, LA = 0x190a;
const UB = 0x1401, FLOAT = 0x1406, HALF = 0x140b, HALF_OES = 0x8d61;
const RGBA32F = 0x8814, RGBA16F = 0x881a;
const INVALID_OPERATION = 0x502, INVALID_FRAMEBUFFER_OPERATION = 0x506;

// ES 3.0 table 3.2/3.3 rows used here: [internal, format, type, bytes/pixel].
const WEBGL2_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [RGBA, RGBA, UB, 4], [RGB, RGB, UB, 3], [LA, LA, UB, 2], [L, L, UB, 1], [ALPHA, ALPHA, UB, 1],
  [RGBA32F, RGBA, FLOAT, 16], [RGBA16F, RGBA, HALF, 8], [RGBA16F, RGBA, FLOAT, 16],
  [0x8815, RGB, FLOAT, 12], [0x881b, RGB, HALF, 6],
];

type Level = { internal: number; width: number; height: number; bpp: number; bytes: Uint8Array };

class StrictWebGL2 {
  error = 0;
  calls: string[] = [];
  enabled = new Set<string>();
  unpackAlignment = 4;
  private next = 1;
  private bound: object | null = null;
  private framebuffer: object | null = null;
  levels = new Map<object, Map<number, Level>>();
  attachments = new Map<object, { texture: object; level: number }>();
  constructor(private available: string[] = []) {}
  private fail(error: number) { if (!this.error) this.error = error; }
  getError() { const e = this.error; this.error = 0; return e; }
  isContextLost() { return false; }
  getExtension(name: string) { if (!this.available.includes(name)) return null; this.enabled.add(name); return {}; }
  getParameter(pname: number) {
    if (pname === 0x8b4d) return 8;
    if (pname === 0x0d33 || pname === 0x851c) return 4096;
    if (pname === 0x88ef) return null;
    return 0;
  }
  createTexture() { return { texture: this.next++ }; }
  createFramebuffer() { return { framebuffer: this.next++ }; }
  activeTexture() {}
  bindTexture(_target: number, texture: object | null) { this.bound = texture; }
  bindFramebuffer(_target: number, framebuffer: object | null) { this.framebuffer = framebuffer; }
  pixelStorei(pname: number, value: number) { if (pname === 0x0cf5) this.unpackAlignment = value; }
  private row(entry: readonly number[], width: number) {
    const a = this.unpackAlignment;
    return Math.ceil(width * entry[3] / a) * a;
  }
  private source(entry: readonly [number, number, number, number], width: number, height: number, data: unknown) {
    if (data === null) return null;
    const view = entry[2] === FLOAT ? Float32Array : entry[2] === HALF ? Uint16Array : Uint8Array;
    if (!(data instanceof view)) { this.fail(INVALID_OPERATION); return undefined; }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const stride = this.row(entry, width);
    if (height && bytes.byteLength < (height - 1) * stride + width * entry[3]) { this.fail(INVALID_OPERATION); return undefined; }
    return { bytes, stride };
  }
  texImage2D(_target: number, level: number, internal: number, width: number, height: number,
             _border: number, format: number, type: number, data: unknown) {
    this.calls.push("texImage2D");
    const entry = WEBGL2_TABLE.find(([i, f, t]) => i === internal && f === format && t === type);
    if (!entry) { this.fail(INVALID_OPERATION); return; }
    const source = this.source(entry, width, height, data);
    if (source === undefined) return;
    const stored: Level = { internal, width, height, bpp: entry[3], bytes: new Uint8Array(width * height * entry[3]) };
    if (source) for (let r = 0; r < height; r++)
      stored.bytes.set(source.bytes.subarray(r * source.stride, r * source.stride + width * entry[3]), r * width * entry[3]);
    let levels = this.levels.get(this.bound!);
    if (!levels) this.levels.set(this.bound!, levels = new Map());
    levels.set(level, stored);
  }
  texSubImage2D(_target: number, level: number, x: number, y: number, width: number, height: number,
                format: number, type: number, data: unknown) {
    this.calls.push("texSubImage2D");
    const stored = this.levels.get(this.bound!)?.get(level);
    const entry = stored && WEBGL2_TABLE.find(([i, f, t]) => i === stored.internal && f === format && t === type);
    if (!stored || !entry || entry[3] !== stored.bpp) { this.fail(INVALID_OPERATION); return; }
    if (x + width > stored.width || y + height > stored.height) { this.fail(0x501); return; }
    const source = this.source(entry, width, height, data);
    if (!source) return;
    for (let r = 0; r < height; r++)
      stored.bytes.set(source.bytes.subarray(r * source.stride, r * source.stride + width * entry[3]),
        ((y + r) * stored.width + x) * entry[3]);
  }
  generateMipmap() {
    this.calls.push("generateMipmap");
    const levels = this.levels.get(this.bound!), base = levels?.get(0);
    // ES 3.0 section 3.8.10: unsized formats, or filterable and renderable.
    const ok = base && ([RGBA, RGB, LA, L, ALPHA].includes(base.internal) ||
      (base.internal === RGBA16F && this.enabled.has("EXT_color_buffer_float")) ||
      (base.internal === RGBA32F && this.enabled.has("EXT_color_buffer_float") && this.enabled.has("OES_texture_float_linear")));
    if (!ok) { this.fail(INVALID_OPERATION); return; }
    for (let level = 1, w = base.width, h = base.height; w > 1 || h > 1; level++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      levels!.set(level, { ...base, width: w, height: h, bytes: new Uint8Array(w * h * base.bpp) });
    }
  }
  framebufferTexture2D(_target: number, _point: number, _textarget: number, texture: object | null, level: number) {
    if (texture) this.attachments.set(this.framebuffer!, { texture, level });
    else this.attachments.delete(this.framebuffer!);
  }
  checkFramebufferStatus() {
    const attached = this.attachments.get(this.framebuffer!);
    const level = attached && this.levels.get(attached.texture)?.get(attached.level);
    const renderable = level && (level.internal === RGBA || level.internal === RGB ||
      ((level.internal === RGBA32F || level.internal === RGBA16F) && this.enabled.has("EXT_color_buffer_float")));
    return renderable ? 0x8cd5 : 0x8cd6;
  }
  clear() { this.calls.push("clear"); }
  drawArrays() { this.calls.push("drawArrays"); }
}

function binding(available: string[] = []) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 1 << 16 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(1 << 16));
  const gl = new StrictWebGL2(available);
  for (const name of available) gl.getExtension(name);
  b.gl = new Proxy(gl, {
    get(object, name: string) {
      const value = (object as unknown as Record<string, unknown>)[name];
      if (value !== undefined) return typeof value === "function" ? value.bind(object) : value;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[], bytes: Uint8Array = new Uint8Array()) => {
    const view = new DataView(b.cmdbufView!.buffer);
    const length = words.length * 4 + bytes.byteLength;
    view.setUint16(0, op, true); view.setUint16(2, length, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    b.cmdbufView!.set(bytes, 4 + words.length * 4);
    expect(decodeAndDispatch(b, 0, 4 + length)).toBe(0);
  };
  const storage = (words: number[]) => {
    const out = new Uint8Array(12);
    expect(runGlQuery(b, O.QOP_IMAGE_STORAGE, new Uint8Array(new Uint32Array(words).buffer), out)).toBe(12);
    return new DataView(out.buffer).getUint32(0, true) === 0;
  };
  const status = () => {
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_CHECK_FB_STATUS, new Uint8Array(new Uint32Array([FBO]).buffer), out)).toBe(4);
    return new DataView(out.buffer).getUint32(0, true);
  };
  send(O.OP_BIND_TEXTURE, [TEX, 5]);
  const texture = () => b.textures.get(5)!;
  return { b, gl, send, storage, status, texture };
}

/** Rows of `components` scalars per pixel, packed at the given alignment. */
function packed(rows: number[][], scalar: 2 | 4, alignment: number): Uint8Array {
  const width = Math.max(...rows.map(row => row.length * scalar));
  const stride = Math.ceil(width / alignment) * alignment;
  const out = new Uint8Array((rows.length - 1) * stride + width), view = new DataView(out.buffer);
  rows.forEach((row, r) => row.forEach((value, i) =>
    scalar === 4 ? view.setFloat32(r * stride + i * 4, value, true) : view.setUint16(r * stride + i * 2, value, true)));
  return out;
}

function texels(level: { bytes: Uint8Array }, scalar: 2 | 4): number[] {
  const view = new DataView(level.bytes.buffer, level.bytes.byteOffset, level.bytes.byteLength);
  return Array.from({ length: level.bytes.byteLength / scalar }, (_, i) =>
    scalar === 4 ? view.getFloat32(i * 4, true) : view.getUint16(i * 2, true));
}

const H1 = 0x3c00; // half-float 1.0

describe("OES_texture_float luminance and alpha formats", () => {
  it("stores LUMINANCE FLOAT pixels as RGBA32F (L,L,L,1) under UNPACK_ALIGNMENT 8", () => {
    const { b, gl, send, texture } = binding();
    send(O.OP_PIXEL_STOREI, [0x0cf5, 8]);
    const data = packed([[0.25, 0.5, 0.75], [1, 2, 3]], 4, 8);
    send(O.OP_TEX_IMAGE_2D, [TEX, 0, L, 3, 2, 0, L, FLOAT, data.byteLength], data);
    expect(b.errors).toEqual([]);
    const level = gl.levels.get(texture())!.get(0)!;
    expect(level.internal).toBe(RGBA32F);
    expect(texels(level, 4)).toEqual([
      0.25, 0.25, 0.25, 1, 0.5, 0.5, 0.5, 1, 0.75, 0.75, 0.75, 1,
      1, 1, 1, 1, 2, 2, 2, 1, 3, 3, 3, 1]);
  });

  it("allocates LUMINANCE_ALPHA HALF_FLOAT_OES as RGBA16F and expands subimage rows", () => {
    const { b, gl, send, storage, texture } = binding();
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, LA, 3, 2, 0, LA, HALF_OES, 0])).toBe(true);
    // Rows of 3 LA half pixels are 12 bytes; alignment 8 pads them to 16.
    send(O.OP_PIXEL_STOREI, [0x0cf5, 8]);
    const data = packed([[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]], 2, 8);
    send(O.OP_TEX_SUB_IMAGE_2D, [TEX, 0, 0, 0, 3, 2, LA, HALF_OES, data.byteLength], data);
    expect(b.errors).toEqual([]);
    const level = gl.levels.get(texture())!.get(0)!;
    expect(level.internal).toBe(RGBA16F);
    expect(texels(level, 2)).toEqual([
      1, 1, 1, 2, 3, 3, 3, 4, 5, 5, 5, 6, 7, 7, 7, 8, 9, 9, 9, 10, 11, 11, 11, 12]);
  });

  it("expands ALPHA FLOAT to (0,0,0,A) at a subimage offset", () => {
    const { b, gl, send, storage, texture } = binding();
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, ALPHA, 2, 2, 0, ALPHA, FLOAT, 0])).toBe(true);
    expect(storage([O.OP_TEX_SUB_IMAGE_2D, TEX, 0, 1, 1, 1, 1, ALPHA, FLOAT, 0])).toBe(true);
    const data = packed([[0.5]], 4, 4);
    send(O.OP_TEX_SUB_IMAGE_2D, [TEX, 0, 1, 1, 1, 1, ALPHA, FLOAT, data.byteLength], data);
    expect(b.errors).toEqual([]);
    expect(texels(gl.levels.get(texture())!.get(0)!, 4).slice(12)).toEqual([0, 0, 0, 0.5]);
  });

  it.each([
    ["RGBA FLOAT into a LUMINANCE FLOAT level", L, FLOAT, RGBA, FLOAT],
    ["LUMINANCE HALF into a LUMINANCE FLOAT level", L, FLOAT, L, HALF_OES],
    ["ALPHA FLOAT into a LUMINANCE FLOAT level", L, FLOAT, ALPHA, FLOAT],
    ["LUMINANCE FLOAT into an RGBA FLOAT level", RGBA, FLOAT, L, FLOAT],
    ["LUMINANCE FLOAT into a LUMINANCE byte level", L, UB, L, FLOAT],
  ])("rejects %s (no format conversion in GLES 2)", (_name, levelFormat, levelType, format, type) => {
    const { b, gl, storage } = binding();
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, levelFormat, 2, 2, 0, levelFormat, levelType, 0])).toBe(true);
    const calls = gl.calls.length;
    expect(storage([O.OP_TEX_SUB_IMAGE_2D, TEX, 0, 0, 0, 1, 1, format, type, 0])).toBe(false);
    expect(b.errors).toEqual([INVALID_OPERATION]);
    expect(gl.calls.length).toBe(calls);
  });

  it("forgets the logical format when the level is respecified", () => {
    const { b, storage } = binding();
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, L, 2, 2, 0, L, FLOAT, 0])).toBe(true);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, RGBA, 2, 2, 0, RGBA, FLOAT, 0])).toBe(true);
    expect(storage([O.OP_TEX_SUB_IMAGE_2D, TEX, 0, 0, 0, 1, 1, RGBA, FLOAT, 0])).toBe(true);
    expect(storage([O.OP_TEX_SUB_IMAGE_2D, TEX, 0, 0, 0, 1, 1, L, FLOAT, 0])).toBe(false);
    expect(b.errors).toEqual([INVALID_OPERATION]);
  });

  it("keeps the logical format on mipmap levels produced by GenerateMipmap", () => {
    const { b, gl, send, storage, texture } = binding(["EXT_color_buffer_float", "OES_texture_float_linear"]);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, L, 4, 4, 0, L, FLOAT, 0])).toBe(true);
    send(O.OP_GENERATE_MIPMAP, [TEX]);
    expect(b.errors).toEqual([]);
    expect(storage([O.OP_TEX_SUB_IMAGE_2D, TEX, 2, 0, 0, 1, 1, L, FLOAT, 0])).toBe(true);
    const data = packed([[0.125]], 4, 4);
    send(O.OP_TEX_SUB_IMAGE_2D, [TEX, 2, 0, 0, 1, 1, L, FLOAT, data.byteLength], data);
    expect(texels(gl.levels.get(texture())!.get(2)!, 4)).toEqual([0.125, 0.125, 0.125, 1]);
    expect(storage([O.OP_TEX_SUB_IMAGE_2D, TEX, 1, 0, 0, 1, 1, RGBA, FLOAT, 0])).toBe(false);
    expect(b.errors).toEqual([INVALID_OPERATION]);
  });

  it("keeps luminance float levels out of color rendering (section 4.4.5)", () => {
    const { b, gl, send, storage, status } = binding(["EXT_color_buffer_float"]);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, L, 2, 2, 0, L, FLOAT, 0])).toBe(true);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D, [FBO, COLOR0, TEX, 5, 0]);
    // The native RGBA32F stand-in is renderable here; GLES 2 luminance is not.
    expect(gl.checkFramebufferStatus()).toBe(0x8cd5);
    expect(status()).toBe(0x8cd6);
    send(O.OP_CLEAR, [0x4000]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(b.errors).toEqual([INVALID_FRAMEBUFFER_OPERATION]);
    expect(gl.calls.filter(call => call === "clear" || call === "drawArrays")).toEqual([]);
    expect(storage([O.OP_TEX_IMAGE_2D, TEX, 0, RGBA, 2, 2, 0, RGBA, FLOAT, 0])).toBe(true);
    expect(status()).toBe(0x8cd5);
  });
});

describe("UNSIGNED_BYTE luminance and alpha formats", () => {
  it.each([[L, 1], [ALPHA, 1], [LA, 2]])("passes format %i through as WebGL 2's unsized format", (format, components) => {
    const { b, gl, send, texture } = binding();
    const data = new Uint8Array(4 * components).map((_, i) => i + 1);
    send(O.OP_PIXEL_STOREI, [0x0cf5, 1]);
    send(O.OP_TEX_IMAGE_2D, [TEX, 0, format, 2, 2, 0, format, UB, data.byteLength], data);
    send(O.OP_TEX_SUB_IMAGE_2D, [TEX, 0, 1, 1, 1, 1, format, UB, components], data.subarray(0, components));
    expect(b.errors).toEqual([]);
    const level = gl.levels.get(texture())!.get(0)!;
    expect(level.internal).toBe(format);
    expect([...level.bytes.subarray(3 * components)]).toEqual([...data.subarray(0, components)]);
  });
});
