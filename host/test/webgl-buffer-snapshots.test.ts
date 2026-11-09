import {GlProgramJournal} from "../src/webgl/program-journal.js";
import {drawBufferSnapshots,validBufferSnapshotDraw} from "../src/webgl/private-buffer-draw.js";
import {markRendererReset} from "../src/webgl/renderer-loss.js";
import {afterEach,expect,it,vi} from "vitest";
import {GlBufferSnapshots,BUFFER_SNAPSHOT_CAPACITY,BUFFER_SNAPSHOT_MAX_BYTES} from "../src/webgl/buffer-snapshots.js";
import {bindBufferObject,replaceBufferData,updateBufferData} from "../src/webgl/buffer-storage.js";
import {deleteBufferNames,collectRetiredBuffers} from "../src/webgl/buffer-references.js";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {GlMuxer} from "../src/webgl/muxer.js";
import {withNativeBatch} from "../src/webgl/native-batch.js";
import {rendererLost,RENDERER_LOST} from "../src/webgl/renderer-loss.js";
import {hasNativeRepair,NativeGlFault,setNativeGlFaultReporter} from "../src/webgl/native-recovery.js";
import {configureGlAudit,resetGlAuditForTesting} from "../src/webgl/native-audit.js";
const ARRAY=0x8892,STATIC=0x88e4;
class NativeBuffers {
  alive=new Set<object>();data=new Map<object,Uint8Array>();bindings=new Map<number,object|null>();
  errors:number[]=[];created=0;defineCalls=0;errorReads=0;failCreateAt=0;failDelete=false;failWrite:object|null=null;writeError=0x505;
  draws=0;pointers=new Map<number,object|null>();
  vertexAttribPointer(index:number){this.pointers.set(index,this.bindings.get(ARRAY)??null);}
  drawArrays(){this.draws++;}
  copyBufferSubData(read:number,write:number,from:number,to:number,length:number){this.data.get(this.bindings.get(write)!)!.set(this.data.get(this.bindings.get(read)!)!.subarray(from,from+length),to);}
  getError(){this.errorReads++;return this.errors.shift()??0;}isContextLost(){return false;}
  getParameter(target:number){return this.bindings.get(target)??null;}
  createBuffer(){if(++this.created===this.failCreateAt)return null;const buffer={};this.alive.add(buffer);return buffer;}
  deleteBuffer(buffer:object|null){if(!buffer)return;if(this.failDelete){this.errors.push(0x502);return;}this.alive.delete(buffer);this.data.delete(buffer);for(const [target,bound]of this.bindings)if(bound===buffer)this.bindings.set(target,null);}
  bindBuffer(target:number,buffer:object|null){if(buffer&&!this.alive.has(buffer)){this.errors.push(0x502);return;}this.bindings.set(target,buffer);}
  bufferData(target:number,value:number|Uint8Array,_usage?:number,offset=0,length?:number){this.defineCalls++;const buffer=this.bindings.get(target)!;
    if(buffer===this.failWrite){this.failWrite=null;this.errors.push(this.writeError);return;}
    this.data.set(buffer,typeof value==="number"?new Uint8Array(value):new Uint8Array(value.subarray(offset,length===undefined?undefined:offset+length)));}
  bufferSubData(target:number,offset:number,value:Uint8Array){const bytes=this.data.get(this.bindings.get(target)!);if(!bytes||offset+value.length>bytes.length){this.errors.push(0x501);return;}bytes.set(value,offset);}
}
afterEach(()=>{resetGlAuditForTesting();setNativeGlFaultReporter(null);});
function fixture(capacity=2){
  const native=new NativeBuffers(),gl=new Proxy(native,{get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);
  const bind=(session:number)=>{registry.bind({pid:1,sessionId:session,cmdbufAddr:0,cmdbufLen:128});const b=registry.get(1,session)!;b.gl=gl;b.contextId=session+1;return b;};
  const b=bind(0),execution=registry.retainContextExecution(1,0,muxer)!;
  const bank=GlBufferSnapshots.reserve(b,capacity)!;expect(bank).not.toBeNull();expect(bank.initialize(execution)).toBe(true);
  expect(bindBufferObject(b,ARRAY,7)).toBe(true);const object=b.buffers.get(7)!;
  const peer=()=>{const p=bind(12);expect(registry.shareObjects(1,12,0)).toBe(true);return p;};
  const dispose=()=>{expect(bank.retire()).toBe(true);execution.release();registry.unbind(1);expect(native.alive.size).toBe(0);};
  return {b,gl,native,registry,muxer,execution,bank,object,peer,dispose};
}
it("refuses unavailable rendering before allocating a native receiver",()=>{
  const registry=new GlContextRegistry();registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:128});
  expect(GlBufferSnapshots.reserve(registry.get(1)!)).toBeNull();registry.unbind(1);
});
it("keeps owned bytes across a future shared context's replacement and partial update",()=>{
  const f=fixture();expect(f.bank.define(f.b,0,1,ARRAY,new Uint8Array([1,2,3,4]),STATIC)).toBe(true);
  const copy=f.bank.resolve(f.b,0,1,f.object,4)!;expect(copy).not.toBe(f.object);
  const peer=f.peer();expect(bindBufferObject(peer,ARRAY,7)).toBe(true);
  expect(replaceBufferData(peer,ARRAY,new Uint8Array([8,9]),STATIC)).toBe(true);
  updateBufferData(peer,ARRAY,1,new Uint8Array([10]));
  expect([...f.native.data.get(f.object)!]).toEqual([8,10]);expect([...f.native.data.get(copy)!]).toEqual([1,2,3,4]);
  expect(f.b.bufferStores.get(f.object)!.size).toBe(2);expect(f.bank.resolve(f.b,0,1,f.object,4)).toBe(copy);
  expect(f.bank.resolve(peer,0,1,f.object,4)).toBeNull();f.dispose();
});
it("retains identity and storage after deletion, final ordinary collection and numeric name reuse",()=>{
  const f=fixture();expect(f.bank.define(f.b,0,1,ARRAY,new Uint8Array([3,5,7]),STATIC)).toBe(true);
  const copy=f.bank.resolve(f.b,0,1,f.object,3)!;expect(bindBufferObject(f.b,ARRAY,0)).toBe(true);
  expect(deleteBufferNames(f.b,[7])).toBe(true);collectRetiredBuffers(f.b);expect(f.native.alive.has(f.object)).toBe(false);
  expect(bindBufferObject(f.b,ARRAY,7)).toBe(true);const replacement=f.b.buffers.get(7)!;expect(replacement).not.toBe(f.object);
  expect(f.bank.resolve(f.b,0,1,replacement,3)).toBeNull();expect(f.bank.resolve(f.b,0,1,f.object,3)).toBe(copy);
  expect([...f.native.data.get(copy)!]).toEqual([3,5,7]);f.dispose();
});
it("recycles bounded native receivers in command order and rejects stale or repeated tokens",()=>{
  const f=fixture(1),created=f.native.created;
  for(let token=1;token<=40;token++){
    expect(f.bank.define(f.b,0,token,ARRAY,new Uint8Array([token]),STATIC)).toBe(true);
    const copy=f.bank.resolve(f.b,0,token,f.object,1)!;expect([...f.native.data.get(copy)!]).toEqual([token]);
    expect(f.bank.resolve(f.b,0,token-1,f.object,1)).toBeNull();expect(f.native.bindings.get(ARRAY)).toBe(f.object);
  }
  const calls=f.native.defineCalls;expect(f.bank.define(f.b,0,40,ARRAY,new Uint8Array([99]),STATIC)).toBe(false);
  expect(f.native.defineCalls).toBe(calls);expect(f.native.created).toBe(created);f.dispose();
});
it("independently rejects the original API operands without exposing an earlier copy as a new generation",()=>{
  const f=fixture();expect(f.bank.define(f.b,0,1,ARRAY,new Uint8Array([1,2]),STATIC)).toBe(true);
  expect(f.bank.define(f.b,0,2,ARRAY,new Uint8Array([9]),0xdead)).toBe(false);expect(f.b.errors).toEqual([0x500]);
  expect([...f.native.data.get(f.object)!]).toEqual([1,2]);expect(f.bank.resolve(f.b,0,1,f.object,2)).toBeNull();
  expect(f.bank.resolve(f.b,0,2,f.object,1)).toBeNull();
  expect(f.bank.define(f.b,0,3,ARRAY,new Uint8Array([8]),STATIC)).toBe(true);f.dispose();
});
it("preserves logical errors, current bindings and byte-span limits",()=>{
  const f=fixture();f.b.errors.push(0x500,0x501);
  expect(f.bank.define(f.b,0,1,ARRAY,8,STATIC)).toBe(true);expect(f.native.bindings.get(ARRAY)).toBe(f.object);
  expect(f.b.errors).toEqual([0x500,0x501]);expect(f.bank.resolve(f.b,0,1,f.object,8)).not.toBeNull();
  for(const bytes of [-1,9,NaN,Infinity,1.5])expect(f.bank.resolve(f.b,0,1,f.object,bytes)).toBeNull();
  const calls=f.native.defineCalls;
  expect(f.bank.define(f.b,1,1,ARRAY,BUFFER_SNAPSHOT_MAX_BYTES+1,STATIC)).toBe(false);expect(f.native.defineCalls).toBe(calls);f.dispose();
});
it("uses one native error sample for an accepted submitted definition and private copy",()=>{
  const f=fixture(1),before=f.native.errorReads;
  expect(withNativeBatch(f.b,"snapshot-one-sample",()=>{expect(f.bank.define(f.b,0,1,ARRAY,new Uint8Array([1,2]),STATIC)).toBe(true);})).toBe(0);
  expect(f.native.errorReads-before).toBe(1);expect(f.native.bindings.get(ARRAY)).toBe(f.object);
  expect(f.bank.resolve(f.b,0,1,f.object,2)).not.toBeNull();f.dispose();
});
it("refuses foreign contexts and replaced group authority before native effects",()=>{
  const f=fixture(),peer=f.peer(),calls=f.native.defineCalls;
  expect(f.bank.define(peer,0,1,ARRAY,4,STATIC)).toBe(false);expect(f.native.defineCalls).toBe(calls);
  const objects=f.b.objects;f.b.objects={...objects,members:new Set()};
  try{expect(f.bank.define(f.b,0,1,ARRAY,4,STATIC)).toBe(false);expect(f.native.defineCalls).toBe(calls);}finally{f.b.objects=objects;}
  f.dispose();
});
it("retains partial cold allocations for exact cleanup and never retries their initialization",()=>{
  const native=new NativeBuffers(),gl=new Proxy(native,{get:(o,k)=>Reflect.get(o,k)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry();registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:128});const b=registry.get(1)!;b.gl=gl;b.contextId=1;
  const execution=registry.retainContextExecution(1,0,new GlMuxer(gl))!;
  for(const n of [0,BUFFER_SNAPSHOT_CAPACITY+1,NaN])expect(GlBufferSnapshots.reserve(b,n)).toBeNull();expect(native.created).toBe(0);
  const bank=GlBufferSnapshots.reserve(b,3)!;native.failCreateAt=2;expect(bank.initialize(execution)).toBe(false);expect(native.alive.size).toBe(1);
  expect(bank.initialize(execution)).toBe(false);expect(native.created).toBe(2);expect(bank.retire()).toBe(true);
  execution.release();registry.unbind(1);expect(native.alive.size).toBe(0);
});
it("keeps a public-retired context's native receivers owned until explicit retirement",()=>{
  const f=fixture(1);expect(f.bank.define(f.b,0,1,ARRAY,new Uint8Array([1]),STATIC)).toBe(true);
  f.execution.release();f.registry.unbind(1);
  expect(f.native.alive.size).toBeGreaterThan(0);expect(f.bank.resolve(f.b,0,1,f.object,1)).toBeNull();
  expect(f.bank.retire()).toBe(true);expect(f.native.alive.size).toBe(0);
});
it("keeps refused native retirement owned and retryable after the loud fault",()=>{
  const f=fixture(1);const faults:Error[]=[];setNativeGlFaultReporter(e=>faults.push(e));f.native.failDelete=true;
  expect(()=>f.bank.retire()).toThrow(NativeGlFault);expect(faults).toHaveLength(1);expect(hasNativeRepair(f.gl)).toBe(true);
  expect(f.native.alive.size).toBeGreaterThan(0);f.native.failDelete=false;expect(f.bank.retire()).toBe(true);f.dispose();
});
it.each([0x505,0x502])("routes private copy flag0x%s through the submitting context's production reset",error=>{
  const f=fixture(1);expect(f.bank.define(f.b,0,1,ARRAY,new Uint8Array([1]),STATIC)).toBe(true);
  const copy=f.bank.resolve(f.b,0,1,f.object,1)!;const peer=f.peer();expect(bindBufferObject(f.b,ARRAY,7)).toBe(true);
  f.native.failWrite=copy;f.native.writeError=error;
  expect(withNativeBatch(f.b,"snapshot-copy-test",()=>{f.bank.define(f.b,0,2,ARRAY,new Uint8Array([2]),STATIC);})).toBe(RENDERER_LOST);
  expect(rendererLost(f.b)).toBe(true);expect(rendererLost(peer)).toBe(false);expect(f.native.getError()).toBe(0);
  expect(f.bank.resolve(f.b,0,2,f.object,1)).toBeNull();f.dispose();
});
it("keeps an unexpected private copy flag fatal under the audit",()=>{
  const f=fixture(1);expect(f.bank.define(f.b,0,1,ARRAY,new Uint8Array([1]),STATIC)).toBe(true);
  f.native.failWrite=f.bank.resolve(f.b,0,1,f.object,1)!;f.native.writeError=0x502;
  const faults:Error[]=[];setNativeGlFaultReporter(e=>faults.push(e));configureGlAudit({mode:"fatal",sink:()=>{},fault:message=>{throw new NativeGlFault(message);}});
  expect(()=>withNativeBatch(f.b,"snapshot-copy-audit",()=>{f.bank.define(f.b,0,2,ARRAY,new Uint8Array([2]),STATIC);})).toThrow(NativeGlFault);
  expect(faults.length).toBeGreaterThan(0);resetGlAuditForTesting();f.dispose();
});

