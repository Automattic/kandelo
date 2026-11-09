import { describe, expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";

class TextureGl {
  active = 0;
  bound = new Map<string, object | null>();
  alive = new Set<object>();
  deleted: object[] = [];
  errors: number[] = [];
  parameters = new Map<object,Map<number,number>>();
  pixels = new Map<object,Uint8Array>();
  failCreate = false;
  rejectUnit = -1;
  parameterCalls = 0;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(pname: number) {
    if (pname === 0x8b4d) return 64;
    if (pname === 0x8069) return this.bound.get(`${this.active}:3553`) ?? null;
    if (pname === 0x8514) return this.bound.get(`${this.active}:34067`) ?? null;
    return 0;
  }
  createTexture() {
    if (this.failCreate) return null;
    const texture = {}; this.alive.add(texture);
    this.parameters.set(texture,new Map([[0x2800,0x2601],[0x2801,0x2702],[0x2802,0x2901],[0x2803,0x2901]]));
    return texture;
  }
  deleteTexture(texture: object) {
    this.alive.delete(texture); this.deleted.push(texture); this.parameters.delete(texture); this.pixels.delete(texture);
    for (const [key,bound] of this.bound) if (bound === texture) this.bound.set(key,null);
  }
  activeTexture(unit: number) { this.active = unit-0x84c0; }
  bindTexture(target: number, texture: object | null) {
    if (texture && this.active === this.rejectUnit) { this.rejectUnit = -1; this.errors.push(0x502); return; }
    this.bound.set(`${this.active}:${target}`,texture);
  }
  texParameteri(target: number, pname: number, value: number) {
    this.parameterCalls++;
    const texture = this.bound.get(`${this.active}:${target}`);
    if (!texture) { this.errors.push(0x502); return; }
    this.parameters.get(texture)!.set(pname,value);
  }
  getTexParameter(target: number, pname: number) {
    const texture = this.bound.get(`${this.active}:${target}`);
    if (!texture) { this.errors.push(0x502); return null; }
    return this.parameters.get(texture)!.get(pname) ?? 0;
  }
  texImage2D(target: number, _level: number, _internal: number, _width: number, _height: number,
      _border: number, _format: number, _type: number, data: Uint8Array | null) {
    const base = target >= 0x8515 && target <= 0x851a ? 0x8513 : target;
    const texture = this.bound.get(`${this.active}:${base}`);
    if (!texture) { this.errors.push(0x502); return; }
    this.pixels.set(texture,data?.slice() ?? new Uint8Array(4));
  }
  generateMipmap(target: number) { if (!this.bound.get(`${this.active}:${target}`)) this.errors.push(0x502); }
  createVertexArray() { return {}; }
  isTexture(texture: object) { return this.alive.has(texture); }
}

function setup() {
  const gl = new TextureGl();
  // These states are irrelevant to this texture model; real browser tests
  // separately execute the complete muxer against native WebGL2 state.
  for (const name of ["bindVertexArray","bindFramebuffer","viewport","enable","disable","scissor","clearColor",
    "clearDepth","clearStencil","lineWidth","depthRange","polygonOffset","sampleCoverage","bindBuffer",
    "bindRenderbuffer","colorMask","depthMask","depthFunc","stencilFuncSeparate","stencilMaskSeparate",
    "stencilOpSeparate","blendColor","blendFuncSeparate","blendEquationSeparate","cullFace","frontFace",
    "useProgram","pixelStorei","deleteVertexArray"]) Object.assign(gl,{[name]: () => {}});
  const native = gl as unknown as WebGL2RenderingContext;
  const reg = new GlContextRegistry();
  const owners = [1,2].map(sessionId => {
    reg.bind({pid:34,sessionId,cmdbufAddr:0,cmdbufLen:4096}); const b = reg.get(34,sessionId)!;
    b.gl = native; b.contextId = sessionId; b.cmdbufView = new Uint8Array(4096); return b;
  });
  const [a,b] = owners;
  expect(reg.shareObjects(34,2,1)).toBe(true);
  const mux = new GlMuxer(native);
  const send = (owner: typeof a, op: number, words: number[], bytes = new Uint8Array()) => {
    mux.switchTo(owner); const v = new DataView(owner.cmdbufView!.buffer);
    v.setUint16(0,op,true); v.setUint16(2,words.length*4+bytes.length,true);
    words.forEach((word,i) => v.setUint32(4+4*i,word,true)); owner.cmdbufView!.set(bytes,4+words.length*4);
    expect(decodeAndDispatch(owner,0,4+words.length*4+bytes.length)).toBe(0);
  };
  const query = (owner: typeof a, target = 0x0de1, pname = 0x2801) => {
    mux.switchTo(owner); const input = new Uint8Array(new Uint32Array([target,pname]).buffer), out = new Uint8Array(12);
    expect(runGlQuery(owner,O.QOP_GET_TEX_PARAMETER,input,out)).toBe(12);
    const v = new DataView(out.buffer); expect(v.getUint32(8,true)).toBe(0x47514c33);
    return {status:v.getUint32(0,true),value:v.getInt32(4,true)};
  };
  return {gl,reg,mux,a,b,send,query};
}

describe("GLES context-owned texture zero", () => {
  it("materializes the initial object on query, once per target and outside the shared namespace", () => {
    const {a,gl,query,send} = setup();
    expect(query(a)).toEqual({status:0,value:0x2702});
    const texture = a.shadow.defaultTextures.get(0x0de1)!;
    expect(a.textures.size).toBe(0); expect(a.shadow.textureUnits.every(value => value === null)).toBe(true);
    expect(gl.alive.size).toBe(1);
    expect(query(a,0x0de1,0x2800)).toEqual({status:0,value:0x2601}); expect(gl.alive.size).toBe(1);
    send(a,O.OP_GEN_TEXTURES,[1,0]); send(a,O.OP_DELETE_TEXTURES,[1,0]);
    expect(gl.alive.has(texture)).toBe(true); expect(a.textures.has(0)).toBe(false);
    expect(query(a,0x8513)).toEqual({status:0,value:0x2702}); expect(gl.alive.size).toBe(2);
  });
  it("makes storage and parameters visible through all zero-bound units, including unselected high units", () => {
    const {gl,a,send,query} = setup();
    send(a,O.OP_TEX_PARAMETERI,[0x0de1,0x2801,0x2600]);
    send(a,O.OP_TEX_IMAGE_2D,[0x0de1,0,0x1908,1,1,0,0x1908,0x1401,4],new Uint8Array([1,2,3,255]));
    const texture = a.shadow.defaultTextures.get(0x0de1)!;
    expect(gl.bound.get("63:3553")).toBe(texture); expect(gl.active).toBe(0);
    send(a,O.OP_ACTIVE_TEXTURE,[0x84c0+63]); expect(query(a)).toEqual({status:0,value:0x2600});
    expect(gl.pixels.get(gl.bound.get("63:3553")!)).toEqual(new Uint8Array([1,2,3,255]));
    send(a,O.OP_GENERATE_MIPMAP,[0x0de1]); expect(a.errors).toEqual([]);
  });
  it("keeps the two default targets and shared-context peers independent through muxer invalidation", () => {
    const {gl,a,b,mux,send,query} = setup();
    send(a,O.OP_TEX_PARAMETERI,[0x0de1,0x2801,0x2600]); send(a,O.OP_TEX_PARAMETERI,[0x8513,0x2801,0x2601]);
    expect(query(b)).toEqual({status:0,value:0x2702}); send(b,O.OP_TEX_PARAMETERI,[0x0de1,0x2801,0x2703]);
    mux.invalidateCurrent(); expect(query(a)).toEqual({status:0,value:0x2600});
    expect(query(a,0x8513)).toEqual({status:0,value:0x2601}); expect(query(b)).toEqual({status:0,value:0x2703});
    expect(a.objects).toBe(b.objects); expect(a.shadow.defaultTextures.get(0x0de1)).not.toBe(b.shadow.defaultTextures.get(0x0de1));
    expect(gl.alive.size).toBe(3);
  });
  it("restores zero objects after named rebinding/deletion without changing named bindings on other units", () => {
    const {gl,a,send,query} = setup();
    send(a,O.OP_BIND_TEXTURE,[0x0de1,7]); const named = a.textures.get(7)!;
    send(a,O.OP_ACTIVE_TEXTURE,[0x84c1]); send(a,O.OP_TEX_PARAMETERI,[0x0de1,0x2801,0x2600]);
    const zero = a.shadow.defaultTextures.get(0x0de1)!;
    expect(gl.bound.get("0:3553")).toBe(named); send(a,O.OP_BIND_TEXTURE,[0x0de1,7]);
    send(a,O.OP_DELETE_TEXTURES,[1,7]); expect(gl.bound.get("0:3553")).toBe(zero); expect(gl.bound.get("1:3553")).toBe(zero);
    expect(query(a)).toEqual({status:0,value:0x2600});
    send(a,O.OP_BIND_TEXTURE,[0x0de1,8]); send(a,O.OP_BIND_TEXTURE,[0x0de1,0]); expect(gl.bound.get("1:3553")).toBe(zero);
  });
  it("rolls back failed allocation/binding and allows retry without running the rejected operation", () => {
    const {gl,a,send,query} = setup();
    gl.failCreate = true; expect(query(a).status).toBe(1); expect(a.errors).toEqual([0x505]);
    gl.failCreate = false; a.errors.length = 0;
    send(a,O.OP_BIND_TEXTURE,[0x0de1,7]); const named = a.textures.get(7)!;
    send(a,O.OP_ACTIVE_TEXTURE,[0x84c1]); gl.rejectUnit = 3;
    send(a,O.OP_TEX_PARAMETERI,[0x0de1,0x2801,0x2600]);
    expect(a.shadow.defaultTextures.size).toBe(0); expect(gl.parameterCalls).toBe(0); expect(gl.alive.size).toBe(1);
    expect(gl.bound.get("0:3553")).toBe(named); expect(gl.bound.get("1:3553")).toBeNull(); expect(gl.active).toBe(1);
    expect(a.errors).toEqual([0x502]); a.errors.length = 0;
    send(a,O.OP_TEX_PARAMETERI,[0x0de1,0x2801,0x2600]); expect(query(a)).toEqual({status:0,value:0x2600}); expect(gl.alive.size).toBe(2);
  });
  it("rejects foreign targets before allocation and retires only the destroyed context's private objects", () => {
    const {gl,reg,mux,a,b,send,query} = setup();
    send(a,O.OP_TEX_PARAMETERI,[0x806f,0x2801,0x2600]); expect(a.errors).toEqual([0x500]); expect(a.shadow.defaultTextures.size).toBe(0);
    send(a,O.OP_TEX_PARAMETERI,[0x0de1,0x813c,1]); expect(gl.parameterCalls).toBe(0); expect(a.shadow.defaultTextures.size).toBe(0);
    expect(query(a,0x0de1,0x813c).status).toBe(1); expect(a.shadow.defaultTextures.size).toBe(0);
    query(a); query(a,0x8513); query(b);
    const peer = b.shadow.defaultTextures.get(0x0de1)!; expect(gl.alive.size).toBe(3);
    mux.invalidateCurrent(); reg.destroyContext(34,1); expect(gl.alive.size).toBe(1); expect(gl.alive.has(peer)).toBe(true);
    mux.invalidateCurrent(); reg.destroyContext(34,2); expect(gl.alive.size).toBe(0); expect(gl.deleted).toHaveLength(3);
  });
});
