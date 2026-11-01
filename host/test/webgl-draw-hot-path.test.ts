import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { setOpaqueAlphaStorage } from "../src/webgl/opaque-alpha.js";
import { registerImageSource } from "../src/webgl/image-storage.js";
import { GlMuxer } from "../src/webgl/muxer.js";

/**
 * Draw-time cost of exactness mechanisms a draw does not use.
 *
 * A wlroots GLES2 frame is many textured-quad draws into one XRGB8888 GBM
 * buffer (an EGLImage renderbuffer whose RGBA8 storage keeps alpha 1.0), with
 * premultiplied blending, no stencil and no depth textures. Opaque-alpha
 * write locking, ES 2.0 framebuffer completeness and depth-texture sampling
 * must cost such a draw at most a constant flag test: their state is derived
 * when the framebuffer, its attachments/storage, the color mask or a texture
 * binding changes, never per draw. Results must be identical to deriving it
 * per draw.
 *
 * The fake renderer counts every native call, models the native color write
 * mask and records the alpha each storage holds after clears and draws.
 */

const FBO = 0x8d40, RBO = 0x8d41, COLOR0 = 0x8ce0, DEPTH = 0x8d00, DRAW = 0x8ca9, READ = 0x8ca8, TEX = 0x0de1;
const RGBA8 = 0x8058, RGB16F = 0x881b, RGBA16F = 0x881a, DEPTH16 = 0x81a5;
const RENDERABLE = new Set([RGBA8, 0x8056, 0x8057, 0x8d62, RGBA16F, DEPTH16, 0x88f0]);

type Program = { linked: boolean; uniforms: Map<string, number> };
type Storage = { format: number; alpha: number; width: number; height: number };

class CountingGl {
  calls = new Map<string, number>();
  mask: [boolean, boolean, boolean, boolean] = [true, true, true, true];
  clearValue: [number, number, number, number] = [0, 0, 0, 0];
  draw: object | null = null;
  read: object | null = null;
  renderbuffer: object | null = null;
  texture: object | null = null;
  current: Program | null = null;
  attachments = new Map<object, object>();
  storage = new Map<object, Storage>();
  draws: Program[] = [];
  fragmentAlpha = 0.25;
  private next = 1;
  getError() { return 0; }
  isContextLost() { return false; }
  getExtension(name: string) { return name === "EXT_color_buffer_float" ? {} : null; }
  getParameter(pname: number): unknown {
    switch (pname) {
      case 0x0c23: return [...this.mask];
      case 0x0c22: return new Float32Array(this.clearValue);
      case 0x8ca6: return this.draw;
      case 0x8caa: return this.read;
      case 0x8ca7: return this.renderbuffer;
      case 0x8069: return this.texture;
      case 0x8b8d: return this.current;
      case 0x84e0: return 0x84c0;
      case 0x8b4d: case 0x8872: case 0x8869: return 16;
      case 0x0d33: case 0x851c: case 0x84e8: return 4096;
      case 0x0d57: return 0;
      default: return 0;
    }
  }
  isEnabled() { return false; }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean) { this.mask = [r, g, b, a]; }
  clearColor(r: number, g: number, b: number, a: number) { this.clearValue = [r, g, b, a]; }
  createFramebuffer() { return { framebuffer: this.next++ }; }
  createRenderbuffer() { return { renderbuffer: this.next++ }; }
  createTexture() { return { texture: this.next++ }; }
  createBuffer() { return { buffer: this.next++ }; }
  deleteFramebuffer(framebuffer: object) { this.attachments.delete(framebuffer); }
  bindFramebuffer(target: number, framebuffer: object | null) {
    if (target !== READ) this.draw = framebuffer;
    if (target !== DRAW) this.read = framebuffer;
  }
  bindRenderbuffer(_target: number, renderbuffer: object | null) { this.renderbuffer = renderbuffer; }
  bindTexture(_target: number, texture: object | null) { this.texture = texture; }
  texImage2D(_target: number, _level: number, format: number, width: number, height: number) {
    this.storage.set(this.texture!, { format, alpha: 0, width, height });
  }
  renderbufferStorage(_target: number, format: number, width: number, height: number) {
    this.storage.set(this.renderbuffer!, { format, alpha: 0, width, height });
  }
  framebufferRenderbuffer(target: number, point: number, _rbTarget: number, image: object | null) {
    if (point !== COLOR0) return;
    const framebuffer = target === READ ? this.read : this.draw;
    if (image) this.attachments.set(framebuffer!, image); else this.attachments.delete(framebuffer!);
  }
  framebufferTexture2D(target: number, point: number, _textarget: number, texture: object | null) {
    this.framebufferRenderbuffer(target, point, RBO, texture);
  }
  checkFramebufferStatus() { return 0x8cd5; }
  createShader(type: number) { return { type, source: "" }; }
  shaderSource(shader: { source: string }, source: string) { shader.source = source; }
  getShaderParameter(shader: { type: number }, pname: number) { return pname === 0x8b4f ? shader.type : true; }
  createProgram(): Program { return { linked: false, uniforms: new Map() }; }
  linkProgram(program: Program) { program.linked = true; program.uniforms = new Map([["uTex", 0]]); }
  getProgramParameter(program: Program, pname: number) {
    if (pname === 0x8b82) return program.linked;
    if (pname === 0x8b86) return 1;
    return 0;
  }
  getActiveUniform(_program: Program, i: number) { return i === 0 ? { name: "uTex", size: 1, type: 0x8b5e } : null; }
  getUniformLocation(program: Program, name: string) { return program.uniforms.has(name) ? { program, name } : null; }
  getUniform(program: Program, location: { name: string }) { return program.uniforms.get(location.name); }
  useProgram(program: Program | null) { this.current = program; }
  private writeAlpha(alpha: number) {
    const target = this.attachments.get(this.draw!), storage = target && this.storage.get(target);
    if (storage && this.mask[3]) storage.alpha = alpha;
  }
  clear(mask: number) { if (mask & 0x4000) this.writeAlpha(this.clearValue[3]); }
  drawArrays() { this.draws.push(this.current!); this.writeAlpha(this.fragmentAlpha); }
}

