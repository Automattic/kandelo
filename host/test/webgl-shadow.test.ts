import { describe, expect, it, vi } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import {
  defaultShadow,
  GL_BLEND,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_PACK_ALIGNMENT,
  GL_POLYGON_OFFSET_FILL,
  GL_READ_FRAMEBUFFER,
  GL_SCISSOR_TEST,
  GL_STENCIL_TEST,
  GL_TEXTURE0,
  GL_UNPACK_ALIGNMENT,
} from "../src/webgl/shadow.js";

class StubGl {
  getError() { return 0; }
  getParameter(name: number): unknown {
    return name === 0x0d3a ? new Int32Array([16384, 16384]) : 32;
  }
  colorMask(...a: boolean[]) {  }
  depthMask(...a: boolean[]) {  }
  stencilFuncSeparate(...a: number[]) {  }
  stencilMaskSeparate(...a: number[]) {  }
  stencilOpSeparate(...a: number[]) {  }
  blendColor(...a: number[]) {  }
  clearDepth(...a: number[]) {  }
  clearStencil(...a: number[]) {  }
  depthRange(...a: number[]) {  }
  polygonOffset(...a: number[]) {  }
  sampleCoverage(...a: unknown[]) {  }
  lineWidth(...a: number[]) {  }
  bindBuffer(...a: unknown[]) {  }
  bindRenderbuffer(...a: unknown[]) {  }
  vertexAttrib4f(...a: number[]) {  }
  clearColor() {}
  viewport() {}
  scissor() {}
  enable() {}
  disable() {}
  blendFunc() {}
  blendFuncSeparate() {}
  blendEquationSeparate() {}
  depthFunc() {}
  cullFace() {}
  frontFace() {}
  pixelStorei() {}
  bindTexture() {}
  activeTexture() {}
  useProgram() {}
  bindVertexArray() {}
  bindFramebuffer() {}
  createTexture() { return {}; }
  createProgram() { return {}; }
  linkProgram() {}
  getProgramParameter(_program: unknown, pname: number) { return pname === 0x8b82 ? true : 0; }
  createVertexArray() { return {}; }
  createFramebuffer() { return {}; }
}

class Tlv {
  view: DataView;
  p = 0;
  constructor(buf: ArrayBuffer) { this.view = new DataView(buf); }
  op(op: number, payloadLen: number): { p: number } {
    this.view.setUint16(this.p, op, true);
    this.view.setUint16(this.p + 2, payloadLen, true);
    const start = this.p + 4;
    this.p = start + payloadLen;
    return { p: start };
  }
}

function setupBinding() {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096), 0, 4096);
  b.gl = new StubGl() as unknown as WebGL2RenderingContext;
  return b;
}

describe("GlShadowState — defaults", () => {
  it("defaultShadow returns plan §B1 initial state", () => {
    const s = defaultShadow();
    expect(s.viewport).toEqual([0, 0, 0, 0]);
    expect(s.scissor).toEqual({ enabled: false, rect: [0, 0, 0, 0] });
    expect(s.clearColor).toEqual([0, 0, 0, 0]);
    expect(s.depthTestEnabled).toBe(false);
    expect(s.depthFunc).toBe(0x0201);
    expect(s.blendEnabled).toBe(false);
    expect(s.cullFaceEnabled).toBe(false);
    expect(s.cullFace).toBe(0x0405);
    expect(s.frontFace).toBe(0x0901);
    expect(s.currentProgram).toBeNull();
    expect(s.vao).toBeNull();
    expect(s.fbo).toBeNull();
    expect(s.activeTexture).toBe(0);
    expect(s.unpackAlignment).toBe(4);
    expect(s.packAlignment).toBe(4);
    expect(s.textureUnits.length).toBe(32);
    expect(s.textureUnits.every((u) => u === null)).toBe(true);
  });

  it("registry.bind() installs a fresh shadow per binding", () => {
    const reg = new GlContextRegistry();
    reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
    reg.bind({ pid: 2, cmdbufAddr: 0, cmdbufLen: 4096 });
    const b1 = reg.get(1)!;
    const b2 = reg.get(2)!;
    expect(b1.shadow).not.toBe(b2.shadow);
    expect(b1.shadow.textureUnits).not.toBe(b2.shadow.textureUnits);
  });
});

