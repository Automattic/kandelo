import {expect,it} from "vitest";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {runServerWait, SERVER_WAIT_ORDERED, SERVER_WAIT_CLIENT_SIGNAL} from "../src/webgl/fence-query.js";

function driver(){let waits=0,error=0,failWait=false;
 const sync={} as WebGLSync;
 const gl={getError:()=>{const n=error;error=0;return n;},isContextLost:()=>false,
  fenceSync:()=>sync,getSyncParameter:()=>0x9118,getParameter:()=>null,
  waitSync:(s:WebGLSync,flags:number,timeout:number)=>{expect(s).toBe(sync);expect([flags,timeout]).toEqual([0,-1]);if(failWait){error=0x502;return;}waits++;},
  deleteSync:()=>{},
 } as unknown as WebGL2RenderingContext;
 return {gl,waits:()=>waits,failWait:(n:boolean)=>{failWait=n;}};
}
/** Destination session 5 and source session 6 of one process. */
function fixture(same:boolean){const source=driver(),destination=same?source:driver(),registry=new GlContextRegistry();
 registry.bind({pid:7,sessionId:5,cmdbufAddr:0,cmdbufLen:64});registry.bind({pid:7,sessionId:6,cmdbufAddr:0,cmdbufLen:64});
 const b=registry.get(7,5)!,s=registry.get(7,6)!;b.gl=destination.gl;b.contextId=9;s.gl=source.gl;s.contextId=10;
 const made=s.fences.prepare(s)!;expect(made.publish()).toBe(true);
 const calls:string[]=[];
 const run=(token=made.token,src:typeof s|null=s)=>{const input=new Uint8Array(8),out=new Uint8Array(16);
  const v=new DataView(input.buffer);v.setUint32(0,6,true);v.setUint32(4,token,true);
  const rc=runServerWait(b,src??undefined,input,out,()=>calls.push("capture"),()=>calls.push("select"));
  return {rc,reply:Array.from(new Uint32Array(out.buffer))};};
 return {source,destination,b,s,token:made.token,calls,run};
}
it("issues one native barrier when both sessions share a physical renderer",()=>{
 const f=fixture(true),{rc,reply}=f.run();
 expect(rc).toBe(16);expect(reply).toEqual([0,f.token,SERVER_WAIT_ORDERED,0x47514c33]);
 expect(f.source.waits()).toBe(1);expect(f.calls).toEqual(["capture","select"]);
});
it("asks the caller to observe the signal when the fence is on another renderer",()=>{
 const f=fixture(false),{rc,reply}=f.run();
 expect(rc).toBe(16);expect(reply).toEqual([0,f.token,SERVER_WAIT_CLIENT_SIGNAL,0x47514c33]);
 // No foreign sync handle is ever passed to the destination's WebGL context.
 expect(f.source.waits()).toBe(0);expect(f.destination.waits()).toBe(0);expect(f.calls).toEqual([]);
});
it("reports an unknown fence or a missing source session without a barrier",()=>{
 const f=fixture(true);
 expect(f.run(f.token+1).reply.slice(0,3)).toEqual([2,f.token+1,0]);
 expect(f.run(f.token,null).reply[0]).toBe(2);expect(f.source.waits()).toBe(0);
});
it("fails without a reply when the native barrier is rejected",()=>{
 const f=fixture(true);f.source.failWait(true);expect(f.run().rc).toBe(-5);
});
it("rejects malformed requests before touching any renderer",()=>{
 const f=fixture(true),out=new Uint8Array(16);
 expect(runServerWait(f.b,f.s,new Uint8Array(4),out,()=>{},()=>{})).toBe(-22);
 expect(runServerWait(f.b,f.s,new Uint8Array(8),out,()=>{},()=>{})).toBe(-22);
 expect(runServerWait(f.b,f.s,new Uint8Array(8),new Uint8Array(12),()=>{},()=>{})).toBe(-22);
 f.b.contextId=null;const input=new Uint8Array(8);new DataView(input.buffer).setUint32(4,f.token,true);
 expect(runServerWait(f.b,f.s,input,out,()=>{},()=>{})).toBe(-1);expect(f.source.waits()).toBe(0);
});
