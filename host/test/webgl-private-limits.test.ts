import { afterEach, describe, expect, it, vi } from "vitest";
import { blendFoldShaderSource } from "../src/webgl/blend-constant.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { vertexDepthRangeShaderSource } from "../src/webgl/vertex-depth-range.js";

/** WebGL 2's own minimums (ES 3.0 table 6.32) as native limits. */
const NATIVE = new Map<number, number>([
  [0x8dfb, 256], // MAX_VERTEX_UNIFORM_VECTORS
  [0x8dfd, 224], // MAX_FRAGMENT_UNIFORM_VECTORS
  [0x8dfc, 15],  // MAX_VARYING_VECTORS
  [0x8869, 16],  // MAX_VERTEX_ATTRIBS
  [0x8872, 16],  // MAX_TEXTURE_IMAGE_UNITS
  [0x8b4c, 16],  // MAX_VERTEX_TEXTURE_IMAGE_UNITS
  [0x8b4d, 32],  // MAX_COMBINED_TEXTURE_IMAGE_UNITS
]);

function binding(native = NATIVE) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 0 });
  const b = reg.get(1)!;
  b.gl = new Proxy({ getError: () => 0, isContextLost: () => false, getParameter: (p: number) => native.get(p) ?? null },
    { get: (target, key) => Reflect.get(target, key) ?? (() => null) }) as unknown as WebGL2RenderingContext;
  const integer = (pname: number) => {
    const input = new Uint8Array(4), out = new Uint8Array(4);
    new DataView(input.buffer).setUint32(0, pname, true);
    expect(runGlQuery(b, O.QOP_GET_INTEGERV, input, out)).toBe(4);
    return new DataView(out.buffer).getInt32(0, true);
  };
  const float = (pname: number) => {
    const input = new Uint8Array(4), out = new Uint8Array(4);
    new DataView(input.buffer).setUint32(0, pname, true);
    expect(runGlQuery(b, O.QOP_GET_FLOATV, input, out)).toBe(4);
    return new DataView(out.buffer).getFloat32(0, true);
  };
  return { b, integer, float };
}

/** Uniform declarations a private variant adds to a stage, each needing at
 * most one vec4 row under GLSL ES 1.00 Appendix A packing. */
function addedUniformRows(guest: string, variant: string): number {
  const declarations = (text: string) => [...text.matchAll(/\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+\w+\s*;/g)];
  const added = declarations(variant).length - declarations(guest).length;
  for (const match of declarations(variant)) expect(["float", "vec2", "vec3", "vec4", "int", "bool", "sampler2D", "samplerCube"])
    .toContain(match[1]);
  return added;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("guest limits leave room for private emulation", () => {
  it("reserves the blend-fold uniform row from MAX_FRAGMENT_UNIFORM_VECTORS on every engine", () => {
    const { integer, float } = binding();
    expect(integer(0x8dfd)).toBe(223);
    expect(float(0x8dfd)).toBe(223);
    // The reduction is exactly what the fragment variant adds.
    const guest = "precision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }\n";
    expect(addedUniformRows(guest, blendFoldShaderSource(guest, true)!)).toBe(NATIVE.get(0x8dfd)! - 223);
  });

  it("reserves the depth-range uniform row from MAX_VERTEX_UNIFORM_VECTORS only where that workaround runs", () => {
    expect(binding().integer(0x8dfb)).toBe(256);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; rv:155.0) Gecko/20100101 Firefox/155.0" });
    const { integer, float } = binding();
    expect(integer(0x8dfb)).toBe(255);
    expect(float(0x8dfb)).toBe(255);
    const guest = "void main() { gl_Position = vec4(gl_DepthRange.near); }\n";
    expect(addedUniformRows(guest, vertexDepthRangeShaderSource(guest))).toBe(NATIVE.get(0x8dfb)! - 255);
  });

  it("leaves limits no private emulation consumes during a guest draw unchanged", () => {
    vi.stubGlobal("navigator", { userAgent: "Firefox/155.0" });
    const { integer } = binding();
    for (const pname of [0x8dfc, 0x8869, 0x8872, 0x8b4c, 0x8b4d]) expect(integer(pname)).toBe(NATIVE.get(pname));
  });

  it("fails loudly when a renderer cannot leave room above the ES 2.0 minimum", () => {
    // ES 2.0 table 6.20: at least 16 fragment uniform vectors.
    const { b } = binding(new Map([[0x8dfd, 16]]));
    const input = new Uint8Array(4), out = new Uint8Array(4);
    new DataView(input.buffer).setUint32(0, 0x8dfd, true);
    expect(() => runGlQuery(b, O.QOP_GET_INTEGERV, input, out)).toThrow(/uniform vectors/);
  });
});