const vertex = "attribute vec2 pos;\nvarying vec2 uv;\nvoid main() { uv = pos; gl_Position = vec4(pos, 0.0, 1.0); }\n";
const fragment = "precision mediump float;\nvarying vec2 uv;\nuniform sampler2D uTex;\n" +
  "void main() { gl_FragColor = texture2D(uTex, uv); }\n";

/** A Map whose lookups are counted: framebuffer facts derived per draw read
 * the attachment table; derived once, they do not. */
class CountedMap<K, V> extends Map<K, V> {
  gets = 0;
  override get(key: K): V | undefined { this.gets++; return super.get(key); }
}

function setup() {
  const gl = new CountingGl();
  const proxy = new Proxy(gl, {
    get(target, key: string) {
      const value = Reflect.get(target, key);
      const count = () => gl.calls.set(key, (gl.calls.get(key) ?? 0) + 1);
      if (typeof value === "function") return (...args: unknown[]) => { count(); return value.apply(target, args); };
      return value ?? (() => { count(); });
    },
  });
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 65536 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(65536);
  b.gl = proxy as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[], text = "") => {
    const bytes = new TextEncoder().encode(text);
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4 + bytes.length, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word >>> 0, true));
    b.cmdbufView!.set(bytes, 4 + words.length * 4);
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4 + bytes.length)).toBe(0);
  };
  const sendFloats = (op: number, values: number[]) => {
    const v = new DataView(new ArrayBuffer(values.length * 4));
    values.forEach((value, i) => v.setFloat32(i * 4, value, true));
    send(op, values.map((_, i) => v.getUint32(i * 4, true)));
  };
  const query = (op: number, words: number[], size = 4) => {
    const out = new Uint8Array(size + 8);
    runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out);
    return new DataView(out.buffer);
  };
  const error = () => {
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), out)).toBe(4);
    return new DataView(out.buffer).getUint32(0, true);
  };
  /** Client-array quad (wlroots binds its vertices from client memory). */
  const clientQuad = () => {
    const out = new Uint8Array(4 + 16 + 20 + 32), v = new DataView(out.buffer);
    v.setUint16(0, O.OP_DRAW_CLIENT_ARRAYS, true); v.setUint16(2, out.length - 4, true);
    [5, 0, 4, 1].forEach((value, i) => v.setUint32(4 + i * 4, value, true));
    [0, 2, 0x1406, 0, 32].forEach((value, i) => v.setUint32(20 + i * 4, value, true));
    b.cmdbufView!.set(out, 0);
    expect(decodeAndDispatch(b, 0, out.length)).toBe(0);
  };
  const renderbuffer = (name: number, internal: number, width = 4, height = 4) => {
    send(O.OP_BIND_RENDERBUFFER, [RBO, name]);
    expect(query(O.QOP_IMAGE_STORAGE, [O.OP_RENDERBUFFER_STORAGE, RBO, internal, width, height]).getUint32(0, true)).toBe(0);
  };
  const framebuffer = (name: number, rbo: number, point = COLOR0) => {
    send(O.OP_BIND_FRAMEBUFFER, [FBO, name]);
    send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, point, RBO, rbo]);
  };
  const texture = (unit: number, name: number, format: number, type: number) => {
    send(O.OP_ACTIVE_TEXTURE, [0x84c0 + unit]);
    send(O.OP_BIND_TEXTURE, [TEX, name]);
    send(O.OP_TEX_IMAGE_2D, [TEX, 0, format, 4, 4, 0, format, type, 0]);
  };
  // The wlroots textured-quad program: one sampler on unit 0.
  send(O.OP_CREATE_SHADER, [0x8b31, 10]);
  send(O.OP_CREATE_SHADER, [0x8b30, 11]);
  send(O.OP_SHADER_SOURCE, [10, vertex.length], vertex);
  send(O.OP_SHADER_SOURCE, [11, fragment.length], fragment);
  send(O.OP_COMPILE_SHADER, [10]);
  send(O.OP_COMPILE_SHADER, [11]);
  send(O.OP_CREATE_PROGRAM, [20]);
  send(O.OP_ATTACH_SHADER, [20, 10]);
  send(O.OP_ATTACH_SHADER, [20, 11]);
  send(O.OP_LINK_PROGRAM, [20]);
  send(O.OP_USE_PROGRAM, [20]);
  send(O.OP_VERTEX_ATTRIB_POINTER, [0, 2, 0x1406, 0, 0, 0]);
  send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY, [0]);
  send(O.OP_ENABLE, [0x0be2]);
  send(O.OP_BLEND_FUNC, [1, 0x0303]);
  texture(0, 30, 0x1908, 0x1401);
  texture(0, 31, 0x1908, 0x1401);
  expect(error()).toBe(0);
  const counting = () => {
    const attachments = new CountedMap(b.framebufferAttachments);
    b.framebufferAttachments = attachments;
    const defaults = new CountedMap(b.shadow.defaultTextures);
    b.shadow.defaultTextures = defaults;
    gl.calls.clear();
    return { attachments, defaults };
  };
  return { b, gl, send, sendFloats, query, error, clientQuad, renderbuffer, framebuffer, texture, counting };
}

