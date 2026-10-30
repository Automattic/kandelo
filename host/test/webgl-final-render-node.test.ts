import {expect,it,vi} from "vitest";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {GlResultOwner} from "../src/webgl/owned-result.js";
import {GlMuxer} from "../src/webgl/muxer.js";
import {GbmBoRegistry} from "../src/dri/registry.js";
import {GlFinalRenderNodeReceiver,finalRenderNodeEffects} from "../src/webgl/final-render-node.js";
import {NativeRetirementReceipt,retainNativeRetirement,reserveNativeRetirement,retireNativeRetirement,transferNativeRetirement} from "../src/webgl/native-recovery.js";
function fixture() {
  let serial=0,blocked=false;const live=new Set<object>(),errors:number[]=[],removed:object[]=[];
  const make=()=>{const object={serial:++serial};live.add(object);return object;};
  const remove=(object:object)=>{if(blocked)throw new Error("delete failed");live.delete(object);removed.push(object);};
  const gl=new Proxy({getError:()=>errors.shift()??0,isContextLost:()=>false,getParameter:(p:number)=>p===0x84e0?0x84c0:null,
    checkFramebufferStatus:()=>0x8cd5,createTexture:make,createFramebuffer:make,createRenderbuffer:make,createProgram:make,
    deleteTexture:remove,deleteFramebuffer:remove,deleteRenderbuffer:remove,deleteProgram:remove,fenceSync:make,deleteSync:remove,getSyncParameter:()=>0x9119},
    {get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry(),bos=new GbmBoRegistry(),muxers=new WeakMap<WebGL2RenderingContext,GlMuxer>();
  registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:64});const binding=registry.get(7,11)!;binding.gl=gl;binding.contextId=21;
  const muxer=new GlMuxer(gl);muxers.set(gl,muxer);muxer.switchTo(binding);
  const owner=new GlResultOwner(1,7,11,binding.operations);
  const receiver=new GlFinalRenderNodeReceiver(registry,bos,muxers,4,512,128);
  return {gl,registry,bos,muxers,binding,muxer,owner,receiver,live,removed,errors,block:(v:boolean)=>{blocked=v;}};
}
it("observes actual GPU retirement after the public BO map is gone without retaining storage",()=>{
  const f=fixture();expect(f.registry.createGpuBo(77,f.gl,2,2)).not.toBe(null);
  const allocation=f.registry.gpuBo(77)!,hold=retainNativeRetirement(allocation.retirement)!;
  const receipt=NativeRetirementReceipt.capture(allocation.retirement)!;
  expect(f.registry.destroyGpuBo(77)).toBe(true);expect(f.registry.gpuBo(77)).toBeUndefined();
  expect(f.live.has(allocation.tex)).toBe(true);expect(receipt.complete).toBe(false);
  let wakes=0;receipt.watch(()=>wakes++);expect(hold.release(null)).toBe(true);expect(wakes).toBe(1);expect(receipt.complete).toBe(true);expect(f.live.has(allocation.tex)).toBe(false);receipt.forget();
});
it("never calls a transferred journal physical deletion",()=>{
  const f=fixture(),actual=reserveNativeRetirement({gl:f.gl,errors:[]},[])!,receipt=NativeRetirementReceipt.capture(actual)!;
  transferNativeRetirement(actual);expect(actual.complete).toBe(true);expect(receipt.complete).toBe(false);receipt.forget();
});
it("keeps final BO storage owned through failed deletion and retires on explicit retry without polling",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const allocation=f.registry.gpuBo(77)!;
  f.block(true);expect(f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[2,77]]))).toBe(true);
  let wakes=0;f.receiver.watch(f.owner,1n,()=>wakes++);f.receiver.drain(4);
  expect(f.receiver.poll(f.owner,1n)).toBe("pending");expect(f.live.has(allocation.tex)).toBe(true);
  const count=wakes;f.receiver.drain(4);f.receiver.drain(4);expect(wakes).toBe(count);expect(f.receiver.runnable).toBe(false);
  f.block(false);f.receiver.retry(f.owner,1n);f.receiver.drain(4);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");expect(f.live.has(allocation.tex)).toBe(false);
  expect(f.receiver.forget(f.owner,1n)).toBe(true);expect(f.receiver.retainedBytes).toBe(0);
});
it("waits for real accepted storage and execution leases; final release wakes once and late watch sees completion",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const allocation=f.registry.gpuBo(77)!;
  const storage=retainNativeRetirement(allocation.retirement)!,execution=f.registry.retainContextExecution(7,11,f.muxer)!;
  const input=finalRenderNodeEffects([[1,11],[2,77]]);expect(f.receiver.begin(f.owner,1n,input)).toBe(true);
  let wakes=0;f.receiver.watch(f.owner,1n,()=>wakes++);f.receiver.drain(4);
  expect(f.registry.get(7,11)).toBeUndefined();expect(f.receiver.poll(f.owner,1n)).toBe("pending");
  f.receiver.drain(4);const count=wakes;f.receiver.drain(4);expect(wakes).toBe(count);
  expect(execution.release()).toBe(true);expect(storage.release(null)).toBe(true);expect(wakes).toBeGreaterThan(count);
  f.receiver.drain(4);expect(f.receiver.poll(f.owner,1n)).toBe("retired");
  let late=0;expect(f.receiver.watch(f.owner,1n,()=>late++)).toBe(true);expect(late).toBe(1);
  expect(f.receiver.forget(f.owner,1n)).toBe(true);
});
it("owns immutable initial effects and refuses mismatched owner, unsupported effects, unknown BO and replay",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const input=finalRenderNodeEffects([[2,77]]);
  expect(f.receiver.begin(f.owner,1n,input)).toBe(true);input[4]=78;
  expect(f.receiver.begin(f.owner,1n,input)).toBe(false);expect(f.receiver.begin({...f.owner},1n,finalRenderNodeEffects([[2,77]]))).toBe(false);
  expect(f.receiver.begin(f.owner,2n,finalRenderNodeEffects([[2,999]]))).toBe(false);
  expect(f.receiver.begin(f.owner,2n,finalRenderNodeEffects([[1,12]]))).toBe(false);
  expect(f.receiver.retainedBytes).toBe(8);f.receiver.drain(4);expect(f.receiver.poll(f.owner,1n)).toBe("retired");
  f.receiver.forget(f.owner,1n);expect(f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[2,77]]))).toBe(false);
});
it("contains throwing metadata observers without replaying native cleanup or callbacks",()=>{
  const f=fixture();f.bos.create({pid:7,bo_id:77,w:2,h:2,stride:8,size:16});let calls=0;
  f.bos.onChange((_pid,_bo,event)=>{if(event==="destroy"){calls++;throw new Error("observer failed after effect");}});
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[2,77]]));f.receiver.drain(4);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");expect(f.receiver.notificationFault(f.owner,1n)).toBe(true);
  f.receiver.drain(4);expect(calls).toBe(1);expect(f.receiver.forget(f.owner,1n)).toBe(true);
});

