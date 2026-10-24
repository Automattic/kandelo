import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";

class ImageGl {
  errors: number[] = [];
  alive = new Set<object>();
  deleted: object[] = [];
  types = new Map<object,number>();
  bindings = new Map<number,object|null>();
  failCreate = false;
  failBind = false;
  creates = 0;
  getError() { return this.errors.shift() ?? 0; }
  createTexture() { return this.create(); }
  createRenderbuffer() { return this.create(); }
  create() { if (this.failCreate) return null; const value={}; this.alive.add(value); this.creates++; return value; }
  deleteTexture(value:object) { this.alive.delete(value); this.deleted.push(value); }
  deleteRenderbuffer(value:object) { this.deleteTexture(value); }
  bindTexture(target:number,value:object|null) { this.bind(target,value); }
  bindRenderbuffer(target:number,value:object|null) { this.bind(target,value); }
  bind(target:number,value:object|null) {
    if (this.failBind || (value && this.types.has(value) && this.types.get(value)!==target)) {
      this.errors.push(0x502); return;
    }
    if(value)this.types.set(value,target);
    this.bindings.set(target,value);
  }
}
function setup() {
  const reg=new GlContextRegistry(); reg.bind({pid:1,cmdbufAddr:0,cmdbufLen:64});
  const b=reg.get(1)!,gl=new ImageGl();b.gl=gl as unknown as WebGL2RenderingContext;b.cmdbufView=new Uint8Array(64);
  const query=(kind:number,target:number,name:number)=>{
    const input=new Uint8Array(new Uint32Array([kind,target,name]).buffer),out=new Uint8Array(12);
    expect(runGlQuery(b,O.QOP_BIND_IMAGE_OBJECT,input,out)).toBe(12);
    const words=new Uint32Array(out.buffer);expect(words[2]).toBe(0x47514c33);
    return [...words.slice(0,2)];
  };
  return {b,gl,query};
}
for(const [kind,target] of [[1,0x0de1],[2,0x8d41]]) {
  const label=kind===1?"texture":"renderbuffer";
  it(`acknowledges ${label} realization and zero binding without reallocating existing names`,()=>{
    const {b,gl,query}=setup(), names=kind===1?b.textures:b.rbos;
    expect(query(kind,target,17)).toEqual([0,1]);const old=names.get(17)!;
    expect(gl.bindings.get(target)).toBe(old);expect(query(kind,target,17)).toEqual([0,1]);expect(gl.creates).toBe(1);
    expect(query(kind,target,0)).toEqual([0,1]);expect(gl.bindings.get(target)).toBeNull();expect(names.get(17)).toBe(old);
    expect(kind===1?b.shadow.textureUnits[0]:b.shadow.renderbuffer).toBeNull();
    expect(query(kind,0xdead,19)).toEqual([1,0]);expect(names.has(19)).toBe(false);expect(b.errors).toEqual([0x500]);
  });
  it(`preserves the old ${label} through allocation rejection and accepts retry`,()=>{
    const {b,gl,query}=setup(),names=kind===1?b.textures:b.rbos;
    expect(query(kind,target,17)).toEqual([0,1]);const old=names.get(17)!;
    gl.failCreate=true;expect(query(kind,target,18)).toEqual([1,0]);
    expect(names.has(18)).toBe(false);expect(gl.bindings.get(target)).toBe(old);
    expect(kind===1?b.shadow.textureUnits[0]:b.shadow.renderbuffer).toBe(old);expect(b.errors).toEqual([0x505]);
    gl.failCreate=false;expect(query(kind,target,18)).toEqual([0,1]);expect(names.get(18)).not.toBe(old);
  });
  it(`releases a failed ${label} bind candidate without publishing its name`,()=>{
    const {b,gl,query}=setup(),names=kind===1?b.textures:b.rbos;
    expect(query(kind,target,17)).toEqual([0,1]);const old=names.get(17)!;
    gl.failBind=true;expect(query(kind,target,18)).toEqual([1,0]);
    expect(names.has(18)).toBe(false);expect(gl.bindings.get(target)).toBe(old);expect(gl.deleted).toHaveLength(1);
    expect(gl.alive.size).toBe(1);expect(b.errors).toEqual([0x502]);
    gl.failBind=false;expect(query(kind,kind===1?0x8513:target,18)).toEqual([0,1]);
    expect(gl.alive.size).toBe(2);
  });
  it(`reserves ${label} namespace storage before changing native binding`,()=>{
    const {b,gl,query}=setup(),names=kind===1?b.textures:b.rbos;
    expect(query(kind,target,17)).toEqual([0,1]);const old=names.get(17)!,set=names.set;
    names.set=()=>{throw new RangeError("allocation failed");};
    try {expect(query(kind,target,18)).toEqual([1,0]);}finally{names.set=set;}
    expect(gl.bindings.get(target)).toBe(old);expect(names.has(18)).toBe(false);expect(gl.alive.size).toBe(1);
    expect(gl.deleted).toHaveLength(1);expect(b.errors).toEqual([0x505]);
  });
  it(`retires the last old ${label} reference when an acknowledged bind replaces it`,()=>{
    const {b,gl,query}=setup(),names=kind===1?b.textures:b.rbos;
    expect(query(kind,target,17)).toEqual([0,1]);const old=names.get(17)!;
    names.delete(17);
    if(kind===1)b.retiredTextures.set(old,17);else b.retiredRenderbuffers.set(old,17);
    expect(query(kind,target,18)).toEqual([0,1]);expect(gl.alive.has(old)).toBe(false);
    expect(gl.deleted).toEqual([old]);expect(kind===1?b.retiredTextures.size:b.retiredRenderbuffers.size).toBe(0);
  });
  it(`keeps queued ${label} binds on the same checked realization path`,()=>{
    const {b,gl,query}=setup(),names=kind===1?b.textures:b.rbos;
    query(kind,target,17);const old=names.get(17)!;gl.failBind=true;
    const view=new DataView(b.cmdbufView!.buffer);view.setUint16(0,kind===1?O.OP_BIND_TEXTURE:O.OP_BIND_RENDERBUFFER,true);
    view.setUint16(2,8,true);view.setUint32(4,target,true);view.setUint32(8,18,true);
    expect(decodeAndDispatch(b,0,12)).toBe(0);expect(names.has(18)).toBe(false);expect(gl.bindings.get(target)).toBe(old);
    expect(kind===1?b.shadow.textureUnits[0]:b.shadow.renderbuffer).toBe(old);expect(gl.deleted).toHaveLength(1);
  });
}
it("rejects cross-target texture reuse without losing the old binding or consuming pending errors",()=>{
  const {b,gl,query}=setup();query(1,0x0de1,17);query(1,0x8513,18);
  const cube=b.textures.get(18)!;b.errors.push(0x501);
  expect(query(1,0x8513,17)).toEqual([1,0]);expect(b.shadow.cubeTextureUnits[0]).toBe(cube);
  expect(gl.bindings.get(0x8513)).toBe(cube);expect(gl.deleted).toEqual([]);expect(b.errors).toEqual([0x501,0x502]);
});
it("validates complete binding request/reply spans before any native mutation",()=>{
  const {b,gl,query}=setup();
  for(const [inputSize,outputSize] of [[0,12],[8,12],[16,12],[12,0],[12,8],[12,16]]) {
    const out=new Uint8Array(outputSize).fill(0xa5);
    expect(runGlQuery(b,O.QOP_BIND_IMAGE_OBJECT,new Uint8Array(inputSize),out)).toBe(-22);
    expect([...out]).toEqual(Array(outputSize).fill(0xa5));
  }
  expect(gl.creates).toBe(0);expect(query(99,0x0de1,17)).toEqual([1,0]);expect(gl.creates).toBe(0);
});
