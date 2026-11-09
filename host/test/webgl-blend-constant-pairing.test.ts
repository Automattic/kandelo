import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { blendFoldShaderSource } from "../src/webgl/blend-constant.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

const CONSTANT_COLOR = 0x8001, ONE_MINUS_CONSTANT_COLOR = 0x8002;
const CONSTANT_ALPHA = 0x8003, ONE_MINUS_CONSTANT_ALPHA = 0x8004;
const ONE = 1, ZERO = 0, SRC_ALPHA = 0x0302, BLEND = 0x0be2;
const MIN = 0x8007, FUNC_ADD = 0x8006;
const UNSIGNED_NORMALIZED = 0x8c17, FLOAT = 0x1406;
const BLEND_DST_RGB = 0x80c8, BLEND_SRC_RGB = 0x80c9, BLEND_DST_ALPHA = 0x80ca, BLEND_SRC_ALPHA = 0x80cb;
const color = (f: number) => f === CONSTANT_COLOR || f === ONE_MINUS_CONSTANT_COLOR;
const alpha = (f: number) => f === CONSTANT_ALPHA || f === ONE_MINUS_CONSTANT_ALPHA;
const FACTOR = "kandelo_blend_source_factor";

type Shader = { type: number; source: string; compiled: string };
type Program = { shaders: Set<Shader>; linked: boolean; vertex: string; fragment: string; uniforms: Map<string, number[]> };
type Draw = { program: Program; blend: number[]; uniforms: Map<string, number[]> };

/** WebGL 1.0 section 6.13 (inherited by WebGL 2): constant color and constant
 * alpha cannot be the source and destination RGB factors together. ES 2.0
 * table 4.1 allows every pair. The program model derives active uniforms from
 * the linked sources, as in the depth-range tests. */
class BlendGl {
  errors: number[] = [];
  current: Program | null = null;
  draws: Draw[] = [];
  blend = [ONE, ZERO, ONE, ZERO];
  componentType = UNSIGNED_NORMALIZED;
  uniformWrites = 0;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number): unknown {
    if (pname === 0x8b8d) return this.current;
    if (pname === BLEND_SRC_RGB) return this.blend[0];
    if (pname === BLEND_DST_RGB) return this.blend[1];
    if (pname === BLEND_SRC_ALPHA) return this.blend[2];
    if (pname === BLEND_DST_ALPHA) return this.blend[3];
    return null;
  }
  getFramebufferAttachmentParameter(_target: number, _attachment: number, pname: number) {
    if (pname === 0x8cd0) return 0x8218; // FRAMEBUFFER_DEFAULT
    if (pname === 0x8211) return this.componentType;
    this.errors.push(0x500); return null;
  }
  blendFunc(s: number, d: number) { this.blendFuncSeparate(s, d, s, d); }
  blendFuncSeparate(srcRGB: number, dstRGB: number, srcA: number, dstA: number) {
    if ((color(srcRGB) && alpha(dstRGB)) || (alpha(srcRGB) && color(dstRGB))) { this.errors.push(0x502); return; }
    this.blend = [srcRGB, dstRGB, srcA, dstA];
  }
  createShader(type: number): Shader { return { type, source: "", compiled: "" }; }
  shaderSource(s: Shader, source: string) { s.source = source; }
  compileShader(s: Shader) { s.compiled = s.source; }
  getShaderParameter(s: Shader, pname: number) { return pname === 0x8b4f ? s.type : true; }
  createProgram(): Program { return { shaders: new Set(), linked: false, vertex: "", fragment: "", uniforms: new Map() }; }
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
    if (location.name === FACTOR) this.uniformWrites++;
    location.p.uniforms.set(location.name, value);
  }
  uniform1f(location: { p: Program; name: string }, x: number) { this.set(location, [x]); }
  uniform1fv(location: { p: Program; name: string }, v: Float32Array) { this.set(location, [v[0]]); }
  uniform3f(location: { p: Program; name: string }, x: number, y: number, z: number) { this.set(location, [x, y, z]); }
  uniform3fv(location: { p: Program; name: string }, v: Float32Array) { this.set(location, [...v]); }
  useProgram(p: Program | null) { if (p && !p.linked) this.errors.push(0x502); else this.current = p; }
  deleteProgram() {}
  checkFramebufferStatus() { return 0x8cd5; }
  drawArrays() {
    this.draws.push({ program: this.current!, blend: [...this.blend],
      uniforms: new Map([...this.current!.uniforms].map(([k, v]) => [k, [...v]])) });
  }
}

