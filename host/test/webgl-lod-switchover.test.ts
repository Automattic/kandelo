import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { translateEssl100 } from "../src/webgl/essl3-translation.js";
import { LOD_SWITCH_DIAGNOSTIC_SOURCE, noteTextureFilter, setTextureFilters, textureSwitchesAtHalf } from "../src/webgl/lod-switchover.js";
import { setGlDiagnosticReporter } from "../src/webgl/diagnostics.js";
import type { HostDiagnostic } from "../src/host-diagnostic.js";
import { depthLevelRevision as lodSwitchRevision } from "../src/webgl/texture-levels.js";

/**
 * ES 2.0's magnification/minification switch-over point c = 0.5 (section
 * 3.7.9) for MAG_FILTER LINEAR with MIN_FILTER NEAREST_MIPMAP_NEAREST or
 * NEAREST_MIPMAP_LINEAR (lod-switchover.ts). The text checks pin which
 * lookups the translation rewrites; tests/graphics/shader-rewrite-check
 * draws them with real engines against an ES 2.0 reference.
 */

const TEX = 0x0de1, CUBE = 0x8513, MIN = 0x2801, MAG = 0x2800;
const NEAREST = 0x2600, LINEAR = 0x2601, NMN = 0x2700, LMN = 0x2701, NML = 0x2702, LML = 0x2703;
const LOD = "kandelo_essl3_lod_";

describe("which textures switch at lambda 0.5", () => {
  it("follows ES 2.0's initial filters and every accepted MIN/MAG filter", () => {
    const texture = {} as WebGLTexture;
    // NEAREST_MIPMAP_LINEAR and LINEAR initially.
    expect(textureSwitchesAtHalf(texture)).toBe(true);
    expect(textureSwitchesAtHalf(null)).toBe(false);
    for (const [min, mag, half] of [[NMN, LINEAR, true], [NML, LINEAR, true], [LMN, LINEAR, false], [LML, LINEAR, false],
      [NEAREST, LINEAR, false], [LINEAR, LINEAR, false], [NMN, NEAREST, false], [NML, NEAREST, false]] as const) {
      noteTextureFilter(texture, MIN, min); noteTextureFilter(texture, MAG, mag);
      expect([min, mag, textureSwitchesAtHalf(texture)]).toEqual([min, mag, half]);
    }
  });

  it("ignores values WebGL rejects, rounds floats, and advances the revision only on a change", () => {
    const texture = {} as WebGLTexture;
    const start = lodSwitchRevision();
    noteTextureFilter(texture, MIN, NML);
    expect(lodSwitchRevision()).toBe(start);
    noteTextureFilter(texture, MIN, 0x1234);
    noteTextureFilter(texture, MAG, NMN);
    noteTextureFilter(texture, 0x2802, LINEAR);
    expect([textureSwitchesAtHalf(texture), lodSwitchRevision()]).toEqual([true, start]);
    noteTextureFilter(texture, MIN, LINEAR + 0.2);
    expect([textureSwitchesAtHalf(texture), lodSwitchRevision()]).toEqual([false, start + 1]);
    setTextureFilters(texture, LINEAR, LINEAR);
    expect(lodSwitchRevision()).toBe(start + 1);
  });
});

