import { expect, it, vi } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { setupMainForward, createMainForwardChannel } from "../src/webgl/main-forward.js";
import { GlOwnedForwardClient, GlOwnedForwardRetirements } from "../src/webgl/owned-forward.js";
import { GlNativeQueryAdapter } from "../src/webgl/native-query-adapter.js";
import { KernelEntryGate,createKernelEntryGatedInstance,isKernelExportFailure } from "../src/kernel-entry-gate.js";
import { GbmBoRegistry } from "../src/dri/registry.js";
import { encodeQueryRequest,decodeQueryReply,type QueryReceiptRequest,type QueryMode } from "../src/webgl/query-receipt-codec.js";
import * as O from "../src/webgl/ops.js";
class Endpoint {
  listeners=new Set<(event:MessageEvent)=>void>();other!:Endpoint;sent:any[]=[];
  drop:((message:any)=>boolean)|null=null;
  postMessage(message:unknown):void {const copied=structuredClone(message);this.sent.push(copied);if(!this.drop?.(copied))this.other.fire(copied);}
  fire(data:unknown):void {for(const listener of [...this.listeners])listener({data} as MessageEvent);}
  addEventListener(_type:"message",listener:(event:MessageEvent)=>void):void {this.listeners.add(listener);}
  removeEventListener(_type:"message",listener:(event:MessageEvent)=>void):void {this.listeners.delete(listener);}
}
const limits={maxOwners:8,maxRequests:16,maxRetainedBytes:4096};
function fixture(width:4|8) {
  const memory=new WebAssembly.Memory({initial:2,maximum:2}),wakes:unknown[][]=[],ownerWakes:unknown[][]=[];
  const kernel=createWasmPosixKernelTestHarness({io:{} as any,memory,pointerWidth:width,
    callbacks:{getProcessMemory:()=>memory,onGlQueryWake:(...args:unknown[])=>wakes.push(args),onGlQueryOwnerWake:(...args:unknown[])=>ownerWakes.push(args)},
    instance:createKernelScratchTestInstance(width,memory,()=>({}),()=>4096)});
  const env=(kernel.testAuthority.buildImportObject(memory) as {env:Record<string,(...args:any[])=>any>}).env;
  const sender=new Endpoint(),receiver=new Endpoint();sender.other=receiver;receiver.other=sender;
  let blocked=false;const log:string[]=[],live=new Set<object>();
  const make=()=>{const value={};live.add(value);return value;};
  const remove=(value:object)=>{if(blocked)throw new Error("cleanup refused");live.delete(value);};
  const gl=new Proxy({getError:()=>0,isContextLost:()=>false,getExtension:()=>null,getSyncParameter:()=>0x9119,
    getParameter:(p:number)=>p===0x84e0?0x84c0:p===0x0d33?4096:0,checkFramebufferStatus:()=>0x8cd5,
    clear:()=>log.push("clear"),finish:()=>log.push("finish"),fenceSync:make,
  },{get:(object,key)=>Reflect.get(object,key)??(String(key).startsWith("create")?make:String(key).startsWith("delete")?remove:()=>null)}) as unknown as WebGL2RenderingContext;
  const retirements=new GlOwnedForwardRetirements(2);
  const dispose=setupMainForward(receiver,{width:4,height:3,getContext:()=>gl} as unknown as HTMLCanvasElement,7,
    {endpoint:receiver,bos:new GbmBoRegistry(),limits,retirements});
  const client=new GlOwnedForwardClient(sender,7,limits,(...args:unknown[])=>wakes.push(args));
  const channel=createMainForwardChannel(sender,7,0,client);
  const legacyQuery=vi.spyOn(channel,"onQuery");kernel.gl.attachMainForward(7,channel);
  const p=(value:number)=>width===8?BigInt(value):value;
  env.host_gl_bind(7,p(32768),p(4096),11,1n);
  expect(env.host_gl_create_context(7,21,p(0),p(0),11)).toBe(0);
  expect(env.host_gl_make_current(7,21,0,0,11)).toBe(0);
  const invoke=(request:QueryReceiptRequest,capacity=0,mode?:QueryMode)=>{
    const bytes=encodeQueryRequest(request);new Uint8Array(memory.buffer,1024,bytes.length).set(bytes);
    const result=env.host_gl_query(7,O.KERNEL_GL_QUERY_CONTROL,p(1024),p(bytes.length),p(2048),p(32+capacity),11);
    return result<0?{error:result}:decodeQueryReply(new Uint8Array(memory.buffer,2048,result),
      {control:request.control,token:request.token,capacity,...(mode?{retirementMode:mode}:{})});
  };
  const begin=(token=1n)=>({control:"begin",token,begin:{op:O.QOP_FINISH,input:new Uint8Array(),capacity:0,
    hasCurrent:true,context:21,draw:0,read:0}} as const);
  const drain=()=>{kernel.drainGlQueryControls(16);dispose.ownedQueries!.drain(16);kernel.drainGlQueryControls(16);};
  const submit=()=>{const bytes=new Uint8Array(memory.buffer,32768,8),v=new DataView(bytes.buffer,bytes.byteOffset,8);
    v.setUint16(0,O.OP_CLEAR,true);v.setUint16(2,4,true);v.setUint32(4,0x4000,true);return env.host_gl_submit(7,p(0),p(8),11);};
  return {kernel,memory,env,p,client,sender,receiver,dispose,retirements,invoke,begin,drain,submit,log,live,legacyQuery,wakes,ownerWakes,channel,gl,block:(value:boolean)=>{blocked=value;}};
}
it.each([4,8] as const)("routes private owned controls through the real %s-byte kernel import and paired receiver",width=>{
  const f=fixture(width);expect(f.submit()).toBe(0);expect(f.invoke(f.begin())).toEqual({phase:"pending"});
  expect(f.log).toEqual(["clear"]);f.drain();expect(f.invoke({control:"poll",token:1n})).toEqual({phase:"ready",result:0,bytes:new Uint8Array()});
  expect(f.log).toEqual(["clear","finish"]);expect(f.legacyQuery).not.toHaveBeenCalled();
  expect(f.invoke({control:"commit",token:1n},0,"commit")).toEqual({phase:"retiring",mode:"commit"});f.drain();
  expect(f.invoke({control:"commit",token:1n},0,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});f.dispose();
});