it("refuses cold copy-workspace metadata before allocating any native receiver",()=>{
  const f=fixture(1),created=f.native.created;
  const map=vi.spyOn(Array.prototype,"map").mockImplementationOnce(()=>{throw new Error("cold receiver allocation refused");});
  let bank:GlBufferSnapshots|null=null;
  try{bank=GlBufferSnapshots.reserve(f.b,1);}finally{map.mockRestore();}
  try{expect(bank).toBeNull();expect(f.native.created).toBe(created);expect(f.b.errors).toEqual([0x505]);}
  finally{f.dispose();}
});
it("reuses a definition receiver after cold admission when warm metadata factories refuse",()=>{
  const f=fixture(1),before=f.native.defineCalls,data=new Uint8Array([1,2]);
  const map=Array.prototype.map,flatMap=Array.prototype.flatMap,set=WeakMap.prototype.set;
  let accepted=false,failure:unknown;
  const forbidden=()=>{throw new Error("warm receiver allocation refused");};
  try{
    Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;
    withNativeBatch(f.b,"warm definition metadata control",()=>{accepted=f.bank.define(f.b,0,1,ARRAY,data,STATIC);});
  }catch(error){failure=error;}
  finally{Array.prototype.map=map;Array.prototype.flatMap=flatMap;WeakMap.prototype.set=set;}
  try{
    expect(failure).toBeUndefined();expect(accepted).toBe(true);expect(f.native.defineCalls).toBe(before+2);
    expect(f.b.errors).toEqual([]);const copy=f.bank.resolve(f.b,0,1,f.object,2)!;
    expect([...f.native.data.get(copy)!]).toEqual([1,2]);expect(f.native.bindings.get(ARRAY)).toBe(f.object);
  }finally{f.dispose();}
});

