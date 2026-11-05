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
  getError(){this.errorReads++;return this.errors.shift()??0;}isContextLost(){return false;}
  getParameter(target:number){return this.bindings.get(target)??null;}
  createBuffer(){if(++this.created===this.failCreateAt)return null;const buffer={};this.alive.add(buffer);return buffer;}
  deleteBuffer(buffer:object|null){if(!buffer)return;if(this.failDelete){this.errors.push(0x502);return;}this.alive.delete(buffer);this.data.delete(buffer);for(const [target,bound]of this.bindings)if(bound===buffer)this.bindings.set(target,null);}
  bindBuffer(target:number,buffer:object|null){if(buffer&&!this.alive.has(buffer)){this.errors.push(0x502);return;}this.bindings.set(target,buffer);}
  bufferData(target:number,value:number|Uint8Array){this.defineCalls++;const buffer=this.bindings.get(target)!;
    if(buffer===this.failWrite){this.failWrite=null;this.errors.push(this.writeError);return;}
    this.data.set(buffer,typeof value==="number"?new Uint8Array(value):new Uint8Array(value));}
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

it("reserves a copy receiver before ordinary storage changes when metadata allocation refuses",()=>{
  const f=fixture(1),before=f.native.defineCalls;
  const map=vi.spyOn(Array.prototype,"map").mockImplementationOnce(()=>{throw new Error("repair receiver allocation refused");});
  let accepted:boolean|undefined,failure:unknown;
  try{accepted=f.bank.define(f.b,0,1,ARRAY,new Uint8Array([1,2]),STATIC);}catch(error){failure=error;}
  finally{map.mockRestore();}
  try{
    expect(failure).toBeUndefined();expect(accepted).toBe(false);expect(f.native.defineCalls).toBe(before);
    expect(f.b.errors).toEqual([0x505]);expect(f.bank.resolve(f.b,0,1,f.object,2)).toBeNull();
    expect(f.bank.define(f.b,0,2,ARRAY,new Uint8Array([3,4]),STATIC)).toBe(true);
  }finally{f.dispose();}
});
