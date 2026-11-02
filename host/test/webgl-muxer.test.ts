import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { afterEach, describe, expect, it } from "vitest";
import { knownVertexAttributeLimit } from "../src/webgl/limits.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { NativeGlFault, setNativeGlFaultReporter } from "../src/webgl/native-recovery.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import {
  defaultShadow,
  GL_BLEND,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_FRAMEBUFFER,
  GL_PACK_ALIGNMENT,
  GL_POLYGON_OFFSET_FILL,
  GL_SCISSOR_TEST,
  GL_STENCIL_TEST,
  GL_TEXTURE0,
  GL_TEXTURE_2D,
  GL_UNPACK_ALIGNMENT,
} from "../src/webgl/shadow.js";

class RecordingGl {
  pendingErrors: number[] = [];
  getParameter(pname: number) { return pname === 0x8869 ? 16 : null; }
  getError() { return this.pendingErrors.shift() ?? 0; }
  colorMask(...a: boolean[]) { this.log.push(["colorMask", a]); }
  depthMask(...a: boolean[]) { this.log.push(["depthMask", a]); }
  stencilFuncSeparate(...a: number[]) { this.log.push(["stencilFuncSeparate", a]); }
  stencilMaskSeparate(...a: number[]) { this.log.push(["stencilMaskSeparate", a]); }
  stencilOpSeparate(...a: number[]) { this.log.push(["stencilOpSeparate", a]); }
  blendColor(...a: number[]) { this.log.push(["blendColor", a]); }
  clearDepth(...a: number[]) { this.log.push(["clearDepth", a]); }
  clearStencil(...a: number[]) { this.log.push(["clearStencil", a]); }
  depthRange(...a: number[]) { this.log.push(["depthRange", a]); }
  polygonOffset(...a: number[]) { this.log.push(["polygonOffset", a]); }
  sampleCoverage(...a: unknown[]) { this.log.push(["sampleCoverage", a]); }
  lineWidth(...a: number[]) { this.log.push(["lineWidth", a]); }
  bindBuffer(...a: unknown[]) { this.log.push(["bindBuffer", a]); }
  bindRenderbuffer(...a: unknown[]) { this.log.push(["bindRenderbuffer", a]); }
  vertexAttrib4f(...a: number[]) { this.log.push(["vertexAttrib4f", a]); }
  log: Array<[string, unknown[]]> = [];
  private nextVao = 1;
  createVertexArray() { const vao = { vao: this.nextVao++ }; this.log.push(["createVertexArray", [vao]]); return vao; }
  bindVertexArray(v: unknown) { this.log.push(["bindVertexArray", [v]]); }
  blendEquationSeparate(...a: number[]) { this.log.push(["blendEquationSeparate", a]); }
  bindFramebuffer(t: number, f: unknown) { this.log.push(["bindFramebuffer", [t, f]]); }
  viewport(...a: number[]) { this.log.push(["viewport", a]); }
  scissor(...a: number[]) { this.log.push(["scissor", a]); }
  enable(c: number) { this.log.push(["enable", [c]]); }
  disable(c: number) { this.log.push(["disable", [c]]); }
  clearColor(...a: number[]) { this.log.push(["clearColor", a]); }
  depthFunc(f: number) { this.log.push(["depthFunc", [f]]); }
  blendFuncSeparate(...a: number[]) { this.log.push(["blendFuncSeparate", a]); }
  cullFace(m: number) { this.log.push(["cullFace", [m]]); }
  frontFace(m: number) { this.log.push(["frontFace", [m]]); }
  useProgram(p: unknown) { this.log.push(["useProgram", [p]]); }
  activeTexture(u: number) { this.log.push(["activeTexture", [u]]); }
  bindTexture(t: number, tex: unknown) { this.log.push(["bindTexture", [t, tex]]); }
  pixelStorei(p: number, v: number) { this.log.push(["pixelStorei", [p, v]]); }

  callsOf(name: string): Array<unknown[]> {
    return this.log.filter((r) => r[0] === name).map((r) => r[1]);
  }
}

function newTarget() {
  return { shadow: defaultShadow(), errors: [] as number[] };
}

function mk(): { gl: RecordingGl; mux: GlMuxer } {
  const gl = new RecordingGl();
  const mux = new GlMuxer(gl as unknown as WebGL2RenderingContext);
  return { gl, mux };
}