describe("cmdbuf decoder — shadow writes", () => {
  it("records the driver-clamped viewport dimensions", () => {
    const b=setupBinding();
    b.gl!.getParameter=() => new Int32Array([4096,3072]);
    const t=new Tlv(b.cmdbufView!.buffer), record=t.op(O.OP_VIEWPORT,16);
    [1,2,5000,5000].forEach((word,i) => t.view.setInt32(record.p+i*4,word,true));
    expect(decodeAndDispatch(b,0,t.p)).toBe(0);
    expect(b.shadow.viewport).toEqual([1,2,4096,3072]);
  });

  it("rejects texture units beyond the native combined-unit limit", () => {
    const b=setupBinding();
    b.gl!.getParameter=() => 48;
    const active=vi.spyOn(b.gl!,"activeTexture");
    const t=new Tlv(b.cmdbufView!.buffer), record=t.op(O.OP_ACTIVE_TEXTURE,4);
    t.view.setUint32(record.p,GL_TEXTURE0+48,true);
    expect(decodeAndDispatch(b,0,t.p)).toBe(0);
    expect(b.shadow.activeTexture).toBe(0);
    expect(active).not.toHaveBeenCalled();
    const reply=new Uint8Array(4);
    expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),reply)).toBe(4);
    expect(new DataView(reply.buffer).getUint32(0,true)).toBe(0x500);
  });

  it.each(["none", "invalidate", "reset-and-invalidate"])("clears higher unused units after %s", (invalidation) => {
    const first=setupBinding(), second=setupBinding();
    second.gl=first.gl;
    first.gl!.getParameter=() => 48;
    let active=0;
    const nativeBindings=new Map<number,unknown>();
    first.gl!.activeTexture=(unit: number) => { active=unit-GL_TEXTURE0; };
    first.gl!.bindTexture=(target: number, texture: unknown) => {
      if(target===0x0de1) nativeBindings.set(active,texture);
    };
    const object={} as WebGLTexture;
    first.textures.set(1,object);
    const mux=new GlMuxer(first.gl!);
    mux.switchTo(first);
    const t=new Tlv(first.cmdbufView!.buffer);
    let record=t.op(O.OP_ACTIVE_TEXTURE,4);
    t.view.setUint32(record.p,GL_TEXTURE0+40,true);
    record=t.op(O.OP_BIND_TEXTURE,8);
    t.view.setUint32(record.p,0x0de1,true); t.view.setUint32(record.p+4,1,true);
    expect(decodeAndDispatch(first,0,t.p)).toBe(0);
    expect(nativeBindings.get(40)).toBe(object);
    if (invalidation === "reset-and-invalidate") first.shadow = defaultShadow();
    if (invalidation !== "none") mux.invalidateCurrent();
    mux.switchTo(second);
    expect(nativeBindings.get(40)).toBeNull();
    mux.switchTo(first);
    expect(nativeBindings.get(40)).toBe(invalidation === "reset-and-invalidate" ? null : object);
  });
  it.each([O.OP_CLEAR_COLOR, O.OP_BLEND_COLOR])("clamps color state for command %i", (op) => {
    const b = setupBinding();
    const t = new Tlv(b.cmdbufView!.buffer), record = t.op(op, 16);
    [-1, 2, 0.25, 0.5].forEach((value, i) => t.view.setFloat32(record.p + i * 4, value, true));
    expect(decodeAndDispatch(b, 0, t.p)).toBe(0);
    expect(op === O.OP_CLEAR_COLOR ? b.shadow.clearColor : b.shadow.blendColor)
      .toEqual([0, 1, 0.25, 0.5]);
  });
  it.each([
    [O.OP_VIEWPORT,[0,0,-1,16],0x501],
    [O.OP_SCISSOR,[0,0,16,-1],0x501],
    [O.OP_DEPTH_FUNC,[0],0x500],
    [O.OP_CULL_FACE,[0],0x500],
    [O.OP_FRONT_FACE,[0],0x500],
    [O.OP_LINE_WIDTH,[0],0x501],
    [O.OP_BLEND_EQUATION_SEPARATE,[0,0x8006],0x500],
    [O.OP_BLEND_FUNC,[1,0x0308],0x500], // saturate is a source-only factor
    [O.OP_BLEND_FUNC_SEPARATE,[1,0,0,0xffffffff],0x500],
    [O.OP_PIXEL_STOREI,[GL_PACK_ALIGNMENT,3],0x501],
    [O.OP_PIXEL_STOREI,[0x0d02,4],0x500], // pack row length is WebGL2-only
    [O.OP_ENABLE,[0x8c89],0x500], // GLES3 rasterizer-discard is not GLES2
  ])("invalid state command %i preserves the complete owner shadow", (op, words, error) => {
    const b=setupBinding(), before=structuredClone(b.shadow);
    const t=new Tlv(b.cmdbufView!.buffer);
    const record=t.op(op as number,(words as number[]).length*4);
    (words as number[]).forEach((word,i) => t.view.setInt32(record.p+i*4,word,true));
    expect(decodeAndDispatch(b,0,t.p)).toBe(0);
    expect(b.shadow).toEqual(before);
    const reply=new Uint8Array(4);
    expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),reply)).toBe(4);
    expect(new DataView(reply.buffer).getUint32(0,true)).toBe(error);
  });
  it("OP_VIEWPORT writes shadow.viewport", () => {
    const b = setupBinding();
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_VIEWPORT, 16);
    t.view.setInt32(h.p, 10, true);
    t.view.setInt32(h.p + 4, 20, true);
    t.view.setInt32(h.p + 8, 640, true);
    t.view.setInt32(h.p + 12, 400, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.viewport).toEqual([10, 20, 640, 400]);
  });

  it("OP_CLEAR_COLOR writes shadow.clearColor", () => {
    const b = setupBinding();
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_CLEAR_COLOR, 16);
    t.view.setFloat32(h.p, 0.5, true);
    t.view.setFloat32(h.p + 4, 0.25, true);
    t.view.setFloat32(h.p + 8, 0.125, true);
    t.view.setFloat32(h.p + 12, 1.0, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.clearColor.map((x) => +x.toFixed(3))).toEqual([0.5, 0.25, 0.125, 1.0]);
  });

  it("OP_ENABLE / OP_DISABLE flip the matching shadow cap bits", () => {
    const b = setupBinding();
    for (const cap of [GL_DEPTH_TEST, GL_STENCIL_TEST, GL_BLEND, GL_CULL_FACE, GL_POLYGON_OFFSET_FILL]) {
      const t = new Tlv(b.cmdbufView!.buffer);
      const h = t.op(O.OP_ENABLE, 4);
      t.view.setUint32(h.p, cap, true);
      decodeAndDispatch(b, 0, t.p);
    }
    expect(b.shadow.depthTestEnabled).toBe(true);
    expect(b.shadow.stencilTestEnabled).toBe(true);
    expect(b.shadow.blendEnabled).toBe(true);
    expect(b.shadow.cullFaceEnabled).toBe(true);
    expect(b.shadow.polygonOffsetFillEnabled).toBe(true);

    const t2 = new Tlv(b.cmdbufView!.buffer);
    const h2 = t2.op(O.OP_DISABLE, 4);
    t2.view.setUint32(h2.p, GL_BLEND, true);
    decodeAndDispatch(b, 0, t2.p);
    expect(b.shadow.blendEnabled).toBe(false);
    expect(b.shadow.depthTestEnabled).toBe(true);
  });

  it("OP_ENABLE on an unrecognized cap leaves the shadow untouched", () => {
    const b = setupBinding();
    const snapshot = JSON.stringify(b.shadow);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_ENABLE, 4);
    t.view.setUint32(h.p, 0xDEADBEEF, true);
    expect(() => decodeAndDispatch(b, 0, t.p)).not.toThrow();
    expect(JSON.stringify(b.shadow)).toBe(snapshot);
  });

  it("SCISSOR_TEST enable/disable flips shadow.scissor.enabled without touching rect", () => {
    const b = setupBinding();
    expect(b.shadow.scissor).toEqual({ enabled: false, rect: [0, 0, 0, 0] });

    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_SCISSOR, 16);
    t.view.setInt32(h.p, 1, true);
    t.view.setInt32(h.p + 4, 2, true);
    t.view.setInt32(h.p + 8, 30, true);
    t.view.setInt32(h.p + 12, 40, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.scissor).toEqual({ enabled: false, rect: [1, 2, 30, 40] });

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_ENABLE, 4);
    t.view.setUint32(h.p, GL_SCISSOR_TEST, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.scissor).toEqual({ enabled: true, rect: [1, 2, 30, 40] });

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_DISABLE, 4);
    t.view.setUint32(h.p, GL_SCISSOR_TEST, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.scissor).toEqual({ enabled: false, rect: [1, 2, 30, 40] });
  });

  it("OP_SCISSOR before OP_ENABLE(GL_SCISSOR_TEST) survives switchTo", () => {
    const b = setupBinding();

    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_SCISSOR, 16);
    t.view.setInt32(h.p, 100, true);
    t.view.setInt32(h.p + 4, 0, true);
    t.view.setInt32(h.p + 8, 200, true);
    t.view.setInt32(h.p + 12, 300, true);
    decodeAndDispatch(b, 0, t.p);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_ENABLE, 4);
    t.view.setUint32(h.p, GL_SCISSOR_TEST, true);
    decodeAndDispatch(b, 0, t.p);

    const enableSpy = vi.spyOn(b.gl!, "enable");
    const scissorSpy = vi.spyOn(b.gl!, "scissor");
    new GlMuxer(b.gl!).switchTo(b);
    expect(enableSpy).toHaveBeenCalledWith(GL_SCISSOR_TEST);
    expect(scissorSpy).toHaveBeenCalledWith(100, 0, 200, 300);
  });

  it("OP_BLEND_FUNC duplicates srcRGB→srcA and dstRGB→dstA", () => {
    const b = setupBinding();
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_BLEND_FUNC, 8);
    t.view.setUint32(h.p, 0x0302, true);
    t.view.setUint32(h.p + 4, 0x0303, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.blendFunc).toEqual({
      srcRGB: 0x0302, dstRGB: 0x0303, srcA: 0x0302, dstA: 0x0303,
    });
  });

  it("OP_BLEND_FUNC_SEPARATE writes all four factors", () => {
    const b = setupBinding();
    const spy = vi.spyOn(b.gl!, "blendFuncSeparate");
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_BLEND_FUNC_SEPARATE, 16);
    [0x0302, 0x0303, 0x0001, 0x0303].forEach((f, i) => t.view.setUint32(h.p + i * 4, f, true));
    decodeAndDispatch(b, 0, t.p);
    expect(spy).toHaveBeenCalledWith(0x0302, 0x0303, 0x0001, 0x0303);
    expect(b.shadow.blendFunc).toEqual({
      srcRGB: 0x0302, dstRGB: 0x0303, srcA: 0x0001, dstA: 0x0303,
    });
  });

  it("OP_BLEND_EQUATION_SEPARATE writes both modes and survives switchTo", () => {
    const b = setupBinding();
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_BLEND_EQUATION_SEPARATE, 8);
    t.view.setUint32(h.p, 0x800a, true);     // GL_FUNC_SUBTRACT
    t.view.setUint32(h.p + 4, 0x8006, true); // GL_FUNC_ADD
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.blendEquation).toEqual({ rgb: 0x800a, alpha: 0x8006 });
    const spy = vi.spyOn(b.gl!, "blendEquationSeparate");
    new GlMuxer(b.gl!).switchTo(b);
    expect(spy).toHaveBeenCalledWith(0x800a, 0x8006);
  });

  it("OP_DEPTH_FUNC / OP_CULL_FACE / OP_FRONT_FACE write their shadow fields", () => {
    const b = setupBinding();
    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_DEPTH_FUNC, 4);
    t.view.setUint32(h.p, 0x0203, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.depthFunc).toBe(0x0203);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_CULL_FACE, 4);
    t.view.setUint32(h.p, 0x0404, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.cullFace).toBe(0x0404);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_FRONT_FACE, 4);
    t.view.setUint32(h.p, 0x0900, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.frontFace).toBe(0x0900);
  });

  it("OP_PIXEL_STOREI writes unpack/pack alignment only on matching pnames", () => {
    const b = setupBinding();
    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_PIXEL_STOREI, 8);
    t.view.setUint32(h.p, GL_UNPACK_ALIGNMENT, true);
    t.view.setInt32(h.p + 4, 1, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.unpackAlignment).toBe(1);
    expect(b.shadow.packAlignment).toBe(4);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_PIXEL_STOREI, 8);
    t.view.setUint32(h.p, GL_PACK_ALIGNMENT, true);
    t.view.setInt32(h.p + 4, 8, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.packAlignment).toBe(8);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_PIXEL_STOREI, 8);
    t.view.setUint32(h.p, 0x9240, true);
    t.view.setInt32(h.p + 4, 1, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.unpackAlignment).toBe(1);
    expect(b.shadow.packAlignment).toBe(8);
  });

  it("OP_ACTIVE_TEXTURE + OP_BIND_TEXTURE populate the active unit", () => {
    const b = setupBinding();
    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_GEN_TEXTURES, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 5, true);
    decodeAndDispatch(b, 0, t.p);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_ACTIVE_TEXTURE, 4);
    t.view.setUint32(h.p, GL_TEXTURE0 + 3, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.activeTexture).toBe(3);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_BIND_TEXTURE, 8);
    t.view.setUint32(h.p, 0x0DE1, true);
    t.view.setUint32(h.p + 4, 5, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.textureUnits[3]).toBe(b.textures.get(5)!);
    expect(b.shadow.textureUnits[0]).toBeNull();
  });

  it("OP_USE_PROGRAM writes shadow.currentProgram and b.currentProgram in sync", () => {
    const b = setupBinding();
    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_CREATE_PROGRAM, 4);
    t.view.setUint32(h.p, 7, true);
    decodeAndDispatch(b, 0, t.p);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_LINK_PROGRAM, 4);
    t.view.setUint32(h.p, 7, true);
    decodeAndDispatch(b, 0, t.p);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_USE_PROGRAM, 4);
    t.view.setUint32(h.p, 7, true);
    decodeAndDispatch(b, 0, t.p);

    const prog = b.programs.get(7)!;
    expect(b.shadow.currentProgram).toBe(prog);
    expect(b.currentProgram).toBe(prog);
  });

  it("OP_BIND_VERTEX_ARRAY writes shadow.vao", () => {
    const b = setupBinding();
    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_GEN_VERTEX_ARRAYS, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 11, true);
    decodeAndDispatch(b, 0, t.p);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_BIND_VERTEX_ARRAY, 4);
    t.view.setUint32(h.p, 11, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.vao).toBe(b.vaos.get(11)!);
  });

  it("OP_BIND_FRAMEBUFFER writes shadow.fbo for draw targets only", () => {
    const b = setupBinding();
    let t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_GEN_FRAMEBUFFERS, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 13, true);
    decodeAndDispatch(b, 0, t.p);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_BIND_FRAMEBUFFER, 8);
    t.view.setUint32(h.p, 0x8D40, true);
    t.view.setUint32(h.p + 4, 13, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.fbo).toBe(b.fbos.get(13)!);

    t = new Tlv(b.cmdbufView!.buffer);
    h = t.op(O.OP_BIND_FRAMEBUFFER, 8);
    t.view.setUint32(h.p, GL_READ_FRAMEBUFFER, true);
    t.view.setUint32(h.p + 4, 0, true);
    decodeAndDispatch(b, 0, t.p);
    expect(b.shadow.fbo).toBe(b.fbos.get(13)!);
  });
});

