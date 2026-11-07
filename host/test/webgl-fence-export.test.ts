import {expect,it} from "vitest";
import {GlContextRegistry} from "../src/webgl/registry.js";
import type {GlFenceLease} from "../src/webgl/fences.js";
import {runExportFence, runServerWait, EXPORT_FENCE_ORDERED, EXPORT_FENCE_RETAINED,
  SERVER_WAIT_ORDERED, SERVER_WAIT_CLIENT_SIGNAL} from "../src/webgl/fence-query.js";

const MAGIC=0x47514c33;
function driver(){let waits=0,deletes=0,status=0x9118;
 const sync={} as WebGLSync;
 const gl={getError:()=>0,isContextLost:()=>false,fenceSync:()=>sync,
  getSyncParameter:()=>status,getParameter:()=>null,
  waitSync:(s:WebGLSync,flags:number,timeout:number)=>{expect(s).toBe(sync);expect([flags,timeout]).toEqual([0,-1]);waits++;},
  deleteSync:()=>{deletes++;},
 } as unknown as WebGL2RenderingContext;
 return {gl,waits:()=>waits,deletes:()=>deletes,signal:()=>{status=0x9119;}};
}
/** Session 6 creates the fence; session 5 is a destination. */
function fixture(){const native=driver(),registry=new GlContextRegistry();
 registry.bind({pid:7,sessionId:5,cmdbufAddr:0,cmdbufLen:64});registry.bind({pid:7,sessionId:6,cmdbufAddr:0,cmdbufLen:64});
 const b=registry.get(7,5)!,s=registry.get(7,6)!;b.gl=native.gl;b.contextId=9;s.gl=native.gl;s.contextId=10;
 const made=s.fences.prepare(s)!;expect(made.publish()).toBe(true);
 const retained=new Map<number,GlFenceLease>();
 const exportFence=(shared:WebGL2RenderingContext|null,token=made.token,id=41)=>{
  const input=new Uint8Array(8),out=new Uint8Array(16);const v=new DataView(input.buffer);
  v.setUint32(0,token,true);v.setUint32(4,id,true);
  const rc=runExportFence(s,input,out,shared,()=>{},(exportId,lease)=>{
   if(retained.has(exportId))return false;retained.set(exportId,lease);return true;});
  return {rc,reply:Array.from(new Uint32Array(out.buffer))};};
 return {native,b,s,token:made.token,retained,exportFence};
}
it("exports a fence on the shared context as complete in submission order",()=>{
 const f=fixture(),{rc,reply}=f.exportFence(f.native.gl);
 expect(rc).toBe(16);expect(reply).toEqual([0,f.token,EXPORT_FENCE_ORDERED,MAGIC]);
 expect(f.retained.size).toBe(0);
});
it("retains a fence on a separate context until the kernel releases it",()=>{
 const f=fixture(),other=driver(),{rc,reply}=f.exportFence(other.gl);
 expect(rc).toBe(16);expect(reply).toEqual([0,f.token,EXPORT_FENCE_RETAINED,MAGIC]);
 const lease=f.retained.get(41)!;expect(lease.context).toBe(f.native.gl);
 // The EGL sync is destroyed; the export still observes the native fence.
 expect(f.s.fences.destroy(f.token)).toBe(true);expect(f.native.deletes()).toBe(0);
 expect(lease.poll(null)).toBe(false);f.native.signal();expect(lease.poll(null)).toBe(true);
 lease.release();expect(f.native.deletes()).toBe(1);
 // An export id is never retained twice.
 const g=fixture();g.exportFence(other.gl);expect(g.exportFence(other.gl).rc).toBe(-5);
});
it("reports an unknown fence and rejects malformed requests",()=>{
 const f=fixture();
 expect(f.exportFence(f.native.gl,f.token+1).reply.slice(0,3)).toEqual([2,f.token+1,0]);
 expect(f.exportFence(f.native.gl,0).rc).toBe(-22);expect(f.exportFence(f.native.gl,f.token,0).rc).toBe(-22);
 expect(runExportFence(f.s,new Uint8Array(4),new Uint8Array(16),null,()=>{},()=>true)).toBe(-22);
});
it("waits natively on an exported fence of the destination's own context",()=>{
 const f=fixture(),other=driver();f.exportFence(other.gl);
 const lease=f.retained.get(41)!,input=new Uint8Array(8),out=new Uint8Array(16);
 new DataView(input.buffer).setUint32(4,41,true);
 const calls:string[]=[];
 expect(runServerWait(f.b,undefined,input,out,()=>calls.push("capture"),()=>calls.push("select"),lease)).toBe(16);
 expect(Array.from(new Uint32Array(out.buffer))).toEqual([0,0,SERVER_WAIT_ORDERED,MAGIC]);
 expect(f.native.waits()).toBe(1);expect(calls).toEqual(["capture","select"]);
 // Another destination context has no shared command stream.
 f.b.gl=other.gl;
 expect(runServerWait(f.b,undefined,input,out,()=>{},()=>{},lease)).toBe(16);
 expect(Array.from(new Uint32Array(out.buffer))).toEqual([0,0,SERVER_WAIT_CLIENT_SIGNAL,MAGIC]);
 // The kernel forwards only live exports; a missing one is a host fault.
 expect(runServerWait(f.b,undefined,input,out,()=>{},()=>{},null)).toBe(-5);
});
