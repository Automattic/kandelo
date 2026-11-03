import { describe, expect, it } from "vitest";
import {
  decodeAndDispatch,
  GL_SUBMIT_EINVAL,
} from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * Hand-rolled WebGL2 stand-in. Records every dispatched call as
 * [methodName, [...args]] tuples; returns synthetic values for the
 * createX() / getX() shapes the bridge / query handler exercise.
 *
 * Vitest's default node environment has no WebGL implementation;
 * jsdom doesn't either. Real-WebGL coverage lives in Playwright (Task B7)
 * and the optional headless-gl smoke test (Task B6, deferred).
 */
class RecordingGl {
  log: Array<[string, unknown[]]> = [];

  // counters so each create*() returns a unique handle the test can match
  private next = 1;

  // factories
  createBuffer() {
    const v = { kind: "buffer", id: this.next++ };
    this.log.push(["createBuffer", []]);
    return v;
  }
  createTexture() {
    const v = { kind: "texture", id: this.next++ };
    this.log.push(["createTexture", []]);
    return v;
  }
  createShader(type: number) {
    const v = { kind: "shader", type, id: this.next++ };
    this.log.push(["createShader", [type]]);
    return v;
  }
  createProgram() {
    const v = { kind: "program", id: this.next++ };
    this.log.push(["createProgram", []]);
    return v;
  }
  createVertexArray() {
    const v = { kind: "vao", id: this.next++ };
    this.log.push(["createVertexArray", []]);
    return v;
  }
  createFramebuffer() {
    const v = { kind: "fbo", id: this.next++ };
    this.log.push(["createFramebuffer", []]);
    return v;
  }
  createRenderbuffer() {
    const v = { kind: "rbo", id: this.next++ };
    this.log.push(["createRenderbuffer", []]);
    return v;
  }

  // most state functions: capture args verbatim
  clear(m: number) { this.log.push(["clear", [m]]); }
  clearColor(r: number, g: number, b: number, a: number) { this.log.push(["clearColor", [r, g, b, a]]); }
  viewport(...a: number[]) { this.log.push(["viewport", a]); }
  scissor(...a: number[]) { this.log.push(["scissor", a]); }
  enable(c: number) { this.log.push(["enable", [c]]); }
  disable(c: number) { this.log.push(["disable", [c]]); }
  blendFunc(s: number, d: number) { this.log.push(["blendFunc", [s, d]]); }
  depthFunc(f: number) { this.log.push(["depthFunc", [f]]); }
  cullFace(m: number) { this.log.push(["cullFace", [m]]); }
  frontFace(m: number) { this.log.push(["frontFace", [m]]); }
  lineWidth(w: number) { this.log.push(["lineWidth", [w]]); }
  pixelStorei(p: number, v: number) { this.log.push(["pixelStorei", [p, v]]); }

  // buffers / textures
  bindBuffer(t: number, b: unknown) { this.log.push(["bindBuffer", [t, b]]); }
  bufferData(t: number, d: unknown, u: number) { this.log.push(["bufferData", [t, d, u]]); }
  bufferSubData(t: number, o: number, d: unknown) { this.log.push(["bufferSubData", [t, o, d]]); }
  deleteBuffer(b: unknown) { this.log.push(["deleteBuffer", [b]]); }
  bindTexture(t: number, x: unknown) { this.log.push(["bindTexture", [t, x]]); }
  texImage2D(...a: unknown[]) { this.log.push(["texImage2D", a]); }
  texSubImage2D(...a: unknown[]) { this.log.push(["texSubImage2D", a]); }
  texParameteri(t: number, p: number, v: number) { this.log.push(["texParameteri", [t, p, v]]); }
  activeTexture(t: number) { this.log.push(["activeTexture", [t]]); }
  generateMipmap(t: number) { this.log.push(["generateMipmap", [t]]); }
  deleteTexture(x: unknown) { this.log.push(["deleteTexture", [x]]); }

  // shaders / programs
  shaderSource(s: unknown, src: string) { this.log.push(["shaderSource", [s, src]]); }
  compileShader(s: unknown) { this.log.push(["compileShader", [s]]); }
  deleteShader(s: unknown) { this.log.push(["deleteShader", [s]]); }
  attachShader(p: unknown, s: unknown) { this.log.push(["attachShader", [p, s]]); }
  linkProgram(p: unknown) { this.log.push(["linkProgram", [p]]); }
  useProgram(p: unknown) { this.log.push(["useProgram", [p]]); }
  bindAttribLocation(p: unknown, i: number, n: string) { this.log.push(["bindAttribLocation", [p, i, n]]); }
  deleteProgram(p: unknown) { this.log.push(["deleteProgram", [p]]); }

