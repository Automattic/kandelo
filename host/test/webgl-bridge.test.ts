import { describe, expect, it } from "vitest";
import {
  decodeAndDispatch,
  GL_SUBMIT_EINVAL,
} from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";

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
  private boundBuffers = new Map<number, unknown>();
  bufferContents = new Map<unknown, Uint8Array>();
  indexDraws: {mode:number;count:number;type:number;offset:number;data:Uint8Array}[] = [];

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
  bindBuffer(t: number, b: unknown) { this.log.push(["bindBuffer", [t, b]]); this.boundBuffers.set(t,b); }
  bufferData(t: number, d: unknown, u: number) {
    this.log.push(["bufferData", [t, d, u]]);
    this.bufferContents.set(this.boundBuffers.get(t), typeof d === "number" ? new Uint8Array(d) : new Uint8Array(d as Uint8Array));
  }
  bufferSubData(t: number, o: number, d: unknown) {
    this.log.push(["bufferSubData", [t, o, d]]);
    this.bufferContents.get(this.boundBuffers.get(t))?.set(d as Uint8Array,o);
  }
  getBufferSubData(t: number, o: number, d: Uint8Array) {
    this.log.push(["getBufferSubData",[t,o,d.byteLength]]);
    d.set(this.bufferContents.get(this.boundBuffers.get(t))!.subarray(o,o+d.byteLength));
  }
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
  detachShader(p: unknown, s: unknown) { this.log.push(["detachShader", [p, s]]); }
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
  uniformMatrix3fv(l: unknown, t: boolean, m: Float32Array) { this.log.push(["uniformMatrix3fv", [l, t, [...m]]]); }
  uniformMatrix4fv(l: unknown, t: boolean, m: Float32Array) { this.log.push(["uniformMatrix4fv", [l, t, [...m]]]); }
  uniform4fv(l: unknown, v: Float32Array) { this.log.push(["uniform4fv", [l, [...v]]]); }

  // attribs / draws
  enableVertexAttribArray(i: number) { this.log.push(["enableVertexAttribArray", [i]]); }
  disableVertexAttribArray(i: number) { this.log.push(["disableVertexAttribArray", [i]]); }
  vertexAttribPointer(i: number, sz: number, t: number, n: boolean, st: number, off: number) { this.log.push(["vertexAttribPointer", [i, sz, t, n, st, off]]); }
  drawArrays(m: number, f: number, c: number) { this.log.push(["drawArrays", [m, f, c]]); }
  drawElements(m: number, c: number, t: number, off: number) {
    this.log.push(["drawElements", [m, c, t, off]]);
    this.indexDraws.push({mode:m,count:c,type:t,offset:off,data:(this.bufferContents.get(this.boundBuffers.get(0x8893)) ?? new Uint8Array()).slice()});
  }

  // VAOs / FBOs / RBOs
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
  deleteVertexArray(v: unknown) { this.log.push(["deleteVertexArray", [v]]); }
  bindFramebuffer(t: number, f: unknown) { this.log.push(["bindFramebuffer", [t, f]]); }
  deleteFramebuffer(f: unknown) { this.log.push(["deleteFramebuffer", [f]]); }
  framebufferTexture2D(...a: unknown[]) { this.log.push(["framebufferTexture2D", a]); }
  bindRenderbuffer(t: number, r: unknown) { this.log.push(["bindRenderbuffer", [t, r]]); }
  deleteRenderbuffer(r: unknown) { this.log.push(["deleteRenderbuffer", [r]]); }
  renderbufferStorage(...a: number[]) { this.log.push(["renderbufferStorage", a]); }
  framebufferRenderbuffer(...a: unknown[]) { this.log.push(["framebufferRenderbuffer", a]); }

  // queries
  finish() { this.log.push(["finish", []]); }
  getError() { return 0; }
  getParameter(p: number) {
    if (p === 0x8f36 || p === 0x8f37) return this.boundBuffers.get(p) ?? null;
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

function seedUniform(b: ReturnType<typeof setupBinding>["b"]): void {
  const program = {} as WebGLProgram;
  b.programs.set(1, program);
  b.shadow.currentProgram = b.currentProgram = program;
  b.currentProgramId = 1;
  b.uniformLocations.set(1, { kind: "uloc", name: "u" } as unknown as WebGLUniformLocation);
  b.uniformLocationPrograms.set(1, 1);
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

describe("logical framebuffer bindings", () => {
  function setup() {
    const gl = new RecordingGl(), { b } = setupBinding(gl);
    const send = (op: number, words: number[]) => {
      const t = new Tlv(b.cmdbufView!.buffer);
      const { p } = t.op(op, words.length * 4);
      words.forEach((word,index) => t.view.setUint32(p+index*4,word,true));
      expect(decodeAndDispatch(b,0,t.p)).toBe(0);
    };
    return { b, gl, send };
  }

  it("rejects an invalid target before allocating or changing a framebuffer", () => {
    const { b, gl, send } = setup();
    send(O.OP_BIND_FRAMEBUFFER,[0xdead,71]);
    expect(b.errors).toEqual([0x500]);
    expect(b.fbos.size).toBe(0);
    expect(b.shadow.fbo).toBeNull(); expect(b.shadow.readFbo).toBeNull();
    expect(gl.log).toEqual([]);
  });

  it("creates names on first bind and returns deleted bindings to the undefined default", () => {
    const { b, gl, send } = setup();
    expect(applyCurrentDrawable(b,{drawSurfaceId:0,readSurfaceId:0,width:0,height:0})).toBe(true);
    const missing = b.undefinedDefaultFbo;
    send(O.OP_BIND_FRAMEBUFFER,[0x8d40,71]);
    const user = b.fbos.get(71);
    expect(user).toBeTruthy(); expect(user).not.toBe(missing);
    expect(b.shadow.fbo).toBe(user); expect(b.shadow.readFbo).toBe(user);
    send(O.OP_DELETE_FRAMEBUFFERS,[1,71]);
    expect(b.fbos.has(71)).toBe(false);
    expect(b.shadow.fbo).toBe(missing); expect(b.shadow.readFbo).toBe(missing);
    expect(gl.log.filter(([name]) => name === "bindFramebuffer")).toEqual([
      ["bindFramebuffer",[0x8d40,user]],
      ["bindFramebuffer",[0x8ca9,missing]], ["bindFramebuffer",[0x8ca8,missing]],
    ]);
  });

  it.each([O.OP_FRAMEBUFFER_TEXTURE_2D,O.OP_FRAMEBUFFER_RENDERBUFFER])("keeps default framebuffer attachments immutable for operation %i", op => {
    const { b, gl, send } = setup();
    expect(applyCurrentDrawable(b,{drawSurfaceId:0,readSurfaceId:0,width:0,height:0})).toBe(true);
    const missing = b.undefinedDefaultFbo;
    gl.log.length = 0;
    send(op,op === O.OP_FRAMEBUFFER_TEXTURE_2D ? [0x8d40,0x8ce0,0x0de1,0,0] : [0x8d40,0x8ce0,0x8d41,0]);
    expect(b.errors).toEqual([0x502]);
    expect(gl.log).toEqual([]);
    expect(b.shadow.fbo).toBe(missing); expect(b.shadow.readFbo).toBe(missing);
  });
});

describe("shared image object deletion", () => {
  function setup() {
    const gl = new RecordingGl(), reg = new GlContextRegistry();
    const bindings = [11,12].map(sessionId => {
      reg.bind({pid:7,sessionId,cmdbufAddr:0,cmdbufLen:1024});
      const b = reg.get(7,sessionId)!; b.gl = gl as unknown as WebGL2RenderingContext;
      b.contextId = sessionId; b.cmdbufView = new Uint8Array(1024); return b;
    });
    expect(reg.shareObjects(7,12,11)).toBe(true);
    const send = (b: typeof bindings[0], op: number, words: number[]) => {
      const t = new Tlv(b.cmdbufView!.buffer), { p } = t.op(op,words.length*4);
      words.forEach((word,index) => t.view.setUint32(p+index*4,word,true));
      expect(decodeAndDispatch(b,0,t.p)).toBe(0);
    };
    return { gl,reg,a:bindings[0],b:bindings[1],send };
  }

  it.each([
    [O.OP_GEN_BUFFERS,O.OP_BIND_BUFFER,0x8892,"buffers","createBuffer"],
    [O.OP_GEN_TEXTURES,O.OP_BIND_TEXTURE,0x0de1,"textures","createTexture"],
    [O.OP_GEN_RENDERBUFFERS,O.OP_BIND_RENDERBUFFER,0x8d41,"rbos","createRenderbuffer"],
  ] as const)("keeps a peer's realized object when delayed reservation %i arrives",(gen,bind,target,map,create)=>{
    const {gl,a,b,send}=setup();
    send(b,bind,[target,71]);const object=b[map].get(71);expect(object).toBeTruthy();
    const creations=gl.log.filter(([name])=>name===create).length;
    send(a,gen,[1,71]);
    expect(a[map].get(71)).toBe(object);expect(a.errors).toEqual([]);
    expect(gl.log.filter(([name])=>name===create)).toHaveLength(creations);
  });
  it.each([
    [O.OP_GEN_BUFFERS,"buffers","createBuffer"],
    [O.OP_GEN_TEXTURES,"textures","createTexture"],
    [O.OP_GEN_RENDERBUFFERS,"rbos","createRenderbuffer"],
  ] as const)("keeps reservation %i distinct from a realized object",(gen,map,create)=>{
    const {gl,a,send}=setup();send(a,gen,[1,71]);expect(a[map].has(71)).toBe(false);
    expect(gl.log.filter(([name])=>name===create)).toEqual([]);expect(a.errors).toEqual([]);
  });

  it.each([O.OP_FRAMEBUFFER_TEXTURE_2D,O.OP_FRAMEBUFFER_RENDERBUFFER])("does not attach an unrealized reserved image for operation %i",op=>{
    const {gl,a,send}=setup();
    send(a,op===O.OP_FRAMEBUFFER_TEXTURE_2D?O.OP_GEN_TEXTURES:O.OP_GEN_RENDERBUFFERS,[1,71]);
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,31]);const framebuffer=a.shadow.fbo!;gl.log.length=0;
    send(a,op,op===O.OP_FRAMEBUFFER_TEXTURE_2D?[0x8d40,0x8ce0,0x0de1,71,0]:[0x8d40,0x8ce0,0x8d41,71]);
    expect(a.errors).toEqual([0x502]);expect(a.framebufferAttachments.has(framebuffer)).toBe(false);
    expect(gl.log.some(([name])=>name==="framebufferTexture2D" || name==="framebufferRenderbuffer")).toBe(false);
  });

  it("keeps another context's deleted texture binding and name through name reuse", () => {
    const { gl,a,b,send } = setup();
    send(a,O.OP_GEN_TEXTURES,[1,71]); send(a,O.OP_BIND_TEXTURE,[0x0de1,71]); const old = a.textures.get(71)!;
    send(a,O.OP_BIND_TEXTURE,[0x0de1,71]); send(b,O.OP_BIND_TEXTURE,[0x0de1,71]);
    send(a,O.OP_DELETE_TEXTURES,[1,71]);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([]);
    expect(a.textures.has(71)).toBe(false); expect(a.shadow.textureUnits[0]).toBeNull();
    expect(b.shadow.textureUnits[0]).toBe(old);
    const input = new Uint8Array(4), output = new Uint8Array(4);
    new DataView(input.buffer).setUint32(0,0x8069,true);
    gl.getParameter = () => old as any;
    expect(runGlQuery(b,O.QOP_GET_INTEGERV,input,output)).toBe(4);
    expect(new DataView(output.buffer).getUint32(0,true)).toBe(71);
    send(a,O.OP_BIND_TEXTURE,[0x0de1,71]); const replacement = a.textures.get(71)!;
    expect(replacement).toBeTruthy(); expect(replacement).not.toBe(old);
    send(b,O.OP_BIND_TEXTURE,[0x0de1,0]);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([["deleteTexture",[old]]]);
    expect(a.textures.get(71)).toBe(replacement);
  });

  it("retains an unbound FBO's deleted texture until the container is destroyed", () => {
    const { gl,a,send } = setup();
    send(a,O.OP_GEN_TEXTURES,[1,71]); send(a,O.OP_BIND_TEXTURE,[0x0de1,71]); const texture = a.textures.get(71)!;
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,31]);
    send(a,O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,71,0]);
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,0]); send(a,O.OP_DELETE_TEXTURES,[1,71]);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([]);
    send(a,O.OP_DELETE_FRAMEBUFFERS,[1,31]);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([["deleteTexture",[texture]]]);
  });

  it("detaches a deleted renderbuffer only from the caller's bound FBO", () => {
    const { gl,a,b,send } = setup();
    send(a,O.OP_GEN_RENDERBUFFERS,[1,71]); send(a,O.OP_BIND_RENDERBUFFER,[0x8d41,71]); const renderbuffer = a.rbos.get(71)!;
    send(a,O.OP_BIND_RENDERBUFFER,[0x8d41,71]);
    for(const [owner,framebuffer] of [[a,31],[b,32]] as const) {
      send(owner,O.OP_BIND_FRAMEBUFFER,[0x8d40,framebuffer]);
      send(owner,O.OP_FRAMEBUFFER_RENDERBUFFER,[0x8d40,0x8ce0,0x8d41,71]);
    }
    send(b,O.OP_BIND_FRAMEBUFFER,[0x8d40,0]);
    send(a,O.OP_DELETE_RENDERBUFFERS,[1,71]);
    expect(gl.log.filter(([name]) => name === "deleteRenderbuffer")).toEqual([]);
    expect(a.shadow.renderbuffer).toBeNull(); expect(a.rbos.has(71)).toBe(false);
    expect(gl.log.filter(([name,args]) => name === "framebufferRenderbuffer" && args[3] === null))
      .toEqual([["framebufferRenderbuffer",[0x8ca9,0x8ce0,0x8d41,null]]]);
    send(b,O.OP_BIND_FRAMEBUFFER,[0x8d40,32]);
    send(b,O.OP_FRAMEBUFFER_RENDERBUFFER,[0x8d40,0x8ce0,0x8d41,0]);
    expect(gl.log.filter(([name]) => name === "deleteRenderbuffer")).toEqual([["deleteRenderbuffer",[renderbuffer]]]);
  });

  it("retains packed depth/stencil storage until both attachment points are released", () => {
    const { gl,a,send } = setup();
    send(a,O.OP_GEN_RENDERBUFFERS,[1,71]); send(a,O.OP_BIND_RENDERBUFFER,[0x8d41,71]); const renderbuffer = a.rbos.get(71)!;
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,31]);
    send(a,O.OP_FRAMEBUFFER_RENDERBUFFER,[0x8d40,0x821a,0x8d41,71]);
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,0]); send(a,O.OP_DELETE_RENDERBUFFERS,[1,71]);
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,31]);
    send(a,O.OP_FRAMEBUFFER_RENDERBUFFER,[0x8d40,0x8d00,0x8d41,0]);
    expect(gl.log.filter(([name]) => name === "deleteRenderbuffer")).toEqual([]);
    send(a,O.OP_FRAMEBUFFER_RENDERBUFFER,[0x8d40,0x8d20,0x8d41,0]);
    expect(gl.log.filter(([name]) => name === "deleteRenderbuffer")).toEqual([["deleteRenderbuffer",[renderbuffer]]]);
  });

  it("keeps attachment ownership after a rejected native replacement", () => {
    const { gl,a,send } = setup();
    send(a,O.OP_GEN_TEXTURES,[1,71]); send(a,O.OP_BIND_TEXTURE,[0x0de1,71]); const texture = a.textures.get(71)!;
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,31]);
    send(a,O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,71,0]);
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,0]); send(a,O.OP_DELETE_TEXTURES,[1,71]);
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,31]);
    let pending = 0;
    gl.getError = () => { const result = pending; pending = 0; return result; };
    const attach = gl.framebufferTexture2D;
    gl.framebufferTexture2D = () => { pending = 0x502; };
    send(a,O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,0,0]);
    expect(a.errors).toEqual([0x502]);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([]);
    gl.framebufferTexture2D = attach;
    send(a,O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,0,0]);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([["deleteTexture",[texture]]]);
  });

  it("reclaims a deleted attachment when its last retaining context ends", () => {
    const { gl,reg,a,b,send } = setup();
    send(a,O.OP_GEN_TEXTURES,[1,71]); send(a,O.OP_BIND_TEXTURE,[0x0de1,71]); const texture = a.textures.get(71)!;
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,31]);
    send(a,O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,71,0]);
    send(a,O.OP_BIND_FRAMEBUFFER,[0x8d40,0]); send(a,O.OP_DELETE_TEXTURES,[1,71]);
    reg.destroyContext(7,11);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([["deleteTexture",[texture]]]);
    expect(b.textures.size).toBe(0);
    reg.destroyContext(7,12);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toHaveLength(1);
  });

  it("leaves BO-owned native texture retirement to its canonical owner", () => {
    const { gl,a,send } = setup();
    send(a,O.OP_GEN_TEXTURES,[1,71]); send(a,O.OP_BIND_TEXTURE,[0x0de1,71]); const texture = a.textures.get(71)!;
    a.externallyOwnedTextures.add(texture);
    send(a,O.OP_DELETE_TEXTURES,[1,71]);
    expect(a.textures.has(71)).toBe(false); expect(a.retiredTextures.size).toBe(0);
    expect(gl.log.filter(([name]) => name === "deleteTexture")).toEqual([]);
  });
});