// Actual production owned sender/controller and real registries. The endpoint
// copies messages; GL is a native API double, with no browser rendering claim.
import {GlOwnedForwardClient,GlOwnedMainForwardController,GlOwnedForwardRetirements} from "../src/webgl/owned-forward.js";
import {GlOperationStream} from "../src/webgl/operation-stream.js";
import {SubmitQueue} from "../src/webgl/submit-queue.js";
class Endpoint {
  other!:Endpoint;listeners=new Set<(event:MessageEvent)=>void>();sent:any[]=[];held:any[]=[];
  hold:((message:any)=>boolean)|null=null;
  postMessage(message:any):void {const copy=structuredClone(message);this.sent.push(copy);if(this.hold?.(copy))this.held.push(copy);else this.other.fire(copy);}
  fire(data:unknown):void {for(const listener of [...this.listeners])listener({data} as MessageEvent);}
  flush():void {for(const message of this.held.splice(0))this.other.fire(message);}
  addEventListener(_type:"message",listener:(event:MessageEvent)=>void):void {this.listeners.add(listener);}
  removeEventListener(_type:"message",listener:(event:MessageEvent)=>void):void {this.listeners.delete(listener);}
}
function paired() {
  const f=fixture(),sender=new Endpoint(),renderer=new Endpoint();sender.other=renderer;renderer.other=sender;
  const holder=new GlOwnedForwardRetirements(2),limits={maxOwners:4,maxRequests:8,maxRetainedBytes:512};
  const server=new GlOwnedMainForwardController(renderer,7,f.registry,f.bos,f.muxers,limits,holder,new SubmitQueue(),()=>{});
  const client=new GlOwnedForwardClient(sender,7,limits,()=>{}),owner=client.register(11,new GlOperationStream())!;
  const drain=()=>{client.drain(8);server.drain(8);client.drain(8);};
  const release=()=>{client.retireOwner(owner);client.forgetOwner(owner);server.close();drain();client.forgetOwner(owner);client.dispose();};
  return {...f,sender,renderer,holder,server,client,remoteOwner:owner,drain,release};
}
it("pairs exact physical BO ACK with lost Begin/retired ACK recovery, copied input and wrong epoch rejection",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const allocation=f.registry.gpuBo(77)!,hold=retainNativeRetirement(allocation.retirement)!;
  f.renderer.hold=m=>m.type==="gl_owned_final_reply";const input=finalRenderNodeEffects([[2,77]]);
  expect(f.client.beginFinal(f.remoteOwner,0x1_0000_0001n,input)).toBe(true);input.fill(255);f.client.drain(8);f.server.drain(8);
  expect(f.client.pollFinal(f.remoteOwner,0x1_0000_0001n)).toBe("awaiting-native-admission");
  const pending=f.renderer.held[0];f.sender.fire({...pending,epoch:pending.epoch+1,finalState:"retired"});
  expect(f.client.pollFinal(f.remoteOwner,0x1_0000_0001n)).toBe("awaiting-native-admission");expect(f.live.has(allocation.tex)).toBe(true);
  f.client.retryFinal(f.remoteOwner,0x1_0000_0001n);f.drain();
  hold.release(null);f.drain();expect(f.live.has(allocation.tex)).toBe(false);expect(f.client.forgetFinal(f.remoteOwner,0x1_0000_0001n)).toBe(false);
  f.renderer.hold=null;f.renderer.flush();f.drain();
  expect(f.client.pollFinal(f.remoteOwner,0x1_0000_0001n)).toBe("retired");let late=0;f.client.watchFinal(f.remoteOwner,0x1_0000_0001n,()=>late++);expect(late).toBe(1);
  expect(f.client.forgetFinal(f.remoteOwner,0x1_0000_0001n)).toBe(true);expect(f.client.retainedBytes).toBe(0);expect(f.server.retainedBytes).toBe(0);
  expect(f.client.beginFinal(f.remoteOwner,0x1_0000_0001n,finalRenderNodeEffects([[2,77]]))).toBe(false);f.release();
});
it("keeps paired cleanup owned through throwing post, shutdown and failed deletion without self-poll",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);f.block(true);
  const original=f.sender.postMessage.bind(f.sender);let first=true;
  f.sender.postMessage=message=>{original(message);if(message.type==="gl_owned_final_begin"&&first){first=false;throw new Error("post threw after enqueue");}};
  f.client.beginFinal(f.remoteOwner,1n,finalRenderNodeEffects([[1,11],[2,77]]));f.drain();
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("pending");expect(f.client.dispose()).toBe(false);
  f.server.close();f.drain();const finals=()=>f.sender.sent.filter(m=>m.type.startsWith("gl_owned_final_")).length;const count=finals();f.drain();f.drain();expect(finals()).toBe(count);expect(f.client.runnableAfterDrain).toBe(false);
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("pending");expect(f.holder.retainedEndpoints).toBe(1);
  f.block(false);f.client.retryFinal(f.remoteOwner,1n);f.drain();f.drain();
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("retired");f.client.forgetFinal(f.remoteOwner,1n);f.release();
  expect(f.holder.retainedEndpoints).toBe(0);
});
it("does not let final admission overtake actual query/legacy prefix and preserves native peer errors",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const prefix=f.binding.operations.reserve("commands")!;
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[2,77]]));f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("pending");expect(f.registry.gpuBo(77)).toBeDefined();expect(f.receiver.runnable).toBe(false);
  prefix.cancel();expect(f.receiver.runnable).toBe(true);f.errors.push(0x501);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");expect(f.binding.errors).toContain(0x501);f.receiver.forget(f.owner,1n);
});

