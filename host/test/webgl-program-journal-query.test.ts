import {recordCompiledExternalSamplers,recordLinkedExternalSamplers} from "../src/webgl/external-texture.js";
import {recordShaderLanguage} from "../src/webgl/essl3-translation.js";
import {bindBufferObject} from "../src/webgl/buffer-storage.js";
import {afterEach,expect,it,vi} from "vitest";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {GlMuxer} from "../src/webgl/muxer.js";
import {runGlQuery} from "../src/webgl/query.js";
import {captureContextGlProgram} from "../src/webgl/program-captures.js";
import {publicCurrentProgramName,GlProgramQueryPin,createShaderIfAccepted,finalizeProgram,retireShaderObjects} from "../src/webgl/program-objects.js";
import {decodeAndDispatch,validateCommandBuffer} from "../src/webgl/bridge.js";
import {QOP_PROGRAM_JOURNAL,QOP_PROGRAM_JOURNAL_BARRIER,OP_USE_PROGRAM_JOURNAL,OP_ERROR_OBSERVED} from "../src/webgl/ops.js";
import {NativeGlFault,setNativeGlFaultReporter} from "../src/webgl/native-recovery.js";
import {NativeContextReset,withNativeBatch} from "../src/webgl/native-batch.js";
import {markRendererReset} from "../src/webgl/renderer-loss.js";
import {configureGlAudit,resetGlAuditForTesting} from "../src/webgl/native-audit.js";
afterEach(()=>{resetGlAuditForTesting();setNativeGlFaultReporter(null);});
const magic=0x47514c33;
function fixture(){
 const selected:unknown[]=[],native=new Set<object>();let current:unknown=null;
 const gl=new Proxy({getError:()=>0,isContextLost:()=>false,getParameter:()=>current,
  getProgramParameter:()=>true,deleteProgram:(p:object)=>native.delete(p),
  useProgram:(p:object)=>{selected.push(p);current=p;}},{get:(o,k)=>Reflect.get(o,k)??(()=>null)}) as unknown as WebGL2RenderingContext;
 const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);
 const bind=(session:number,pid=1)=>{registry.bind({pid,sessionId:session,cmdbufAddr:0,cmdbufLen:256});const b=registry.get(pid,session)!;
  b.gl=gl;b.contextId=session+21;b.cmdbufView=new Uint8Array(256);return b;};
 const b=bind(0),program={};native.add(program);b.programs.set(20,program);b.programShaders.set(20,new Set());
 const execution=registry.retainContextExecution(1,0,muxer)!,capture=captureContextGlProgram(execution,20);
 const query=(words:number[],out=new Uint8Array(48).fill(0xa5),lease=execution)=>{
  const rc=runGlQuery(b,QOP_PROGRAM_JOURNAL,new Uint8Array(new Uint32Array(words).buffer),out,lease);
  return {rc,out,words:[...new Uint32Array(out.buffer,out.byteOffset,Math.floor(out.byteLength/4))]};
 };
 const emit=(rows:[number,number[]][])=>{const v=new DataView(b.cmdbufView!.buffer);let p=0;
  for(const [op,words]of rows){v.setUint16(p,op,true);v.setUint16(p+2,words.length*4,true);p+=4;for(const word of words){v.setUint32(p,word,true);p+=4;}}
  return p;};
 const setup=()=>{const reserved=query([1,1,4]);expect(reserved.words).toEqual([0,1,1,1,4,0,0,0,0,0,0,magic]);
  const registered=query([2,2,capture]);expect(registered.words.slice(0,5)).toEqual([0,2,2,1,1]);return {id:1,token:1};};
 const dispose=()=>{const journal=b.programJournal;journal?.retire();if(journal)for(let i=0;i<4;i++)for(let t=1;t<10;t++)journal.discard(i,t);
  execution.release();registry.unbind(1);expect(native.size).toBe(0);};
 return {b,gl,program,registry,muxer,execution,capture,selected,native,bind,query,emit,setup,dispose};
}
it("owns cold buffer receivers through journal closure without repeating preparation",()=>{
 const f=fixture();f.setup();let created=0;
 Object.assign(f.gl,{createBuffer:()=>{created++;const buffer={};f.native.add(buffer);return buffer;},deleteBuffer:(buffer:object|null)=>{if(buffer)f.native.delete(buffer);}});
 const journal=f.b.programJournal!;
 expect(journal.prepareBufferSnapshots(2)).toBe(2);expect(created).toBe(2);
 expect(journal.prepareBufferSnapshots(2)).toBe(2);expect(journal.prepareBufferSnapshots(1)).toBe(0);expect(created).toBe(2);
 expect(bindBufferObject(f.b,0x8892,3)).toBe(true);const object=f.b.buffers.get(3)!;
 expect(journal.defineBufferSnapshot(0,1,0x8892,new Uint8Array([1,2]),0x88e4)).toBe(true);
 const copy=journal.resolveBufferSnapshot(0,1,object,2)!;expect(copy).not.toBeNull();expect(f.native.has(copy)).toBe(true);
 journal.retire();expect(f.native.has(copy)).toBe(false);expect(journal.resolveBufferSnapshot(0,1,object,2)).toBeNull();
 expect(journal.prepareBufferSnapshots(2)).toBe(0);f.dispose();
});
it("retains a partially prepared buffer bank in its journal until retirement",()=>{
 const f=fixture();f.setup();let created=0;
 Object.assign(f.gl,{createBuffer:()=>{if(++created===2)return null;const buffer={};f.native.add(buffer);return buffer;},deleteBuffer:(buffer:object|null)=>{if(buffer)f.native.delete(buffer);}});
 const journal=f.b.programJournal!;
 expect(journal.prepareBufferSnapshots(3)).toBe(0);expect(created).toBe(2);
 expect(journal.prepareBufferSnapshots(3)).toBe(0);expect(created).toBe(2);f.dispose();
});
it("reads immutable uniform signatures without selecting or changing the mutation receipt or errors",()=>{
 const f=fixture();f.setup();
 Object.assign(f.gl,{
  getProgramParameter:(_p:object,pname:number)=>pname===0x8b86?2:true,
  getActiveUniform:(_p:object,index:number)=>index===0?{name:"matrices[0]",type:0x8b5c,size:3}:{name:"scalar",type:0x1406,size:1},
  getUniformLocation:()=>({}),
 });
 const receipt=f.query([6]).words;f.b.errors.push(0x500,0x501);
 expect(f.query([8,1,1,1]).words).toEqual([0,0,8,1,1,1,0x8b5c,2,3,0,0,magic]);
 expect(f.query([8,1,1,3]).words).toEqual([0,0,8,1,1,3,0x1406,1,2,0,0,magic]);
 expect(f.query([8,1,1,400]).words).toEqual([0,0,8,1,1,400,0,0,0,0,0,magic]);
 expect(f.query([8,1,1,0xffff_fffe]).words).toEqual([0,0,8,1,1,0xffff_fffe,0,0,0,0,0,magic]);
 expect(f.query([6]).words).toEqual(receipt);expect(f.b.errors).toEqual([0x500,0x501]);expect(f.selected).toEqual([]);
 const reflection=vi.spyOn(f.gl,"getActiveUniform");f.query([8,1,1,1]);expect(reflection).not.toHaveBeenCalled();reflection.mockRestore();f.dispose();
});
it("distinguishes absent native locations from deferred long names without resolving them",()=>{
 const f=fixture();f.setup();const long="u".repeat(257),lookups:string[]=[];
 Object.assign(f.gl,{
  getProgramParameter:(_p:object,pname:number)=>pname===0x8b86?2:true,
  getActiveUniform:(_p:object,index:number)=>({name:index?long:"absent",type:0x8b5a,size:1}),
  getUniformLocation:(_p:object,name:string)=>{lookups.push(name);return null;},
 });
 expect(f.query([8,1,1,0]).words.slice(6,9)).toEqual([0x8b5a,1,4]);
 expect(f.query([8,1,1,1]).words.slice(6,9)).toEqual([0x8b5a,1,0]);
 expect(lookups).toEqual(["absent"]);f.dispose();
});
it("refuses foreign or collected generation proofs and denies signature reads through the lifecycle barrier",()=>{
 const f=fixture();f.setup();
 for(const [id,token] of [[2,1],[1,99],[1,0]])expect(f.query([8,id,token,0]).words).toEqual([1,0,8,id,token,0,0,0,0,0,0,magic]);
 const out=new Uint8Array(48).fill(0xa5);
 expect(runGlQuery(f.b,QOP_PROGRAM_JOURNAL_BARRIER,new Uint8Array(new Uint32Array([8,1,1,0]).buffer),out)).toBe(-22);
 expect([...out]).toEqual(Array(48).fill(0xa5));
 expect(f.b.programJournal!.releaseCapture(1)).toBe(true);
 expect(f.query([8,1,1,0]).words[0]).toBe(1);f.dispose();
});
it("keeps the old executable signature after its public name points at a different link",()=>{
 const f=fixture();f.setup();const newer={};f.native.add(newer);
 Object.assign(f.gl,{
  getProgramParameter:(_p:object,pname:number)=>pname===0x8b86?1:true,
  getActiveUniform:(p:object)=>({name:"matrix",type:p===f.program?0x8b5c:0x1406,size:1}),
  getUniformLocation:()=>({}),
 });
 f.b.programs.set(20,newer);
 expect(f.query([8,1,1,0]).words.slice(6,9)).toEqual([0x8b5c,1,2]);
 const handle=captureContextGlProgram(f.execution,20);expect(f.query([2,3,handle]).words[4]).toBe(2);
 expect(f.query([8,1,2,0]).words.slice(6,9)).toEqual([0x1406,1,2]);
 expect(f.selected).toEqual([]);f.dispose();
});
it("reserves, registers and publishes a batch before selecting its exact native generation",()=>{
 const f=fixture();f.setup();
 const accepted=f.query([3,3,2,1,0,1,0,1,0,20,1,1,1,2,0,2,0,0,0]);
 expect(accepted.words).toEqual([0,3,3,1,2,2,0,2,0,0,0,magic]);expect(f.selected).toEqual([]);expect(publicCurrentProgramName(f.b)).toBe(0);
 const length=f.emit([[OP_USE_PROGRAM_JOURNAL,[1,0,1,0]],[OP_USE_PROGRAM_JOURNAL,[1,1,2,0]]]);
 expect(decodeAndDispatch(f.b,0,length)).toBe(0);expect(f.selected).toEqual([f.program,null]);
 expect(f.query([7,1]).words).toEqual([0,0,7,1,1,2,0,2,0,2,0,magic]);f.dispose();
});
it("preflights every row before any logical effect and clears preview cells after rejection",()=>{
 const f=fixture();f.setup();
 const rejected=f.query([3,3,2,1,0,1,0,1,0,20,1,1,1,2,0,3,0,0,0]);
 expect(rejected.words).toEqual([1,3,3,1,0,0,0,0,0,0,0,magic]);expect(publicCurrentProgramName(f.b)).toBe(0);
 expect(f.query([3,4,2,1,0,1,0,1,0,20,1,1,1,2,0,2,0,0,0]).words[0]).toBe(0);
 expect(decodeAndDispatch(f.b,0,f.emit([[OP_USE_PROGRAM_JOURNAL,[1,0,1,0]],[OP_USE_PROGRAM_JOURNAL,[1,1,2,0]]]))).toBe(0);f.dispose();
});
it("recovers a lost copyout from the retained receipt without repeating acquisition",()=>{
 const f=fixture(),out=new Uint8Array(48);const failure=vi.spyOn(out,"set").mockImplementation(()=>{throw new Error("copyout lost");});
 try{expect(()=>f.query([1,1,4],out)).toThrow("copyout lost");}finally{failure.mockRestore();}
 const journal=f.b.programJournal;expect(journal).toBeDefined();expect(f.query([6]).words).toEqual([0,1,1,1,4,0,0,0,0,0,0,magic]);
 const before=f.b.programQueryPins.get(f.program),clone=vi.spyOn(GlProgramQueryPin.prototype,"clone");
 expect(f.query([1,1,4]).rc).toBe(-22);expect(f.b.programJournal).toBe(journal);expect(f.b.programQueryPins.get(f.program)).toBe(before);
 expect(clone).not.toHaveBeenCalled();clone.mockRestore();f.dispose();
});
it("retains indeterminate status and forbids mutator retry after a native admission fault",()=>{
 const f=fixture();expect(f.query([1,1,4]).words[0]).toBe(0);
 const fail=vi.spyOn(f.b.programJournal!,"registerCapture").mockImplementation(()=>{throw new NativeGlFault("admission fault");});
 try{expect(()=>f.query([2,2,f.capture])).toThrow(NativeGlFault);}finally{fail.mockRestore();}
 expect(f.query([6]).words.slice(0,3)).toEqual([2,2,2]);expect(f.query([2,2,f.capture]).rc).toBe(-22);
 expect(f.query([2,3,f.capture]).rc).toBe(-22);f.dispose();
});
for(const kind of ["unexpected","reset"] as const)it(`retains a committed prefix without replay after ${kind} publication failure`,()=>{
 const f=fixture();f.setup();const journal=f.b.programJournal!,original=journal.publish.bind(journal);
 const reported:Error[]=[],cause=kind==="reset"?new NativeContextReset("controlled reset"):new Error("controlled publication failure");
 setNativeGlFaultReporter(fault=>{reported.push(fault);});
 const publish=vi.spyOn(journal,"publish").mockImplementation((...args)=>{
  const accepted=original(...args);expect(accepted).toBe(true);
  if(kind==="reset")markRendererReset(f.b);
  throw cause;
 });
 try{
  expect(()=>f.query([3,3,2,1,0,1,0,1,0,20,1,1,1,2,0,2,0,0,0])).toThrow(kind==="reset"?NativeContextReset:NativeGlFault);
  expect(publish).toHaveBeenCalledTimes(1);expect(f.selected).toEqual([]);
  expect(publicCurrentProgramName(f.b)).toBe(20);
  expect(f.query([6]).words.slice(0,3)).toEqual([2,3,3]);
  expect(f.query([7,1]).words.slice(5,11)).toEqual([1,0,1,0,0,0]);
  expect(f.query([3,3,1,1,0,1,0,1,0,20,1]).rc).toBe(-22);
  expect(f.query([3,4,1,1,1,2,0,2,0,0,0]).rc).toBe(-22);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(reported).toHaveLength(kind==="reset"?0:1);
  if(kind==="unexpected"){
   expect(reported[0]!.cause).toBe(cause);
   expect(reported[0]!.message).toMatch(/pid 1 session 0 transaction 3 action 3/);
  }
 }finally{publish.mockRestore();setNativeGlFaultReporter(null);f.dispose();}
});
it("keeps the receipt indeterminate until all progress fields are sealed",()=>{
 const f=fixture();f.setup();const cause=new Error("receipt snapshot failed"),reported:Error[]=[];
 setNativeGlFaultReporter(fault=>{reported.push(fault);});
 const snapshot=vi.spyOn(f.b.programJournal!,"publishedTicket","get").mockImplementation(()=>{throw cause;});
 try{
  expect(()=>f.query([3,3,2,1,0,1,0,1,0,20,1,1,1,2,0,2,0,0,0])).toThrow(NativeGlFault);
  expect(f.query([6]).words.slice(0,3)).toEqual([2,3,3]);
  expect(reported).toHaveLength(1);expect(reported[0]!.cause).toBe(cause);
 }finally{snapshot.mockRestore();setNativeGlFaultReporter(null);f.dispose();}
});

