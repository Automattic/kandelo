import { expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GbmBoRegistry } from "../src/dri/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";
import { encodeQueryRequest, decodeQueryReply, type QueryControl, type QueryMode, type QueryReceiptReply } from "../src/webgl/query-receipt-codec.js";
import * as O from "../src/webgl/ops.js";

async function fixture(limits={maxOwners:4,maxRequests:8,maxRetainedBytes:1024}) {
  let serial=0, blocked=false, selected: object|null=null;
  const flags:number[]=[], live=new Set<object>(), reads:object[]=[];
  const make=()=>{const handle={serial:++serial};live.add(handle);return handle;};
  const remove=(handle:object)=>{if(blocked)throw new Error("delete blocked");live.delete(handle);};
  const gl=new Proxy({getError:()=>flags.shift()??0,isContextLost:()=>false,
    getParameter:(p:number)=>p===0x84e0?0x84c0:p===0x0d33?4096:0,
    checkFramebufferStatus:()=>0x8cd5,getSyncParameter:()=>0x9119,
    createTexture:make,createFramebuffer:make,createRenderbuffer:make,createVertexArray:make,fenceSync:make,
    deleteTexture:remove,deleteFramebuffer:remove,deleteRenderbuffer:remove,deleteVertexArray:remove,deleteSync:remove,
    bindFramebuffer:(target:number,value:object|null)=>{if(target!==0x8ca9)selected=value;},
    readPixels:(_x:number,_y:number,_w:number,_h:number,_format:number,_type:number,out:Uint8Array)=>{reads.push(selected!);out.fill((selected as {serial?:number})?.serial??0);},
  },{get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry();registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const binding=registry.get(7,11)!;binding.gl=gl;binding.contextId=1;binding.surfaceId=31;
  resizeSurfaceTarget(binding,4,3);applyCurrentDrawable(binding,{drawSurfaceId:31,readSurfaceId:31,width:4,height:3});
  const muxer=new GlMuxer(gl), muxers=new WeakMap([[gl,muxer]]), wakes:unknown[][]=[];
  const {GlNativeQueryAdapter}=await import("../src/webgl/native-query-adapter.js");
  const adapter=new GlNativeQueryAdapter(registry,new GbmBoRegistry(),muxers,limits,(...args:unknown[])=>wakes.push(args));
  const owner=adapter.register(7,11)!;
  const begin=(token:bigint,op:number,input=new Uint8Array(),capacity=0)=>adapter.control(owner,encodeQueryRequest({control:"begin",token,
    begin:{op,input,capacity,hasCurrent:true,context:1,draw:31,read:31}}));
  const control=(token:bigint,control:QueryControl,capacity=0,mode?:QueryMode):QueryReceiptReply=>{
    const result=adapter.control(owner,encodeQueryRequest({control,token}));
    if("error" in result)throw new Error(`control error ${result.error}`);
    return decodeQueryReply(result.bytes,{control,token,capacity,...(mode?{retirementMode:mode}:{})});
  };
  return {registry,binding,gl,muxer,adapter,owner,begin,control,reads,flags,live,wakes,block:(v:boolean)=>{blocked=v;}};
}
const words=(...values:number[])=>{const bytes=new Uint8Array(values.length*4),v=new DataView(bytes.buffer);values.forEach((x,i)=>v.setUint32(i*4,x,true));return bytes;};

it("holds a copied query behind accepted commands and reads original storage after resize/current replacement", async()=>{
  const f=await fixture(), prefix=f.binding.operations.reserve("commands")!, old=f.binding.presentTarget!;
  const input=words(0,0,1,1,0x1908,0x1401);
  expect(f.begin(1n,O.QOP_READ_PIXELS,input,4)).toHaveProperty("bytes"); input.fill(255);
  resizeSurfaceTarget(f.binding,8,6);
  expect(f.control(1n,"poll",4)).toEqual({phase:"pending"});f.adapter.drain(8);expect(f.reads).toEqual([]);
  prefix.start();prefix.finish();f.adapter.drain(8);
  expect(f.reads).toEqual([old.fbo]); const result=f.control(1n,"poll",4);expect(result.phase).toBe("ready");
  f.adapter.drain(8);expect(f.reads).toHaveLength(1);
  expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});f.registry.unbind(7);
});

it("consumes a prepared GL error only at Commit across lost Ready/retry and copyout-fault cancellation", async()=>{
  const f=await fixture();f.muxer.switchTo(f.binding);f.binding.errors.push(0x501);f.flags.push(0x500);
  f.begin(1n,O.QOP_GET_ERROR,new Uint8Array(),4);f.adapter.drain(4);
  const result=f.control(1n,"poll",4);expect(result).toEqual(f.control(1n,"poll",4));
  if(result.phase!=="ready")throw new Error("missing result");expect(new DataView(result.bytes.buffer).getUint32(0,true)).toBe(0x501);
  expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  f.begin(2n,O.QOP_GET_ERROR,new Uint8Array(),4);f.adapter.drain(4);
  const next=f.control(2n,"poll",4);if(next.phase!=="ready")throw new Error("missing result");
  expect(new DataView(next.bytes.buffer).getUint32(0,true)).toBe(0x501);
  f.control(2n,"commit",4,"commit");f.control(2n,"commit",4,"commit");
  f.begin(3n,O.QOP_GET_ERROR,new Uint8Array(),4);f.adapter.drain(4);
  const third=f.control(3n,"poll",4);if(third.phase!=="ready")throw new Error("missing result");
  expect(new DataView(third.bytes.buffer).getUint32(0,true)).toBe(0x500);f.registry.unbind(7);
});

