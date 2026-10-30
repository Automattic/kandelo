import { expect, it, vi } from "vitest";
import { GbmBoRegistry } from "../src/dri/registry.js";
import type { GlOwnedForwardRetirements } from "../src/webgl/owned-forward.js";
import { GlOperationStream } from "../src/webgl/operation-stream.js";
import { createMainForwardChannel, setupMainForward, type GlForwardMessage } from "../src/webgl/main-forward.js";
import { encodeQueryRequest } from "../src/webgl/query-receipt-codec.js";
import * as O from "../src/webgl/ops.js";

class Endpoint {
  listeners = new Set<(e:MessageEvent)=>void>();
  sent:unknown[]=[];
  other!:Endpoint;
  drop:((data:unknown)=>boolean)|null=null;
  delay=false;
  queued:unknown[]=[];
  postMessage(data:unknown):void {
    const copy=structuredClone(data);this.sent.push(copy);
    if(this.drop?.(copy))return;
    if(this.delay)this.queued.push(copy);else this.other.fire(copy);
  }
  fire(data:unknown):void {for(const listener of [...this.listeners])listener({data} as MessageEvent);}
  flush():void {for(const data of this.queued.splice(0))this.other.fire(data);}
  addEventListener(_type:"message",listener:(e:MessageEvent)=>void):void {this.listeners.add(listener);}
  removeEventListener(_type:"message",listener:(e:MessageEvent)=>void):void {this.listeners.delete(listener);}
}
const words=(...values:number[])=>{const b=new Uint8Array(values.length*4),v=new DataView(b.buffer);values.forEach((x,i)=>v.setUint32(i*4,x,true));return b;};
const limits={maxOwners:4,maxRequests:8,maxRetainedBytes:4096};
async function fixture(automatic=false,holder?:GlOwnedForwardRetirements,scheduler?:(epoch:number)=>void) {
  const module=await import("../src/webgl/owned-forward.js");
  const clientPort=new Endpoint(),serverPort=new Endpoint();clientPort.other=serverPort;serverPort.other=clientPort;
  let blocked=false,serial=0,selected:object|null=null;
  const reads:unknown[]=[],errors:number[]=[];
  const log:string[]=[],live=new Set<object>();
  const make=()=>{const value={serial:++serial};live.add(value);return value;};
  const remove=(value:object)=>{if(blocked)throw new Error("native delete refused");live.delete(value);};
  const gl=new Proxy({getError:()=>errors.shift()??0,isContextLost:()=>false,getExtension:()=>null,getSyncParameter:()=>0x9119,
    FRAMEBUFFER_COMPLETE:0x8cd5,checkFramebufferStatus:()=>0x8cd5,
    getParameter:(p:number)=>{log.push(`parameter:${p}`);return p===0x0d33?4096:p===0x84e0?0x84c0:0;},clear:()=>log.push("clear"),finish:()=>log.push("finish"),
    createVertexArray:make,createTexture:make,createFramebuffer:make,createRenderbuffer:make,fenceSync:make,
    deleteVertexArray:remove,deleteTexture:remove,deleteFramebuffer:remove,deleteRenderbuffer:remove,deleteSync:remove,
    bindFramebuffer:(target:number,value:object|null)=>{if(target!==0x8ca9)selected=value;},
    readPixels:(_x:number,_y:number,_w:number,_h:number,_f:number,_t:number,bytes:Uint8Array)=>{reads.push(selected);log.push("read");bytes.fill(7);},
  },{get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const canvas={width:4,height:3,getContext:()=>gl} as unknown as HTMLCanvasElement;
  const retirements=holder??new module.GlOwnedForwardRetirements(2),drainRequests:number[]=[];
  const dispose=setupMainForward(serverPort,canvas,7,{endpoint:serverPort,limits,retirements,bos:new GbmBoRegistry(),
    ...(scheduler?{queueDrain:scheduler}:automatic?{}:{queueDrain:(epoch:number)=>{drainRequests.push(epoch);}})});
  const channel=createMainForwardChannel(clientPort as {postMessage(message:GlForwardMessage):void},7);
  expect(channel.onCreateContext(11,undefined,21)).toBe(0);
  expect(channel.onMakeCurrent!({drawSurfaceId:0,readSurfaceId:0,width:4,height:3},11)).toBe(0);
  const client=new module.GlOwnedForwardClient(clientPort,7,limits,()=>{});
  const operations=new GlOperationStream(),owner=client.register(11,operations)!;
  const begin=(token:bigint,op=O.QOP_FINISH,input=new Uint8Array(),capacity=0)=>client.begin(owner,token,
    {op,input,capacity,context:21,hasCurrent:true,draw:0,read:0});
  log.length=0;
  const drain=()=>{client.drain(8);dispose.ownedQueries!.drain(8);client.drain(8);};
  return {module,clientPort,serverPort,dispose,channel,client,owner,operations,begin,drain,log,live,reads,errors,retirements,drainRequests,block:(v:boolean)=>{blocked=v;}};
}

it("releases an unsent canceled receipt without a fabricated remote ACK or post",async()=>{
  const f=await fixture(),prefix=f.operations.reserve("commands")!;
  f.begin(1n);f.client.drain(8);expect(f.client.admission(f.owner,1n)).toBe("unsent");
  const sent=f.clientPort.sent.length;
  f.client.control(f.owner,1n,"cancel");f.client.drain(8);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(f.clientPort.sent).toHaveLength(sent);expect(f.log).toEqual([]);prefix.cancel();f.dispose();
});

it("keeps the legacy command prefix ahead of the actual paired owned receiver",async()=>{
  const f=await fixture();
  const bytes=new Uint8Array(8),v=new DataView(bytes.buffer);v.setUint16(0,O.OP_CLEAR,true);v.setUint16(2,4,true);v.setUint32(4,0x4000,true);
  f.clientPort.delay=true;f.channel.onSubmit(bytes,11);f.begin(1n);f.client.drain(8);
  expect(f.client.admission(f.owner,1n)).toBe("awaiting-native-admission");expect(f.log).toEqual([]);
  f.clientPort.flush();f.clientPort.delay=false;f.drain();expect(f.log.filter(x=>!x.startsWith("parameter:"))).toEqual(["clear","finish"]);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"ready",rc:0,bytes:new Uint8Array()});
  f.clientPort.delay=false;f.client.control(f.owner,1n,"commit");f.drain();expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});f.dispose();
});

