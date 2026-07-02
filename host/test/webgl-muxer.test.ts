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
  log: Array<[string, unknown[]]> = [];
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
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

  it("iterates only non-null texture units and ends with shadow.activeTexture", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    const texA = { id: "A" } as unknown as WebGLTexture;
    const texC = { id: "C" } as unknown as WebGLTexture;
    t.shadow.textureUnits[0] = texA;
    t.shadow.textureUnits[2] = texC;
    t.shadow.activeTexture = 5;
    mux.switchTo(t);

    const activeCalls = gl.callsOf("activeTexture").map((c) => (c as number[])[0]);
    expect(activeCalls).toEqual([GL_TEXTURE0 + 0, GL_TEXTURE0 + 2, GL_TEXTURE0 + 5]);
    expect(gl.callsOf("bindTexture")).toEqual([
      [GL_TEXTURE_2D, texA],
      [GL_TEXTURE_2D, texC],
    ]);
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
