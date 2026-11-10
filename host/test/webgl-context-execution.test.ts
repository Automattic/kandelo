import { expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { NativeGlFault } from "../src/webgl/native-recovery.js";

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
function caught(call:()=>unknown):Error|undefined{try{call();}catch(error){return error as Error;}return undefined;}
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
it("faults when selected-peer error capture fails before retiring a context",()=>{
  const f=fixture(),lease=f.retain()!;f.reg.destroyContext(7,11);
  const peer=f.reg.get(7,11)!;peer.gl=f.gl;peer.contextId=2;f.muxer.switchTo(peer);f.errors.push(0x500);
  const read=vi.spyOn(f.gl,"getError").mockImplementation(()=>{throw new Error("error read failed");});
  try {
    const fault=caught(()=>lease.release());
    expect(fault).toBeInstanceOf(NativeGlFault);
    expect(fault!.message).toMatch(/could not read the selected owner's error flags before retiring a context/);
    expect(f.live.has(f.texture)).toBe(true);expect(f.deleted).toEqual([]);
  } finally {read.mockRestore();}
});
it("faults when the live renderer refuses a retired context's local-container deletion",()=>{
  const f=fixture(),vao=f.gl.createVertexArray()!;f.binding.vaos.set(9,vao);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const destroy=f.gl.deleteVertexArray.bind(f.gl);
  f.gl.deleteVertexArray=value=>{if(value===vao)throw new Error("VAO retirement rejected");destroy(value);};
  const fault=caught(()=>lease.release());
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(/live renderer refused deleteVertexArray of an object the host retired/);
  expect(f.deleted.filter(value=>value===f.texture)).toHaveLength(1);expect(f.live.has(vao)).toBe(true);
});
it("faults when the live renderer refuses a retired image after an accepted prefix",()=>{
  const f=fixture(),second=f.gl.createTexture()!;f.binding.textures.set(2,second);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const destroy=f.gl.deleteTexture.bind(f.gl);
  f.gl.deleteTexture=value=>{if(value===second)throw new Error("texture retirement rejected");destroy(value);};
  const fault=caught(()=>lease.release());
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect(fault!.message).toMatch(/live renderer refused deleteTexture of an object the host retired/);
  expect(f.deleted.filter(value=>value===f.texture)).toHaveLength(1);expect(f.live.has(second)).toBe(true);
  expect(f.binding.cmdbufView).toBeNull();
});
it("faults when the live renderer refuses to uninstall a retired context's program",()=>{
  const f=fixture(),program=f.gl.createProgram()!;f.binding.currentProgram=program;f.binding.shadow.currentProgram=program;
  f.gl.useProgram(program);
  const lease=f.retain()!;f.reg.destroyContext(7,11);
  const use=f.gl.useProgram.bind(f.gl);
  f.gl.useProgram=value=>{if(value===null)throw new Error("program unbind rejected");use(value);};
  const fault=caught(()=>lease.release());
  expect(fault).toBeInstanceOf(NativeGlFault);
  // destroyContextResources unbinds the executable before the checked
  // uninstall; the refusal surfaces there as the generic retirement fault.
  expect(fault!.message).toMatch(/retiring a context's native objects threw/);
  expect((fault!.cause as Error).message).toBe("program unbind rejected");
  expect(f.live.has(program)).toBe(true);expect(f.gl.getParameter(0x8b8d)).toBe(program);
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

it("does not run native cleanup for admitted live execution",()=>{
  const f=fixture();
  const lease=f.reg.retainContextExecution(7,11,f.muxer)!;
  expect(lease).not.toBeNull();
  const prepare=vi.spyOn(f.muxer,"prepareRetirement"),read=vi.spyOn(f.gl,"getError");
  try {
    expect(f.deleted).toEqual([]);expect(f.reg.getContext(7,1)).toBe(f.binding);
    expect(lease.release()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
    // Ending an execution admission does not retire the public context.
    expect(f.live.has(f.texture)).toBe(true);expect(f.deleted).toEqual([]);
  } finally {prepare.mockRestore();read.mockRestore();f.reg.unbind(7);}
  expect(f.live.size).toBe(0);
});

it("does not treat retained retired execution as runnable cleanup",()=>{
  const f=fixture(),first=f.reg.retainContextExecution(7,11,f.muxer)!,second=first.clone()!;
  f.reg.destroyContext(7,11);
  const prepare=vi.spyOn(f.muxer,"prepareRetirement"),read=vi.spyOn(f.gl,"getError");
  try {
    expect(first.release()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
    expect(f.live.has(f.texture)).toBe(true);expect(second.binding).toBe(f.binding);
    expect(second.release()).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(f.deleted.filter(value=>value===f.texture)).toHaveLength(1);
  } finally {prepare.mockRestore();read.mockRestore();f.reg.unbind(7);}
  expect(f.live.size).toBe(0);
});

it("faults when the final execution release cannot read the selected owner's error flags",()=>{
  const f=fixture(),lease=f.reg.retainContextExecution(7,11,f.muxer)!;
  f.reg.destroyContext(7,11);f.errors.push(0x500);
  const read=vi.spyOn(f.gl,"getError").mockImplementation(()=>{throw new Error("selected error capture failed");});
  try {
    const fault=caught(()=>lease.release());
    expect(fault).toBeInstanceOf(NativeGlFault);
    expect(fault!.message).toMatch(/could not read the selected owner's error flags before retiring a context/);
    expect(f.errors).toEqual([0x500]);expect(f.deleted).toEqual([]);expect(f.live.has(f.texture)).toBe(true);
  } finally {read.mockRestore();}
});

it("confines a retirement fault to its exact registry and physical renderer",()=>{
  const f=fixture(),g=fixture();
  const first=f.reg.retainContextExecution(7,11,f.muxer)!,second=g.reg.retainContextExecution(7,11,g.muxer)!;
  f.reg.destroyContext(7,11);g.reg.destroyContext(7,11);
  const readF=vi.spyOn(f.gl,"getError").mockImplementation(()=>{throw new Error("first renderer unavailable");});
  const readG=vi.spyOn(g.gl,"getError");
  try {
    expect(caught(()=>first.release())).toBeInstanceOf(NativeGlFault);
    expect(readG).not.toHaveBeenCalled();expect(g.deleted).toEqual([]);expect(f.deleted).toEqual([]);
  } finally {readF.mockRestore();readG.mockRestore();}
  // The other registry's renderer retires normally.
  expect(second.release()).toBe(true);
  expect(g.deleted.filter(value=>value===g.texture)).toHaveLength(1);
  g.reg.unbind(7);expect(g.live.size).toBe(0);
});