it("replays lost Begin and Commit acknowledgements without repeating native effects",async()=>{
  const f=await fixture();let dropBegin=true,dropCommit=true;
  f.serverPort.drop=data=>{const m=data as {type:string;control?:string};
    if(m.type!=="gl_owned_reply")return false;
    if(m.control==="begin" && dropBegin){dropBegin=false;return true;}
    if(m.control==="commit" && dropCommit){dropCommit=false;return true;}return false;};
  expect(f.begin(1n)).toBe(true);f.client.drain(8);expect(f.client.admission(f.owner,1n)).toBe("awaiting-native-admission");
  f.dispose.ownedQueries!.drain(8);expect(f.log.filter(x=>!x.startsWith("parameter:"))).toEqual(["finish"]);
  f.client.drain(8);expect(f.client.poll(f.owner,1n).state).toBe("ready");
  f.client.control(f.owner,1n,"commit");f.client.drain(8);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retiring",mode:"commit"});
  f.client.drain(8);expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  expect(f.log.filter(x=>!x.startsWith("parameter:"))).toEqual(["finish"]);expect(f.client.retainedBytes).toBe(0);
  expect(f.client.forget(f.owner,1n)).toBe(true);expect(f.dispose.ownedQueries!.pendingRequests).toBe(0);
  f.client.retireOwner(f.owner);f.client.forgetOwner(f.owner);f.dispose();expect(f.retirements.retainedEndpoints).toBe(0);expect(f.client.dispose()).toBe(true);
});

it("keeps attempted sends uncertain even when postMessage throws after enqueue",async()=>{
  const f=await fixture(),original=f.clientPort.postMessage.bind(f.clientPort);
  let throwOnce=true;f.clientPort.postMessage=data=>{original(data);if((data as {type:string}).type==="gl_owned_control" && throwOnce){throwOnce=false;throw new Error("post failed after enqueue");}};
  f.serverPort.drop=data=>(data as {type:string}).type==="gl_owned_reply";
  f.begin(1n);f.client.drain(8);expect(f.client.admission(f.owner,1n)).toBe("awaiting-native-admission");
  f.client.control(f.owner,1n,"cancel");f.client.drain(8);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retiring",mode:"cancel"});expect(f.client.retainedBytes).toBe(0);
  f.serverPort.drop=null;f.client.drain(8);expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(f.log).toEqual([]);f.dispose();
});

it("authenticates a Cancel-before-Begin tombstone and refuses its late Begin forever",async()=>{
  const f=await fixture();f.clientPort.drop=data=>{const m=data as {type:string;bytes?:ArrayBuffer};return m.type==="gl_owned_control" && new DataView(m.bytes!).getUint16(6,true)===1;};
  f.begin(1n);f.client.drain(8);const delayed=f.clientPort.sent.at(-1)!;
  f.client.control(f.owner,1n,"cancel");f.client.drain(8);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  f.client.forget(f.owner,1n);f.clientPort.drop=null;f.serverPort.fire(delayed);f.dispose.ownedQueries!.drain(8);
  expect(f.log).toEqual([]);expect(f.dispose.ownedQueries!.pendingRequests).toBe(0);f.dispose();
});

