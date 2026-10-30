import { expect, it, vi } from "vitest";
import { GlContextExecutionLease, GlContextRegistry } from "../src/webgl/registry.js";
import { GbmBoRegistry } from "../src/dri/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";
import { encodeQueryRequest, decodeQueryReply, type QueryControl, type QueryMode, type QueryReceiptReply } from "../src/webgl/query-receipt-codec.js";
import { publishedUniformLocation } from "../src/webgl/object-group.js";
import { linkProgramRetainingExecutable } from "../src/webgl/program-objects.js";
import { GlNativeResultCustody } from "../src/webgl/owned-result.js";
import { prepareGlUniformQuery } from "../src/webgl/uniform-query-candidate.js";
import { KernelEntryGate } from "../src/kernel-entry-gate.js";
import * as O from "../src/webgl/ops.js";

async function fixture(limits={maxOwners:4,maxRequests:8,maxRetainedBytes:1024}) {
  let serial=0, blocked=false, selected: object|null=null, currentProgram:object|null=null;
  const uniformReads:{program:object;name:string}[]=[],deletedPrograms:object[]=[];
  const flags:number[]=[], live=new Set<object>(), reads:object[]=[];
  const make=()=>{const handle={serial:++serial};live.add(handle);return handle;};
  const remove=(handle:object)=>{if(blocked)throw new Error("delete blocked");live.delete(handle);};
  const gl=new Proxy({getError:()=>flags.shift()??0,isContextLost:()=>false,
    getParameter:(p:number)=>p===0x8b8d?currentProgram:p===0x84e0?0x84c0:p===0x0d33?4096:0,
    createProgram:make,linkProgram:()=>{},useProgram:(program:object|null)=>{currentProgram=program;},
    deleteProgram:(program:object)=>{remove(program);deletedPrograms.push(program);},
    getProgramParameter:(_program:object,p:number)=>p===0x8b82?true:p===0x8b86?1:0,
    getActiveUniform:()=>({name:"color",size:1,type:0x1406}),
    getUniformLocation:(program:object,name:string)=>{uniformReads.push({program,name});return name==="color"?{program,name}:null;},
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
  return {registry,binding,gl,muxer,adapter,owner,begin,control,reads,flags,live,wakes,uniformReads,deletedPrograms,block:(v:boolean)=>{blocked=v;}};
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


async function uniformFixture() {
  const f=await fixture({maxOwners:4,maxRequests:16,maxRetainedBytes:4096});
  const program=f.gl.createProgram()!;f.binding.programs.set(20,program);
  f.binding.programShaders.set(20,new Set());
  const single=(name="color")=>{const text=new TextEncoder().encode(name),input=new Uint8Array(8+text.length);input.set(words(20,text.length));input.set(text,8);return input;};
  const lookup=(action:number,token:number,arg=0,text="")=>{
    const bytes=new TextEncoder().encode(text),input=new Uint8Array(16+bytes.length);
    input.set(words(action,20,token,arg));input.set(bytes,16);return input;
  };
  const ready=(token:bigint,capacity:number)=>{
    const result=f.control(token,"poll",capacity);if(result.phase!=="ready")throw new Error(`missing uniform Ready: ${result.phase}`);return result;
  };
  const peer=()=>{
    f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0});const peer=f.registry.get(7,12)!;
    peer.gl=f.gl;peer.contextId=2;expect(f.registry.shareObjects(7,12,11)).toBe(true);return peer;
  };
  return {...f,program,single,lookup,ready,peer};
}
const scalar=(bytes:Uint8Array,offset=0)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getInt32(offset,true);

it("prepares uniform native reads once and publishes only after copyout Commit with stable lost ACK",async()=>{
  const f=await uniformFixture(),input=f.single();
  f.begin(1n,O.QOP_GET_UNIFORM_LOC,input,4);input.fill(255);f.adapter.drain(16);
  const ready=f.ready(1n,4),index=scalar(ready.bytes);
  expect(ready.result).toBe(4);expect(f.uniformReads).toEqual([{program:f.program,name:"color"}]);
  expect(publishedUniformLocation(f.binding,index)).toBeUndefined();expect(f.binding.nextUniformLoc).toBe(0);
  expect(f.binding.programQueryPins.get(f.program)).toBe(1);expect(f.binding.uniformLookupBudget.used).toBeGreaterThan(0);
  expect(f.control(1n,"poll",4)).toEqual(ready);f.adapter.drain(16);expect(f.uniformReads).toHaveLength(1);
  const ack={phase:"retired",mode:"commit",accepted:true};
  expect(f.control(1n,"commit",4,"commit")).toEqual(ack);expect(f.control(1n,"commit",4,"commit")).toEqual(ack);
  expect(publishedUniformLocation(f.binding,index)?.metadata.executable).toBe(f.program);
  expect(f.binding.programQueryPins.size).toBe(0);expect(f.binding.uniformLookupBudget.used).toBe(0);
  expect(f.uniformReads).toHaveLength(1);f.registry.unbind(7);
});

it("cancels a copied uniform result without exposing or burning a location index",async()=>{
  const f=await uniformFixture();f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);
  const index=scalar(f.ready(1n,4).bytes);
  expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.binding.uniformLocationRecords.size).toBe(0);expect(f.binding.nextUniformLoc).toBe(0);
  expect(f.binding.programQueryPins.size).toBe(0);expect(f.binding.uniformLookupBudget.used).toBe(0);
  f.begin(2n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);expect(scalar(f.ready(2n,4).bytes)).toBe(index);
  f.control(2n,"commit",4,"commit");f.registry.unbind(7);
});