it("keeps cube and 2D texture bindings independent on the same unit", () => {
  const b = setupBinding();
  const commands = new Tlv(b.cmdbufView!.buffer as ArrayBuffer);
  let record = commands.op(O.OP_GEN_TEXTURES, 12);
  commands.view.setUint32(record.p, 2, true);
  commands.view.setUint32(record.p + 4, 11, true);
  commands.view.setUint32(record.p + 8, 12, true);
  record = commands.op(O.OP_BIND_TEXTURE, 8);
  commands.view.setUint32(record.p, 0x0de1, true);
  commands.view.setUint32(record.p + 4, 11, true);
  record = commands.op(O.OP_BIND_TEXTURE, 8);
  commands.view.setUint32(record.p, 0x8513, true);
  commands.view.setUint32(record.p + 4, 12, true);
  expect(decodeAndDispatch(b, 0, commands.p)).toBe(0);
  expect(b.shadow.textureUnits[0]).toBe(b.textures.get(11));
  const gl = b.gl!;
  const bind = vi.spyOn(gl, "bindTexture");
  new GlMuxer(gl).switchTo(b);
  expect(bind).toHaveBeenCalledWith(0x0de1, b.textures.get(11));
  // A cube map is a native 2D array texture (cube-storage.ts).
  expect(bind).toHaveBeenCalledWith(0x8c1a, b.textures.get(12));
});

