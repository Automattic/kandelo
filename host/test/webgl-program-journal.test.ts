import {expect,it,vi} from "vitest";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {GlMuxer} from "../src/webgl/muxer.js";
import {GlProgramJournal} from "../src/webgl/program-journal.js";
import {captureContextGlProgram,releaseGlProgramCapture} from "../src/webgl/program-captures.js";
import {GlProgramQueryPin,currentProgramName,publicCurrentProgramName,finalizeProgram,useProgramIfAccepted,
  linkProgramRetainingExecutable} from "../src/webgl/program-objects.js";
import {consumeObservedGlError} from "../src/webgl/errors.js";
import {NativeGlFault} from "../src/webgl/native-recovery.js";
import {runGlQuery} from "../src/webgl/query.js";
import {QOP_GET_INTEGERV} from "../src/webgl/ops.js";

function fixture(capacity=4,installed=false) {
  const live=new Set<object>(),selected:(object|null)[]=[],deleted:object[]=[];
  let native:object|null=null,error=0,refuseSelect=false,refuseDelete=false;
  const make=()=>{const p={};live.add(p);return p;};
  const gl=new Proxy({getError:()=>{const value=error;error=0;return value;},isContextLost:()=>false,
    getParameter:(p:number)=>p===0x8b8d?native:null,
    getProgramParameter:(_p:object,pname:number)=>pname===0x8b82?true:0,
    createProgram:make,deleteProgram:(p:object)=>{if(refuseDelete){error=0x502;return;}live.delete(p);deleted.push(p);},
    useProgram:(p:object|null)=>{selected.push(p);if(refuseSelect)error=0x502;else native=p;}},
    {get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);
  const bind=(session:number,pid=1)=>{
    registry.bind({pid,sessionId:session,cmdbufAddr:0,cmdbufLen:64});
    const b=registry.get(pid,session)!;b.gl=gl;b.contextId=session+1;return b;
  };
  const b=bind(0),p=make(),q=make();
  for(const [name,program] of [[20,p],[30,q]] as const){b.programs.set(name,program);b.programShaders.set(name,new Set());}
  if(installed)expect(useProgramIfAccepted(b,20)).toBe(true);
  const execution=registry.retainContextExecution(1,0,muxer)!;
  const capture=captureContextGlProgram(execution,20),captureQ=captureContextGlProgram(execution,30);
  const journal=GlProgramJournal.create(execution,capacity)!;expect(journal).not.toBeNull();
  const token=journal.registerCapture(capture),tokenQ=journal.registerCapture(captureQ);expect(token).toBeGreaterThan(0);expect(tokenQ).toBeGreaterThan(0);
  const dispose=()=>{journal.retire();execution.release();registry.unbind(1);expect(live.size).toBe(0);};
  return {b,p,q,gl,group:b.objects,registry,muxer,execution,capture,captureQ,journal,token,tokenQ,selected,deleted,live,bind,dispose,
    refuseSelect:(value:boolean)=>{refuseSelect=value;},refuseDelete:(value:boolean)=>{refuseDelete=value;}};
}
it("publishes public current names without installing native executables",()=>{
  const f=fixture();expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);
  expect(publicCurrentProgramName(f.b)).toBe(20);expect(currentProgramName(f.b)).toBe(0);expect(f.selected).toEqual([]);
  const out=new Uint8Array(4);
  expect(runGlQuery(f.b,QOP_GET_INTEGERV,new Uint8Array(new Uint32Array([0x8b8d]).buffer),out)).toBe(4);
  expect(new DataView(out.buffer).getUint32(0,true)).toBe(20);
  expect(f.journal.execute(0,1)).toBe(true);expect(f.selected).toEqual([f.p]);expect(currentProgramName(f.b)).toBe(20);f.dispose();
});
it("keeps a deleted logically current name then executes its private generation after the name retires",()=>{
  const f=fixture();expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);
  f.b.programDeletePending.add(20);finalizeProgram(f.b,20);expect(f.b.programs.has(20)).toBe(true);
  expect(f.journal.publish(f.b,1,2,2,0,0)).toBe(true);expect(f.b.programs.has(20)).toBe(false);
  expect(f.journal.releaseCapture(f.token)).toBe(true);expect(releaseGlProgramCapture(f.b,f.capture)).toBe(true);
  expect(f.journal.execute(0,1)).toBe(true);expect(f.selected.at(-1)).toBe(f.p);
  expect(publicCurrentProgramName(f.b)).toBe(0);expect(currentProgramName(f.b)).toBe(20);expect(f.live.has(f.p)).toBe(true);
  expect(f.journal.execute(1,2)).toBe(true);expect(f.live.has(f.p)).toBe(false);f.dispose();
});
it("retains a predecessor independently until the successor's native switch",()=>{
  const f=fixture(4,true);expect(f.journal.publish(f.b,0,1,1,30,f.tokenQ)).toBe(true);
  f.b.programDeletePending.add(20);finalizeProgram(f.b,20);expect(f.b.programs.has(20)).toBe(false);
  expect(f.journal.releaseCapture(f.token)).toBe(true);expect(releaseGlProgramCapture(f.b,f.capture)).toBe(true);
  expect(f.live.has(f.p)).toBe(true);expect(f.journal.execute(0,1)).toBe(true);expect(f.live.has(f.p)).toBe(false);f.dispose();
});
it("does not let the last query pin delete a latest public name retained by an older logical executable",()=>{
  const f=fixture();expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);
  const latest=f.gl.createProgram()!;f.b.programs.set(20,latest);f.b.programDeletePending.add(20);
  const pin=GlProgramQueryPin.acquire(f.execution,20)!;expect(pin.release()).toBe(true);
  expect(f.b.programs.get(20)).toBe(latest);expect(f.live.has(latest)).toBe(true);
  expect(f.journal.execute(0,1)).toBe(true);
  expect(f.journal.publish(f.b,1,2,2,0,0)).toBe(true);expect(f.b.programs.has(20)).toBe(false);expect(f.live.has(latest)).toBe(false);
  expect(f.journal.execute(1,2)).toBe(true);f.dispose();
});
it("replays repeated errors only at their original observation positions",()=>{
  const f=fixture();f.b.errors=[0x500];
  expect(f.journal.publish(f.b,0,1,1,999,0)).toBe(true);expect(f.journal.publish(f.b,1,2,2,999,0)).toBe(true);
  expect(f.b.errors).toEqual([0x500]);expect(f.journal.execute(0,1)).toBe(true);expect(f.b.errors).toEqual([0x500,0x501]);
  consumeObservedGlError(f.b,1<<1);expect(f.b.errors).toEqual([0x500]);
  expect(f.journal.execute(1,2)).toBe(true);expect(f.b.errors).toEqual([0x500,0x501]);expect(f.selected).toEqual([]);f.dispose();
});
it("computes stale-generation rejection without accepting the later mutable name",()=>{
  const f=fixture();f.b.programs.set(20,f.q);
  expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);expect(publicCurrentProgramName(f.b)).toBe(0);
  expect(f.b.errors).toEqual([]);expect(f.journal.execute(0,1)).toBe(true);expect(f.b.errors).toEqual([0x502]);expect(f.selected).toEqual([]);f.dispose();
});
it("shares metadata ordering across peer journals while keeping execution ordered per context",()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const lease=f.registry.retainContextExecution(1,12,f.muxer)!,capture=captureContextGlProgram(lease,20);
  const journal=GlProgramJournal.create(lease,2)!,token=journal.registerCapture(capture);
  expect(f.journal.publish(peer,0,1,1,20,f.token)).toBe(true);
  expect(journal.publish(f.b,0,1,1,20,token)).toBe(false);expect(journal.publish(f.b,0,1,2,20,token)).toBe(true);
  expect(journal.execute(0,1)).toBe(true);expect(f.journal.execute(0,1)).toBe(true);
  journal.retire();lease.release();f.dispose();
});
it("refuses foreign process, group and retired authority without consuming a cell or sequence",()=>{
  const f=fixture(),foreign=f.bind(12),pid={...f.b,pid:2};
  for(const authority of [foreign,pid,{...f.b,contextId:null}])expect(f.journal.publish(authority,0,1,1,20,f.token)).toBe(false);
  expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);expect(f.journal.execute(0,1)).toBe(true);
  f.dispose();
});
for(const index of [-1,4,0.5,NaN])it(`rejects invalid slot ${index} without changing logical current`,()=>{
  const f=fixture();expect(f.journal.publish(f.b,index,1,1,20,f.token)).toBe(false);expect(publicCurrentProgramName(f.b)).toBe(0);
  expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);expect(f.journal.execute(0,1)).toBe(true);f.dispose();
});
it("bounds pending cells and refuses stale tickets and out-of-order execution",()=>{
  const f=fixture(1);expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);
  expect(f.journal.publish(f.b,0,2,2,0,0)).toBe(false);expect(f.journal.execute(0,2)).toBe(false);
  expect(f.journal.execute(0,1)).toBe(true);expect(f.journal.publish(f.b,0,2,2,0,0)).toBe(true);
  expect(f.journal.execute(0,1)).toBe(false);expect(f.journal.execute(0,2)).toBe(true);expect(f.journal.execute(0,2)).toBe(false);f.dispose();
});
it("keeps accepted work through public context destruction without retaining its public name",()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const frame=f.execution.clone()!;expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);
  f.b.programDeletePending.add(20);f.execution.release();f.registry.destroyContext(1,0);
  expect(peer.programs.has(20)).toBe(false);expect(f.live.has(f.p)).toBe(true);
  expect(f.journal.execute(0,1)).toBe(true);expect(frame.binding.currentProgram).toBe(f.p);expect(f.live.has(f.p)).toBe(true);
  expect(frame.release()).toBe(true);expect(f.live.has(f.p)).toBe(false);
  f.registry.unbind(1);expect(f.live.size).toBe(0);
  expect(f.group.members.size).toBe(0);
});
it("does not clone pins or allocate map entries during logical publication or execution",()=>{
  const f=fixture(),clone=vi.spyOn(GlProgramQueryPin.prototype,"clone").mockImplementation(()=>{throw new Error("late clone");});
  const original=Map.prototype.set,publication=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
    if(!this.has(key))throw new Error("late map entry");return original.call(this,key,value);
  });
  try {expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);expect(f.journal.execute(0,1)).toBe(true);}
  finally{clone.mockRestore();publication.mockRestore();}f.dispose();
});
for(const mode of ["refusal","throw"] as const)it(`retains failed cold admission rollback after ${mode}`,()=>{
  const f=fixture(),original=Map.prototype.set;
  const publication=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
    if(value && typeof value==="object" && "cache" in value && "references" in value) {
      original.call(this,key,value);throw new Error("cold index publication after insertion");
    }
    return original.call(this,key,value);
  });
  const cleanup=vi.spyOn(GlProgramQueryPin.prototype,"release").mockImplementation(()=>{if(mode==="throw")throw new Error("cleanup threw");return false;});
  try {expect(()=>f.journal.registerCapture(f.capture)).toThrow(NativeGlFault);}
  finally{publication.mockRestore();cleanup.mockRestore();}
  f.dispose();
});
it("rejects peer-owned capture registration before acquiring native custody",()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const lease=f.registry.retainContextExecution(1,12,f.muxer)!,capture=captureContextGlProgram(lease,20);
  const before=f.b.programQueryPins.get(f.p);expect(f.journal.registerCapture(capture)).toBe(0);expect(f.b.programQueryPins.get(f.p)).toBe(before);
  lease.release();f.dispose();
});
it("requires explicit drain and disable before legacy link/use without dropping accepted work",()=>{
  const f=fixture();expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);expect(f.journal.disable()).toBe(false);
  expect(()=>useProgramIfAccepted(f.b,20)).toThrow(NativeGlFault);expect(()=>linkProgramRetainingExecutable(f.b,20)).toThrow(NativeGlFault);
  expect(f.journal.execute(0,1)).toBe(true);expect(f.journal.disable()).toBe(true);expect(f.b.programJournal).toBeUndefined();
  expect(publicCurrentProgramName(f.b)).toBe(20);expect(useProgramIfAccepted(f.b,0)).toBe(true);f.dispose();
});
it("never replays a refused native selector and retains cleanup until fault retirement",()=>{
  const f=fixture();expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);f.refuseSelect(true);
  expect(f.journal.execute(0,1)).toBe(false);expect(f.journal.execute(0,1)).toBe(false);expect(f.selected).toHaveLength(1);
  f.refuseSelect(false);f.journal.retire();expect(f.journal.discard(0,1)).toBe(true);expect(f.journal.discard(0,1)).toBe(false);f.dispose();
});
for(const mode of ["refusal","throw"] as const)it(`keeps exact generation custody after final native cleanup ${mode}`,()=>{
  const f=fixture();expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);expect(f.journal.execute(0,1)).toBe(true);
  f.b.programDeletePending.add(20);expect(f.journal.releaseCapture(f.token)).toBe(true);expect(releaseGlProgramCapture(f.b,f.capture)).toBe(true);
  expect(f.journal.publish(f.b,1,2,2,0,0)).toBe(true);
  const cleanup=vi.spyOn(GlProgramQueryPin.prototype,"release").mockImplementation(()=>{if(mode==="throw")throw new Error("cleanup threw");return false;});
  try {expect(()=>f.journal.execute(1,2)).toThrow(NativeGlFault);expect(f.journal.execute(1,2)).toBe(false);}
  finally{cleanup.mockRestore();}f.dispose();
});