it.each(["commit","cancel"] as const)("retains failed native uniform pin cleanup through %s and retries without another lookup",async mode=>{
  const f=await uniformFixture();f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);f.ready(1n,4);
  const peer=f.peer();f.muxer.switchTo(peer);linkProgramRetainingExecutable(peer,20);
  expect(f.binding.programs.get(20)).not.toBe(f.program);f.flags.push(0x500);f.block(true);
  expect(f.control(1n,mode,4,mode)).toEqual({phase:"retiring",mode});
  expect(peer.errors).toEqual([0x500]);expect(f.binding.errors).toContain(0x502);
  expect(f.binding.programQueryPins.get(f.program)).toBe(1);expect(f.live.has(f.program)).toBe(true);
  expect(f.adapter.retainedBytes).toBeGreaterThan(0);expect(f.binding.uniformLookupBudget.used).toBeGreaterThan(0);
  f.block(false);f.adapter.drain(8);
  expect(f.control(1n,mode,4,mode)).toEqual({phase:"retired",mode,accepted:true});
  expect(f.deletedPrograms.filter(program=>program===f.program)).toHaveLength(1);expect(f.uniformReads).toHaveLength(1);
  expect(f.adapter.retainedBytes).toBe(0);expect(f.binding.uniformLookupBudget.used).toBe(0);f.registry.unbind(7);
});

it("never revalidates an old native uniform location as the peer's new executable",async()=>{
  const f=await uniformFixture();f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);
  const index=scalar(f.ready(1n,4).bytes),peer=f.peer();linkProgramRetainingExecutable(peer,20);
  const next=peer.programs.get(20);expect(next).not.toBe(f.program);
  expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  expect(f.binding.nextUniformLoc).toBe(index);expect(publishedUniformLocation(peer,index)).toBeUndefined();
  expect(f.binding.programs.get(20)).toBe(next);expect(f.uniformReads).toEqual([{program:f.program,name:"color"}]);f.registry.unbind(7);
});

it("retires a uniform candidate after its actual source identity makes publication fail",async()=>{
  const f=await uniformFixture();f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);f.ready(1n,4);
  f.binding.contextId=2;
  expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:false});
  expect(f.binding.uniformLookupBudget.used).toBe(0);expect(f.binding.uniformLocationRecords.size).toBe(0);
  expect(f.binding.programQueryPins.size).toBe(0);expect(f.adapter.retainedBytes).toBe(0);f.registry.unbind(7);
});