function sourceAttribute(f:ReturnType<typeof fixture>,index=0){
  f.b.vertexArrays.get(0)!.attributes.set(index,{buffer:f.object,enabled:true,size:2,type:0x1406,normalized:false,stride:0,offset:0});
}
function ownedDraw(id:number,token=1,count=3):DataView{
  return new DataView(new Uint32Array([id,4,0,count,1,0,0,token,2,0x1406,0,0,0]).buffer);
}
it("cold-captures actual static attribute bytes before a future peer changes their store",()=>{
  const f=fixture();sourceAttribute(f);expect(replaceBufferData(f.b,ARRAY,new Uint8Array([1,2,3,4,5,6,7,8]),STATIC)).toBe(true);
  expect(f.bank.captureAttribute(f.b,0,1,0)).toBe(8);const native=f.bank.resolve(f.b,0,1,f.object,8)!;
  const peer=f.peer();expect(bindBufferObject(peer,ARRAY,7)).toBe(true);replaceBufferData(peer,ARRAY,new Uint8Array([9]),STATIC);
  expect([...f.native.data.get(native)!]).toEqual([1,2,3,4,5,6,7,8]);expect(f.bank.captureAttribute(f.b,0,1,0)).toBeNull();f.dispose();
});
it("completes an unavailable cold capture without inventing a guest API error",()=>{
  const f=fixture();expect(f.bank.captureAttribute(f.b,0,1,0)).toBe(0);expect(f.b.errors).toEqual([]);
  sourceAttribute(f);replaceBufferData(f.b,ARRAY,BUFFER_SNAPSHOT_MAX_BYTES+1,STATIC);
  expect(f.bank.captureAttribute(f.b,0,2,0)).toBe(0);expect(f.b.errors).toEqual([]);f.dispose();
});
it("retains the public owner's reset identity in the cold range-proven execution view",()=>{
  const f=fixture(),peer=f.peer(),view=f.bank.executionView(f.b)!;f.b.robustAccess=true;
  expect(view.robustAccess).toBe(false);expect(f.b.robustAccess).toBe(true);markRendererReset(view);
  expect(rendererLost(f.b)).toBe(true);expect(rendererLost(view)).toBe(true);expect(rendererLost(peer)).toBe(false);f.dispose();
});
it("draws an in-range retained generation after the ordinary robust store shrinks",()=>{
  const f=fixture(),journal=GlProgramJournal.create(f.execution,4)!;expect(journal.prepareBufferSnapshots(2)).toBe(2);
  sourceAttribute(f);f.b.robustAccess=true;f.b.currentProgram={} as WebGLProgram;
  expect(journal.defineBufferSnapshot(0,1,ARRAY,new Uint8Array(24),STATIC)).toBe(true);
  const retained=journal.resolveBufferSnapshot(0,1,f.object,24)!;
  const peer=f.peer();bindBufferObject(peer,ARRAY,7);replaceBufferData(peer,ARRAY,new Uint8Array(2),STATIC);
  expect(validBufferSnapshotDraw(ownedDraw(journal.id))).toBe(true);const before=f.native.errorReads;
  expect(withNativeBatch(f.b,"owned-buffer-draw",()=>{expect(drawBufferSnapshots(f.b,ownedDraw(journal.id))).toBe(true);})).toBe(0);
  expect(f.native.errorReads-before).toBe(1);expect(f.native.draws).toBe(1);expect(f.native.pointers.get(0)).toBe(f.object);
  expect(f.native.data.get(retained)!.byteLength).toBe(24);expect(f.b.bufferStores.get(f.object)!.size).toBe(2);expect(f.b.robustAccess).toBe(true);
  f.b.currentProgram=null;journal.retire();f.dispose();
});
it("executes and restores a warmed owned draw when repair metadata factories refuse",()=>{
  const f=fixture(),journal=GlProgramJournal.create(f.execution,4)!;expect(journal.prepareBufferSnapshots(2)).toBe(2);
  sourceAttribute(f);f.b.currentProgram={} as WebGLProgram;
  expect(journal.defineBufferSnapshot(0,1,ARRAY,new Uint8Array(24),STATIC)).toBe(true);
  const wire=ownedDraw(journal.id);withNativeBatch(f.b,"prime owned draw",()=>{drawBufferSnapshots(f.b,wire);});
  const before=f.native.draws,reads=f.native.errorReads;
  const map=Array.prototype.map,flatMap=Array.prototype.flatMap,set=WeakMap.prototype.set;
  const forbidden=()=>{throw new Error("warm draw metadata refused");};
  let accepted=false,failure:unknown;
  try{
    Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;
    withNativeBatch(f.b,"warm owned draw metadata control",()=>{accepted=drawBufferSnapshots(f.b,wire);});
  }catch(error){failure=error;}
  finally{Array.prototype.map=map;Array.prototype.flatMap=flatMap;WeakMap.prototype.set=set;}
  try{
    expect(failure).toBeUndefined();expect(accepted).toBe(true);expect(f.native.draws).toBe(before+1);
    expect(f.native.errorReads-reads).toBe(1);expect(f.native.pointers.get(0)).toBe(f.object);expect(f.b.errors).toEqual([]);
  }finally{f.b.currentProgram=null;journal.retire();f.dispose();}
});
it("refuses stale token, incomplete rows and oversized spans before native drawing",()=>{
  const f=fixture(),journal=GlProgramJournal.create(f.execution,4)!;expect(journal.prepareBufferSnapshots(2)).toBe(2);sourceAttribute(f);
  journal.defineBufferSnapshot(0,1,ARRAY,new Uint8Array(24),STATIC);
  for(const v of [ownedDraw(journal.id,2),ownedDraw(journal.id,1,4)])expect(drawBufferSnapshots(f.b,v)).toBe(false);
  sourceAttribute(f,1);expect(drawBufferSnapshots(f.b,ownedDraw(journal.id))).toBe(false);expect(f.native.draws).toBe(0);
  journal.retire();f.dispose();
});

