import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { isOpaqueAlphaStorage } from "../src/webgl/opaque-alpha.js";

/**
 * RGB color formats on RGBA storage (opaque-alpha.ts). WebGL 2 has no
 * renderable RGB16F, so a GL_EXT_color_buffer_half_float RGB16F_EXT
 * renderbuffer is stored as RGBA16F whose alpha starts at 1.0 and is never
 * written: draws and clears into it run with the native alpha write mask off,
 * while the guest's logical COLOR_WRITEMASK is unchanged. Reads, copies and
 * DST_ALPHA blending therefore observe alpha = 1, as for a format without
 * alpha, and the framebuffer is COMPLETE.
 *
 * The fake renderer enforces WebGL 2's renderable renderbuffer formats
 * (RGB16F is INVALID_ENUM), tracks the native write mask and records the
 * alpha each renderbuffer holds after clears and draws.
 */

const FBO = 0x8d40, RBO = 0x8d41, COLOR0 = 0x8ce0, DRAW = 0x8ca9, READ = 0x8ca8;
const RGBA16F = 0x881a, RGB16F = 0x881b;
const COMPLETE = 0x8cd5;
const RENDERABLE = new Set([0x8056, 0x8057, 0x8d62, 0x8058, 0x8051, 0x8229, 0x822b, 0x81a5, 0x8d48, 0x88f0,
  RGBA16F, 0x822f, 0x822d]);

type Storage = { format: number; alpha: number };

class FakeWebGL2 {
  error = 0;
  mask: [boolean, boolean, boolean, boolean] = [true, true, true, true];
  clearValue: [number, number, number, number] = [0, 0, 0, 0];
  scissor = false;
  draw: object | null = null;
  read: object | null = null;
  renderbuffer: object | null = null;
  texture: object | null = null;
  attachments = new Map<object, object>();
  storage = new Map<object, Storage>();
  calls: unknown[][] = [];
  fragmentAlpha = 0.25;
  private next = 1;
  getError() { const e = this.error; this.error = 0; return e; }
  isContextLost() { return false; }
  getExtension(name: string) { return name === "EXT_color_buffer_float" ? {} : null; }
  getParameter(pname: number): unknown {
    switch (pname) {
      case 0x0c23: return [...this.mask];
      case 0x0c22: return new Float32Array(this.clearValue);
      case 0x8ca6: return this.draw;
      case 0x8caa: return this.read;
      case 0x8ca7: return this.renderbuffer;
      case 0x84e0: return 0x84c0;
      case 0x8069: return this.texture;
      case 0x8b4d: return 8;
      case 0x0d33: case 0x851c: return 4096;
      default: return null;
    }
  }
  getRenderbufferParameter(_target: number, pname: number) {
    const format = this.storage.get(this.renderbuffer!)?.format ?? 0;
    return pname === 0x8d44 ? format : pname === 0x8d53 ? (format === RGBA16F ? 16 : 0) : 16;
  }
  isEnabled(cap: number) { return cap === 0x0c11 ? this.scissor : false; }
  enable(cap: number) { if (cap === 0x0c11) this.scissor = true; }
  disable(cap: number) { if (cap === 0x0c11) this.scissor = false; }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean) { this.mask = [r, g, b, a]; this.calls.push(["colorMask", r, g, b, a]); }
  clearColor(r: number, g: number, b: number, a: number) { this.clearValue = [r, g, b, a]; }
  createFramebuffer() { return { framebuffer: this.next++ }; }
  createRenderbuffer() { return { renderbuffer: this.next++ }; }
  createTexture() { return { texture: this.next++ }; }
  deleteFramebuffer(framebuffer: object) { this.attachments.delete(framebuffer); }
  bindFramebuffer(target: number, framebuffer: object | null) {
    if (target !== READ) this.draw = framebuffer;
    if (target !== DRAW) this.read = framebuffer;
  }
  bindRenderbuffer(_target: number, renderbuffer: object | null) { this.renderbuffer = renderbuffer; }
  bindTexture(_target: number, texture: object | null) { this.texture = texture; }
  texImage2D() { this.storage.set(this.texture!, { format: 0x8058, alpha: 0 }); }
  framebufferTexture2D(target: number, _point: number, _textarget: number, texture: object | null) {
    this.framebufferRenderbuffer(target, 0, 0, texture);
  }
  renderbufferStorage(_target: number, format: number) {
    if (!RENDERABLE.has(format)) { this.error ||= 0x500; return; }
    this.storage.set(this.renderbuffer!, { format, alpha: 0 });
  }
  framebufferRenderbuffer(target: number, _point: number, _rbTarget: number, renderbuffer: object | null) {
    const framebuffer = target === READ ? this.read : this.draw;
    if (renderbuffer) this.attachments.set(framebuffer!, renderbuffer); else this.attachments.delete(framebuffer!);
  }
  checkFramebufferStatus() {
    const attached = this.attachments.get(this.draw!);
    return attached && RENDERABLE.has(this.storage.get(attached)?.format ?? 0) ? COMPLETE : 0x8cd6;
  }
  private writeAlpha(alpha: number) {
    const target = this.attachments.get(this.draw!), storage = target && this.storage.get(target);
    if (storage && this.mask[3]) storage.alpha = alpha;
  }
  clear(mask: number) { this.calls.push(["clear", mask]); if (mask & 0x4000) this.writeAlpha(this.clearValue[3]); }
  drawArrays() { this.calls.push(["drawArrays"]); this.writeAlpha(this.fragmentAlpha); }
}

