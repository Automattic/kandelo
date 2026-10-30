import { expect, it, vi } from "vitest";
import { GlOwnedResultStore, GlResultOwner, GlNativeResultCustody, GlRemoteResultCustody, GlResultPeer } from "../src/webgl/owned-result.js";
import * as resultTypes from "../src/webgl/owned-result.js";
import { QOP_FENCE_STATUS, QOP_RELEASE_FENCE } from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";
import { defaultFramebuffer } from "../src/webgl/framebuffer.js";
import { GlOperationStream } from "../src/webgl/operation-stream.js";
import { GlMuxer } from "../src/webgl/muxer.js";

const store = (limits = {maxOwners:4,maxRequests:8,maxRetainedBytes:1024}) => new GlOwnedResultStore(limits);

const fixtureStreams = new WeakMap<GlOwnedResultStore,Map<string,GlOperationStream>>();
function open(s: GlOwnedResultStore,pid: number,sessionId: number,operations?: GlOperationStream) {
  let streams=fixtureStreams.get(s); if (!streams) {streams=new Map();fixtureStreams.set(s,streams);}
  const key=`${pid}:${sessionId}`;
  if (!streams.has(key)) streams.set(key,operations??new GlOperationStream());
  return s.openOwner(pid,sessionId,operations??streams.get(key)!);
}

function begin(s: GlOwnedResultStore, owner: GlResultOwner, token: bigint, op: number,
  input: Uint8Array, capacity: number, custody: GlNativeResultCustody | resultTypes.GlFenceResultCustody | GlRemoteResultCustody | null = null) {
  return s.begin(owner,token,op,input,capacity,custody);
}