  // uniforms
  uniform1i(l: unknown, x: number) { this.log.push(["uniform1i", [l, x]]); }
  uniform1f(l: unknown, x: number) { this.log.push(["uniform1f", [l, x]]); }
  uniform2f(l: unknown, x: number, y: number) { this.log.push(["uniform2f", [l, x, y]]); }
  uniform3f(l: unknown, x: number, y: number, z: number) { this.log.push(["uniform3f", [l, x, y, z]]); }
  uniform4f(l: unknown, x: number, y: number, z: number, w: number) { this.log.push(["uniform4f", [l, x, y, z, w]]); }
  uniformMatrix4fv(l: unknown, t: boolean, m: Float32Array) { this.log.push(["uniformMatrix4fv", [l, t, [...m]]]); }
  uniform4fv(l: unknown, v: Float32Array) { this.log.push(["uniform4fv", [l, [...v]]]); }

  // attribs / draws
  enableVertexAttribArray(i: number) { this.log.push(["enableVertexAttribArray", [i]]); }
  disableVertexAttribArray(i: number) { this.log.push(["disableVertexAttribArray", [i]]); }
  vertexAttribPointer(i: number, sz: number, t: number, n: boolean, st: number, off: number) { this.log.push(["vertexAttribPointer", [i, sz, t, n, st, off]]); }
  drawArrays(m: number, f: number, c: number) { this.log.push(["drawArrays", [m, f, c]]); }
  drawElements(m: number, c: number, t: number, off: number) { this.log.push(["drawElements", [m, c, t, off]]); }

  // VAOs / FBOs / RBOs
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
  deleteVertexArray(v: unknown) { this.log.push(["deleteVertexArray", [v]]); }
  bindFramebuffer(t: number, f: unknown) { this.log.push(["bindFramebuffer", [t, f]]); }
  framebufferTexture2D(...a: unknown[]) { this.log.push(["framebufferTexture2D", a]); }
  bindRenderbuffer(t: number, r: unknown) { this.log.push(["bindRenderbuffer", [t, r]]); }
  renderbufferStorage(...a: number[]) { this.log.push(["renderbufferStorage", a]); }
  framebufferRenderbuffer(...a: unknown[]) { this.log.push(["framebufferRenderbuffer", a]); }

  // queries
  finish() { this.log.push(["finish", []]); }
  getError() { return 0; }
  getParameter(p: number) {
    if (p === 0x1F03 /* GL_EXTENSIONS */) return "WEBGL_test";
    return 42;
  }
  getUniformLocation(_p: unknown, name: string) {
    return name === "u_unknown" ? null : { kind: "uloc", name };
  }
  getAttribLocation(_p: unknown, _name: string) { return 7; }
  getShaderParameter(_s: unknown, _p: number) { return true; }
  getShaderInfoLog(_s: unknown) { return "shader log"; }
  getProgramParameter(_p: unknown, _q: number) { return 1; }
  getProgramInfoLog(_p: unknown) { return "program log"; }
  readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, dst: Uint8Array) {
    for (let i = 0; i < dst.length; i++) dst[i] = (i & 0xff);
  }
  checkFramebufferStatus(_t: number) { return 0x8CD5 /* GL_FRAMEBUFFER_COMPLETE */; }

  // OpenGL ES 3.0
  extensions = new Set(["EXT_color_buffer_float", "OES_texture_float_linear"]);
  getExtension(name: string) { return this.extensions.has(name) ? {} : null; }
  stencilFuncSeparate(...a: number[]) { this.log.push(["stencilFuncSeparate", a]); }
  bindBufferRange(...a: unknown[]) { this.log.push(["bindBufferRange", a]); }
  uniform3uiv(l: unknown, v: Uint32Array) { this.log.push(["uniform3uiv", [l, [...v]]]); }
  uniformMatrix3x2fv(l: unknown, t: boolean, m: Float32Array) { this.log.push(["uniformMatrix3x2fv", [l, t, [...m]]]); }
  createSampler() { return { kind: "sampler", id: this.next++ }; }
  bindSampler(u: number, s: unknown) { this.log.push(["bindSampler", [u, s]]); }
  fenceSync(c: number, f: number) { this.log.push(["fenceSync", [c, f]]); return { kind: "sync", id: this.next++ }; }
  clientWaitSync(s: unknown, f: number, t: number) { this.log.push(["clientWaitSync", [s, f, t]]); return 0x911A; /* GL_ALREADY_SIGNALED */ }
  getBufferSubData(t: number, o: number, dst: Uint8Array, dstOff: number, len: number) {
    this.log.push(["getBufferSubData", [t, o, dstOff, len]]);
    for (let i = 0; i < len; i++) dst[dstOff + i] = (o + i) & 0xff;
  }
}