it("retains copied request bytes through caller mutation, context destruction and late Ready",async()=>{
  const f=await fixture(),input=words(0x0d33);
  // GET_INTEGERV is enough to expose whether the first copied parameter was
  // replaced; glGetError is separately covered by the native candidate suite.
  expect(f.begin(1n,O.QOP_GET_INTEGERV,input,4)).toBe(true);input.fill(255);
  f.client.drain(8);f.channel.onDestroyContext(11);f.drain();
  const result=f.client.poll(f.owner,1n);expect(result.state).toBe("ready");
  if(result.state!=="ready")throw new Error("missing retained result");expect(result.rc).toBe(4);expect(f.log.filter(x=>x.startsWith("parameter:"))).toContain("parameter:3379");
  expect(f.log).not.toContain("parameter:4294967295");
  f.client.control(f.owner,1n,"cancel");f.drain();expect(f.client.poll(f.owner,1n).state).toBe("retired");f.dispose();
});

it("keeps actual renderer custody and listener through failing retirement after setup disposal",async()=>{
  const f=await fixture();f.begin(1n,O.QOP_CREATE_FENCE,words(9),16);f.drain();
  expect(f.client.poll(f.owner,1n).state).toBe("ready");f.block(true);f.dispose();
  expect(f.retirements.retainedEndpoints).toBe(1);expect(f.serverPort.listeners.size).toBe(1);
  f.client.control(f.owner,1n,"cancel");f.client.drain(8);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retiring",mode:"cancel"});expect(f.dispose.ownedQueries!.retainedBytes).toBe(36);
  expect(f.client.dispose()).toBe(false);f.block(false);f.retirements.drain(8);f.client.drain(8);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(f.dispose.ownedQueries!.retainedBytes).toBe(0);f.client.retireOwner(f.owner);f.client.forgetOwner(f.owner);
  expect(f.retirements.retainedEndpoints).toBe(0);expect(f.serverPort.listeners.size).toBe(0);expect(f.client.dispose()).toBe(true);
});

it("recovers lost owner-open and owner-forgotten replies without dropping cleanup authority",async()=>{
  const f=await fixture();let lost=true;f.serverPort.drop=data=>{const m=data as {type:string};if(m.type==="gl_owned_owner_forgotten" && lost){lost=false;return true;}return false;};
  f.begin(1n);f.drain();f.client.control(f.owner,1n,"cancel");f.drain();f.client.retireOwner(f.owner);f.dispose();f.drain();
  f.client.forgetOwner(f.owner);expect(f.retirements.retainedEndpoints).toBe(1);expect(f.client.dispose()).toBe(false);
  f.client.forgetOwner(f.owner);expect(f.retirements.retainedEndpoints).toBe(0);expect(f.client.dispose()).toBe(true);
});

it("rejects wrong peers, stale generations, malformed controls and borrowed or oversized buffers",async()=>{
  const f=await fixture();f.begin(1n);f.client.drain(8);
  const sent=f.clientPort.sent.at(-1) as Record<string,unknown>;
  const before=f.dispose.ownedQueries!.pendingRequests;
  for(const change of [{pid:8},{sessionId:12},{clientRegistration:999999},{epoch:999999},{registration:999999},
    {bytes:new ArrayBuffer(48+65537)},{bytes:new SharedArrayBuffer(48)},
    {bytes:new Uint8Array(48)},{bytes:new ArrayBuffer(48)}])f.serverPort.fire({...sent,...change});
  expect(f.dispose.ownedQueries!.pendingRequests).toBe(before);
  f.dispose.ownedQueries!.drain(8);f.client.drain(8);expect(f.log.filter(x=>x==="finish")).toHaveLength(1);
  const ready=f.serverPort.sent.find(data=>(data as {type:string;control?:string}).type==="gl_owned_reply"
    && (data as {control?:string}).control==="poll") as Record<string,unknown>;
  expect(ready).toBeDefined();
  for(const change of [{pid:8},{sessionId:12},{clientRegistration:999999},{epoch:999999},{registration:999999},
    {bytes:new ArrayBuffer(32+65537)},{bytes:new SharedArrayBuffer(32)}])f.clientPort.fire({...ready,...change});
  expect(f.client.poll(f.owner,1n).state).toBe("ready");f.client.control(f.owner,1n,"cancel");f.client.drain(8);
  f.clientPort.fire(ready);expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  f.dispose();
});