function binding() {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096));
  const fake = new FakeWebGL2();
  b.gl = new Proxy(fake, {
    get(object, name: string) {
      const value = (object as unknown as Record<string, unknown>)[name];
      if (value !== undefined) return typeof value === "function" ? value.bind(object) : value;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[], floats = false) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true); view.setUint16(2, words.length * 4, true);
    words.forEach((word, i) => floats ? view.setFloat32(4 + i * 4, word, true) : view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
  };
  const query = (op: number, words: number[], size = 4) => {
    const out = new Uint8Array(size + 8);
    runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out);
    return new DataView(out.buffer);
  };
  const attach = (internal: number) => {
    send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    expect(query(O.QOP_IMAGE_STORAGE, [O.OP_RENDERBUFFER_STORAGE, RBO, internal, 4, 4]).getUint32(0, true)).toBe(0);
    send(O.OP_BIND_FRAMEBUFFER, [FBO, 9]);
    send(O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, COLOR0, RBO, 7]);
    return fake.storage.get(b.rbos.get(7)!)!;
  };
  return { b, fake, send, query, attach };
}

describe("RGB16F_EXT renderbuffers on RGBA16F storage", () => {
  it("stores RGBA16F with alpha 1.0 and restores every native state it touched", () => {
    const { b, fake, send, query, attach } = binding();
    send(O.OP_CLEAR_COLOR, [0.1, 0.2, 0.3, 0.4], true);
    send(O.OP_ENABLE, [0x0c11]);
    send(O.OP_COLOR_MASK, [1, 0, 1, 1]);
    const storage = attach(RGB16F);
    expect(b.errors).toEqual([]);
    expect(storage).toEqual({ format: RGBA16F, alpha: 1 });
    expect([fake.mask, fake.clearValue, fake.scissor]).toEqual([[true, false, true, true], [0.1, 0.2, 0.3, 0.4].map(Math.fround), true]);
    expect(isOpaqueAlphaStorage(b.rbos.get(7)!)).toBe(true);
    expect(query(O.QOP_CHECK_FB_STATUS, [FBO], 0).getUint32(0, true)).toBe(COMPLETE);
    send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    expect(query(O.QOP_GET_RENDERBUFFER_PARAMETER, [RBO, 0x8d44]).getUint32(4, true)).toBe(RGB16F);
    expect(query(O.QOP_GET_RENDERBUFFER_PARAMETER, [RBO, 0x8d53]).getUint32(4, true)).toBe(0);
  });

  it("clears and draws never write its alpha, and the guest mask is unchanged", () => {
    const { b, fake, send, attach } = binding();
    const storage = attach(RGB16F);
    send(O.OP_CLEAR_COLOR, [0, 0, 0, 0], true);
    fake.calls = [];
    send(O.OP_CLEAR, [0x4000]);
    expect(storage.alpha).toBe(1);
    expect(fake.calls).toEqual([["colorMask", true, true, true, false], ["clear", 0x4000], ["colorMask", true, true, true, true]]);
    fake.calls = [];
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(storage.alpha).toBe(1);
    expect(fake.calls).toEqual([["colorMask", true, true, true, false], ["drawArrays"], ["colorMask", true, true, true, true]]);
    expect(b.shadow.colorMask).toEqual([true, true, true, true]);
    expect(fake.mask).toEqual([true, true, true, true]);
    expect(b.errors).toEqual([]);
  });

  it("needs no lock when the guest does not write alpha, or for RGBA16F", () => {
    const masked = binding();
    masked.attach(RGB16F);
    masked.send(O.OP_COLOR_MASK, [1, 1, 1, 0]);
    masked.fake.calls = [];
    masked.send(O.OP_CLEAR, [0x4000]);
    expect(masked.fake.calls).toEqual([["clear", 0x4000]]);
    const rgba = binding();
    const storage = rgba.attach(RGBA16F);
    rgba.send(O.OP_CLEAR_COLOR, [0, 0, 0, 0.5], true);
    rgba.fake.calls = [];
    rgba.send(O.OP_CLEAR, [0x4000]);
    expect(storage.alpha).toBe(0.5);
    expect(rgba.fake.calls).toEqual([["clear", 0x4000]]);
    expect(isOpaqueAlphaStorage(rgba.b.rbos.get(7)!)).toBe(false);
  });

  it("forgets the opaque storage when the renderbuffer is respecified with alpha", () => {
    const { b, send, query, attach } = binding();
    attach(RGB16F);
    send(O.OP_BIND_RENDERBUFFER, [RBO, 7]);
    expect(query(O.QOP_IMAGE_STORAGE, [O.OP_RENDERBUFFER_STORAGE, RBO, RGBA16F, 4, 4]).getUint32(0, true)).toBe(0);
    expect(isOpaqueAlphaStorage(b.rbos.get(7)!)).toBe(false);
  });
});

describe("GPU buffers of formats without alpha on storage with alpha", () => {
  it.each([[0x34325258, true], [0x34324258, true], [0x34325241, false],
    [0x30335258, true], [0x30334258, true], [0x30334241, false],
    [0x48344258, true], [0x48344241, false]])("format %i starts opaque: %s", (format, opaque) => {
    const reg = new GlContextRegistry();
    const fake = new FakeWebGL2();
    const gl = new Proxy(fake, {
      get(object, name: string) {
        const value = (object as unknown as Record<string, unknown>)[name];
        if (value !== undefined) return typeof value === "function" ? value.bind(object) : value;
        return () => undefined;
      },
    }) as unknown as WebGL2RenderingContext;
    expect(reg.createGpuBo(31, gl, 4, 4, format)).not.toBeNull();
    const tex = reg.gpuBo(31)!.tex;
    expect(isOpaqueAlphaStorage(tex)).toBe(opaque);
    expect(fake.calls.some(call => call[0] === "clear")).toBe(opaque);
    expect(fake.storage.get(tex)!.alpha).toBe(opaque ? 1 : 0);
    expect(fake.mask).toEqual([true, true, true, true]);
  });
});