it("never wraps an exhausted generation token into an earlier wire handle",()=>{
 const f=fixture();f.setup();
 (f.b.programJournal as unknown as {nextGeneration:number}).nextGeneration=0xffff_ffff;
 expect(f.query([2,3,f.capture]).words.slice(0,5)).toEqual([0,3,2,1,0xffff_ffff]);
 const retain=vi.spyOn(GlProgramQueryPin.prototype,"clone");
 try{expect(f.query([2,4,f.capture]).words.slice(0,5)).toEqual([1,4,2,1,0]);expect(retain).not.toHaveBeenCalled();}
 finally{retain.mockRestore();}f.dispose();
});
for(const how of ["context","session"] as const)it(`reclaims unsubmitted wire metadata on ${how} retirement`,()=>{
 const f=fixture();f.setup();const group=f.b.objects;
 expect(f.query([3,3,2,1,0,1,0,1,0,20,1,1,1,2,0,2,0,0,0]).words[0]).toBe(0);
 f.execution.release();
 try {
  if(how==="context")f.registry.destroyContext(1,0);else expect(f.registry.unbind(1)).toBe(true);
  expect(group.programQueryPins.size).toBe(0);expect(group.members.size).toBe(0);expect(f.native.size).toBe(0);
 }finally{f.dispose();}
});
it("replays independently computed repeated flags at their original audited positions",()=>{
 const f=fixture();f.setup();expect(f.query([3,3,2,1,0,1,0,1,0,999,0,1,1,2,0,2,0,999,0]).words[0]).toBe(0);
 expect(f.b.errors).toEqual([]);
 configureGlAudit({mode:"fatal",sink:()=>{},fault:message=>{throw new NativeGlFault(message);}});
 const n=f.emit([[OP_USE_PROGRAM_JOURNAL,[1,0,1,0]],[OP_ERROR_OBSERVED,[2,2]],
  [OP_USE_PROGRAM_JOURNAL,[1,1,2,0]],[OP_ERROR_OBSERVED,[2,2]]]);
 expect(decodeAndDispatch(f.b,0,n)).toBe(0);expect(f.b.errors).toEqual([]);expect(f.selected).toEqual([]);f.dispose();
});
it("keeps recovery/status quiet and preserves active upload transactions and older flags",()=>{
 const f=fixture();f.setup();f.b.errors=[0x500];
 const upload={} as any,compressed={} as any;f.b.uniformUpload=upload;f.b.compressedUpload=compressed;
 const native=vi.spyOn(f.gl,"getError").mockImplementation(()=>{throw new Error("native drain");});
 try{expect(f.query([6]).rc).toBe(48);expect(f.query([7,1]).rc).toBe(48);}finally{native.mockRestore();}
 expect(f.b.uniformUpload).toBe(upload);expect(f.b.compressedUpload).toBe(compressed);expect(f.b.errors).toEqual([0x500]);
 f.b.uniformUpload=null;f.b.compressedUpload=null;f.dispose();
});
it("gives metadata peers no selector authority and never reuses a disabled journal handle",()=>{
 const f=fixture();f.setup();const peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
 expect(f.query([3,3,1,1,0,1,0,1,0,20,1]).words[0]).toBe(0);
 const n=f.emit([[OP_USE_PROGRAM_JOURNAL,[1,0,1,0]]]);peer.cmdbufView!.set(f.b.cmdbufView!.subarray(0,n));
 expect(()=>decodeAndDispatch(peer,0,n)).toThrow(NativeGlFault);expect(f.selected).toEqual([]);
 expect(decodeAndDispatch(f.b,0,n)).toBe(0);expect(f.query([5,4]).words[0]).toBe(0);
 expect(f.query([1,5,4]).words[3]).toBe(2);
 expect(()=>decodeAndDispatch(f.b,0,n)).toThrow(NativeGlFault);f.dispose();
});
it("does not let older identical errors manufacture a successful operation receipt",()=>{
 const f=fixture();f.setup();f.b.errors=[0x502];
 expect(f.query([4,3,1,999]).words[0]).toBe(1);expect(f.b.errors).toEqual([0x502]);f.dispose();
});
it("shares the receipt ledger for lifecycle metadata without granting cold acquisition",()=>{
 const f=fixture();f.setup();const barrier=(words:number[],out=new Uint8Array(48).fill(0xa5))=>{
  const rc=runGlQuery(f.b,QOP_PROGRAM_JOURNAL_BARRIER,new Uint8Array(new Uint32Array(words).buffer),out,f.execution);
  return {rc,words:[...new Uint32Array(out.buffer)]};
 };
 for(const words of [[1,3,4],[2,3,f.capture],[4,3,1,1],[5,3]]){
  expect(barrier(words)).toEqual({rc:-22,words:new Array(12).fill(0xa5a5a5a5)});
 }
 expect(barrier([6]).words).toEqual(f.query([6]).words);
 expect(barrier([3,3,2,1,0,1,0,1,0,20,1,1,1,2,0,2,0,0,0]).words.slice(0,7)).toEqual([0,3,3,1,2,2,0]);
 expect(f.query([6]).words[1]).toBe(3);expect(f.selected).toEqual([]);
 expect(decodeAndDispatch(f.b,0,f.emit([[OP_USE_PROGRAM_JOURNAL,[1,0,1,0]],[OP_USE_PROGRAM_JOURNAL,[1,1,2,0]]]))).toBe(0);
 f.dispose();
});
it("refuses lifecycle metadata through a missing native public context",()=>{
 const f=fixture();const previous=f.b.contextId;f.b.contextId=null;
 const out=new Uint8Array(48).fill(0xa5);
 expect(runGlQuery(f.b,QOP_PROGRAM_JOURNAL_BARRIER,new Uint8Array(new Uint32Array([6]).buffer),out)).toBe(-22);
 expect([...out]).toEqual(new Array(48).fill(0xa5));f.b.contextId=previous;f.dispose();
});
for(const words of [[0],[1,0,4],[1,1,257],[2,1,0],[3,1,0],[3,1,1],[4,1,0,1],[5,1,1],[6,1],[7,0],
 [3,1,1,1,256,1,0,1,0,20,1],[3,1,1,1,0,1,0x20_0000,1,0,20,1]])
 it(`rejects malformed wire ${words}`,()=>{const f=fixture();const q=f.query(words);expect(q.rc).toBe(-22);
  expect([...q.out]).toEqual(new Array(48).fill(0xa5));expect(f.b.programJournal).toBeUndefined();f.dispose();});