it("keeps accepted draw/read storage alive through surface replacement and context retirement",async()=>{
  const f=await fixture();
  expect(f.channel.onCreateSurface!({surfaceId:31,kind:1,width:4,height:3,configId:1,targetBoId:0},11).rc).toBe(0);
  expect(f.channel.onMakeCurrent!({drawSurfaceId:31,readSurfaceId:31,width:4,height:3},11)).toBe(0);
  const begin={op:O.QOP_READ_PIXELS,input:words(0,0,1,1,0x1908,0x1401),capacity:4,
    hasCurrent:true,context:21,draw:31,read:31};
  expect(f.client.begin(f.owner,1n,begin)).toBe(true);f.client.drain(8);
  // Admission has captured the old independent target; later public roots
  // retire before the queued native query executes.
  const old=[...f.live];f.channel.onDestroySurface!(31,11);
  expect(f.channel.onCreateSurface!({surfaceId:32,kind:1,width:8,height:6,configId:1,targetBoId:0},11).rc).toBe(0);
  f.channel.onDestroyContext(11);
  expect(f.live.size).toBeGreaterThan(0);f.drain();expect(f.reads).toHaveLength(1);expect(old).toContain(f.reads[0]);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"ready",rc:4,bytes:new Uint8Array([7,7,7,7])});
  f.client.control(f.owner,1n,"commit");f.drain();expect(f.live.has(f.reads[0] as object)).toBe(false);
  f.channel.onDestroySurface!(32,11);f.dispose();expect(f.live.size).toBe(0);
});

it("copies only bounded independent codec bytes across the paired endpoint",async()=>{
  const f=await fixture(),guest=new WebAssembly.Memory({initial:1}),view=new Uint8Array(guest.buffer,17,4);
  new DataView(view.buffer,view.byteOffset,4).setUint32(0,0x0d33,true);
  expect(f.begin(1n,O.QOP_GET_INTEGERV,view,4)).toBe(true);view.fill(255);f.drain();
  const messages=f.clientPort.sent.filter(data=>(data as {type:string}).type==="gl_owned_control") as Array<Record<string,unknown>>;
  expect(messages.length).toBeGreaterThan(0);
  for(const message of messages) {
    expect(Object.keys(message).sort()).toEqual(["type","pid","sessionId","clientRegistration","epoch","registration","bytes"].sort());
    expect(message.bytes).toBeInstanceOf(ArrayBuffer);expect(message.bytes).not.toBe(guest.buffer);
    expect((message.bytes as ArrayBuffer).byteLength).toBeLessThanOrEqual(48+65536);
  }
  expect(f.client.retainedBytes).toBe(12);f.client.control(f.owner,1n,"cancel");f.drain();expect(f.client.retainedBytes).toBe(0);f.dispose();
});

it("requires the same ordered endpoint and reserves an actual bounded receiver before admission",async()=>{
  const f=await fixture(),other=new Endpoint();
  expect(()=>setupMainForward(f.serverPort,{} as HTMLCanvasElement,7,{endpoint:other,limits,retirements:f.retirements,bos:new GbmBoRegistry()})).toThrow(/ordered endpoint/);
  const exhausted=new f.module.GlOwnedForwardRetirements(0);
  expect(()=>setupMainForward(f.serverPort,{} as HTMLCanvasElement,7,{endpoint:f.serverPort,limits,retirements:exhausted,bos:new GbmBoRegistry()})).toThrow(/budget exhausted/);
  expect(exhausted.retainedEndpoints).toBe(0);f.dispose();
});

it("recovers a lost Open acknowledgement after server admission has closed",async()=>{
  const f=await fixture();const operations=new GlOperationStream();
  // Establish a second actual session through normal creation, then lose only
  // its optional Open ACK. No query may be posted using a guessed generation.
  expect(f.channel.onCreateContext(12,undefined,22)).toBe(0);
  f.serverPort.drop=data=>(data as {type:string;sessionId:number}).type==="gl_owned_opened" && (data as {sessionId:number}).sessionId===12;
  const owner=f.client.register(12,operations)!;expect(owner).not.toBeNull();f.client.retireOwner(owner);f.dispose();
  expect(f.client.forgetOwner(owner)).toBe(false);expect(f.client.dispose()).toBe(false);
  f.serverPort.drop=null;f.drain();expect(f.client.retirementComplete(owner)).toBe(true);
  expect(f.client.forgetOwner(owner)).toBe(true);
  // The original owner also has a real open grant, even with no query records.
  f.client.retireOwner(f.owner);expect(f.client.forgetOwner(f.owner)).toBe(true);
  expect(f.retirements.retainedEndpoints).toBe(0);expect(f.client.dispose()).toBe(true);
});