async function framebufferFixture(){
  const [{foreignTextureGl},{GlFramebufferSnapshots},{recordTextureLevel}]=await Promise.all([
    import("./support/foreign-texture-gl.js"),import("../src/webgl/framebuffer-snapshots.js"),import("../src/webgl/texture-levels.js")]);
  const native=foreignTextureGl(),gl=new Proxy(native.gl,{get:(object,key)=>Reflect.get(object,key)??(()=>null)}) as WebGL2RenderingContext;
  const registry=new GlContextRegistry();registry.bind({pid:101,cmdbufAddr:0,cmdbufLen:64});const b=registry.get(101)!;b.gl=gl;b.contextId=1;
  const target=gl.createTexture()!,input=gl.createTexture()!,framebuffer=gl.createFramebuffer()!;
  const spec={width:4,height:4,internalFormat:0x8058,format:0x1908,type:0x1401,compressed:false,
    gles:{internalFormat:0x1908,format:0x1908,type:0x1401,expanded:false,colorRenderable:true,depth:false,stencil:false}};
  recordTextureLevel(target,0xde1,0,spec);recordTextureLevel(input,0xde1,0,spec);
  b.textures.set(1,target);b.textures.set(2,input);b.fbos.set(3,framebuffer);b.shadow.fbo=framebuffer;b.shadow.textureUnits[0]=input;
  b.framebufferAttachments.set(framebuffer,new Map([[0x8ce0,{kind:"texture",object:target,target:0xde1,level:0}]]));
  gl.bindFramebuffer(0x8ca9,framebuffer);gl.framebufferTexture2D(0x8ca9,0x8ce0,0xde1,target,0);gl.bindTexture(0xde1,input);
  const execution=registry.retainContextExecution(101,0,new GlMuxer(gl))!,bank=GlFramebufferSnapshots.create(execution)!;
  return{native,gl,b,registry,execution,bank,target,input,framebuffer,recordTextureLevel,spec,
    dispose:()=>{expect(bank.retire()).toBe(true);execution.release();registry.unbind(101);}};
}
it("captures complete native target and input generations without public framebuffer metadata",async()=>{
  const f=await framebufferFixture();expect(f.bank.capture(0,1,3)).toBe(1);const capture=f.bank.resolve(0,1)!;
  expect(capture.framebuffer).not.toBe(f.framebuffer);expect(f.native.frames.get(capture.framebuffer!)?.get(0x8ce0)).toBe(f.target);
  expect(capture.inputs[0].native).toBe(f.input);expect(capture.view!.shadow).not.toBe(f.b.shadow);expect(f.b.shadow.fbo).toBe(f.framebuffer);
  expect(f.bank.capture(0,1,3)).toBeNull();f.b.errors.length=0;f.dispose();
});
it("keeps old target write accounting after public respecification and unrelated framebuffer revisions",async()=>{
  const [{imageTextureOperation,textureNative},{prepareDrawTarget},{storageWrites}]=await Promise.all([
    import("../src/webgl/image-storage.js"),import("../src/webgl/opaque-alpha.js"),import("../src/webgl/image-writes.js")]);
  const f=await framebufferFixture();expect(f.bank.capture(0,1,3)).toBe(1);const capture=f.bank.resolve(0,1)!;
  f.b.shadow.textureUnits[0]=f.target;f.gl.bindTexture(0xde1,f.target);
  expect(imageTextureOperation(f.b,0xde1,true,()=>f.gl.texImage2D(0xde1,0,0x8058,2,2,0,0x1908,0x1401,null),false,0)).toBe(true);
  f.recordTextureLevel(f.target,0xde1,0,{...f.spec,width:2,height:2});const replacement=textureNative(f.b,f.target);
  const old=storageWrites(f.target),next=storageWrites(replacement),oldCount=old.count,nextCount=next.count;
  prepareDrawTarget(capture.view!);expect(old.count).toBe(oldCount+1);expect(next.count).toBe(nextCount);
  expect(f.native.frames.get(capture.framebuffer!)?.get(0x8ce0)).toBe(f.target);
  expect(f.native.frames.get(f.framebuffer)?.get(0x8ce0)).toBe(replacement);f.dispose();
});
it("refuses feedback on any bound unit before native target capture and keeps unavailable API errors empty",async()=>{
  const f=await framebufferFixture();f.b.shadow.textureUnits[7]=f.target;
  const frames=f.native.frames.size;expect(f.bank.capture(0,1,3)).toBe(0);expect(f.b.errors).toEqual([]);expect(f.native.frames.size).toBe(frames);
  expect(f.bank.resolve(0,1)).toBeNull();f.dispose();
});
it("shares a captured framebuffer execution view's logical reset with its original owner",async()=>{
  const f=await framebufferFixture();expect(f.bank.capture(0,1,3)).toBe(1);const capture=f.bank.resolve(0,1)!;
  markRendererReset(capture.view!);expect(rendererLost(f.b)).toBe(true);expect(f.bank.resolve(0,1)).toBeNull();f.dispose();
});

