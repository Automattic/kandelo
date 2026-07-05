import { describe, expect, it } from "vitest";
import { GlMuxer } from "../src/webgl/muxer.js";
import {
  defaultShadow,
  GL_BLEND,
  GL_BACK,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_FRONT,
  GL_FRAMEBUFFER,
  GL_PACK_ALIGNMENT,
  GL_POLYGON_OFFSET_FILL,
  GL_SCISSOR_TEST,
  GL_STENCIL_TEST,
  GL_TEXTURE0,
  GL_TEXTURE_2D,
  GL_UNPACK_ALIGNMENT,
} from "../src/webgl/shadow.js";

class RecordingGl {
  log: Array<[string, unknown[]]> = [];
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
  bindFramebuffer(t: number, f: unknown) { this.log.push(["bindFramebuffer", [t, f]]); }
  viewport(...a: number[]) { this.log.push(["viewport", a]); }
  scissor(...a: number[]) { this.log.push(["scissor", a]); }
  enable(c: number) { this.log.push(["enable", [c]]); }
  disable(c: number) { this.log.push(["disable", [c]]); }
  clearColor(...a: number[]) { this.log.push(["clearColor", a]); }
  colorMask(...a: boolean[]) { this.log.push(["colorMask", a]); }
  depthMask(v: boolean) { this.log.push(["depthMask", [v]]); }
  depthFunc(f: number) { this.log.push(["depthFunc", [f]]); }
  stencilFuncSeparate(...a: number[]) { this.log.push(["stencilFuncSeparate", a]); }
  stencilMaskSeparate(...a: number[]) { this.log.push(["stencilMaskSeparate", a]); }
  stencilOpSeparate(...a: number[]) { this.log.push(["stencilOpSeparate", a]); }
  blendEquationSeparate(...a: number[]) { this.log.push(["blendEquationSeparate", a]); }
  blendColor(...a: number[]) { this.log.push(["blendColor", a]); }
  blendFuncSeparate(...a: number[]) { this.log.push(["blendFuncSeparate", a]); }
  cullFace(m: number) { this.log.push(["cullFace", [m]]); }
  frontFace(m: number) { this.log.push(["frontFace", [m]]); }
  useProgram(p: unknown) { this.log.push(["useProgram", [p]]); }
  vertexAttrib4f(i: number, x: number, y: number, z: number, w: number) {
    this.log.push(["vertexAttrib4f", [i, x, y, z, w]]);
  }
  activeTexture(u: number) { this.log.push(["activeTexture", [u]]); }
  bindTexture(t: number, tex: unknown) { this.log.push(["bindTexture", [t, tex]]); }
  pixelStorei(p: number, v: number) { this.log.push(["pixelStorei", [p, v]]); }

  callsOf(name: string): Array<unknown[]> {
    return this.log.filter((r) => r[0] === name).map((r) => r[1]);
  }
}

function newTarget() {
  return { shadow: defaultShadow() };
}

function mk(): { gl: RecordingGl; mux: GlMuxer } {
  const gl = new RecordingGl();
  const mux = new GlMuxer(gl as unknown as WebGL2RenderingContext);
  return { gl, mux };
}

