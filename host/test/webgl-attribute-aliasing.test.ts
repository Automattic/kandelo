import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

type Shader = { type: number; source: string; compiled: string; deleted: boolean };
type Attribute = { name: string; type: number; slots: number; active: boolean };
type Program = {
  shaders: Set<Shader>; bound: Map<string, number>; linked: boolean; log: string;
  vertex: string; attributes: Attribute[]; locations: Map<string, number>;
};
const TYPES: Record<string, [number, number]> = {
  float: [0x1406, 1], vec2: [0x8b50, 1], vec3: [0x8b51, 1], vec4: [0x8b52, 1],
  mat2: [0x8b5a, 2], mat3: [0x8b5b, 3], mat4: [0x8b5c, 4],
};

/** WebGL linker model. An attribute is active when its name is used outside
 * its declaration. WebGL 1.0 "Attribute Aliasing" (and WebGL 2) make the link
 * fail when two active attributes share a location; ES 2.0 section 2.10.4
 * allows that when no path uses both. Unbound attributes take free slots. */
class LinkerGl {
  errors: number[] = [];
  maxAttributes = 16;
  current: Program | null = null;
  programs: Program[] = [];
  deleted = new Set<Program>();
  draws: Program[] = [];
  native: [number, number] = [0, 1];
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x8b8d) return this.current;
    if (pname === 0x8869) return this.maxAttributes;
    return 0;
  }
  createShader(type: number): Shader { return { type, source: "", compiled: "", deleted: false }; }
  shaderSource(s: Shader, source: string) { s.source = source; }
  compileShader(s: Shader) { s.compiled = s.source; }
  getShaderParameter(s: Shader, pname: number) { return pname === 0x8b4f ? s.type : true; }
  deleteShader(s: Shader) { s.deleted = true; }
  createProgram(): Program {
    const p = { shaders: new Set<Shader>(), bound: new Map(), linked: false, log: "", vertex: "", attributes: [], locations: new Map() };
    this.programs.push(p); return p;
  }
  attachShader(p: Program, s: Shader) {
    if ([...p.shaders].some(other => other.type === s.type)) { this.errors.push(0x502); return; }
    p.shaders.add(s);
  }
  detachShader(p: Program, s: Shader) { if (!p.shaders.delete(s)) this.errors.push(0x502); }
  bindAttribLocation(p: Program, index: number, name: string) {
    if (index >= this.maxAttributes) { this.errors.push(0x501); return; }
    p.bound.set(name, index);
  }
  linkProgram(p: Program) {
    const vertex = [...p.shaders].find(s => s.type === 0x8b31);
    p.vertex = vertex?.compiled ?? "";
    p.attributes = []; p.locations = new Map(); p.linked = false; p.log = "";
    if (!vertex || p.shaders.size !== 2) { p.log = "missing shader"; return; }
    for (const m of p.vertex.matchAll(/attribute\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*;/g)) {
      const [type, slots] = TYPES[m[1]];
      const uses = p.vertex.split(new RegExp(`\\b${m[2]}\\b`)).length - 1;
      p.attributes.push({ name: m[2], type, slots, active: uses > 1 });
    }
    const used = new Map<number, string>();
    for (const a of p.attributes.filter(a => a.active && p.bound.has(a.name))) {
      const at = p.bound.get(a.name)!;
      for (let i = 0; i < a.slots; i++) {
        if (at + i >= this.maxAttributes) { p.log = "location out of range"; return; }
        if (used.has(at + i)) { p.log = `aliasing: ${a.name} and ${used.get(at + i)}`; return; }
        used.set(at + i, a.name);
      }
      p.locations.set(a.name, at);
    }
    for (const a of p.attributes.filter(a => a.active && !p.bound.has(a.name))) {
      let at = 0;
      while ([...Array(a.slots).keys()].some(i => used.has(at + i))) at++;
      if (at + a.slots > this.maxAttributes) { p.log = "too many attributes"; return; }
      for (let i = 0; i < a.slots; i++) used.set(at + i, a.name);
      p.locations.set(a.name, at);
    }
    p.linked = true;
  }
  getProgramParameter(p: Program, pname: number) {
    if (pname === 0x8b82) return p.linked;
    if (pname === 0x8b89) return p.linked ? p.attributes.filter(a => a.active).length : 0;
    if (pname === 0x8b85) return p.shaders.size;
    return 0;
  }
  getProgramInfoLog(p: Program) { return p.log; }
  getActiveAttrib(p: Program, i: number) {
    const a = p.attributes.filter(x => x.active)[i];
    return a ? { name: a.name, size: 1, type: a.type } : null;
  }
  getAttribLocation(p: Program, name: string) { return p.locations.get(name) ?? -1; }
  useProgram(p: Program | null) { if (p && !p.linked) this.errors.push(0x502); else this.current = p; }
  deleteProgram(p: Program) { this.deleted.add(p); }
  depthRange(n: number, f: number) { if (n > f) this.errors.push(0x502); else this.native = [n, f]; }
  checkFramebufferStatus() { return 0x8cd5; }
  drawArrays() { this.draws.push(this.current!); }
}