it("copies input once, executes once, and keeps result bytes independent from workspace and poll copies", () => {
  const s = store(), owner = open(s,7,11)!, input = new Uint8Array(new SharedArrayBuffer(4)); input.set([1,2,3,4]);
  expect(begin(s,owner,0x20_0000_0000_0001n,9,input,4)).toBe("admitted"); input.fill(0);
  expect(begin(s,owner,0x20_0000_0000_0001n,9,new Uint8Array([99]),4)).toBe("existing");
  expect(begin(s,owner,0x20_0000_0000_0001n,10,input,4)).toBe("rejected");
  for (let i=0;i<4;i++) expect(s.poll(owner,0x20_0000_0000_0001n)).toEqual({state:"pending"});
  const execution = s.take(owner,0x20_0000_0000_0001n)!;
  expect([...execution.input]).toEqual([1,2,3,4]); expect(s.take(owner,0x20_0000_0000_0001n)).toBeNull();
  const workspace = execution.output; workspace.set([4,3,2,1]);
  expect(execution.complete(4)).toBe(true); workspace.fill(88);
  expect(execution.complete(4)).toBe(false);
  const first = s.poll(owner,0x20_0000_0000_0001n);
  expect(first).toEqual({state:"ready",rc:4,bytes:new Uint8Array([4,3,2,1])});
  if (first.state === "ready") first.bytes.fill(77);
  expect(s.poll(owner,0x20_0000_0000_0001n)).toEqual({state:"ready",rc:4,bytes:new Uint8Array([4,3,2,1])});
  expect(s.retainedBytes).toBe(12); expect(s.commit(owner,0x20_0000_0000_0001n)).toBe(true);
  expect(s.retainedBytes).toBe(12);
  expect(s.acknowledgeRetired(owner,0x20_0000_0000_0001n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(s.retainedBytes).toBe(0); expect(begin(s,owner,0x20_0000_0000_0001n,9,input,4)).toBe("rejected");
});

it.each([0n,-1n,0x8000_0000_0000_0000n,1 as unknown as bigint])("rejects invalid or narrowed token %s", token => {
  const s = store(), owner = open(s,7,11)!;
  expect(begin(s,owner,token,1,new Uint8Array(),0)).toBe("rejected"); expect(s.pendingRequests).toBe(0);
});

it("enforces explicit request/owner/byte budgets without releasing them at Ready or Cancel", () => {
  const s = store({maxOwners:1,maxRequests:2,maxRetainedBytes:10}), owner = open(s,7,11)!;
  expect(open(s,7,11)).toBe(owner); expect(open(s,7,12)).toBeNull();
  expect(begin(s,owner,1n,1,new Uint8Array(2),4)).toBe("admitted"); expect(s.retainedBytes).toBe(10);
  expect(begin(s,owner,2n,1,new Uint8Array(1),0)).toBe("rejected");
  expect(begin(s,owner,2n,1,new Uint8Array(),0)).toBe("admitted");
  expect(begin(s,owner,3n,1,new Uint8Array(),0)).toBe("rejected");
  expect(s.cancel(owner,1n)).toBe(true); expect(s.retainedBytes).toBe(10);
  expect(s.acknowledgeRetired(owner,1n).state).toBe("retired"); expect(s.retainedBytes).toBe(0);
  expect(begin(s,owner,3n,1,new Uint8Array(65537),0)).toBe("rejected");
  expect(begin(s,owner,3n,1,new Uint8Array(),Number.MAX_SAFE_INTEGER)).toBe("rejected");
  expect(begin(s,owner,3n,1,new Uint8Array(),-1)).toBe("rejected");
});

it.each([-1,0.5,Number.MAX_SAFE_INTEGER+1])("rejects invalid budget unit %s", value => {
  expect(() => store({maxOwners:value,maxRequests:1,maxRetainedBytes:1})).toThrow(RangeError);
});

it("cancellation revokes late completion but waits for the exact running execution to become quiescent", () => {
  const s = store(), owner = open(s,7,11)!;
  begin(s,owner,1n,1,new Uint8Array([7]),4); const execution = s.take(owner,1n)!;
  expect(s.commit(owner,1n)).toBe(false); expect(s.cancel(owner,1n)).toBe(true);
  expect(s.commit(owner,1n)).toBe(false); expect(() => execution.output).toThrow("revoked");
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"}); expect(s.retainedBytes).toBe(9);
  expect(execution.complete(4)).toBe(false); expect(s.poll(owner,1n)).toEqual({state:"retiring",mode:"cancel"});
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(execution.complete(4)).toBe(false); expect(s.poll(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
});

it("rejects forged/stale registration capabilities and preserves owner retirement receipts", () => {
  const s = store(), owner = open(s,7,11)!, other = open(store(),7,11)!;
  const forged = new GlResultOwner(owner.registration,owner.pid,owner.sessionId,owner.operations);
  for (const wrong of [other,forged]) expect(begin(s,wrong,1n,1,new Uint8Array(),0)).toBe("rejected");
  begin(s,owner,1n,1,new Uint8Array(),0); expect(s.retireOwner(owner)).toBe(true);
  expect(begin(s,owner,2n,1,new Uint8Array(),0)).toBe("rejected"); expect(open(s,7,11)).toBeNull();
  expect(s.acknowledgeRetired(owner,1n).state).toBe("retired");
  expect(s.forget(owner,1n)).toBe(true);
  const replacement = open(s,7,11)!; expect(replacement.registration).toBeGreaterThan(owner.registration);
  expect(begin(s,owner,2n,1,new Uint8Array(),0)).toBe("rejected");
  expect(s.poll(replacement,1n)).toEqual({state:"unknown"});
});

it.each([5,NaN,-0x8000_0001])("reports invalid native completion %s as failure without truncating", rc => {
  const s = store(), owner = open(s,7,11)!; begin(s,owner,1n,1,new Uint8Array(),4);
  const execution = s.take(owner,1n)!; execution.output.fill(7); expect(execution.complete(rc)).toBe(true);
  expect(s.poll(owner,1n)).toEqual({state:"ready",rc:-5,bytes:new Uint8Array()});
  expect(s.commit(owner,1n)).toBe(false); expect(s.cancel(owner,1n)).toBe(true);
});

it("requires the exact remote peer retirement ACK before releasing client bytes", () => {
  const s = store(), owner = open(s,7,11)!, peer = new GlResultPeer(1), wrong = new GlResultPeer(1);
  const custody = new GlRemoteResultCustody(peer,owner,1n);
  begin(s,owner,1n,1,new Uint8Array([1]),4,custody); const execution = s.take(owner,1n)!;
  execution.complete(0);
  s.commit(owner,1n); expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  expect(custody.acknowledge(wrong,owner,1n,"commit",true)).toBe(false);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"}); expect(s.retainedBytes).toBe(9);
  expect(custody.acknowledge(peer,owner,1n,"commit",true)).toBe(true);
  expect(custody.acknowledge(peer,owner,1n,"cancel",true)).toBe(false);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
});

function native() {
  let serial=0, reject=false;
  const live = new Set<object>(), flags: number[]=[];
  const make=()=>{const value={serial:++serial}; live.add(value); return value;};
  const remove=(value:object)=>{ if (reject) throw new Error("native deletion blocked"); live.delete(value); };
  const gl=new Proxy({getError:()=>flags.shift()??0,isContextLost:()=>false,getParameter:(p:number)=>p===0x84e0?0x84c0:null,checkFramebufferStatus:()=>0x8cd5,
    getSyncParameter:()=>0x9119,createTexture:make,createVertexArray:make,createFramebuffer:make,createRenderbuffer:make,createSync:make,fenceSync:make,
    deleteTexture:remove,deleteVertexArray:remove,deleteFramebuffer:remove,deleteRenderbuffer:remove,deleteSync:remove,
  },{get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry();registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const binding=registry.get(7,11)!;binding.gl=gl;binding.contextId=1;
  const texture=gl.createTexture()!;binding.textures.set(1,texture);
  const muxer=new GlMuxer(gl), execution=registry.retainSubmitExecution(binding,muxer)!;
  expect(execution.admitted).toBe(true);
  const candidate=binding.fences.prepare(binding)!;
  expect(candidate).not.toBeNull();
  return {registry,binding,gl,muxer,execution,candidate,texture,live,flags,block:(value:boolean)=>{reject=value;}};
}

it("publishes a real candidate exactly once while actual failed context cleanup retains the receipt and budget", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  const publication=vi.spyOn(f.candidate,"publish");
  begin(s,owner,1n,1,new Uint8Array(),4,new GlNativeResultCustody(f.execution,f.candidate,f.muxer));
  const execution=s.take(owner,1n)!;
  execution.complete(0); f.registry.destroyContext(7,11); f.block(true);
  expect(s.commit(owner,1n)).toBe(true);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  expect(publication).toHaveBeenCalledTimes(1); expect(f.live.has(f.texture)).toBe(true); expect(s.retainedBytes).toBe(8);
  f.block(false);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(publication).toHaveBeenCalledTimes(1); expect(f.live.has(f.texture)).toBe(false);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(publication).toHaveBeenCalledTimes(1);
  expect(f.binding.fences.has(f.candidate.token)).toBe(true); f.registry.unbind(7);
});

it("cancels a real candidate without equating failed delegated deletion with accepted cleanup", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  begin(s,owner,1n,1,new Uint8Array(),0,new GlNativeResultCustody(f.execution,f.candidate,f.muxer));
  const execution=s.take(owner,1n)!;
  execution.complete(0); f.block(true); s.cancel(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"}); expect(f.live.size).toBeGreaterThan(1);
  f.block(false); expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(f.binding.fences.has(f.candidate.token)).toBe(false); f.registry.unbind(7);
});

it("owner retirement before commit completion cannot publish a new fence into retired authority", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  const publication=vi.spyOn(f.candidate,"publish");
  begin(s,owner,1n,1,new Uint8Array(),0,new GlNativeResultCustody(f.execution,f.candidate,f.muxer));
  const execution=s.take(owner,1n)!;
  execution.complete(0); s.commit(owner,1n); s.retireOwner(owner);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:false});
  expect(publication).not.toHaveBeenCalled(); expect(f.binding.fences.has(f.candidate.token)).toBe(false);
  f.registry.unbind(7);
});


it("remote completion checks exact peer/owner/token and cannot revive cancellation or repeat native execution", () => {
  const s=store(), owner=open(s,7,11)!, other=open(s,7,12)!, peer=new GlResultPeer(1), wrong=new GlResultPeer(1);
  const custody=new GlRemoteResultCustody(peer,owner,1n);
  begin(s,owner,1n,1,new Uint8Array(),4,custody); const execution=s.take(owner,1n)!;
  expect(custody.acknowledge(peer,owner,1n,"cancel",true)).toBe(false);
  for (const [sender,target,token] of [[wrong,owner,1n],[peer,other,1n],[peer,owner,2n]] as const)
    expect(s.completeRemote(sender,target,token,4,new Uint8Array([1,2,3,4]))).toBe(false);
  expect(s.poll(owner,1n)).toEqual({state:"pending"});
  s.cancel(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  expect(s.completeRemote(peer,owner,1n,4,new Uint8Array([1,2,3,4]))).toBe(false);
  expect(s.poll(owner,1n)).toEqual({state:"retiring",mode:"cancel"});
  expect(custody.acknowledge(peer,owner,1n,"cancel",false)).toBe(false);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  expect(custody.acknowledge(peer,owner,1n,"cancel",true)).toBe(true);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(s.completeRemote(peer,owner,1n,4,new Uint8Array([1,2,3,4]))).toBe(false);
});

it("native cancellation preserves the selected peer's flags before retiring the source candidate", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0}); const peer=f.registry.get(7,12)!;
  peer.gl=f.gl; peer.contextId=2; f.muxer.switchTo(peer); f.flags.push(0x500);
  begin(s,owner,1n,1,new Uint8Array(),0,new GlNativeResultCustody(f.execution,f.candidate,f.muxer));
  const execution=s.take(owner,1n)!;
  execution.complete(0); s.cancel(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(peer.errors).toEqual([0x500]); expect(f.binding.errors).toEqual([]); f.registry.unbind(7);
});


it("cannot transfer one native execution/candidate or custody owner twice", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  const custody=new GlNativeResultCustody(f.execution,f.candidate,f.muxer);
  expect(()=>new GlNativeResultCustody(f.execution,null,f.muxer)).toThrow("already transferred");
  expect(()=>new GlNativeResultCustody(null,f.candidate,f.muxer)).toThrow("already transferred");
  const other=open(s,7,12)!;
  expect(begin(s,owner,1n,1,new Uint8Array(),0,custody)).toBe("admitted");
  expect(begin(s,other,2n,1,new Uint8Array(),0,custody)).toBe("rejected");
  expect(begin(s,owner,2n,1,new Uint8Array(),0,custody)).toBe("rejected");
  begin(s,other,2n,1,new Uint8Array(),0);
  const first=s.take(owner,1n)!, second=s.take(other,2n)!;
  first.complete(0); second.complete(0); s.cancel(owner,1n); s.cancel(other,2n);
  expect(s.acknowledgeRetired(owner,1n).state).toBe("retired");
  expect(s.acknowledgeRetired(other,2n).state).toBe("retired"); f.registry.unbind(7);
});