describe("lookups through switching samplers (ESSL 3.00 translation)", () => {
  const frag = (decls: string, body: string) => `precision mediump float;\n${decls}\nvoid main() {\n${body}\n}\n`;
  const t = (source: string, names: string[], fragment = true) => translateEssl100(source, fragment, new Set(names)).text;

  it("rewrites only the listed samplers' lookups, with their bias and projection", () => {
    const text = t(frag("uniform sampler2D a;\nuniform sampler2D b;\nvarying vec4 v;",
      "gl_FragColor = texture2D(a, v.xy) + texture2D(b, v.xy) + texture2D(a, v.xy, 1.5) + texture2DProj(a, v.xyz) + texture2DProj(a, v);"), ["a"]);
    expect(text).toContain(`${LOD}texture2D ( true , a , v . xy )`);
    expect(text).toContain("texture ( b , v . xy )");
    expect(text).toContain(`${LOD}texture2D ( true , a , v . xy , 1.5 )`);
    expect(text).toContain(`${LOD}texture2DProj ( true , a , v . xyz )`);
    expect(text).toContain(`${LOD}texture2DProj ( true , a , v )`);
    expect(text).toContain("return lambda > 0.5 ? lambda : 0.0;");
    // Nothing listed: the translation is the ordinary one.
    expect(translateEssl100(frag("uniform sampler2D a;", "gl_FragColor = texture2D(a, vec2(0.5));"), true, new Set()).text)
      .toBe(translateEssl100(frag("uniform sampler2D a;", "gl_FragColor = texture2D(a, vec2(0.5));"), true).text);
    expect(t(frag("uniform sampler2D a;", "gl_FragColor = texture2D(a, vec2(0.5));"), ["b"])).not.toContain(LOD);
  });

  it("resolves array elements, struct members, macros and sampler parameters", () => {
    const array = t(frag("uniform sampler2D s[3];\nuniform int k;", "gl_FragColor = texture2D(s[1], vec2(0.5)) + texture2D(s[0], vec2(0.5)) + texture2D(s[k], vec2(0.5));"), ["s[1]", "s[2]"]);
    expect(array).toContain(`${LOD}texture2D ( true , s [ 1 ]`);
    expect(array).toContain("texture ( s [ 0 ]");
    expect(array).toContain(`${LOD}texture2D ( kandelo_essl3_lodarray_s(int(k)) , s [ k ]`);
    expect(array).toContain("bool kandelo_essl3_lodarray_s(int i) { return i == 1 || i == 2; }");
    const member = t(frag("struct S { sampler2D t; float k; };\nuniform S u;", "gl_FragColor = texture2D(u.t, vec2(0.5)) * u.k;"), ["u.t"]);
    expect(member).toContain(`${LOD}texture2D ( true , u . t`);
    const macro = t(frag("uniform sampler2D a;\n#define LOOK(x) texture2D(x, vec2(0.5))", "gl_FragColor = LOOK(a);"), ["a"]);
    expect(macro).toContain(`${LOD}texture2D ( true , a`);
    const param = t("precision mediump float;\nuniform sampler2D a;\nuniform sampler2D b;\n" +
      "vec4 look(sampler2D x, vec2 p);\nvec4 look(sampler2D x, vec2 p) { return texture2D(x, p); }\n" +
      "vec4 twice(vec2 p, sampler2D y) { return look(y, p) * 2.0; }\n" +
      "void main() { gl_FragColor = look(a, vec2(0.5)) + twice(vec2(0.5), b); }\n", ["a"]);
    expect(param).toContain("vec4 look ( sampler2D x , vec2 p , bool kandelo_essl3_lodarg0 ) ;");
    expect(param).toContain(`return ${LOD}texture2D ( kandelo_essl3_lodarg0 , x , p ) ;`);
    expect(param).toContain("look ( y , p , kandelo_essl3_lodarg1 )");
    expect(param).toContain("look ( a , vec2 ( 0.5 ) , true )");
    expect(param).toContain("twice ( vec2 ( 0.5 ) , b , false )");
  });

  it("leaves sampling it cannot resolve to the native rule", () => {
    // Overloads of one arity with different sampler positions.
    const ambiguous = t("precision mediump float;\nuniform sampler2D a;\n" +
      "vec4 f(sampler2D x, vec2 p) { return texture2D(x, p); }\nvec4 f(vec2 p, sampler2D x) { return texture2D(x, p); }\n" +
      "void main() { gl_FragColor = f(a, vec2(0.5)) + texture2D(a, vec2(0.5)); }\n", ["a"]);
    expect(ambiguous).toContain("vec4 f ( sampler2D x , vec2 p ) { return texture ( x , p ) ; }");
    expect(ambiguous).toContain(`${LOD}texture2D ( true , a`);
    // A struct parameter's sampler member.
    const struct = t("precision mediump float;\nstruct S { sampler2D t; };\nuniform S u;\n" +
      "vec4 f(S s) { return texture2D(s.t, vec2(0.5)); }\nvoid main() { gl_FragColor = f(u); }\n", ["u.t"]);
    expect(struct).not.toContain(`${LOD}texture2D (`);
  });

  it("returns each lookup it leaves native that may read a listed sampler, with the reason (D-55)", () => {
    const gaps = (source: string, names: string[]) => translateEssl100(source, true, new Set(names)).lodSwitchGaps;
    const head = "precision mediump float;\n";
    // Overloads of one arity with different sampler positions: any listed
    // sampler may reach them. Both lookups are one gap.
    expect(gaps(head + "uniform sampler2D a;\nuniform sampler2D b;\n" +
      "vec4 f(sampler2D x, vec2 p) { return texture2D(x, p); }\nvec4 f(vec2 p, sampler2D x) { return texture2D(x, p); }\n" +
      "void main() { gl_FragColor = f(a, vec2(0.5)) + texture2D(b, vec2(0.5)); }\n", ["a", "b"]))
      .toEqual([{ reason: "overloaded-function", samplers: ["a", "b"], argument: "x", function: "f" }]);
    // A struct parameter can carry only a struct uniform's samplers.
    const struct = head + "struct S { sampler2D t; };\nuniform S u;\nuniform sampler2D a;\n" +
      "vec4 f(S s) { return texture2D(s.t, vec2(0.5)); }\nvoid main() { gl_FragColor = f(u) + texture2D(a, vec2(0.5)); }\n";
    expect(gaps(struct, ["u.t", "a"])).toEqual([{ reason: "struct-parameter", samplers: ["u.t"], argument: "s . t", function: "f" }]);
    expect(gaps(struct, ["a"])).toBeUndefined();
    // A sampler array parameter: only listed array elements; a plain
    // sampler parameter of the same name is unattributed for the same reason.
    expect(gaps(head + "uniform sampler2D s[2];\nuniform sampler2D a;\n" +
      "vec4 g(sampler2D xs[2]) { return texture2D(xs[1], vec2(0.5)); }\nvec4 g(sampler2D x) { return texture2D(x, vec2(0.5)); }\n" +
      "void main() { gl_FragColor = g(s) + g(a); }\n", ["s[1]", "a"])).toEqual([
      { reason: "array-parameter", samplers: ["s[1]"], argument: "xs [ 1 ]", function: "g" },
      { reason: "array-parameter", samplers: ["a", "s[1]"], argument: "x", function: "g" }]);
    // An index containing a call: the listed elements of that array.
    expect(gaps(head + "uniform sampler2D s[3];\nuniform sampler2D a;\nint k(int i) { return i; }\n" +
      "void main() { gl_FragColor = texture2D(s[k(1)], vec2(0.5)) + texture2D(a, vec2(0.5)); }\n", ["s[1]", "a"]))
      .toEqual([{ reason: "index-expression", samplers: ["s[1]"], argument: "s [ k ( 1 ) ]", function: "main" }]);
    // Everything the rewrite resolves is no gap.
    expect(gaps(head + "uniform sampler2D s[3];\nuniform int k;\nstruct S { sampler2D t; };\nuniform S u;\n" +
      "vec4 look(sampler2D x) { return texture2D(x, vec2(0.5)); }\n" +
      "void main() { gl_FragColor = texture2D(s[1], vec2(0.5)) + texture2D(s[k], vec2(0.5)) + texture2D(u.t, vec2(0.5)) + look(s[2]); }\n",
    ["s[1]", "s[2]", "u.t"])).toBeUndefined();
  });

  it("uses the explicit level of detail in a vertex shader and leaves its implicit lookups alone", () => {
    const text = t("uniform sampler2D a;\nuniform samplerCube c;\nattribute vec4 p;\nvarying vec4 v;\n" +
      "void main() { v = texture2DLod(a, p.xy, p.z) + texture2D(a, p.xy) + texture2DProjLod(a, p, 0.25) + textureCubeLod(c, p.xyz, p.w);\n" +
      "gl_Position = p; }\n", ["a", "c"], false);
    expect(text).toContain(`${LOD}texture2DLod ( true , a , p . xy , p . z )`);
    expect(text).toContain("texture ( a , p . xy )");
    expect(text).toContain(`${LOD}texture2DProjLod ( true , a , p , 0.25 )`);
    expect(text).toContain(`${LOD}textureCubeLod ( true , c , p . xyz , p . w )`);
    expect(text).toContain("return textureLod(x, p, on ? kandelo_essl3_lodLevel(lod) : lod);");
    expect(text).toContain("return kandelo_essl3_textureCubeLod(x, r, on ? kandelo_essl3_lodLevel(lod) : lod);");
  });

  it("computes a cube lookup's level of detail from the selected face", () => {
    const text = t(frag("uniform samplerCube c;\nvarying vec3 r;", "gl_FragColor = textureCube(c, r) + textureCube(c, r, -0.5);"), ["c"]);
    expect(text).toContain(`${LOD}textureCube ( true , c , r )`);
    expect(text).toContain(`${LOD}textureCube ( true , c , r , - 0.5 )`);
    expect(text).toContain("kandelo_essl3_cubeGrad(r, dFdx(r), s, t, m) * size");
    expect(text).toContain("if (!on) return kandelo_essl3_textureCube(x, r, bias);");
  });
});

