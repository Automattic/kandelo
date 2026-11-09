import { describe, expect, it, vi } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { withNativeBatch } from "../src/webgl/native-batch.js";
import * as recovery from "../src/webgl/native-recovery.js";
import { bindFramebufferObject } from "../src/webgl/image-references.js";
import { registerFramebufferColorStorage,hostFramebufferColorStorage,storageWrites } from "../src/webgl/image-writes.js";
import { requireGlesFramebufferComplete } from "../src/webgl/image-sizes.js";

/** WebGL 2 follows ES 3.0 completeness: attachments of different sizes are
 * complete and render to their intersection. ES 2.0 section 4.4.5 instead
 * requires FRAMEBUFFER_INCOMPLETE_DIMENSIONS, so the stand-in reports the
 * WebGL 2 answer and the host must supply the ES 2.0 one. */
class FramebufferGl {
  errors: number[] = [];
  nativeStatus = 0x8cd5;
  log: string[] = [];
  private next = 1;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x0d33 || pname === 0x851c) return 4096; // MAX_TEXTURE_SIZE, MAX_CUBE_MAP_TEXTURE_SIZE
    if (pname === 0x8b4d) return 16; // MAX_COMBINED_TEXTURE_IMAGE_UNITS
    return null;
  }
  createTexture() { return { texture: this.next++ }; }
  createRenderbuffer() { return { renderbuffer: this.next++ }; }
  createFramebuffer() { return { framebuffer: this.next++ }; }
  checkFramebufferStatus() { return this.nativeStatus; }
  clear() { this.log.push("clear"); }
  drawArrays() { this.log.push("drawArrays"); }
  drawElements() { this.log.push("drawElements"); }
  readPixels() { this.log.push("readPixels"); }
  copyTexImage2D() { this.log.push("copyTexImage2D"); }
  copyTexSubImage2D() { this.log.push("copyTexSubImage2D"); }
  isContextLost() { return false; }
}

function setup() {
  const gl = new FramebufferGl();
  const proxy = new Proxy(gl, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value ?? (() => {});
  } });
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(4096);
  b.gl = proxy as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[]) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word >>> 0, true));
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
  };
  const query = (op: number, words: number[], outLength = 4) => {
    const input = new Uint8Array(words.length * 4), out = new Uint8Array(outLength);
    words.forEach((word, i) => new DataView(input.buffer).setUint32(i * 4, word >>> 0, true));
    return { rc: runGlQuery(b, op, input, out), value: new DataView(out.buffer).getUint32(0, true) };
  };
  const error = () => query(O.QOP_GET_ERROR, []).value;
  const status = () => query(O.QOP_CHECK_FB_STATUS, [0x8d40]).value;
  // TexImage2D payload: target, level, internalformat, w, h, border, format, type, dataLen.
  const texImage = (target: number, level: number, w: number, h: number) =>
    send(O.OP_TEX_IMAGE_2D, [target, level, 0x1908, w, h, 0, 0x1908, 0x1401, 0]);
  const renderbuffer = (name: number, w: number, h: number) => {
    send(O.OP_BIND_RENDERBUFFER, [0x8d41, name]);
    send(O.OP_RENDERBUFFER_STORAGE, [0x8d41, 0x81a5, w, h]);
  };
  return { b, gl, send, query, error, status, texImage, renderbuffer };
}

/** FBO 31 with a 64x64 RGBA color texture 71 and a depth renderbuffer 81. */
function mismatched(depthSize = 32) {
  const t = setup();
  t.send(O.OP_BIND_TEXTURE, [0x0de1, 71]);
  t.texImage(0x0de1, 0, 64, 64);
  t.renderbuffer(81, depthSize, depthSize);
  t.send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 31]);
  t.send(O.OP_FRAMEBUFFER_TEXTURE_2D, [0x8d40, 0x8ce0, 0x0de1, 71, 0]);
  t.send(O.OP_FRAMEBUFFER_RENDERBUFFER, [0x8d40, 0x8d00, 0x8d41, 81]);
  expect(t.error()).toBe(0);
  t.gl.log.length = 0;
  return t;
}