it("a detached native workspace becomes a failed completion without leaving a stuck running receipt", () => {
  const s=store(), owner=open(s,7,11)!;
  begin(s,owner,1n,1,new Uint8Array(),4); const execution=s.take(owner,1n)!;
  const workspace=execution.output;
  structuredClone(workspace.buffer,{transfer:[workspace.buffer]});
  expect(execution.complete(4)).toBe(true);
  expect(s.poll(owner,1n)).toEqual({state:"ready",rc:-5,bytes:new Uint8Array()});
  expect(s.cancel(owner,1n)).toBe(true);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
});


it("native and remote receipts retain both sides until real server retirement follows client copyout", () => {
  const f=native(), server=store(), client=store();
  const serverOwner=open(server,7,11,f.binding.operations)!, clientOwner=open(client,7,11)!, peer=new GlResultPeer(1);
  const remote=new GlRemoteResultCustody(peer,clientOwner,1n), publication=vi.spyOn(f.candidate,"publish");
  const input=new Uint8Array([3,4]);
  begin(server,serverOwner,1n,1,structuredClone(input),4,new GlNativeResultCustody(f.execution,f.candidate,f.muxer));
  begin(client,clientOwner,1n,1,input,4,remote);
  const nativeExecution=server.take(serverOwner,1n)!, forwardedExecution=client.take(clientOwner,1n)!;
  nativeExecution.output.set([8,7,6,5]); nativeExecution.complete(4);
  const reply=server.poll(serverOwner,1n); expect(reply.state).toBe("ready");
  if (reply.state !== "ready") throw new Error("missing server reply");
  expect(client.completeRemote(peer,clientOwner,1n,reply.rc,structuredClone(reply.bytes))).toBe(true);
  const clientReply=client.poll(clientOwner,1n); if (clientReply.state !== "ready") throw new Error("missing client reply");
  const copiedOut=new Uint8Array(clientReply.bytes); expect([...copiedOut]).toEqual([8,7,6,5]);
  expect(publication).not.toHaveBeenCalled();
  client.commit(clientOwner,1n); server.commit(serverOwner,1n);
  f.registry.destroyContext(7,11); f.block(true);
  expect(server.acknowledgeRetired(serverOwner,1n)).toEqual({state:"pending"});
  expect(client.acknowledgeRetired(clientOwner,1n)).toEqual({state:"pending"});
  expect(server.retainedBytes).toBe(10); expect(client.retainedBytes).toBe(10);
  f.block(false); const acknowledgement=server.acknowledgeRetired(serverOwner,1n);
  expect(acknowledgement).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(publication).toHaveBeenCalledTimes(1);
  if (acknowledgement.state !== "retired") throw new Error("missing server retirement");
  remote.acknowledge(peer,clientOwner,1n,acknowledgement.mode,acknowledgement.accepted);
  expect(client.acknowledgeRetired(clientOwner,1n)).toEqual(acknowledgement);
  expect(client.retainedBytes).toBe(0); expect(server.retainedBytes).toBe(0);
  expect(server.acknowledgeRetired(serverOwner,1n)).toEqual(acknowledgement);
  expect(client.acknowledgeRetired(clientOwner,1n)).toEqual(acknowledgement);
  expect(server.forget(serverOwner,1n)).toBe(true); expect(client.forget(clientOwner,1n)).toBe(true);
  f.registry.unbind(7);
});


