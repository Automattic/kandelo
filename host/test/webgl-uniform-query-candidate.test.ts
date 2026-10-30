import { describe,expect,it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { prepareGlUniformQuery } from "../src/webgl/uniform-query-candidate.js";
import { publishedUniformLocation } from "../src/webgl/object-group.js";
import { GlUniformLookupBudget } from "../src/webgl/uniform-lookup-bytes.js";
import { finalizeProgram,linkProgramRetainingExecutable,useProgramIfAccepted } from "../src/webgl/program-objects.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";

type Program={linked:boolean;links:number;id:number};
function fixture(limit=8*1024*1024) {
  const errors:number[]=[],lookups:{program:Program;text:string;links:number}[]=[],deleted:Program[]=[];
  let serial=0,current:Program|null=null;
  const controls={failDelete:false,failLink:false,writes:0};
  const native={
    getError:()=>errors.shift()??0,isContextLost:()=>false,
    createProgram:()=>({linked:true,links:0,id:++serial}),
    getParameter:(p:number)=>p===0x8b8d?current:0,
    getProgramParameter:(p:Program,q:number)=>q===0x8b82?p.linked:q===0x8b86?1:0,
    getActiveUniform:()=>({name:"color",type:0x1406,size:1}),
    getUniformLocation:(p:Program,text:string)=>{lookups.push({program:p,text,links:p.links});return text==="color"?{p,links:p.links}:null;},
    useProgram:(p:Program|null)=>{current=p;},
    uniform1f:(location:{p:Program;links:number})=>{expect(location.p).toBe(current);expect(location.links).toBe(location.p.links);controls.writes++;},
    linkProgram:(p:Program)=>{p.links++;p.linked=!controls.failLink;},
    deleteProgram:(p:Program)=>{if(controls.failDelete){errors.push(0x502);return;}deleted.push(p);},
  };
  const gl=new Proxy(native,{get:(target,key)=>Reflect.get(target,key)??(()=>null)}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry();registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:4096});
  const b=registry.get(7,11)!;b.gl=gl;b.contextId=21;b.cmdbufView=new Uint8Array(4096);
  b.objects.uniformLookupBudget=new GlUniformLookupBudget(limit);
  const program=native.createProgram();b.programs.set(20,program as unknown as WebGLProgram);
  const muxer=new GlMuxer(gl),execution=registry.retainContextExecution(7,11,muxer)!;expect(execution).not.toBeNull();
  const single=(text="color",capacity=4)=>{
    const bytes=new TextEncoder().encode(text),input=new Uint8Array(8+bytes.length),v=new DataView(input.buffer);
    v.setUint32(0,20,true);v.setUint32(4,bytes.length,true);input.set(bytes,8);
    return prepareGlUniformQuery(execution,O.QOP_GET_UNIFORM_LOC,input,capacity);
  };
  const lookup=(action:number,token:number,arg=0,bytes=new Uint8Array(),capacity=16)=>{
    const input=new Uint8Array(16+bytes.length),v=new DataView(input.buffer);
    [action,20,token,arg].forEach((word,i)=>v.setUint32(i*4,word,true));input.set(bytes,16);
    return prepareGlUniformQuery(execution,O.QOP_LOOKUP_UNIFORM,input,capacity);
  };
  const close=()=>{expect(execution.release()).toBe(true);registry.unbind(7,11);};
  return {b,gl,registry,execution,muxer,native,controls,program,lookups,deleted,errors,single,lookup,close};
}
function scalar(bytes:Uint8Array,offset=0):number {return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getInt32(offset,true);}
function commit(candidate:NonNullable<ReturnType<typeof prepareGlUniformQuery>>):void {expect(candidate.publish()).toBe(true);expect(candidate.retire()).toBe(true);}