type Cond = "always" | "never" | "A" | "!A";
/** Mirrors dEQP glsAttributeLocationTests.cpp generateVertexShaderTemplate()
 * for GLSL ES 1.00 (the version dEQP forces whenever bindings alias). */
function deqpVertexShader(attributes: { type: string; name: string; cond: Cond }[]): string {
  const toVec4 = (a: { type: string; name: string }) =>
    a.type === "vec2" ? `vec4(${a.name}.xy, ${a.name}.yx)` : a.type === "vec3" ? `vec4(${a.name}.xyz, ${a.name}.x)` : `vec4(${a.name})`;
  let src = "#version 100\nvarying mediump vec4 v_color;\n";
  for (const a of attributes) src += `attribute mediump ${a.type} ${a.name};\n`;
  src += "\n" + (attributes.some(a => a.cond === "A" || a.cond === "!A") ? "uniform mediump float u_A;\n" : "") + "\n";
  src += "void main (void)\n{\n\tmediump vec4 color = vec4(0.0);\n\n";
  for (const a of attributes) {
    if (a.cond === "always") src += `\tcolor += ${toVec4(a)};\n`;
    else src += `\tif (${a.cond === "never" ? "0 != 0" : `u_A ${a.cond === "A" ? "!=" : "=="} 0.0`})\n\t{\n\t\tcolor += ${toVec4(a)};\n\t}\n`;
  }
  return src + "\n\tv_color = color;\n\tgl_Position = color;\n}\n";
}
const fragment = "#version 100\n\nvarying mediump vec4 v_color;\nvoid main (void)\n{\n\tgl_FragColor = v_color;\n}\n";

function setup() {
  const gl = new LinkerGl();
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
  const query = (op: number, words: number[], text = "", outLength = 4) => {
    const bytes = new TextEncoder().encode(text);
    const input = new Uint8Array(words.length * 4 + bytes.length), out = new Uint8Array(outLength);
    words.forEach((word, i) => new DataView(input.buffer).setUint32(i * 4, word >>> 0, true));
    input.set(bytes, words.length * 4);
    const rc = runGlQuery(b, op, input, out);
    return { rc, out, view: new DataView(out.buffer) };
  };
  const error = () => query(O.QOP_GET_ERROR, []).view.getUint32(0, true);
  const programiv = (pname: number) => query(O.QOP_GET_PROGRAMIV, [20, pname]).view.getInt32(0, true);
  const location = (name: string) => {
    const r = query(O.QOP_GET_ATTRIB_LOC, [20, name.length], name);
    expect(r.rc).toBe(4);
    return r.view.getInt32(0, true);
  };
  const activeAttributes = () => {
    const list: [string, number, number][] = [];
    for (let i = 0; i < programiv(0x8b89); i++) {
      const r = query(O.QOP_GET_ACTIVE_ATTRIB, [20, i, 0, 64], "", 64 + 12 + 8);
      expect(r.rc).toBeGreaterThan(0);
      // Checked reply: u32 status, then u32 nameLength, i32 size, u32 type, name.
      expect(r.view.getUint32(0, true)).toBe(0);
      const payload = new DataView(r.out.buffer, 4);
      const length = payload.getUint32(0, true);
      list.push([new TextDecoder().decode(r.out.subarray(16, 16 + length)), payload.getInt32(4, true), payload.getUint32(8, true)]);
    }
    return list;
  };
  /** Create, bind before link and link program 20 from a vertex source. */
  const build = (vertex: string, bindings: [string, number][]) => {
    send(O.OP_CREATE_SHADER, [0x8b31, 10]);
    send(O.OP_CREATE_SHADER, [0x8b30, 11]);
    send(O.OP_SHADER_SOURCE, [10, vertex.length], vertex);
    send(O.OP_SHADER_SOURCE, [11, fragment.length], fragment);
    send(O.OP_COMPILE_SHADER, [10]);
    send(O.OP_COMPILE_SHADER, [11]);
    send(O.OP_CREATE_PROGRAM, [20]);
    send(O.OP_ATTACH_SHADER, [20, 10]);
    send(O.OP_ATTACH_SHADER, [20, 11]);
    for (const [name, at] of bindings) send(O.OP_BIND_ATTRIB_LOCATION, [20, at, name.length], name);
    send(O.OP_LINK_PROGRAM, [20]);
  };
  return { b, gl, send, query, error, programiv, location, activeAttributes, build };
}

