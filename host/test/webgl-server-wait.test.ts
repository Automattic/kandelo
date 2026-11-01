import {expect,it} from "vitest";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {GlFenceOwner} from "../src/webgl/fences.js";
import {GlOperationStream} from "../src/webgl/operation-stream.js";
import {GlMuxer} from "../src/webgl/muxer.js";
import {GlServerWaitQueue} from "../src/webgl/server-wait.js";

function driver(){let signaled=false,waits=0,deletes=0,error=0,failDelete=false;
 const sync={} as WebGLSync;
 const gl={getError:()=>{const n=error;error=0;return n;},isContextLost:()=>false,
  fenceSync:()=>sync,getSyncParameter:()=>signaled?0x9119:0x9118,getParameter:()=>null,
  waitSync:(s:WebGLSync,flags:number,timeout:number)=>{expect(s).toBe(sync);expect([flags,timeout]).toEqual([0,-1]);waits++;},
  deleteSync:()=>{if(failDelete){error=0x502;return;}deletes++;},
 } as unknown as WebGL2RenderingContext;
 return {gl,signal:()=>{signaled=true;},waits:()=>waits,deletes:()=>deletes,failDelete:(n:boolean)=>{failDelete=n;}};
}
function fixture(same=false){const source=driver(),destination=same?source:driver(),registry=new GlContextRegistry();
 registry.bind({pid:7,sessionId:5,cmdbufAddr:0,cmdbufLen:64});const b=registry.get(7,5)!;b.gl=destination.gl;b.contextId=9;
 const muxer=new GlMuxer(destination.gl),sourceMuxer=same?muxer:new GlMuxer(source.gl);
 const muxers=new WeakMap([[destination.gl,muxer],[source.gl,sourceMuxer]]);
 const fences=new GlFenceOwner();const made=fences.prepare({gl:source.gl,errors:[]})!;expect(made.publish()).toBe(true);
 const lease=fences.acquire(made.token)!,execution=registry.retainContextExecution(7,5,muxer)!;
 const queue=new GlServerWaitQueue(muxers);return {source,destination,b,registry,muxer,fences,lease,execution,queue};
}
it("uses one same-native wait and preserves accepted ordering after result cancellation",()=>{
 const f=fixture(true),before=f.b.operations.reserve("query")!;expect(before.start()).toBe(true);
 const wait=f.queue.prepare(f.lease,f.execution,f.b.operations)!;expect(wait.accept()).toBe(true);wait.cancel();
 const later=f.b.operations.reserve("commands")!;expect(later.ready).toBe(false);expect(f.queue.drain()).toBe(0);
 before.finish();expect(f.queue.drain()).toBe(1);expect(f.source.waits()).toBe(1);expect(wait.status).toBe("ordered");expect(wait.retired).toBe(true);expect(later.ready).toBe(true);
 const reply=new Uint8Array(16);expect(wait.writeReply(reply)).toBe(16);expect(new Uint32Array(reply.buffer)[0]).toBe(0);expect(f.queue.drain()).toBe(0);expect(f.source.waits()).toBe(1);
});
it("polls foreign fences only on later turns while unrelated streams remain runnable",()=>{
 const f=fixture(),wait=f.queue.prepare(f.lease,f.execution,f.b.operations)!;wait.accept();const later=f.b.operations.reserve("query")!;
 expect(f.queue.drain()).toBe(1);expect(wait.status).toBe("pending");expect(later.ready).toBe(false);expect(f.queue.runnable).toBe(false);expect(f.queue.needsPoll).toBe(true);expect(f.queue.drain()).toBe(0);
 const peer=new GlOperationStream();expect(peer.tryBeginImmediate("query")).not.toBeNull();f.fences.destroy(f.lease.token);f.source.signal();f.queue.pollAfterTurn();expect(f.queue.drain()).toBe(1);
 expect(wait.status).toBe("ordered");expect(f.source.waits()).toBe(0);expect(f.destination.waits()).toBe(0);expect(later.ready).toBe(true);expect(f.source.deletes()).toBe(1);
});
it("withdraws an unpublished barrier and retains failed physical deletion for retry",()=>{
 const f=fixture();const wait=f.queue.prepare(f.lease,f.execution,f.b.operations)!;f.fences.destroy(f.lease.token);f.source.failDelete(true);wait.cancel();
 expect(f.queue.drain()).toBe(1);expect(wait.retired).toBe(false);expect(wait.status).toBe("cancelled");expect(f.queue.runnable).toBe(false);expect(f.queue.needsPoll).toBe(true);
 f.source.failDelete(false);f.queue.pollAfterTurn();expect(f.queue.drain()).toBe(1);expect(wait.retired).toBe(true);expect(f.source.deletes()).toBe(1);expect(f.queue.pending).toBe(0);
});
it("requires exact closed destination authority to cancel an accepted dependency",()=>{
 const f=fixture(),wait=f.queue.prepare(f.lease,f.execution,f.b.operations)!;wait.accept();f.queue.drain();
 expect(wait.retireDestination(new GlOperationStream())).toBe(false);expect(f.queue.retireDestination(f.b.operations)).toBe(false);
 f.b.operations.close();expect(f.queue.retireDestination(f.b.operations)).toBe(true);expect(f.queue.drain()).toBe(1);expect(wait.retired).toBe(true);expect(wait.status).toBe("cancelled");
});
it("refuses mismatched destination custody without consuming supplied leases",()=>{
 const f=fixture();expect(f.queue.prepare(f.lease,f.execution,new GlOperationStream())).toBeNull();expect(f.queue.pending).toBe(0);
 expect(f.execution.context).toBe(f.destination.gl);expect(f.lease.poll(null)).toBe(false);expect(f.execution.release()).toBe(true);expect(f.lease.releaseRetirement()).toBe(true);
});
it("does not pass a native sync handle to a foreign native context",()=>{
 const f=fixture();expect(f.lease.enqueueNativeWait(f.destination.gl,null)).toBeNull();expect(f.source.waits()).toBe(0);expect(f.destination.waits()).toBe(0);f.execution.release();f.lease.release();
});
it("keeps the original source fence alive across physical cleanup receipts",()=>{
 const f=fixture(),receipts=f.fences.captureRetirements()!;expect(receipts).toHaveLength(1);f.fences.close();
 expect(receipts[0].retry()).toBe(false);expect(f.source.deletes()).toBe(0);expect(f.lease.poll(null)).toBe(false);
 expect(f.lease.releaseRetirement()).toBe(true);expect(receipts[0].complete).toBe(true);expect(f.source.deletes()).toBe(1);receipts[0].forget();f.execution.release();
});
it("admits another wait and its reply before an earlier foreign barrier signals",()=>{
 const f=fixture(),first=f.queue.prepare(f.lease,f.execution,f.b.operations)!;first.accept();f.queue.drain();
 const source=f.fences.acquire(f.lease.token)!,destination=f.execution.clone()!;
 const second=f.queue.prepare(source,destination,f.b.operations)!;expect(second.accept()).toBe(true);
 expect(second.writeReply(new Uint8Array(16))).toBe(16);expect(second.status).toBe("pending");expect(f.queue.runnable).toBe(false);
 f.fences.destroy(f.lease.token);f.source.signal();f.queue.pollAfterTurn();expect(f.queue.drain()).toBe(2);expect(f.queue.pending).toBe(0);expect(f.source.deletes()).toBe(1);
});
it("does not replay a rejected native wait or allow later commands past it",()=>{
 const f=fixture(true);let calls=0;f.source.gl.waitSync=()=>{calls++;throw new Error("native wait rejected");};
 const wait=f.queue.prepare(f.lease,f.execution,f.b.operations)!;wait.accept();const later=f.b.operations.reserve("commands")!;
 expect(f.queue.drain()).toBe(1);expect(wait.status).toBe("failed");expect(f.b.operations.immediateState()).toBe("closed");expect(later.start()).toBe(false);expect(f.queue.drain()).toBe(0);expect(calls).toBe(1);
});