it("retains exact CPU mirror journal and storage before CPU metadata can disappear",()=>{
  const f=fixture();f.bos.create({pid:7,bo_id:77,w:2,h:2,stride:8,size:16});
  const mirror=f.registry.cpuImages.acquire(f.binding,77,f.bos,{width:2,height:2,format:0x34325241,pitch:8,offset:0})!;
  expect(mirror).not.toBeNull();const hold=retainNativeRetirement(mirror.retirement)!;
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[2,77]]));f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("pending");expect(f.bos.dims(77)).toBeDefined();expect(f.live.has(mirror.tex)).toBe(true);
  expect(f.registry.cpuImages.acquire(f.binding,77,f.bos,{width:2,height:2,format:0x34325241,pitch:8,offset:0})).toBeNull();
  hold.release(null);f.receiver.drain(2);expect(f.receiver.poll(f.owner,1n)).toBe("retired");expect(f.bos.dims(77)).toBeUndefined();
  expect(f.live.has(mirror.tex)).toBe(false);f.receiver.forget(f.owner,1n);
});
it("holds actual foreign view cleanup and canonical backing when a view deletion fails",async()=>{
  const {bindGpuForeignTexture}=await import("../src/webgl/foreign-texture.js");
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const allocation=f.registry.gpuBo(77)!;
  const name=bindGpuForeignTexture(f.binding,77,allocation);expect(name).toBeGreaterThan(0);
  const object=f.binding.textures.get(name)!;expect(f.binding.foreignTextureBos.get(object)).toBe(77);
  f.block(true);f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[2,77]]));f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("pending");expect(f.live.has(allocation.tex)).toBe(true);
  f.block(false);f.receiver.retry(f.owner,1n);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");expect(f.binding.foreignTextureBos.has(object)).toBe(false);
  expect(f.live.has(allocation.tex)).toBe(false);f.receiver.forget(f.owner,1n);
});
it("reserves capability budget before capture and keeps partial capture owned without revoking another member",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const allocation=f.registry.gpuBo(77)!;
  const constrained=new GlFinalRenderNodeReceiver(f.registry,f.bos,f.muxers,4,512,0);
  expect(constrained.begin(f.owner,1n,finalRenderNodeEffects([[1,11],[2,77]]))).toBe(false);expect(f.binding.operations.immediateState()).toBe("idle");
  expect(constrained.retainedCapabilities).toBe(0);expect(f.registry.get(7,11)).toBe(f.binding);
  const capture=vi.spyOn(f.registry,"captureBoRetirement").mockReturnValueOnce(null);
  expect(f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[1,11],[2,77]]))).toBe(true);
  expect(f.registry.get(7,11)).toBe(f.binding);expect(f.live.has(allocation.tex)).toBe(true);expect(f.receiver.retainedCapabilities).toBeGreaterThan(0);
  capture.mockRestore();f.receiver.drain(4);expect(f.receiver.poll(f.owner,1n)).toBe("rejected");expect(f.registry.get(7,11)).toBe(f.binding);expect(f.live.has(allocation.tex)).toBe(true);f.receiver.forget(f.owner,1n);
  expect(f.receiver.retainedCapabilities).toBe(0);
});
it("keeps source session fence storage until the actual retained fence lease releases",async()=>{
  const f=fixture();
  // The native fence owner is the same actual narrow authority captured by
  // strict session retirement; no synthetic cleanup acknowledgement is used.
  const candidate=f.binding.fences.prepare(f.binding,9)!;expect(candidate.publish()).toBe(true);
  const lease=f.binding.fences.acquire(9)!;expect(lease).not.toBeNull();
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[1,11]]));f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("pending");expect(f.binding.fences.contexts().size).toBe(1);
  let wakes=0;f.receiver.watch(f.owner,1n,()=>wakes++);const count=wakes;
  expect(lease.releaseRetirement()).toBe(true);expect(wakes).toBe(count+1);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");f.receiver.forget(f.owner,1n);
});