// --- the draw path ----------------------------------------------------------------

type Shader = { type: number; source: string; compiled: string };
type Program = { shaders: Set<Shader>; linked: boolean; vertex: string; fragment: string; uniforms: Map<string, number>;
  bindings: Map<string, number> };

/** A program model whose uniforms and attributes come from the linked
 * sources, so translated names are visible. `failVersion300` makes ESSL 3.00
 * compiles fail (a variant the engine rejects). */
class LodGl {
  errors: number[] = [];
  current: Program | null = null;
  draws: { program: Program; units: Map<string, number> }[] = [];
  links = 0;
  failVersion300 = false;
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
  compileShader(s: Shader) { s.compiled = this.failVersion300 && s.source.startsWith("#version 300 es") ? "" : s.source; }
  getShaderParameter(s: Shader, pname: number) { return pname === 0x8b4f ? s.type : s.compiled !== "" || s.source === ""; }
  getShaderInfoLog() { return ""; }
  createProgram(): Program { return { shaders: new Set(), linked: false, vertex: "", fragment: "", uniforms: new Map(), bindings: new Map() }; }
  attachShader(p: Program, s: Shader) { p.shaders.add(s); }
  bindAttribLocation(p: Program, at: number, name: string) { p.bindings.set(name, at); }
  linkProgram(p: Program) {
    this.links++;
    p.vertex = [...p.shaders].find(s => s.type === 0x8b31)?.compiled ?? "";
    p.fragment = [...p.shaders].find(s => s.type === 0x8b30)?.compiled ?? "";
    p.linked = p.vertex !== "" && p.fragment !== "";
    p.uniforms = new Map([...`${p.vertex}\n${p.fragment}`.matchAll(/\buniform (?:\w+p )?sampler\w+ (\w+)/g)].map(m => [m[1], 0]));
  }
  attributes(p: Program) { return [...p.vertex.matchAll(/(?:\battribute|\bin) (?:\w+p )?vec4 (\w+)/g)].map(m => m[1]); }
  getProgramParameter(p: Program, pname: number) {
    if (pname === 0x8b82) return p.linked;
    if (pname === 0x8b86) return p.uniforms.size;
    if (pname === 0x8b89) return this.attributes(p).length;
    return 0;
  }
  getActiveUniform(p: Program, i: number) { const name = [...p.uniforms.keys()][i]; return name ? { name, size: 1, type: 0x8b5e } : null; }
  getActiveAttrib(p: Program, i: number) { const name = this.attributes(p)[i]; return name ? { name, size: 1, type: 0x8b52 } : null; }
  getAttribLocation(p: Program, name: string) { return p.bindings.get(name) ?? this.attributes(p).indexOf(name); }
  getUniformLocation(p: Program, name: string) { return p.uniforms.has(name) ? { p, name } : null; }
  getUniform(p: Program, location: { name: string }) { return p.uniforms.get(location.name); }
  uniform1i(location: { p: Program; name: string }, x: number) {
    if (location.p !== this.current) { this.errors.push(0x502); return; }
    location.p.uniforms.set(location.name, x);
  }
  uniform1iv(location: { p: Program; name: string }, v: Int32Array) { this.uniform1i(location, v[0]); }
  useProgram(p: Program | null) { if (p && !p.linked) this.errors.push(0x502); else this.current = p; }
  checkFramebufferStatus() { return 0x8cd5; }
  drawArrays() { this.draws.push({ program: this.current!, units: new Map(this.current!.uniforms) }); }
}

