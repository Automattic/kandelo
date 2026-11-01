import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { setOpaqueAlphaStorage } from "../src/webgl/opaque-alpha.js";
import { registerImageSource } from "../src/webgl/image-storage.js";
import { gpuSourceStorage } from "../src/webgl/foreign-texture.js";
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
/** `content` names the last image written to the storage; sampling records
 * the content of the texture bound to unit 0. */
type Storage = { format: number; alpha: number; width: number; height: number; content: number };

class CountingGl {
  calls = new Map<string, number>();
  mask: [boolean, boolean, boolean, boolean] = [true, true, true, true];
  clearValue: [number, number, number, number] = [0, 0, 0, 0];
  draw: object | null = null;
  read: object | null = null;
  renderbuffer: object | null = null;
  active = 0;
  units: (object | null)[] = [];
  get texture(): object | null { return this.units[this.active] ?? null; }
  current: Program | null = null;
  /** Content of unit 0's texture at each draw. */
  sampled: number[] = [];
  private contents = 1000;
  attachments = new Map<object, object>();
  storage = new Map<object, Storage>();
  draws: Program[] = [];
  fragmentAlpha = 0.25;
  /** A native draw error, as WebGL records for a rejected draw. */
  rejectDraws = false;
  error = 0;
  private next = 1;
  getError() { const error = this.error; this.error = 0; return error; }
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
      case 0x84e0: return 0x84c0 + this.active;
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
  activeTexture(unit: number) { this.active = unit - 0x84c0; }
  /** WebGL fixes a texture's target at its first bind. */
  targets = new Map<object, number>();
  bindTexture(target: number, texture: object | null) {
    const fixed = texture && this.targets.get(texture);
    if (fixed && fixed !== target) { this.error ||= 0x502; return; }
    if (texture) this.targets.set(texture, target);
    this.units[this.active] = texture;
  }
  getTexParameter() { return 0x2601; }
  texImage2D(_target: number, _level: number, format: number, width: number, height: number) {
    this.storage.set(this.texture!, { format, alpha: 0, width, height, content: ++this.contents });
  }
  texSubImage2D() { this.storage.get(this.texture!)!.content = ++this.contents; }
  copyTexSubImage2D() {
    const source = this.storage.get(this.attachments.get(this.read!)!)!;
    this.storage.get(this.texture!)!.content = source.content;
  }
  renderbufferStorage(_target: number, format: number, width: number, height: number) {
    this.storage.set(this.renderbuffer!, { format, alpha: 0, width, height, content: ++this.contents });
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
    if (storage) storage.content = ++this.contents;
    if (storage && this.mask[3]) storage.alpha = alpha;
  }
  clear(mask: number) { if (mask & 0x4000) this.writeAlpha(this.clearValue[3]); }
  drawArrays() {
    if (this.rejectDraws) { this.error ||= 0x502; return; }
    this.draws.push(this.current!);
    const unit0 = this.units[0];
    this.sampled.push(unit0 ? this.storage.get(unit0)?.content ?? 0 : 0);
    this.writeAlpha(this.fragmentAlpha);
  }
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
  const sendBytes = (op: number, payload: Uint8Array) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true); view.setUint16(2, payload.length, true);
    b.cmdbufView!.set(payload, 4);
    expect(decodeAndDispatch(b, 0, 4 + payload.length)).toBe(0);
  };
  /** An element buffer holding `indices` (u16) bound to ELEMENT_ARRAY_BUFFER. */
  const elements = (name: number, indices: number[]) => {
    send(O.OP_BIND_BUFFER, [0x8893, name]);
    const payload = new Uint8Array(12 + indices.length * 2), v = new DataView(payload.buffer);
    v.setUint32(0, 0x8893, true); v.setUint32(4, indices.length * 2, true);
    indices.forEach((index, i) => v.setUint16(8 + i * 2, index, true));
    v.setUint32(8 + indices.length * 2, 0x88e4, true);
    sendBytes(O.OP_BUFFER_DATA, payload);
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
  return { reg, b, gl, send, sendFloats, sendBytes, elements, query, error, clientQuad, renderbuffer, framebuffer, texture, counting };
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

  // [C3]
  it("depth-texture selection scans no texture units while none holds a depth texture", () => {
    const h = setup();
    h.renderbuffer(7, RGBA8);
    h.framebuffer(9, 7);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    const { defaultTextureGets } = perDraw(h, 16, "buffer");
    expect(defaultTextureGets).toBe(0);
    expect(h.gl.draws.every(program => program === h.gl.current)).toBe(true);
  });

  // [C4]
  it("a buffer-array draw with no private state issues only the draw", () => {
    const h = setup();
    h.renderbuffer(7, RGB16F);
    h.framebuffer(9, 7);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    const { calls, attachmentGets, defaultTextureGets } = perDraw(h, 16, "buffer", false);
    expect(calls).toEqual({ drawArrays: 1 });
    expect(attachmentGets).toBe(0);
    expect(defaultTextureGets).toBe(0);
    expect(h.gl.storage.get(h.b.rbos.get(7)!)!.alpha).toBe(1);
    // A native rejection of such a draw still reaches the guest's GetError.
    h.gl.rejectDraws = true;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    h.gl.rejectDraws = false;
    expect(h.error()).toBe(0x502);
    expect(h.error()).toBe(0);
  });

  // [C3]
  it("client-array quads add nothing for completeness, alpha locking or depth sampling", () => {
    const h = setup();
    h.renderbuffer(7, RGB16F);
    h.framebuffer(9, 7);
    h.clientQuad();
    const { calls, attachmentGets, defaultTextureGets } = perDraw(h, 16, "client");
    expect(calls.colorMask ?? 0).toBe(0);
    expect(calls.checkFramebufferStatus ?? 0).toBe(0);
    expect(calls.getParameter ?? 0).toBe(0);
    expect(attachmentGets).toBe(0);
    expect(defaultTextureGets).toBe(0);
    expect(h.gl.storage.get(h.b.rbos.get(7)!)!.alpha).toBe(1);
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
    h.gl.storage.set(bo, { format: RGBA8, alpha: 1, width: 4, height: 4, content: 1 });
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
  it.each([
    ["XRGB8888", 0x34325258, true], ["XBGR2101010", 0x30334258, true], ["XRGB2101010", 0x30335258, true],
    ["XBGR16161616F", 0x48344258, true], ["ABGR16161616F", 0x48344241, false], ["R8", 0x20203852, false],
    ["GR88", 0x38385247, false],
  ])("a GBM %s buffer imported as an EGLImage renderbuffer locks alpha: %s", (_name, format, locked) => {
    const h = setup();
    expect(h.reg.createGpuBo(31, h.b.gl!, 4, 4, format)).not.toBeNull();
    const gpu = h.reg.gpuBo(31)!;
    const token = registerImageSource(h.b, 31, gpu.tex, 4, 4, undefined, gpuSourceStorage(gpu.storage));
    h.send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    expect(h.query(O.QOP_IMAGE_TARGET, [2, 7, token]).getUint32(0, true)).toBe(0);
    h.framebuffer(9, 7);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.mask[3]).toBe(!locked);
    if (locked) expect(h.gl.storage.get(gpu.tex)!.alpha).toBe(1);
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

  // [C3]
  it("depth sampling follows texture bindings, respecification and deletion", () => {
    const h = setup();
    h.renderbuffer(7, RGBA8);
    h.framebuffer(9, 7);
    const primary = h.gl.current;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).toBe(primary);
    // A depth texture bound to the sampled unit selects the variant.
    h.texture(0, 50, 0x1902, 0x1403);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).not.toBe(primary);
    h.send(O.OP_BIND_TEXTURE, [TEX, 30]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).toBe(primary);
    // A bound texture respecified as depth, then back to color.
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1902, 4, 4, 0, 0x1902, 0x1403, 0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).not.toBe(primary);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, 0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).toBe(primary);
    // Texture zero specified as depth is sampled by every unbound unit.
    h.send(O.OP_BIND_TEXTURE, [TEX, 0]);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1902, 4, 4, 0, 0x1902, 0x1403, 0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).not.toBe(primary);
    h.send(O.OP_BIND_TEXTURE, [TEX, 31]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).toBe(primary);
    // Deleting a bound depth texture rebinds texture zero (depth here).
    h.send(O.OP_BIND_TEXTURE, [TEX, 50]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).not.toBe(primary);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, 0]);
    h.send(O.OP_BIND_TEXTURE, [TEX, 0]);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, 0]);
    h.send(O.OP_BIND_TEXTURE, [TEX, 50]);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1902, 4, 4, 0, 0x1902, 0x1403, 0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).not.toBe(primary);
    expect(h.query(O.QOP_IMAGE_OBJECT_DELETE, [1, 50]).getUint32(0, true)).toBe(0);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.at(-1)).toBe(primary);
    expect(h.error()).toBe(0);
  });
});