it("restores dither and pixel-store state across a shared context switch", () => {
  const a = setupBinding(), b = setupBinding();
  b.gl = a.gl;
  const commands = new Tlv(a.cmdbufView!.buffer as ArrayBuffer);
  let record = commands.op(O.OP_DISABLE, 4);
  commands.view.setUint32(record.p, 0x0bd0, true);
  // GLES 2 admits only the alignments; the WebGL2-only names stay at the
  // host's private defaults even when a guest names them.
  for (const [key, value] of [[0x0cf5, 2], [0x0d05, 8], [0x0cf2, 7], [0x0d02, 9]]) {
    record = commands.op(O.OP_PIXEL_STOREI, 8);
    commands.view.setUint32(record.p, key, true);
    commands.view.setInt32(record.p + 4, value, true);
  }
  expect(decodeAndDispatch(a, 0, commands.p)).toBe(0);
  expect(a.errors).toEqual([0x500]);
  const gl = a.gl!;
  const pixelStore = vi.spyOn(gl, "pixelStorei");
  const enable = vi.spyOn(gl, "enable"), disable = vi.spyOn(gl, "disable");
  const muxer = new GlMuxer(gl);
  muxer.switchTo(a);
  expect(disable).toHaveBeenCalledWith(0x0bd0);
  expect(pixelStore).toHaveBeenCalledWith(0x0cf5, 2);
  expect(pixelStore).toHaveBeenCalledWith(0x0d05, 8);
  for (const key of [0x0cf2, 0x0cf3, 0x0cf4, 0x0d02])
    expect(pixelStore).toHaveBeenCalledWith(key, 0);
  pixelStore.mockClear();
  muxer.switchTo(b);
  expect(enable).toHaveBeenCalledWith(0x0bd0);
  expect(pixelStore).toHaveBeenCalledWith(0x0cf5, 4);
  expect(pixelStore).toHaveBeenCalledWith(0x0d05, 4);
  for (const key of [0x0cf2, 0x0cf3, 0x0cf4, 0x0d02])
    expect(pixelStore).toHaveBeenCalledWith(key, 0);
});