it("reserves cold target recovery metadata before native allocation and retains a refused capture for exact retirement",async()=>{
  const f=await framebufferFixture(),frames=f.native.frames.size;
  const map=vi.spyOn(Array.prototype,"map").mockImplementationOnce(()=>{throw new Error("target recovery metadata refused");});
  let result:number|null|undefined,failure:unknown;
  try{result=f.bank.capture(0,1,3);}catch(error){failure=error;}finally{map.mockRestore();}
  expect(failure).toBeUndefined();expect(result).toBeNull();expect(f.native.frames.size).toBe(frames);expect(f.b.errors).toEqual([0x505]);
  f.b.errors.length=0;expect(f.bank.capture(0,2,3)).toBe(1);f.dispose();
});
it("reuses a cold target selector plan while updating scalar restore state",async()=>{
  const f=await framebufferFixture();expect(f.bank.capture(0,1,3)).toBe(1);const capture=f.bank.resolve(0,1)!;
  const first=f.bank.changes(capture);f.b.shadow.activeTexture=3;f.b.shadow.colorMask=[true,false,true,false];
  const second=f.bank.changes(capture);expect(second).toBe(first);expect(second.apply[second.apply.length-1]).toEqual(["activeTexture",0x84c3]);
  expect(second.restore[second.restore.length-1]).toEqual(["colorMask",true,false,true,false]);f.dispose();
});