// `sample` is reserved in ESSL 3.00: the translated variant names it
// kandelo_essl1_sample, while the guest's ES 1.00 executable does not.
const vertex = "attribute vec4 sample;\nvoid main() { gl_Position = sample; }\n";
const fragment = "precision mediump float;\nuniform sampler2D uColor;\nuniform sampler2D uOther;\n" +
  "void main() { gl_FragColor = texture2D(uColor, vec2(0.5)) + texture2D(uOther, vec2(0.5)); }\n";

function setup(gl = new LodGl(), fragmentSource = fragment) {
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
  send(O.OP_SHADER_SOURCE, [11, fragmentSource.length], fragmentSource);
  send(O.OP_COMPILE_SHADER, [10]);
  send(O.OP_COMPILE_SHADER, [11]);
  send(O.OP_CREATE_PROGRAM, [20]);
  send(O.OP_ATTACH_SHADER, [20, 10]);
  send(O.OP_ATTACH_SHADER, [20, 11]);
  send(O.OP_BIND_ATTRIB_LOCATION, [20, 3, "sample".length], "sample");
  send(O.OP_LINK_PROGRAM, [20]);
  send(O.OP_USE_PROGRAM, [20]);
  const primary = gl.current!;
  send(O.OP_UNIFORM1I, [location("uColor"), 1]);
  send(O.OP_UNIFORM1I, [location("uOther"), 2]);
  /** A texture on `unit` with the given MIN filter (MAG stays LINEAR). */
  const texture = (unit: number, name: number, min: number, target = TEX) => {
    send(O.OP_ACTIVE_TEXTURE, [0x84c0 + unit]);
    send(O.OP_BIND_TEXTURE, [target, name]);
    send(O.OP_TEX_PARAMETERI, [target, MIN, min]);
  };
  texture(1, 71, LINEAR);
  texture(2, 72, LINEAR);
  expect(error()).toBe(0);
  return { b, gl, send, error, location, primary, texture };
}