describe("EGLImage siblings sample current storage without per-draw copies", () => {
  /** A compositor: output FBO 9 (RGBA8 renderbuffer 7) and client texture
   * 60, an EGLImage sibling of buffer storage `bo` (token). */
  function compositor() {
    const h = setup();
    h.renderbuffer(7, RGBA8);
    h.framebuffer(9, 7);
    const bo = h.gl.createTexture();
    h.gl.storage.set(bo, { format: RGBA8, alpha: 1, width: 4, height: 4, content: 1 });
    const token = registerImageSource(h.b, 41, bo, 4, 4);
    h.send(O.OP_ACTIVE_TEXTURE, [0x84c0]);
    h.send(O.OP_BIND_TEXTURE, [TEX, 60]);
    expect(h.query(O.QOP_IMAGE_TARGET, [1, 60, token]).getUint32(0, true)).toBe(0);
    const canonical = () => h.gl.storage.get(bo)!.content;
    const sample = () => { h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]); return h.gl.sampled.at(-1); };
    return { h, bo, token, canonical, sample };
  }

  // [C5]
  it("a steady frame copies nothing", () => {
    const { h, canonical, sample } = compositor();
    expect(sample()).toBe(canonical());
    const { calls } = perDraw(h, 16, "buffer", false);
    expect(calls.copyTexSubImage2D ?? 0).toBe(0);
    expect(calls.getParameter ?? 0).toBe(0);
    expect(h.gl.sampled.slice(-16)).toEqual(new Array(16).fill(canonical()));
    // Rebinding the sibling each quad, as a compositor does, changes nothing.
    const bound = perDraw(h, 16, "buffer");
    expect(bound.calls.copyTexSubImage2D ?? 0).toBe(0);
    expect(h.error()).toBe(0);
  });

  // [C5]
  it("copies once after each write to the canonical storage, by any path", () => {
    const { h, bo, token, canonical, sample } = compositor();
    sample();
    const copies = () => h.gl.calls.get("copyTexSubImage2D") ?? 0;
    const once = (write: () => void) => {
      write();
      h.gl.calls.clear();
      expect(sample()).toBe(canonical());
      expect(copies()).toBe(1);
      h.gl.calls.clear();
      expect(sample()).toBe(canonical());
      expect(copies()).toBe(0);
    };
    // A client draws into the buffer through an EGLImage renderbuffer.
    once(() => {
      h.send(O.OP_BIND_RENDERBUFFER, [RBO, 70]);
      expect(h.query(O.QOP_IMAGE_TARGET, [2, 70, token]).getUint32(0, true)).toBe(0);
      h.framebuffer(71, 70);
      h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
      h.send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    });
    // ...or clears it.
    once(() => {
      h.send(O.OP_BIND_FRAMEBUFFER, [FBO, 71]);
      h.send(O.OP_CLEAR, [0x4000]);
      h.send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    });
    // ...or writes pixels through another sibling texture.
    once(() => {
      h.send(O.OP_ACTIVE_TEXTURE, [0x84c1]);
      h.send(O.OP_BIND_TEXTURE, [TEX, 72]);
      expect(h.query(O.QOP_IMAGE_TARGET, [1, 72, token]).getUint32(0, true)).toBe(0);
      h.send(O.OP_TEX_SUB_IMAGE_2D, [TEX, 0, 0, 0, 1, 1, 0x1908, 0x1401, 4, 0x01020304]);
      // Only unit 0's sibling is counted below; a bound sibling copies too.
      h.send(O.OP_BIND_TEXTURE, [TEX, 0]);
      h.send(O.OP_ACTIVE_TEXTURE, [0x84c0]);
    });
    expect(h.gl.storage.get(bo)!.content).toBe(canonical());
    expect(h.error()).toBe(0);
  });

  // [C5]
  it("copies after a client renders into a GBM buffer as its default framebuffer", () => {
    const { h } = compositor();
    expect(h.reg.createGpuBo(31, h.b.gl!, 4, 4, 0x34325241)).not.toBeNull();
    const gpu = h.reg.gpuBo(31)!;
    const token = registerImageSource(h.b, 31, gpu.tex, 4, 4);
    h.send(O.OP_BIND_TEXTURE, [TEX, 61]);
    expect(h.query(O.QOP_IMAGE_TARGET, [1, 61, token]).getUint32(0, true)).toBe(0);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    // The EGL surface's default framebuffer is the buffer's own framebuffer.
    h.b.shadow.fbo = gpu.fbo;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    h.send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.sampled.at(-1)).toBe(h.gl.storage.get(gpu.tex)!.content);
    expect(h.error()).toBe(0);
  });
});