it("does not publish native fence creation until copyout Commit and retains cleanup failures", async()=>{
  const f=await fixture(), deletion=vi.spyOn(f.gl,"deleteSync");
  f.begin(1n,O.QOP_CREATE_FENCE,words(9),16);f.adapter.drain(4);
  expect(f.binding.fences.has(9)).toBe(false);expect(f.control(1n,"poll",16).phase).toBe("ready");
  f.block(true);expect(f.control(1n,"cancel",16,"cancel")).toEqual({phase:"retiring",mode:"cancel"});
  expect(f.adapter.retainedBytes).toBe(36);expect(f.live.has(deletion.mock.calls[0][0]!)).toBe(true);
  f.block(false);f.adapter.drain(4);
  expect(f.control(1n,"cancel",16,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.binding.fences.has(9)).toBe(false);expect(f.adapter.retainedBytes).toBe(0);f.registry.unbind(7);
});


it("uses independent exact source fence authority after current/context retirement",async()=>{
  const f=await fixture();f.begin(1n,O.QOP_CREATE_FENCE,words(12),16);f.adapter.drain(4);f.control(1n,"commit",16,"commit");
  f.registry.destroyContext(7,11);
  const bytes=encodeQueryRequest({control:"begin",token:2n,begin:{op:O.QOP_FENCE_STATUS,input:words(12),capacity:16,
    hasCurrent:false,context:1,draw:0,read:0}});
  expect(f.adapter.control(f.owner,bytes)).toHaveProperty("bytes");f.adapter.drain(4);
  const result=f.control(2n,"poll",16);expect(result.phase).toBe("ready");
  if(result.phase!=="ready")throw new Error("missing fence status");expect(new DataView(result.bytes.buffer).getUint32(8,true)).toBe(1);
  f.control(2n,"cancel",16,"cancel");expect(f.binding.fences.has(12)).toBe(true);f.registry.unbind(7);
});

it("keeps failed-admission rollback custody charged until actual native cleanup and ACK",async()=>{
  const f=await fixture(), texture=f.gl.createTexture()!;f.binding.textures.set(7,texture);
  vi.spyOn(f.binding.operations,"reserve").mockImplementationOnce(()=>{f.registry.destroyContext(7,11);f.block(true);return null;});
  const result=f.begin(1n,O.QOP_GET_ERROR,new Uint8Array(),4);expect(result).toHaveProperty("bytes");
  expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retiring",mode:"cancel"});
  expect(f.adapter.pendingRequests).toBe(1);expect(f.live.has(texture)).toBe(true);
  f.block(false);f.adapter.drain(4);
  expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.live.has(texture)).toBe(false);expect(f.adapter.pendingRequests).toBe(1);
  expect(f.control(1n,"forget",4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.adapter.pendingRequests).toBe(0);f.registry.unbind(7);
});

it("rotates bounded visits past blocked owner heads so runnable peers progress",async()=>{
  const f=await fixture(), prefix=f.binding.operations.reserve("commands")!;
  f.begin(1n,O.QOP_GET_ERROR,new Uint8Array(),4);
  f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0});const peer=f.registry.get(7,12)!;
  peer.gl=f.gl;peer.contextId=2;peer.surfaceId=41;resizeSurfaceTarget(peer,2,2);
  applyCurrentDrawable(peer,{drawSurfaceId:41,readSurfaceId:41,width:2,height:2});const owner=f.adapter.register(7,12)!;
  const input=encodeQueryRequest({control:"begin",token:1n,begin:{op:O.QOP_GET_ERROR,input:new Uint8Array(),capacity:4,
    hasCurrent:true,context:2,draw:41,read:41}});
  f.adapter.control(owner,input);f.adapter.drain(1);expect(f.wakes).toEqual([]);f.adapter.drain(1);
  expect(f.wakes).toEqual([[7,12,owner.registration,1n]]);expect(f.control(1n,"poll",4)).toEqual({phase:"pending"});
  prefix.start();prefix.finish();f.adapter.retireOwner(f.owner);f.adapter.retireOwner(owner);f.registry.unbind(7);
});

it("acknowledges retirement once, keeps only bounded terminal metadata, and clears it on closed-owner teardown",async()=>{
  const f=await fixture(), texture=f.gl.createTexture()!;f.binding.textures.set(7,texture);
  f.begin(1n,O.QOP_GET_ERROR,new Uint8Array(),4);f.adapter.drain(4);f.registry.destroyContext(7,11);
  const ack={phase:"retired",mode:"commit",accepted:true};
  expect(f.control(1n,"commit",4,"commit")).toEqual(ack);expect(f.control(1n,"commit",4,"commit")).toEqual(ack);
  expect(f.adapter.retainedBytes).toBe(0);expect(f.live.has(texture)).toBe(false);expect(f.adapter.pendingRequests).toBe(1);
  f.adapter.retireOwner(f.owner);expect(f.adapter.forgetOwner(f.owner)).toBe(true);expect(f.adapter.pendingRequests).toBe(0);
  expect(f.adapter.control(f.owner,encodeQueryRequest({control:"poll",token:1n}))).toHaveProperty("error");f.registry.unbind(7);
});

