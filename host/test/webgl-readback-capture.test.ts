import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";

const OP = 0x33, MAGIC = 0x47514c33;
function fixture() {
  const registry = new GlContextRegistry();
  registry.bind({pid:7,sessionId:5,cmdbufAddr:0,cmdbufLen:64});
  const b=registry.get(7,5)!;
  let reads=0, value=41, error=0;
  const gl={getError:()=>{const result=error;error=0;return result;},
    readPixels:(_x:number,_y:number,_w:number,_h:number,_format:number,_type:number,out:Uint8Array)=>{reads++;out.fill(value);},
  } as unknown as WebGL2RenderingContext;
  b.gl=gl;b.contextId=9;
  const query=(words:number[],capacity=16)=>{
    const input=new Uint8Array(words.length*4),out=new Uint8Array(capacity).fill(0xa5);
    const v=new DataView(input.buffer);words.forEach((word,i)=>v.setUint32(i*4,word,true));
    const rc=runGlQuery(b,OP,input,out);return {rc,out,v:new DataView(out.buffer)};
  };
  const begin=(token=1)=>query([1,token,132612,0,0,257,129,0x1908,0x1401]);
  return {b,registry,query,begin,reads:()=>reads,setValue:(next:number)=>{value=next;},failRead:()=>{gl.readPixels=()=>{reads++;error=0x506;};}};
}
it("captures once and returns immutable chunks after later rendering",()=>{
  const f=fixture(),first=f.begin();
  expect(first.rc).toBe(16);expect([...new Uint32Array(first.out.buffer)]).toEqual([0,1,132612,MAGIC]);
  f.setValue(99);
  const chunks=[f.query([2,1,0,65520],65536),f.query([2,1,65520,65520],65536),f.query([2,1,131040,1572],1588)];
  for(const chunk of chunks){expect(chunk.v.getUint32(0,true)).toBe(0);expect([...chunk.out.subarray(12,-4)]).toEqual(Array(chunk.out.length-16).fill(41));}
  expect(f.reads()).toBe(1);expect(f.query([3,1]).v.getUint32(0,true)).toBe(0);
  expect(f.query([2,1,0,4],20).v.getUint32(0,true)).toBe(1);expect(f.reads()).toBe(1);
});
it("refuses replayed admission and stale cancellation without losing a replacement",()=>{
  const f=fixture();f.begin();expect(f.begin().v.getUint32(0,true)).toBe(1);expect(f.reads()).toBe(1);
  expect(f.begin(2).v.getUint32(0,true)).toBe(0);expect(f.query([3,1]).v.getUint32(0,true)).toBe(1);
  expect(f.query([2,2,0,4],20).v.getUint32(0,true)).toBe(0);expect(f.reads()).toBe(2);
  expect(f.query([3,2]).v.getUint32(0,true)).toBe(0);expect(f.query([3,2]).v.getUint32(0,true)).toBe(0);
});
it("does not publish captured bytes after a native framebuffer error",()=>{
  const f=fixture();f.failRead();expect(f.begin().v.getUint32(0,true)).toBe(1);
  const chunk=f.query([2,1,0,4],20);expect(chunk.v.getUint32(0,true)).toBe(1);expect([...chunk.out.subarray(4,-4)]).toEqual(Array(12).fill(0));
  expect(f.b.errors).toContain(0x506);expect(f.reads()).toBe(1);
});
it("rejects incomplete, oversized or contradictory requests before native capture",()=>{
  const f=fixture();
  for(const words of [[1,1,132611,0,0,257,129,0x1908,0x1401],[1,2,4,0,0,-1,1,0x1908,0x1401],[1,3,0xffffffff,0,0,0x7fffffff,0x7fffffff,0x1908,0x1406]]) {
    expect(f.query(words).v.getUint32(0,true)).toBe(1);
  }
  const malformed=f.query([1,4],16);expect(malformed.rc).toBe(-22);expect([...malformed.out]).toEqual(Array(16).fill(0xa5));expect(f.reads()).toBe(0);
});
it("binds copied bytes to the original context and rejects cross-context reads",()=>{
  const f=fixture();f.begin();f.b.contextId=10;
  expect(f.query([2,1,0,4],20).v.getUint32(0,true)).toBe(1);expect(f.reads()).toBe(1);
});
it("refuses a truncated chunk output before consuming captured bytes",()=>{
  const f=fixture();f.begin();const short=f.query([2,1,0,4],19);
  expect(short.rc).toBe(-22);expect([...short.out]).toEqual(Array(19).fill(0xa5));
  expect(f.query([2,1,0,4],20).v.getUint32(0,true)).toBe(0);expect(f.reads()).toBe(1);
});

it("releases copied storage at public context retirement and canvas detachment",()=>{
  for (const retire of [({registry}:ReturnType<typeof fixture>)=>registry.destroyContext(7,5),
      ({registry}:ReturnType<typeof fixture>)=>registry.unbind(7,5),
      ({registry}:ReturnType<typeof fixture>)=>registry.detachCanvas(7)]) {
    const f=fixture();f.begin();expect(f.b.readbackCapture).not.toBeNull();retire(f);expect(f.b.readbackCapture).toBeNull();
  }
});
it("enforces copied-storage budget without native access or a replayable token",()=>{
  const f=fixture();
  const result=f.query([1,1,67108868,0,0,16777217,1,0x1908,0x1401]);
  expect(result.v.getUint32(0,true)).toBe(1);expect(f.b.errors).toContain(0x505);expect(f.reads()).toBe(0);
  expect(f.begin().v.getUint32(0,true)).toBe(1);expect(f.reads()).toBe(0);
});
it("rejects a bad chunk range while retaining the exact captured image",()=>{
  const f=fixture();f.begin();
  for(const [offset,count] of [[132611,2],[0xffffffff,4]]) expect(f.query([2,1,offset,count],count+16).v.getUint32(0,true)).toBe(1);
  expect(f.query([2,1,132611,1],17).out[12]).toBe(41);expect(f.reads()).toBe(1);
});
it("preserves pack padding geometry across odd-byte chunk boundaries",()=>{
  const f=fixture();f.b.shadow.packAlignment=8;
  const begin=f.query([1,1,100099,0,0,257,129,0x1907,0x1401]);
  expect(begin.v.getUint32(0,true)).toBe(0);expect(f.query([2,1,65519,3],19).out.subarray(12,15)).toEqual(new Uint8Array([41,41,41]));expect(f.reads()).toBe(1);
});
it("contains native exceptions without publishing a partial capture",()=>{
  const f=fixture();f.b.gl!.readPixels=()=>{throw new Error("native failure");};
  expect(f.begin().v.getUint32(0,true)).toBe(1);expect(f.b.readbackCapture).toBeNull();expect(f.b.errors).toContain(0x502);
});

it("does not relabel a captured image if context replacement occurs during native read",()=>{
  const f=fixture();f.b.gl!.readPixels=(_x,_y,_w,_h,_format,_type,out)=>{
    (out as Uint8Array).fill(73);f.b.contextId=10;
  };
  expect(f.begin().v.getUint32(0,true)).toBe(1);expect(f.b.readbackCapture).toBeNull();
});

it("rejects future-token release without acknowledging or retiring another capture",()=>{
  const f=fixture();f.begin();
  expect(f.query([3,2]).v.getUint32(0,true)).toBe(1);
  expect(f.b.readbackCaptureSerial).toBe(1);
  expect(f.query([2,1,0,4],20).v.getUint32(0,true)).toBe(0);expect(f.reads()).toBe(1);
});
