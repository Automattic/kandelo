import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { defaultShadow } from "../src/webgl/shadow.js";
import { reversedDepthShaderSource } from "../src/webgl/reversed-depth.js";

/** WebGL 2 stand-in that enforces the WebGL rule ES 2.0 does not have:
 * depthRange(zNear, zFar) with zNear > zFar is INVALID_OPERATION
 * (WebGL 1.0 section 6.12, inherited by WebGL 2). */
class DepthGl {
  errors: number[] = [];
  native: [number, number] = [0, 1];
  rejectAll = false;
  log: Array<[string, unknown[]]> = [];
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x0b70) return new Float32Array(this.native);
    return 0;
  }
  depthRange(n: number, f: number) {
    this.log.push(["depthRange", [n, f]]);
    if (this.rejectAll || n > f) { this.errors.push(0x502); return; }
    this.native = [n, f];
  }
}

function binding(gl = new DepthGl()) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096));
  b.gl = gl as unknown as WebGL2RenderingContext;
  return { b, gl };
}

function depthRange(b: ReturnType<typeof binding>["b"], n: number, f: number): void {
  const v = new DataView(b.cmdbufView!.buffer);
  v.setUint16(0, O.OP_DEPTH_RANGEF, true);
  v.setUint16(2, 8, true);
  v.setFloat32(4, n, true);
  v.setFloat32(8, f, true);
  expect(decodeAndDispatch(b, 0, 12)).toBe(0);
}

function glError(b: ReturnType<typeof binding>["b"]): number {
  const reply = new Uint8Array(4);
  expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), reply)).toBe(4);
  return new DataView(reply.buffer).getUint32(0, true);
}

describe("glDepthRangef state ownership", () => {
  it("a natively rejected depthRange leaves the logical shadow unchanged (ES 2.0 section 2.5)", () => {
    const { b, gl } = binding();
    gl.rejectAll = true;
    depthRange(b, 0.25, 0.75);
    expect(glError(b)).toBe(0x502);
    expect(b.shadow.depthRange).toEqual([0, 1]);
  });
});

describe("reversed depth ranges (ES 2.0 section 2.12.1)", () => {
  it("accepts n > f, keeps the logical pair and sets the ordered native range", () => {
    const { b, gl } = binding();
    depthRange(b, 1, 0.25);
    expect(glError(b)).toBe(0);
    expect(b.shadow.depthRange).toEqual([1, 0.25]);
    expect(gl.native).toEqual([0.25, 1]);
  });

  it("DEPTH_RANGE queries report the logical values", () => {
    const { b } = binding();
    depthRange(b, 1, 0);
    const pname = new Uint8Array(4);
    new DataView(pname.buffer).setUint32(0, 0x0b70, true);
    const floats = new Uint8Array(8);
    expect(runGlQuery(b, O.QOP_GET_FLOATV, pname, floats)).toBe(8);
    expect([0, 4].map(at => new DataView(floats.buffer).getFloat32(at, true))).toEqual([1, 0]);
    const ints = new Uint8Array(8);
    expect(runGlQuery(b, O.QOP_GET_INTEGERV, pname, ints)).toBe(8);
    expect([0, 4].map(at => new DataView(ints.buffer).getInt32(at, true))).toEqual([0x7fffffff, 0]);
  });

  it("the muxer replays the ordered native range for a reversed owner", () => {
    const gl = new RecordingMuxGl();
    const mux = new GlMuxer(gl as unknown as WebGL2RenderingContext);
    const owner = { shadow: defaultShadow(), errors: [] as number[] };
    owner.shadow.depthRange = [0.75, 0.5];
    mux.switchTo(owner);
    expect(gl.ranges).toEqual([[0.5, 0.75]]);
  });
});

