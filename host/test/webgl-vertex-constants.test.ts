import { afterEach,expect,it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import { NativeGlFault,setNativeGlFaultReporter } from "../src/webgl/native-recovery.js";
import * as O from "../src/webgl/ops.js";

const OLD=[1,2,3,4] as [number,number,number,number];
const NEXT=[5,6,7,8] as [number,number,number,number];
function fixture() {
  const registry=new GlContextRegistry();registry.bind({pid:1,sessionId:2,cmdbufAddr:0,cmdbufLen:4096});
  const b=registry.get(1,2)!,errors:number[]=[],calls:number[][]=[],values=new Map<number,number[]>([[2,[...OLD]]]);
  let fault="",rejectRestore=false,restoreIndex=2,limit=8,queryError=0;
  const gl={
    isContextLost:()=>false,getError:()=>errors.shift()??0,
    getParameter:()=>{if(queryError){errors.push(queryError);queryError=0;}return limit;},
    vertexAttrib4f(index:number,...value:number[]){
      calls.push([index,...value]);
      if(index>=8){errors.push(0x501);return;}
      if(rejectRestore&&index===restoreIndex&&value.join(",")===(index===2?OLD:[0,0,0,1]).join(",")){errors.push(0x502);return;}
      const mode=fault;fault="";
      if(mode==="native"){errors.push(0x505);return;}
      if(mode==="throw")throw Error("native constant refused");
      values.set(index,value);
      if(mode==="after-throw")throw Error("constant accepted then transport threw");
    },
  } as unknown as WebGL2RenderingContext;
  b.gl=gl;b.shadow.vertexAttribValues.set(2,[...OLD]);
  const submit=(indices:number[],value:number[]=NEXT)=>{
    const bytes=new Uint8Array(indices.length*24),v=new DataView(bytes.buffer);
    indices.forEach((index,i)=>{const p=i*24;v.setUint16(p,O.OP_VERTEX_ATTRIB_4FV,true);v.setUint16(p+2,20,true);v.setUint32(p+4,index,true);value.forEach((part,j)=>v.setFloat32(p+8+j*4,part,true));});
    b.cmdbufView=bytes;return decodeAndDispatch(b,0,bytes.length);
  };
  const query=(index:number)=>{const output=new Uint8Array(24);expect(runGlQuery(b,O.QOP_GET_VERTEX_ATTRIBFV,new Uint8Array(new Uint32Array([index,0x8626]).buffer),output)).toBe(24);expect(new DataView(output.buffer).getUint32(0,true)).toBe(0);expect(new DataView(output.buffer).getUint32(20,true)).toBe(0x47514c33);return [...new Float32Array(output.buffer,4,4)];};
  return {b,gl,calls,values,errors,registry,submit,query,
    fault:(value:string)=>{fault=value;},restore:(reject:boolean,index=2)=>{rejectRestore=reject;restoreIndex=index;},
    limit:(value:number)=>{limit=value;},queryError:(value:number)=>{queryError=value;},
  };
}

it.each([8,123456,0xffff_ffff])("rejects constant index %s without native effects or shadow growth",index=>{
  const f=fixture(),old=f.b.shadow.vertexAttribValues;f.errors.push(0x500);
  expect(f.submit([index])).toBe(0);expect(f.calls).toEqual([]);
  expect(f.b.shadow.vertexAttribValues).toBe(old);expect([...old.keys()]).toEqual([2]);
  expect(f.b.errors).toEqual([0x500,0x501]);expect(f.values.get(2)).toEqual(OLD);
});

it.each(["native","throw","after-throw"])("publishes no new constant value after %s refusal",fault=>{
  const f=fixture();f.errors.push(0x500);f.fault(fault);
  expect(f.submit([2])).toBe(0);expect(f.b.shadow.vertexAttribValues.get(2)).toEqual(OLD);
  expect(f.values.get(2)).toEqual(OLD);expect(f.query(2)).toEqual(OLD);
  expect(f.b.errors).toEqual([0x500,fault==="native"?0x505:0x502]);
});

it("bounds repeated invalid-index batches and still executes a later valid command",()=>{
  const f=fixture(),indices=Array.from({length:100},(_,i)=>1000+i);
  expect(f.submit([...indices,7])).toBe(0);expect(f.calls).toEqual([[7,...NEXT]]);
  expect([...f.b.shadow.vertexAttribValues.keys()]).toEqual([2,7]);expect(f.query(7)).toEqual(NEXT);
  expect(f.b.errors).toEqual([0x501]);
});

afterEach(()=>setNativeGlFaultReporter(null));

it("makes a refused scalar restoration of an uncertain new constant a fatal fault",()=>{
  const f=fixture(),old=f.b.shadow.vertexAttribValues,reported:Error[]=[];f.b.contextId=3;f.errors.push(0x500);
  setNativeGlFaultReporter(fault=>reported.push(fault));
  f.fault("after-throw");f.restore(true,7);
  let thrown:unknown;try{f.submit([7]);}catch(error){thrown=error;}
  expect(thrown).toBeInstanceOf(NativeGlFault);
  expect((thrown as Error).message).toMatch(/live renderer refused to restore native state after a rejected change/);
  expect(reported.length).toBeGreaterThan(0);expect(reported.at(-1)).toBe(thrown);
  // The uncertain constant is never published as logical state.
  expect(f.b.shadow.vertexAttribValues).toBe(old);expect(old.has(7)).toBe(false);expect(f.values.get(7)).toEqual(NEXT);
  expect(f.b.errors).toEqual([0x500,0x502]);
});

it("updates an existing private tuple only after acceptance without cloning its Map",()=>{
  const f=fixture(),map=f.b.shadow.vertexAttribValues,previous=map.get(2)!;
  map[Symbol.iterator]=()=>{throw Error("an existing-key update must not clone");};
  expect(f.submit([2])).toBe(0);expect(f.b.shadow.vertexAttribValues).toBe(map);
  expect(map.get(2)).toBe(previous);expect(previous).toEqual(NEXT);expect(f.values.get(2)).toEqual(NEXT);
});

it("reserves a new index from bounded valid-slot lookups even with historical invalid keys",()=>{
  const f=fixture(),map=f.b.shadow.vertexAttribValues;
  for(let index=1000;index<2000;index++)map.set(index,[1,1,1,1]);
  map[Symbol.iterator]=()=>{throw Error("must not clone historical invalid entries");};
  const get=map.get;let reads=0;map.get=index=>{reads++;return get.call(map,index);};
  expect(f.submit([7])).toBe(0);expect(reads).toBe(9);
  expect([...f.b.shadow.vertexAttribValues.keys()]).toEqual([2,7]);expect(f.values.get(7)).toEqual(NEXT);
});

it("refuses before native work when bounded shadow reservation fails",()=>{
  const f=fixture(),map=f.b.shadow.vertexAttribValues,get=map.get;
  map.get=index=>{if(index===4)throw RangeError("metadata reservation refused");return get.call(map,index);};
  expect(f.submit([7])).toBe(0);expect(f.b.shadow.vertexAttribValues).toBe(map);
  expect(f.calls).toEqual([]);expect(f.b.errors).toEqual([0x505]);
});

it("preserves native query errors and retries without admitting a rejected limit",()=>{
  const f=fixture(),old=f.b.shadow.vertexAttribValues;f.errors.push(0x500);f.queryError(0x505);
  expect(f.submit([7])).toBe(0);expect(f.calls).toEqual([]);expect(f.b.shadow.vertexAttribValues).toBe(old);
  expect(f.b.errors).toEqual([0x500,0x505]);expect(f.submit([7])).toBe(0);expect(f.values.get(7)).toEqual(NEXT);
});

it("rejects an unavailable native limit without publishing or guessing capacity",()=>{
  const f=fixture(),old=f.b.shadow.vertexAttribValues;f.limit(0);
  expect(f.submit([2])).toBe(0);expect(f.calls).toEqual([]);expect(f.b.shadow.vertexAttribValues).toBe(old);
  expect(f.b.errors).toEqual([0x502]);f.limit(8);expect(f.submit([2])).toBe(0);expect(f.values.get(2)).toEqual(NEXT);
});
