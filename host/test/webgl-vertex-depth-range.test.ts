import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

type Shader = { type: number; source: string; compiled: string };
type Program = { shaders: Set<Shader>; linked: boolean; vertex: string; fragment: string; uniforms: Map<string, number[]> };

/** Program model with source-derived uniforms: a uniform is active when its
 * name occurs outside its declaration in either stage. */
class RangeGl {
  errors: number[] = [];
  current: Program | null = null;
  draws: { program: Program; uniforms: Map<string, number[]> }[] = [];
  native: [number, number] = [0, 1];
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown { return pname === 0x8b8d ? this.current : 0; }
  createShader(type: number): Shader { return { type, source: "", compiled: "" }; }
  shaderSource(s: Shader, source: string) { s.source = source; }
  compileShader(s: Shader) { s.compiled = s.source; }
  getShaderParameter(s: Shader, pname: number) { return pname === 0x8b4f ? s.type : true; }
  createProgram(): Program {
    return { shaders: new Set(), linked: false, vertex: "", fragment: "", uniforms: new Map() };
  }
  attachShader(p: Program, s: Shader) { p.shaders.add(s); }
  linkProgram(p: Program) {
    p.vertex = [...p.shaders].find(s => s.type === 0x8b31)?.compiled ?? "";
    p.fragment = [...p.shaders].find(s => s.type === 0x8b30)?.compiled ?? "";
    p.linked = p.shaders.size === 2;
    const all = `${p.vertex}\n${p.fragment}`;
    p.uniforms = new Map();
    for (const m of all.matchAll(/uniform\s+(?:\w+\s+)?(float|vec3)\s+(\w+)\s*;/g))
      if (all.split(new RegExp(`\\b${m[2]}\\b`)).length - 1 > 1) p.uniforms.set(m[2], m[1] === "vec3" ? [0, 0, 0] : [0]);
  }
  getProgramParameter(p: Program, pname: number) {
    if (pname === 0x8b82) return p.linked;
    if (pname === 0x8b86) return p.uniforms.size;
    return 0;
  }
  getActiveUniform(p: Program, i: number) {
    const [name, value] = [...p.uniforms][i] ?? [];
    return name ? { name, size: 1, type: value!.length === 3 ? 0x8b51 : 0x1406 } : null;
  }
  getUniformLocation(p: Program, name: string) { return p.uniforms.has(name) ? { p, name } : null; }
  getUniform(p: Program, location: { name: string }) {
    const value = p.uniforms.get(location.name)!;
    return value.length === 1 ? value[0] : new Float32Array(value);
  }
  private set(location: { p: Program; name: string }, value: number[]) {
    if (location.p !== this.current) { this.errors.push(0x502); return; }
    location.p.uniforms.set(location.name, value);
  }
  uniform1f(location: { p: Program; name: string }, x: number) { this.set(location, [x]); }
  uniform1fv(location: { p: Program; name: string }, v: Float32Array) { this.set(location, [v[0]]); }
  uniform3f(location: { p: Program; name: string }, x: number, y: number, z: number) { this.set(location, [x, y, z]); }
  useProgram(p: Program | null) { if (p && !p.linked) this.errors.push(0x502); else this.current = p; }
  deleteProgram() {}
  depthRange(n: number, f: number) { if (n > f) this.errors.push(0x502); else this.native = [n, f]; }
  checkFramebufferStatus() { return 0x8cd5; }
  drawArrays() {
    this.draws.push({ program: this.current!, uniforms: new Map([...this.current!.uniforms].map(([k, v]) => [k, [...v]])) });
  }
}

const READS_RANGE = "varying mediump vec4 v;\n" +
  "void main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); v = vec4(gl_DepthRange.near, gl_DepthRange.far, gl_DepthRange.diff, 1.0); }\n";
const NO_RANGE = "varying mediump vec4 v;\nvoid main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); v = vec4(1.0); }\n";
const FRAGMENT_TRIGGER = "precision mediump float;\nvarying vec4 v;\nuniform float u_other;\n" +
  "void main() { gl_FragColor = u_other > 2.0 ? vec4(gl_DepthRange.near) : v; }\n";
const FRAGMENT_NO_UNIFORM = "precision mediump float;\nvarying vec4 v;\n" +
  "void main() { gl_FragColor = gl_DepthRange.near > 2.0 ? vec4(0.0) : v; }\n";
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

function setup(userAgent: string, vertex: string, fragment: string) {
  vi.stubGlobal("navigator", { userAgent });
  const gl = new RangeGl();
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
  const range = (n: number, f: number) => {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat32(0, n, true); v.setFloat32(4, f, true);
    send(O.OP_DEPTH_RANGEF, [v.getUint32(0, true), v.getUint32(4, true)]);
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
  return { gl, send, error, range, primary: gl.current! };
}

const PRIVATE = "kandelo_native_depth_range_values";

describe("FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM workaround", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("on Firefox, a vertex stage reading gl_DepthRange alongside the trigger reads a private uniform instead", () => {
    const { gl, send, error, range, primary } = setup(FIREFOX, READS_RANGE, FRAGMENT_TRIGGER);
    range(0.25, 0.75);
    send(O.OP_DRAW_ARRAYS, [0, 0, 1]);
    expect(error()).toBe(0);
    const draw = gl.draws[0];
    expect(draw.program).not.toBe(primary);
    expect(draw.program.vertex).not.toMatch(/\bgl_DepthRange\b/);
    expect(draw.program.fragment).toBe(FRAGMENT_TRIGGER);
    expect(draw.uniforms.get(PRIVATE)).toEqual([0.25, 0.75, 0.5]);
    expect(gl.current).toBe(primary);
    // A later range reaches the same variant before its next draw.
    range(0.125, 0.5);
    send(O.OP_DRAW_ARRAYS, [0, 0, 1]);
    expect(gl.draws[1].program).toBe(draw.program);
    expect(gl.draws[1].uniforms.get(PRIVATE)).toEqual([0.125, 0.5, 0.375]);
  });

  it("composes with a reversed range: the private uniform holds the ordered native range", () => {
    const { gl, send, error, range } = setup(FIREFOX, READS_RANGE, FRAGMENT_TRIGGER);
    range(0.75, 0.25);
    send(O.OP_DRAW_ARRAYS, [0, 0, 1]);
    expect(error()).toBe(0);
    const { program, uniforms } = gl.draws[0];
    expect(program.vertex).toContain("gl_Position.z = -gl_Position.z;");
    expect(program.vertex).not.toMatch(/\bgl_DepthRange\b/);
    expect(uniforms.get(PRIVATE)).toEqual([0.25, 0.75, 0.5]);
  });

  it.each([
    ["another engine", CHROME, READS_RANGE, FRAGMENT_TRIGGER],
    ["no other uniform", FIREFOX, READS_RANGE, FRAGMENT_NO_UNIFORM],
    ["a vertex stage that does not read gl_DepthRange", FIREFOX, NO_RANGE, FRAGMENT_TRIGGER],
  ])("leaves %s on the guest executable", (_, userAgent, vertex, fragment) => {
    const { gl, send, error, range, primary } = setup(userAgent, vertex, fragment);
    range(0.25, 0.75);
    send(O.OP_DRAW_ARRAYS, [0, 0, 1]);
    expect(error()).toBe(0);
    expect(gl.draws[0].program).toBe(primary);
  });
});