const VERTEX = "attribute vec4 p;\nvoid main() { gl_Position = p; }\n";
const FRAGMENT = "precision mediump float;\nuniform float u_shade;\nvoid main() { gl_FragColor = vec4(u_shade); }\n";

function setup(fragment = FRAGMENT) {
  const gl = new BlendGl();
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
  const floats = (values: number[]) => {
    const v = new DataView(new ArrayBuffer(values.length * 4));
    values.forEach((value, i) => v.setFloat32(i * 4, value, true));
    return values.map((_, i) => v.getUint32(i * 4, true));
  };
  const error = () => {
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), out)).toBe(4);
    return new DataView(out.buffer).getUint32(0, true);
  };
  const integer = (pname: number) => {
    const input = new Uint8Array(4), out = new Uint8Array(4);
    new DataView(input.buffer).setUint32(0, pname, true);
    expect(runGlQuery(b, O.QOP_GET_INTEGERV, input, out)).toBe(4);
    return new DataView(out.buffer).getInt32(0, true);
  };
  send(O.OP_CREATE_SHADER, [0x8b31, 10]);
  send(O.OP_CREATE_SHADER, [0x8b30, 11]);
  send(O.OP_SHADER_SOURCE, [10, VERTEX.length], VERTEX);
  send(O.OP_SHADER_SOURCE, [11, fragment.length], fragment);
  send(O.OP_COMPILE_SHADER, [10]);
  send(O.OP_COMPILE_SHADER, [11]);
  send(O.OP_CREATE_PROGRAM, [20]);
  send(O.OP_ATTACH_SHADER, [20, 10]);
  send(O.OP_ATTACH_SHADER, [20, 11]);
  send(O.OP_LINK_PROGRAM, [20]);
  send(O.OP_USE_PROGRAM, [20]);
  send(O.OP_BLEND_COLOR, floats([0.2, 0.4, 0.6, 0.8]));
  const draw = () => send(O.OP_DRAW_ARRAYS, [0, 0, 1]);
  return { b, gl, proxy, send, error, integer, draw, floats, reg, primary: gl.current! };
}