describe("reversed-depth twin shader source", () => {
  it("wraps the guest main and negates clip z without moving guest lines", () => {
    const source = "attribute vec4 p; // main entry\nvoid main() {\n  gl_Position = p; /* main */\n}\n";
    const twin = reversedDepthShaderSource(source, true);
    expect(twin.startsWith("attribute vec4 p; // main entry\nvoid kandelo_reversed_depth_main() {\n  gl_Position = p; /* main */\n}\n")).toBe(true);
    expect(twin).toContain("void main() { kandelo_reversed_depth_main(); gl_Position.z = -gl_Position.z; }");
    expect(reversedDepthShaderSource("void main(){gl_FragColor=vec4(1);}", false))
      .toBe("void kandelo_reversed_depth_main(){gl_FragColor=vec4(1);}\nvoid main() { kandelo_reversed_depth_main(); }\n");
  });

  it("redirects gl_DepthRange to the logical near/far/diff after #version", () => {
    const source = "#version 100\n#extension GL_OES_standard_derivatives : enable\nprecision mediump float;\n" +
      "void main(){gl_FragColor=vec4(gl_DepthRange.near,gl_DepthRange.far,gl_DepthRange.diff,1.0);}\n";
    const twin = reversedDepthShaderSource(source, false);
    const lines = twin.split("\n");
    expect(lines[0]).toBe("#version 100");
    expect(lines[1]).toBe("#extension GL_OES_standard_derivatives : enable");
    expect(lines[2]).toMatch(/^struct kandelo_reversed_depth_range_parameters \{ highp float near; highp float far; highp float diff; \};$/);
    expect(lines[3]).toBe("kandelo_reversed_depth_range_parameters kandelo_reversed_depth_range;");
    expect(lines[4]).toBe("#line 3");
    expect(lines[5]).toBe("precision mediump float;");
    expect(twin).not.toMatch(/gl_DepthRange\.(near|far|diff),/);
    expect(twin).toContain("kandelo_reversed_depth_range.near = gl_DepthRange.far; " +
      "kandelo_reversed_depth_range.far = gl_DepthRange.near; kandelo_reversed_depth_range.diff = -gl_DepthRange.diff;");
  });

  it("does not rename identifiers that merely contain main", () => {
    const twin = reversedDepthShaderSource("float mainly; float x_main; void main(){ float m = 1.0e5; }", true);
    expect(twin).toContain("float mainly; float x_main; void kandelo_reversed_depth_main(){ float m = 1.0e5; }");
  });
});

describe("reversed-range draws run a private z-negating executable", () => {
  it("draws through the twin with pinned attributes and copied uniforms, then restores the guest executable", () => {
    const { b, gl, send, uniformLocation } = programBinding();
    const primary = gl.current!;
    const scale = uniformLocation("scale");
    send(O.OP_UNIFORM1F, [scale, f32(2.5)]);
    depthRange(b, 1, 0);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(glError(b)).toBe(0);
    expect(gl.draws).toHaveLength(1);
    const twin = gl.draws[0].program;
    expect(twin).not.toBe(primary);
    expect(twin.vertex).toContain("gl_Position.z = -gl_Position.z;");
    expect(twin.vertex).toContain("void kandelo_reversed_depth_main()");
    expect(twin.attributes.get("position")).toBe(primary.attributes.get("position"));
    expect(gl.draws[0].uniforms.get("scale")).toBe(2.5);
    expect(gl.draws[0].depth).toEqual([0, 1]);
    expect(gl.current).toBe(primary);

    // Later guest uniform writes reach the same twin before the next draw.
    send(O.OP_UNIFORM1F, [scale, f32(4)]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws[1].program).toBe(twin);
    expect(gl.draws[1].uniforms.get("scale")).toBe(4);

    // An ordered range draws with the guest executable itself.
    depthRange(b, 0, 1);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws[2].program).toBe(primary);
    expect(glError(b)).toBe(0);
  });

  it("releases the twin with its guest executable and rebuilds it after relinking", () => {
    const { b, gl, send } = programBinding();
    depthRange(b, 1, 0);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    const first = gl.draws[0].program;
    send(O.OP_LINK_PROGRAM, [20]);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.deleted.has(first)).toBe(true);
    const second = gl.draws[1].program;
    expect(second).not.toBe(first);
    send(O.OP_USE_PROGRAM, [0]);
    send(O.OP_DELETE_PROGRAM, [20]);
    expect(gl.deleted.has(second)).toBe(true);
    expect(glError(b)).toBe(0);
  });

  it("a twin that cannot be built refuses the draw with a visible error", () => {
    const { b, gl, send } = programBinding();
    gl.failTwinLink = true;
    depthRange(b, 1, 0);
    send(O.OP_DRAW_ARRAYS, [4, 0, 3]);
    expect(gl.draws).toHaveLength(0);
    expect(glError(b)).toBe(0x502);
    expect(gl.current!.vertex).not.toContain("kandelo");
  });
});