it("replays renderbuffer aliases from a narrow state owner", () => {
  const { gl, mux } = mk();
  const logical = {}, native = {};
  const direct = newTarget();
  direct.shadow.renderbuffer = logical;
  mux.switchTo(direct);
  expect(gl.callsOf("bindRenderbuffer").at(-1)).toEqual([0x8d41, logical]);

  const aliased = { ...newTarget(), renderbufferViews: new Map([
    [logical, { native, source: null }],
  ]) };
  aliased.shadow.renderbuffer = logical;
  mux.switchTo(aliased);
  expect(gl.callsOf("bindRenderbuffer").at(-1)).toEqual([0x8d41, native]);
});

describe("GlMuxer.switchTo", () => {
  it("keeps native errors with the outgoing owner across a switch", () => {
    const { gl, mux } = mk();
    const a = newTarget(), b = newTarget();
    mux.switchTo(a);
    gl.pendingErrors.push(0x500, 0x501);
    mux.switchTo(b);
    expect(b.errors).toEqual([]);
    expect(gl.getError()).toBe(0);
    expect(a.errors).toEqual([0x500, 0x501]);
  });

  it("captures errors before invalidation loses the owner's identity", () => {
    const { gl, mux } = mk();
    const a = newTarget(), b = newTarget();
    mux.switchTo(a);
    a.errors.push(0x500);
    gl.pendingErrors.push(0x500, 0x502);
    mux.invalidateCurrent();
    mux.switchTo(b);
    expect(a.errors).toEqual([0x500, 0x502]);
    expect(b.errors).toEqual([]);
    expect(gl.getError()).toBe(0);
  });

  it("retains error ownership after a failed drain without blocking cleanup", () => {
    const { gl, mux } = mk();
    const a = newTarget(), b = newTarget();
    mux.switchTo(a);
    const readError = gl.getError.bind(gl);
    gl.getError = () => { throw new Error("renderer failed"); };
    expect(() => mux.invalidateCurrent()).not.toThrow();
    expect(() => mux.switchTo(b)).toThrow("renderer failed");
    gl.pendingErrors.push(0x502);
    gl.getError = readError;
    mux.switchTo(b);
    expect(a.errors).toEqual([0x502]);
    expect(b.errors).toEqual([]);
  });

  it("discards errors from unowned host operations and bounds failed drains", () => {
    const { gl, mux } = mk();
    const a = newTarget(), b = newTarget();
    gl.pendingErrors.push(0x500);
    mux.switchTo(a);
    expect(a.errors).toEqual([]);
    gl.getError = () => 0x502;
    expect(() => mux.switchTo(b)).toThrow("did not clear");
    expect(a.errors).toEqual([0x502]);
    expect(b.errors).toEqual([]);
  });

  it("gives each binding its own default vertex array", () => {
    // Two programs sharing one WebGL context must not share vertex
    // attribute state: GL gives every context its own vertex array 0.
    const { gl, mux } = mk();
    const a = newTarget();
    const b = newTarget();
    mux.switchTo(a);
    mux.switchTo(b);
    mux.switchTo(a);
    const created = gl.callsOf("createVertexArray").map((c) => c[0]);
    expect(created).toHaveLength(2);
    expect(a.shadow.defaultVao).toBe(created[0]);
    expect(b.shadow.defaultVao).toBe(created[1]);
    expect(gl.callsOf("bindVertexArray").map((c) => c[0]))
      .toEqual([created[0], created[1], created[0]]);
  });

  it("binds the program's own vertex array when it has one bound", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    const vao = { app: 1 };
    t.shadow.vao = vao as unknown as WebGLVertexArrayObject;
    mux.switchTo(t);
    expect(gl.callsOf("createVertexArray")).toHaveLength(0);
    expect(gl.callsOf("bindVertexArray")).toEqual([[vao]]);
  });

  it("replays the blend equation", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.blendEquation = { rgb: 0x800a, alpha: 0x8006 };
    mux.switchTo(t);
    expect(gl.callsOf("blendEquationSeparate")).toEqual([[0x800a, 0x8006]]);
  });

  it("replays viewport, clearColor, useProgram from the target shadow", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.viewport = [10, 20, 640, 400];
    t.shadow.clearColor = [0.1, 0.2, 0.3, 0.4];
    const prog = { id: 7 };
    t.shadow.currentProgram = prog as unknown as WebGLProgram;

    mux.switchTo(t);

    expect(gl.callsOf("viewport")).toEqual([[10, 20, 640, 400]]);
    expect(gl.callsOf("clearColor").map((c) => (c as number[]).map((x) => +x.toFixed(3))))
      .toEqual([[0.1, 0.2, 0.3, 0.4]]);
    expect(gl.callsOf("useProgram")).toEqual([[prog]]);
  });

  it("restores a shared draw/read framebuffer with one bind", () => {
    const { gl, mux } = mk();
    const fbo = { id: 13 };
    const t = newTarget();
    t.shadow.fbo = fbo as unknown as WebGLFramebuffer;
    t.shadow.readFbo = t.shadow.fbo;
    mux.switchTo(t);
    expect(gl.callsOf("bindFramebuffer")).toEqual([[GL_FRAMEBUFFER, fbo]]);
  });

  it("restores distinct read and draw framebuffer bindings", () => {
    const { gl, mux } = mk();
    const a = newTarget(), b = newTarget();
    a.shadow.fbo = { draw: 1 } as WebGLFramebuffer;
    a.shadow.readFbo = { read: 1 } as WebGLFramebuffer;
    mux.switchTo(a); mux.switchTo(b); mux.switchTo(a);
    expect(gl.callsOf("bindFramebuffer")).toEqual([
      [GL_FRAMEBUFFER,a.shadow.fbo],[0x8ca8,a.shadow.readFbo],
      [GL_FRAMEBUFFER,null],
      [GL_FRAMEBUFFER,a.shadow.fbo],[0x8ca8,a.shadow.readFbo],
    ]);
  });

  it("scissor enabled → gl.enable; disabled → gl.disable; rect is always replayed", () => {
    const { gl: g1, mux: m1 } = mk();
    const t1 = newTarget();
    t1.shadow.scissor = { enabled: true, rect: [1, 2, 30, 40] };
    m1.switchTo(t1);
    expect(g1.callsOf("enable")).toContainEqual([GL_SCISSOR_TEST]);
    expect(g1.callsOf("scissor")).toEqual([[1, 2, 30, 40]]);

    const { gl: g2, mux: m2 } = mk();
    const t2 = newTarget();
    t2.shadow.scissor = { enabled: false, rect: [5, 6, 7, 8] };
    m2.switchTo(t2);
    expect(g2.callsOf("disable")).toContainEqual([GL_SCISSOR_TEST]);
    expect(g2.callsOf("scissor")).toEqual([[5, 6, 7, 8]]);
  });

  it("emits enable/disable for each cap based on the shadow bit", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.depthTestEnabled = true;
    t.shadow.stencilTestEnabled = false;
    t.shadow.blendEnabled = true;
    t.shadow.cullFaceEnabled = false;
    t.shadow.polygonOffsetFillEnabled = true;
    mux.switchTo(t);
    const enables = gl.callsOf("enable").map((c) => (c as number[])[0]);
    const disables = gl.callsOf("disable").map((c) => (c as number[])[0]);
    expect(enables).toContain(GL_DEPTH_TEST);
    expect(enables).toContain(GL_BLEND);
    expect(enables).toContain(GL_POLYGON_OFFSET_FILL);
    expect(disables).toContain(GL_STENCIL_TEST);
    expect(disables).toContain(GL_CULL_FACE);
  });

  it("blendFuncSeparate uses the shadow's per-channel factors", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.blendFunc = { srcRGB: 0x0302, dstRGB: 0x0303, srcA: 1, dstA: 0 };
    mux.switchTo(t);
    expect(gl.callsOf("blendFuncSeparate")).toEqual([[0x0302, 0x0303, 1, 0]]);
  });

  it("clears unused texture units and ends with shadow.activeTexture", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    const texA = { id: "A" } as unknown as WebGLTexture;
    const texC = { id: "C" } as unknown as WebGLTexture;
    t.shadow.textureUnits[0] = texA;
    t.shadow.textureUnits[2] = texC;
    t.shadow.activeTexture = 5;
    mux.switchTo(t);

    const activeCalls = gl.callsOf("activeTexture").map((c) => (c as number[])[0]);
    expect(activeCalls).toEqual([...Array.from({length: 32}, (_, i) => GL_TEXTURE0 + i), GL_TEXTURE0 + 5]);
    expect(gl.callsOf("bindTexture")).toEqual(t.shadow.textureUnits.flatMap((tex, unit) => [
      // A cube map is a native 2D array texture (cube-storage.ts).
      [GL_TEXTURE_2D, tex], [0x8c1a, t.shadow.cubeTextureUnits[unit]],
    ]));
  });

  it("pixelStorei replays unpack and pack alignment", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    t.shadow.unpackAlignment = 1;
    t.shadow.packAlignment = 8;
    mux.switchTo(t);
    expect(gl.callsOf("pixelStorei")).toEqual([
      [GL_UNPACK_ALIGNMENT, 1],
      [GL_PACK_ALIGNMENT, 8],
      ...t.shadow.pixelStore.entries(),
    ]);
  });

  it("switchTo is a no-op when the target is the current binding", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    mux.switchTo(t);
    const after = gl.log.length;
    expect(after).toBeGreaterThan(0);
    mux.switchTo(t);
    expect(gl.log.length).toBe(after);
  });

  it("switchTo to a different target replays state", () => {
    const { gl, mux } = mk();
    const t1 = newTarget();
    t1.shadow.viewport = [0, 0, 100, 100];
    const t2 = newTarget();
    t2.shadow.viewport = [0, 0, 200, 200];
    mux.switchTo(t1);
    mux.switchTo(t2);
    expect(gl.callsOf("viewport")).toEqual([
      [0, 0, 100, 100],
      [0, 0, 200, 200],
    ]);
  });

  it("invalidateCurrent forces the next switchTo to replay", () => {
    const { gl, mux } = mk();
    const t = newTarget();
    mux.switchTo(t);
    const after = gl.log.length;
    mux.invalidateCurrent();
    mux.switchTo(t);
    // The second replay is the first minus the one-time creation of the
    // binding's default vertex array.
    expect(gl.log.length - after).toBe(after - 1);
  });
  it("restores stencil, masks, clear values and constant attributes across bindings", () => {
    const { gl, mux } = mk();
    const a = newTarget();
    const b = newTarget();
    a.shadow.colorMask = [false, true, false, true];
    a.shadow.clearDepth = 0.25;
    a.shadow.clearStencil = 3;
    a.shadow.stencil.front.writeMask = 0x0f;
    a.shadow.stencil.front.ref = 7;
    a.shadow.vertexAttribValues.set(2, [1, 0.5, 0.25, 1]);
    mux.switchTo(a);
    mux.switchTo(b);
    mux.switchTo(a);
    expect(gl.callsOf("colorMask")).toEqual([a.shadow.colorMask, b.shadow.colorMask, a.shadow.colorMask]);
    expect(gl.callsOf("clearDepth")).toEqual([[0.25], [1], [0.25]]);
    expect(gl.callsOf("clearStencil")).toEqual([[3], [0], [3]]);
    expect(gl.callsOf("stencilMaskSeparate")).toContainEqual([0x0404, 0x0f]);
    expect(gl.callsOf("stencilFuncSeparate")).toContainEqual([0x0404, 0x0207, 7, 0xffffffff]);
    expect(gl.callsOf("vertexAttrib4f").filter(([index])=>index===2)).toEqual([
      [2, 1, 0.5, 0.25, 1], [2, 0, 0, 0, 1], [2, 1, 0.5, 0.25, 1],
    ]);
  });

});