function setupBinding(gl: RecordingGl, capacity = 4096) {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: capacity });
  const b = reg.get(1)!;
  const sab = new ArrayBuffer(capacity);
  b.cmdbufView = new Uint8Array(sab, 0, capacity);
  b.gl = gl as unknown as WebGL2RenderingContext;
  return { reg, b };
}

it("preserves legacy extension queries and gates new capabilities by table version", () => {
  const { b } = setupBinding(new RecordingGl());
  const input = new Uint8Array(8);
  const view = new DataView(input.buffer);
  view.setUint32(0, 0x1F03 /* GL_EXTENSIONS */, true);
  const out = new Uint8Array(4096);
  expect(runGlQuery(b, O.QOP_GET_STRING, input.subarray(0, 4), out)).toBe(4);
  expect(new DataView(out.buffer).getUint32(0, true)).toBe(0);
  view.setUint32(4, 2, true);
  const size = runGlQuery(b, O.QOP_GET_STRING, input, out);
  expect(size).toBeGreaterThan(4);
  expect(new TextDecoder().decode(out.subarray(4, size))).toContain("GL_EXT_texture_rg");
  for (const version of [0, O.OP_VERSION + 1]) {
    view.setUint32(4, version, true);
    expect(runGlQuery(b, O.QOP_GET_STRING, input, out)).toBe(-22);
  }
});

/** TLV writer helper. Returns the final length (header + payload). */
class Tlv {
  view: DataView;
  p = 0;
  constructor(buf: ArrayBuffer) { this.view = new DataView(buf); }
  op(op: number, payloadLen: number): { p: number } {
    this.view.setUint16(this.p, op, true);
    this.view.setUint16(this.p + 2, payloadLen, true);
    const start = this.p + 4;
    this.p = start + payloadLen;
    return { p: start };
  }
}

