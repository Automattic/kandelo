import { describe, expect, it, vi } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
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
  clearColor() {}
  viewport() {}
  scissor() {}
  enable() {}
  disable() {}
  blendFunc() {}
  blendFuncSeparate() {}
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