for(const n of [0,16,44,52])it(`preflights the entire reply capacity ${n}`,()=>{
 const f=fixture(),q=f.query([1,1,4],new Uint8Array(n).fill(0xa5));expect(q.rc).toBe(-22);expect(f.b.programJournal).toBeUndefined();f.dispose();
});
it("rejects a malformed trailing selector before any native mutation",()=>{
 const f=fixture();f.setup();expect(f.query([3,3,1,1,0,1,0,1,0,20,1]).words[0]).toBe(0);
 const n=f.emit([[OP_USE_PROGRAM_JOURNAL,[1,0,1,0]],[OP_USE_PROGRAM_JOURNAL,[1,0,0,0]]]);
 expect(validateCommandBuffer(f.b.cmdbufView!,0,n)).toBeLessThan(0);expect(decodeAndDispatch(f.b,0,n)).toBeLessThan(0);
 expect(f.selected).toEqual([]);f.dispose();
});

function shaderRetirementFixture(){
 const f=fixture(),deleted:WebGLShader[]=[],a={},shaderB={};let next=0;
 f.gl.createShader=()=>[a,shaderB][next++] as WebGLShader;
 f.gl.deleteShader=(shader:WebGLShader)=>{deleted.push(shader);};
 createShaderIfAccepted(f.b,0x8b31,40);createShaderIfAccepted(f.b,0x8b30,41);
 f.b.programShaders.set(20,new Set([40,41]));
 f.b.shaderDeletePending.add(40);f.b.shaderDeletePending.add(41);f.b.programDeletePending.add(20);
 return {...f,deleted,a,shaderB};
}
it("retires all dependent shader names before a pending native OOM and keeps exact physical custody",()=>{
 const f=shaderRetirementFixture();let pending=true;
 f.gl.getError=()=>{if(pending){pending=false;return 0x505;}return 0;};
 expect(withNativeBatch(f.b,"publication cleanup",()=>{finalizeProgram(f.b,20);return 0;})).toBe(-19);
 expect(f.b.programs.has(20)).toBe(false);expect(f.b.shaders.size).toBe(0);
 expect(f.b.shaderDeletePending.size).toBe(0);expect(f.deleted).toEqual([]);
 const head=f.b.objects.retiredShaders!;expect(head.shader).toBe(f.shaderB);expect(head.next!.shader).toBe(f.a);
 const reads=vi.spyOn(f.gl,"getError");
 expect(f.query([6]).rc).toBe(48);expect(reads).not.toHaveBeenCalled();
 expect(f.b.objects.retiredShaders).toBe(head);reads.mockRestore();
 // Logical reset does not lose the shared physical renderer's objects.
 retireShaderObjects(f.b);expect(f.deleted).toEqual([f.shaderB,f.a]);
 expect(f.b.objects.retiredShaders).toBeNull();f.dispose();
});
it("reserves shader deletion custody at creation without a late weak-map publication",()=>{
 const f=shaderRetirementFixture();
 const late=vi.spyOn(WeakMap.prototype,"set").mockImplementation(()=>{throw new Error("late shader custody allocation");});
 try{finalizeProgram(f.b,20);expect(late).not.toHaveBeenCalled();}
 finally{late.mockRestore();}
 expect(f.b.shaders.size).toBe(0);expect(f.deleted).toEqual([f.shaderB,f.a]);f.dispose();
});
it.each([0x502,0x505])("keeps refused shader cleanup0x%s fatal with its exact deletion receiver retained",code=>{
 const f=shaderRetirementFixture();let error=0;
 f.gl.deleteShader=()=>{error=code;};f.gl.getError=()=>{const result=error;error=0;return result;};
 expect(()=>finalizeProgram(f.b,20)).toThrow(NativeGlFault);
 expect(f.b.shaders.size).toBe(0);expect(f.b.objects.retiredShaders!.shader).toBe(f.shaderB);
 f.gl.deleteShader=(shader:WebGLShader)=>{f.deleted.push(shader);};
 retireShaderObjects(f.b);expect(f.deleted).toEqual([f.shaderB,f.a]);f.dispose();
});