it("adopts actual cleanup custody acquired by an operation racing cancellation before quiescence", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  const publication=vi.spyOn(f.candidate,"publish");
  const custody=new GlNativeResultCustody(f.execution,null,f.muxer);
  begin(s,owner,1n,1,new Uint8Array(),0,custody); const execution=s.take(owner,1n)!;
  s.cancel(owner,1n);
  expect(custody.adoptCandidate(f.candidate)).toBe(true);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  expect(execution.complete(0)).toBe(false);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(publication).not.toHaveBeenCalled(); f.registry.unbind(7);
});

it("rejects mismatched physical custody without consuming the actual native capabilities", () => {
  const f=native(), wrong=new GlMuxer({} as WebGL2RenderingContext);
  expect(()=>new GlNativeResultCustody(f.execution,f.candidate,wrong)).toThrow("renderer mismatch");
  const s=store(), owner=open(s,7,11,f.binding.operations)!;
  expect(begin(s,owner,1n,1,new Uint8Array(),0,new GlNativeResultCustody(f.execution,f.candidate,f.muxer))).toBe("admitted");
  const execution=s.take(owner,1n)!;
  execution.complete(0); s.cancel(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  f.registry.unbind(7);
});


it("receipt execution and following commands share the exact existing session ticket order through ACK", () => {
  const s=store(), operations=new GlOperationStream(), owner=s.openOwner(7,11,operations)!;
  expect(s.openOwner(7,11,new GlOperationStream())).toBeNull();
  expect(s.openOwner(7,11,undefined as unknown as GlOperationStream)).toBeNull();
  const prefix=operations.reserve("commands")!;
  expect(begin(s,owner,1n,1,new Uint8Array(),0)).toBe("admitted");
  const following=operations.reserve("commands")!;
  expect(s.take(owner,1n)).toBeNull(); expect(following.start()).toBe(false);
  expect(prefix.start()).toBe(true); prefix.finish();
  const execution=s.take(owner,1n)!; expect(execution).not.toBeNull(); execution.complete(0);
  expect(following.start()).toBe(false); s.commit(owner,1n); expect(following.start()).toBe(false);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(following.start()).toBe(true); following.finish(); expect(operations.pending).toBe(0);
});

it("receipt ticket retirement leaves runnable peer sessions independent", () => {
  const s=store(), blockedStream=new GlOperationStream(), peerStream=new GlOperationStream();
  const blocked=s.openOwner(7,11,blockedStream)!, peer=s.openOwner(7,12,peerStream)!;
  begin(s,blocked,1n,1,new Uint8Array(),0); begin(s,peer,1n,1,new Uint8Array(),0);
  const first=s.take(blocked,1n)!; const second=s.take(peer,1n)!;
  expect(first).not.toBeNull(); expect(second).not.toBeNull();
  first.complete(0); second.complete(0); s.commit(blocked,1n); s.commit(peer,1n);
  expect(s.acknowledgeRetired(peer,1n).state).toBe("retired"); expect(peerStream.pending).toBe(0);
  expect(blockedStream.pending).toBe(1); s.acknowledgeRetired(blocked,1n); expect(blockedStream.pending).toBe(0);
});


it("Begin retains accepted drawable/context custody before a queued result can start", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  expect(f.execution.release()).toBe(true); f.binding.surfaceId=31;
  expect(resizeSurfaceTarget(f.binding,4,3)).toBe(true);
  expect(applyCurrentDrawable(f.binding,{drawSurfaceId:31,readSurfaceId:31,width:4,height:3})).toBe(true);
  const accepted=f.registry.retainSubmitExecution(f.binding,f.muxer)!, old=f.binding.presentTarget!;
  const prefix=f.binding.operations.reserve("commands")!;
  expect(begin(s,owner,1n,1,new Uint8Array(),0,new GlNativeResultCustody(accepted,null,f.muxer))).toBe("admitted");
  expect(resizeSurfaceTarget(f.binding,8,6)).toBe(true); f.registry.destroyContext(7,11);
  expect(f.live.has(old.fbo)).toBe(true); expect(s.take(owner,1n)).toBeNull();
  prefix.start(); prefix.finish(); const execution=s.take(owner,1n)!;
  accepted.run(()=>{expect(defaultFramebuffer(f.binding)).toBe(old.fbo);expect(f.binding.contextId).toBe(1);});
  execution.complete(0); s.cancel(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(f.live.has(old.fbo)).toBe(false); f.registry.unbind(7);
});


it("replays terminal ACK without effects and bounds metadata until explicit Forget", () => {
  const s=store({maxOwners:1,maxRequests:1,maxRetainedBytes:8}), owner=open(s,7,11)!;
  begin(s,owner,1n,1,new Uint8Array(),4); const execution=s.take(owner,1n)!;
  execution.complete(0); s.commit(owner,1n);
  const ack={state:"retired",mode:"commit",accepted:true};
  expect(s.acknowledgeRetired(owner,1n)).toEqual(ack);
  expect(s.acknowledgeRetired(owner,1n)).toEqual(ack);
  expect(s.poll(owner,1n)).toEqual(ack);
  expect(s.retainedBytes).toBe(0); expect(s.pendingRequests).toBe(1);
  expect(begin(s,owner,2n,1,new Uint8Array(),0)).toBe("rejected");
  expect(s.forget(owner,1n)).toBe(true); expect(s.pendingRequests).toBe(0);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"unknown"});
  expect(execution.complete(0)).toBe(false);
  expect(begin(s,owner,1n,1,new Uint8Array(),0)).toBe("rejected");
  expect(begin(s,owner,2n,1,new Uint8Array(),0)).toBe("admitted");
  expect(s.forget(owner,2n)).toBe(false);
});

