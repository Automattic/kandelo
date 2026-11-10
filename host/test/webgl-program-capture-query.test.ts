import { expect,it,vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { runGlQuery } from "../src/webgl/query.js";
import { QOP_PROGRAM_CAPTURE } from "../src/webgl/ops.js";
import { captureGlProgram,retainGlProgramCapture } from "../src/webgl/program-captures.js";
import { NativeGlFault } from "../src/webgl/native-recovery.js";
import { GlProgramQueryPin } from "../src/webgl/program-objects.js";

function fixture() {
  let linked=true,nativeError=0,refuse=false;
  const selected:object[]=[];
  const gl=new Proxy({getError:()=>{const e=nativeError;nativeError=0;return e;},isContextLost:()=>false,
    getProgramParameter:()=>linked,getParameter:()=>null,deleteProgram:()=>{},
    useProgram:(p:object)=>{if(refuse)nativeError=0x502;else selected.push(p);}},
    {get:(o,k)=>Reflect.get(o,k)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);
  const bind=(session:number)=>{
    registry.bind({pid:1,sessionId:session,cmdbufAddr:0,cmdbufLen:64});
    const b=registry.get(1,session)!;b.gl=gl;b.contextId=session+1;return b;
  };
  const b=bind(0),program={};b.programs.set(20,program);b.programShaders.set(20,new Set());
  const execution=registry.retainContextExecution(1,0,muxer)!;
  const query=(words:number[],outputBytes=16)=>{
    const out=new Uint8Array(outputBytes).fill(0xa5);
    const rc=runGlQuery(b,QOP_PROGRAM_CAPTURE,new Uint8Array(new Uint32Array(words).buffer),out,execution);
    return {rc,out,words:Array.from(new Uint32Array(out.buffer,0,Math.floor(out.byteLength/4)))};
  };
  return {b,registry,muxer,bind,program,execution,selected,query,
    link:(value:boolean)=>{linked=value;},refuse:()=>{refuse=true;}};
}
const magic=0x47514c33;
it("captures checked link state, selects the exact owner and releases its cache without losing current state",()=>{
  const f=fixture();f.b.errors=[0x500];const capture=f.query([1,20]);
  expect(capture).toMatchObject({rc:16,words:[0,1,1,magic]});expect(f.b.errors).toEqual([0x500]);
  expect(f.query([2,20,1]).words).toEqual([0,1,1,magic]);
  expect(f.selected).toEqual([f.program]);expect(f.b.currentProgram).toBe(f.program);
  expect(f.query([3,1]).words).toEqual([0,1,0,magic]);expect(f.b.currentProgram).toBe(f.program);
  expect(f.query([3,1]).words).toEqual([1,0,0,magic]);expect(f.b.errors).toEqual([0x500,0x502]);
  f.execution.release();f.registry.unbind(1);
});
it("reports false linking without capturing or replacing an older current executable",()=>{
  const f=fixture();f.b.currentProgram=f.b.shadow.currentProgram=f.program;f.b.currentProgramId=20;f.link(false);
  expect(f.query([1,20]).words).toEqual([0,0,0,magic]);expect(f.b.programQueryPins.size).toBe(0);
  expect(f.b.currentProgram).toBe(f.program);expect(f.b.errors).toEqual([]);
  f.execution.release();f.registry.unbind(1);
});
it("refuses a peer-owned or stale generation and does not resurrect a deleted name",()=>{
  const f=fixture();f.query([1,20]);const peer=f.bind(12);expect(f.registry.shareObjects(1,12,0)).toBe(true);
  const out=new Uint8Array(16);
  expect(runGlQuery(peer,QOP_PROGRAM_CAPTURE,new Uint8Array(new Uint32Array([2,20,1]).buffer),out)).toBe(16);
  expect(Array.from(new Uint32Array(out.buffer))).toEqual([1,0,0,magic]);expect(f.selected).toEqual([]);
  f.b.programs.set(20,{});expect(f.query([2,20,1]).words).toEqual([1,0,0,magic]);
  f.b.programs.delete(20);expect(f.query([2,20,1]).words).toEqual([1,0,0,magic]);
  f.execution.release();f.registry.unbind(1);
});
it("keeps repeated older flags from manufacturing acceptance of a refused native selection",()=>{
  const f=fixture();f.query([1,20]);f.b.errors=[0x502];f.refuse();
  expect(f.query([2,20,1]).words).toEqual([1,0,0,magic]);expect(f.b.errors).toEqual([0x502]);
  expect(f.b.currentProgram).toBeNull();f.execution.release();f.registry.unbind(1);
});
it("does not grant the guest retirement authority over a private group capture",()=>{
  const f=fixture();const handle=captureGlProgram(f.execution,20);
  expect(f.query([3,handle]).words).toEqual([1,0,0,magic]);
  const pin=retainGlProgramCapture(f.b,handle)!;expect(pin.program).toBe(f.program);pin.release();
  f.execution.release();f.registry.unbind(1);
});
for(const mode of ["refusal","throw"] as const)it(`keeps native cleanup ${mode} fatal with retained retry custody`,()=>{
  const f=fixture();f.query([1,20]);const failure=vi.spyOn(GlProgramQueryPin.prototype,"release").mockImplementation(()=>{
    if(mode==="throw")throw new Error("cleanup failed");return false;
  });
  try {expect(()=>f.query([3,1])).toThrow(NativeGlFault);}finally{failure.mockRestore();}
  expect(f.query([3,1]).words).toEqual([0,1,0,magic]);f.execution.release();f.registry.unbind(1);
});
for(const words of [[0,20],[1,20,1],[2,20],[2,20,0],[3,0],[3,1,1]])it(`rejects malformed capture request ${words}`,()=>{
  const f=fixture(),r=f.query(words);expect(r.rc).toBe(-22);expect([...r.out]).toEqual(new Array(16).fill(0xa5));
  expect(f.selected).toEqual([]);expect(f.b.programQueryPins.size).toBe(0);f.execution.release();f.registry.unbind(1);
});
for(const bytes of [0,12,20])it(`rejects capture output capacity ${bytes} before acquisition`,()=>{
  const f=fixture(),r=f.query([1,20],bytes);expect(r.rc).toBe(-22);expect([...r.out]).toEqual(new Array(bytes).fill(0xa5));
  expect(f.b.programQueryPins.size).toBe(0);f.execution.release();f.registry.unbind(1);
});
it("reserves explicit execution custody and preserves Node's no-renderer boundary",()=>{
  const f=fixture(),input=new Uint8Array(new Uint32Array([1,20]).buffer),out=new Uint8Array(16);
  expect(runGlQuery(f.b,QOP_PROGRAM_CAPTURE,input,out)).toBe(16);
  expect(Array.from(new Uint32Array(out.buffer))).toEqual([1,0,0,magic]);expect(f.b.errors).toEqual([0x505]);
  f.execution.release();f.registry.unbind(1);expect(runGlQuery(f.b,QOP_PROGRAM_CAPTURE,input,out)).toBe(-1);
});