async function realScalarContext(extended=false,journal=false,failFirst=false){
 const {createWasmPosixKernelTestHarness}=await import("../src/kernel.js");
 const {createKernelScratchTestInstance}=await import("./support/kernel-scratch-instance.js");
 const {GlProgramJournal}=await import("../src/webgl/program-journal.js");
 const memory=new WebAssembly.Memory({initial:2,maximum:2});let deny=false,coldRefusal=failFirst,viewportQueries=0,extensionQueries=0;
 class ScalarGl extends StubGl {
  isContextLost(){return false;}
  getExtension(_name:string){extensionQueries++;if(deny)throw new Error("late scalar extension reflection");return extended?{}:null;}
  getParameter(pname:number):unknown {
   if(pname===0x0d3a){viewportQueries++;if(coldRefusal){coldRefusal=false;throw new Error("injected cold scalar metadata refusal");}if(deny)throw new Error("late scalar viewport capability allocation");return new Int32Array([4096,3072]);}
   return super.getParameter(pname);
  }
 }
 const gl=new ScalarGl(),kernel=createWasmPosixKernelTestHarness({io:{} as any,callbacks:{getProcessMemory:()=>memory},memory,pointerWidth:4,
  instance:createKernelScratchTestInstance(4,memory,()=>({}),()=>4096)});
 const imports=kernel.testAuthority.buildImportObject(memory).env as Record<string,(...args:any[])=>any>;
 kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:4096});kernel.gl.attachCanvas(7,{width:16,height:16,getContext:()=>gl} as unknown as OffscreenCanvas);
 if(failFirst){expect(imports.host_gl_create_context(7,20,0,0,11)).toBe(-19);expect(kernel.gl.get(7,11)!.contextId).toBeNull();expect(kernel.gl.get(7,11)!.gl).toBeNull();}
 expect(imports.host_gl_create_context(7,21,0,0,11)).toBe(0);const b=kernel.gl.get(7,11)!;b.cmdbufView=new Uint8Array(4096);
 let execution:ReturnType<GlContextRegistry["retainContextExecution"]>|null=null;
 if(journal){execution=kernel.gl.retainContextExecution(7,11,new GlMuxer(b.gl!));expect(GlProgramJournal.create(execution!,4)).not.toBeNull();}
 return {b,gl,kernel,imports,deny:()=>{deny=true;},counts:()=>({viewportQueries,extensionQueries}),done(){b.programJournal?.retire();execution?.release();kernel.releaseProcessViews(7);}};
}
it("warms scalar capabilities during real context admission and allocates nothing on no-renderer refusal",async()=>{
 const f=await realScalarContext();try{expect(f.counts().viewportQueries).toBe(1);expect(f.counts().extensionQueries).toBeGreaterThan(0);}finally{f.done();}
 const {createWasmPosixKernelTestHarness}=await import("../src/kernel.js"),{createKernelScratchTestInstance}=await import("./support/kernel-scratch-instance.js");
 const memory=new WebAssembly.Memory({initial:2,maximum:2}),kernel=createWasmPosixKernelTestHarness({io:{} as any,callbacks:{},memory,pointerWidth:4,
  instance:createKernelScratchTestInstance(4,memory,()=>({}),()=>4096)}),imports=kernel.testAuthority.buildImportObject(memory).env as Record<string,(...args:any[])=>any>;
 kernel.gl.bind({pid:8,sessionId:12,cmdbufAddr:0,cmdbufLen:4096});expect(imports.host_gl_create_context(8,22,0,0,12)).toBe(-19);
 expect(kernel.gl.get(8,12)!.wirePayload??null).toBeNull();kernel.releaseProcessViews(8);
});
for(const journal of [false,true])for(const extended of [false,true])it(`keeps first/warm scalar receivers allocation-safe (journal ${journal}, extended ${extended})`,async()=>{
 const nativeBatch=await import("../src/webgl/native-batch.js"),f=await realScalarContext(extended,journal),b=f.b;
 const records:{bytes:Uint8Array;field:string;values:number[]}[]=[];
 const add=(op:number,field:string,values:number[],floating=false)=>{const bytes=new Uint8Array(4+values.length*4),v=new DataView(bytes.buffer);v.setUint16(0,op,true);v.setUint16(2,values.length*4,true);for(let i=0;i<values.length;i++)floating?v.setFloat32(4+i*4,values[i],true):v.setInt32(4+i*4,values[i],true);records.push({bytes,field,values});};
 add(O.OP_VIEWPORT,"viewport",[1,2,5000,5000]);add(O.OP_SCISSOR,"scissor",[3,4,12,13]);add(O.OP_CLEAR_COLOR,"clearColor",[-1,2,.25,.5],true);
 add(O.OP_BLEND_COLOR,"blendColor",[-1,2,.25,.5],true);add(O.OP_COLOR_MASK,"colorMask",[1,0,1,0]);add(O.OP_DEPTH_RANGEF,"depthRange",[.75,.25],true);
 const rows={viewport:b.shadow.viewport,clearColor:b.shadow.clearColor,blendColor:b.shadow.blendColor,colorMask:b.shadow.colorMask,depthRange:b.shadow.depthRange,scissor:b.shadow.scissor.rect};
 for(const key of ["viewport","clearColor","blendColor","colorMask","depthRange"] as const)Object.defineProperty(b.shadow,key,{configurable:true,get:()=>rows[key],set(){throw new Error(`late scalar ${key} row replacement`);}});
 Object.defineProperty(b.shadow.scissor,"rect",{configurable:true,get:()=>rows.scissor,set(){throw new Error("late scalar scissor row replacement");}});
 f.deny();const cold=f.counts(),Data=globalThis.DataView,Int=globalThis.Int32Array,Float=globalThis.Float32Array,map=Array.prototype.map,flat=Array.prototype.flatMap,set=WeakMap.prototype.set;
 try{
  const forbidden=()=>{throw new Error("late scalar CPU allocation");};
  globalThis.DataView=new Proxy(Data,{construct:forbidden});globalThis.Int32Array=new Proxy(Int,{construct:forbidden});globalThis.Float32Array=new Proxy(Float,{construct:forbidden});Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;
  for(let round=0;round<2;round++)for(const record of records){b.cmdbufView=record.bytes;expect(nativeBatch.withNativeBatch(b,"exact scalar",()=>decodeAndDispatch(b,0,record.bytes.length))).toBe(0);}
 }finally{globalThis.DataView=Data;globalThis.Int32Array=Int;globalThis.Float32Array=Float;Array.prototype.map=map;Array.prototype.flatMap=flat;WeakMap.prototype.set=set;}
 expect(f.counts()).toEqual(cold);expect(b.errors).toEqual([]);expect(rows.viewport).toEqual([1,2,4096,3072]);expect(rows.scissor).toEqual([3,4,12,13]);expect(rows.clearColor).toEqual(extended?[-1,2,.25,.5]:[0,1,.25,.5]);expect(rows.blendColor).toEqual(extended?[-1,2,.25,.5]:[0,1,.25,.5]);expect(rows.colorMask).toEqual([true,false,true,false]);expect(rows.depthRange).toEqual([.75,.25]);f.done();
});