it("owner metadata teardown cannot discard unresolved actual custody", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  begin(s,owner,1n,1,new Uint8Array(),0,new GlNativeResultCustody(f.execution,f.candidate,f.muxer));
  const execution=s.take(owner,1n)!;
  expect(s.forgetOwner(owner)).toBe(false); s.retireOwner(owner);
  expect(s.forgetOwner(owner)).toBe(false); execution.complete(0); f.block(true);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  expect(s.forgetOwner(owner)).toBe(false);
  f.block(false); expect(s.acknowledgeRetired(owner,1n).state).toBe("retired");
  expect(s.forgetOwner(owner)).toBe(true); expect(s.pendingRequests).toBe(0);
  expect(open(s,7,11)!.registration).toBeGreaterThan(owner.registration); f.registry.unbind(7);
});


function fenceInput(f: ReturnType<typeof native>) { const input=new Uint8Array(4); new DataView(input.buffer).setUint32(0,f.candidate.token,true); return input; }

function fenceCustody(f: ReturnType<typeof native>, owner: GlResultOwner, kind: "status" | "release", lease = f.binding.fences.acquire(f.candidate.token)!) {
  return new resultTypes.GlFenceResultCustody(owner,lease,kind,f.muxer);
}

it("retains exact source fence status after creator context retirement without current execution custody", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.candidate.publish(); const custody=fenceCustody(f,owner,"status");
  expect(f.execution.release()).toBe(true); f.registry.destroyContext(7,11);
  expect(f.binding.contextId).toBeNull();
  expect(begin(s,owner,1n,QOP_FENCE_STATUS,fenceInput(f),16,custody)).toBe("admitted");
  const execution=s.take(owner,1n)!;
  expect(custody.poll()).toBe(true); execution.complete(0); s.commit(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(f.binding.fences.has(f.candidate.token)).toBe(true); f.registry.unbind(7);
});