it("reads owned guest uniform types while preserving the legacy signature bytes and receipt",()=>{
 const f=fixture();f.setup();const shader={} as WebGLShader;
 recordCompiledExternalSamplers(shader,["external"]);recordLinkedExternalSamplers(f.program,true,[shader]);
 Object.assign(f.gl,{getProgramParameter:(_p:object,pname:number)=>pname===0x8b86?2:true,
  getActiveUniform:(_p:object,index:number)=>({name:index?"plain":"external",type:0x8b5e,size:1}),getUniformLocation:()=>({})});
 try{
  const receipt=f.query([6]).words;f.b.errors.push(0x500,0x501);
  const legacy=f.query([8,1,1,0]).words;
  expect(f.query([9,1,1,0]).words).toEqual([0,0,9,1,1,0,0x8b5e,1,2,0x8d66,0,magic]);
  expect(f.query([9,1,1,1]).words).toEqual([0,0,9,1,1,1,0x8b5e,1,2,0x8b5e,0,magic]);
  expect(f.query([8,1,1,0]).words).toEqual(legacy);expect(legacy[9]).toBe(0);
  expect(f.query([6]).words).toEqual(receipt);expect(f.b.errors).toEqual([0x500,0x501]);expect(f.selected).toEqual([]);
 }finally{f.dispose();}
});
it("reports a translated cube's guest type from its immutable owned generation",()=>{
 const f=fixture();f.setup();const shader={} as WebGLShader;
 recordShaderLanguage(shader,"essl300","uniform samplerCube cube;void main(){gl_Position=textureCube(cube,vec3(1.,0.,0.));}",false);
 recordLinkedExternalSamplers(f.program,true,[shader]);
 Object.assign(f.gl,{getProgramParameter:(_p:object,pname:number)=>pname===0x8b86?1:true,
  getActiveUniform:()=>({name:"cube",type:0x8dc1,size:1}),getUniformLocation:()=>({})});
 try{
  expect(f.query([9,1,1,0]).words).toEqual([0,0,9,1,1,0,0x8dc1,1,2,0x8b60,0,magic]);
  expect(f.query([8,1,1,0]).words).toEqual([0,0,8,1,1,0,0x8dc1,1,2,0,0,magic]);
 }finally{f.dispose();}
});
it("denies guest-type reflection through foreign, retired and lifecycle authority",()=>{
 const f=fixture();f.setup();
 try{
  for(const [id,token] of [[2,1],[1,99],[1,0]])expect(f.query([9,id,token,0]).words).toEqual([1,0,9,id,token,0,0,0,0,0,0,magic]);
  const out=new Uint8Array(48).fill(0xa5);
  expect(runGlQuery(f.b,QOP_PROGRAM_JOURNAL_BARRIER,new Uint8Array(new Uint32Array([9,1,1,0]).buffer),out)).toBe(-22);
  expect([...out]).toEqual(Array(48).fill(0xa5));expect(f.b.programJournal!.releaseCapture(1)).toBe(true);
  expect(f.query([9,1,1,0]).words).toEqual([1,0,9,1,1,0,0,0,0,0,0,magic]);
 }finally{f.dispose();}
});