describe("retained uniform query candidates",()=>{
  it("looks up once, keeps Ready private and publishes the exact reserved location once",()=>{
    const f=fixture(),candidate=f.single()!,index=scalar(candidate.bytes);
    expect(candidate.result).toBe(4);expect(f.lookups).toHaveLength(1);
    expect(f.b.nextUniformLoc).toBe(0);expect(publishedUniformLocation(f.b,index)).toBeUndefined();
    expect(scalar(candidate.bytes)).toBe(index);expect(f.lookups).toHaveLength(1);
    expect(candidate.publish()).toBe(true);expect(candidate.publish()).toBe(true);
    expect(f.b.nextUniformLoc).toBe(index);expect(publishedUniformLocation(f.b,index)?.metadata.executable).toBe(f.program);
    expect(candidate.retire()).toBe(true);expect(candidate.retire()).toBe(true);
    expect(f.b.programQueryPins.size).toBe(0);expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("cancels unpublished identities without burning an index or exposing a setter location",()=>{
    const f=fixture(),candidate=f.single()!,index=scalar(candidate.bytes);
    candidate.cancel();expect(candidate.awaitingPublication).toBe(false);expect(candidate.publish()).toBe(false);expect(candidate.retire()).toBe(true);
    expect(f.b.uniformLocationRecords.size).toBe(0);expect(f.b.nextUniformLoc).toBe(0);
    const next=f.single()!;expect(scalar(next.bytes)).toBe(index);commit(next);f.close();
  });
  it("shares a reservation across equal names and reclaims it only after the last cancel",()=>{
    const f=fixture(),a=f.single()!,b=f.single()!,index=scalar(a.bytes);
    expect(scalar(b.bytes)).toBe(index);a.cancel();expect(a.retire()).toBe(true);
    expect(f.b.uniformLocationRecords.get(index)?.references).toBe(1);commit(b);
    expect(publishedUniformLocation(f.b,index)).toBeDefined();f.close();
  });
  it("does not allocate a replacement record during Commit",()=>{
    const f=fixture(),candidate=f.single()!,set=f.b.uniformLocationRecords.set;
    f.b.uniformLocationRecords.set=()=>{throw new Error("publication allocated");};
    commit(candidate);f.b.uniformLocationRecords.set=set;f.close();
  });
  it("pins a noncurrent executable so relink uses a replacement and never revives an old location",()=>{
    const f=fixture(),candidate=f.single()!,index=scalar(candidate.bytes);
    f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:4096});const peer=f.registry.get(7,12)!;peer.gl=f.gl;peer.contextId=22;
    expect(f.registry.shareObjects(7,12,11)).toBe(true);
    linkProgramRetainingExecutable(peer,20);linkProgramRetainingExecutable(peer,20);
    expect(f.program.links).toBe(0);expect(f.deleted).not.toContain(f.program);
    expect(f.b.programs.get(20)).not.toBe(f.program);
    const fresh=f.single()!;expect(scalar(fresh.bytes)).toBeGreaterThan(index);commit(fresh);
    commit(candidate);expect(publishedUniformLocation(f.b,index)).toBeUndefined();
    expect(f.deleted.filter(p=>p===f.program)).toHaveLength(1);f.registry.unbind(7,12);f.close();
  });
  it("keeps an old current executable's prepared location valid after failed relink",()=>{
    const f=fixture();useProgramIfAccepted(f.b,20);const candidate=f.single()!,index=scalar(candidate.bytes);
    f.controls.failLink=true;linkProgramRetainingExecutable(f.b,20);
    expect(f.b.currentProgram).toBe(f.program);expect(f.b.programs.get(20)).not.toBe(f.program);
    commit(candidate);expect(publishedUniformLocation(f.b,index)?.metadata.executable).toBe(f.program);
    const v=new DataView(f.b.cmdbufView!.buffer);v.setUint16(0,O.OP_UNIFORM1F,true);v.setUint16(2,8,true);v.setInt32(4,index,true);
    expect(decodeAndDispatch(f.b,0,12)).toBe(0);expect(f.controls.writes).toBe(1);f.close();
  });
  it("matches the actual captured lease even after replacement and rejects a different same-device source",()=>{
    const f=fixture(),candidate=f.single()!;
    expect(candidate.matchesExecution(f.execution)).toBe(true);
    f.b.contextId=99;expect(candidate.matchesExecution(f.execution)).toBe(false);f.b.contextId=21;
    f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:4096});const peer=f.registry.get(7,12)!;peer.gl=f.gl;peer.contextId=22;
    const other=f.registry.retainContextExecution(7,12,f.muxer)!;expect(candidate.matchesExecution(other)).toBe(false);
    f.registry.destroyContext(7,11);expect(candidate.matchesExecution(f.execution)).toBe(true);
    candidate.cancel();expect(candidate.retire()).toBe(true);expect(candidate.retirementComplete).toBe(true);
    expect(candidate.matchesExecution(f.execution)).toBe(false);expect(other.release()).toBe(true);f.registry.unbind(7,12);
    expect(f.execution.release()).toBe(true);f.registry.unbind(7,11);
  });
  it("returns an inactive location without allocating a public index",()=>{
    const f=fixture(),candidate=f.single("absent")!;expect(scalar(candidate.bytes)).toBe(-1);commit(candidate);
    expect(f.b.nextUniformLoc).toBe(0);expect(f.b.uniformLocationRecords.size).toBe(0);expect(f.b.errors).toEqual([]);f.close();
  });
  it("keeps deleted query programs alive until candidate cancellation retires native custody",()=>{
    const f=fixture(),candidate=f.single()!;
    f.b.programDeletePending.add(20);finalizeProgram(f.b,20);expect(f.deleted).toEqual([]);
    candidate.cancel();expect(candidate.retire()).toBe(true);expect(f.deleted).toEqual([f.program]);
    expect(f.b.programs.has(20)).toBe(false);expect(f.b.uniformLocationRecords.size).toBe(0);f.close();
  });
  it("retains a failed native pin retirement for exact retry",()=>{
    const f=fixture(),candidate=f.single()!;linkProgramRetainingExecutable(f.b,20);
    candidate.cancel();f.controls.failDelete=true;expect(candidate.retire()).toBe(false);
    expect(f.b.programQueryPins.get(f.program as unknown as WebGLProgram)).toBe(1);
    expect(f.deleted).not.toContain(f.program);f.controls.failDelete=false;
    expect(candidate.retire()).toBe(true);expect(f.deleted.filter(p=>p===f.program)).toHaveLength(1);f.close();
  });
  it("preserves actual source execution after public context replacement",()=>{
    const f=fixture(),candidate=f.single()!,index=scalar(candidate.bytes);
    f.registry.destroyContext(7,11);const replacement=f.registry.get(7,11)!;
    expect(replacement).not.toBe(f.b);commit(candidate);
    expect(replacement.uniformLocationRecords.size).toBe(0);expect(f.b.nextUniformLoc).toBe(index);
    expect(f.execution.release()).toBe(true);expect(f.deleted).toContain(f.program);f.registry.unbind(7,11);
  });
  it.each([0,3,65537])("rejects output capacity%s before native reads or pin allocation",capacity=>{
    const f=fixture();expect(f.single("color",capacity)).toBeNull();expect(f.lookups).toEqual([]);
    expect(f.b.programQueryPins.size).toBe(0);expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("reports staging exhaustion before any native lookup or partial public identity",()=>{
    const f=fixture(3);expect(f.single()).toBeNull();expect(f.lookups).toEqual([]);
    expect(f.b.errors).toEqual([0x505]);expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("stages BEGIN and CHUNK privately and preserves the old assembly on canceled delivery",()=>{
    const f=fixture(),begin=f.lookup(1,1,5)!;expect(f.b.uniformLookup).toBeNull();commit(begin);
    const pending=f.b.uniformLookup!;
    const chunk=f.lookup(2,1,0,new TextEncoder().encode("color"))!;
    expect(pending.cursor).toBe(0);chunk.cancel();expect(chunk.retire()).toBe(true);expect(pending.cursor).toBe(0);
    commit(f.lookup(2,1,0,new TextEncoder().encode("color"))!);expect(pending.cursor).toBe(5);
    const finish=f.lookup(3,1)!;expect(f.b.uniformLookup).toBe(pending);expect(f.lookups).toHaveLength(1);
    const index=scalar(finish.bytes,8);commit(finish);expect(f.b.uniformLookup).toBeNull();
    expect(publishedUniformLocation(f.b,index)).toBeDefined();expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("preserves an accepted assembly and serial when replacement BEGIN is canceled",()=>{
    const f=fixture();commit(f.lookup(1,1,5)!);const old=f.b.uniformLookup;
    const next=f.lookup(1,2,9)!;expect(f.b.uniformLookup).toBe(old);expect(f.b.uniformLookupSerial).toBe(1);
    next.cancel();expect(next.retire()).toBe(true);expect(f.b.uniformLookup).toBe(old);
    expect(f.b.uniformLookupBudget.used).toBe(5);commit(f.lookup(4,1)!);expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("detects in-place relink between name chunks before querying the replacement executable",()=>{
    const f=fixture();commit(f.lookup(1,1,5)!);commit(f.lookup(2,1,0,new TextEncoder().encode("color"))!);
    linkProgramRetainingExecutable(f.b,20);expect(f.b.programs.get(20)).toBe(f.program);
    const finish=f.lookup(3,1)!;expect(scalar(finish.bytes)).toBe(1);expect(f.lookups).toEqual([]);
    commit(finish);expect(f.b.uniformLookup).toBeNull();expect(f.b.errors).toContain(0x502);f.close();
  });
  it("charges candidate copies as well as assembly bytes and releases every cancellation",()=>{
    const f=fixture(40);commit(f.lookup(1,1,20)!);expect(f.b.uniformLookupBudget.used).toBe(20);
    const chunk=f.lookup(2,1,0,new Uint8Array(5))!;
    expect(scalar(chunk.bytes)).toBe(1);expect(f.b.uniformLookupBudget.used).toBe(36);
    chunk.cancel();expect(chunk.retire()).toBe(true);expect(f.b.uniformLookupBudget.used).toBe(20);
    commit(f.lookup(4,1)!);expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("assembles a valid 140001-byte name in RPC-sized chunks without reexecuting Ready",()=>{
    const f=fixture(),text="u"+"n".repeat(140000),bytes=new TextEncoder().encode(text);
    f.native.getActiveUniform=()=>({name:text,type:0x1406,size:1});
    f.native.getUniformLocation=(p,name)=>{f.lookups.push({program:p,text:name,links:p.links});return {p,links:p.links};};
    commit(f.lookup(1,1,bytes.length)!);
    for(let offset=0;offset<bytes.length;offset+=65520)commit(f.lookup(2,1,offset,bytes.subarray(offset,offset+65520))!);
    expect(f.lookups).toEqual([]);const finish=f.lookup(3,1)!,index=scalar(finish.bytes,8);
    expect(scalar(finish.bytes,8)).toBe(index);expect(f.lookups).toHaveLength(1);expect(f.lookups[0].text).toBe(text);
    commit(finish);expect(publishedUniformLocation(f.b,index)?.canonical).toBe(text);
    expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("shares copied-byte pressure across actual object-group peers",()=>{
    const f=fixture(40);commit(f.lookup(1,1,20)!);
    f.registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:4096});const peer=f.registry.get(7,12)!;peer.gl=f.gl;peer.contextId=22;
    expect(f.registry.shareObjects(7,12,11)).toBe(true);const execution=f.registry.retainContextExecution(7,12,f.muxer)!;
    const input=new Uint8Array(new Uint32Array([1,20,1,20]).buffer),candidate=prepareGlUniformQuery(execution,O.QOP_LOOKUP_UNIFORM,input,16)!;
    expect(scalar(candidate.bytes)).toBe(1);expect(peer.errors).toEqual([0x505]);expect(f.b.errors).toEqual([]);
    candidate.cancel();expect(candidate.retire()).toBe(true);expect(peer.uniformLookup).toBeNull();
    expect(peer.uniformLookupBudget.used).toBe(20);expect(execution.release()).toBe(true);f.registry.unbind(7,12);
    f.close();expect(f.b.objects.uniformLookupBudget.used).toBe(0);
  });
  it("refuses a 4GiB declared assembly through its resource budget without attempting that allocation",()=>{
    const f=fixture(),candidate=f.lookup(1,1,0xffff_ffff)!;expect(scalar(candidate.bytes)).toBe(1);
    expect(f.b.uniformLookup).toBeNull();expect(f.b.uniformLookupBudget.used).toBe(16);
    candidate.cancel();expect(candidate.retire()).toBe(true);expect(f.b.uniformLookupBudget.used).toBe(0);f.close();
  });
  it("releases accepted assembly bytes when its owner retires",()=>{
    const f=fixture();commit(f.lookup(1,1,140001)!);const budget=f.b.uniformLookupBudget;
    expect(budget.used).toBe(140001);f.close();expect(budget.used).toBe(0);
  });
  it("keeps existing driver errors on the actual query context",()=>{
    const f=fixture();f.errors.push(0x500);const candidate=f.single()!;
    expect(f.b.errors).toEqual([0x500]);candidate.cancel();expect(candidate.retire()).toBe(true);
    const out=new Uint8Array(4);expect(runGlQuery(f.b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
    expect(scalar(out)).toBe(0x500);f.close();
  });
});