describe("shared buffer deletion", () => {
  function setup() {
    const gl = new RecordingGl(), reg = new GlContextRegistry();
    const [a,b] = [11,12].map(sessionId => {
      reg.bind({pid:7,sessionId,cmdbufAddr:0,cmdbufLen:1024});
      const owner = reg.get(7,sessionId)!; owner.gl = gl as unknown as WebGL2RenderingContext;
      owner.contextId = sessionId; owner.cmdbufView = new Uint8Array(1024); return owner;
    });
    expect(reg.shareObjects(7,12,11)).toBe(true);
    const send = (owner: typeof a, op: number, words: number[], tail = new Uint8Array()) => {
      const t = new Tlv(owner.cmdbufView!.buffer), {p} = t.op(op,words.length*4+tail.length);
      words.forEach((word,i) => t.view.setUint32(p+i*4,word,true));
      owner.cmdbufView!.set(tail,p+words.length*4);
      expect(decodeAndDispatch(owner,0,t.p)).toBe(0);
    };
    return {gl,reg,a,b,send};
  }

  it.each([false,true])("pins and restores the unnamed ARRAY identity across temporary rebinding and peer name reuse (index first: %s)",(indexFirst)=>{
    const {gl,reg,a,b,send}=setup();
    const target=indexFirst?0x8893:0x8892;
    send(a,O.OP_BIND_BUFFER,[target,71]);send(a,O.OP_BUFFER_DATA,[target,12,0x88e4]);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]);if(indexFirst)send(a,O.OP_BIND_BUFFER,[0x8893,0]);
    const old=a.shadow.arrayBuffer!,object=a.buffers.get(71)!;
    send(a,0x0105,[]);send(a,O.OP_BIND_BUFFER,[0x8892,72]);
    send(b,O.OP_DELETE_BUFFERS,[1,71]);
    expect(a.retiredBuffers.get(object)).toBe(71);expect(a.bufferStores.has(object)).toBe(true);
    expect(gl.log.filter(([name,args])=>name==="deleteBuffer" && args[0]===old)).toEqual([]);
    send(b,O.OP_BIND_BUFFER,[0x8892,71]);const replacement=b.shadow.arrayBuffer;
    expect(replacement).not.toBe(old);
    send(a,0x0106,[]);expect(a.shadow.arrayBuffer).toBe(old);
    expect(a.bufferStores.get(object)!.size).toBe(12);
    expect(gl.log.at(-1)).toEqual(["bindBuffer",[0x8892,old]]);
    send(a,O.OP_BIND_BUFFER,[0x8892,0]);expect(a.bufferStores.has(object)).toBe(false);
    expect(b.shadow.arrayBuffer).toBe(replacement);reg.unbind(7);
  });
  it("retains a failed restore for retry and releases a captured buffer on context retirement",()=>{
    const {gl,reg,a,b,send}=setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]);send(a,O.OP_BUFFER_DATA,[0x8892,4,0x88e4]);const old=a.shadow.arrayBuffer!;
    send(a,0x0105,[]);send(a,O.OP_BIND_BUFFER,[0x8892,72]);const temporary=a.shadow.arrayBuffer;
    send(b,O.OP_DELETE_BUFFERS,[1,71]);
    const original=gl.bindBuffer.bind(gl);let reject=true;
    gl.bindBuffer=(target:number,value:unknown)=>{if(target===0x8892 && value===old && reject)throw new Error("restore rejected");original(target,value);};
    send(a,0x0106,[]);expect(a.shadow.arrayBuffer).toBe(temporary);expect(a.bufferStores.has(old)).toBe(true);
    expect(a.errors).not.toEqual([]);
    send(a,O.OP_DRAW_ARRAYS,[0,0,1]);expect(gl.log.some(([name])=>name==="drawArrays")).toBe(false);
    reject=false;
    send(a,0x0106,[]);expect(a.shadow.arrayBuffer).toBe(old);
    send(a,0x0105,[]);send(a,O.OP_BIND_BUFFER,[0x8892,72]);reg.destroyContext(7,11);
    expect(b.bufferStores.has(old)).toBe(false);reg.unbind(7);
  });
  it("keeps zero savepoints distinct from absent ones and rejects nested captures",()=>{
    const {a,send}=setup();
    send(a,0x0105,[]);send(a,O.OP_BIND_BUFFER,[0x8892,71]);
    send(a,0x0105,[]);expect(a.errors).toEqual([0x502]);a.errors.length=0;
    send(a,0x0106,[]);expect(a.shadow.arrayBuffer).toBeNull();
    send(a,0x0106,[]);expect(a.errors).toEqual([0x502]);
  });

  it("rejects a malformed capture record before any preceding state mutation",()=>{
    const {a}=setup();const bytes=a.cmdbufView!,v=new DataView(bytes.buffer);
    v.setUint16(0,0x0105,true);v.setUint16(2,0,true);
    v.setUint16(4,0x0106,true);v.setUint16(6,4,true);v.setUint32(8,0,true);
    expect(decodeAndDispatch(a,0,12)).toBe(GL_SUBMIT_EINVAL);
    expect(a.savedClientArrayBuffer).toBeUndefined();expect(a.shadow.arrayBuffer).toBeNull();
  });

  function queryWords(owner: ReturnType<typeof setup>["a"], op: number, words: number[], size = 4) {
    const input = new Uint8Array(words.length*4), out = new Uint8Array(size+8).fill(0xaa);
    words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
    const rc = runGlQuery(owner,op,input,out);
    return {rc:rc < 0 ? rc : rc-8,status:new DataView(out.buffer).getUint32(0,true),out:out.slice(4,size+4)};
  }

  it("queries logical buffer size/usage while a bound native view is stale", () => {
    const {a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,4,0x88e4]); send(a,O.OP_BIND_BUFFER,[0x8893,71]);
    send(a,O.OP_BUFFER_DATA,[0x8892,32,0x88e8]);
    for (const [pname,value] of [[0x8764,32],[0x8765,0x88e8]]) {
      const q = queryWords(a,O.QOP_GET_BUFFER_PARAMETER,[0x8893,pname]);
      expect(q.rc).toBe(4); expect(new DataView(q.out.buffer).getUint32(0,true)).toBe(value);
    }
    const q = queryWords(a,O.QOP_GET_BUFFER_PARAMETER,[0x8893,0xdead]);
    expect(q.status).toBe(1); expect([...q.out]).toEqual([0,0,0,0]); expect(a.errors).toContain(0x500);
  });

  it("queries logical converted attribute formats and rounds current integer values", () => {
    const {a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,3,0x140c,1,1024,16]);
    for (const [pname,value] of [[0x8623,3],[0x8624,1024],[0x8625,0x140c],[0x886a,1],[0x889f,71]]) {
      const q = queryWords(a,O.QOP_GET_VERTEX_ATTRIBIV,[0,pname]);
      expect(q.rc).toBe(4); expect(new DataView(q.out.buffer).getInt32(0,true)).toBe(value);
    }
    a.shadow.vertexAttribValues.set(0,[-1.75,0.25,2.5,1]);
    const integer = queryWords(a,O.QOP_GET_VERTEX_ATTRIBIV,[0,0x8626],16), floats = queryWords(a,O.QOP_GET_VERTEX_ATTRIBFV,[0,0x8626],16);
    expect([...new Int32Array(integer.out.buffer)]).toEqual([-2,0,3,1]); expect([...new Float32Array(floats.out.buffer)]).toEqual([-1.75,0.25,2.5,1]);
  });

  it("distinguishes reserved, bound, deleted and reused buffer names", () => {
    const {a,b,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[1,71]);
    expect(new DataView(queryWords(a,O.QOP_IS_OBJECT,[0,71]).out.buffer).getUint32(0,true)).toBe(0);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(b,O.OP_BIND_BUFFER,[0x8892,71]);
    expect(new DataView(queryWords(a,O.QOP_IS_OBJECT,[0,71]).out.buffer).getUint32(0,true)).toBe(1);
    send(a,O.OP_DELETE_BUFFERS,[1,71]);
    expect(new DataView(queryWords(b,O.QOP_IS_OBJECT,[0,71]).out.buffer).getUint32(0,true)).toBe(0);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]);
    expect(new DataView(queryWords(a,O.QOP_IS_OBJECT,[0,71]).out.buffer).getUint32(0,true)).toBe(1);
  });

  it("reports GLES enable state and rejects foreign enable caps without mutating native state", () => {
    const {gl,a,send} = setup();
    expect(new DataView(queryWords(a,O.QOP_IS_ENABLED,[0x0bd0]).out.buffer).getUint32(0,true)).toBe(1);
    send(a,O.OP_ENABLE,[0x0be2]); expect(new DataView(queryWords(a,O.QOP_IS_ENABLED,[0x0be2]).out.buffer).getUint32(0,true)).toBe(1);
    const calls = gl.log.length; send(a,O.OP_ENABLE,[0x8c89]);
    expect(gl.log.length).toBe(calls); expect(a.errors).toContain(0x500);
  });

  it("returns a bounded index bitset from authoritative storage after another-target updates", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,12,0x88e4]); send(a,O.OP_BIND_BUFFER,[0x8893,71]);
    const data = new Uint8Array(new Uint16Array([123,1,65535,1,255,9]).buffer);
    send(a,O.OP_BUFFER_SUB_DATA,[0x8892,0,data.length],data);
    const q = queryWords(a,O.QOP_GET_INDEX_USAGE,[0x1403,2,4],8196), view = new DataView(q.out.buffer);
    expect(q.rc).toBe(8196); expect(q.status).toBe(0); expect(view.getUint32(0,true)).toBe(65535);
    expect(q.out[4]).toBe(2); expect(q.out[4+Math.floor(255/8)]).toBe(128); expect(q.out[8195]).toBe(128);
    expect(q.out.subarray(4,8196).reduce((n,bits) => n+[...bits.toString(2)].filter(v => v === "1").length,0)).toBe(3);
    expect(gl.getParameter(0x8f36)).toBeNull(); expect(gl.getParameter(0x8f37)).toBeNull();
  });

  it("rejects short v3 envelopes before modifying their output bytes", () => {
    const {a} = setup();
    const out = new Uint8Array(8203).fill(0xaa), input = new Uint8Array(12);
    expect(runGlQuery(a,O.QOP_GET_INDEX_USAGE,input,out)).toBe(-22);
    expect(out.every(v => v === 170)).toBe(true); expect(a.errors).toEqual([]);
  });

  it("marks index query failures without returning partial payloads", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,2,0x88e4]);
    for (const words of [[0x1403,1,1],[0x1401,0,3],[0x1401,0,0]]) {
      const q = queryWords(a,O.QOP_GET_INDEX_USAGE,words,8196); expect(q.status).toBe(1); expect(q.out.every(v => v === 0)).toBe(true);
    }
    const errors: number[] = []; gl.getError = () => errors.shift() ?? 0; gl.getBufferSubData = () => { errors.push(0x505); };
    const q = queryWords(a,O.QOP_GET_INDEX_USAGE,[0x1403,0,1],8196); expect(q.status).toBe(1); expect(q.out.every(v => v === 0)).toBe(true);
    expect(gl.getParameter(0x8f36)).toBeNull(); expect(gl.getParameter(0x8f37)).toBeNull();
  });

  it("widens byte indices including 255 in bounded chunks while keeping one strip draw", () => {
    const {gl,a,send} = setup();
    const values = Uint8Array.from({length:40001},(_,i) => i%256);
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,values.length,0x88e4]);
    for (let i=0; i<values.length; i+=256) {
      const bytes = values.slice(i,i+256); send(a,O.OP_BUFFER_SUB_DATA,[0x8893,i,bytes.length],bytes);
    }
    const object = a.buffers.get(71)!;
    const savedRead = gl.createBuffer(), savedWrite = gl.createBuffer(); gl.bindBuffer(0x8f36,savedRead); gl.bindBuffer(0x8f37,savedWrite);
    send(a,O.OP_DRAW_ELEMENTS,[3,40000,0x1401,1]);
    expect(gl.indexDraws).toHaveLength(1);
    expect(gl.indexDraws[0]).toMatchObject({mode:3,count:40000,type:0x1403,offset:0});
    expect(new Uint16Array(gl.indexDraws[0].data.buffer)).toEqual(Uint16Array.from(values.subarray(1)));
    expect(gl.log.filter(([name]) => name === "getBufferSubData")).toEqual([
      ["getBufferSubData",[0x8f36,1,32768]], ["getBufferSubData",[0x8f36,32769,7232]]]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toHaveLength(1);
    expect(a.vertexArrays.get(0)!.element).toBe(object); expect(a.bufferStores.size).toBe(1);
    expect(gl.bufferContents.get(object)).toEqual(values);
    expect(gl.getParameter(0x8f36)).toBe(savedRead); expect(gl.getParameter(0x8f37)).toBe(savedWrite);
    expect(gl.log.filter(([name]) => name === "bindBuffer").at(-1)).toEqual(["bindBuffer",[0x8893,object]]);
  });

  it("widens short indices including 65535 without changing values or input storage", () => {
    const {gl,a,send} = setup();
    const values = new Uint16Array([123,0,65535,1]), bytes = new Uint8Array(values.buffer);
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,bytes.length,0x88e4]);
    send(a,O.OP_BUFFER_SUB_DATA,[0x8893,0,bytes.length],bytes);
    send(a,O.OP_DRAW_ELEMENTS,[5,3,0x1403,2]);
    expect(gl.indexDraws).toHaveLength(1);
    expect(gl.indexDraws[0]).toMatchObject({mode:5,count:3,type:0x1405,offset:0});
    expect(new Uint32Array(gl.indexDraws[0].data.buffer)).toEqual(new Uint32Array([0,65535,1]));
    expect(gl.bufferContents.get(a.buffers.get(71)!)).toEqual(bytes); expect(a.errors).toEqual([]);
  });

  it("rejects invalid indexed draw arguments before reading or allocating", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,4,0x88e4]);
    const calls = gl.log.length;
    for (const words of [[7,1,0x1401,0],[0,1,0x1405,0],[0,-1,0x1401,0],[0,1,0x1403,1],[0,3,0x1403,0]]) {
      send(a,O.OP_DRAW_ELEMENTS,words);
    }
    expect(gl.log.length).toBe(calls); expect(gl.indexDraws).toEqual([]);
    expect(a.errors).toContain(0x500); expect(a.errors).toContain(0x501); expect(a.errors).toContain(0x502);
  });

  it("releases failed index transfers, restores bindings and can draw after retry", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,1,0x88e4]);
    send(a,O.OP_BUFFER_SUB_DATA,[0x8893,0,1],new Uint8Array([255]));
    const object = a.buffers.get(71)!;
    const errors: number[] = []; gl.getError = () => errors.shift() ?? 0;
    const read = gl.getBufferSubData.bind(gl); gl.getBufferSubData = () => { errors.push(0x505); };
    send(a,O.OP_DRAW_ELEMENTS,[0,1,0x1401,0]);
    expect(gl.indexDraws).toEqual([]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toHaveLength(1);
    expect(a.vertexArrays.get(0)!.element).toBe(object); expect(a.bufferStores.get(object)!.source).toBe(object);
    expect(gl.getParameter(0x8f36)).toBeNull(); expect(gl.getParameter(0x8f37)).toBeNull();
    gl.getBufferSubData = read; send(a,O.OP_DRAW_ELEMENTS,[0,1,0x1401,0]);
    expect(new Uint16Array(gl.indexDraws[0].data.buffer)).toEqual(new Uint16Array([255]));
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toHaveLength(2);
    expect(a.errors).toContain(0x505);
  });

  it("keeps the original element binding after promotion allocation fails", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,1,0x88e4]);
    const object = a.buffers.get(71)!, calls = gl.log.length;
    gl.createBuffer = () => null as any; send(a,O.OP_DRAW_ELEMENTS,[0,1,0x1401,0]);
    expect(gl.log.length).toBe(calls); expect(gl.indexDraws).toEqual([]);
    expect(a.vertexArrays.get(0)!.element).toBe(object); expect(a.errors).toContain(0x505);
  });

  it("converts signed fixed-point values and keeps the logical normalized format", () => {
    const {gl,a,send} = setup();
    const values = new Int32Array([-32768,98304,16384,65536]);
    const bytes = new Uint8Array(values.buffer), payload = new Uint8Array(bytes.length+4);
    payload.set(bytes); new DataView(payload.buffer).setUint32(bytes.length,0x88e4,true);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,bytes.length],payload);
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,4,0x140c,1,0,0]); send(a,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
    const attribute = a.vertexArrays.get(0)!.attributes.get(0)!;
    send(a,O.OP_DRAW_ARRAYS,[0,0,1]);
    expect([...new Float32Array(gl.bufferContents.get(attribute.view!)!.buffer)]).toEqual([-0.5,1.5,0.25,1]);
    expect(attribute).toMatchObject({type:0x140c,normalized:true,stride:0,offset:0});
    expect(gl.log).toContainEqual(["vertexAttribPointer",[0,4,0x1406,false,0,0]]);
    expect(gl.bufferContents.get(a.buffers.get(71)!)).toEqual(bytes);
    expect(a.errors).toEqual([]);
  });

  it("packs a valid wide float stride without copying padding into the attribute", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,608,0x88e4]);
    for (const [offset,value] of [[4,1.5],[304,-2.5],[604,3.5]]) {
      send(a,O.OP_BUFFER_SUB_DATA,[0x8892,offset,4],new Uint8Array(new Float32Array([value]).buffer));
    }
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,1,0x1406,0,300,4]); send(a,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
    send(a,O.OP_DRAW_ARRAYS,[0,0,3]);
    const attribute = a.vertexArrays.get(0)!.attributes.get(0)!;
    expect([...new Float32Array(gl.bufferContents.get(attribute.view!)!.buffer)]).toEqual([1.5,-2.5,3.5]);
    expect(attribute).toMatchObject({stride:300,offset:4}); expect(a.errors).toEqual([]);
  });

  it("retains converted storage in a disabled unbound peer VAO and releases it after layout replacement", () => {
    const {gl,a,b,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,4,0x140c,0,0,0]);
    const native = a.vertexArrays.get(0)!.attributes.get(0)!.view!;
    send(b,O.OP_BIND_BUFFER,[0x8892,71]); send(b,O.OP_GEN_VERTEX_ARRAYS,[1,31]); send(b,O.OP_BIND_VERTEX_ARRAY,[31]);
    send(b,O.OP_VERTEX_ATTRIB_POINTER,[0,4,0x140c,1,0,0]); send(b,O.OP_BIND_VERTEX_ARRAY,[0]);
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,4,0x1406,0,0,0]);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === native)).toEqual([]);
    expect(a.bufferStores.get(a.buffers.get(71)!)!.converted.size).toBe(1);
    send(b,O.OP_DELETE_VERTEX_ARRAYS,[1,31]);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === native)).toHaveLength(1);
    expect(a.bufferStores.get(a.buffers.get(71)!)!.converted.size).toBe(0);
  });

  it("suppresses a draw after converted-data readback fails and retries without changing raw storage", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,16,0x88e4]);
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,4,0x140c,0,0,0]); send(a,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
    const errors: number[] = []; gl.getError = () => errors.shift() ?? 0;
    const read = gl.getBufferSubData.bind(gl); gl.getBufferSubData = () => { errors.push(0x505); };
    send(a,O.OP_DRAW_ARRAYS,[0,0,1]);
    expect(gl.log.some(([name]) => name === "drawArrays")).toBe(false);
    expect(gl.getParameter(0x8f36)).toBeNull(); expect(gl.getParameter(0x8f37)).toBeNull();
    const store = a.bufferStores.get(a.buffers.get(71)!)!;
    expect([...store.converted.values()][0].valid).toBe(false); expect(store.source).toBe(a.buffers.get(71));
    gl.getBufferSubData = read; send(a,O.OP_DRAW_ARRAYS,[0,0,1]);
    expect(gl.log.filter(([name]) => name === "drawArrays")).toHaveLength(1);
    expect([...store.converted.values()][0].valid).toBe(true);
  });

  it("retains both views through a peer's secondary array binding alone", () => {
    const {gl,a,b,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,4,0x88e4]);
    send(b,O.OP_BIND_BUFFER,[0x8892,71]);
    const object = a.buffers.get(71)!, vertex = b.shadow.arrayBuffer!;
    expect(vertex).not.toBe(object);
    send(a,O.OP_DELETE_BUFFERS,[1,71]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toEqual([]);
    expect(b.shadow.arrayBuffer).toBe(vertex);
    send(b,O.OP_BIND_BUFFER,[0x8892,0]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toEqual([["deleteBuffer",[object]],["deleteBuffer",[vertex]]]);
    expect(b.bufferStores.size).toBe(0); expect(b.bufferViewOwners.size).toBe(0);
  });

  it("accepts an empty partial update using the logical size without synchronizing a stale view", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,4,0x88e4]); send(a,O.OP_BIND_BUFFER,[0x8893,71]);
    send(a,O.OP_BUFFER_DATA,[0x8892,8,0x88e4]);
    const object = a.buffers.get(71)!, store = a.bufferStores.get(object)!;
    const calls = gl.log.length;
    send(a,O.OP_BUFFER_SUB_DATA,[0x8893,8,0]);
    expect(gl.log.length).toBe(calls); expect(a.errors).toEqual([]);
    expect(store.views.get(0x8893)!.valid).toBe(false); expect(store.source).toBe(object);
  });

  it("synchronizes large vertex/index views in bounded chunks and preserves copy bindings", () => {
    const {gl,a,send} = setup();
    const savedRead = gl.createBuffer(), savedWrite = gl.createBuffer();
    gl.bindBuffer(0x8f36,savedRead); gl.bindBuffer(0x8f37,savedWrite);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); const object = a.buffers.get(71)!;
    send(a,O.OP_BUFFER_DATA,[0x8892,131080,0x88e8]);
    send(a,O.OP_BUFFER_SUB_DATA,[0x8892,131076,4],new Uint8Array([1,2,3,4]));
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,1,0x1406,0,0,0]); send(a,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
    send(a,O.OP_BIND_BUFFER,[0x8893,71]);
    const store = a.bufferStores.get(object)!, index = store.views.get(0x8893)!.native;
    expect(index).not.toBe(object);
    expect(gl.bufferContents.get(index)).toEqual(gl.bufferContents.get(object));
    expect(gl.log.filter(([name]) => name === "getBufferSubData")).toEqual([
      ["getBufferSubData",[0x8f36,0,65536]], ["getBufferSubData",[0x8f36,65536,65536]], ["getBufferSubData",[0x8f36,131072,8]]]);
    send(a,O.OP_BUFFER_SUB_DATA,[0x8893,0,1],new Uint8Array([9])); send(a,O.OP_DRAW_ARRAYS,[0,0,1]);
    expect(gl.bufferContents.get(object)![0]).toBe(9);
    expect(store.size).toBe(131080); expect(store.usage).toBe(0x88e8);
    expect(gl.getParameter(0x8f36)).toBe(savedRead); expect(gl.getParameter(0x8f37)).toBe(savedWrite);
    expect(a.errors).toEqual([]);
  });

  it("keeps storage metadata and bytes unchanged after invalid updates", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,4,0x88e4]);
    send(a,O.OP_BUFFER_SUB_DATA,[0x8892,0,4],new Uint8Array([1,2,3,4]));
    const object = a.buffers.get(71)!, store = a.bufferStores.get(object)!;
    const errors: number[] = [];
    gl.getError = () => errors.shift() ?? 0;
    const bufferData = gl.bufferData.bind(gl); gl.bufferData = () => { errors.push(0x500); };
    send(a,O.OP_BUFFER_DATA,[0x8892,8,0]); gl.bufferData = bufferData;
    send(a,O.OP_BUFFER_SUB_DATA,[0x8892,3,2],new Uint8Array([9,9]));
    expect(store.size).toBe(4); expect(store.usage).toBe(0x88e4); expect(store.source).toBe(object);
    expect(gl.bufferContents.get(object)).toEqual(new Uint8Array([1,2,3,4]));
    expect(a.errors).toContain(0x500); expect(a.errors).toContain(0x501);
  });

  it("suppresses a draw after failed synchronization and retries from authoritative storage", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); send(a,O.OP_BUFFER_DATA,[0x8892,1,0x88e4]); send(a,O.OP_BIND_BUFFER,[0x8893,71]);
    send(a,O.OP_BUFFER_SUB_DATA,[0x8892,0,1],new Uint8Array([9]));
    const object = a.buffers.get(71)!, store = a.bufferStores.get(object)!;
    const errors: number[] = [];
    gl.getError = () => errors.shift() ?? 0;
    const read = gl.getBufferSubData.bind(gl); gl.getBufferSubData = () => { errors.push(0x505); };
    send(a,O.OP_DRAW_ELEMENTS,[0,1,0x1401,0]);
    expect(gl.log.some(([name]) => name === "drawElements")).toBe(false);
    expect(store.source).toBe(object); expect(store.views.get(0x8893)!.valid).toBe(false);
    expect(gl.getParameter(0x8f36)).toBeNull(); expect(gl.getParameter(0x8f37)).toBeNull();
    gl.getBufferSubData = read; send(a,O.OP_DRAW_ELEMENTS,[0,1,0x1401,0]);
    expect(gl.bufferContents.get(store.views.get(0x8893)!.native)).toEqual(new Uint8Array([9]));
    expect(gl.log.filter(([name]) => name === "drawElements")).toHaveLength(1);
    expect(a.errors).toContain(0x505);
  });

  it("rolls back failed second-view allocation and deletes both successful views at the final reference", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); send(a,O.OP_BUFFER_DATA,[0x8893,4,0x88e4]);
    const object = a.buffers.get(71)!, store = a.bufferStores.get(object)!;
    const errors: number[] = [];
    gl.getError = () => errors.shift() ?? 0;
    const data = gl.bufferData.bind(gl); gl.bufferData = () => { errors.push(0x505); };
    send(a,O.OP_BIND_BUFFER,[0x8892,71]);
    expect(a.shadow.arrayBuffer).toBeNull(); expect(store.views.size).toBe(1); expect(a.bufferViewOwners.size).toBe(1);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toHaveLength(1);
    gl.bufferData = data; send(a,O.OP_BIND_BUFFER,[0x8892,71]);
    const vertex = store.views.get(0x8892)!.native;
    send(a,O.OP_DELETE_BUFFERS,[1,71]);
    expect(a.bufferStores.size).toBe(0); expect(a.bufferViewOwners.size).toBe(0);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === object)).toHaveLength(1);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === vertex)).toHaveLength(1);
  });

  it("keeps delayed buffer reservations and rejected native binds from replacing references", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[2,71,72]);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); const old = a.buffers.get(71)!;
    send(a,O.OP_GEN_BUFFERS,[1,71]); expect(a.buffers.get(71)).toBe(old);
    expect(a.errors).toEqual([]);
    const errors: number[] = [];
    gl.getError = () => errors.shift() ?? 0;
    gl.bindBuffer = () => { errors.push(0x502); };
    send(a,O.OP_BIND_BUFFER,[0x8892,72]);
    expect(a.shadow.arrayBuffer).toBe(old);
    expect(a.vertexArrays.get(0)!.element).toBeNull();
  });

  it("preserves a peer buffer binding and its old name until rebinding", () => {
    const {gl,a,b,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[1,71]);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); const old = a.buffers.get(71)!; send(b,O.OP_BIND_BUFFER,[0x8892,71]);
    send(a,O.OP_DELETE_BUFFERS,[1,71]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toEqual([]);
    expect(a.shadow.arrayBuffer).toBeNull(); expect(b.shadow.arrayBuffer).toBe(old);
    const input = new Uint8Array(4), out = new Uint8Array(4);
    new DataView(input.buffer).setUint32(0,0x8894,true); gl.getParameter = () => old as any;
    expect(runGlQuery(b,O.QOP_GET_INTEGERV,input,out)).toBe(4);
    expect(new DataView(out.buffer).getUint32(0,true)).toBe(71);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); expect(a.buffers.get(71)).not.toBe(old);
    send(b,O.OP_BIND_BUFFER,[0x8892,0]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toEqual([["deleteBuffer",[old]]]);
  });

  it("retains buffer storage through an unbound VAO until that container ends", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[1,71]);
    send(a,O.OP_GEN_VERTEX_ARRAYS,[1,31]); send(a,O.OP_BIND_VERTEX_ARRAY,[31]);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); const buffer = a.buffers.get(71)!;
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,0,0]);
    send(a,O.OP_BIND_VERTEX_ARRAY,[0]); send(a,O.OP_DELETE_BUFFERS,[1,71]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toEqual([]);
    send(a,O.OP_DELETE_VERTEX_ARRAYS,[1,31]);
    expect(gl.log.filter(([name]) => name === "deleteBuffer")).toEqual([["deleteBuffer",[buffer]]]);
  });

  it("clears only active attribute and element references on deletion", () => {
    const {gl,a,b,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[1,71]);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); const old = a.buffers.get(71)!;
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,8,4]);
    send(a,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
    send(a,O.OP_BIND_BUFFER,[0x8893,71]);
    send(b,O.OP_BIND_BUFFER,[0x8893,71]);
    send(a,O.OP_DELETE_BUFFERS,[1,71]);
    expect(a.vertexArrays.get(0)!.element).toBeNull();
    expect(a.vertexArrays.get(0)!.attributes.get(0)).toEqual({buffer:null,enabled:true,
      size:2,type:0x1406,normalized:false,stride:8,offset:4});
    expect(b.vertexArrays.get(0)!.element).toBe(old);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === old)).toEqual([]);
    expect(gl.log.filter(([name]) => name === "vertexAttribPointer")).toEqual([
      ["vertexAttribPointer",[0,2,0x1406,false,8,4]], ["vertexAttribPointer",[0,2,0x1406,false,8,4]]]);
    send(b,O.OP_BIND_BUFFER,[0x8893,0]);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === old)).toEqual([["deleteBuffer",[old]]]);
  });

  it("preserves accepted pointer state when a later native pointer update fails", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[2,71,72]);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); const old = a.buffers.get(71)!; send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,0,0]);
    send(a,O.OP_BIND_BUFFER,[0x8892,72]);
    const errors: number[] = [];
    gl.getError = () => errors.shift() ?? 0;
    gl.vertexAttribPointer = () => { errors.push(0x501); };
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,5,0x1406,0,0,0]);
    expect(a.vertexArrays.get(0)!.attributes.get(0)!.buffer).toBe(old);
    expect(a.vertexArrays.get(0)!.attributes.get(0)!.size).toBe(2);
    expect(a.errors).toContain(0x501);
  });

  it("keeps names and references intact when buffer-zero clearing cannot allocate", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[1,71]);
    send(a,O.OP_BIND_BUFFER,[0x8892,71]); const old = a.buffers.get(71)!; send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,2,0x1406,0,0,0]);
    gl.createBuffer = () => null as any;
    send(a,O.OP_DELETE_BUFFERS,[1,71]);
    expect(a.buffers.get(71)).toBe(old); expect(a.shadow.arrayBuffer).toBe(old);
    expect(a.vertexArrays.get(0)!.attributes.get(0)!.buffer).toBe(old);
    expect(a.errors).toContain(0x505);
  });

  it("returns to the private default VAO and retains its element binding", () => {
    const {gl,a,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[1,71]);
    send(a,O.OP_BIND_BUFFER,[0x8893,71]); const old = a.buffers.get(71)!;
    send(a,O.OP_GEN_VERTEX_ARRAYS,[1,31]); send(a,O.OP_BIND_VERTEX_ARRAY,[31]);
    expect(a.vertexArrays.get(31)!.element).toBeNull();
    send(a,O.OP_DELETE_VERTEX_ARRAYS,[1,31]);
    expect(a.vertexArrayId).toBe(0); expect(a.shadow.vao).toBeNull();
    expect(a.vertexArrays.get(0)!.element).toBe(old);
    expect(gl.log.at(-1)).toEqual(["bindVertexArray",[a.shadow.defaultVao]]);
    send(a,O.OP_BIND_VERTEX_ARRAY,[31]);
    expect(a.vertexArrayId).toBe(0); expect(a.errors).toContain(0x502);
  });

  it("retires deleted storage on the last owning context's destruction", () => {
    const {gl,reg,a,b,send} = setup();
    send(a,O.OP_GEN_BUFFERS,[1,71]);
    send(b,O.OP_GEN_VERTEX_ARRAYS,[1,31]); send(b,O.OP_BIND_VERTEX_ARRAY,[31]);
    send(b,O.OP_BIND_BUFFER,[0x8893,71]); const old = a.buffers.get(71)!; send(b,O.OP_BIND_VERTEX_ARRAY,[0]);
    send(a,O.OP_DELETE_BUFFERS,[1,71]); reg.destroyContext(7,11);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === old)).toEqual([]);
    reg.destroyContext(7,12);
    expect(gl.log.filter(([name,args]) => name === "deleteBuffer" && args[0] === old)).toEqual([["deleteBuffer",[old]]]);
  });

});

