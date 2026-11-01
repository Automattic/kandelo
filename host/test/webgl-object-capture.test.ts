import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";

const OP=0x34, SHADER_LOG=0x08, PROGRAM_LOG=0x0a, SOURCE=0x1a, ATTRIB=0x18, UNIFORM=0x20, ATTACHED=0x19;
function fixture() {
  const registry=new GlContextRegistry();registry.bind({pid:7,sessionId:5,cmdbufAddr:0,cmdbufLen:64});
  const b=registry.get(7,5)!;let text="abc",calls=0,error=0;
  const gl={getParameter:()=>null,deleteShader:()=>{},deleteProgram:()=>{},getError:()=>{const result=error;error=0;return result;},getShaderInfoLog:()=>{calls++;return text;},
    getProgramInfoLog:()=>{calls++;return text;},getProgramParameter:()=>1,
    getActiveAttrib:()=>{calls++;return {name:text,size:2,type:0x1406};},
    getActiveUniform:()=>{calls++;return {name:text,size:3,type:0x8b52};},
  } as unknown as WebGL2RenderingContext;
  b.gl=gl;b.contextId=9;b.shaders.set(2,{} as WebGLShader);b.programs.set(3,{} as WebGLProgram);
  b.shaderSources.set(b.shaders.get(2)!,new TextEncoder().encode(text));b.programShaders.set(3,new Set([2]));
  const query=(words:number[],capacity=16)=>{const input=new Uint8Array(words.length*4),out=new Uint8Array(capacity).fill(0xa5);
    const v=new DataView(input.buffer);words.forEach((n,i)=>v.setUint32(i*4,n,true));const rc=runGlQuery(b,OP,input,out);return {rc,out,v:new DataView(out.buffer)};};
  const begin=(op=SHADER_LOG,limit=0xffffffff,token=1,index=0)=>query([1,token,op,op===SHADER_LOG||op===SOURCE?2:3,index,limit]);
  return {registry,b,gl,query,begin,setText:(s:string)=>{text=s;},calls:()=>calls,setError:(n:number)=>{error=n;}};
}
it("captures one complete large UTF-8 log across bounded chunks without requery",()=>{
  const f=fixture();f.setText("é".repeat(40000));const start=f.begin();expect(start.rc).toBe(16);expect(start.v.getUint32(0,true)).toBe(0);expect(start.v.getUint32(8,true)).toBe(80004);
  f.setText("z".repeat(80000));const a=f.query([2,1,0,65520],65536),b=f.query([2,1,65520,14484],14500);
  expect(a.v.getUint32(0,true)).toBe(0);expect(b.v.getUint32(0,true)).toBe(0);expect(a.v.getUint32(12,true)).toBe(80000);
  const bytes=new Uint8Array(80000);bytes.set(a.out.subarray(16,-4));bytes.set(b.out.subarray(12,-4),65516);
  expect(new TextDecoder().decode(bytes)).toBe("é".repeat(40000));expect(f.calls()).toBe(1);expect(f.query([3,1]).v.getUint32(0,true)).toBe(0);
});
it.each([SHADER_LOG,PROGRAM_LOG,ATTRIB,UNIFORM])("captures original result and metadata for op %i",op=>{
  const f=fixture();const a=f.begin(op,2);expect(a.v.getUint32(0,true)).toBe(0);const total=op===ATTRIB||op===UNIFORM?14:6;
  expect(a.v.getUint32(8,true)).toBe(total);f.setText("xyz");const chunk=f.query([2,1,0,total],total+16);
  expect(chunk.v.getUint32(12,true)).toBe(3);expect(new TextDecoder().decode(chunk.out.subarray(total+10,total+12))).toBe("ab");
  if(total===14){expect(chunk.v.getUint32(16,true)).toBe(op===ATTRIB?2:3);expect(chunk.v.getUint32(20,true)).toBe(op===ATTRIB?0x1406:0x8b52);}
  expect(f.calls()).toBe(1);
});
it("freezes source bytes even after same-length shared object mutation",()=>{
  const f=fixture();expect(f.begin(SOURCE).v.getUint32(0,true)).toBe(0);f.b.shaderSources.get(f.b.shaders.get(2)!)!.fill(120);
  const c=f.query([2,1,0,7],23);expect(new TextDecoder().decode(c.out.subarray(16,-4))).toBe("abc");
});
it("freezes the original attached shader list and supports metadata-only limits",()=>{
  const f=fixture();expect(f.begin(ATTACHED).v.getUint32(8,true)).toBe(8);f.b.programShaders.get(3)!.clear();const c=f.query([2,1,0,8],24);expect(c.v.getUint32(12,true)).toBe(1);expect(c.v.getUint32(16,true)).toBe(2);
  expect(f.begin(PROGRAM_LOG,0,2).v.getUint32(8,true)).toBe(4);expect(f.calls()).toBe(1);
});
it("does not acknowledge a different pending token or replay admission",()=>{
  const f=fixture();f.begin();expect(f.begin().v.getUint32(0,true)).toBe(1);expect(f.calls()).toBe(1);
  for(const token of [2,0xffffffff])expect(f.query([3,token]).v.getUint32(0,true)).toBe(1);
  expect(f.query([2,1,0,7],23).v.getUint32(0,true)).toBe(0);expect(f.query([3,1]).v.getUint32(0,true)).toBe(0);expect(f.query([3,1]).v.getUint32(0,true)).toBe(0);
});
it("rejects invalid names and indices without a native result or captured bytes",()=>{
  const f=fixture();expect(f.begin(ATTRIB,100,1,1).v.getUint32(0,true)).toBe(1);expect(f.calls()).toBe(0);
  f.b.shaders.delete(2);expect(f.begin(SHADER_LOG,100,2).v.getUint32(0,true)).toBe(1);expect(f.calls()).toBe(0);
});
it("requires the original context and clears copied storage on retirement",()=>{
  const f=fixture();f.begin();f.b.contextId=10;expect(f.query([2,1,0,7],23).v.getUint32(0,true)).toBe(1);
  for(const retire of [(r:GlContextRegistry)=>r.destroyContext(7,5),(r:GlContextRegistry)=>r.unbind(7,5),(r:GlContextRegistry)=>r.detachCanvas(7)]){
    const g=fixture();g.begin();expect((g.b as unknown as {objectCapture:unknown}).objectCapture).toBeTruthy();retire(g.registry);expect((g.b as unknown as {objectCapture:unknown}).objectCapture).toBeNull();
  }
});
it("refuses malformed envelopes before capture and never publishes failed native output",()=>{
  const f=fixture();expect(f.query([1,1]).rc).toBe(-22);expect(f.calls()).toBe(0);
  f.gl.getShaderInfoLog=()=>{f.setError(0x502);return "bad";};expect(f.begin().v.getUint32(0,true)).toBe(1);expect(f.query([2,1,0,4],20).v.getUint32(0,true)).toBe(1);
});
it("checks chunk limits and complete reply envelopes without consuming custody",()=>{
  const f=fixture();f.begin();
  for(const [words,capacity] of [[[2,1,0,65521],65537],[[2,1,0,7],22]] as [number[],number][]){const q=f.query(words,capacity);expect(q.rc).toBe(-22);expect(q.out.every(x=>x===0xa5)).toBe(true);}
  for(const offset of [7,0xffffffff])expect(f.query([2,1,offset,1],17).v.getUint32(0,true)).toBe(1);
  expect(f.query([2,1,0,7],23).v.getUint32(0,true)).toBe(0);expect(f.calls()).toBe(1);
});
it("does not install an obsolete result over a reentrant replacement",()=>{
  const f=fixture();let entered=false;
  f.gl.getShaderInfoLog=()=>{if(!entered){entered=true;expect(f.begin(PROGRAM_LOG,3,2).v.getUint32(0,true)).toBe(0);}return "old";};
  expect(f.begin().v.getUint32(0,true)).toBe(1);expect(f.query([3,1]).v.getUint32(0,true)).toBe(1);
  const q=f.query([2,2,0,7],23);expect(q.v.getUint32(0,true)).toBe(0);expect(new TextDecoder().decode(q.out.subarray(16,-4))).toBe("abc");
});
it("enforces copied-storage budget, while allowing a small caller prefix",()=>{
  const f=fixture();f.b.shaderSources.set(f.b.shaders.get(2)!,new Uint8Array(64*1024*1024));
  expect(f.begin(SOURCE).v.getUint32(0,true)).toBe(1);expect(f.b.errors).toContain(0x505);
  expect(f.begin(SOURCE,4,2).v.getUint32(8,true)).toBe(8);
  expect(f.query([2,2,0,8],24).v.getUint32(12,true)).toBe(64*1024*1024);
});