describe("constant color with constant alpha blend factors (ES 2.0 table 4.1)", () => {
  it.each([
    [O.OP_BLEND_FUNC, [CONSTANT_COLOR, CONSTANT_ALPHA], [CONSTANT_COLOR, CONSTANT_ALPHA, CONSTANT_COLOR, CONSTANT_ALPHA]],
    [O.OP_BLEND_FUNC, [ONE_MINUS_CONSTANT_ALPHA, ONE_MINUS_CONSTANT_COLOR],
      [ONE_MINUS_CONSTANT_ALPHA, ONE_MINUS_CONSTANT_COLOR, ONE_MINUS_CONSTANT_ALPHA, ONE_MINUS_CONSTANT_COLOR]],
    [O.OP_BLEND_FUNC_SEPARATE, [CONSTANT_ALPHA, CONSTANT_COLOR, ONE, ZERO], [CONSTANT_ALPHA, CONSTANT_COLOR, ONE, ZERO]],
    [O.OP_BLEND_FUNC_SEPARATE, [ONE_MINUS_CONSTANT_COLOR, ONE_MINUS_CONSTANT_ALPHA, SRC_ALPHA, ONE],
      [ONE_MINUS_CONSTANT_COLOR, ONE_MINUS_CONSTANT_ALPHA, SRC_ALPHA, ONE]],
  ])("op %i %j is accepted; queries report the logical factors", (op, words, logical) => {
    const { b, gl, send, error, integer } = setup();
    send(op, words);
    expect(error()).toBe(0);
    expect(b.shadow.blendFunc).toEqual({ srcRGB: logical[0], dstRGB: logical[1], srcA: logical[2], dstA: logical[3] });
    expect([BLEND_SRC_RGB, BLEND_DST_RGB, BLEND_SRC_ALPHA, BLEND_DST_ALPHA].map(integer)).toEqual(logical);
    // Natively the RGB source factor is ONE; it is applied in the shader.
    expect(gl.blend).toEqual([ONE, logical[1], logical[2], logical[3]]);
  });

  it("owner replay installs the native pair, never the forbidden one", () => {
    const { b, gl, proxy, send } = setup();
    send(O.OP_BLEND_FUNC_SEPARATE, [CONSTANT_COLOR, CONSTANT_ALPHA, CONSTANT_ALPHA, CONSTANT_COLOR]);
    gl.blend = [0, 0, 0, 0];
    new GlMuxer(proxy as unknown as WebGL2RenderingContext).switchTo(b);
    expect(gl.errors).toEqual([]);
    expect(gl.blend).toEqual([ONE, CONSTANT_ALPHA, CONSTANT_ALPHA, CONSTANT_COLOR]);
  });

  it.each([
    ["CONSTANT_COLOR", CONSTANT_COLOR, CONSTANT_ALPHA, [0.2, 0.4, 0.6]],
    ["ONE_MINUS_CONSTANT_COLOR", ONE_MINUS_CONSTANT_COLOR, ONE_MINUS_CONSTANT_ALPHA, [0.8, 0.6, 0.4]],
    ["CONSTANT_ALPHA", CONSTANT_ALPHA, ONE_MINUS_CONSTANT_COLOR, [0.8, 0.8, 0.8]],
    ["ONE_MINUS_CONSTANT_ALPHA", ONE_MINUS_CONSTANT_ALPHA, CONSTANT_COLOR, [0.2, 0.2, 0.2]],
  ])("a blended draw folds a %s source factor into a private fragment variant", (_, src, dst, factor) => {
    const { gl, send, error, draw, primary } = setup();
    send(O.OP_ENABLE, [BLEND]);
    send(O.OP_BLEND_FUNC_SEPARATE, [src, dst, SRC_ALPHA, ONE]);
    draw();
    expect(error()).toBe(0);
    const { program, blend, uniforms } = gl.draws[0];
    expect(program).not.toBe(primary);
    expect(program.vertex).toBe(VERTEX);
    expect(program.fragment).toContain(`gl_FragColor.rgb = clamp(gl_FragColor.rgb, 0.0, 1.0) * clamp(${FACTOR}, 0.0, 1.0);`);
    expect(blend).toEqual([ONE, dst, SRC_ALPHA, ONE]);
    uniforms.get(FACTOR)!.forEach((value, i) => expect(value).toBeCloseTo(factor[i], 6));
    expect(gl.current).toBe(primary);
  });

  it("a floating-point color buffer receives the unclamped product", () => {
    const { gl, send, error, draw } = setup();
    gl.componentType = FLOAT;
    send(O.OP_ENABLE, [BLEND]);
    send(O.OP_BLEND_FUNC, [CONSTANT_COLOR, CONSTANT_ALPHA]);
    draw();
    expect(error()).toBe(0);
    expect(gl.draws[0].program.fragment).toContain(`gl_FragColor.rgb = gl_FragColor.rgb * ${FACTOR};`);
  });

  it("uploads the factor only when blend color or factors change", () => {
    const { gl, send, error, draw, floats } = setup();
    send(O.OP_ENABLE, [BLEND]);
    send(O.OP_BLEND_FUNC, [CONSTANT_COLOR, CONSTANT_ALPHA]);
    draw(); draw();
    expect(gl.uniformWrites).toBe(1);
    send(O.OP_BLEND_COLOR, floats([0.5, 0.25, 0.125, 1]));
    draw();
    expect(error()).toBe(0);
    expect(gl.uniformWrites).toBe(2);
    expect(gl.draws[2].program).toBe(gl.draws[0].program);
    expect(gl.draws[2].uniforms.get(FACTOR)).toEqual([0.5, 0.25, 0.125]);
  });

  it.each([
    ["blending disabled", false, FUNC_ADD, [CONSTANT_COLOR, CONSTANT_ALPHA]],
    ["a MIN equation (factors unused)", true, MIN, [CONSTANT_COLOR, CONSTANT_ALPHA]],
    ["a pairing only in the alpha factors", true, FUNC_ADD, [ONE, ZERO, CONSTANT_COLOR, CONSTANT_ALPHA]],
  ])("leaves %s on the guest executable", (_, enable, equation, factors) => {
    const { gl, send, error, draw, primary } = setup();
    if (enable) send(O.OP_ENABLE, [BLEND]);
    send(O.OP_BLEND_EQUATION, [equation]);
    send(factors.length === 2 ? O.OP_BLEND_FUNC : O.OP_BLEND_FUNC_SEPARATE, factors);
    draw();
    expect(error()).toBe(0);
    expect(gl.draws[0].program).toBe(primary);
    expect(gl.uniformWrites).toBe(0);
  });

  it("composes with a reversed depth range in one variant", () => {
    const { gl, send, error, draw, floats } = setup();
    send(O.OP_DEPTH_RANGEF, floats([0.75, 0.25]));
    send(O.OP_ENABLE, [BLEND]);
    send(O.OP_BLEND_FUNC, [CONSTANT_ALPHA, CONSTANT_COLOR]);
    draw();
    expect(error()).toBe(0);
    const { program } = gl.draws[0];
    expect(program.vertex).toContain("gl_Position.z = -gl_Position.z;");
    expect(program.fragment).toContain(`clamp(${FACTOR}, 0.0, 1.0)`);
  });
});