it("uses the actual main-forward factory receiver for final session cleanup and endpoint release",async()=>{
  const {setupMainForward,createMainForwardChannel}=await import("../src/webgl/main-forward.js");
  const f=fixture(),sender=new Endpoint(),renderer=new Endpoint();sender.other=renderer;renderer.other=sender;
  const holder=new GlOwnedForwardRetirements(2),limits={maxOwners:4,maxRequests:8,maxRetainedBytes:512};
  const dispose=setupMainForward(renderer,{width:2,height:2,getContext:()=>f.gl} as unknown as HTMLCanvasElement,7,
    {endpoint:renderer,bos:f.bos,limits,retirements:holder,queueDrain:()=>{}});
  const client=new GlOwnedForwardClient(sender,7,limits,()=>{}),channel=createMainForwardChannel(sender,7,0,client);
  expect(channel.onCreateContext(11,undefined,21)).toBe(0);const owner=client.register(11,new GlOperationStream())!;
  expect(client.beginFinal(owner,1n,finalRenderNodeEffects([[1,11]]))).toBe(true);
  client.drain(8);dispose.ownedQueries!.drain(8);client.drain(8);
  expect(client.pollFinal(owner,1n)).toBe("retired");expect(client.forgetFinal(owner,1n)).toBe(true);
  expect(client.hasCreationBarrier()).toBe(true);expect(channel.onCreateContext(11,undefined,22)).toBe(-16);
  client.retireOwner(owner);client.forgetOwner(owner);dispose();client.drain(8);dispose.ownedQueries!.drain(8);client.forgetOwner(owner);
  expect(client.dispose()).toBe(true);expect(holder.retainedEndpoints).toBe(0);
});
it("does not require destroying a borrowed canonical BO which still has its own live owner",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const gpu=f.registry.gpuBo(77)!;
  f.binding.surface.borrowedTarget={gl:f.gl,fbo:gpu.fbo,w:2,h:2,retirement:gpu.retirement};
  f.binding.surface.gl=f.gl;f.binding.renderTargetFbo=gpu.fbo;
  expect(f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[1,11]]))).toBe(true);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");expect(f.live.has(gpu.tex)).toBe(true);
  expect(f.registry.gpuBo(77)).toBe(gpu);f.receiver.forget(f.owner,1n);f.registry.retireForeignBo(77);
});
it("does not replay a throwing session observer while retaining actual context cleanup",()=>{
  const f=fixture();let calls=0;f.registry.onChange((_pid,event)=>{if(event==="unbind"){calls++;throw new Error("unbind observer threw");}});
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[1,11]]));f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");f.receiver.drain(2);expect(calls).toBe(1);f.receiver.forget(f.owner,1n);
});