it("publishes forwarded error consumption only on Commit, preserving Cancel and lost-ACK retries",async()=>{
  const f=await fixture();
  const prefix=new Uint8Array(8),pv=new DataView(prefix.buffer);pv.setUint16(0,O.OP_CLEAR,true);pv.setUint16(2,4,true);pv.setUint32(4,0x4000,true);
  f.channel.onSubmit(prefix,11);f.errors.push(0x501);
  f.begin(1n,O.QOP_GET_ERROR,words(1),4);f.drain();
  const value=(token:bigint)=>{const result=f.client.poll(f.owner,token);if(result.state!=="ready")throw new Error("missing error result");return new DataView(result.bytes.buffer).getUint32(0,true);};
  expect(value(1n)).toBe(0x501);f.client.control(f.owner,1n,"cancel");f.drain();
  f.begin(2n,O.QOP_GET_ERROR,new Uint8Array(),4);f.drain();expect(value(2n)).toBe(0x501);
  let drop=true;f.serverPort.drop=data=>{const m=data as {type:string;control?:string};if(m.type==="gl_owned_reply" && m.control==="commit" && drop){drop=false;return true;}return false;};
  f.client.control(f.owner,2n,"commit");f.drain();f.client.drain(8);expect(f.client.poll(f.owner,2n).state).toBe("retired");
  f.begin(3n,O.QOP_GET_ERROR,new Uint8Array(),4);f.drain();expect(value(3n)).toBe(0x500);
  f.client.control(f.owner,3n,"commit");f.drain();f.begin(4n,O.QOP_GET_ERROR,new Uint8Array(),4);f.drain();expect(value(4n)).toBe(0);
  f.client.control(f.owner,4n,"cancel");f.drain();f.dispose();
});

it("keeps a later same-session command queued until actual result publication and cleanup",async()=>{
  const f=await fixture();f.begin(1n);f.client.drain(8);
  const bytes=new Uint8Array(8),v=new DataView(bytes.buffer);v.setUint16(0,O.OP_CLEAR,true);v.setUint16(2,4,true);v.setUint32(4,0x4000,true);
  f.channel.onSubmit(bytes,11);expect(f.log.filter(x=>x==="clear")).toEqual([]);f.drain();
  expect(f.log.filter(x=>x==="finish")).toHaveLength(1);expect(f.log.filter(x=>x==="clear")).toEqual([]);
  f.client.control(f.owner,1n,"commit");f.drain();
  // Receiver drain must resume the actual legacy SubmitQueue without requiring
  // an unrelated future GL submit to wake it up.
  expect(f.log.filter(x=>x==="clear")).toHaveLength(1);f.dispose();
});

it("never grants a replacement native generation to a delayed Open after clean owner release",async()=>{
  const f=await fixture();const oldOpen=f.clientPort.sent.find(data=>(data as {type:string}).type==="gl_owned_open")!;
  f.client.retireOwner(f.owner);expect(f.client.forgetOwner(f.owner)).toBe(true);
  const before=f.serverPort.sent.filter(data=>(data as {type:string}).type==="gl_owned_opened").length;
  f.serverPort.fire(oldOpen);
  expect(f.serverPort.sent.filter(data=>(data as {type:string}).type==="gl_owned_opened")).toHaveLength(before);
  expect((f.serverPort.sent.at(-1) as {type:string}).type).toBe("gl_owned_open_rejected");
  f.dispose();expect(f.retirements.retainedEndpoints).toBe(0);
});

it("makes retained source fence status/release controls work after creator context retirement",async()=>{
  const f=await fixture();f.begin(1n,O.QOP_CREATE_FENCE,words(23),16);f.drain();f.client.control(f.owner,1n,"commit");f.drain();
  f.channel.onDestroyContext(11);
  const source={hasCurrent:false,context:21,draw:0,read:0,input:words(23),capacity:16};
  expect(f.client.begin(f.owner,2n,{...source,op:O.QOP_FENCE_STATUS})).toBe(true);f.drain();
  expect(f.client.poll(f.owner,2n).state).toBe("ready");f.client.control(f.owner,2n,"cancel");f.drain();
  expect(f.client.begin(f.owner,3n,{...source,op:O.QOP_RELEASE_FENCE})).toBe(true);f.drain();
  expect(f.client.poll(f.owner,3n).state).toBe("ready");f.client.control(f.owner,3n,"commit");f.drain();
  expect(f.client.poll(f.owner,3n)).toEqual({state:"retired",mode:"commit",accepted:true});f.dispose();
});

