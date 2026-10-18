import { describe, expect, it } from "vitest";
import { GlMuxer } from "../src/webgl/muxer.js";
import {
  defaultShadow,
  GL_BLEND,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
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
  colorMask(...a: boolean[]) { this.log.push(["colorMask", a]); }
  depthMask(...a: boolean[]) { this.log.push(["depthMask", a]); }
  stencilFuncSeparate(...a: number[]) { this.log.push(["stencilFuncSeparate", a]); }
  stencilMaskSeparate(...a: number[]) { this.log.push(["stencilMaskSeparate", a]); }
  stencilOpSeparate(...a: number[]) { this.log.push(["stencilOpSeparate", a]); }
  blendColor(...a: number[]) { this.log.push(["blendColor", a]); }
  clearDepth(...a: number[]) { this.log.push(["clearDepth", a]); }
  clearStencil(...a: number[]) { this.log.push(["clearStencil", a]); }
  depthRange(...a: number[]) { this.log.push(["depthRange", a]); }
  polygonOffset(...a: number[]) { this.log.push(["polygonOffset", a]); }
  sampleCoverage(...a: unknown[]) { this.log.push(["sampleCoverage", a]); }
  lineWidth(...a: number[]) { this.log.push(["lineWidth", a]); }
  bindBuffer(...a: unknown[]) { this.log.push(["bindBuffer", a]); }
  bindRenderbuffer(...a: unknown[]) { this.log.push(["bindRenderbuffer", a]); }
  vertexAttrib4f(...a: number[]) { this.log.push(["vertexAttrib4f", a]); }
  log: Array<[string, unknown[]]> = [];
  private nextVao = 1;
  createVertexArray() { const vao = { vao: this.nextVao++ }; this.log.push(["createVertexArray", [vao]]); return vao; }
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
  blendEquationSeparate(...a: number[]) { this.log.push(["blendEquationSeparate", a]); }
  bindFramebuffer(t: number, f: unknown) { this.log.push(["bindFramebuffer", [t, f]]); }
  viewport(...a: number[]) { this.log.push(["viewport", a]); }
  scissor(...a: number[]) { this.log.push(["scissor", a]); }
  enable(c: number) { this.log.push(["enable", [c]]); }
  disable(c: number) { this.log.push(["disable", [c]]); }
  clearColor(...a: number[]) { this.log.push(["clearColor", a]); }
  depthFunc(f: number) { this.log.push(["depthFunc", [f]]); }
  blendFuncSeparate(...a: number[]) { this.log.push(["blendFuncSeparate", a]); }
  cullFace(m: number) { this.log.push(["cullFace", [m]]); }
  frontFace(m: number) { this.log.push(["frontFace", [m]]); }
  useProgram(p: unknown) { this.log.push(["useProgram", [p]]); }
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
  it("gives each binding its own default vertex array", () => {
    // Two programs sharing one WebGL context must not share vertex
    // attribute state: GL gives every context its own vertex array 0.
    const { gl, mux } = mk();
    const a = newTarget();
    const b = newTarget();
    mux.switchTo(a);
    mux.switchTo(b);
    mux.switchTo(a);
    const created = gl.callsOf("createVertexArray").map((c) => c[0]);
    expect(created).toHaveLength(2);
    expect(a.shadow.defaultVao).toBe(created[0]);
    expect(b.shadow.defaultVao).toBe(created[1]);
    expect(gl.callsOf("bindVertexArray").map((c) => c[0]))
      .toEqual([created[0], created[1], created[0]]);
  });

  it("binds the program's own vertex array when it has one bound", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    const vao = { app: 1 };
    t.shadow.vao = vao as unknown as WebGLVertexArrayObject;
    mux.switchTo(t);
    expect(gl.callsOf("createVertexArray")).toHaveLength(0);
    expect(gl.callsOf("bindVertexArray")).toEqual([[vao]]);
  });

  it("replays the blend equation", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.blendEquation = { rgb: 0x800a, alpha: 0x8006 };
    mux.switchTo(t);
    expect(gl.callsOf("blendEquationSeparate")).toEqual([[0x800a, 0x8006]]);
  });

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

  it("clears unused texture units and ends with shadow.activeTexture", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    const texA = { id: "A" } as unknown as WebGLTexture;
    const texC = { id: "C" } as unknown as WebGLTexture;
    t.shadow.textureUnits[0] = texA;
    t.shadow.textureUnits[2] = texC;
    t.shadow.activeTexture = 5;
    mux.switchTo(t);

    const activeCalls = gl.callsOf("activeTexture").map((c) => (c as number[])[0]);
    expect(activeCalls).toEqual([...Array.from({length: 32}, (_, i) => GL_TEXTURE0 + i), GL_TEXTURE0 + 5]);
    expect(gl.callsOf("bindTexture")).toEqual(t.shadow.textureUnits.map(tex => [GL_TEXTURE_2D, tex]));
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
    // The second replay is the first minus the one-time creation of the
    // binding's default vertex array.
    expect(gl.log.length - after).toBe(after - 1);
  });
  it("restores stencil, masks, clear values and constant attributes across bindings", () => {
    const { gl, mux } = mk();
    const a = newTarget();
    const b = newTarget();
    a.shadow.colorMask = [false, true, false, true];
    a.shadow.clearDepth = 0.25;
    a.shadow.clearStencil = 3;
    a.shadow.stencil.front.writeMask = 0x0f;
    a.shadow.stencil.front.ref = 7;
    a.shadow.vertexAttribValues.set(2, [1, 0.5, 0.25, 1]);
    mux.switchTo(a);
    mux.switchTo(b);
    mux.switchTo(a);
    expect(gl.callsOf("colorMask")).toEqual([a.shadow.colorMask, b.shadow.colorMask, a.shadow.colorMask]);
    expect(gl.callsOf("clearDepth")).toEqual([[0.25], [1], [0.25]]);
    expect(gl.callsOf("clearStencil")).toEqual([[3], [0], [3]]);
    expect(gl.callsOf("stencilMaskSeparate")).toContainEqual([0x0404, 0x0f]);
    expect(gl.callsOf("stencilFuncSeparate")).toContainEqual([0x0404, 0x0207, 7, 0xffffffff]);
    expect(gl.callsOf("vertexAttrib4f")).toEqual([
      [2, 1, 0.5, 0.25, 1], [2, 0, 0, 0, 1], [2, 1, 0.5, 0.25, 1],
    ]);
  });

});