it("retries public-name finalization after a failed cold-owner retirement",()=>{
  const f=fixture();expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);
  f.b.programDeletePending.add(20);
  const cleanup=vi.spyOn(GlProgramQueryPin.prototype,"release").mockImplementation(()=>false);
  try {expect(()=>f.journal.retire()).toThrow(NativeGlFault);}
  finally{cleanup.mockRestore();}
  expect(f.b.programJournal).toBe(f.journal);
  f.journal.retire();expect(f.b.programs.has(20)).toBe(false);
  expect(f.journal.discard(0,1)).toBe(true);f.dispose();
});
it("pins the installed old executable when a newer named link has failed",()=>{
  const f=fixture(4,true);expect(f.journal.disable()).toBe(true);
  const failed=f.gl.createProgram()!;f.b.programs.set(20,failed);
  const status=vi.spyOn(f.gl,"getProgramParameter").mockImplementation((p:object,pname:number)=>pname===0x8b82?p!==failed:0);
  try {
    const next=GlProgramJournal.create(f.execution,2)!;expect(next).not.toBeNull();
    f.b.programDeletePending.add(20);expect(next.publish(f.b,0,1,1,0,0)).toBe(true);
    expect(f.b.programs.has(20)).toBe(false);expect(f.live.has(failed)).toBe(false);
    expect(releaseGlProgramCapture(f.b,f.capture)).toBe(true);expect(f.live.has(f.p)).toBe(true);
    expect(next.execute(0,1)).toBe(true);expect(f.live.has(f.p)).toBe(false);next.retire();
  } finally{status.mockRestore();}f.dispose();
});
it("refuses journal activation on a retained but publicly retired context",()=>{
  const f=fixture(),frame=f.execution.clone()!;f.execution.release();f.registry.destroyContext(1,0);
  const next=GlProgramJournal.create(frame,2);if(next)next.retire();
  expect(next).toBeNull();frame.release();f.registry.unbind(1);expect(f.live.size).toBe(0);
});
for(const mode of ["refusal","throw"] as const)it(`keeps the installed-root rollback receiver after ${mode}`,()=>{
  const f=fixture(4,true);expect(f.journal.disable()).toBe(true);const original=Map.prototype.set;
  const publication=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
    if(key===0 && value && typeof value==="object" && "cache" in value && "references" in value) {
      original.call(this,key,value);throw new Error("root index publication after insertion");
    }
    return original.call(this,key,value);
  });
  const cleanup=vi.spyOn(GlProgramQueryPin.prototype,"release").mockImplementation(()=>{if(mode==="throw")throw new Error("root cleanup threw");return false;});
  try {expect(()=>GlProgramJournal.create(f.execution,2)).toThrow(NativeGlFault);}
  finally{cleanup.mockRestore();publication.mockRestore();}
  expect(f.b.programJournal).toBeDefined();f.b.programJournal!.retire();expect(f.b.programJournal).toBeUndefined();f.dispose();
});
it("clears retired logical-name state before reusing a public session",()=>{
  const f=fixture();f.execution.release();f.registry.destroyContext(1,0);
  expect(f.registry.get(1,0)).toBe(f.b);expect(f.b.contextId).toBeNull();
  f.b.gl=f.gl;f.b.contextId=77;
  const program=f.gl.createProgram()!;f.b.programs.set(56,program);f.b.programShaders.set(56,new Set());
  expect(useProgramIfAccepted(f.b,56)).toBe(true);expect(publicCurrentProgramName(f.b)).toBe(56);
  f.dispose();
});

