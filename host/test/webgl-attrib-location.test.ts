import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";

/* ES 2.0 section 2.10.4: GetAttribLocation reports errors only for the
 * program; an inactive or "gl_"-prefixed name is -1. This fake applies the
 * WebGL rules the renderer must not import: names longer than its lookup
 * limit, or with characters outside the GLSL ES character set, raise
 * INVALID_VALUE. */
class AttributeGl {
  errors: number[] = [];
  lookups: string[] = [];
  constructor(readonly active: string[], readonly limit = 256, readonly linked = true) {}
  getError() { return this.errors.shift() ?? 0; }
  getProgramParameter(_program: object, pname: number) {
    return pname === 0x8b82 ? this.linked : pname === 0x8b89 ? this.active.length : null;
  }
  getActiveAttrib(_program: object, index: number) { return {name:this.active[index],size:1,type:0x8b52}; }
  getAttribLocation(_program: object, name: string) {
    this.lookups.push(name);
    if (name.length > this.limit || /[^\x20-\x7e]|[$"'@\\`]/.test(name)) { this.errors.push(0x501); return -1; }
    return this.active.indexOf(name);
  }
}

function setup(gl: AttributeGl) {
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:64});
  const b = registry.get(1)!;
  b.gl = gl as unknown as WebGL2RenderingContext;
  b.programs.set(9,{} as WebGLProgram);
  const locate = (program: number, name: string) => {
    const bytes = new TextEncoder().encode(name), input = new Uint8Array(8+bytes.length);
    const v = new DataView(input.buffer); v.setUint32(0,program,true); v.setUint32(4,bytes.length,true); input.set(bytes,8);
    const out = new Uint8Array(4), rc = runGlQuery(b,O.QOP_GET_ATTRIB_LOC,input,out);
    return rc === 4 ? new DataView(out.buffer).getInt32(0,true) : null;
  };
  return {b,locate};
}

it("returns -1 without a WebGL-only error for a long inactive name", () => {
  const gl = new AttributeGl(["position"]), {b,locate} = setup(gl);
  expect(locate(9,"a".repeat(300))).toBe(-1);
  expect(locate(9,"a".repeat(65528))).toBe(-1);
  expect(b.errors).toEqual([]); expect(gl.lookups).toEqual([]);
});

it("resolves a long active name natively when the engine accepts its length", () => {
  const long = "p".repeat(300), gl = new AttributeGl(["position",long],1024), {b,locate} = setup(gl);
  expect(locate(9,long)).toBe(1); expect(b.errors).toEqual([]);
});

it("keeps the engine's error for a long active name beyond its lookup limit", () => {
  const long = "p".repeat(300), gl = new AttributeGl([long]), {b,locate} = setup(gl);
  expect(locate(9,long)).toBeNull(); expect(b.errors).toEqual([0x501]);
});

it("returns -1 for reserved and non-identifier names without native lookup", () => {
  const gl = new AttributeGl(["position"]), {b,locate} = setup(gl);
  for (const name of ["gl_Vertex","a$b","pos[0]","s.x","","9a"]) expect(locate(9,name)).toBe(-1);
  expect(b.errors).toEqual([]); expect(gl.lookups).toEqual([]);
  expect(locate(9,"position")).toBe(0);
});

it("still reports program errors for long names", () => {
  const gl = new AttributeGl([],256,false), {b,locate} = setup(gl);
  expect(locate(9,"a".repeat(300))).toBeNull(); expect(b.errors).toEqual([0x502]);
  b.errors.length = 0;
  expect(locate(4,"a".repeat(300))).toBeNull(); expect(b.errors).toEqual([0x501]);
});
