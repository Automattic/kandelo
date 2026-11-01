import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

type Shader = { type: number; source: string; compiled: string };
type Program = { shaders: Set<Shader>; linked: boolean; vertex: string; fragment: string; uniforms: Map<string, number> };
const SAMPLERS = ["uDepth", "uColor"];

/** Program/texture model. OES_depth_texture issue 2 requires GLSL texture*
 * calls to return (d, d, d, 1.0) for depth textures; WebGL 2 returns
 * (d, 0, 0, 1), so only a rewritten executable is correct. */
class SamplingGl {
  errors: number[] = [];
  current: Program | null = null;
  programs: Program[] = [];
  deleted = new Set<Program>();
  draws: { program: Program; units: Map<string, number> }[] = [];
  native: [number, number] = [0, 1];
  private next = 1;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x8b8d) return this.current;
    if (pname === 0x0d33 || pname === 0x851c) return 4096;
    if (pname === 0x8b4d || pname === 0x8872 || pname === 0x8869) return 16;
    return 0;
  }
  createTexture() { return { texture: this.next++ }; }
  createShader(type: number): Shader { return { type, source: "", compiled: "" }; }
  shaderSource(s: Shader, source: string) { s.source = source; }
  compileShader(s: Shader) { s.compiled = s.source; }
  getShaderParameter(s: Shader, pname: number) { return pname === 0x8b4f ? s.type : true; }
  createProgram(): Program {
    const p = { shaders: new Set<Shader>(), linked: false, vertex: "", fragment: "", uniforms: new Map() };
    this.programs.push(p); return p;
  }
  attachShader(p: Program, s: Shader) { p.shaders.add(s); }
  linkProgram(p: Program) {
    p.vertex = [...p.shaders].find(s => s.type === 0x8b31)?.compiled ?? "";
    p.fragment = [...p.shaders].find(s => s.type === 0x8b30)?.compiled ?? "";
    p.linked = p.shaders.size === 2;
    p.uniforms = new Map(SAMPLERS.map(name => [name, 0]));
  }
  getProgramParameter(p: Program, pname: number) {
    if (pname === 0x8b82) return p.linked;
    if (pname === 0x8b86) return SAMPLERS.length;
    return 0;
  }
  getActiveUniform(_p: Program, i: number) { return SAMPLERS[i] ? { name: SAMPLERS[i], size: 1, type: 0x8b5e } : null; }
  getUniformLocation(p: Program, name: string) { return p.uniforms.has(name) ? { p, name } : null; }
  getUniform(p: Program, location: { name: string }) { return p.uniforms.get(location.name); }
  uniform1i(location: { p: Program; name: string }, x: number) {
    if (location.p !== this.current) { this.errors.push(0x502); return; }
    location.p.uniforms.set(location.name, x);
  }
  uniform1iv(location: { p: Program; name: string }, v: Int32Array) { this.uniform1i(location, v[0]); }
  useProgram(p: Program | null) { if (p && !p.linked) this.errors.push(0x502); else this.current = p; }
  deleteProgram(p: Program) { this.deleted.add(p); }
  depthRange(n: number, f: number) { if (n > f) this.errors.push(0x502); else this.native = [n, f]; }
  checkFramebufferStatus() { return 0x8cd5; }
  drawArrays() { this.draws.push({ program: this.current!, units: new Map(this.current!.uniforms) }); }
}

const vertex = "attribute vec4 p;\nvoid main() { gl_Position = p; }\n";
const fragment = "precision mediump float;\nuniform sampler2D uDepth;\nuniform sampler2D uColor;\n" +
  "void main() { gl_FragColor = texture2D(uDepth, vec2(0.5)) + texture2D(uColor, vec2(0.5)); }\n";