describe("cmdbuf decoder — TLV walker", () => {
  it("rejects a malformed trailing command before changing any GL state", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const before = [...b.shadow.clearColor];
    const command = t.op(O.OP_CLEAR_COLOR, 16);
    for (let i = 0; i < 4; i++) t.view.setFloat32(command.p + i * 4, 1, true);
    t.op(O.OP_CLEAR, 3); // valid header, invalid payload length
    expect(decodeAndDispatch(b, 0, t.p)).toBe(GL_SUBMIT_EINVAL);
    expect(gl.log).toEqual([]);
    expect(b.shadow.clearColor).toEqual(before);
  });

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

    // BufferData payload: u32 target, u32 dataLen=12, 12 bytes data, u32 usage.
    h = t.op(O.OP_BUFFER_DATA, 8 + 12 + 4);
    t.view.setUint32(h.p, 0x8892, true);
    t.view.setUint32(h.p + 4, 12, true);
    for (let i = 0; i < 12; i++) {
      t.view.setUint8(h.p + 8 + i, (i + 1) * 17);
    }
    t.view.setUint32(h.p + 8 + 12, 0x88E4 /* GL_STATIC_DRAW */, true);

    decodeAndDispatch(b, 0, t.p);

    expect(b.buffers.has(42)).toBe(true);
    const bufObj = b.buffers.get(42);
    expect(gl.log[1]).toEqual(["bindBuffer", [0x8892, bufObj]]);
    const data = (gl.log[2][1] as unknown[])[1] as Uint8Array;
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
    seedUniform(b);
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

  it("UniformMatrix3fv reads nine floats per matrix", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    seedUniform(b);
    const mat: number[] = [];
    for (let i = 0; i < 18; i++) mat.push(i * 0.25);

    const t = new Tlv(b.cmdbufView!.buffer);
    const h = t.op(O.OP_UNIFORM_MATRIX3FV, 12 + 18 * 4);
    t.view.setInt32(h.p, 1, true);
    t.view.setUint32(h.p + 4, 2, true);
    t.view.setUint32(h.p + 8, 0, true);
    for (let i = 0; i < 18; i++) {
      t.view.setFloat32(h.p + 12 + i * 4, mat[i], true);
    }

    expect(decodeAndDispatch(b, 0, t.p)).toBe(0);
    const call = gl.log.find((r) => r[0] === "uniformMatrix3fv");
    expect((call![1] as unknown[])[2]).toEqual(mat);
  });

  it("DeleteRenderbuffers deletes and forgets each named renderbuffer", () => {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const t = new Tlv(b.cmdbufView!.buffer);
    const gen = t.op(O.OP_GEN_RENDERBUFFERS, 12);
    t.view.setUint32(gen.p, 2, true);
    t.view.setUint32(gen.p + 4, 5, true);
    t.view.setUint32(gen.p + 8, 6, true);
    for (const name of [5,6]) {
      const bind=t.op(O.OP_BIND_RENDERBUFFER,8);
      t.view.setUint32(bind.p,0x8d41,true);t.view.setUint32(bind.p+4,name,true);
    }
    const del = t.op(O.OP_DELETE_RENDERBUFFERS, 8);
    t.view.setUint32(del.p, 1, true);
    t.view.setUint32(del.p + 4, 5, true);

    const rbo5 = (() => {
      decodeAndDispatch(b, 0, del.p - 4);
      return b.rbos.get(5);
    })();
    expect(decodeAndDispatch(b, del.p - 4, t.p - (del.p - 4))).toBe(0);
    expect(gl.log).toContainEqual(["deleteRenderbuffer", [rbo5]]);
    expect(b.rbos.has(5)).toBe(false);
    expect(b.rbos.has(6)).toBe(true);
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
    seedUniform(b);
    // SDL updates a named texture. Keep this fixture about unaligned
    // record layout rather than lazy creation of GLES texture zero.
    const texture = gl.createTexture() as unknown as WebGLTexture;
    b.textures.set(1,texture); b.shadow.textureUnits[0] = texture;
    gl.bindTexture(0x0de1,texture); gl.log.length = 0;
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

describe("shader/program deferred deletion", () => {
  function setup() {
    const gl = new RecordingGl();
    const { b } = setupBinding(gl);
    const send = (op: number, ...words: number[]) => {
      const tlv = new Tlv(b.cmdbufView!.buffer);
      const record = tlv.op(op, words.length*4);
      words.forEach((word, i) => tlv.view.setUint32(record.p+i*4, word, true));
      expect(decodeAndDispatch(b,0,tlv.p)).toBe(0);
    };
    const query = (op: number, ...words: number[]) => {
      const input = new Uint8Array(words.length*4), output = new Uint8Array(4);
      words.forEach((word, i) => new DataView(input.buffer).setUint32(i*4,word,true));
      expect(runGlQuery(b,op,input,output)).toBe(4);
      return new DataView(output.buffer).getUint32(0,true);
    };
    return { b, gl, send, query };
  }

  it("retains a deleted current program and its shaders until a successful switch", () => {
    const { b, gl, send, query } = setup();
    send(O.OP_CREATE_SHADER, 0x8b31, 11);
    send(O.OP_CREATE_PROGRAM, 12);
    send(O.OP_ATTACH_SHADER,12,11);
    send(O.OP_USE_PROGRAM,12);
    send(O.OP_DELETE_SHADER,11);
    send(O.OP_DELETE_PROGRAM,12);
    expect(b.programs.has(12)).toBe(true);
    expect(b.shaders.has(11)).toBe(true);
    expect(query(O.QOP_GET_INTEGERV,0x8b8d)).toBe(12);
    expect(query(O.QOP_GET_PROGRAMIV,12,0x8b80)).toBe(1); // DELETE_STATUS
    expect(gl.log.filter(([method]) => method === "deleteProgram")).toHaveLength(0);
    const program = b.currentProgram;
    send(O.OP_USE_PROGRAM,999);
    expect(b.currentProgram).toBe(program);
    expect(b.programs.has(12)).toBe(true);
    expect(query(O.QOP_GET_ERROR)).toBe(0x501);
    send(O.OP_USE_PROGRAM,0);
    expect(b.programs.has(12)).toBe(false);
    expect(b.shaders.has(11)).toBe(false);
    expect(gl.log.filter(([method]) => method === "deleteProgram")).toHaveLength(1);
  });

  it("can detach a deleted shader, retaining it until its last program releases it", () => {
    const { b, gl, send } = setup();
    send(O.OP_CREATE_SHADER,0x8b31,11);
    for (const name of [12,13]) {
      send(O.OP_CREATE_PROGRAM,name);
      send(O.OP_ATTACH_SHADER,name,11);
    }
    send(O.OP_DELETE_SHADER,11);
    send(O.OP_DETACH_SHADER,12,11);
    expect(b.shaders.has(11)).toBe(true);
    send(O.OP_DETACH_SHADER,13,11);
    expect(b.shaders.has(11)).toBe(false);
    expect(gl.log.filter(([method]) => method === "detachShader")).toHaveLength(2);
  });

  it("preserves the prior program when the driver rejects a switch", () => {
    const { b, gl, send, query } = setup();
    send(O.OP_CREATE_PROGRAM,12);
    send(O.OP_CREATE_PROGRAM,13);
    send(O.OP_USE_PROGRAM,12);
    send(O.OP_DELETE_PROGRAM,12);
    let pending = 0;
    gl.getError = () => { const error = pending; pending = 0; return error; };
    gl.useProgram = () => { pending = 0x502; };
    send(O.OP_USE_PROGRAM,13);
    expect(b.currentProgram).toBe(b.programs.get(12));
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(query(O.QOP_GET_INTEGERV,0x8b8d)).toBe(12);
    expect(b.programs.has(12)).toBe(true);
  });

  it("does not retain a shader when the driver rejects attachment", () => {
    const { b, gl, send, query } = setup();
    send(O.OP_CREATE_SHADER,0x8b31,11);
    send(O.OP_CREATE_PROGRAM,12);
    let pending=0;
    gl.getError=() => { const error=pending; pending=0; return error; };
    gl.attachShader=() => { pending=0x502; };
    send(O.OP_ATTACH_SHADER,12,11);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    send(O.OP_DELETE_SHADER,11);
    expect(b.shaders.has(11)).toBe(false);
    expect(b.programShaders.get(12)?.size).toBe(0);
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

  it.each([O.QOP_GET_INTEGERV, O.QOP_GET_FLOATV])("query %i returns guest object names instead of native objects", (op) => {
    const { b, gl } = setup();
    const cases: [number, Map<number, any>][] = [
      [0x8894, b.buffers], [0x8895, b.buffers], // array/element buffers
      [0x8069, b.textures], [0x8514, b.textures], // 2D/cube textures
      [0x8ca6, b.fbos], [0x8ca7, b.rbos],
    ];
    for (const [pname, names] of cases) {
      const object = {};
      names.set(73, object);
      gl.getParameter = () => object as any;
      const request = new Uint8Array(4);
      new DataView(request.buffer).setUint32(0, pname, true);
      const reply = new Uint8Array(4);
      expect(runGlQuery(b, op, request, reply)).toBe(4);
      expect(op === O.QOP_GET_FLOATV ? new DataView(reply.buffer).getFloat32(0,true)
        : new DataView(reply.buffer).getInt32(0,true)).toBe(73);
    }
  });

  it.each([O.QOP_GET_INTEGERV, O.QOP_GET_FLOATV])("query %i rejects short vector destinations without partial writes", (op) => {
    const { b, gl } = setup();
    const request = new Uint8Array(4);
    new DataView(request.buffer).setUint32(0, 0x0c22, true); // clear color
    gl.getParameter = () => new Float32Array([0.25,0.5,0.75,1]) as any;
    const reply = new Uint8Array(12).fill(0xa5);
    expect(runGlQuery(b, op, request, reply)).toBe(-22);
    expect([...reply]).toEqual(Array(12).fill(0xa5));
  });

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

  it("does not publish readback bytes after a framebuffer error", () => {
    const { b, gl } = setup();
    let pending = 0;
    gl.getError = () => { const error = pending; pending = 0; return error; };
    gl.readPixels = () => { pending = 0x506; };
    const request = new Uint8Array(24);
    [0,0,1,1,0x1908,0x1401].forEach((word, index) => new DataView(request.buffer).setUint32(index * 4, word, true));
    const reply = new Uint8Array(4).fill(0xa5);
    expect(runGlQuery(b, O.QOP_READ_PIXELS, request, reply)).toBe(-22);
    expect([...reply]).toEqual([0xa5,0xa5,0xa5,0xa5]);
    expect(runGlQuery(b, O.QOP_GET_ERROR, input([]), reply)).toBe(4);
    expect(new DataView(reply.buffer).getUint32(0, true)).toBe(0x506);
  });

  it("merges native and retained error flags before consuming a duplicate", () => {
    const { b, gl } = setup();
    b.errors.push(0x500);
    let pending = 0x500;
    gl.getError = () => { const result = pending; pending = 0; return result; };
    const reply = out(4);
    const next = () => {
      expect(runGlQuery(b, O.QOP_GET_ERROR, input([]), reply)).toBe(4);
      return new DataView(reply.buffer).getUint32(0, true);
    };
    expect(next()).toBe(0x500);
    expect(next()).toBe(0);
  });

  it.each([
    [0x0b21, [1.75], [2]], // LINE_WIDTH: round, do not truncate
    [0x2a00, [-1.75], [-2]], // POLYGON_OFFSET_UNITS
    [0x0c22, [0, 0.25, 0.5, 1], [0, 536870911, 1073741823, 2147483647]],
    [0x0b70, [0, 1], [0, 2147483647]], // DEPTH_RANGE
  ])("integer query converts state %i using GLES rules", (pname, values, expected) => {
    const { b, gl } = setup();
    gl.getParameter = () => new Float32Array(values as number[]) as any;
    const input = new Uint8Array(4), out = new Uint8Array((expected as number[]).length * 4);
    new DataView(input.buffer).setUint32(0, pname as number, true);
    expect(runGlQuery(b, O.QOP_GET_INTEGERV, input, out)).toBe(out.length);
    expect([...new Int32Array(out.buffer)]).toEqual(expected);
  });

  it.each([O.QOP_GET_INTEGERV, O.QOP_GET_FLOATV])("invalid numeric query %i preserves output and the GL error", (op) => {
    const { b, gl } = setup();
    let error = 0;
    gl.getParameter = () => { error = 0x500; return null as any; };
    gl.getError = () => { const result = error; error = 0; return result; };
    const input = new Uint8Array(4), out = new Uint8Array(16).fill(0xa5);
    new DataView(input.buffer).setUint32(0, 0xffffffff, true);
    expect(runGlQuery(b, op, input, out)).toBeLessThan(0);
    expect([...out]).toEqual(new Array(16).fill(0xa5));
    expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), out)).toBe(4);
    expect(new DataView(out.buffer).getUint32(0, true)).toBe(0x500);
  });

  it("QOP_GET_INTEGERV reads a u32 pname and writes an i32", () => {
    const { b } = setup();
    const o = out(4);
    const pname = new Uint8Array(4);
    new DataView(pname.buffer).setUint32(0, 0x0D33 /* MAX_TEXTURE_SIZE */, true);
    expect(runGlQuery(b, O.QOP_GET_INTEGERV, pname, o)).toBe(4);
    expect(new DataView(o.buffer).getInt32(0, true)).toBe(42);
  });

  it("derives GLES compiler and format-count queries without unsupported WebGL enums", () => {
    const { b, gl } = setup();
    const names: number[] = [];
    gl.getParameter = (name: number) => {
      names.push(name);
      expect(name).toBe(0x86a3); // WebGL COMPRESSED_TEXTURE_FORMATS
      return new Uint32Array([0x83f0, 0x83f1]) as any;
    };
    for (const [pname, expected] of [[0x8df9, 0], [0x8dfa, 1], [0x86a2, 2]]) {
      const request = new Uint8Array(4), reply = new Uint8Array(4);
      new DataView(request.buffer).setUint32(0, pname, true);
      expect(runGlQuery(b, O.QOP_GET_INTEGERV, request, reply)).toBe(4);
      expect(new DataView(reply.buffer).getInt32(0, true)).toBe(expected);
    }
    expect(names).toEqual([0x86a3]);
  });

  it("QOP_GET_UNIFORM_LOC reuses live locations and allocates monotonic replacement indices", () => {
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
    expect(idx2).toBe(idx1);

    // Removing the live record must never recycle its published index.
    b.uniformLocations.delete(1);
    const o3 = out(4);
    expect(runGlQuery(b, O.QOP_GET_UNIFORM_LOC, inp, o3)).toBe(4);
    expect(new DataView(o3.buffer).getInt32(0, true)).toBe(2);
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

describe("GLES2 core object queries", () => {
  function setup() {
    const gl = new RecordingGl(), {reg,b} = setupBinding(gl,65540);
    const send = (op: number, words: number[], bytes = new Uint8Array()) => {
      const v = new DataView(b.cmdbufView!.buffer);
      v.setUint16(0,op,true); v.setUint16(2,words.length*4+bytes.length,true);
      words.forEach((word,i) => v.setUint32(4+4*i,word,true)); b.cmdbufView!.set(bytes,4+4*words.length);
      expect(decodeAndDispatch(b,0,4+4*words.length+bytes.length)).toBe(0);
    };
    const query = (op: number, words: number[], size: number) => {
      const input = new Uint8Array(words.length*4), out = new Uint8Array(size+8).fill(0xaa);
      words.forEach((word,i) => new DataView(input.buffer).setUint32(4*i,word,true));
      const rc = runGlQuery(b,op,input,out), view = new DataView(out.buffer);
      if (rc >= 0) expect(view.getUint32(size+4,true)).toBe(0x47514c33);
      return {rc,status:view.getUint32(0,true),bytes:out.subarray(4,size+4)};
    };
    return {gl,reg,b,send,query};
  }
  it("preserves original shader bytes, empty source and deferred deletion", () => {
    const {b,send,query} = setup();
    send(O.OP_CREATE_SHADER,[0x8b31,11]); send(O.OP_CREATE_PROGRAM,[12]); send(O.OP_ATTACH_SHADER,[12,11]);
    const original = new Uint8Array([97,0,98,0xff]); send(O.OP_SHADER_SOURCE,[11,original.length],original);
    const first = query(O.QOP_GET_SHADER_SOURCE,[11,0,4],8);
    expect(first.status).toBe(0); expect([...first.bytes]).toEqual([4,0,0,0,97,0,98,255]);
    send(O.OP_DELETE_SHADER,[11]); expect(b.shaderSources.size).toBe(1);
    expect([...query(O.QOP_GET_SHADER_SOURCE,[11,2,2],6).bytes]).toEqual([4,0,0,0,98,255]);
    send(O.OP_SHADER_SOURCE,[11,0]); expect([...query(O.QOP_GET_SHADER_SOURCE,[11,0,0],4).bytes]).toEqual([0,0,0,0]);
    send(O.OP_DETACH_SHADER,[12,11]); expect(b.shaderSources.size).toBe(0);
    expect(query(O.QOP_GET_SHADER_SOURCE,[11,0,0],4).status).toBe(1); expect(b.errors).toContain(0x501);
  });
  it("returns source chunks larger than a TLV without growing reply capacity", () => {
    const {b,send,query} = setup(); send(O.OP_CREATE_SHADER,[0x8b31,11]);
    const source = Uint8Array.from({length:70000},(_,i) => i%256); b.shaderSources.set(b.shaders.get(11)!,source);
    const first = query(O.QOP_GET_SHADER_SOURCE,[11,0,65524],65528);
    const last = query(O.QOP_GET_SHADER_SOURCE,[11,65524,4476],4480);
    expect(first.rc).toBe(65536); expect(first.bytes.subarray(4)).toEqual(source.subarray(0,65524));
    expect(last.bytes.subarray(4)).toEqual(source.subarray(65524));
    expect(query(O.QOP_GET_SHADER_SOURCE,[11,0,65525],65529).rc).toBe(-22);
  });
  it("queries active attribute metadata and maximum name length without exposing native objects", () => {
    const {gl,b,send,query} = setup(); send(O.OP_CREATE_PROGRAM,[12]);
    Object.assign(gl,{getActiveAttrib: () => ({name:"position",size:1,type:0x8b50})});
    const result = query(O.QOP_GET_ACTIVE_ATTRIB,[12,0,2,3],15);
    expect(result.status).toBe(0); expect([...new Uint32Array(result.bytes.slice(0,12).buffer)]).toEqual([8,1,0x8b50]);
    expect(new TextDecoder().decode(result.bytes.subarray(12))).toBe("sit");
    expect(query(O.QOP_GET_ACTIVE_ATTRIB,[12,1,0,0],12).status).toBe(1); expect(b.errors).toContain(0x501);
    const input = new Uint8Array(new Uint32Array([12,0x8b8a]).buffer), out = new Uint8Array(4);
    expect(runGlQuery(b,O.QOP_GET_PROGRAMIV,input,out)).toBe(4); expect(new DataView(out.buffer).getUint32(0,true)).toBe(9);
  });
  it("retains attached pending-delete shader names until detach", () => {
    const {b,send,query} = setup(); send(O.OP_CREATE_PROGRAM,[12]);
    send(O.OP_CREATE_SHADER,[0x8b31,11]); send(O.OP_CREATE_SHADER,[0x8b30,13]);
    send(O.OP_ATTACH_SHADER,[12,11]); send(O.OP_ATTACH_SHADER,[12,13]); send(O.OP_DELETE_SHADER,[11]);
    expect([...new Uint32Array(query(O.QOP_GET_ATTACHED_SHADERS,[12,1,1],8).bytes.slice().buffer)]).toEqual([2,13]);
    expect(query(O.QOP_GET_ATTACHED_SHADERS,[11,0,0],4).status).toBe(1); expect(b.errors).toContain(0x502);
    send(O.OP_DETACH_SHADER,[12,11]); expect(b.shaders.has(11)).toBe(false);
  });
  it("reports original attachment identities after deletion and name reuse", () => {
    const {b,send,query} = setup();
    send(O.OP_BIND_FRAMEBUFFER,[0x8d40,5]); send(O.OP_BIND_TEXTURE,[0x8513,7]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x8516,7,0]);
    const expected = [0x1702,7,0,0x8516];
    expect([...new Uint32Array(query(O.QOP_GET_FB_ATTACHMENT,[0x8d40,0x8ce0],16).bytes.slice().buffer)]).toEqual(expected);
    send(O.OP_BIND_FRAMEBUFFER,[0x8d40,6]); send(O.OP_DELETE_TEXTURES,[1,7]); send(O.OP_BIND_TEXTURE,[0x0de1,7]);
    send(O.OP_BIND_FRAMEBUFFER,[0x8d40,5]);
    expect([...new Uint32Array(query(O.QOP_GET_FB_ATTACHMENT,[0x8d40,0x8ce0],16).bytes.slice().buffer)]).toEqual(expected);
    send(O.OP_BIND_FRAMEBUFFER,[0x8d40,0]); expect(query(O.QOP_GET_FB_ATTACHMENT,[0x8d40,0x8ce0],16).status).toBe(1);
    expect(b.errors).toContain(0x502);
  });
  it("queries renderbuffer/texture parameters and rejects ES3 enums and missing bindings", () => {
    const {gl,b,send,query} = setup();
    Object.assign(gl,{getRenderbufferParameter: () => 32,getTexParameter: () => 0x2601});
    expect(query(O.QOP_GET_RENDERBUFFER_PARAMETER,[0x8d41,0x8d42],4).status).toBe(1);
    send(O.OP_BIND_RENDERBUFFER,[0x8d41,9]);
    expect(new DataView(query(O.QOP_GET_RENDERBUFFER_PARAMETER,[0x8d41,0x8d42],4).bytes.buffer,4,4).getInt32(0,true)).toBe(32);
    expect(query(O.QOP_GET_TEX_PARAMETER,[0x0de1,0x813c],4).status).toBe(1);
    expect(query(O.QOP_GET_RENDERBUFFER_PARAMETER,[0x8d41,0x8cab],4).status).toBe(1); expect(b.errors).toContain(0x500);
  });
  it("validates only logical programs and preserves native rejection errors", () => {
    const {gl,b,send} = setup(); Object.assign(gl,{validateProgram: (program: unknown) => gl.log.push(["validateProgram",[program]])});
    send(O.OP_CREATE_PROGRAM,[12]); send(O.OP_CREATE_SHADER,[0x8b31,11]);
    send(O.OP_VALIDATE_PROGRAM,[12]); expect(gl.log.filter(([name]) => name === "validateProgram")).toHaveLength(1);
    send(O.OP_VALIDATE_PROGRAM,[11]); send(O.OP_VALIDATE_PROGRAM,[99]); expect(b.errors).toEqual([0x502,0x501]);
  });
  it("does not publish partial data after a native query failure", () => {
    const {gl,b,send,query} = setup(); send(O.OP_CREATE_PROGRAM,[12]);
    const errors: number[] = []; gl.getError = () => errors.shift() ?? 0;
    Object.assign(gl,{getActiveAttrib: () => { errors.push(0x505); return {name:"partial",size:1,type:0x1406}; }});
    const failed = query(O.QOP_GET_ACTIVE_ATTRIB,[12,0,0,8],20);
    expect(failed.status).toBe(1); expect(failed.bytes.every(v => v === 0)).toBe(true); expect(b.errors).toEqual([0x505]);
  });
});