describe("blend fold shader source", () => {
  it("writes gl_FragData[0] when the guest writes gl_FragData", () => {
    const source = "precision mediump float;\nvoid main() { gl_FragData[0] = vec4(1.0); }\n";
    const folded = blendFoldShaderSource(source, true)!;
    expect(folded).toContain("void kandelo_blend_main() { gl_FragData[0] = vec4(1.0); }");
    expect(folded).toContain(`gl_FragData[0].rgb = clamp(gl_FragData[0].rgb, 0.0, 1.0) * clamp(${FACTOR}, 0.0, 1.0);`);
    expect(folded).not.toMatch(/\bgl_FragColor\b/);
  });
});

it("uses stable blend factor rows without aliasing shared twins at equal peer revisions",()=>{
 const f=setup(),{b,reg,gl,send,draw,floats}=f;b.contextId=1;
 send(O.OP_ENABLE,[BLEND]);send(O.OP_BLEND_FUNC,[CONSTANT_COLOR,CONSTANT_ALPHA]);draw();
 const first=b.shadow.blendSourceFactor;expect(gl.uniformWrites).toBe(1);
 reg.bind({pid:1,sessionId:12,cmdbufAddr:0,cmdbufLen:65536});const peer=reg.get(1,12)!;peer.gl=b.gl;peer.contextId=2;peer.cmdbufView=new Uint8Array(65536);
 expect(reg.shareObjects(1,12,0)).toBe(true);
 const peerSend=(op:number,words:number[])=>{const bytes=new Uint8Array(4+words.length*4),v=new DataView(bytes.buffer);v.setUint16(0,op,true);v.setUint16(2,words.length*4,true);for(let i=0;i<words.length;i++)v.setUint32(4+i*4,words[i],true);peer.cmdbufView=bytes;expect(decodeAndDispatch(peer,0,bytes.length)).toBe(0);};
 peerSend(O.OP_USE_PROGRAM,[20]);peerSend(O.OP_BLEND_COLOR,floats([.75,.5,.25,1]));peerSend(O.OP_ENABLE,[BLEND]);peerSend(O.OP_BLEND_FUNC,[CONSTANT_COLOR,CONSTANT_ALPHA]);
 expect(peer.shadow.blendSourceVersion).toBe(b.shadow.blendSourceVersion);expect(peer.shadow.blendSourceFactor).not.toBe(first);
 peerSend(O.OP_DRAW_ARRAYS,[0,0,1]);expect(gl.draws.at(-1)!.uniforms.get(FACTOR)).toEqual([.75,.5,.25]);expect(gl.uniformWrites).toBe(2);
 draw();expect(gl.draws.at(-1)!.uniforms.get(FACTOR)![0]).toBeCloseTo(.2,6);expect(gl.uniformWrites).toBe(3);
 const row=peer.shadow.blendSourceFactor;peerSend(O.OP_BLEND_COLOR,floats([.125,.25,.5,1]));expect(peer.shadow.blendSourceFactor).toBe(row);
 peerSend(O.OP_DRAW_ARRAYS,[0,0,1]);peerSend(O.OP_DRAW_ARRAYS,[0,0,1]);expect(gl.draws.at(-1)!.uniforms.get(FACTOR)).toEqual([.125,.25,.5]);expect(gl.uniformWrites).toBe(4);
 draw();expect(gl.draws.at(-1)!.uniforms.get(FACTOR)![0]).toBeCloseTo(.2,6);expect(gl.uniformWrites).toBe(5);
 reg.unbind(1);
});
it("keeps saturated blend revisions permanently dirty rather than reusing stale shared values",()=>{
 const {b,gl,send,draw,floats,reg}=setup();send(O.OP_ENABLE,[BLEND]);send(O.OP_BLEND_FUNC,[CONSTANT_COLOR,CONSTANT_ALPHA]);draw();
 const row=b.shadow.blendSourceFactor;b.shadow.blendSourceVersion=Number.MAX_SAFE_INTEGER;
 send(O.OP_BLEND_COLOR,floats([.5,.25,.125,1]));expect(b.shadow.blendSourceVersion).toBe(-1);expect(b.shadow.blendSourceFactor).toBe(row);draw();
 expect(gl.draws.at(-1)!.uniforms.get(FACTOR)).toEqual([.5,.25,.125]);send(O.OP_BLEND_COLOR,floats([.125,.5,.25,1]));expect(b.shadow.blendSourceVersion).toBe(-1);draw();draw();
 expect(gl.draws.at(-1)!.uniforms.get(FACTOR)).toEqual([.125,.5,.25]);expect(gl.uniformWrites).toBe(4);reg.unbind(1);
});