describe("cmdbuf decoder — TLV walker", () => {
  it("walks ClearColor + Clear + Viewport in order", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_CLEAR_COLOR, 16);
    t.view.setFloat32(h.p, 0.1, true); t.view.setFloat32(h.p + 4, 0.2, true);
    t.view.setFloat32(h.p + 8, 0.3, true); t.view.setFloat32(h.p + 12, 1.0, true);
    h = t.op(O.OP_CLEAR, 4);
    t.view.setUint32(h.p, 0x4000, true);
    h = t.op(O.OP_VIEWPORT, 16);
    t.view.setInt32(h.p, 0, true); t.view.setInt32(h.p + 4, 0, true);
    t.view.setInt32(h.p + 8, 640, true); t.view.setInt32(h.p + 12, 400, true);

    decodeAndDispatch(b, 0, t.p);

    expect(gl.log[0][0]).toBe("clearColor");
    expect((gl.log[0][1] as number[]).map((x) => +x.toFixed(3))).toEqual([0.1, 0.2, 0.3, 1.0]);
    expect(gl.log[1]).toEqual(["clear", [0x4000]]);
    expect(gl.log[2]).toEqual(["viewport", [0, 0, 640, 400]]);
  });

  it("GenBuffers + BindBuffer + BufferData round-trips a u32 name", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);

    // Gen with one synthesized name = 42.
    let h = t.op(O.OP_GEN_BUFFERS, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 42, true);

    // Bind GL_ARRAY_BUFFER (0x8892) to name 42.
    h = t.op(O.OP_BIND_BUFFER, 8);
    t.view.setUint32(h.p, 0x8892, true);
    t.view.setUint32(h.p + 4, 42, true);

    // BufferData allocates: u32 target, u32 size, u32 usage.
    h = t.op(O.OP_BUFFER_DATA, 12);
    t.view.setUint32(h.p, 0x8892, true);
    t.view.setUint32(h.p + 4, 300_000, true);
    t.view.setUint32(h.p + 8, 0x88E4 /* GL_STATIC_DRAW */, true);

    // BufferSubData: u32 target, i32 offset, u32 dataLen=12, 12 bytes data.
    h = t.op(O.OP_BUFFER_SUB_DATA, 12 + 12);
    t.view.setUint32(h.p, 0x8892, true);
    t.view.setInt32(h.p + 4, 8, true);
    t.view.setUint32(h.p + 8, 12, true);
    for (let i = 0; i < 12; i++) {
      t.view.setUint8(h.p + 12 + i, (i + 1) * 17);
    }

    decodeAndDispatch(b, 0, t.p);

    expect(b.buffers.has(42)).toBe(true);
    const bufObj = b.buffers.get(42);
    expect(gl.log[1]).toEqual(["bindBuffer", [0x8892, bufObj]]);
    expect(gl.log[2]).toEqual(["bufferData", [0x8892, 300_000, 0x88E4]]);
    const [, offset, data] = gl.log[3][1] as [number, number, Uint8Array];
    expect(offset).toBe(8);
    expect(data.byteLength).toBe(12);
    expect(data[0]).toBe(17);
  });

  it("CreateShader + ShaderSource decodes UTF-8 source", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const src = "void main(){gl_Position=vec4(0);}";
    const srcBytes = new TextEncoder().encode(src);

    let h = t.op(O.OP_CREATE_SHADER, 8);
    t.view.setUint32(h.p, 0x8B30 /* GL_FRAGMENT_SHADER */, true);
    t.view.setUint32(h.p + 4, 1, true); // cmdbuf-name = 1

    h = t.op(O.OP_SHADER_SOURCE, 8 + srcBytes.byteLength);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, srcBytes.byteLength, true);
    new Uint8Array(t.view.buffer).set(srcBytes, h.p + 8);

    decodeAndDispatch(b, 0, t.p);

    expect(b.shaders.has(1)).toBe(true);
    const sh = b.shaders.get(1);
    expect(gl.log.find((r) => r[0] === "shaderSource")?.[1]).toEqual([sh, src]);
  });

  it("ShaderSource decodes over a SharedArrayBuffer-backed cmdbuf", () => {
    // Regression: TextDecoder rejects views over SharedArrayBuffer
    // (the native cmdbuf when the user program runs against shared
    // memory — i.e. always, in this kernel). The bridge must copy
    // before decoding. Without the fix the dispatch throws
    // "The provided ArrayBufferView value must not be shared".
    const gl = new RecordingGl();
    const reg = new GlContextRegistry();
    reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
    const b = reg.get(1)!;
    const sab = new SharedArrayBuffer(4096);
    b.cmdbufView = new Uint8Array(sab, 0, 4096);
    b.gl = gl as unknown as WebGL2RenderingContext;

    const t = new Tlv(b.cmdbufView.buffer);
    const src = "void main(){gl_FragColor=vec4(1.0);}";
    const srcBytes = new TextEncoder().encode(src);

    let h = t.op(O.OP_CREATE_SHADER, 8);
    t.view.setUint32(h.p, 0x8B30, true);
    t.view.setUint32(h.p + 4, 1, true);

    h = t.op(O.OP_SHADER_SOURCE, 8 + srcBytes.byteLength);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, srcBytes.byteLength, true);
    new Uint8Array(t.view.buffer).set(srcBytes, h.p + 8);

    expect(() => decodeAndDispatch(b, 0, t.p)).not.toThrow();
    expect(gl.log.find((r) => r[0] === "shaderSource")?.[1][1]).toBe(src);
  });

  it("BindAttribLocation decodes over a SharedArrayBuffer-backed cmdbuf", () => {
    const gl = new RecordingGl();
    const reg = new GlContextRegistry();
    reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
    const b = reg.get(1)!;
    const sab = new SharedArrayBuffer(4096);
    b.cmdbufView = new Uint8Array(sab, 0, 4096);
    b.gl = gl as unknown as WebGL2RenderingContext;

    const t = new Tlv(b.cmdbufView.buffer);
    const name = "a_pos";
    const nameBytes = new TextEncoder().encode(name);

    let h = t.op(O.OP_CREATE_PROGRAM, 4);
    t.view.setUint32(h.p, 7, true);

    h = t.op(O.OP_BIND_ATTRIB_LOCATION, 12 + nameBytes.byteLength);
    t.view.setUint32(h.p, 7, true);
    t.view.setUint32(h.p + 4, 0, true);
    t.view.setUint32(h.p + 8, nameBytes.byteLength, true);
    new Uint8Array(t.view.buffer).set(nameBytes, h.p + 12);

    expect(() => decodeAndDispatch(b, 0, t.p)).not.toThrow();
    expect(gl.log.find((r) => r[0] === "bindAttribLocation")?.[1][2]).toBe(name);
  });

  it("UniformMatrix4fv reads the right number of floats", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    // Fake a uniform location at index 1.
    b.uniformLocations.set(1, { kind: "uloc", name: "u" } as unknown as WebGLUniformLocation);
    const mat: number[] = [];
    for (let i = 0; i < 16; i++) mat.push(i * 0.5);

    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_UNIFORM_MATRIX4FV, 12 + 16 * 4);
    t.view.setInt32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 1, true); // count
    t.view.setUint32(h.p + 8, 0, true); // transpose=false
    for (let i = 0; i < 16; i++) {
      t.view.setFloat32(h.p + 12 + i * 4, mat[i], true);
    }

    decodeAndDispatch(b, 0, t.p);

    const call = gl.log.find((r) => r[0] === "uniformMatrix4fv");
    expect(call).toBeDefined();
    const recordedMat = (call![1] as unknown[])[2] as number[];
    expect(recordedMat).toEqual(mat);
  });

  it("float uniforms after an odd-length record are applied, not rejected", () => {
    // Records are packed back to back with no padding, so one whose
    // payload is not a multiple of 4 bytes leaves every later record
    // unaligned. SDL's YUV upload of a 350-pixel-wide frame is one: its
    // 175-pixel chroma rows make a 175-byte texSubImage2D. Rejecting the
    // unaligned matrix that follows dropped the rest of the submit, and
    // SDL, which caches the projection it believes it uploaded, drew every
    // later frame with the stale one.
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    b.uniformLocations.set(1, { kind: "uloc", name: "u" } as unknown as WebGLUniformLocation);
    const mat: number[] = [];
    for (let i = 0; i < 16; i++) mat.push(i * 0.25);
    const vec = [0.5, -1, 2, 8];

    const t = new Tlv(b.cmdbufView!.buffer);
    const rowBytes = 175;
    const tex = t.op(O.OP_TEX_SUB_IMAGE_2D, 36 + rowBytes);
    t.view.setUint32(tex.p, 0x0DE1, true); // TEXTURE_2D
    t.view.setInt32(tex.p + 16, rowBytes, true); // width
    t.view.setInt32(tex.p + 20, 1, true); // height
    t.view.setUint32(tex.p + 24, 0x1909, true); // LUMINANCE
    t.view.setUint32(tex.p + 28, 0x1401, true); // UNSIGNED_BYTE
    t.view.setUint32(tex.p + 32, rowBytes, true);
    const m = t.op(O.OP_UNIFORM_MATRIX4FV, 12 + 16 * 4);
    expect((b.cmdbufView!.byteOffset + m.p + 12) % 4).not.toBe(0);
    t.view.setInt32(m.p, 1, true);
    t.view.setUint32(m.p + 4, 1, true);
    t.view.setUint32(m.p + 8, 0, true);
    for (let i = 0; i < 16; i++) t.view.setFloat32(m.p + 12 + i * 4, mat[i], true);
    const u = t.op(O.OP_UNIFORM4FV, 8 + 4 * 4);
    t.view.setInt32(u.p, 1, true);
    t.view.setUint32(u.p + 4, 1, true);
    for (let i = 0; i < 4; i++) t.view.setFloat32(u.p + 8 + i * 4, vec[i], true);
    const d = t.op(O.OP_DRAW_ARRAYS, 12);
    t.view.setUint32(d.p, 4, true);
    t.view.setInt32(d.p + 4, 0, true);
    t.view.setInt32(d.p + 8, 4, true);

    expect(decodeAndDispatch(b, 0, t.p)).toBe(0);
    expect(gl.log.map((r) => r[0])).toEqual([
      "texSubImage2D", "uniformMatrix4fv", "uniform4fv", "drawArrays",
    ]);
    expect((gl.log[1][1] as unknown[])[2]).toEqual(mat);
    expect((gl.log[2][1] as unknown[])[1]).toEqual(vec);
  });

  it("DrawArrays(GL_TRIANGLES, 0, 3) decodes correctly", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_DRAW_ARRAYS, 12);
    t.view.setUint32(h.p, 0x0004 /* GL_TRIANGLES */, true);
    t.view.setInt32(h.p + 4, 0, true);
    t.view.setInt32(h.p + 8, 3, true);

    decodeAndDispatch(b, 0, t.p);

    expect(gl.log[0]).toEqual(["drawArrays", [0x0004, 0, 3]]);
  });

  it("unknown opcode returns EINVAL without throwing", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(0xCAFE, 4);
    t.view.setUint32(h.p, 0, true);
    expect(decodeAndDispatch(b, 0, t.p)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
  });

  it("truncated TLV header returns EINVAL", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    expect(decodeAndDispatch(b, 0, 3)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
  });

  it("overlong payload returns EINVAL", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, O.OP_CLEAR, true);
    view.setUint16(2, 4, true);
    view.setUint32(4, 0x4000, true);
    expect(decodeAndDispatch(b, 0, 7)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
  });

  it("short array payload returns EINVAL before partial dispatch", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_GEN_BUFFERS, 8);
    t.view.setUint32(h.p, 2, true);
    t.view.setUint32(h.p + 4, 10, true);
    expect(decodeAndDispatch(b, 0, t.p)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
    expect(b.buffers.size).toBe(0);
  });

  it("submit with no live context is a silent no-op", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    b.gl = null;
    const t = new Tlv(b.cmdbufView!.buffer);
    t.op(O.OP_CLEAR, 4);
    expect(() => decodeAndDispatch(b, 0, t.p)).not.toThrow();
    expect(gl.log).toEqual([]);
  });
});