it("refuses a conflicting BO claim before effects and authenticates changed same-length renderer retries",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const gpu=f.registry.gpuBo(77)!,hold=retainNativeRetirement(gpu.retirement)!;
  f.client.beginFinal(f.remoteOwner,1n,finalRenderNodeEffects([[2,77]]));f.drain();
  expect(f.receiver.begin(f.owner,2n,finalRenderNodeEffects([[1,11],[2,77]]))).toBe(false);
  expect(f.registry.get(7,11)).toBe(f.binding);const sent=f.sender.sent.find(m=>m.type==="gl_owned_final_begin")!;
  const changed=structuredClone(sent);new DataView(changed.bytes).setUint32(4,78,true);f.renderer.fire(changed);f.server.drain(8);
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("pending");expect(f.live.has(gpu.tex)).toBe(true);
  hold.release(null);f.drain();expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("retired");f.client.forgetFinal(f.remoteOwner,1n);f.release();
});
it("waits for another accepted execution after revoking only its session",()=>{
  const f=fixture(),work=f.registry.retainContextExecution(7,11,f.muxer)!;
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[1,11]]));f.receiver.drain(2);
  expect(f.registry.get(7,11)).toBeUndefined();expect(f.receiver.poll(f.owner,1n)).toBe("pending");
  let wakes=0;f.receiver.watch(f.owner,1n,()=>wakes++);const count=wakes;
  expect(work.release()).toBe(true);expect(wakes).toBe(count+1);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");f.receiver.forget(f.owner,1n);
});
it("retains later scalar cleanup intent behind its actual final-file ACK",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const gpu=f.registry.gpuBo(77)!,hold=retainNativeRetirement(gpu.retirement)!;
  f.client.beginFinal(f.remoteOwner,1n,finalRenderNodeEffects([[1,11],[2,77]]));f.drain();
  expect(f.client.queueRetirement(11,"context",21)).toBe(true);f.client.drain(8);
  expect(f.sender.sent.some(m=>m.type==="gl_owned_retire")).toBe(false);
  hold.release(null);f.drain();f.drain();expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("retired");
  expect(f.sender.sent.some(m=>m.type==="gl_owned_retire")).toBe(true);f.client.forgetFinal(f.remoteOwner,1n);f.release();
});
it("validates the independently copied effects rather than caller-controlled buffer accessors",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const bytes=finalRenderNodeEffects([[2,77]]);
  Object.defineProperty(bytes,"buffer",{get(){bytes.fill(255);throw new Error("borrowed caller buffer read");}});
  expect(f.receiver.begin(f.owner,1n,bytes)).toBe(true);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");f.receiver.forget(f.owner,1n);
});
it("retains already-retired execution authority after the public context slot is replaced",()=>{
  const f=fixture(),old=f.registry.retainContextExecution(7,11,f.muxer)!;
  f.registry.destroyContext(7,11);expect(f.registry.get(7,11)).not.toBe(f.binding);
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[1,11]]));f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("pending");
  let wakes=0;f.receiver.watch(f.owner,1n,()=>wakes++);const count=wakes;
  old.release();expect(wakes).toBe(count+1);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("retired");f.receiver.forget(f.owner,1n);
});
it("never captures a replacement BO after initial source capability preparation failed",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);const before=f.registry.gpuBo(77)!;
  const capture=vi.spyOn(f.registry,"captureBoRetirement").mockReturnValueOnce(null);
  expect(f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[2,77]]))).toBe(true);capture.mockRestore();
  expect(f.registry.destroyGpuBo(77)).toBe(true);expect(f.live.has(before.tex)).toBe(false);
  expect(f.registry.createGpuBo(77,f.gl,2,2)).not.toBeNull();const replacement=f.registry.gpuBo(77)!;
  f.receiver.drain(2);expect(f.live.has(replacement.tex)).toBe(true);
  expect(f.receiver.poll(f.owner,1n)).toBe("rejected");f.receiver.forget(f.owner,1n);f.registry.retireForeignBo(77);
});
it("retains rejecting rollback custody through actual native cleanup failure without recapturing",()=>{
  const f=fixture();f.registry.createGpuBo(77,f.gl,2,2);
  const texture=f.gl.createTexture()!;f.binding.textures.set(4,texture);
  const capture=vi.spyOn(f.registry,"captureBoRetirement").mockReturnValueOnce(null);
  f.receiver.begin(f.owner,1n,finalRenderNodeEffects([[1,11],[2,77]]));capture.mockRestore();
  expect(f.receiver.poll(f.owner,1n)).toBe("rejecting");f.block(true);f.registry.destroyContext(7,11);
  const replacement=f.registry.get(7,11)!;f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("rejecting");expect(f.receiver.forget(f.owner,1n)).toBe(false);expect(f.receiver.retainedBytes).toBe(16);
  const capCalls=vi.spyOn(f.registry,"captureBoRetirement");f.receiver.drain(2);expect(capCalls).not.toHaveBeenCalled();capCalls.mockRestore();
  f.block(false);f.receiver.retry(f.owner,1n);f.receiver.drain(2);
  expect(f.receiver.poll(f.owner,1n)).toBe("rejected");expect(f.registry.get(7,11)).toBe(replacement);
  expect(f.live.has(texture)).toBe(false);f.receiver.forget(f.owner,1n);expect(f.receiver.retainedBytes).toBe(0);
});

