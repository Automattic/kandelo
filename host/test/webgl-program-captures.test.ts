import { expect,it,vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { NativeGlFault } from "../src/webgl/native-recovery.js";
import { GlProgramQueryPin } from "../src/webgl/program-objects.js";
import { captureContextGlProgram,captureGlProgram,retainGlProgramCapture,releaseGlProgramCapture } from "../src/webgl/program-captures.js";

function fixture() {
  const live=new Set<object>(),deleted:object[]=[];
  const make=()=>{const p={};live.add(p);return p;};
  const gl=new Proxy({getError:()=>0,getParameter:()=>null,isContextLost:()=>false,
    createProgram:make,deleteProgram:(p:object)=>{live.delete(p);deleted.push(p);}},
    {get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);
  const bind=(session:number)=>{
    registry.bind({pid:1,sessionId:session,cmdbufAddr:0,cmdbufLen:64});
    const b=registry.get(1,session)!;b.gl=gl;b.contextId=session+1;return b;
  };
  const owner=bind(0),program=gl.createProgram()!;owner.programs.set(20,program);owner.programShaders.set(20,new Set());
  const execution=registry.retainContextExecution(1,0,muxer)!;
  return {registry,muxer,gl,owner,program,execution,live,deleted,bind,group:owner.objects};
}
for(const removal of ["destroy","unbind"] as const)
  it(`releases cache custody before final public ${removal} without a reference cycle`,()=>{
    const f=fixture(),handle=captureGlProgram(f.execution,20);
    expect(handle).toBe(1);expect(f.execution.release()).toBe(true);
    if(removal==="destroy")f.registry.destroyContext(1,0);else f.registry.unbind(1);
    expect(f.live.size).toBe(0);expect(f.deleted.filter(p=>p===f.program)).toHaveLength(1);
    expect(f.group.members.size).toBe(0);expect(f.owner.programQueryPins.size).toBe(0);
    expect(retainGlProgramCapture(f.owner,handle)).toBeNull();
    f.registry.unbind(1);expect(f.deleted.filter(p=>p===f.program)).toHaveLength(1);
  });
it("retires only the exact context-owned cache while a shared peer and accepted clone survive",()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const own=captureContextGlProgram(f.execution,20),group=captureGlProgram(f.execution,20);
  const peerExecution=f.registry.retainContextExecution(1,12,f.muxer)!;
  const peerHandle=captureContextGlProgram(peerExecution,20),accepted=retainGlProgramCapture(f.owner,own)!;
  peerExecution.release();f.execution.release();
  f.registry.destroyContext(1,0);
  expect(retainGlProgramCapture(peer,own)).toBeNull();
  for(const handle of [peerHandle,group]) {
    const retained=retainGlProgramCapture(peer,handle)!;expect(retained.program).toBe(f.program);retained.release();
  }
  expect(accepted.program).toBe(f.program);
  f.registry.destroyContext(1,12);expect(f.live.has(f.program)).toBe(true);
  accepted.release();expect(f.live.size).toBe(0);expect(f.group.members.size).toBe(0);
});
it("rolls back a failed context-owner index publication without leaking a pin",()=>{
  const f=fixture(),original=Map.prototype.set;
  const failure=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
    if(typeof key==="number" && value===f.owner)throw new Error("owner-index allocation");
    return original.call(this,key,value);
  });
  try {expect(captureContextGlProgram(f.execution,20)).toBe(0);}finally{failure.mockRestore();}
  expect(f.owner.programQueryPins.size).toBe(0);expect(f.owner.errors).toEqual([0x505]);
  f.execution.release();f.registry.destroyContext(1,0);expect(f.live.size).toBe(0);
});
for(const custody of ["program-pin","context-execution"] as const)
it(`does not retain a deleted public name through retired private ${custody}`,()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const handle=captureContextGlProgram(f.execution,20);
  f.owner.currentProgram=f.owner.shadow.currentProgram=f.program;f.owner.currentProgramId=20;
  f.owner.programDeletePending.add(20);
  const pending=custody==="program-pin" ? retainGlProgramCapture(f.owner,handle)! : f.execution.clone()!;
  f.execution.release();f.registry.destroyContext(1,0);
  expect(peer.programs.has(20)).toBe(false);expect(f.live.has(f.program)).toBe(true);
  if(custody==="context-execution")expect(pending.binding.currentProgram).toBe(f.program);
  expect(pending.release()).toBe(true);expect(f.live.has(f.program)).toBe(false);
  f.registry.destroyContext(1,12);expect(f.group.members.size).toBe(0);expect(f.group.programQueryPins.size).toBe(0);
});
for(const mode of ["refusal","throw"] as const)
it(`keeps failed publication custody after native rollback ${mode} for explicit context containment`,()=>{
  const f=fixture(),original=Map.prototype.set;
  const publication=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
    if(typeof key==="number" && value===f.owner)throw new Error("owner publication");
    return original.call(this,key,value);
  });
  const cleanup=vi.spyOn(GlProgramQueryPin.prototype,"release").mockImplementation(()=>{
    if(mode==="throw")throw new Error("native rollback threw");return false;
  });
  try {expect(()=>captureContextGlProgram(f.execution,20)).toThrow(NativeGlFault);}
  finally{publication.mockRestore();cleanup.mockRestore();}
  expect(f.live.has(f.program)).toBe(true);expect(f.owner.programQueryPins.get(f.program)).toBe(1);
  f.execution.release();f.registry.destroyContext(1,0);
  expect(f.live.size).toBe(0);expect(f.owner.programQueryPins.size).toBe(0);expect(f.group.members.size).toBe(0);
});
it("keeps captures through one peer retirement and pending clones through the last public retirement",()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const handle=captureGlProgram(f.execution,20);f.execution.release();f.registry.destroyContext(1,0);
  expect(f.live.has(f.program)).toBe(true);
  const pending=retainGlProgramCapture(peer,handle)!;expect(pending.program).toBe(f.program);
  f.registry.destroyContext(1,12);
  expect(f.live.has(f.program)).toBe(true);expect(pending.program).toBe(f.program);
  expect(f.owner.programQueryPins.get(f.program)).toBe(1);
  expect(retainGlProgramCapture(peer,handle)).toBeNull();
  expect(pending.release()).toBe(true);expect(pending.release()).toBe(true);
  expect(f.live.size).toBe(0);expect(f.group.members.size).toBe(0);
  expect(f.deleted.filter(p=>p===f.program)).toHaveLength(1);f.registry.unbind(1);
});
it("never reuses a retired capture handle and refuses other share groups",()=>{
  const f=fixture(),first=captureGlProgram(f.execution,20),foreign=f.bind(33);
  expect(retainGlProgramCapture(foreign,first)).toBeNull();expect(foreign.errors).toEqual([0x501]);
  expect(releaseGlProgramCapture(f.owner,first)).toBe(true);
  const second=captureGlProgram(f.execution,20);expect(second).toBeGreaterThan(first);
  expect(retainGlProgramCapture(f.owner,first)).toBeNull();
  expect(releaseGlProgramCapture(f.owner,second)).toBe(true);
  f.execution.release();f.registry.unbind(1);expect(f.live.size).toBe(0);
});
it("rolls back pin ownership if publishing a new cache entry fails",()=>{
  const f=fixture(),original=Map.prototype.set;
  const fail=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
    if(typeof key==="number" && value instanceof GlProgramQueryPin)throw new Error("cache allocation");
    return original.call(this,key,value);
  });
  try {expect(captureGlProgram(f.execution,20)).toBe(0);}finally{fail.mockRestore();}
  expect(f.owner.errors).toEqual([0x505]);expect(f.owner.programQueryPins.size).toBe(0);
  f.execution.release();f.registry.destroyContext(1,0);expect(f.live.size).toBe(0);f.registry.unbind(1);
});
it("attributes a failed clone reservation to the requesting peer",()=>{
  const f=fixture(),peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const handle=captureGlProgram(f.execution,20),original=Map.prototype.set;
  const fail=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
    if(key===f.program && value===2)throw new Error("pin count allocation");return original.call(this,key,value);
  });
  try {expect(retainGlProgramCapture(peer,handle)).toBeNull();}finally{fail.mockRestore();}
  expect(peer.errors).toEqual([0x505]);expect(f.owner.errors).toEqual([]);
  expect(f.owner.programQueryPins.get(f.program)).toBe(1);
  f.execution.release();f.registry.unbind(1);expect(f.live.size).toBe(0);
});

for(const mode of ["refusal","throw"] as const)
  it(`retains closed-cache cleanup custody after a ${mode} and retries it explicitly`,()=>{
    const f=fixture();captureGlProgram(f.execution,20);f.execution.release();
    const failure=vi.spyOn(GlProgramQueryPin.prototype,"release").mockImplementation(()=>{
      if(mode==="throw")throw new Error("cleanup allocation");return false;
    });
    try {expect(()=>f.registry.destroyContext(1,0)).toThrow(NativeGlFault);}
    finally{failure.mockRestore();}
    expect(f.live.has(f.program)).toBe(true);
    f.registry.destroyContext(1,0);expect(f.live.size).toBe(0);
    expect(f.group.members.size).toBe(0);expect(f.group.programQueryPins.size).toBe(0);
    f.registry.unbind(1);
  });