function collectFaults(): Error[] {
  const reported: Error[] = [];
  setNativeGlFaultReporter(fault => reported.push(fault));
  return reported;
}
afterEach(() => setNativeGlFaultReporter(null));
const REFUSED_RESTORE = /live renderer refused to restore native state after a rejected change/;

it("makes a refused framebuffer-binding restoration after a rejected deletion a fatal fault", () => {
  const {gl,mux} = mk(), reg = new GlContextRegistry(), reported = collectFaults();
  reg.bind({pid:1,cmdbufAddr:0,cmdbufLen:0}); const b = reg.get(1)!;
  b.gl = gl as unknown as WebGL2RenderingContext;
  const framebuffer = {};
  b.fbos.set(17,framebuffer); b.shadow.fbo = b.shadow.readFbo = framebuffer;
  mux.switchTo(b);
  let rejected = false;
  const bind = gl.bindFramebuffer.bind(gl);
  gl.bindFramebuffer = (target,value) => {
    if (rejected && value === framebuffer) { gl.pendingErrors.push(0x502); return; }
    bind(target,value);
  };
  Object.assign(gl,{deleteFramebuffer() { rejected = true; gl.pendingErrors.push(0x505); }});
  const out = new Uint8Array(12);
  // The fault is reported, then the query's reply wrapper rethrows it
  // instead of turning it into a failed reply.
  let thrown: unknown;
  try { runGlQuery(b,O.QOP_IMAGE_OBJECT_DELETE,new Uint8Array(new Uint32Array([3,17]).buffer),out); }
  catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(NativeGlFault);
  expect((thrown as Error).message).toMatch(REFUSED_RESTORE);
  expect(reported).toEqual([thrown]);
  expect(b.fbos.get(17)).toBe(framebuffer);
  expect(b.errors).toContain(0x505); expect(b.errors).toContain(0x502);
});