it("pairs rejecting rollback without closing owner admission, losing cleanup or replaying source selection",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const allocation=f.registry.gpuBo(77)!;
  const texture=f.gl.createTexture()!;f.binding.textures.set(4,texture);
  const capture=vi.spyOn(f.registry,"captureBoRetirement").mockReturnValueOnce(null);
  f.client.beginFinal(f.remoteOwner,1n,finalRenderNodeEffects([[1,11],[2,77]]));f.client.drain(8);
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("rejecting");expect(capture).toHaveBeenCalledTimes(1);
  f.block(true);f.registry.destroyContext(7,11);f.drain();
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("rejecting");expect(f.client.forgetFinal(f.remoteOwner,1n)).toBe(false);
  expect(f.client.dispose()).toBe(false);expect(f.server.retainedBytes).toBe(16);expect(f.live.has(allocation.tex)).toBe(true);
  const posts=f.sender.sent.length;f.drain();f.drain();expect(f.sender.sent.length).toBe(posts);expect(capture).toHaveBeenCalledTimes(1);
  f.renderer.hold=m=>m.type==="gl_owned_final_reply"&&m.finalState==="rejected";
  f.block(false);f.client.retryFinal(f.remoteOwner,1n);f.drain();
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("rejecting");expect(f.live.has(texture)).toBe(false);
  const rejected=f.renderer.held[0];expect(rejected.finalState).toBe("rejected");
  f.sender.fire({...rejected,registration:rejected.registration+1});expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("rejecting");
  f.renderer.hold=null;f.renderer.flush();expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("rejected");
  let late=0;f.client.watchFinal(f.remoteOwner,1n,()=>late++);expect(late).toBe(1);
  expect(f.client.forgetFinal(f.remoteOwner,1n)).toBe(true);expect(f.server.retainedBytes).toBe(0);expect(capture).toHaveBeenCalledTimes(1);capture.mockRestore();
  expect(f.client.beginFinal(f.remoteOwner,2n,finalRenderNodeEffects([[2,77]]))).toBe(true);f.drain();f.drain();
  expect(f.client.pollFinal(f.remoteOwner,2n)).toBe("retired");expect(f.client.forgetFinal(f.remoteOwner,2n)).toBe(true);f.release();
});