describe("BindTexture", () => {
  // [C6]
  it("rebinding a texture to its own target issues only the bind", () => {
    const h = setup();
    h.send(O.OP_BIND_TEXTURE, [TEX, 30]);
    h.counting();
    for (let i = 0; i < 16; i++) h.send(O.OP_BIND_TEXTURE, [TEX, 30 + (i % 2)]);
    expect(Object.fromEntries(h.gl.calls)).toEqual({ bindTexture: 16 });
    expect(h.b.shadow.textureUnits[0]).toBe(h.b.textures.get(31));
    expect(h.error()).toBe(0);
  });

  // [C6]
  it("a bind to another target than the texture's still fails without changing the binding", () => {
    const h = setup();
    h.send(O.OP_BIND_TEXTURE, [0x8513, 40]);
    h.send(O.OP_BIND_TEXTURE, [TEX, 30]);
    h.send(O.OP_BIND_TEXTURE, [0x8513, 30]);
    expect(h.error()).toBe(0x502);
    expect(h.b.shadow.cubeTextureUnits[0]).toBe(h.b.textures.get(40));
    h.send(O.OP_BIND_TEXTURE, [0x8513, 30]);
    expect(h.error()).toBe(0x502);
    h.send(O.OP_BIND_TEXTURE, [0x8513, 0]);
    expect(h.b.shadow.cubeTextureUnits[0]).toBe(null);
    expect(h.error()).toBe(0);
  });
});