/** One wlroots-style quad: bind the surface texture, draw a strip. */
function quads(h: ReturnType<typeof setup>, n: number, draw: "buffer" | "client", bind = true) {
  for (let i = 0; i < n; i++) {
    if (bind) h.send(O.OP_BIND_TEXTURE, [TEX, 30 + (i % 2)]);
    if (draw === "client") h.clientQuad(); else h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
  }
}

function perDraw(h: ReturnType<typeof setup>, n: number, draw: "buffer" | "client", bind = true) {
  const counted = h.counting();
  quads(h, n, draw, bind);
  const calls = Object.fromEntries([...h.gl.calls].map(([name, count]) => [name, count / n]));
  return { calls, attachmentGets: counted.attachments.gets / n, defaultTextureGets: counted.defaults.gets / n };
}

describe("draws that use no exactness feature do no extra work", () => {
  // [C2]
  it("an XRGB-like target locks native alpha once, not around every draw and clear", () => {
    const h = setup();
    h.renderbuffer(7, RGB16F);
    h.framebuffer(9, 7);
    h.send(O.OP_CLEAR, [0x4000]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    const N = 16;
    const { calls, attachmentGets } = perDraw(h, N, "buffer");
    h.send(O.OP_CLEAR, [0x4000]);
    expect(h.gl.calls.get("colorMask") ?? 0).toBe(0);
    expect(calls.colorMask ?? 0).toBe(0);
    expect(attachmentGets).toBe(0);
    // The storage still never received a written alpha.
    expect(h.gl.storage.get(h.b.rbos.get(7)!)!.alpha).toBe(1);
    expect(h.gl.mask).toEqual([true, true, true, false]);
    // The guest's logical mask is what queries report.
    const mask = h.query(O.QOP_GET_INTEGERV, [0x0c23], 16);
    expect([0, 1, 2, 3].map(i => mask.getInt32(i * 4, true))).toEqual([1, 1, 1, 1]);
    expect(h.error()).toBe(0);
  });

  // [C1]
  it("completeness is derived once per framebuffer revision, not per draw", () => {
    const h = setup();
    h.renderbuffer(7, RGBA8);
    h.renderbuffer(8, DEPTH16);
    h.framebuffer(9, 7);
    h.send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, DEPTH, RBO, 8]);
    // The guest writes no alpha, so no alpha-lock derivation is involved.
    h.send(O.OP_COLOR_MASK, [1, 1, 1, 0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    const { attachmentGets } = perDraw(h, 16, "buffer");
    h.send(O.OP_CLEAR, [0x4000]);
    expect(attachmentGets).toBe(0);
    expect(h.error()).toBe(0);
  });

});

describe("derived draw state follows every change it depends on", () => {
  // [C2]
  it("the alpha lock follows framebuffer binding, color mask and storage respecification", () => {
    const h = setup();
    h.renderbuffer(7, RGB16F);
    h.renderbuffer(8, RGBA8);
    h.framebuffer(9, 7);
    h.framebuffer(10, 8);
    const opaque = h.gl.storage.get(h.b.rbos.get(7)!)!, plain = h.gl.storage.get(h.b.rbos.get(8)!)!;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(plain.alpha).toBe(0.25);
    h.send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(opaque.alpha).toBe(1);
    // A guest color mask written while locked keeps alpha off natively.
    h.send(O.OP_COLOR_MASK, [1, 0, 1, 1]);
    expect(h.gl.mask).toEqual([true, false, true, false]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(opaque.alpha).toBe(1);
    const mask = h.query(O.QOP_GET_INTEGERV, [0x0c23], 16);
    expect([0, 1, 2, 3].map(i => mask.getInt32(i * 4, true))).toEqual([1, 0, 1, 1]);
    h.send(O.OP_BIND_FRAMEBUFFER, [FBO, 10]);
    plain.alpha = 0;
    h.send(O.OP_CLEAR_COLOR, [0, 0, 0, 0x3f000000]);
    h.send(O.OP_CLEAR, [0x4000]);
    expect(plain.alpha).toBe(0.5);
    expect(h.gl.mask).toEqual([true, false, true, true]);
    // Respecifying the attached storage with alpha releases the lock.
    h.send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    h.renderbuffer(7, RGBA16F);
    const respecified = h.gl.storage.get(h.b.rbos.get(7)!)!;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(respecified.alpha).toBe(0.25);
    // ...and making it opaque again restores it.
    h.renderbuffer(7, RGB16F);
    const again = h.gl.storage.get(h.b.rbos.get(7)!)!;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(again.alpha).toBe(1);
    // Detaching the opaque storage releases the lock as well.
    h.send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, COLOR0, RBO, 8]);
    plain.alpha = 0;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(plain.alpha).toBe(0.25);
    expect(h.error()).toBe(0);
  });

  // [C2]
  it("locks alpha for an EGLImage renderbuffer whose shared storage has no alpha (GBM XRGB8888)", () => {
    const h = setup();
    // A GBM XRGB8888 buffer: RGBA8 storage whose alpha is 1.0 and never written.
    const bo = h.gl.createTexture();
    h.gl.storage.set(bo, { format: RGBA8, alpha: 1, width: 4, height: 4 });
    setOpaqueAlphaStorage(bo, true);
    const token = registerImageSource(h.b, 41, bo, 4, 4);
    h.send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    expect(h.query(O.QOP_IMAGE_TARGET, [2, 7, token]).getUint32(0, true)).toBe(0);
    h.framebuffer(9, 7);
    expect(h.gl.attachments.get(h.gl.draw!)).toBe(bo);
    h.send(O.OP_CLEAR, [0x4000]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.storage.get(bo)!.alpha).toBe(1);
    expect(h.error()).toBe(0);
  });

  // [C2]
  it("an owner switch replays the locked native mask", () => {
    const h = setup();
    h.renderbuffer(7, RGB16F);
    h.framebuffer(9, 7);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    const muxer = new GlMuxer(h.b.gl!);
    muxer.switchTo(h.b);
    expect(h.gl.mask).toEqual([true, true, true, false]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.storage.get(h.b.rbos.get(7)!)!.alpha).toBe(1);
  });

  // [C1]
  it("cached completeness follows attachment and storage changes", () => {
    const h = setup();
    h.renderbuffer(7, RGBA8);
    h.renderbuffer(8, DEPTH16);
    h.framebuffer(9, 7);
    h.send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, DEPTH, RBO, 8]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0);
    // Respecify the attached depth image at another size: incomplete dimensions.
    h.renderbuffer(8, DEPTH16, 8, 8);
    const draws = h.gl.draws.length;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    h.send(O.OP_CLEAR, [0x4000]);
    expect(h.error()).toBe(0x506);
    expect(h.gl.draws.length).toBe(draws);
    expect(h.query(O.QOP_CHECK_FB_STATUS, [FBO], 0).getUint32(0, true)).toBe(0x8cd9);
    h.renderbuffer(8, DEPTH16, 4, 4);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0);
    // Attaching a color texture level of another size is incomplete too.
    h.texture(1, 40, 0x1908, 0x1401);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, 0]);
    h.send(O.OP_FRAMEBUFFER_TEXTURE_2D, [FBO, COLOR0, TEX, 40, 0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0x506);
    // Respecifying that level to the common size completes it again.
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, 0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0);
    // Deleting the odd-sized depth renderbuffer detaches it from the bound framebuffer.
    h.renderbuffer(8, DEPTH16, 8, 8);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0x506);
    expect(h.query(O.QOP_IMAGE_OBJECT_DELETE, [2, 8]).getUint32(0, true)).toBe(0);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0);
  });

});