class RecordingMuxGl {
  ranges: number[][] = [];
  depthRange(n: number, f: number) { this.ranges.push([n, f]); }
  getError() { return 0; }
  getParameter() { return null; }
  createVertexArray() { return {}; }
}
for (const name of ["colorMask", "depthMask", "stencilFuncSeparate", "stencilMaskSeparate", "stencilOpSeparate",
  "blendColor", "clearDepth", "clearStencil", "polygonOffset", "sampleCoverage", "lineWidth", "bindBuffer",
  "bindRenderbuffer", "vertexAttrib4f", "bindVertexArray", "blendEquationSeparate", "bindFramebuffer", "viewport",
  "scissor", "enable", "disable", "clearColor", "depthFunc", "blendFuncSeparate", "cullFace", "frontFace",
  "useProgram", "activeTexture", "bindTexture", "pixelStorei"]) {
  (RecordingMuxGl.prototype as unknown as Record<string, () => void>)[name] = () => {};
}

type FakeShader = { type: number; source: string; compiled: string };
type FakeProgram = { shaders: Set<FakeShader>; bound: Map<string, number>; attributes: Map<string, number>;
  linked: boolean; vertex: string; uniforms: Map<string, number> };

/** Program-level WebGL model: uniforms address the installed program, link
 * assigns unbound attributes in reverse order, depthRange enforces WebGL. */