describe("draws whose samplers switch at lambda 0.5", () => {
  let diagnostics: HostDiagnostic[] = [];
  beforeEach(() => { diagnostics = []; setGlDiagnosticReporter(diagnostic => diagnostics.push(diagnostic)); });
  afterEach(() => setGlDiagnosticReporter(null));
  it("run the guest executable while no unit holds such a texture", () => {
    const { gl, send, error, primary } = setup();
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.map(d => d.program)).toEqual([primary, primary]);
    expect(error()).toBe(0);
  });

  it("run one translated variant per sampler set, with the guest's attribute bindings and uniform values", () => {
    const { b, gl, send, error, primary, texture } = setup();
    texture(1, 71, NML);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(error()).toBe(0);
    const variant = gl.draws[0].program;
    expect(variant).not.toBe(primary);
    expect(gl.draws[1].program).toBe(variant);
    expect(variant.fragment.startsWith("#version 300 es")).toBe(true);
    expect(variant.fragment).toContain(`${LOD}texture2D ( true , uColor , vec2 ( 0.5 ) )`);
    expect(variant.fragment).toContain("texture ( uOther , vec2 ( 0.5 ) )");
    expect(variant.bindings.get("kandelo_essl1_sample")).toBe(3);
    expect(gl.draws[0].units).toEqual(new Map([["uColor", 1], ["uOther", 2]]));
    expect(gl.current).toBe(primary);
    expect(b.shadow.samplingUnits).toMatchObject({ any: 1, half: 1, depth: 0 });
    // MAG_FILTER NEAREST keeps c = 0: the guest executable again.
    send(O.OP_TEX_PARAMETERI, [TEX, MAG, NEAREST]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws[2].program).toBe(primary);
    send(O.OP_TEX_PARAMETERI, [TEX, MAG, LINEAR]);
    // Both samplers: another variant.
    texture(2, 72, NMN);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    const both = gl.draws[3].program;
    expect(both).not.toBe(variant);
    expect(both.fragment).toContain(`${LOD}texture2D ( true , uOther`);
    expect(error()).toBe(0);
    // The emulation applied to every lookup: nothing to report.
    expect(diagnostics).toEqual([]);
  });

  it("follow bindings, sampler units, texture zero and cube maps", () => {
    const { b, gl, send, location, primary, texture } = setup();
    // An unused unit holding such a texture costs the program nothing.
    texture(5, 75, NML);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.at(-1)!.program).toBe(primary);
    send(O.OP_UNIFORM1I, [location("uOther"), 5]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.at(-1)!.program.fragment).toContain(`${LOD}texture2D ( true , uOther`);
    send(O.OP_BIND_TEXTURE, [TEX, 0]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.at(-1)!.program).toBe(primary);
    // Texture zero, once it exists, has ES 2.0's initial filters.
    send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 4, 4, 0, 0x1908, 0x1401, 0]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.at(-1)!.program.fragment).toContain(`${LOD}texture2D ( true , uOther`);
    send(O.OP_TEX_PARAMETERF, [TEX, MIN, new Uint32Array(new Float32Array([LINEAR]).buffer)[0]]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.at(-1)!.program).toBe(primary);
    // A cube map on the sampled unit is not the 2D sampler's texture.
    texture(5, 76, NML, CUBE);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.at(-1)!.program).toBe(primary);
    expect(b.shadow.samplingUnits).toMatchObject({ any: 1, half: 1, defaults: 0 });
  });

  it("keep the native rule, without an error or a rebuild per draw, when the variant does not compile", () => {
    const gl = new LodGl();
    const { send, error, primary, texture } = setup(gl);
    gl.failVersion300 = true;
    texture(1, 71, NMN);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    const links = gl.links;
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws.map(d => d.program)).toEqual([primary, primary]);
    expect(gl.links).toBe(links);
    expect(error()).toBe(0);
    // Reported once, when the variant failed, not at the draws after it.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ pid: 1, source: LOD_SWITCH_DIAGNOSTIC_SOURCE });
    expect(diagnostics[0].message).toMatch(/^GLES program 20: lookups that may read sampler uColor keep WebGL's .*c = 0 instead of ES 2\.0's c = 0\.5/);
    expect(diagnostics[0].message).toContain("did not compile or link, and is not retried");
    // Another failing sampler set names only the sampler not yet reported.
    texture(2, 72, NML);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(diagnostics.map(d => d.message.match(/read samplers? (\S+) keep/)?.[1])).toEqual(["uColor", "uOther"]);
  });

  it("report lookups the rewrite cannot attribute once per program, reason and sampler, and keep drawing", () => {
    const overloads = "precision mediump float;\nuniform sampler2D uColor;\nuniform sampler2D uOther;\n" +
      "vec4 f(sampler2D x, vec2 p) { return texture2D(x, p); }\nvec4 f(vec2 p, sampler2D x) { return texture2D(x, p); }\n" +
      "void main() { gl_FragColor = f(uColor, vec2(0.5)) + f(vec2(0.5), uOther); }\n";
    const { gl, send, error, location, primary, texture } = setup(new LodGl(), overloads);
    texture(1, 71, NML);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    // The variant runs (with c = 0 for those lookups); no GL error.
    expect(gl.draws[0].program).not.toBe(primary);
    expect(error()).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ pid: 1, source: LOD_SWITCH_DIAGNOSTIC_SOURCE });
    expect(diagnostics[0].message).toContain("GLES program 20: lookups that may read sampler uColor keep");
    expect(diagnostics[0].message).toContain("overloads of one arity take samplers at different positions");
    expect(diagnostics[0].message).toContain("(`x` in f)");
    // A second sampler set: a new variant, and only the new sampler.
    texture(2, 72, NML);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    texture(2, 72, LINEAR);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(diagnostics.map(d => d.message.match(/read samplers? (\S+) keep/)?.[1])).toEqual(["uColor", "uOther"]);
    // A relink is a new executable: its gaps are reported afresh.
    send(O.OP_LINK_PROGRAM, [20]);
    send(O.OP_UNIFORM1I, [location("uColor"), 1]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[2].message).toContain("GLES program 20: lookups that may read sampler uColor keep");
    expect(error()).toBe(0);
  });
});
