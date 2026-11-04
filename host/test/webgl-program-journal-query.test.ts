import {afterEach,expect,it,vi} from "vitest";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {GlMuxer} from "../src/webgl/muxer.js";
import {runGlQuery} from "../src/webgl/query.js";
import {captureContextGlProgram} from "../src/webgl/program-captures.js";
import {publicCurrentProgramName,GlProgramQueryPin} from "../src/webgl/program-objects.js";
import {decodeAndDispatch,validateCommandBuffer} from "../src/webgl/bridge.js";
import {QOP_PROGRAM_JOURNAL,QOP_PROGRAM_JOURNAL_BARRIER,OP_USE_PROGRAM_JOURNAL,OP_ERROR_OBSERVED} from "../src/webgl/ops.js";
import {NativeGlFault,setNativeGlFaultReporter} from "../src/webgl/native-recovery.js";
import {NativeContextReset} from "../src/webgl/native-batch.js";
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