describe("query handler", () => {
  function out(n: number) {
    return new Uint8Array(new ArrayBuffer(n));
  }
  function input(bytes: number[]) {
    return new Uint8Array(bytes);
  }
  function setup() {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    return { gl, b };
  }

  it("QOP_FINISH finishes the context and writes nothing", () => {
    const { b, gl } = setup();
    expect(runGlQuery(b, O.QOP_FINISH, input([]), out(0))).toBe(0);
    expect(gl.log.filter(([m]) => m === "finish")).toHaveLength(1);
  });

  it("QOP_GET_ERROR writes 4 bytes", () => {
    const { b } = setup();
    const o = out(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, input([]), o)).toBe(4);
    expect(o[0]).toBe(0); // RecordingGl.getError() returns 0
  });

  it("QOP_GET_INTEGERV reads a u32 pname and writes an i32", () => {
    const { b } = setup();
    const o = out(4);
    const pname = new Uint8Array(4);
    new DataView(pname.buffer).setUint32(0, 0x0D33 /* MAX_TEXTURE_SIZE */, true);
    expect(runGlQuery(b, O.QOP_GET_INTEGERV, pname, o)).toBe(4);
    expect(new DataView(o.buffer).getInt32(0, true)).toBe(42);
  });

  it("QOP_GET_UNIFORM_LOC allocates monotonic indices", () => {
    const { b } = setup();
    // Plant a "program" object so the lookup succeeds.
    const prog = { kind: "program", id: 1 } as unknown as WebGLProgram;
    b.programs.set(7, prog);

    const name = new TextEncoder().encode("u_color");
    const inp = new Uint8Array(8 + name.byteLength);
    new DataView(inp.buffer).setUint32(0, 7, true);
    new DataView(inp.buffer).setUint32(4, name.byteLength, true);
    inp.set(name, 8);

    const o1 = out(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o1)).toBe(4);
    const idx1 = new DataView(o1.buffer).getInt32(0, true);
    expect(idx1).toBe(1);
    expect(b.uniformLocations.has(1)).toBe(true);

    const o2 = out(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o2)).toBe(4);
    const idx2 = new DataView(o2.buffer).getInt32(0, true);
    expect(idx2).toBe(2);

    // Delete idx1; next lookup should be idx 3, not reused 1.
    b.uniformLocations.delete(1);
    const o3 = out(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o3)).toBe(4);
    expect(new DataView(o3.buffer).getInt32(0, true)).toBe(3);
  });

  it("QOP_GET_UNIFORM_LOC returns -1 for a missing uniform", () => {
    const { b } = setup();
    const prog = { kind: "program" } as unknown as WebGLProgram;
    b.programs.set(1, prog);
    const name = new TextEncoder().encode("u_unknown");
    const inp = new Uint8Array(8 + name.byteLength);
    new DataView(inp.buffer).setUint32(0, 1, true);
    new DataView(inp.buffer).setUint32(4, name.byteLength, true);
    inp.set(name, 8);
    const o = out(4);
    runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o);
    expect(new DataView(o.buffer).getInt32(0, true)).toBe(-1);
  });

  it("QOP_GET_SHADER_INFO_LOG writes string-len header + bytes", () => {
    const { b } = setup();
    b.shaders.set(1, {} as unknown as WebGLShader);
    const inp = new Uint8Array(4);
    new DataView(inp.buffer).setUint32(0, 1, true);
    const o = out(64);
    const n = runGlQuery(b, O.QOP_GET_SHADER_INFO_LOG, inp, o);
    const len = new DataView(o.buffer).getUint32(0, true);
    expect(len).toBe("shader log".length);
    expect(n).toBe(4 + len);
    expect(new TextDecoder().decode(o.subarray(4, 4 + len))).toBe("shader log");
  });

  it("returns -EPERM when the binding has no live context", () => {
    const { b } = setup();
    b.gl = null;
    expect(runGlQuery(b, O.QOP_GET_ERROR, input([]), out(4))).toBe(-1);
  });

  it("returns -EINVAL for an unknown query op", () => {
    const { b } = setup();
    expect(runGlQuery(b, 0xfe, input([]), out(4))).toBe(-22);
  });
});