it("preserves a native allocation failure instead of inventing a false-link error",()=>{
  const f=fixture(),status=vi.spyOn(f.gl,"getProgramParameter").mockReturnValue(null);
  let reads=0;const errors=vi.spyOn(f.gl,"getError").mockImplementation(()=>++reads===2?0x505:0);
  try {expect(f.journal.registerCapture(f.capture)).toBe(0);expect(f.b.errors).toEqual([0x505]);}
  finally{status.mockRestore();errors.mockRestore();}f.dispose();
});
it("keeps peer publication cleanup errors with the current metadata authority",()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  f.b.shaders.set(101,{});f.b.shaderDeletePending.add(101);f.b.programShaders.get(20)!.add(101);
  expect(f.journal.publish(f.b,0,1,1,20,f.token)).toBe(true);f.b.programDeletePending.add(20);
  let reads=0;const errors=vi.spyOn(f.gl,"getError").mockImplementation(()=>reads++===0?0x500:0);
  try {expect(f.journal.publish(peer,1,2,2,0,0)).toBe(true);}
  finally{errors.mockRestore();}
  expect(f.b.errors).toEqual([]);expect(peer.errors).toEqual([0x500]);
  expect(f.journal.execute(0,1)).toBe(true);expect(f.journal.execute(1,2)).toBe(true);f.dispose();
});
