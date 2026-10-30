import { describe, expect, it, vi } from "vitest";
import { decodeAndDispatch, validateCommandBuffer } from "../src/webgl/bridge.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { uniformLocation } from "../src/webgl/uniform-queries.js";
import { runGlQuery } from "../src/webgl/query.js";
import { linkProgramRetainingExecutable } from "../src/webgl/program-objects.js";
import { uniformUploadComponents } from "../src/webgl/uniform-upload.js";
import * as O from "../src/webgl/ops.js";

const signatures: [number,number,string][] = [
  [O.OP_UNIFORM1FV,0x1406,"uniform1fv"],[O.OP_UNIFORM2FV,0x8b50,"uniform2fv"],
  [O.OP_UNIFORM3FV,0x8b51,"uniform3fv"],[O.OP_UNIFORM4FV,0x8b52,"uniform4fv"],
  [O.OP_UNIFORM1IV,0x1404,"uniform1iv"],[O.OP_UNIFORM2IV,0x8b53,"uniform2iv"],
  [O.OP_UNIFORM3IV,0x8b54,"uniform3iv"],[O.OP_UNIFORM4IV,0x8b55,"uniform4iv"],
  [O.OP_UNIFORM_MATRIX2FV,0x8b5a,"uniformMatrix2fv"],
  [O.OP_UNIFORM_MATRIX3FV,0x8b5b,"uniformMatrix3fv"],
  [O.OP_UNIFORM_MATRIX4FV,0x8b5c,"uniformMatrix4fv"],
];

/** Reflection/native-call model only. Normal compiled guests and rendered
 * browser cases supply separate driver evidence. These run the real decoder. */
function setup(type=0x1406,size=20000,array=true) {
  const program={} as WebGLProgram, nativeLocation={} as WebGLUniformLocation;
  const calls: {name:string;values:number[]}[]=[], errors:number[]=[];
  let current:WebGLProgram|null=program;
  const linked=new Set([program]);
  const native={
    linkSucceeds:false,failUniform:false,
    linkProgram:(p:WebGLProgram)=>{if(native.linkSucceeds)linked.add(p);},
    getError:()=>errors.shift()??0,
    getProgramParameter:(p:WebGLProgram,pname:number)=>pname===0x8b82?linked.has(p):pname===0x8b86?1:0,
    getActiveUniform:()=>({name:array?"values[0]":"values",size,type}),
    getUniformLocation:()=>nativeLocation,
    getParameter:(pname:number)=>pname===0x8b8d?current:0,
    useProgram:(p:WebGLProgram|null)=>{current=p;},
    createProgram:()=>({}),
  };
  const gl=new Proxy(native,{get(target,key){
    if(typeof key==="string" && key.startsWith("uniform")) return (_loc:unknown,...args:unknown[])=>{
      if(native.failUniform){errors.push(0x502);return;}
      const data=args.at(-1) as ArrayLike<number>;calls.push({name:key,values:Array.from(data)});
    };
    return Reflect.get(target,key)??(()=>{});
  }}) as unknown as WebGL2RenderingContext;
  const registry=new GlContextRegistry();registry.bind({pid:1,sessionId:2,cmdbufAddr:0,cmdbufLen:1<<20});
  const b=registry.get(1,2)!;b.gl=gl;b.contextId=21;b.cmdbufView=new Uint8Array(1<<20);
  b.programs.set(20,program);b.currentProgram=b.shadow.currentProgram=program;b.currentProgramId=20;
  const location=uniformLocation(b,20,"values")!;expect(location).toBeGreaterThan(0);
  function bytes(op:number,words:number[]) {
    const input=new Uint8Array(4+words.length*4),v=new DataView(input.buffer);
    v.setUint16(0,op,true);v.setUint16(2,words.length*4,true);
    words.forEach((word,index)=>v.setUint32(4+index*4,word,true));return input;
  }
  const send=(op:number,words:number[])=>{const data=bytes(op,words);b.cmdbufView!.set(data);return decodeAndDispatch(b,0,data.length);};
  const begin=(total:number,op=O.OP_UNIFORM1FV,token=1,loc=location,transpose=0)=>send(O.OP_UNIFORM_UPLOAD_BEGIN,[token,op,loc,total,transpose]);
  const chunk=(offset:number,data:number[],op=O.OP_UNIFORM1FV,token=1)=>send(O.OP_UNIFORM_UPLOAD_CHUNK,[token,op,offset,data.length/uniformUploadComponents(op),...data]);
  const commit=(token=1)=>send(O.OP_UNIFORM_UPLOAD_COMMIT,[token]);
  const bits=(values:number[],integer=false)=>values.map(value=>integer?value:new Uint32Array(new Float32Array([value]).buffer)[0]);
  return {b,registry,gl,program,calls,errors,native,location,bytes,send,begin,chunk,commit,bits};
}