/** dEQP BindAliasingAttributeTest: a_0 (type) at 1 used when u_A != 0,
 * a_1 (vec4) at 1 + offset used when u_A == 0. */
function condCase(type: string, offset = 0) {
  const t = setup();
  t.build(deqpVertexShader([{ type, name: "a_0", cond: "A" }, { type: "vec4", name: "a_1", cond: "!A" }]),
    [["a_0", 1], ["a_1", 1 + offset]]);
  return t;
}

describe("ES 2.0 attribute aliasing (section 2.10.4) on WebGL", () => {
  it.each(["float", "vec2", "vec3", "vec4", "mat2", "mat3", "mat4"])("bind_aliasing.cond_%s links and reflects the guest's attributes", type => {
    const t = condCase(type);
    expect(t.programiv(0x8b82)).toBe(1);
    expect(t.activeAttributes().sort()).toEqual([["a_0", 1, TYPES[type][0]], ["a_1", 1, 0x8b52]]);
    expect(t.location("a_0")).toBe(1);
    expect(t.location("a_1")).toBe(1);
    expect(t.location("kandelo_alias_1")).toBe(-1);
    expect(t.programiv(0x8b8a)).toBe(4);
    expect(t.error()).toBe(0);
  });

  it.each(["mat2", "mat3", "mat4"])("bind_aliasing.cond_%s_offset_1 aliases the matrix's second column", type => {
    const t = condCase(type, 1);
    expect(t.programiv(0x8b82)).toBe(1);
    expect(t.location("a_0")).toBe(1);
    expect(t.location("a_1")).toBe(2);
    const executable = t.gl.programs.find(p => p.linked)!;
    const slots = TYPES[type][1], width = type === "mat2" ? ".xy" : type === "mat3" ? ".xyz" : "";
    const columns = Array.from({ length: slots }, (_, i) => `kandelo_alias_${1 + i}${width}`).join(", ");
    expect(executable.vertex).toContain(`a_0 = ${type}(${columns});`);
    expect(executable.vertex).toContain("a_1 = kandelo_alias_2;");
    expect([...executable.bound]).toEqual(expect.arrayContaining(
      Array.from({ length: slots }, (_, i) => [`kandelo_alias_${1 + i}`, 1 + i])));
    expect(t.error()).toBe(0);
  });

  it.each(["float", "vec2", "vec3", "vec4", "mat2", "mat3", "mat4"])("bind_aliasing.max_cond_%s fills every location with aliased pairs", type => {
    const t = setup();
    const slots = TYPES[type][1], attributes: { type: string; name: string; cond: Cond }[] = [];
    const bindings: [string, number][] = [];
    let ndx = 0;
    for (let at = 16 - slots; at >= 0; at -= slots, ndx++) {
      attributes.push({ type, name: `a_${ndx}`, cond: "A" }, { type, name: `a_${ndx + 16}`, cond: "!A" });
      bindings.push([`a_${ndx}`, at], [`a_${ndx + 16}`, at]);
    }
    t.build(deqpVertexShader(attributes), bindings);
    expect(t.programiv(0x8b82)).toBe(1);
    expect(t.activeAttributes()).toHaveLength(attributes.length);
    for (const [name, at] of bindings) expect(t.location(name)).toBe(at);
    expect(t.error()).toBe(0);
  });

  it("keeps non-aliased attributes and their native reflection", () => {
    const t = setup();
    t.build(deqpVertexShader([{ type: "vec4", name: "a_0", cond: "A" }, { type: "vec2", name: "a_1", cond: "!A" },
      { type: "vec3", name: "pos", cond: "always" }, { type: "float", name: "free", cond: "always" }]),
    [["a_0", 3], ["a_1", 3], ["pos", 0]]);
    expect(t.programiv(0x8b82)).toBe(1);
    expect(t.location("pos")).toBe(0);
    expect(t.location("free")).not.toBe(3);
    expect(t.location("free")).toBeGreaterThan(0);
    expect(t.activeAttributes().map(a => a[0]).sort()).toEqual(["a_0", "a_1", "free", "pos"]);
    const executable = t.gl.programs.find(p => p.linked)!;
    expect(executable.vertex).toContain("attribute mediump vec3 pos;");
    expect(executable.vertex).toContain("\nmediump vec4 a_0;");
  });

  it("an aliased attribute that is never referenced is inactive", () => {
    const t = setup();
    const vertex = deqpVertexShader([{ type: "vec4", name: "a_0", cond: "A" }, { type: "vec4", name: "a_1", cond: "!A" }])
      .replace("attribute mediump vec4 a_1;\n", "attribute mediump vec4 a_1;\nattribute mediump vec4 unused;\n");
    t.build(vertex, [["a_0", 2], ["a_1", 2], ["unused", 2]]);
    expect(t.programiv(0x8b82)).toBe(1);
    expect(t.activeAttributes().map(a => a[0]).sort()).toEqual(["a_0", "a_1"]);
    expect(t.location("unused")).toBe(-1);
  });

  it("a link that fails for another reason stays a truthful failure", () => {
    const t = setup();
    // No overlapping bindings: the native failure is the program's own.
    t.gl.maxAttributes = 1;
    t.build(deqpVertexShader([{ type: "vec4", name: "a_0", cond: "always" }, { type: "vec4", name: "a_1", cond: "always" }]), []);
    expect(t.programiv(0x8b82)).toBe(0);
    expect(t.gl.programs).toHaveLength(1);
  });

  it("attachments stay logical and relinking re-resolves the guest's shaders", () => {
    const t = condCase("vec2");
    t.send(O.OP_DETACH_SHADER, [20, 10]);
    expect(t.error()).toBe(0);
    expect(t.programiv(0x8b85)).toBe(1);
    t.send(O.OP_ATTACH_SHADER, [20, 10]);
    expect(t.error()).toBe(0);
    expect(t.programiv(0x8b85)).toBe(2);
    t.send(O.OP_LINK_PROGRAM, [20]);
    expect(t.error()).toBe(0);
    expect(t.programiv(0x8b82)).toBe(1);
    expect(t.location("a_0")).toBe(1);
  });

  it("a reversed-depth draw composes the twin over the aliasing executable", () => {
    const t = condCase("vec2");
    t.send(O.OP_USE_PROGRAM, [20]);
    const executable = t.gl.current!;
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat32(0, 1, true); v.setFloat32(4, 0, true);
    t.send(O.OP_DEPTH_RANGEF, [v.getUint32(0, true), v.getUint32(4, true)]);
    t.send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(t.error()).toBe(0);
    const twin = t.gl.draws[0];
    expect(twin).not.toBe(executable);
    expect(twin.vertex).toContain("attribute highp vec4 kandelo_alias_1;");
    expect(twin.vertex).toContain("gl_Position.z = -gl_Position.z;");
    expect(twin.bound.get("kandelo_alias_1")).toBe(1);
    expect(twin.linked).toBe(true);
    expect(t.gl.current).toBe(executable);
  });
});