describe("GlMuxer.switchTo", () => {
  it("replays viewport, clearColor, useProgram from the target shadow", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.viewport = [10, 20, 640, 400];
    t.shadow.clearColor = [0.1, 0.2, 0.3, 0.4];
    const prog = { id: 7 };
    t.shadow.currentProgram = prog as unknown as WebGLProgram;

    mux.switchTo(t);

    expect(gl.callsOf("viewport")).toEqual([[10, 20, 640, 400]]);
    expect(gl.callsOf("clearColor").map((c) => (c as number[]).map((x) => +x.toFixed(3))))
      .toEqual([[0.1, 0.2, 0.3, 0.4]]);
    expect(gl.callsOf("useProgram")).toEqual([[prog]]);
  });

  it("bindFramebuffer always targets FRAMEBUFFER (draw+read)", () => {
    const { gl, mux } = mk();
    const fbo = { id: 13 };
    const t = newTarget();
    t.shadow.fbo = fbo as unknown as WebGLFramebuffer;
    mux.switchTo(t);
    expect(gl.callsOf("bindFramebuffer")).toEqual([[GL_FRAMEBUFFER, fbo]]);
  });

  it("scissor enabled → gl.enable; disabled → gl.disable; rect is always replayed", () => {
    const { gl: g1, mux: m1 } = mk();
    const t1 = newTarget();
    t1.shadow.scissor = { enabled: true, rect: [1, 2, 30, 40] };
    m1.switchTo(t1);
    expect(g1.callsOf("enable")).toContainEqual([GL_SCISSOR_TEST]);
    expect(g1.callsOf("scissor")).toEqual([[1, 2, 30, 40]]);

    const { gl: g2, mux: m2 } = mk();
    const t2 = newTarget();
    t2.shadow.scissor = { enabled: false, rect: [5, 6, 7, 8] };
    m2.switchTo(t2);
    expect(g2.callsOf("disable")).toContainEqual([GL_SCISSOR_TEST]);
    expect(g2.callsOf("scissor")).toEqual([[5, 6, 7, 8]]);
  });

  it("emits enable/disable for each cap based on the shadow bit", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.depthTestEnabled = true;
    t.shadow.stencilTestEnabled = false;
    t.shadow.blendEnabled = true;
    t.shadow.cullFaceEnabled = false;
    t.shadow.polygonOffsetFillEnabled = true;
    mux.switchTo(t);
    const enables = gl.callsOf("enable").map((c) => (c as number[])[0]);
    const disables = gl.callsOf("disable").map((c) => (c as number[])[0]);
    expect(enables).toContain(GL_DEPTH_TEST);
    expect(enables).toContain(GL_BLEND);
    expect(enables).toContain(GL_POLYGON_OFFSET_FILL);
    expect(disables).toContain(GL_STENCIL_TEST);
    expect(disables).toContain(GL_CULL_FACE);
  });

  it("blendFuncSeparate uses the shadow's per-channel factors", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.blendFunc = { srcRGB: 0x0302, dstRGB: 0x0303, srcA: 1, dstA: 0 };
    mux.switchTo(t);
    expect(gl.callsOf("blendFuncSeparate")).toEqual([[0x0302, 0x0303, 1, 0]]);
  });

  it("replays blend equation and constant blend color", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.blendEquation = { modeRGB: 0x800A, modeA: 0x800B };
    t.shadow.blendColor = [0.1, 0.2, 0.3, 0.4];
    mux.switchTo(t);
    expect(gl.callsOf("blendEquationSeparate")).toEqual([[0x800A, 0x800B]]);
    expect(gl.callsOf("blendColor").map((c) => (c as number[]).map((x) => +x.toFixed(3))))
      .toEqual([[0.1, 0.2, 0.3, 0.4]]);
  });

  it("replays color/depth write masks and stencil state", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.colorMask = [false, true, false, true];
    t.shadow.depthMask = false;
    t.shadow.stencil.front = {
      func: 0x0202,
      ref: 3,
      valueMask: 0x0F,
      writeMask: 0xAA,
      fail: 0x1E01,
      zfail: 0x1E02,
      zpass: 0x1E03,
    };
    t.shadow.stencil.back = {
      func: 0x0203,
      ref: 4,
      valueMask: 0xF0,
      writeMask: 0x55,
      fail: 0x1E00,
      zfail: 0x1E01,
      zpass: 0x1E02,
    };

    mux.switchTo(t);

    expect(gl.callsOf("colorMask")).toEqual([[false, true, false, true]]);
    expect(gl.callsOf("depthMask")).toEqual([[false]]);
    expect(gl.callsOf("stencilFuncSeparate")).toEqual([
      [GL_FRONT, 0x0202, 3, 0x0F],
      [GL_BACK, 0x0203, 4, 0xF0],
    ]);
    expect(gl.callsOf("stencilMaskSeparate")).toEqual([
      [GL_FRONT, 0xAA],
      [GL_BACK, 0x55],
    ]);
    expect(gl.callsOf("stencilOpSeparate")).toEqual([
      [GL_FRONT, 0x1E01, 0x1E02, 0x1E03],
      [GL_BACK, 0x1E00, 0x1E01, 0x1E02],
    ]);
  });

  it("replays all texture units and ends with shadow.activeTexture", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    const texA = { id: "A" } as unknown as WebGLTexture;
    const texC = { id: "C" } as unknown as WebGLTexture;
    t.shadow.textureUnits[0] = texA;
    t.shadow.textureUnits[2] = texC;
    t.shadow.activeTexture = 5;
    mux.switchTo(t);

    const activeCalls = gl.callsOf("activeTexture").map((c) => (c as number[])[0]);
    expect(activeCalls).toEqual([
      ...Array.from({ length: t.shadow.textureUnits.length }, (_, i) => GL_TEXTURE0 + i),
      GL_TEXTURE0 + 5,
    ]);
    const textureCalls = gl.callsOf("bindTexture");
    expect(textureCalls).toHaveLength(t.shadow.textureUnits.length);
    expect(textureCalls[0]).toEqual([GL_TEXTURE_2D, texA]);
    expect(textureCalls[1]).toEqual([GL_TEXTURE_2D, null]);
    expect(textureCalls[2]).toEqual([GL_TEXTURE_2D, texC]);
  });

  it("replays disabled vertex attribute current values", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.vertexAttribValues.set(3, [0.498, 0.498, 0.498, 1]);

    mux.switchTo(t);

    expect(gl.callsOf("vertexAttrib4f")).toEqual([[3, 0.498, 0.498, 0.498, 1]]);
  });

  it("pixelStorei replays unpack and pack alignment", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.unpackAlignment = 1;
    t.shadow.packAlignment = 8;
    mux.switchTo(t);
    expect(gl.callsOf("pixelStorei")).toEqual([
      [GL_UNPACK_ALIGNMENT, 1],
      [GL_PACK_ALIGNMENT, 8],
    ]);
  });

  it("switchTo is a no-op when the target is the current binding", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    mux.switchTo(t);
    const after = gl.log.length;
    expect(after).toBeGreaterThan(0);
    mux.switchTo(t);
    expect(gl.log.length).toBe(after);
  });

  it("switchTo to a different target replays state", () => {
    const { gl, mux } = mk();
    const t1 = newTarget();
    t1.shadow.viewport = [0, 0, 100, 100];
    const t2 = newTarget();
    t2.shadow.viewport = [0, 0, 200, 200];
    mux.switchTo(t1);
    mux.switchTo(t2);
    expect(gl.callsOf("viewport")).toEqual([
      [0, 0, 100, 100],
      [0, 0, 200, 200],
    ]);
  });

  it("invalidateCurrent forces the next switchTo to replay", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    mux.switchTo(t);
    const after = gl.log.length;
    mux.invalidateCurrent();
    mux.switchTo(t);
    expect(gl.log.length).toBe(after * 2);
  });
});