it("merges fallback C flags and interrupts a pending uniform transaction before preparing its error result",async()=>{
  const f=await fixture();f.binding.uniformUpload={payload:new Uint8Array([1,2,3])} as unknown as NonNullable<typeof f.binding.uniformUpload>;
  const input=words((1<<1)|(1<<2));
  expect(f.begin(1n,O.QOP_GET_ERROR,input,4)).toHaveProperty("bytes");expect(f.binding.uniformUpload).not.toBeNull();
  f.adapter.drain(4);expect(f.binding.uniformUpload).toBeNull();expect(f.binding.errors).toEqual([0x502,0x501]);
  const result=f.control(1n,"poll",4);if(result.phase!=="ready")throw new Error("missing error");
  expect(new DataView(result.bytes.buffer).getUint32(0,true)).toBe(0x502);
  f.control(1n,"cancel",4,"cancel");expect(f.binding.errors).toEqual([0x502,0x501]);f.registry.unbind(7);
});


it("publishes a prepared error once despite lost ACK and failing old-context cleanup",async()=>{
  const f=await fixture(), texture=f.gl.createTexture()!, queue=f.binding.errors;
  f.binding.textures.set(7,texture);queue.push(0x501);
  f.begin(1n,O.QOP_GET_ERROR,new Uint8Array(),4);f.adapter.drain(4);f.registry.destroyContext(7,11);f.block(true);
  expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retiring",mode:"commit"});expect(queue).not.toContain(0x501);
  const afterFailure=[...queue];queue.push(0x500);f.block(false);
  const ack={phase:"retired",mode:"commit",accepted:true};
  expect(f.control(1n,"commit",4,"commit")).toEqual(ack);expect(f.control(1n,"commit",4,"commit")).toEqual(ack);
  expect(queue).toEqual([...afterFailure,0x500]);expect(f.live.has(texture)).toBe(false);
  expect(f.control(1n,"forget",4,"commit")).toEqual(ack);
  expect(f.adapter.control(f.owner,encodeQueryRequest({control:"forget",token:1n}))).toHaveProperty("error");f.registry.unbind(7);
});

it("rejects malformed masks, unsupported mutations and physical reentry before any native error consumption",async()=>{
  const f=await fixture(), nativeErrors=vi.spyOn(f.gl,"getError");f.binding.errors.push(0x501);
  const invalid=f.begin(1n,O.QOP_GET_ERROR,words(8),4);expect(invalid).toHaveProperty("bytes");
  expect(f.begin(2n,O.QOP_IMAGE_TARGET,words(1,1,1),12)).toHaveProperty("bytes");
  expect(nativeErrors).not.toHaveBeenCalled();expect(f.binding.errors).toEqual([0x501]);expect(f.adapter.pendingRequests).toBe(0);
  const {runGlRendererOperation}=await import("../src/webgl/submit-drain.js");
  runGlRendererOperation(f.muxer,()=>{
    expect(f.adapter.preentry(f.owner,{op:O.QOP_GET_ERROR,input:new Uint8Array(),capacity:4,hasCurrent:true,context:1,draw:31,read:31}))
      .toEqual({state:"terminal",error:5});
  });
  expect(nativeErrors).not.toHaveBeenCalled();f.registry.unbind(7);
});

it("keeps only preentry forward refusal and sends no synchronous forward query",async()=>{
  const f=await fixture(), onQuery=vi.fn();f.binding.forward={onQuery} as unknown as NonNullable<typeof f.binding.forward>;
  expect(f.adapter.preentry(f.owner,{op:O.QOP_GET_ERROR,input:new Uint8Array(),capacity:4,hasCurrent:true,context:1,draw:31,read:31}))
    .toEqual({state:"owned-required",reason:"forward-only"});
  expect(f.begin(1n,O.QOP_GET_ERROR,new Uint8Array(),4)).toHaveProperty("bytes");
  expect(onQuery).not.toHaveBeenCalled();expect(f.adapter.pendingRequests).toBe(0);f.binding.forward=null;f.registry.unbind(7);
});


it("rejects malformed read-only query spans before a busy prefix can admit owned work",async()=>{
  const f=await fixture(), prefix=f.binding.operations.reserve("commands")!;
  const result=f.begin(1n,O.QOP_READ_PIXELS,new Uint8Array(),4);if("error" in result)throw new Error("missing rejection");
  expect(decodeQueryReply(result.bytes,{control:"begin",token:1n,capacity:4})).toEqual({phase:"rejected",error:22});
  expect(f.adapter.pendingRequests).toBe(0);expect(f.reads).toEqual([]);prefix.cancel();f.registry.unbind(7);
});