it("stages uniform name assembly until Commit and preserves each old stage on Cancel",async()=>{
  const f=await uniformFixture();
  f.begin(1n,O.QOP_LOOKUP_UNIFORM,f.lookup(1,1,5),16);f.adapter.drain(16);f.ready(1n,16);
  expect(f.binding.uniformLookup).toBeNull();f.control(1n,"commit",16,"commit");
  const assembly=f.binding.uniformLookup!;expect(assembly.cursor).toBe(0);expect(f.binding.uniformLookupSerial).toBe(1);
  f.begin(2n,O.QOP_LOOKUP_UNIFORM,f.lookup(1,2,100),16);f.adapter.drain(16);f.ready(2n,16);f.control(2n,"cancel",16,"cancel");
  expect(f.binding.uniformLookup).toBe(assembly);expect(f.binding.uniformLookupSerial).toBe(1);
  f.begin(3n,O.QOP_LOOKUP_UNIFORM,f.lookup(2,1,0,"color"),16);f.adapter.drain(16);f.ready(3n,16);
  expect(assembly.cursor).toBe(0);f.control(3n,"cancel",16,"cancel");expect(assembly.cursor).toBe(0);
  f.begin(4n,O.QOP_LOOKUP_UNIFORM,f.lookup(2,1,0,"color"),16);f.adapter.drain(16);f.control(4n,"commit",16,"commit");
  expect(assembly.cursor).toBe(5);expect(new TextDecoder().decode(assembly.bytes)).toBe("color");expect(f.uniformReads).toHaveLength(0);
  f.begin(5n,O.QOP_LOOKUP_UNIFORM,f.lookup(3,1),16);f.adapter.drain(16);const canceled=f.ready(5n,16);
  f.control(5n,"cancel",16,"cancel");expect(f.binding.uniformLookup).toBe(assembly);
  f.begin(6n,O.QOP_LOOKUP_UNIFORM,f.lookup(3,1),16);f.adapter.drain(16);const final=f.ready(6n,16);
  expect(scalar(canceled.bytes,8)).toBe(scalar(final.bytes,8));expect(f.binding.uniformLookup).toBe(assembly);
  f.control(6n,"commit",16,"commit");expect(f.binding.uniformLookup).toBeNull();
  expect(publishedUniformLocation(f.binding,scalar(final.bytes,8))).toBeDefined();expect(f.binding.uniformLookupBudget.used).toBe(0);f.registry.unbind(7);
});

it.each([false,true])("keeps the actual bootstrap lease after failed cleanup (throws=%s)",async throws=>{
  const f=await uniformFixture();f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);f.ready(1n,4);
  const release=vi.spyOn(GlContextExecutionLease.prototype,"release").mockImplementationOnce(()=>{if(throws)throw new Error("release refused");return false;});
  try {expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retiring",mode:"cancel"});} finally {release.mockRestore();}
  expect(f.binding.uniformLookupBudget.used).toBeGreaterThan(0);
  expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.binding.uniformLookupBudget.used).toBe(0);expect(f.binding.programQueryPins.size).toBe(0);expect(f.uniformReads).toHaveLength(1);f.registry.unbind(7);
});

it("keeps an unadopted uniform candidate in typed rollback custody after transfer throws",async()=>{
  const f=await uniformFixture(),adopt=vi.spyOn(GlNativeResultCustody.prototype,"adoptUniformCandidate").mockImplementationOnce(()=>{throw new Error("transfer refused");});
  try {f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);} finally {adopt.mockRestore();}
  expect(f.ready(1n,4).result).toBe(-5);expect(f.binding.programQueryPins.get(f.program)).toBe(1);
  expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.binding.programQueryPins.size).toBe(0);expect(f.binding.uniformLookupBudget.used).toBe(0);expect(f.uniformReads).toHaveLength(1);f.registry.unbind(7);
});

it("rejects malformed uniform framing before context capture behind a busy prefix",async()=>{
  const f=await uniformFixture(),capture=vi.spyOn(f.registry,"retainSubmitExecution"),prefix=f.binding.operations.reserve("commands")!;
  const invalid:[number,Uint8Array,number][]=[
    [O.QOP_GET_UNIFORM_LOC,words(20,100),4],[O.QOP_GET_UNIFORM_LOC,f.single(),0],
    [O.QOP_LOOKUP_UNIFORM,words(5,20,1,0),16],[O.QOP_LOOKUP_UNIFORM,words(1,20,0,5),16],
    [O.QOP_LOOKUP_UNIFORM,words(2,20,1,0),16],[O.QOP_LOOKUP_UNIFORM,words(3,20,1,5),16],
  ];
  for(let i=0;i<invalid.length;i++) {
    const [op,input,capacity]=invalid[i],reply=f.begin(BigInt(i+1),op,input,capacity);
    if("error" in reply)throw new Error("missing rejection");
    expect(decodeQueryReply(reply.bytes,{control:"begin",token:BigInt(i+1),capacity})).toEqual({phase:"rejected",error:22});
  }
  expect(capture).not.toHaveBeenCalled();expect(f.uniformReads).toHaveLength(0);expect(f.adapter.pendingRequests).toBe(0);prefix.cancel();f.registry.unbind(7);
});