describe("GLES texture upload marshalling", () => {
  for (const [type, View, values] of [
    [0x1406, Float32Array, [0.25, 0.5, 0.75, 1]],
    [0x8d61, Uint16Array, [0x3c00, 0x3800, 0, 0x3c00]],
    [0x8033, Uint16Array, [0xffff]],
  ] as const) {
    it(`copies unaligned shared texture bytes into a typed view for ${type.toString(16)}`, () => {
      const gl = new RecordingGl();
      const { b } = setupBinding(gl);
      const input = new View(values);
      const buffer = new SharedArrayBuffer(256);
      // Prior TLV records can put the next texture record at a nonaligned offset.
      b.cmdbufView = new Uint8Array(buffer, 1);
      const t = new Tlv(buffer);
      t.p = 1;
      const h = t.op(O.OP_TEX_IMAGE_2D, 36 + input.byteLength);
      [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, type, input.byteLength]
        .forEach((n, i) => t.view.setUint32(h.p + i * 4, n, true));
      new Uint8Array(buffer, h.p + 36, input.byteLength).set(new Uint8Array(input.buffer));
      expect(decodeAndDispatch(b, 0, t.p - 1)).toBe(0);
      const args = gl.log.find(row => row[0] === "texImage2D")![1];
      const uploaded = args[8] as Float32Array | Uint16Array;
      expect(uploaded).toBeInstanceOf(View);
      expect(uploaded.buffer).toBeInstanceOf(ArrayBuffer);
      expect([...uploaded]).toEqual([...values]);
      expect(args[7]).toBe(type === 0x8d61 ? 0x140b : type);
      expect(args[2]).toBe(type === 0x1406 ? 0x8814 : type === 0x8d61 ? 0x881a : 0x1908);
    });
  }

  it("translates GLES2 allocation formats while preserving sized requests", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    for (const [internal, format, type, expected] of [
      [0x1903, 0x1903, 0x1401, 0x8229], // RED byte -> R8
      [0x8227, 0x8227, 0x1406, 0x8230], // RG float -> RG32F
      [0x1902, 0x1902, 0x1403, 0x81a5], // depth short -> depth16
      [0x84f9, 0x84f9, 0x84fa, 0x88f0], // packed depth/stencil
      [0x8058, 0x1908, 0x1401, 0x8058], // explicit RGBA8
    ]) {
      const t = new Tlv(b.cmdbufView!.buffer);
      const h = t.op(O.OP_TEX_IMAGE_2D, 36);
      [0x0de1, 0, internal, 4, 4, 0, format, type, 0]
        .forEach((n, i) => t.view.setUint32(h.p + i * 4, n, true));
      expect(decodeAndDispatch(b, 0, t.p)).toBe(0);
      const args = gl.log.at(-1)![1];
      expect(args[2]).toBe(expected);
      expect(args[8]).toBeNull();
    }
  });
});