it("rejects CPU mirror final admission before capture when accepted prefix work still needs it",()=>{
  const f=fixture();f.bos.create({pid:7,bo_id:77,w:2,h:2,stride:8,size:16});
  const prefix=f.binding.operations.reserve("commands")!,input=finalRenderNodeEffects([[2,77]]);
  const capture=vi.spyOn(f.registry,"captureBoRetirement");
  expect(f.receiver.begin(f.owner,1n,input)).toBe(true);
  expect(f.receiver.poll(f.owner,1n)).toBe("rejected");expect(capture).not.toHaveBeenCalled();
  expect(f.receiver.retainedCapabilities).toBe(0);expect(f.bos.dims(77)).toBeDefined();
  const mirror=f.registry.cpuImages.acquire(f.binding,77,f.bos,{width:2,height:2,format:0x34325241,pitch:8,offset:0});expect(mirror).not.toBeNull();
  prefix.cancel();f.receiver.drain(4);expect(f.receiver.begin(f.owner,1n,input)).toBe(true);expect(capture).not.toHaveBeenCalled();
  expect(f.receiver.poll(f.owner,1n)).toBe("rejected");f.receiver.forget(f.owner,1n);
  expect(f.receiver.begin(f.owner,1n,input)).toBe(false);expect(f.receiver.begin(f.owner,2n,input)).toBe(true);capture.mockRestore();
  f.receiver.drain(4);expect(f.receiver.poll(f.owner,2n)).toBe("retired");f.receiver.forget(f.owner,2n);
});

it("never resurrects a paired terminal rejection after absent BO creation and Forget",()=>{
  const f=paired(),input=finalRenderNodeEffects([[2,77]]);
  expect(f.client.beginFinal(f.remoteOwner,1n,input)).toBe(true);f.drain();
  expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("rejected");
  const original=f.sender.sent.find(m=>m.type==="gl_owned_final_begin");expect(original).toBeDefined();
  expect(f.client.forgetFinal(f.remoteOwner,1n)).toBe(true);
  f.registry.createGpuBo(77,f.gl,2,2);const replacement=f.registry.gpuBo(77)!;
  f.sender.postMessage(original);f.server.drain(8);
  expect(f.live.has(replacement.tex)).toBe(true);expect(f.registry.gpuBo(77)).toBe(replacement);
  f.registry.retireForeignBo(77);f.release();
});

it("refuses physical proof from a guarded live-program release journal",()=>{
  const f=fixture(),program=f.gl.createProgram()!;f.binding.programs.set(8,program);
  const journal=reserveNativeRetirement({gl:f.gl,errors:[]},[["deleteProgram",program]],[],{unusedProgramOwners:f.binding.objects})!;
  const receipt=NativeRetirementReceipt.capture(journal);
  const dependent=reserveNativeRetirement({gl:f.gl,errors:[]},[],[journal])!;
  expect(NativeRetirementReceipt.capture(dependent)).toBeNull();
  expect(retireNativeRetirement(journal)).toBe(true);expect(f.live.has(program)).toBe(true);
  expect(receipt?.complete??false).toBe(false);expect(receipt).toBeNull();
  f.binding.programs.delete(8);
  const physical=reserveNativeRetirement({gl:f.gl,errors:[]},[["deleteProgram",program]])!,actual=NativeRetirementReceipt.capture(physical)!;
  expect(actual).not.toBeNull();expect(retireNativeRetirement(physical)).toBe(true);expect(actual.complete).toBe(true);expect(f.live.has(program)).toBe(false);actual.forget();
});