it("validates the whole retained framebuffer clear shape before effectful entry",async()=>{
  const {validFramebufferSnapshotClear}=await import("../src/webgl/private-framebuffer-clear.js");
  const view=(words:number[])=>new DataView(new Uint32Array(words).buffer);
  expect(validFramebufferSnapshotClear(view([1,0,1,0x4500]))).toBe(true);
  for(const words of [[0,0,1,0x4000],[1,16,1,0x4000],[1,0,0,0x4000],[1,0,1,0x80000000],[1,0,1],[1,0,1,0x4000,0]])
    expect(validFramebufferSnapshotClear(view(words))).toBe(false);
});
it("completes an unsupported private target as unavailable without inventing a guest error or retaining unused pins",async()=>{
  const f=await framebufferFixture();f.gl.checkFramebufferStatus=()=>0x8cdd;
  const frames=f.native.frames.size;expect(f.bank.capture(0,1,3)).toBe(0);expect(f.b.errors).toEqual([]);
  expect(f.bank.resolve(0,1)).toBeNull();expect(f.native.frames.size).toBe(frames);f.dispose();
});

it("uploads exact wire byte ranges from cold scratch when new typed-array metadata refuses",()=>{
  const f=fixture(1),wire=new DataView(new Uint8Array([99,3,5,7,11,101]).buffer);
  const calls=[{source:null as Uint8Array|null,size:0,offset:0,length:0},{source:null as Uint8Array|null,size:0,offset:0,length:0}];
  let at=0;
  f.gl.bufferData=((_target:number,value:number|Uint8Array,_usage:number,offset=0,length=0)=>{
    const call=calls[at++];call.source=typeof value==="number"?null:value;
    call.size=typeof value==="number"?value:value.byteLength;call.offset=offset;call.length=length;
  }) as WebGL2RenderingContext["bufferData"];
  const TypedArray=globalThis.Uint8Array;let accepted=false,failure:unknown;
  try{
    globalThis.Uint8Array=class extends TypedArray{constructor(){throw new Error("warm typed-array allocation refused");}} as typeof Uint8Array;
    withNativeBatch(f.b,"wire scratch metadata control",()=>{accepted=f.bank.defineFromWire(f.b,0,1,ARRAY,wire,1,4,STATIC);});
  }catch(error){failure=error;}
  finally{globalThis.Uint8Array=TypedArray;}
  try{
    expect(failure).toBeUndefined();expect(accepted).toBe(true);expect(at).toBe(2);
    expect(calls[0].source).toBe(calls[1].source);expect(calls[0].size).toBe(BUFFER_SNAPSHOT_MAX_BYTES);
    expect(calls[0].offset).toBe(0);expect(calls[0].length).toBe(4);expect(calls[1].length).toBe(4);
    expect(Array.from(calls[0].source!.subarray(0,4))).toEqual([3,5,7,11]);
    expect(f.b.bufferStores.get(f.object)!.size).toBe(4);expect(f.bank.resolve(f.b,0,1,f.object,4)).not.toBeNull();
    expect(f.bank.resolve(f.b,0,1,f.object,5)).toBeNull();expect(f.b.errors).toEqual([]);
  }finally{f.dispose();}
});

