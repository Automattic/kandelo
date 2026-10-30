import { expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";

function fixture() {
  let serial=0;
  const live=new Set<object>(),deleted:object[]=[],errors:number[]=[];
  const make=()=>{const object={id:++serial};live.add(object);return object;};
  const remove=(object:object)=>{live.delete(object);deleted.push(object);};
  let installed:WebGLProgram|null=null;
  const gl=new Proxy({
    getError:()=>errors.shift()??0,getParameter:(p:number)=>p===0x8b8d?installed:null,isContextLost:()=>false,
    createTexture:make,deleteTexture:remove,createVertexArray:make,deleteVertexArray:remove,
    createProgram:make,deleteProgram:remove,createShader:make,deleteShader:remove,
    useProgram(program:WebGLProgram|null){installed=program;},
  },{get(target,key){return Reflect.get(target,key)??(()=>null);}}) as unknown as WebGL2RenderingContext;
  const reg=new GlContextRegistry();reg.bind({pid:7,sessionId:11,cmdbufAddr:256,cmdbufLen:40});
  const binding=reg.get(7,11)!;binding.gl=gl;binding.contextId=1;
  const memory=new WebAssembly.Memory({initial:1,maximum:1});binding.cmdbufView=new Uint8Array(memory.buffer,256,40);
  const texture=gl.createTexture()!;binding.textures.set(1,texture);
  const muxer=new GlMuxer(gl);
  const retain=()=>Reflect.get(reg,"retainContextExecution")?.call(reg,7,11,muxer) as ReturnType<GlContextRegistry["retainContextExecution"]>|undefined;
  return {reg,binding,memory,gl,texture,muxer,live,deleted,errors,retain};
}
it("revokes public context lookup without deleting a retained execution owner",()=>{
  const f=fixture(),lease=f.retain();
  f.reg.destroyContext(7,11);
  expect(f.live.has(f.texture)).toBe(true);expect(lease).toBeTruthy();
  expect(f.reg.getContext(7,1)).toBeUndefined();
  expect(f.reg.get(7,11)).not.toBe(f.binding);expect(f.reg.get(7,11)!.contextId).toBeNull();
  expect(f.binding.cmdbufView).toBeNull();expect(lease!.binding).toBe(f.binding);expect(f.binding.gl).toBe(f.gl);
  expect(lease!.release()).toBe(true);expect(f.live.has(f.texture)).toBe(false);
  expect(lease!.release()).toBe(true);expect(f.deleted.filter(x=>x===f.texture)).toHaveLength(1);
  f.reg.unbind(7);
});
it("reuses a public session with fresh state while old execution retains native identity",()=>{
  const f=fixture(),lease=f.retain();f.reg.destroyContext(7,11);
  expect(f.live.has(f.texture)).toBe(true);expect(lease).toBeTruthy();
  const replacement=f.reg.get(7,11)!;replacement.gl=f.gl;replacement.contextId=2;
  const fresh=f.gl.createTexture()!;replacement.textures.set(1,fresh);
  expect(lease!.binding.textures.get(1)).toBe(f.texture);expect(replacement.objects).not.toBe(f.binding.objects);
  expect(replacement.fences).toBe(f.binding.fences);expect(replacement.cmdbufAddr).toBe(256);
  expect(replacement.cmdbufView).toBeNull();
  f.muxer.switchTo(replacement);f.errors.push(0x500);
  expect(lease!.release()).toBe(true);
  expect(replacement.errors).toEqual([0x500]);expect(f.live.has(fresh)).toBe(true);expect(f.live.has(f.texture)).toBe(false);
  expect(f.reg.getContext(7,2)).toBe(replacement);
  f.muxer.invalidateCurrent();f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("retains execution after final session removal without retaining its guest view",()=>{
  const f=fixture(),lease=f.retain();f.reg.unbind(7);
  expect(f.live.has(f.texture)).toBe(true);expect(lease).toBeTruthy();
  expect(f.reg.list()).toEqual([]);expect(f.binding.cmdbufView).toBeNull();
  expect(lease!.binding.gl).toBe(f.gl);expect(lease!.release()).toBe(true);
  expect(f.live.size).toBe(0);
});

it("clones retained execution after public revocation without granting a new lookup",()=>{
  const f=fixture(),first=f.retain()!;f.reg.destroyContext(7,11);
  const second=first.clone()!;expect(second).not.toBeNull();
  expect(f.retain()).toBeNull();expect(first.release()).toBe(true);expect(f.live.has(f.texture)).toBe(true);
  expect(first.clone()).toBeNull();expect(()=>first.binding).toThrow("released");
  expect(second.release()).toBe(true);expect(f.live.has(f.texture)).toBe(false);
  f.reg.unbind(7);
});
it("does not replace a public slot after its execution reference already ended",()=>{
  const f=fixture(),lease=f.retain()!;expect(lease.release()).toBe(true);
  f.reg.destroyContext(7,11);expect(f.reg.get(7,11)).toBe(f.binding);
  expect(f.binding.gl).toBeNull();expect(f.live.size).toBe(0);f.reg.unbind(7);
});
it("rejects wrong process, session, renderer or absent context without consuming ownership",()=>{
  const f=fixture(),other=new GlMuxer({} as WebGL2RenderingContext);
  expect(f.reg.retainContextExecution(8,11,f.muxer)).toBeNull();
  expect(f.reg.retainContextExecution(7,12,f.muxer)).toBeNull();
  expect(f.reg.retainContextExecution(7,11,other)).toBeNull();
  f.binding.contextId=null;expect(f.retain()).toBeNull();f.binding.contextId=1;
  expect(f.reg.getContext(7,1)).toBe(f.binding);expect(f.deleted).toEqual([]);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("leaves the public owner usable after replacement-slot allocation fails",()=>{
  const f=fixture(),create=vi.spyOn(f.reg as any,"newBinding").mockImplementation(()=>{throw new RangeError("slot allocation failed");});
  expect(f.retain()).toBeNull();expect(f.reg.getContext(7,1)).toBe(f.binding);expect(f.deleted).toEqual([]);
  expect(f.binding.cmdbufView!.buffer).toBe(f.memory.buffer);
  create.mockRestore();const lease=f.retain()!;expect(lease).not.toBeNull();
  f.reg.destroyContext(7,11);expect(lease.release()).toBe(true);f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("retains cleanup when selected-peer error capture fails and retries only its renderer",()=>{
  const f=fixture(),lease=f.retain()!;f.reg.destroyContext(7,11);
  const peer=f.reg.get(7,11)!;peer.gl=f.gl;peer.contextId=2;f.muxer.switchTo(peer);f.errors.push(0x500);
  const read=vi.spyOn(f.gl,"getError").mockImplementation(()=>{throw new Error("error read failed");});
  expect(lease.release()).toBe(false);expect(f.live.has(f.texture)).toBe(true);
  expect(lease.context).toBe(f.gl);expect(lease.clone()).toBeNull();expect(()=>lease.binding).toThrow("released");
  expect(f.reg.retryExecutionRetirements({} as WebGL2RenderingContext)).toBe(true);
  expect(f.reg.retryExecutionRetirements(f.gl)).toBe(false);expect(f.deleted).toEqual([]);
  read.mockRestore();expect(f.reg.retryExecutionRetirements(f.gl)).toBe(true);
  expect(peer.errors).toEqual([0x500]);expect(lease.release()).toBe(true);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("does not replay accepted image cleanup while a local-container deletion rejects",()=>{
  const f=fixture(),vao=f.gl.createVertexArray()!;f.binding.vaos.set(9,vao);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const destroy=f.gl.deleteVertexArray.bind(f.gl);let reject=true;
  f.gl.deleteVertexArray=value=>{if(value===vao && reject)throw new Error("VAO retirement rejected");destroy(value);};
  expect(lease.release()).toBe(false);expect(f.live.has(f.texture)).toBe(false);expect(f.live.has(vao)).toBe(true);
  expect(f.reg.retryExecutionRetirements(f.gl)).toBe(false);
  expect(f.deleted.filter(value=>value===f.texture)).toHaveLength(1);
  reject=false;expect(lease.release()).toBe(true);expect(f.deleted.filter(value=>value===vao)).toHaveLength(1);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("retains rejected image ownership after an accepted prefix and collects it on retry",()=>{
  const f=fixture(),second=f.gl.createTexture()!;f.binding.textures.set(2,second);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const destroy=f.gl.deleteTexture.bind(f.gl);let reject=true;
  f.gl.deleteTexture=value=>{if(value===second && reject)throw new Error("texture retirement rejected");destroy(value);};
  expect(lease.release()).toBe(false);expect(f.live.has(f.texture)).toBe(false);expect(f.live.has(second)).toBe(true);
  expect(f.binding.textures.get(2)).toBe(second);expect(f.binding.cmdbufView).toBeNull();
  expect(f.reg.retryExecutionRetirements(f.gl)).toBe(false);
  expect(f.deleted.filter(value=>value===f.texture)).toHaveLength(1);
  reject=false;expect(lease.release()).toBe(true);
  expect(f.deleted.filter(value=>value===second)).toHaveLength(1);f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("releases a completed retry token without touching the newly selected owner",()=>{
  const f=fixture(),vao=f.gl.createVertexArray()!;f.binding.vaos.set(9,vao);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const destroy=f.gl.deleteVertexArray.bind(f.gl);let reject=true;
  f.gl.deleteVertexArray=value=>{if(value===vao && reject)throw new Error("VAO retirement rejected");destroy(value);};
  expect(lease.release()).toBe(false);reject=false;
  expect(f.reg.retryExecutionRetirements(f.gl)).toBe(true);
  const peer=f.reg.get(7,11)!;peer.gl=f.gl;peer.contextId=2;f.muxer.switchTo(peer);
  const read=vi.spyOn(f.gl,"getError").mockImplementation(()=>{throw new Error("peer error read failed");});
  try {expect(lease.release()).toBe(true);expect(read).not.toHaveBeenCalled();}
  finally {read.mockRestore();f.muxer.invalidateCurrent();f.reg.unbind(7);}
  expect(f.deleted.filter(value=>value===vao)).toHaveLength(1);expect(f.live.size).toBe(0);
});
it("keeps a retained executable until a failed unbind can be acknowledged",()=>{
  const f=fixture(),program=f.gl.createProgram()!;f.binding.currentProgram=program;f.binding.shadow.currentProgram=program;
  f.gl.useProgram(program);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const use=f.gl.useProgram.bind(f.gl);let reject=true;
  f.gl.useProgram=value=>{if(value===null && reject)throw new Error("program unbind rejected");use(value);};
  expect(lease.release()).toBe(false);expect(f.live.has(program)).toBe(true);
  reject=false;expect(lease.release()).toBe(true);expect(f.gl.getParameter(0x8b8d)).toBeNull();
  expect(f.deleted.filter(value=>value===program)).toHaveLength(1);f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("preserves shared group objects through retirement of one retained execution",()=>{
  const f=fixture();f.reg.bind({pid:7,sessionId:12,cmdbufAddr:512,cmdbufLen:40});
  const peer=f.reg.get(7,12)!;peer.gl=f.gl;peer.contextId=2;
  expect(f.reg.shareObjects(7,12,11)).toBe(true);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const next=f.reg.get(7,11)!;next.gl=f.gl;next.contextId=3;
  expect(f.reg.shareObjects(7,11,12)).toBe(true);
  expect(lease.release()).toBe(true);expect(f.live.has(f.texture)).toBe(true);
  expect(peer.textures.get(1)).toBe(f.texture);expect(next.textures.get(1)).toBe(f.texture);
  f.reg.unbind(7);expect(f.deleted.filter(value=>value===f.texture)).toHaveLength(1);expect(f.live.size).toBe(0);
});
it("keeps multiple retired executions disjoint from the newest session occupant",()=>{
  const f=fixture(),first=f.retain()!;f.reg.destroyContext(7,11);
  const middle=f.reg.get(7,11)!;middle.gl=f.gl;middle.contextId=2;
  const old=f.gl.createTexture()!;middle.textures.set(1,old);
  const second=f.retain()!;f.reg.destroyContext(7,11);
  const newest=f.reg.get(7,11)!;newest.gl=f.gl;newest.contextId=3;
  const current=f.gl.createTexture()!;newest.textures.set(1,current);
  expect(second.release()).toBe(true);expect(f.live.has(old)).toBe(false);expect(f.live.has(f.texture)).toBe(true);
  f.muxer.switchTo(newest);expect(first.release()).toBe(true);
  expect(f.live.has(current)).toBe(true);expect(f.reg.getContext(7,3)).toBe(newest);
  f.muxer.invalidateCurrent();f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("preserves a public surface across replacement and retires it separately",()=>{
  const f=fixture();f.binding.surfaceId=71;const surface=f.binding.surface,lease=f.retain()!;
  f.reg.destroyContext(7,11);expect(f.reg.getSurface(7,71)).toBe(surface);
  expect(lease.release()).toBe(true);expect(surface.ownerAlive).toBe(true);
  f.reg.destroySurface(7,11);expect(surface.ownerAlive).toBe(false);f.reg.unbind(7);
});