class ProgramGl {
  errors: number[] = [];
  native: [number, number] = [0, 1];
  current: FakeProgram | null = null;
  draws: { program: FakeProgram; uniforms: Map<string, number>; depth: number[] }[] = [];
  deleted = new Set<FakeProgram>();
  programs: FakeProgram[] = [];
  failTwinLink = false;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x8b8d) return this.current;
    if (pname === 0x0b70) return new Float32Array(this.native);
    return 0;
  }
  depthRange(n: number, f: number) { if (n > f) this.errors.push(0x502); else this.native = [n, f]; }
  createShader(type: number): FakeShader { return { type, source: "", compiled: "" }; }
  shaderSource(s: FakeShader, source: string) { s.source = source; }
  compileShader(s: FakeShader) { s.compiled = s.source; }
  getShaderParameter(s: FakeShader, pname: number) { return pname === 0x8b4f ? s.type : true; }
  createProgram(): FakeProgram {
    const p = { shaders: new Set<FakeShader>(), bound: new Map(), attributes: new Map(), linked: false, vertex: "", uniforms: new Map() };
    this.programs.push(p);
    return p;
  }
  attachShader(p: FakeProgram, s: FakeShader) { p.shaders.add(s); }
  detachShader(p: FakeProgram, s: FakeShader) { p.shaders.delete(s); }
  bindAttribLocation(p: FakeProgram, index: number, name: string) { p.bound.set(name, index); }
  linkProgram(p: FakeProgram) {
    const vertex = [...p.shaders].find(s => s.type === 0x8b31);
    p.vertex = vertex?.compiled ?? "";
    p.linked = !!vertex && p.shaders.size === 2 && !(this.failTwinLink && p.vertex.includes("kandelo"));
    p.uniforms = new Map([["scale", 0]]);
    const names = ["position", "uv"];
    p.attributes = new Map(names.map((name, i) => [name, p.bound.get(name) ?? names.length - 1 - i]));
  }
  getProgramParameter(p: FakeProgram, pname: number) {
    if (pname === 0x8b82) return p.linked;
    if (pname === 0x8b89) return p.attributes.size;
    if (pname === 0x8b86) return 1;
    return 0;
  }
  getActiveAttrib(p: FakeProgram, i: number) { const name = [...p.attributes.keys()][i]; return name ? { name, size: 1, type: 0x8b52 } : null; }
  getAttribLocation(p: FakeProgram, name: string) { return p.attributes.get(name) ?? -1; }
  getActiveUniform(_p: FakeProgram, i: number) { return i === 0 ? { name: "scale", size: 1, type: 0x1406 } : null; }
  getUniformLocation(p: FakeProgram, name: string) { return p.uniforms.has(name) ? { p, name } : null; }
  getUniform(p: FakeProgram, location: { name: string }) { return p.uniforms.get(location.name); }
  uniform1f(location: { p: FakeProgram; name: string }, x: number) {
    if (location.p !== this.current) { this.errors.push(0x502); return; }
    location.p.uniforms.set(location.name, x);
  }
  uniform1fv(location: { p: FakeProgram; name: string }, v: Float32Array) { this.uniform1f(location, v[0]); }
  useProgram(p: FakeProgram | null) { if (p && !p.linked) this.errors.push(0x502); else this.current = p; }
  deleteProgram(p: FakeProgram) { this.deleted.add(p); }
  drawArrays() { this.draws.push({ program: this.current!, uniforms: new Map(this.current!.uniforms), depth: [...this.native] }); }
}

function f32(x: number): number {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, x, true);
  return v.getUint32(0, true);
}

function programBinding() {
  const gl = new ProgramGl();
  const proxy = new Proxy(gl, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value ?? (() => {});
  } });
  const { b } = binding(proxy as unknown as DepthGl);
  const send = (op: number, words: number[], text = "") => {
    const bytes = new TextEncoder().encode(text);
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4 + bytes.length, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    b.cmdbufView!.set(bytes, 4 + words.length * 4);
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4 + bytes.length)).toBe(0);
  };
  const uniformLocation = (name: string) => {
    const bytes = new TextEncoder().encode(name), input = new Uint8Array(8 + bytes.length);
    new DataView(input.buffer).setUint32(0, 20, true);
    new DataView(input.buffer).setUint32(4, bytes.length, true);
    input.set(bytes, 8);
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, input, out)).toBe(4);
    return new DataView(out.buffer).getInt32(0, true);
  };
  const vertex = "attribute vec4 position;\nattribute vec2 uv;\nuniform float scale;\n" +
    "void main() { gl_Position = position * scale + vec4(uv, 0.0, 0.0); }\n";
  send(O.OP_CREATE_SHADER, [0x8b31, 10]);
  send(O.OP_CREATE_SHADER, [0x8b30, 11]);
  send(O.OP_SHADER_SOURCE, [10, vertex.length], vertex);
  send(O.OP_SHADER_SOURCE, [11, 37], "void main(){gl_FragColor=vec4(1.0);}\n");
  send(O.OP_COMPILE_SHADER, [10]);
  send(O.OP_COMPILE_SHADER, [11]);
  send(O.OP_CREATE_PROGRAM, [20]);
  send(O.OP_ATTACH_SHADER, [20, 10]);
  send(O.OP_ATTACH_SHADER, [20, 11]);
  send(O.OP_LINK_PROGRAM, [20]);
  send(O.OP_USE_PROGRAM, [20]);
  return { b, gl, send, uniformLocation };
}