it("borrows only target selectors for a cold-reserved clear or prepared sampled draw",async()=>{
  const {storageWrites}=await import("../src/webgl/image-writes.js");
  const f=await framebufferFixture();expect(f.bank.capture(0,1,3)).toBe(1);
  const capture=f.bank.resolve(0,1)!,plan=f.bank.targetChanges(capture);
  const bind=f.gl.bindTexture.bind(f.gl);let textureBinds=0,effects=0;
  f.gl.bindTexture=(target,native)=>{textureBinds++;bind(target,native);};
  const map=Array.prototype.map,flatMap=Array.prototype.flatMap,set=WeakMap.prototype.set;
  const forbidden=()=>{throw new Error("warm target metadata refused");};
  const writes=storageWrites(f.target).count,work=()=>{effects++;return true;};
  let drew=false,cleared=false,failure:unknown;
  try{
    Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;
    withNativeBatch(f.b,"target-only prepared execution",()=>{drew=plan.executeTargetOnly(work);cleared=plan.clear(0x4000);});
  }catch(error){failure=error;}
  finally{Array.prototype.map=map;Array.prototype.flatMap=flatMap;WeakMap.prototype.set=set;}
  try{
    expect(failure).toBeUndefined();expect(drew).toBe(true);expect(cleared).toBe(true);expect(effects).toBe(1);
    expect(textureBinds).toBe(0);expect((plan.restore[1] as unknown[])[2]).toBeNull();expect(storageWrites(f.target).count).toBe(writes+1);
    expect(f.b.shadow.fbo).toBe(f.framebuffer);expect(f.b.shadow.textureUnits[0]).toBe(f.input);expect(f.b.errors).toEqual([]);
    expect(f.bank.changes(capture)).toBe(plan);expect(plan.execute(work)).toBe(true);expect(textureBinds).toBe(2);
  }finally{f.dispose();}
});