it("fence-release EFAULT cancellation preserves public sync while Commit removes it exactly once", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.candidate.publish(); const cancelledLease=f.binding.fences.acquire(f.candidate.token)!;
  const cancel=fenceCustody(f,owner,"release",cancelledLease), cancelledPublication=vi.spyOn(cancelledLease,"publishRelease");
  begin(s,owner,1n,QOP_RELEASE_FENCE,fenceInput(f),16,cancel);
  s.take(owner,1n)!.complete(16); s.cancel(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(f.binding.fences.has(f.candidate.token)).toBe(true);
  expect(cancelledPublication).not.toHaveBeenCalled();
  const committedLease=f.binding.fences.acquire(f.candidate.token)!;
  const commit=fenceCustody(f,owner,"release",committedLease), committedPublication=vi.spyOn(committedLease,"publishRelease");
  begin(s,owner,2n,QOP_RELEASE_FENCE,fenceInput(f),16,commit); s.take(owner,2n)!.complete(16);
  expect(f.binding.fences.has(f.candidate.token)).toBe(true); s.commit(owner,2n);
  expect(s.acknowledgeRetired(owner,2n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(f.binding.fences.has(f.candidate.token)).toBe(false);
  expect(s.acknowledgeRetired(owner,2n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(committedPublication).toHaveBeenCalledTimes(1);
  f.registry.unbind(7);
});

it("fence lease custody rejects foreign source ledger, stale lease and opcode mismatch", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!, foreign=open(s,7,12)!;
  f.candidate.publish(); const lease=f.binding.fences.acquire(f.candidate.token)!;
  expect(()=>fenceCustody(f,foreign,"release",lease)).toThrow("source");
  const foreignLedger=new GlResultOwner(owner.registration,7,11,new GlOperationStream());
  expect(()=>fenceCustody(f,foreignLedger,"release",lease)).toThrow("source");
  const custody=fenceCustody(f,owner,"release",lease);
  expect(begin(s,owner,1n,QOP_FENCE_STATUS,fenceInput(f),16,custody)).toBe("rejected");
  expect(begin(s,owner,1n,QOP_RELEASE_FENCE,new Uint8Array([255,0,0,0]),16,custody)).toBe("rejected");
  expect(begin(s,owner,1n,QOP_RELEASE_FENCE,fenceInput(f),16,custody)).toBe("admitted");
  expect(()=>fenceCustody(f,owner,"release",lease)).toThrow("transferred");
  s.take(owner,1n)!.complete(0); s.cancel(owner,1n); s.acknowledgeRetired(owner,1n);
  expect(()=>fenceCustody(f,owner,"release",lease)).toThrow();
  f.execution.release(); f.registry.unbind(7);
});

it("fence release retirement retries actual deletion and preserves selected peer flags", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.candidate.publish(); const custody=fenceCustody(f,owner,"release"), deletion=vi.spyOn(f.gl,"deleteSync");
  f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0}); const peer=f.registry.get(7,12)!;
  peer.gl=f.gl;peer.contextId=2;f.muxer.switchTo(peer);
  begin(s,owner,1n,QOP_RELEASE_FENCE,fenceInput(f),16,custody); s.take(owner,1n)!.complete(0);
  f.execution.release(); f.registry.destroyContext(7,11); f.block(true); f.flags.push(0x501); s.commit(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  expect(peer.errors).toEqual([0x501]); expect(f.binding.errors).toEqual([]);
  expect(s.retainedBytes).toBe(36); expect(f.binding.fences.has(f.candidate.token)).toBe(false);
  const nativeSync=deletion.mock.calls[0][0]!; expect(f.live.has(nativeSync)).toBe(true);
  f.block(false); expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(s.retainedBytes).toBe(0); expect(f.live.has(nativeSync)).toBe(false); f.registry.unbind(7);
});


it("creatorless status polling preserves source renderer's selected peer error owner", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.candidate.publish(); const custody=fenceCustody(f,owner,"status");
  f.execution.release(); f.registry.destroyContext(7,11);
  f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0}); const peer=f.registry.get(7,12)!;
  peer.gl=f.gl;peer.contextId=2;f.muxer.switchTo(peer); f.flags.push(0x500);
  begin(s,owner,1n,QOP_FENCE_STATUS,fenceInput(f),16,custody); const execution=s.take(owner,1n)!;
  expect(custody.poll()).toBe(true); expect(peer.errors).toEqual([0x500]); expect(f.binding.errors).toEqual([]);
  execution.complete(0); s.cancel(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true}); f.registry.unbind(7);
});