it("reports quota-ready commands separately from blocked/retiring work without a retry spin",async()=>{
  const f=await fixture();f.begin(1n);f.client.drain(8);
  const bytes=new Uint8Array(8),v=new DataView(bytes.buffer);v.setUint16(0,O.OP_CLEAR,true);v.setUint16(2,4,true);v.setUint32(4,0x4000,true);
  for(let i=0;i<3;i++)f.channel.onSubmit(bytes,11);
  const blocked=f.dispose.ownedQueries!.drain(1);expect(blocked.commands).toBe("blocked");
  f.client.drain(8);f.client.control(f.owner,1n,"commit");f.client.drain(8);
  const requestCount=f.drainRequests.length;
  expect(f.dispose.ownedQueries!.drain(1).commands).toBe("runnable");expect(f.log.filter(x=>x==="clear")).toHaveLength(1);
  expect(f.dispose.ownedQueries!.drain(1).commands).toBe("runnable");expect(f.dispose.ownedQueries!.drain(1).commands).toBe("empty");
  expect(f.log.filter(x=>x==="clear")).toHaveLength(3);expect(f.drainRequests).toHaveLength(requestCount);
  expect(new Set(f.drainRequests).size).toBe(1);for(const epoch of f.drainRequests)expect(Number.isSafeInteger(epoch)).toBe(true);f.dispose();
});

it("repeats a lost owner-retirement notice until the client requests the exact Cancel mode",async()=>{
  const f=await fixture();f.begin(1n);f.client.drain(8);f.dispose.ownedQueries!.drain(8);
  let drop=true;f.serverPort.drop=data=>{const m=data as {type:string;control?:string};
    if(m.type==="gl_owned_closing")return true;
    if(m.type==="gl_owned_reply" && m.control==="poll" && drop){drop=false;return true;}return false;};
  f.dispose.ownedQueries!.retireSession(11);
  f.client.drain(8);expect(f.client.poll(f.owner,1n)).toEqual({state:"pending"});
  f.client.drain(8);expect(f.client.poll(f.owner,1n)).toEqual({state:"retiring",mode:"cancel"});
  f.client.drain(8);expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  f.serverPort.drop=null;f.dispose();f.drain();
  f.client.retireOwner(f.owner);f.client.forgetOwner(f.owner);expect(f.retirements.retainedEndpoints).toBe(0);
});

it("refuses a premature Commit before native entry without poisoning later cancellation",async()=>{
  const f=await fixture();f.begin(1n);f.client.drain(8);
  const envelope=f.clientPort.sent.at(-1) as Record<string,unknown>;
  const commit=encodeQueryRequest({control:"commit",token:1n});
  f.serverPort.fire({...envelope,bytes:commit.buffer});
  f.client.control(f.owner,1n,"cancel");f.client.drain(8);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"cancel",accepted:true});
  expect(f.log).toEqual([]);f.dispose();
});

async function rendererTurn():Promise<void> {await new Promise<void>(resolve=>setTimeout(resolve,0));}
it("factory schedules actual native query work on a later renderer turn without a drain callback",async()=>{
  const f=await fixture(true);f.begin(1n);f.client.drain(8);
  expect(f.log.filter(value=>value==="finish")).toEqual([]);await rendererTurn();
  f.client.drain(8);expect(f.client.poll(f.owner,1n).state).toBe("ready");expect(f.log.filter(value=>value==="finish")).toHaveLength(1);
  f.client.control(f.owner,1n,"cancel");f.client.drain(8);await closeFactory(f);
});
it("factory resumes the real command queue after query publication without another submit",async()=>{
  const f=await fixture(true);f.begin(1n);f.client.drain(8);
  const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);view.setUint16(0,O.OP_CLEAR,true);view.setUint16(2,4,true);view.setUint32(4,0x4000,true);
  f.channel.onSubmit(bytes,11);await rendererTurn();f.client.drain(8);
  expect(f.log.filter(value=>value==="finish")).toHaveLength(1);expect(f.log.filter(value=>value==="clear")).toEqual([]);
  f.client.control(f.owner,1n,"commit");f.client.drain(8);await rendererTurn();
  expect(f.log.filter(value=>value==="clear")).toHaveLength(1);await closeFactory(f);
});