describe("atomic large uniform uploads",()=>{
  it("merges a client error trailer between upload batches without interrupting custody",()=>{
    const t=setup(0x1406,2);
    expect(t.begin(2)).toBe(0);expect(t.chunk(0,t.bits([3]))).toBe(0);
    const pending=t.b.uniformUpload;
    expect(t.send(O.OP_CLIENT_ERRORS,[0x03])).toBe(0);
    expect(t.b.uniformUpload).toBe(pending);expect(t.b.errors).toEqual([0x500,0x501]);
    expect(t.chunk(1,t.bits([4]))).toBe(0);expect(t.commit()).toBe(0);
    expect(t.calls).toEqual([{name:"uniform1fv",values:[3,4]}]);
    expect(t.b.errors).toEqual([0x500,0x501]);
  });
  it.each(signatures)("submits opcode%s exactly once after data beyond one TLV is complete",(op,type,name)=>{
    const components=uniformUploadComponents(op),maximum=Math.floor((65535-16)/(components*4)),count=maximum+2;
    const t=setup(type,count),integer=op>=O.OP_UNIFORM1IV && op<=O.OP_UNIFORM4IV;
    const values=Array.from({length:count*components},(_,i)=>i%700-.25);
    if(integer)for(let i=0;i<values.length;i++)values[i]=Math.trunc(values[i])|0;
    expect(t.begin(count,op)).toBe(0);expect(t.calls).toEqual([]);
    expect(t.chunk(0,t.bits(values.slice(0,maximum*components),integer),op)).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.chunk(maximum,t.bits(values.slice(maximum*components),integer),op)).toBe(0);
    expect(t.calls).toEqual([]);expect(t.commit()).toBe(0);
    expect(t.calls).toEqual([{name,values}]);expect(t.b.uniformUpload).toBeNull();expect(t.b.errors).toEqual([]);
  });
  it("clamps a large call beginning at an interior reflected array element",()=>{
    const t=setup(0x1406,3);const interior=uniformLocation(t.b,20,"values[2]")!;
    t.begin(20000,O.OP_UNIFORM1FV,1,interior);
    expect(t.b.uniformUpload?.payload?.byteLength).toBe(12);
    t.chunk(0,t.bits(Array(16000).fill(4)));t.chunk(16000,t.bits(Array(4000).fill(5)));t.commit();
    expect(t.calls).toEqual([{name:"uniform1fv",values:[4]}]);expect(t.b.errors).toEqual([]);
  });
  it("bounds staging to reflected tail and consumes ignored source without retaining it",()=>{
    const t=setup(0x1406,3);t.begin(20000);
    expect(t.b.uniformUpload?.payload?.byteLength).toBe(20);
    t.chunk(0,t.bits(Array(16000).fill(2)));t.chunk(16000,t.bits(Array(4000).fill(3)));t.commit();
    expect(t.calls).toEqual([{name:"uniform1fv",values:[2,2,2]}]);expect(t.b.uniformUpload).toBeNull();
  });
  it.each([["nonarray",0x1406,false],["wrong type",0x1404,true]] as const)("rejects %s before any prefix update",(_label,type,array)=>{
    const t=setup(type,1,array);t.begin(20000);
    expect(t.b.uniformUpload?.payload).toBeNull();expect(t.b.errors).toEqual([0x502]);
    t.chunk(0,t.bits(Array(16000).fill(1)));t.chunk(16000,t.bits(Array(4000).fill(2)));t.commit();
    expect(t.calls).toEqual([]);expect(t.b.errors).toEqual([0x502]);
  });
  it.each([[-1,0],[1,1]] as const)("rejects invalid count/transpose (%s,%s) before staging",(count,transpose)=>{
    const t=setup(0x8b5c,3000);t.begin(count,O.OP_UNIFORM_MATRIX4FV,1,t.location,transpose);
    expect(t.b.uniformUpload?.payload).toBeNull();expect(t.b.errors).toEqual([0x501]);expect(t.calls).toEqual([]);
  });
  it("keeps zero count and inactive calls as validated no-ops without native arrays",()=>{
    const t=setup();t.begin(0);t.commit();expect(t.calls).toEqual([]);
    t.begin(20000,O.OP_UNIFORM1FV,2,-1);t.chunk(0,Array(16000).fill(0),O.OP_UNIFORM1FV,2);
    t.chunk(16000,Array(4000).fill(0),O.OP_UNIFORM1FV,2);t.commit(2);
    expect(t.calls).toEqual([]);expect(t.b.errors).toEqual([]);
  });
  it("does not mutate native storage after incomplete, duplicate or reordered continuation",()=>{
    for(const failure of ["missing","duplicate","offset","op","overrun"]){
      const t=setup();t.begin(2);t.chunk(0,t.bits([1]));
      if(failure==="duplicate")t.chunk(0,t.bits([2]));
      if(failure==="offset")t.chunk(2,t.bits([2]));
      if(failure==="op")t.chunk(1,t.bits([2]),O.OP_UNIFORM1IV);
      if(failure==="overrun")t.chunk(1,t.bits([2,3]));
      t.commit();expect(t.calls,failure).toEqual([]);expect(t.b.uniformUpload).toBeNull();expect(t.b.errors).toEqual([0x502]);
    }
  });
  it("commits once, retires cancelled tokens and never lets stale traffic erase a newer owner",()=>{
    const t=setup();t.begin(1);t.chunk(0,t.bits([1]));t.commit();t.commit();expect(t.calls).toHaveLength(1);
    t.send(O.OP_UNIFORM_UPLOAD_CANCEL,[2]);t.send(O.OP_UNIFORM_UPLOAD_CANCEL,[2]);t.begin(1,O.OP_UNIFORM1FV,2);
    expect(t.b.uniformUpload).toBeNull();
    t.begin(1,O.OP_UNIFORM1FV,3);const owner=t.b.uniformUpload;
    t.send(O.OP_UNIFORM_UPLOAD_CANCEL,[2]);t.begin(1,O.OP_UNIFORM1FV,2);t.commit(2);
    expect(t.b.uniformUpload).toBe(owner);
    t.chunk(0,t.bits([2]),O.OP_UNIFORM1FV,3);t.commit(3);expect(t.calls).toHaveLength(2);
    t.send(O.OP_UNIFORM_UPLOAD_CANCEL,[0xffffffff]);t.begin(1,O.OP_UNIFORM1FV,1);
    expect(t.b.uniformUploadSerial).toBe(0xffffffff);expect(t.b.uniformUpload).toBeNull();
  });
  it("reports an abandoned call when a newer BEGIN replaces its unfinished owner",()=>{
    const t=setup();t.begin(2);t.chunk(0,t.bits([1]));const abandoned=t.b.uniformUpload;
    expect(t.calls).toEqual([]);expect(t.b.errors).toEqual([]);
    t.begin(1,O.OP_UNIFORM1FV,2);const replacement=t.b.uniformUpload;
    expect(replacement).not.toBe(abandoned);expect(replacement?.token).toBe(2);
    expect(t.b.errors).toEqual([0x502]);expect(t.calls).toEqual([]);
    t.begin(2,O.OP_UNIFORM1FV,1);t.chunk(1,t.bits([2]),O.OP_UNIFORM1FV,1);
    t.send(O.OP_UNIFORM_UPLOAD_CANCEL,[1]);t.commit(1);
    expect(t.b.uniformUpload).toBe(replacement);
    t.chunk(0,t.bits([9]),O.OP_UNIFORM1FV,2);t.commit(2);
    expect(t.calls).toEqual([{name:"uniform1fv",values:[9]}]);expect(t.b.errors).toEqual([0x502]);
    expect(t.b.uniformUpload).toBeNull();
  });
  it("preserves earlier errors and consumes allocation failures without native writes",()=>{
    const t=setup();t.b.errors.push(0x500);
    const Original=globalThis.Uint8Array;
    // Only the transaction's actual storage allocation is refused.
    const input=t.bytes(O.OP_UNIFORM_UPLOAD_BEGIN,[1,O.OP_UNIFORM1FV,t.location,2,0]);
    t.b.cmdbufView!.set(input);
    vi.stubGlobal("Uint8Array",class extends Original {
      constructor(...args:any[]){if(args.length===1 && args[0]===16)throw new RangeError("allocation refused");super(...args as [number]);}
    });
    try{expect(decodeAndDispatch(t.b,0,input.length)).toBe(0);}finally{vi.unstubAllGlobals();}
    expect(t.b.uniformUpload?.payload).toBeNull();expect(t.b.errors).toEqual([0x500,0x505]);
    t.chunk(0,t.bits([1,2]));t.commit();expect(t.calls).toEqual([]);expect(t.b.uniformUpload).toBeNull();
  });
  it("refuses unrelated commands and queries before their native effects",()=>{
    const t=setup();t.begin(2);t.send(O.OP_USE_PROGRAM,[0]);
    expect(t.b.currentProgram).toBe(t.program);expect(t.b.uniformUpload).toBeNull();expect(t.calls).toEqual([]);
    t.b.errors.length=0;t.begin(2,O.OP_UNIFORM1FV,2);
    const output=new Uint8Array(4).fill(0xaa);
    expect(runGlQuery(t.b,O.QOP_GET_INTEGERV,new Uint8Array(new Uint32Array([0x8b8d]).buffer),output)).toBe(-5);
    expect([...output]).toEqual([0xaa,0xaa,0xaa,0xaa]);expect(t.b.uniformUpload).toBeNull();expect(t.b.errors).toEqual([0x502]);
  });
  it("rechecks exact executable/location/context/group authority before commit",()=>{
    for(const change of ["executable","location","metadata","context","group"]){
      const t=setup();t.begin(1);t.chunk(0,t.bits([1]));
      if(change==="executable")t.b.currentProgram={} as WebGLProgram;
      if(change==="location")t.b.uniformLocations.set(t.location,{} as WebGLUniformLocation);
      if(change==="metadata")t.b.uniformMetadata.set(t.location,{...t.b.uniformMetadata.get(t.location)!});
      if(change==="context")t.b.contextId=22;
      if(change==="group")t.b.objects={...t.b.objects};
      t.commit();expect(t.calls,change).toEqual([]);expect(t.b.errors).toEqual([0x502]);expect(t.b.uniformUpload).toBeNull();
    }
  });
  it("retains accepted executable metadata through a failed relink and deleted-current program",()=>{
    const t=setup();linkProgramRetainingExecutable(t.b,20);
    expect(t.b.programs.get(20)).not.toBe(t.program);expect(t.b.currentProgram).toBe(t.program);
    t.send(O.OP_DELETE_PROGRAM,[20]);t.begin(1);t.chunk(0,t.bits([1]));t.commit();
    expect(t.calls).toEqual([{name:"uniform1fv",values:[1]}]);expect(t.b.errors).toEqual([]);
  });
  it("a successful shared-peer relink invalidates staged location authority",()=>{
    const t=setup();t.begin(1);t.chunk(0,t.bits([1]));
    t.registry.bind({pid:1,sessionId:3,cmdbufAddr:0,cmdbufLen:0});
    const peer=t.registry.get(1,3)!;peer.gl=t.gl;peer.contextId=22;
    expect(t.registry.shareObjects(1,3,2)).toBe(true);t.native.linkSucceeds=true;
    linkProgramRetainingExecutable(peer,20);
    expect(t.b.currentProgram).toBe(t.program);expect(t.b.uniformMetadata.has(t.location)).toBe(false);
    t.commit();expect(t.calls).toEqual([]);expect(t.b.errors).toEqual([0x502]);expect(t.b.uniformUpload).toBeNull();
    t.registry.destroyContext(1,3);t.registry.destroyContext(1,2);
  });
  it("clears staged ownership after an actual native commit rejection",()=>{
    const t=setup();t.begin(1);t.chunk(0,t.bits([1]));
    t.native.failUniform=true;t.commit();
    expect(t.b.uniformUpload).toBeNull();expect(t.calls).toEqual([]);expect(t.b.errors).toEqual([0x502]);
  });
  it("rejects malformed reserved fields before any preceding command mutation",()=>{
    const t=setup(),clear=vi.fn();Object.assign(t.native,{clear});t.begin(2);
    const first=t.bytes(O.OP_CLEAR,[0x4000]),last=t.bytes(O.OP_UNIFORM_UPLOAD_BEGIN,[2,O.OP_UNIFORM1FV,t.location,2,1]);
    const batch=new Uint8Array(first.length+last.length);batch.set(first);batch.set(last,first.length);
    t.b.cmdbufView!.set(batch);expect(decodeAndDispatch(t.b,0,batch.length)).toBe(-22);
    expect(clear).not.toHaveBeenCalled();expect(t.b.uniformUpload).toBeNull();expect(t.calls).toEqual([]);
  });
  it("drops pending bytes on malformed batches and context retirement",()=>{
    const t=setup();t.begin(20000);
    const malformed=t.bytes(O.OP_UNIFORM_UPLOAD_CHUNK,[1,O.OP_UNIFORM1FV,0,2,0]);
    expect(validateCommandBuffer(malformed,0,malformed.length)).toBe(-22);
    t.b.cmdbufView!.set(malformed);expect(decodeAndDispatch(t.b,0,malformed.length)).toBe(-22);
    expect(t.b.uniformUpload).toBeNull();expect(t.calls).toEqual([]);
    t.begin(20000,O.OP_UNIFORM1FV,2);t.registry.destroyContext(1,2);expect(t.b.uniformUpload).toBeNull();
  });
});