it("keeps capacity refusals nonexecuting after space returns without abandoning accepted lower tokens",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const target=f.registry.gpuBo(77)!;
  for(let i=0;i<8;i++)f.registry.createGpuBo(100+i,f.gl,2,2);
  f.client.beginFinal(f.remoteOwner,1n,finalRenderNodeEffects([[2,100]]));f.client.drain(8);
  const template=f.sender.sent.find(m=>m.type==="gl_owned_final_begin");
  const begin=(token:number,bo:number)=>({...template,tokenLow:token,bytes:finalRenderNodeEffects([[2,bo]]).buffer});
  for(let i=1;i<8;i++)f.sender.postMessage(begin(i+1,100+i));
  const refused=begin(99,77);f.renderer.hold=m=>m.type==="gl_owned_final_reply"&&m.tokenLow===99;
  f.sender.postMessage(refused);expect(f.renderer.held.at(-1).finalState).toBe("rejected");
  f.server.drain(8);f.client.drain(8);expect(f.client.pollFinal(f.remoteOwner,1n)).toBe("retired");
  f.client.forgetFinal(f.remoteOwner,1n);
  for(let token=2;token<=8;token++)f.sender.postMessage({...template,type:"gl_owned_final_forget",tokenLow:token});
  expect(f.server.retainedBytes).toBe(0);f.renderer.hold=null;
  f.sender.postMessage(refused);f.server.drain(8);expect(f.registry.gpuBo(77)).toBe(target);expect(f.live.has(target.tex)).toBe(true);
  f.sender.postMessage({...refused,type:"gl_owned_final_forget"});f.sender.postMessage(refused);f.server.drain(8);
  expect(f.registry.gpuBo(77)).toBe(target);f.registry.retireForeignBo(77);f.release();
});
it("revokes malformed-batch and byte-capacity tokens before a terminal refusal ACK",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const target=f.registry.gpuBo(77)!;
  f.client.beginFinal(f.remoteOwner,1n,finalRenderNodeEffects([[2,999]]));f.drain();
  const template=f.sender.sent.find(m=>m.type==="gl_owned_final_begin");f.client.forgetFinal(f.remoteOwner,1n);
  const malformed=new Uint8Array(8);new DataView(malformed.buffer).setUint32(0,9,true);
  for(const [token,bytes] of [[2,malformed],[3,new Uint8Array(520)]] as const) {
    f.sender.postMessage({...template,tokenLow:token,bytes:bytes.buffer});
    expect(f.renderer.sent.at(-1).finalState).toBe("rejected");
    // Changing bytes under a refused identity must not make it executable.
    f.sender.postMessage({...template,type:"gl_owned_final_forget",tokenLow:token});
    f.sender.postMessage({...template,tokenLow:token,bytes:finalRenderNodeEffects([[2,77]]).buffer});f.server.drain(8);
    expect(f.registry.gpuBo(77)).toBe(target);
  }
  expect(f.server.retainedBytes).toBe(0);f.registry.retireForeignBo(77);f.release();
});
it("keeps query-contention final refusals revoked after the actual query retires",async()=>{
  const {QOP_FINISH}=await import("../src/webgl/ops.js");
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const target=f.registry.gpuBo(77)!;
  expect(f.client.begin(f.remoteOwner,1n,{op:QOP_FINISH,input:new Uint8Array(),capacity:0,context:21,hasCurrent:true,draw:0,read:0})).toBe(true);f.drain();
  const grant=f.renderer.sent.find(m=>m.type==="gl_owned_opened"),refused={...grant,type:"gl_owned_final_begin",tokenLow:2,tokenHigh:0,bytes:finalRenderNodeEffects([[2,77]]).buffer};
  f.sender.postMessage(refused);expect(f.renderer.sent.at(-1).finalState).toBe("rejected");
  f.client.control(f.remoteOwner,1n,"cancel");f.drain();f.drain();expect(f.client.poll(f.remoteOwner,1n).state).toBe("retired");
  f.client.forget(f.remoteOwner,1n);f.sender.postMessage({...refused,type:"gl_owned_final_forget"});f.sender.postMessage(refused);f.server.drain(8);
  expect(f.registry.gpuBo(77)).toBe(target);f.registry.retireForeignBo(77);f.release();
});
it("cannot burn another registration's admission floor with a forged terminal refusal",()=>{
  const f=paired();f.registry.createGpuBo(77,f.gl,2,2);const target=f.registry.gpuBo(77)!;
  f.client.beginFinal(f.remoteOwner,1n,finalRenderNodeEffects([[2,999]]));f.drain();
  const template=f.sender.sent.find(m=>m.type==="gl_owned_final_begin");f.client.forgetFinal(f.remoteOwner,1n);
  f.sender.postMessage({...template,tokenLow:99,registration:template.registration+1});
  expect(f.client.beginFinal(f.remoteOwner,2n,finalRenderNodeEffects([[2,77]]))).toBe(true);f.drain();f.drain();
  expect(f.client.pollFinal(f.remoteOwner,2n)).toBe("retired");expect(f.live.has(target.tex)).toBe(false);f.client.forgetFinal(f.remoteOwner,2n);f.release();
});

it("does not turn a transferred dependency into physical deletion proof",()=>{
  const f=fixture(),dependency=reserveNativeRetirement({gl:f.gl,errors:[]},[])!;
  const journal=reserveNativeRetirement({gl:f.gl,errors:[]},[],[dependency])!,receipt=NativeRetirementReceipt.capture(journal)!;
  transferNativeRetirement(dependency);expect(retireNativeRetirement(journal)).toBe(true);
  expect(journal.complete).toBe(true);expect(receipt.complete).toBe(false);receipt.forget();
});