describe("FRAMEBUFFER_INCOMPLETE_DIMENSIONS (ES 2.0 section 4.4.5)", () => {
  it("reports 0x8CD9 when attached images differ in size, and COMPLETE once they match", () => {
    const t = mismatched();
    expect(t.status()).toBe(0x8cd9);
    t.renderbuffer(81, 64, 64);
    expect(t.status()).toBe(0x8cd5);
    expect(t.error()).toBe(0);
  });

  it("follows the clause order: an attachment-incomplete native status is reported first", () => {
    const t = mismatched();
    t.gl.nativeStatus = 0x8cd6; // FRAMEBUFFER_INCOMPLETE_ATTACHMENT
    expect(t.status()).toBe(0x8cd6);
    t.gl.nativeStatus = 0x8cdd; // FRAMEBUFFER_UNSUPPORTED is the later clause
    expect(t.status()).toBe(0x8cd9);
  });

  it("draws and clears on a dimension-incomplete FBO raise INVALID_FRAMEBUFFER_OPERATION with no native work", () => {
    const t = mismatched();
    t.send(O.OP_CLEAR, [0x4000]);
    expect(t.error()).toBe(0x506);
    t.send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(t.error()).toBe(0x506);
    expect(t.gl.log).toEqual([]);
    t.renderbuffer(81, 64, 64);
    t.send(O.OP_CLEAR, [0x4000]);
    t.send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(t.gl.log).toEqual(["clear", "drawArrays"]);
    expect(t.error()).toBe(0);
  });

  it("readPixels and copyTex* from a dimension-incomplete FBO fail without reading", () => {
    const t = mismatched();
    const read = t.query(O.QOP_READ_PIXELS, [0, 0, 1, 1, 0x1908, 0x1401], 4);
    expect(read.rc).toBeLessThan(0);
    expect(t.error()).toBe(0x506);
    t.send(O.OP_BIND_TEXTURE, [0x0de1, 72]);
    t.send(O.OP_COPY_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 0, 0, 8, 8, 0]);
    expect(t.error()).toBe(0x506);
    t.send(O.OP_COPY_TEX_SUB_IMAGE_2D, [0x0de1, 0, 0, 0, 0, 0, 8, 8]);
    expect(t.error()).toBe(0x506);
    expect(t.gl.log).toEqual([]);
  });

  it("tracks mipmap levels defined by GenerateMipmap and CopyTexImage2D", () => {
    const t = mismatched();
    t.send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 0]);
    t.send(O.OP_GENERATE_MIPMAP, [0x0de1]);
    t.send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 31]);
    // Level 1 of a 64x64 base is 32x32, matching the depth renderbuffer.
    t.send(O.OP_FRAMEBUFFER_TEXTURE_2D, [0x8d40, 0x8ce0, 0x0de1, 71, 1]);
    expect(t.status()).toBe(0x8cd5);
    // Respecifying level 1 from the (default) framebuffer changes its size.
    t.send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 0]);
    t.send(O.OP_COPY_TEX_IMAGE_2D, [0x0de1, 1, 0x1908, 0, 0, 16, 16, 0]);
    t.send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 31]);
    expect(t.status()).toBe(0x8cd9);
    expect(t.error()).toBe(0);
  });

  it("tracks each cube face independently", () => {
    const t = setup();
    t.send(O.OP_BIND_TEXTURE, [0x8513, 71]);
    t.texImage(0x8515, 0, 16, 16);
    t.texImage(0x8516, 0, 8, 8);
    t.renderbuffer(81, 16, 16);
    t.send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 31]);
    t.send(O.OP_FRAMEBUFFER_RENDERBUFFER, [0x8d40, 0x8d00, 0x8d41, 81]);
    t.send(O.OP_FRAMEBUFFER_TEXTURE_2D, [0x8d40, 0x8ce0, 0x8515, 71, 0]);
    expect(t.status()).toBe(0x8cd5);
    t.send(O.OP_FRAMEBUFFER_TEXTURE_2D, [0x8d40, 0x8ce0, 0x8516, 71, 0]);
    expect(t.status()).toBe(0x8cd9);
    expect(t.error()).toBe(0);
  });
});

it.each([false,true])("rejects an undefined default framebuffer before native work (read: %s)",read=>{
  const t=setup(),missing={} as WebGLFramebuffer;t.b.undefinedDefaultFbo=missing;
  t.b.shadow.fbo=missing;t.b.shadow.readFbo=missing;
  expect(requireGlesFramebufferComplete(t.b,read)).toBe(false);
  expect(t.b.errors).toEqual([0x506]);expect(t.gl.log).toEqual([]);
});