it("holds a void context retirement behind an unsent query and authenticates actual failed cleanup",()=>{
  const f=fixture(4);expect(f.invoke(f.begin())).toEqual({phase:"pending"});
  f.env.host_gl_destroy_context(7,21);expect(f.kernel.gl.get(7,11)?.contextId).toBeNull();
  expect(f.sender.sent.some(m=>m.type==="gl_forward_destroy_context")).toBe(false);
  expect(f.submit()).toBe(-16);expect(f.env.host_gl_create_context(7,22,0,0,11)).toBe(-16);
  expect(f.channel.onCreateContext(12,undefined,22)).toBe(-16);
  f.drain();expect(f.invoke({control:"poll",token:1n}).phase).toBe("ready");expect(f.log).toEqual(["finish"]);
  f.block(true);expect(f.invoke({control:"cancel",token:1n},0,"cancel")).toEqual({phase:"retiring",mode:"cancel"});f.drain();
  expect(f.invoke({control:"cancel",token:1n},0,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.client.hasBarrier(11)).toBe(true);expect(f.live.size).toBeGreaterThan(0);
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(false);expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(false);
  f.block(false);f.drain();expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(true);
  f.env.host_gl_unbind(7,11);f.drain();
  expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(true);f.dispose();expect(f.retirements.retainedEndpoints).toBe(0);
});

it("retries a lost scalar cleanup ACK without deleting twice or releasing the source early",()=>{
  const f=fixture(4);f.invoke(f.begin());f.drain();f.invoke({control:"poll",token:1n});f.invoke({control:"cancel",token:1n},0,"cancel");f.drain();
  f.env.host_gl_destroy_context(7,21);
  f.receiver.drop=m=>m.type==="gl_owned_retired" && m.complete;
  f.kernel.drainGlQueryControls(16);expect(f.client.hasBarrier(11)).toBe(true);expect(f.env.host_gl_create_context(7,22,0,0,11)).toBe(-16);
  const deletes=f.live.size;f.receiver.drop=null;f.drain();expect(f.live.size).toBe(deletes);expect(f.client.hasBarrier(11)).toBe(false);
  expect(f.env.host_gl_create_context(7,22,0,0,11)).toBe(0);f.dispose();
});

it("keeps the real shutdown receiver alive after disposal with a delayed scalar intent",()=>{
  const f=fixture(4);f.invoke(f.begin());f.env.host_gl_destroy_context(7,21);f.block(true);f.dispose();
  expect(f.retirements.retainedEndpoints).toBe(1);expect(f.receiver.listeners.size).toBe(1);
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(false);
  f.block(false);f.drain();f.drain();
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(true);
  f.env.host_gl_unbind(7,11);f.drain();f.drain();expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(true);
  expect(f.retirements.retainedEndpoints).toBe(0);expect(f.receiver.listeners.size).toBe(0);
});

it.each([4,8] as const)("preflights the complete copied %s-byte Rust reply before opening a forwarded owner",width=>{
  const f=fixture(width),register=vi.spyOn(f.client,"register");
  const request={...f.begin(),begin:{...f.begin().begin,op:O.QOP_GET_ERROR,capacity:4}},bytes=encodeQueryRequest(request);
  new Uint8Array(f.memory.buffer,1024,bytes.length).set(bytes);
  expect(f.env.host_gl_query(7,O.KERNEL_GL_QUERY_CONTROL,f.p(1024),f.p(bytes.length),f.p(f.memory.buffer.byteLength-32),f.p(36),11)).toBe(-14);
  expect(f.env.host_gl_query(7,O.KERNEL_GL_QUERY_CONTROL,f.p(1024),f.p(bytes.length),f.p(2048),f.p(32),11)).toBe(-22);
  expect(register).not.toHaveBeenCalled();expect(f.sender.sent.some(m=>m.type==="gl_owned_open")).toBe(false);f.dispose();
});

it("retains the cached owner when a duplicate Begin changes its frozen source header",()=>{
  const f=fixture(4);f.invoke(f.begin());
  expect(f.invoke({...f.begin(),begin:{...f.begin().begin,context:99}})).toEqual({error:-22});
  f.drain();expect(f.invoke({control:"poll",token:1n})).toMatchObject({phase:"ready",result:0});
  f.invoke({control:"cancel",token:1n},0,"cancel");f.drain();expect(f.invoke({control:"cancel",token:1n},0,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});f.dispose();
});

it("keeps uncertain Begin and Commit responses owned through the actual kernel import",()=>{
  const f=fixture(4);f.receiver.drop=m=>m.type==="gl_owned_reply" && m.control==="begin";
  expect(f.invoke(f.begin())).toEqual({phase:"pending"});f.drain();
  f.receiver.drop=null;f.drain();expect(f.invoke({control:"poll",token:1n})).toMatchObject({phase:"ready",result:0});
  f.receiver.drop=m=>m.type==="gl_owned_reply" && m.control==="commit";
  expect(f.invoke({control:"commit",token:1n},0,"commit")).toEqual({phase:"retiring",mode:"commit"});f.drain();
  expect(f.invoke({control:"commit",token:1n},0,"commit")).toEqual({phase:"retiring",mode:"commit"});expect(f.submit()).toBe(-16);
  f.receiver.drop=null;f.drain();expect(f.invoke({control:"commit",token:1n},0,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  expect(f.log.filter(x=>x==="finish")).toHaveLength(1);expect(f.submit()).toBe(0);f.dispose();
});

it("preserves prepared GET_ERROR across a failed fresh reply span and cancellation",()=>{
  const f=fixture(4),mask=new Uint8Array(4);new DataView(mask.buffer).setUint32(0,1,true);
  const request=(token:bigint,input=new Uint8Array())=>({control:"begin",token,begin:{...f.begin().begin,op:O.QOP_GET_ERROR,input,capacity:4}} as const);
  f.invoke(request(1n,mask),4);f.drain();const ready=f.invoke({control:"poll",token:1n},4);
  if(!("phase" in ready) || ready.phase!=="ready")throw new Error("missing prepared error");expect(new DataView(ready.bytes.buffer).getUint32(0,true)).toBe(0x500);
  const poll=encodeQueryRequest({control:"poll",token:1n});new Uint8Array(f.memory.buffer,1024,poll.length).set(poll);
  expect(f.env.host_gl_query(7,O.KERNEL_GL_QUERY_CONTROL,1024,poll.length,f.memory.buffer.byteLength-32,36,11)).toBe(-14);
  f.invoke({control:"cancel",token:1n},4,"cancel");f.drain();f.invoke(request(2n),4);f.drain();
  const retry=f.invoke({control:"poll",token:2n},4);if(!("phase" in retry) || retry.phase!=="ready")throw new Error("missing preserved flag");
  expect(new DataView(retry.bytes.buffer).getUint32(0,true)).toBe(0x500);f.invoke({control:"commit",token:2n},4,"commit");f.drain();f.dispose();
});

it("notifies exact owner authority after the last query Forget and ignores stale scalar ACKs",()=>{
  const f=fixture(4);f.invoke(f.begin());f.drain();f.invoke({control:"poll",token:1n});f.invoke({control:"cancel",token:1n},0,"cancel");f.drain();
  expect(f.invoke({control:"cancel",token:1n},0,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  f.invoke({control:"forget",token:1n},0,"cancel");expect(f.client.pendingRequests).toBe(0);
  f.env.host_gl_destroy_context(7,21);f.receiver.drop=m=>m.type==="gl_owned_retired" && m.complete;f.drain();
  expect(f.ownerWakes).toEqual([]);const tokenWakes=f.wakes.length;
  const ack=f.receiver.sent.findLast(m=>m.type==="gl_owned_retired" && m.complete)!;expect(ack).toBeDefined();
  f.sender.fire({...ack,registration:ack.registration+1});f.sender.fire({...ack,source:ack.source+1});expect(f.ownerWakes).toEqual([]);
  f.sender.fire(ack);expect(f.ownerWakes).toHaveLength(1);expect(f.ownerWakes[0]).toEqual([7,11,f.wakes[0][2]]);expect(f.wakes).toHaveLength(tokenWakes);
  f.sender.fire(ack);expect(f.ownerWakes).toHaveLength(1);
  const owner=f.client.register(11,f.kernel.gl.get(7,11)!.operations)!,late:unknown[][]=[];
  expect(f.client.watchOwner(owner,(...args:unknown[])=>late.push(args))).toBe(true);expect(late).toEqual([[7,11,owner.registration]]);f.dispose();
});

it("keeps central lifecycle metadata until a delayed authenticated owner cleanup ACK arrives",()=>{
  const f=fixture(4);f.invoke(f.begin());f.drain();f.invoke({control:"poll",token:1n});f.invoke({control:"cancel",token:1n},0,"cancel");f.drain();
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(true);f.env.host_gl_unbind(7,11);f.drain();
  f.receiver.drop=m=>m.type==="gl_owned_owner_forgotten";
  expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(false);
  const ack=f.receiver.sent.findLast(m=>m.type==="gl_owned_owner_forgotten")!;expect(ack).toBeDefined();
  f.sender.fire({...ack,registration:ack.registration+1});expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(false);
  f.sender.fire(ack);expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(true);f.dispose();expect(f.retirements.retainedEndpoints).toBe(0);
});

it("mints a fresh registration for a replacement client and ignores old authenticated notifications",()=>{
  const f=fixture(4);f.invoke(f.begin());f.drain();f.invoke({control:"poll",token:1n});f.invoke({control:"cancel",token:1n},0,"cancel");f.drain();
  const oldRegistration=f.wakes[0][2] as number;f.env.host_gl_destroy_context(7,21);f.drain();
  const oldAck=f.receiver.sent.findLast(m=>m.type==="gl_owned_retired" && m.complete)!;
  f.kernel.prepareGlQueryControlTeardown(7);f.env.host_gl_unbind(7,11);f.drain();expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(true);
  expect(f.client.dispose()).toBe(true);
  const replacement=new GlOwnedForwardClient(f.sender,7,limits,(...args:unknown[])=>f.wakes.push(args));
  const channel=createMainForwardChannel(f.sender,7,0,replacement);f.kernel.gl.attachMainForward(7,channel);
  f.env.host_gl_bind(7,32768,4096,11,1n);expect(f.env.host_gl_create_context(7,22,0,0,11)).toBe(0);expect(f.env.host_gl_make_current(7,22,0,0,11)).toBe(0);
  expect(f.invoke({...f.begin(2n),begin:{...f.begin(2n).begin,context:22}})).toEqual({phase:"pending"});f.drain();
  expect(f.invoke({control:"poll",token:2n})).toMatchObject({phase:"ready",result:0});
  const newRegistration=f.wakes.at(-1)![2] as number;expect(newRegistration).toBeGreaterThan(oldRegistration);
  const notifications=f.ownerWakes.length;f.sender.fire(oldAck);expect(f.ownerWakes).toHaveLength(notifications);
  expect(f.invoke({control:"cancel",token:2n},0,"cancel")).toEqual({phase:"retiring",mode:"cancel"});f.drain();f.dispose();
});

it("does not coalesce distinct scalar source identities and refuses all unsupported later admission",()=>{
  const f=fixture(4);f.invoke(f.begin());f.env.host_gl_destroy_context(7,21);
  expect(f.client.queueRetirement(11,"context",22)).toBe(false);expect(f.env.host_gl_create_context(7,22,0,0,11)).toBe(-16);
  expect(f.submit()).toBe(-16);expect(f.channel.onPresent!(11)).toBe(-16);expect(f.channel.onMakeCurrent!({drawSurfaceId:0,readSurfaceId:0,width:0,height:0},11)).toBe(-16);
  expect(f.channel.onQuery!(O.QOP_FINISH,new Uint8Array(),0,11)).toEqual({rc:-16,bytes:new Uint8Array()});
  expect(f.invoke(f.begin(2n))).toEqual({phase:"rejected",error:16});expect(f.sender.sent.some(m=>m.type==="gl_owned_control")).toBe(false);
  f.kernel.prepareGlQueryControlTeardown(7);f.drain();f.drain();f.env.host_gl_unbind(7,11);f.drain();f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7);f.dispose();
});

it("retains the actual legacy receiver until a delayed endpoint closing acknowledgement",()=>{
  const f=fixture(4);f.invoke(f.begin());f.drain();f.invoke({control:"cancel",token:1n},0,"cancel");f.drain();
  expect(f.invoke({control:"cancel",token:1n},0,"cancel")).toMatchObject({phase:"retired"});
  f.receiver.drop=m=>m.type==="gl_owned_endpoint_closing";
  f.dispose();expect(f.receiver.listeners.size).toBe(2);expect(f.retirements.retainedEndpoints).toBe(1);
  expect(f.submit()).toBe(0);expect(f.log.filter(value=>value==="clear")).toHaveLength(1);
  const notice=f.receiver.sent.findLast(m=>m.type==="gl_owned_endpoint_closing")!;
  f.sender.fire({...notice,endpointRegistration:notice.endpointRegistration+1});expect(f.submit()).toBe(0);
  f.block(true);f.sender.fire(notice);
  expect(f.submit()).toBe(-16);expect(f.receiver.listeners.size).toBe(1);
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(false);
  f.block(false);f.receiver.drop=null;f.drain();f.drain();
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(true);
  f.env.host_gl_unbind(7,11);f.drain();expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(true);
  expect(f.retirements.retainedEndpoints).toBe(0);expect(f.receiver.listeners.size).toBe(0);
});

it("refuses associated legacy admission until the actual endpoint grant arrives",()=>{
  const f=fixture(4);f.invoke(f.begin());
  const other=new Endpoint();other.other=f.receiver;f.receiver.other=other;
  const client=new GlOwnedForwardClient(other,7,limits,()=>{}),channel=createMainForwardChannel(other,7,0,client);
  // A replacement cannot acquire this existing endpoint's authority while its
  // old native owner is live; its unacknowledged calls have zero effects.
  expect(channel.onCreateContext(12,undefined,22)).toBe(-16);
  expect(()=>channel.onSubmit(new Uint8Array(),12)).toThrow();
  expect(other.sent.some(m=>m.type==="gl_forward_submit" || m.type==="gl_forward_create_context")).toBe(false);
});


it("preserves an actual branded kernel export failure through the private native control import",()=>{
  const memory=new WebAssembly.Memory({initial:1,maximum:1});
  const raw=createKernelScratchTestInstance(4,memory,()=>({kernel_handle_channel:()=>{throw new Error("actual export failed");}}),()=>4096);
  const gated=createKernelEntryGatedInstance(raw,new KernelEntryGate());let fatal:unknown;
  try {(gated.exports.kernel_handle_channel as (offset:number)=>number)(0);}catch(error){fatal=error;}
  expect(isKernelExportFailure(fatal)).toBe(true);
  const f=fixture(4),binding=f.kernel.gl.get(7,11)!;binding.forward=null;binding.gl=f.gl;
  const control=vi.spyOn(GlNativeQueryAdapter.prototype,"control").mockImplementation(()=>{throw fatal;});
  try {expect(()=>f.invoke(f.begin())).toThrow(fatal as Error);}finally{control.mockRestore();f.dispose();}
});

it("retains typed shutdown custody for a legacy-only session without a query registration",()=>{
  const f=fixture(4);expect(f.sender.sent.some(m=>m.type==="gl_owned_open")).toBe(false);
  f.block(true);f.dispose();expect(f.submit()).toBe(-16);
  expect(f.retirements.retainedEndpoints).toBe(1);expect(f.receiver.listeners.size).toBe(1);expect(f.live.size).toBeGreaterThan(0);
  f.block(false);f.retirements.drain(1);expect(f.live.size).toBe(0);
  expect(f.retirements.retainedEndpoints).toBe(0);expect(f.receiver.listeners.size).toBe(0);
});

it("keeps endpoint cleanup proof and listener ownership through a lost release acknowledgement",()=>{
  const f=fixture(4);f.block(true);
  expect(f.client.dispose()).toBe(false);expect(f.client.legacyReady()).toBe(false);
  expect(f.live.size).toBeGreaterThan(0);expect(f.sender.listeners.size).toBe(1);
  f.receiver.drop=m=>m.type==="gl_owned_endpoint_released";
  f.block(false);f.dispose.ownedQueries!.drain(1);expect(f.live.size).toBe(0);
  expect(f.client.dispose()).toBe(false);f.dispose();expect(f.retirements.retainedEndpoints).toBe(1);
  const released=f.receiver.sent.findLast(m=>m.type==="gl_owned_endpoint_released")!;
  f.sender.fire({...released,epoch:released.epoch+1});expect(f.client.dispose()).toBe(false);
  f.sender.fire(released);expect(f.client.dispose()).toBe(true);
  expect(f.retirements.retainedEndpoints).toBe(0);expect(f.receiver.listeners.size).toBe(0);
});