async function closeFactory(f:Awaited<ReturnType<typeof fixture>>):Promise<void> {
  const state=f.client.poll(f.owner,1n);
  if(state.state==="pending" || state.state==="ready")f.client.control(f.owner,1n,"cancel");
  f.client.drain(8);await rendererTurn();f.client.drain(8);
  expect(f.client.poll(f.owner,1n).state).toBe("retired");expect(f.client.forget(f.owner,1n)).toBe(true);
  f.client.retireOwner(f.owner);f.client.forgetOwner(f.owner);f.dispose();
  for(let i=0;i<3;i++){f.client.drain(8);await rendererTurn();}
  expect(f.client.dispose()).toBe(true);expect(f.serverPort.listeners.size).toBe(0);
}
it("factory gives every actual endpoint a bounded fair turn past the shared holder quota",async()=>{
  const {GlOwnedForwardRetirements}=await import("../src/webgl/owned-forward.js"),holder=new GlOwnedForwardRetirements(72);
  const peers:Awaited<ReturnType<typeof fixture>>[]=[];
  for(let i=0;i<70;i++){const f=await fixture(true,holder);peers.push(f);f.begin(1n);f.client.drain(8);}
  const count=()=>peers.reduce((sum,f)=>sum+f.log.filter(value=>value==="finish").length,0);
  expect(count()).toBe(0);await rendererTurn();expect(count()).toBe(32);
  await rendererTurn();await rendererTurn();expect(count()).toBe(70);
  for(const f of peers){f.client.drain(8);expect(f.client.poll(f.owner,1n).state).toBe("ready");await closeFactory(f);}
  expect(holder.retainedEndpoints).toBe(0);
});
it("factory keeps failed cleanup after disposal, sleeps, and honors a real renewed retirement control",async()=>{
  const f=await fixture(true),drain=vi.spyOn(f.dispose.ownedQueries!,"drain");
  f.begin(1n);f.client.drain(8);await rendererTurn();f.client.drain(8);f.block(true);f.dispose();
  f.client.drain(8);await rendererTurn();f.client.drain(8);await rendererTurn();
  expect(f.retirements.retainedEndpoints).toBe(1);expect(f.serverPort.listeners.size).toBeGreaterThan(0);expect(f.live.size).toBeGreaterThan(0);
  const attempts=drain.mock.calls.length;for(let i=0;i<3;i++)await rendererTurn();expect(drain).toHaveBeenCalledTimes(attempts);
  f.block(false);f.client.drain(8);await rendererTurn();await closeFactory(f);
  expect(f.retirements.retainedEndpoints).toBe(0);expect(f.live.size).toBe(0);
});
it("factory retains uncertain ACKs without a timer retry loop and rejects invalid or stale work authority",async()=>{
  const f=await fixture(true),drain=vi.spyOn(f.dispose.ownedQueries!,"drain");f.begin(1n);f.client.drain(8);await rendererTurn();f.client.drain(8);await rendererTurn();
  const original=f.clientPort.sent.find(message=>(message as {type:string}).type==="gl_owned_control") as Record<string,unknown>;
  const settled=drain.mock.calls.length;
  for(const change of [{pid:9},{registration:999999},{epoch:999999},{clientRegistration:999999},{bytes:new ArrayBuffer(48+65537)}])f.serverPort.fire({...original,...change});
  expect(f.retirements.requestDrain(999999)).toBe(false);for(let i=0;i<3;i++)await rendererTurn();expect(drain).toHaveBeenCalledTimes(settled);
  f.serverPort.drop=data=>{const message=data as {type:string;control?:string};return message.type==="gl_owned_reply" && message.control==="commit";};
  f.client.control(f.owner,1n,"commit");f.client.drain(8);await rendererTurn();
  expect(f.client.poll(f.owner,1n).state).toBe("retiring");const uncertain=drain.mock.calls.length;
  for(let i=0;i<3;i++)await rendererTurn();expect(drain).toHaveBeenCalledTimes(uncertain);
  f.serverPort.drop=null;f.client.drain(8);await rendererTurn();expect(f.client.poll(f.owner,1n).state).toBe("retired");
  await closeFactory(f);expect(f.retirements.requestDrain(original.epoch as number)).toBe(false);expect(f.retirements.retainedEndpoints).toBe(0);
});
it("factory captures timer intrinsics and cancels only after authenticated actual receiver release",async()=>{
  const f=await fixture(true),timer=setTimeout;
  const schedule=vi.spyOn(globalThis,"setTimeout").mockImplementation(()=>{throw new Error("late schedule replacement");});
  const cancel=vi.spyOn(globalThis,"clearTimeout").mockImplementation(()=>{throw new Error("late cancel replacement");});
  try {
    f.begin(1n);f.client.drain(8);f.client.control(f.owner,1n,"cancel");f.client.drain(8);f.client.forget(f.owner,1n);
    f.client.retireOwner(f.owner);f.client.forgetOwner(f.owner);f.dispose();
    expect(f.client.dispose()).toBe(true);expect(f.retirements.retainedEndpoints).toBe(0);expect(f.live.size).toBe(0);
    await new Promise<void>(resolve=>timer(resolve,0));expect(f.log.filter(value=>value==="finish")).toEqual([]);
    expect(schedule).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();
  } finally {schedule.mockRestore();cancel.mockRestore();}
});
it("factory exposes override scheduling failure while retaining actual admitted work for renewed scheduling",async()=>{
  let failed=true,holder:GlOwnedForwardRetirements|undefined;
  const f=await fixture(true,undefined,epoch=>{if(failed)throw new Error("renderer scheduler refused");holder!.requestDrain(epoch);});holder=f.retirements;
  f.begin(1n);f.client.drain(8);const message=f.clientPort.sent.find(value=>(value as {type:string}).type==="gl_owned_control")!;
  expect(()=>f.serverPort.fire(message)).toThrow("renderer scheduler refused");
  expect(f.dispose.ownedQueries!.pendingRequests).toBe(1);expect(f.retirements.retainedEndpoints).toBe(1);expect(f.log.filter(value=>value==="finish")).toEqual([]);
  failed=false;f.serverPort.fire(message);await rendererTurn();f.client.drain(8);
  expect(f.client.poll(f.owner,1n).state).toBe("ready");expect(f.log.filter(value=>value==="finish")).toHaveLength(1);await closeFactory(f);
});