it("returns a surfaceless framebuffer error for clear/read/copy without resetting the context",()=>{
  const t=setup(),missing={} as WebGLFramebuffer;t.b.undefinedDefaultFbo=missing;
  t.b.shadow.fbo=missing;t.b.shadow.readFbo=missing;
  t.send(O.OP_CLEAR,[0x4000]);expect(t.error()).toBe(0x506);
  expect(t.query(O.QOP_READ_PIXELS,[0,0,1,1,0x1908,0x1401],4).rc).toBeLessThan(0);
  expect(t.error()).toBe(0x506);
  t.send(O.OP_BIND_TEXTURE,[0x0de1,72]);t.gl.log.length=0;
  t.send(O.OP_COPY_TEX_IMAGE_2D,[0x0de1,0,0x1908,0,0,1,1,0]);expect(t.error()).toBe(0x506);
  t.send(O.OP_COPY_TEX_SUB_IMAGE_2D,[0x0de1,0,0,0,0,0,1,1]);expect(t.error()).toBe(0x506);
  expect(t.gl.log).toEqual([]);
  // Ordinary argument errors keep their existing independent priority.
  t.send(O.OP_CLEAR,[0x80000000]);expect(t.error()).toBe(0x501);
});

it("uses the existing drawable's default completeness without allocating a verdict cache entry",()=>{
  const t=setup(),framebuffer={} as WebGLFramebuffer;t.b.renderTargetFbo=framebuffer;
  t.b.shadow.fbo=framebuffer;t.b.shadow.readFbo=framebuffer;
  const spy=vi.spyOn(WeakMap.prototype,"set").mockImplementationOnce(()=>{throw Error("verdict allocation refused");});
  let complete=false;
  try{complete=requireGlesFramebufferComplete(t.b);}finally{spy.mockRestore();}
  expect(complete).toBe(true);expect(t.b.errors).toEqual([]);expect(t.gl.log).toEqual([]);
});


it("binds preallocated default draw/read targets without transaction allocation in a guest batch",()=>{
  const t=setup(),draw={} as WebGLFramebuffer,read={} as WebGLFramebuffer;
  t.b.drawSurface={renderTargetFbo:draw} as any;t.b.readSurface={renderTargetFbo:read} as any;
  const inverse=vi.spyOn(recovery,"nativeInverse").mockImplementation(()=>{throw new Error("allocation");});
  try {
    expect(withNativeBatch(t.b,"default bind",()=>{expect(bindFramebufferObject(t.b,0x8d40,0)).toBe(true);})).toBe(0);
    expect(t.b.shadow.fbo).toBe(draw);expect(t.b.shadow.readFbo).toBe(read);
    expect(t.b.errors).toEqual([]);expect(inverse).not.toHaveBeenCalled();
  }finally{inverse.mockRestore();}
});
it("keeps fallible transaction preparation for private exact and user-target binds",()=>{
  const t=setup();
  const inverse=vi.spyOn(recovery,"nativeInverse").mockImplementation(()=>{throw new Error("allocation");});
  try {
    expect(bindFramebufferObject(t.b,0x8d40,0)).toBe(false);expect(t.error()).toBe(0x505);
    expect(withNativeBatch(t.b,"user bind",()=>{expect(bindFramebufferObject(t.b,0x8d40,17)).toBe(false);})).toBe(0);
    expect(t.error()).toBe(0x505);expect(t.b.fbos.size).toBe(0);
  }finally{inverse.mockRestore();}
});
it("reserves default-target write metadata before its first clear",()=>{
  const t=setup(),fbo={} as WebGLFramebuffer,storage={};
  registerFramebufferColorStorage(fbo,storage);t.b.renderTargetFbo=fbo;t.b.shadow.fbo=fbo;
  const set=vi.spyOn(WeakMap.prototype,"set").mockImplementation(()=>{throw new Error("allocation");});
  try {t.send(O.OP_CLEAR,[0x4000]);expect(t.error()).toBe(0);expect(t.gl.log).toEqual(["clear"]);
    expect(storageWrites(storage).count).toBe(1);expect(set).not.toHaveBeenCalled();
  }finally{set.mockRestore();}
});
it("does not publish default color storage when coherence metadata reservation fails",()=>{
  const fbo={} as WebGLFramebuffer,storage={};
  const original=WeakMap.prototype.set;
  const set=vi.spyOn(WeakMap.prototype,"set").mockImplementation(function(this:WeakMap<object,unknown>,key:object,value:unknown){
    if(key===storage)throw new Error("metadata allocation");return original.call(this,key,value);
  });
  try {expect(()=>registerFramebufferColorStorage(fbo,storage)).toThrow("metadata allocation");
    expect(hostFramebufferColorStorage(fbo)).toBeUndefined();
  }finally{set.mockRestore();}
});
