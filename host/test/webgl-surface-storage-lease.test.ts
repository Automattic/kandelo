import { expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import * as S from "../src/webgl/surface-resources.js";
import { hasNativeRepair, repairNativeState } from "../src/webgl/native-recovery.js";

function fixture() {
  let serial=0,reject=false;
  const errors:number[]=[],live=new Set<object>(),deleted:object[]=[];
  const make=()=>{const value={id:++serial};live.add(value);return value;};
  const remove=(value:object)=>{if(reject){errors.push(0x505);return;}expect(live.delete(value)).toBe(true);deleted.push(value);};
  const gl={getError:()=>errors.shift()??0,isContextLost:()=>false,
    getParameter:(p:number)=>p===0x84e0?0x84c0:null,
    createTexture:make,createFramebuffer:make,createRenderbuffer:make,
    deleteTexture:remove,deleteFramebuffer:remove,deleteRenderbuffer:remove,
    activeTexture(){},bindTexture(){},bindFramebuffer(){},bindRenderbuffer(){},
    texImage2D(){},texParameteri(){},framebufferTexture2D(){},renderbufferStorage(){},framebufferRenderbuffer(){},
    checkFramebufferStatus:()=>0x8cd5,
  } as unknown as WebGL2RenderingContext;
  const reg=new GlContextRegistry();reg.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:40});
  const binding=reg.get(7,11)!;binding.gl=gl;binding.contextId=1;binding.surfaceId=31;
  expect(resizeSurfaceTarget(binding,4,3)).toBe(true);
  const retain=Reflect.get(S,"retainSurfaceStorage") as typeof S.retainSurfaceStorage | undefined;
  return {reg,binding,gl,live,deleted,errors,retain,reject(value:boolean){reject=value;}};
}
it("keeps a queued allocation live while resize publishes independent storage",()=>{
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain?.(f.binding.surface);
  expect(resizeSurfaceTarget(f.binding,8,6)).toBe(true);
  expect(f.live.has(old.fbo)).toBe(true);
  expect(f.live.has(old.tex)).toBe(true);
  expect(f.live.has(old.depthStencil)).toBe(true);
  expect(lease).toBeTruthy();
  expect(lease!.framebuffer).toBe(old.fbo);expect([lease!.width,lease!.height]).toEqual([4,3]);
  expect(f.binding.presentTarget!.fbo).not.toBe(old.fbo);
  expect(hasNativeRepair(f.gl)).toBe(false);expect(repairNativeState(f.gl)).toBe(true);
  expect(lease!.release(null)).toBe(true);
  expect(f.deleted).toEqual(expect.arrayContaining([old.fbo,old.tex,old.depthStencil]));
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("keeps copied storage identity after the surface description is revoked",()=>{
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain?.(f.binding.surface);
  f.reg.destroySurface(7,11);
  expect(f.live.has(old.fbo)).toBe(true);expect(lease).toBeTruthy();
  expect(lease!.surfaceId).toBe(31);expect(lease!.framebuffer).toBe(old.fbo);
  expect(f.binding.surfaceId).toBeNull();
  expect(lease!.release(null)).toBe(true);expect(lease!.release(null)).toBe(true);
  expect(f.deleted.filter(x=>x===old.fbo)).toHaveLength(1);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});

it("clones an existing retired allocation without granting a new public hold",async()=>{
  const {retainNativeRetirement}=await import("../src/webgl/native-recovery.js");
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  expect(resizeSurfaceTarget(f.binding,8,6)).toBe(true);
  expect(retainNativeRetirement(old.retirement)).toBeNull();
  const second=lease.clone()!;expect(second).not.toBeNull();
  expect(lease.release(null)).toBe(true);expect(f.live.has(old.fbo)).toBe(true);
  expect(lease.clone()).toBeNull();expect(()=>lease.framebuffer).toThrow("released");
  expect(second.framebuffer).toBe(old.fbo);expect(second.release(null)).toBe(true);
  expect(f.deleted.filter(x=>x===old.fbo)).toHaveLength(1);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("retains a retry token after final deletion rejection without decrementing twice",()=>{
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  f.reg.destroySurface(7,11);f.reject(true);
  const peer={errors:[] as number[]};f.errors.push(0x500);
  expect(lease.release(peer)).toBe(false);
  expect(peer.errors).toEqual([0x500]);expect(old.retirement.references).toBe(0);
  expect(lease.context).toBe(f.gl);expect(()=>lease.framebuffer).toThrow("released");
  expect(lease.clone()).toBeNull();expect(hasNativeRepair(f.gl)).toBe(true);
  expect(lease.release(peer)).toBe(false);expect(old.retirement.references).toBe(0);
  f.reject(false);expect(lease.release(peer)).toBe(true);
  expect(peer.errors).toEqual([0x500]);expect(lease.context).toBeNull();
  expect(old.retirement.complete).toBe(true);expect(hasNativeRepair(f.gl)).toBe(false);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("keeps a lease active if selected-owner errors cannot be captured",()=>{
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  f.reg.destroySurface(7,11);
  const read=vi.spyOn(f.gl,"getError").mockImplementation(()=>{throw new Error("error read failed");});
  expect(lease.release(null)).toBe(false);expect(old.retirement.references).toBe(1);
  expect(lease.framebuffer).toBe(old.fbo);expect(f.live.has(old.fbo)).toBe(true);
  read.mockRestore();expect(lease.release(null)).toBe(true);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("does not transfer deletion ownership while retained storage is in use",async()=>{
  const {transferNativeRetirement}=await import("../src/webgl/native-recovery.js");
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  expect(()=>transferNativeRetirement(old.retirement)).toThrow("retained native storage");
  expect(old.retirement.complete).toBe(false);expect(lease.release(null)).toBe(true);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("rejects reference exhaustion without changing allocation ownership",()=>{
  const f=fixture(),old=f.binding.presentTarget!;
  old.retirement.references=Number.MAX_SAFE_INTEGER;
  expect(f.retain!(f.binding.surface)).toBeNull();expect(f.live.size).toBe(3);
  expect(old.retirement.references).toBe(Number.MAX_SAFE_INTEGER);
  old.retirement.references=0;f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("retains pending selector inverses until the held native object is really deleted",async()=>{
  const {applyNativeChanges,nativeInverse}=await import("../src/webgl/native-recovery.js");
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  let reject=true;
  const bind=vi.spyOn(f.gl,"bindFramebuffer").mockImplementation((_target,framebuffer)=>{
    if(reject && framebuffer===old.fbo)throw new Error("selector blocked");
  });
  const owner={gl:f.gl,errors:[] as number[]};
  expect(applyNativeChanges({...owner,shadow:f.binding.shadow},[
    {apply:()=>false,restore:nativeInverse(owner,[["bindFramebuffer",0x8ca9,old.fbo]])},
  ],{shared:true})).toBe(false);
  f.reg.destroySurface(7,11);expect(f.live.has(old.fbo)).toBe(true);
  reject=false;expect(repairNativeState(f.gl)).toBe(true);
  expect(bind).toHaveBeenLastCalledWith(0x8ca9,old.fbo);
  expect(f.live.has(old.fbo)).toBe(true);expect(lease.release(null)).toBe(true);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("releases its reference but defers deletion behind an unresolved native inverse",async()=>{
  const {applyNativeChanges,nativeInverse}=await import("../src/webgl/native-recovery.js");
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  let reject=true;
  vi.spyOn(f.gl,"bindFramebuffer").mockImplementation(()=>{if(reject)throw new Error("selector blocked");});
  const owner={gl:f.gl,errors:[] as number[]};
  expect(applyNativeChanges({...owner,shadow:f.binding.shadow},[
    {apply:()=>false,restore:nativeInverse(owner,[["bindFramebuffer",0x8ca9,old.fbo]])},
  ],{shared:true})).toBe(false);
  f.reg.destroySurface(7,11);expect(lease.release(null)).toBe(false);
  expect(old.retirement.references).toBe(0);expect(f.deleted).toEqual([]);
  reject=false;expect(repairNativeState(f.gl)).toBe(true);
  expect(lease.release(null)).toBe(true);
  expect(f.deleted.filter(x=>x===old.fbo)).toHaveLength(1);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
it("does not release a native dependency while its storage lease is held",async()=>{
  const N=await import("../src/webgl/native-recovery.js");
  const f=fixture(),child=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  const buffer={} as WebGLBuffer;let calls=0;f.gl.deleteBuffer=()=>{calls++;};
  const parent=N.reserveNativeRetirement({gl:f.gl,errors:[]},[["deleteBuffer",buffer]],[child.retirement])!;
  expect(N.retireNativeRetirement(parent)).toBe(false);
  f.reg.destroySurface(7,11);
  expect(hasNativeRepair(f.gl)).toBe(false);expect(repairNativeState(f.gl)).toBe(true);expect(calls).toBe(0);
  expect(lease.release(null)).toBe(true);expect(calls).toBe(1);
  // The parent was reserved after its child, so one collection pass sees
  // both completed receipts and never leaves an admission-blocking tail.
  expect(parent.complete).toBe(true);expect(hasNativeRepair(f.gl)).toBe(false);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});

it("does not replay accepted deletions when only one allocation member rejects cleanup",()=>{
  const f=fixture(),old=f.binding.presentTarget!,lease=f.retain!(f.binding.surface)!;
  const destroy=f.gl.deleteTexture.bind(f.gl);let rejected=true,attempts=0;
  f.gl.deleteTexture=texture=>{attempts++;if(rejected)throw new Error("texture deletion rejected");destroy(texture);};
  f.reg.destroySurface(7,11);expect(lease.release(null)).toBe(false);
  expect(f.live.has(old.tex)).toBe(true);expect(f.live.has(old.fbo)).toBe(false);expect(f.live.has(old.depthStencil)).toBe(false);
  expect(lease.release(null)).toBe(false);expect(attempts).toBe(2);
  expect(f.deleted.filter(x=>x===old.fbo)).toHaveLength(1);expect(f.deleted.filter(x=>x===old.depthStencil)).toHaveLength(1);
  rejected=false;expect(lease.release(null)).toBe(true);expect(attempts).toBe(3);
  expect(f.deleted.filter(x=>x===old.tex)).toHaveLength(1);
  f.reg.unbind(7);expect(f.live.size).toBe(0);
});