function setup() {
  const gl = new SamplingGl();
  const proxy = new Proxy(gl, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value ?? (() => {});
  } });
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
  const error = () => {
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), out)).toBe(4);
    return new DataView(out.buffer).getUint32(0, true);
  };
  const location = (name: string) => {
    const bytes = new TextEncoder().encode(name), input = new Uint8Array(8 + bytes.length);
    new DataView(input.buffer).setUint32(0, 20, true);
    new DataView(input.buffer).setUint32(4, bytes.length, true);
    input.set(bytes, 8);
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, input, out)).toBe(4);
    return new DataView(out.buffer).getInt32(0, true);
  };
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
  const primary = gl.current!;
  send(O.OP_UNIFORM1I, [location("uDepth"), 1]);
  send(O.OP_UNIFORM1I, [location("uColor"), 2]);
  // Unit 1: a depth texture; unit 2: an RGBA texture.
  const image = (unit: number, name: number, format: number, type: number) => {
    send(O.OP_ACTIVE_TEXTURE, [0x84c0 + unit]);
    send(O.OP_BIND_TEXTURE, [0x0de1, name]);
    send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, format, 4, 4, 0, format, type, 0]);
  };
  image(1, 71, 0x1902, 0x1403);
  image(2, 72, 0x1908, 0x1401);
  expect(error()).toBe(0);
  return { b, gl, send, error, location, primary, image };
}

describe("OES_depth_texture luminance sampling (issue 2)", () => {
  it("draws with a variant that returns (d, d, d, 1) only for the depth-bound sampler", () => {
    const { gl, send, error, primary } = setup();
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(error()).toBe(0);
    const variant = gl.draws[0].program;
    expect(variant).not.toBe(primary);
    expect(variant.fragment).toContain("kandelo_depth_texel(true, texture2D(uDepth, vec2(0.5)))");
    expect(variant.fragment).toContain("+ texture2D(uColor, vec2(0.5))");
    // Uniform values (the sampler units) are the guest program's.
    expect(gl.draws[0].units).toEqual(new Map([["uDepth", 1], ["uColor", 2]]));
    expect(gl.current).toBe(primary);
  });

  it("follows sampler units and bindings, using the guest executable when no depth texture is sampled", () => {
    const { gl, send, location, primary, image } = setup();
    send(O.OP_UNIFORM1I, [location("uDepth"), 2]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws[0].program).toBe(primary);
    send(O.OP_UNIFORM1I, [location("uColor"), 1]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws[1].program.fragment).toContain("kandelo_depth_texel(true, texture2D(uColor, vec2(0.5)))");
    expect(gl.draws[1].program.fragment).toContain("texture2D(uDepth, vec2(0.5)) +");
    expect(gl.draws[1].units).toEqual(new Map([["uDepth", 2], ["uColor", 1]]));
    // Respecifying unit 1's texture as RGBA removes the need for a variant.
    image(1, 71, 0x1908, 0x1401);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws[2].program).toBe(primary);
  });

  it("DEPTH_STENCIL textures (OES_packed_depth_stencil) sample depth the same way", () => {
    const { gl, send, error, image } = setup();
    image(1, 71, 0x84f9, 0x84fa);
    expect(error()).toBe(0);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws[0].program.fragment).toContain("kandelo_depth_texel(true, texture2D(uDepth");
  });

  it("composes with the reversed-depth twin in one executable per key", () => {
    const { gl, send, error, primary } = setup();
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat32(0, 1, true); v.setFloat32(4, 0, true);
    send(O.OP_DEPTH_RANGEF, [v.getUint32(0, true), v.getUint32(4, true)]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(error()).toBe(0);
    const both = gl.draws[0].program;
    expect(gl.draws[1].program).toBe(both);
    expect(both.fragment).toContain("kandelo_depth_texel(true, texture2D(uDepth");
    expect(both.vertex).toContain("gl_Position.z = -gl_Position.z;");
    v.setFloat32(0, 0, true); v.setFloat32(4, 1, true);
    send(O.OP_DEPTH_RANGEF, [v.getUint32(0, true), v.getUint32(4, true)]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    const depthOnly = gl.draws[2].program;
    expect(depthOnly).not.toBe(both);
    expect(depthOnly).not.toBe(primary);
    expect(depthOnly.vertex).not.toContain("gl_Position.z = -gl_Position.z;");
    // Every variant is released with the guest executable.
    send(O.OP_USE_PROGRAM, [0]);
    send(O.OP_DELETE_PROGRAM, [20]);
    expect(gl.deleted.has(both) && gl.deleted.has(depthOnly)).toBe(true);
  });
});