it("admitted source status survives public session closure until its lease quiesces", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.candidate.publish(); const custody=fenceCustody(f,owner,"status");
  begin(s,owner,1n,QOP_FENCE_STATUS,fenceInput(f),16,custody); const execution=s.take(owner,1n)!;
  f.execution.release(); f.registry.unbind(7);
  expect(custody.poll()).toBe(true); execution.complete(0); s.commit(owner,1n); f.block(true);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"pending"});
  f.block(false); expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
});


it("rejects a lease released between custody capture and admission without destroying the public fence", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.candidate.publish(); const lease=f.binding.fences.acquire(f.candidate.token)!, custody=fenceCustody(f,owner,"release",lease);
  lease.release();
  expect(begin(s,owner,1n,QOP_RELEASE_FENCE,fenceInput(f),16,custody)).toBe("rejected");
  expect(f.binding.fences.has(f.candidate.token)).toBe(true); expect(s.pendingRequests).toBe(0);
  f.execution.release(); f.registry.unbind(7);
});


it("committed source release preserves an independent waiter until its own final retirement", () => {
  const f=native(), s=store(), owner=open(s,7,11,f.binding.operations)!;
  f.candidate.publish(); const waiter=f.binding.fences.acquire(f.candidate.token)!;
  const custody=fenceCustody(f,owner,"release"), deletion=vi.spyOn(f.gl,"deleteSync");
  begin(s,owner,1n,QOP_RELEASE_FENCE,fenceInput(f),16,custody); s.take(owner,1n)!.complete(0); s.commit(owner,1n);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(f.binding.fences.has(f.candidate.token)).toBe(false); expect(deletion).not.toHaveBeenCalled();
  expect(waiter.poll(null)).toBe(true); waiter.release(); expect(deletion).toHaveBeenCalledTimes(1);
  expect(s.acknowledgeRetired(owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(deletion).toHaveBeenCalledTimes(1); f.execution.release(); f.registry.unbind(7);
});