it("refuses a cold scalar metadata failure before context success and permits a fresh admission",async()=>{
 const f=await realScalarContext(false,false,true);try{expect(f.counts().viewportQueries).toBe(2);expect(f.b.contextId).toBe(21);expect(f.b.errors).toEqual([]);}finally{f.done();}
});
for(const journal of [false,true])it(`keeps full scalar batch preflight atomic and releases borrowed bytes (journal ${journal})`,async()=>{
 const f=await realScalarContext(false,journal),b=f.b,before=[...b.shadow.clearColor];let nativeWrites=0;f.gl.clearColor=()=>{nativeWrites++;};
 const bytes=new Uint8Array(27),v=new DataView(bytes.buffer);v.setUint16(0,O.OP_CLEAR_COLOR,true);v.setUint16(2,16,true);for(let i=0;i<4;i++)v.setFloat32(4+i*4,1,true);v.setUint16(20,O.OP_VIEWPORT,true);v.setUint16(22,16,true);b.cmdbufView=bytes;b.errors=[0x505];
 expect(decodeAndDispatch(b,0,bytes.length)).toBe(-22);expect(nativeWrites).toBe(0);expect(b.shadow.clearColor).toEqual(before);expect(b.errors).toEqual([0x505]);expect(b.wirePayload!.byteLength).toBe(0);expect(b.wirePayload!.buffer).not.toBe(bytes.buffer);f.done();
});