it("makes a refused client-array completion restoration a fatal fault without publishing it", () => {
  const {gl,mux} = mk(), reg = new GlContextRegistry(), reported = collectFaults(); reg.bind({pid:1,cmdbufAddr:0,cmdbufLen:4});
  const b = reg.get(1)!, saved = {}, temporary = {};
  b.gl = gl as unknown as WebGL2RenderingContext; b.shadow.arrayBuffer = temporary;
  b.savedClientArrayBuffer = saved; b.cmdbufView = new Uint8Array(new Uint16Array([O.OP_END_CLIENT_ARRAY,0]).buffer);
  mux.switchTo(b);
  const bind = gl.bindBuffer.bind(gl);
  gl.bindBuffer = (...args) => {if(args[0]===0x8892 && args[1]===saved){gl.pendingErrors.push(0x502);return;}bind(...args);};
  let thrown: unknown;
  try { decodeAndDispatch(b,0,4); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(NativeGlFault);
  expect((thrown as Error).message).toMatch(REFUSED_RESTORE);
  expect(reported.length).toBeGreaterThan(0); expect(reported.at(-1)).toBe(thrown);
  // The refused completion is never published as logical state.
  expect(b.shadow.arrayBuffer).toBe(temporary); expect(b.savedClientArrayBuffer).toBe(saved);
});

it("revokes the outgoing owner before any prefix of a full peer replay can throw",()=>{
  const {gl,mux}=mk(),a=newTarget(),b=newTarget();a.shadow.fbo={};b.shadow.fbo={};
  mux.switchTo(a);const program=gl.useProgram;
  gl.useProgram=()=>{throw Error("peer replay refused after selector writes");};
  expect(()=>mux.switchTo(b)).toThrow("peer replay refused");
  gl.useProgram=program;const before=gl.callsOf("bindVertexArray").length;
  mux.switchTo(a);expect(gl.callsOf("bindVertexArray")).toHaveLength(before+1);
  expect(gl.callsOf("bindFramebuffer").at(-2)).toEqual([GL_FRAMEBUFFER,a.shadow.fbo]);
});

function constantState() {
  const {gl,mux}=mk(),values=new Map<number,number[]>();
  gl.vertexAttrib4f=(index,...value)=>{values.set(index,value);gl.log.push(["vertexAttrib4f",[index,...value]]);};
  Object.assign(gl,{getParameter:(p:number)=>p===0x8869?16:null});
  return {gl,mux,values};
}

it("clears a previous owner's constants after full invalidation loses its identity",()=>{
  const {gl,mux,values}=constantState(),a=newTarget(),b=newTarget();
  a.shadow.vertexAttribValues.set(6,[1,2,3,4]);mux.switchTo(a);
  mux.invalidateCurrent();a.shadow.vertexAttribValues.clear();mux.switchTo(b);
  expect(values.get(6)).toEqual([0,0,0,1]);
  expect(gl.callsOf("vertexAttrib4f").at(-1)).toEqual([6,0,0,0,1]);
});

it("retains constant indices introduced by guest commands before selected-owner retirement",()=>{
  const {gl,mux,values}=constantState(),reg=new GlContextRegistry();
  reg.bind({pid:1,cmdbufAddr:0,cmdbufLen:24});const a=reg.get(1)!;a.gl=gl as unknown as WebGL2RenderingContext;
  mux.switchTo(a);
  const bytes=new Uint8Array(24),v=new DataView(bytes.buffer);
  v.setUint16(0,O.OP_VERTEX_ATTRIB_4FV,true);v.setUint16(2,20,true);v.setUint32(4,9,true);
  [2,3,4,5].forEach((value,i)=>v.setFloat32(8+i*4,value,true));a.cmdbufView=bytes;
  expect(decodeAndDispatch(a,0,24)).toBe(0);expect(values.get(9)).toEqual([2,3,4,5]);
  expect(mux.prepareRetirement()).toBe(true);a.shadow.vertexAttribValues.clear();mux.switchTo(newTarget());
  expect(values.get(9)).toEqual([0,0,0,1]);
});

it.each(["during constants","after constants"]as const)("retains incoming constant indices across a failed replay %s",failure=>{
  const {gl,mux,values}=constantState(),a=newTarget(),b=newTarget(),c=newTarget();
  a.shadow.vertexAttribValues.set(2,[1,1,1,1]);b.shadow.vertexAttribValues.set(11,[2,2,2,2]);mux.switchTo(a);
  const attribute=gl.vertexAttrib4f.bind(gl),active=gl.activeTexture.bind(gl);let reject=true;
  gl.vertexAttrib4f=(index,...value)=>{attribute(index,...value);if(reject&&index===11&&failure==="during constants")throw Error("accepted attribute then throw");};
  gl.activeTexture=(unit)=>{if(reject&&failure==="after constants")throw Error("texture replay refused");active(unit);};
  expect(()=>mux.switchTo(b)).toThrow();reject=false;
  // Neither former binding remains necessary to identify the native prefix.
  a.shadow.vertexAttribValues.clear();b.shadow.vertexAttribValues.clear();mux.switchTo(c);
  expect(values.get(2)).toEqual([0,0,0,1]);expect(values.get(11)).toEqual([0,0,0,1]);
});

it("queries no native vertex limit while no constant-attribute index has been touched",()=>{
  const {gl,mux}=mk();let reads=0;gl.getParameter=()=>{reads++;return 16;};
  mux.switchTo(newTarget());mux.invalidateCurrent();mux.switchTo(newTarget());
  expect(reads).toBe(0);expect(gl.callsOf("vertexAttrib4f")).toEqual([]);
});

it("bounds a guest-sized constant index by the accepted native limit without retaining a sparse key set",()=>{
  const {gl,mux,values}=constantState(),a=newTarget();let reads=0;
  gl.getParameter=()=>{reads++;return 8;};
  a.shadow.vertexAttribValues.set(0xffff_ffff,[9,9,9,9]);a.shadow.vertexAttribValues.set(3,[1,2,3,4]);
  mux.switchTo(a);expect(values.get(3)).toEqual([1,2,3,4]);expect(values.has(0xffff_ffff)).toBe(false);
  mux.invalidateCurrent();a.shadow.vertexAttribValues.clear();mux.switchTo(newTarget());
  expect(values.get(3)).toEqual([0,0,0,1]);expect(reads).toBe(1);
  expect(gl.callsOf("vertexAttrib4f")).toHaveLength(16);
  expect(gl.callsOf("vertexAttrib4f").every(([index])=>Number(index)>=0&&Number(index)<8)).toBe(true);
});

it.each(["native rejection","invalid value"]as const)("admits no cached vertex limit after %s and retries the exact native query",failure=>{
  const {gl,mux,values}=constantState(),a=newTarget(),b=newTarget(),c=newTarget();let reads=0,reject=true;
  gl.getParameter=()=>{reads++;if(reject){if(failure==="native rejection")gl.pendingErrors.push(0x505);return failure==="invalid value"?0:16;}return 8;};
  mux.switchTo(a);gl.pendingErrors.push(0x501);b.shadow.vertexAttribValues.set(11,[2,2,2,2]);
  const before=gl.callsOf("bindVertexArray").length;
  expect(()=>mux.switchTo(b)).toThrow("vertex attribute limit is unavailable");
  expect(knownVertexAttributeLimit(gl as unknown as WebGL2RenderingContext)).toBe(0);
  expect(Reflect.get(mux,"current")).toBeNull();expect(gl.callsOf("bindVertexArray")).toHaveLength(before);
  expect(a.errors).toEqual([0x501]);expect(b.errors).toEqual([]);expect(values.size).toBe(0);
  reject=false;mux.switchTo(c);expect(reads).toBe(2);
  expect(knownVertexAttributeLimit(gl as unknown as WebGL2RenderingContext)).toBe(8);
  expect([...values.keys()]).toEqual([0,1,2,3,4,5,6,7]);
});

it("retains constant clearing coverage even when invalidation cannot capture the old owner's flags",()=>{
  const {gl,mux,values}=constantState(),a=newTarget(),b=newTarget();a.shadow.vertexAttribValues.set(5,[2,3,4,5]);
  mux.switchTo(a);gl.pendingErrors.push(0x501);const get=gl.getError;gl.getError=()=>{throw Error("capture refused");};
  mux.invalidateCurrent();expect(()=>mux.switchTo(b)).toThrow("capture refused");
  gl.getError=get;mux.switchTo(b);expect(a.errors).toEqual([0x501]);expect(b.errors).toEqual([]);
  expect(values.get(5)).toEqual([0,0,0,1]);
});