describe("cmdbuf decoder — OpenGL ES 3.0", () => {
  it("TexSubImage2D hands WebGL2 the typed array its type requires", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    // An odd-length record first, so the pixel data starts unaligned.
    let h = t.op(O.OP_SHADER_SOURCE, 9);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 1, true);
    h = t.op(O.OP_TEX_SUB_IMAGE_2D, 36 + 8);
    t.view.setUint32(h.p, 0x0DE1, true);                 // GL_TEXTURE_2D
    t.view.setUint32(h.p + 16, 2, true);                 // width
    t.view.setUint32(h.p + 20, 1, true);                 // height
    t.view.setUint32(h.p + 24, 0x1903, true);            // GL_RED
    t.view.setUint32(h.p + 28, 0x1406, true);            // GL_FLOAT
    t.view.setUint32(h.p + 32, 8, true);
    t.view.setFloat32(h.p + 36, 0.5, true);
    t.view.setFloat32(h.p + 40, 2.0, true);

    expect(decodeAndDispatch(b, 0, t.p)).toBe(0);

    const data = gl.log.find(([m]) => m === "texSubImage2D")![1][8];
    expect(data).toBeInstanceOf(Float32Array);
    expect([...(data as Float32Array)]).toEqual([0.5, 2.0]);
  });

  it("UniformUIV and UniformMatrixFV pick the setter by shape", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    b.uniformLocations.set(5, { kind: "uloc" } as unknown as WebGLUniformLocation);
    const t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_UNIFORM_UIV, 12 + 12);
    t.view.setInt32(h.p, 5, true);
    t.view.setUint32(h.p + 4, 3, true);
    t.view.setUint32(h.p + 8, 1, true);
    [7, 8, 0xFFFFFFFF].forEach((x, i) => t.view.setUint32(h.p + 12 + i * 4, x, true));
    h = t.op(O.OP_UNIFORM_MATRIX_FV, 20 + 24);
    t.view.setInt32(h.p, 5, true);
    t.view.setUint32(h.p + 4, 3, true);
    t.view.setUint32(h.p + 8, 2, true);
    t.view.setUint32(h.p + 12, 1, true);
    for (let i = 0; i < 6; i++) t.view.setFloat32(h.p + 20 + i * 4, i, true);

    expect(decodeAndDispatch(b, 0, t.p)).toBe(0);

    expect(gl.log[0]).toEqual(["uniform3uiv", [{ kind: "uloc" }, [7, 8, 0xFFFFFFFF]]]);
    expect(gl.log[1]).toEqual(["uniformMatrix3x2fv", [{ kind: "uloc" }, false, [0, 1, 2, 3, 4, 5]]]);
  });

  it("a uniform vector whose size disagrees with its count is refused", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_UNIFORM_UIV, 12 + 4);
    t.view.setUint32(h.p + 4, 2, true);
    t.view.setUint32(h.p + 8, 1, true);
    expect(decodeAndDispatch(b, 0, t.p)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
  });

  it("records the GLES 3.0 context state the muxer replays", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    let h = t.op(O.OP_GEN_BUFFERS, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 3, true);
    h = t.op(O.OP_BIND_BUFFER_RANGE, 20);
    [0x8A11, 2, 3, 256, 64].forEach((x, i) => t.view.setUint32(h.p + i * 4, x, true));
    h = t.op(O.OP_STENCIL_FUNC_SEPARATE, 16);
    [0x0404 /* GL_FRONT */, 0x0202, 1, 0xFF].forEach((x, i) => t.view.setUint32(h.p + i * 4, x, true));
    h = t.op(O.OP_GEN_SAMPLERS, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 4, true);
    h = t.op(O.OP_BIND_SAMPLER, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 4, true);
    h = t.op(O.OP_GEN_FRAMEBUFFERS, 8);
    t.view.setUint32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 6, true);
    h = t.op(O.OP_BIND_FRAMEBUFFER, 8);
    t.view.setUint32(h.p, 0x8D40 /* GL_FRAMEBUFFER */, true);
    t.view.setUint32(h.p + 4, 6, true);

    expect(decodeAndDispatch(b, 0, t.p)).toBe(0);

    const buf = b.buffers.get(3)!;
    expect(b.shadow.uniformBufferRanges.get(2)).toEqual({ buffer: buf, offset: 256, size: 64 });
    expect(b.shadow.bufferBindings.get(0x8A11)).toBe(buf);
    expect(b.shadow.stencil.front).toMatchObject({ func: 0x0202, ref: 1, valueMask: 0xFF });
    expect(b.shadow.stencil.back.func).toBe(0x0207);
    expect(b.shadow.samplerUnits[1]).toBe(b.samplers.get(4));
    expect(b.shadow.fbo).toBe(b.fbos.get(6));
    expect(b.shadow.readFbo).toBe(b.fbos.get(6));
  });

  it("FenceSync names a host fence that a client wait polls once", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_FENCE_SYNC, 12);
    t.view.setUint32(h.p, 9, true);
    t.view.setUint32(h.p + 4, 0x9117 /* GL_SYNC_GPU_COMMANDS_COMPLETE */, true);

    expect(decodeAndDispatch(b, 0, t.p)).toBe(0);

    const out = new Uint8Array(4);
    const input = new Uint8Array(new Uint32Array([9, 1]).buffer);
    expect(runGlQuery(b, O.QOP_CLIENT_WAIT_SYNC, input, out)).toBe(4);
    expect(new DataView(out.buffer).getUint32(0, true)).toBe(0x911A);
    expect(gl.log.at(-1)).toEqual(["clientWaitSync", [b.syncs.get(9), 1, 0]]);
  });
});