it("adopts a uniform candidate only once against its actual captured logical source",async()=>{
  const f=await uniformFixture(),work=f.registry.retainSubmitExecution(f.binding,f.muxer)!;
  const source=work.cloneContextExecution()!,candidate=prepareGlUniformQuery(source,O.QOP_GET_UNIFORM_LOC,f.single(),4)!;
  const peer=f.peer(),peerWork=f.registry.retainSubmitExecution(peer,f.muxer)!;
  const wrong=new GlNativeResultCustody(peerWork,null,f.muxer),own=new GlNativeResultCustody(work,null,f.muxer);
  expect(wrong.adoptUniformCandidate(candidate,source)).toBe(false);
  expect(own.adoptUniformCandidate(candidate,source)).toBe(true);
  const duplicateWork=f.registry.retainSubmitExecution(f.binding,f.muxer)!;
  const duplicate=new GlNativeResultCustody(duplicateWork,null,f.muxer);
  expect(duplicate.adoptUniformCandidate(candidate,source)).toBe(false);
  expect(source.release()).toBe(true);
  expect(own.retire("cancel").complete).toBe(true);expect(wrong.retire("cancel").complete).toBe(true);
  expect(duplicate.retire("cancel").complete).toBe(true);
  expect(f.binding.uniformLookupBudget.used).toBe(0);expect(f.binding.programQueryPins.size).toBe(0);f.registry.unbind(7);
});

it("retains actual preparation custody through a branded native failure without swallowing it",async()=>{
  const f=await uniformFixture(),gate=new KernelEntryGate();let failure:unknown;
  try {gate.invokeKernelExport("uniform-source-failure",()=>{throw new Error("native failure");});} catch(error) {failure=error;}
  const lookup=vi.spyOn(f.gl,"getUniformLocation").mockImplementationOnce(()=>{throw failure;});
  try {
    f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);expect(()=>f.adapter.drain(16)).toThrow(failure as Error);
  } finally {lookup.mockRestore();}
  expect(f.ready(1n,4).result).toBe(-5);expect(f.binding.programQueryPins.get(f.program)).toBe(1);
  expect(f.binding.uniformLookupBudget.used).toBeGreaterThan(0);
  expect(f.control(1n,"cancel",4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.binding.uniformLookupBudget.used).toBe(0);expect(f.binding.programQueryPins.size).toBe(0);f.registry.unbind(7);
});


it("uses the captured uniform source after public context replacement and retires only its old program",async()=>{
  const f=await uniformFixture(),objects=f.binding.objects;
  f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.registry.destroyContext(7,11);
  const replacement=f.registry.get(7,11)!;expect(replacement).not.toBe(f.binding);
  f.adapter.drain(16);const ready=f.ready(1n,4),index=scalar(ready.bytes);
  expect(f.uniformReads).toEqual([{program:f.program,name:"color"}]);expect(objects.programQueryPins.get(f.program)).toBe(1);
  expect(replacement.uniformLocationRecords.has(index)).toBe(false);
  expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  expect(replacement.uniformLocationRecords.has(index)).toBe(false);
  expect(f.deletedPrograms.filter(program=>program===f.program)).toHaveLength(1);
  expect(objects.uniformLookupBudget.used).toBe(0);f.registry.unbind(7);
});

it("cancels an unpublished uniform candidate if owner closure denies a previously requested Commit",async()=>{
  const f=await uniformFixture();f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);f.ready(1n,4);
  const release=vi.spyOn(GlContextExecutionLease.prototype,"release").mockImplementationOnce(()=>false);
  try {expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retiring",mode:"commit"});} finally {release.mockRestore();}
  expect(f.binding.nextUniformLoc).toBe(0);expect(f.adapter.retireOwner(f.owner)).toBe(true);
  expect(f.control(1n,"commit",4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:false});
  expect(f.binding.nextUniformLoc).toBe(0);expect(f.binding.uniformLocationRecords.size).toBe(0);
  expect(f.binding.programQueryPins.size).toBe(0);expect(f.binding.uniformLookupBudget.used).toBe(0);
  expect(f.adapter.forgetOwner(f.owner)).toBe(true);f.registry.unbind(7);
});


it.each(["commit","cancel"] as const)("retains actual old-context native cleanup after uniform %s",async mode=>{
  const f=await uniformFixture();f.begin(1n,O.QOP_GET_UNIFORM_LOC,f.single(),4);f.adapter.drain(16);f.ready(1n,4);
  f.registry.destroyContext(7,11);f.block(true);
  expect(f.control(1n,mode,4,mode)).toEqual({phase:"retiring",mode});
  expect(f.live.has(f.program)).toBe(true);expect(f.adapter.retainedBytes).toBeGreaterThan(0);
  f.block(false);f.adapter.drain(16);
  expect(f.control(1n,mode,4,mode)).toEqual({phase:"retired",mode,accepted:true});
  expect(f.control(1n,mode,4,mode)).toEqual({phase:"retired",mode,accepted:true});
  expect(f.deletedPrograms.filter(program=>program===f.program)).toHaveLength(1);
  expect(f.uniformReads).toHaveLength(1);expect(f.adapter.retainedBytes).toBe(0);f.registry.unbind(7);
});