for(const journal of [false,true])for(const op of [O.OP_DEPTH_RANGEF,O.OP_BLEND_FUNC_SEPARATE])it(`preserves native scalar exception reset ownership (journal ${journal}, op ${op})`,async()=>{
 const nativeBatch=await import("../src/webgl/native-batch.js"),{RENDERER_LOST,rendererLost}=await import("../src/webgl/renderer-loss.js"),f=await realScalarContext(false,journal),b=f.b;
 const values=op===O.OP_DEPTH_RANGEF?[.25,.75]:[1,0,1,0],bytes=new Uint8Array(4+values.length*4),v=new DataView(bytes.buffer);v.setUint16(0,op,true);v.setUint16(2,values.length*4,true);for(let i=0;i<values.length;i++)op===O.OP_DEPTH_RANGEF?v.setFloat32(4+i*4,values[i],true):v.setUint32(4+i*4,values[i],true);b.cmdbufView=bytes;
 const method=op===O.OP_DEPTH_RANGEF?"depthRange":"blendFuncSeparate",ordinary=f.gl[method];f.gl[method]=()=>{throw new Error("injected native scalar exception");};
 try{expect(nativeBatch.withNativeBatch(b,"scalar native exception",()=>decodeAndDispatch(b,0,bytes.length))).toBe(RENDERER_LOST);expect(rendererLost(b)).toBe(true);expect(b.errors).toEqual([]);expect(b.wirePayload!.byteLength).toBe(0);}finally{f.gl[method]=ordinary;f.done();}
});