describe("query handler — OpenGL ES 3.0", () => {
  it("lists the GL_EXTENSIONS string one extension per index", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const strOut = new Uint8Array(4096);
    const len = runGlQuery(b, O.QOP_GET_STRING, new Uint8Array(new Uint32Array([0x1F03, O.OP_VERSION]).buffer), strOut);
    const listed = new TextDecoder().decode(strOut.subarray(4, len)).split(" ");
    expect(listed).toContain("GL_OES_texture_float_linear");
    expect(listed).not.toContain("GL_EXT_float_blend");

    const count = new Uint8Array(4);
    runGlQuery(b, O.QOP_GET_INTEGERV, new Uint8Array(new Uint32Array([0x821D]).buffer), count);
    expect(new DataView(count.buffer).getInt32(0, true)).toBe(listed.length);

    const out = new Uint8Array(64);
    const indexed = listed.map((_, i) => {
      const n = runGlQuery(b, O.QOP_GET_STRINGI, new Uint8Array(new Uint32Array([0x1F03, i]).buffer), out);
      return new TextDecoder().decode(out.subarray(4, n));
    });
    expect(indexed).toEqual(listed);
    const past = new Uint8Array(new Uint32Array([0x1F03, listed.length]).buffer);
    expect(runGlQuery(b, O.QOP_GET_STRINGI, past, out)).toBe(-22);
  });

  it("QOP_GET_BUFFER_SUB_DATA reads the requested range", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const out = new Uint8Array(4);
    const n = runGlQuery(b, O.QOP_GET_BUFFER_SUB_DATA, new Uint8Array(new Uint32Array([0x8F36, 10, 4]).buffer), out);
    expect(n).toBe(4);
    expect([...out]).toEqual([10, 11, 12, 13]);
  });
});