it("factory rejects a synchronous scheduler override before executing native work",async()=>{
  let inline=true,controller:NonNullable<ReturnType<typeof setupMainForward>["ownedQueries"]>|undefined,holder:GlOwnedForwardRetirements|undefined;
  const f=await fixture(true,undefined,epoch=>{if(inline)controller!.drain(1);else holder!.requestDrain(epoch);});
  controller=f.dispose.ownedQueries!;holder=f.retirements;f.begin(1n);f.client.drain(8);
  const message=f.clientPort.sent.find(value=>(value as {type:string}).type==="gl_owned_control")!;
  expect(()=>f.serverPort.fire(message)).toThrow("later non-reentrant turn");expect(f.log.filter(value=>value==="finish")).toEqual([]);
  inline=false;f.serverPort.fire(message);await rendererTurn();f.client.drain(8);
  expect(f.client.poll(f.owner,1n).state).toBe("ready");await closeFactory(f);
});


it("rejects changed paired Begin inputs through lost admission ACK and Ready without new bytes or native effects",async()=>{
  const f=await fixture();let dropBegin=true;
  f.serverPort.drop=data=>{const m=data as {type:string;control?:string};
    if(m.type==="gl_owned_reply" && m.control==="begin" && dropBegin){dropBegin=false;return true;}return false;};
  const original=words(0x0d33),changed=words(0x0d32);
  expect(f.begin(1n,O.QOP_GET_INTEGERV,original,4)).toBe(true);
  const charged=f.client.retainedBytes;expect(charged).toBe(12);
  f.client.drain(8);expect(f.client.admission(f.owner,1n)).toBe("awaiting-native-admission");
  // Also exercise the real authenticated receiver with a changed wire body,
  // rather than relying only on the paired client's local refusal.
  const first=f.clientPort.sent.find(value=>(value as {type:string}).type==="gl_owned_control") as object;
  const tampered={...first,bytes:encodeQueryRequest({control:"begin",token:1n,begin:{
    op:O.QOP_GET_INTEGERV,input:changed,capacity:4,context:21,hasCurrent:true,draw:0,read:0}}).buffer};
  const replies=f.serverPort.sent.length;f.serverPort.fire(tampered);expect(f.serverPort.sent).toHaveLength(replies);
  const sent=f.clientPort.sent.length;
  expect(f.begin(1n,O.QOP_GET_INTEGERV,changed,4)).toBe(false);
  expect(f.clientPort.sent).toHaveLength(sent);expect(f.client.retainedBytes).toBe(charged);
  f.drain();const ready=f.client.poll(f.owner,1n);expect(ready).toEqual({state:"ready",rc:4,bytes:words(4096)});
  const nativeReads=f.log.filter(value=>value===`parameter:${0x0d33}`).length;
  expect(nativeReads).toBeGreaterThan(0);
  const readyReplies=f.serverPort.sent.length;f.serverPort.fire(tampered);expect(f.serverPort.sent).toHaveLength(readyReplies);
  expect(f.begin(1n,O.QOP_GET_INTEGERV,changed,4)).toBe(false);
  expect(f.begin(1n,O.QOP_GET_INTEGERV,original,4)).toBe(true);
  f.drain();expect(f.client.poll(f.owner,1n)).toEqual(ready);
  expect(f.log.filter(value=>value===`parameter:${0x0d33}`)).toHaveLength(nativeReads);
  expect(f.client.retainedBytes).toBe(charged);
  f.client.control(f.owner,1n,"commit");f.drain();expect(f.client.retainedBytes).toBe(0);
  expect(f.begin(1n,O.QOP_GET_INTEGERV,original,4)).toBe(false);
  expect(f.client.poll(f.owner,1n)).toEqual({state:"retired",mode:"commit",accepted:true});
  f.dispose();
});
