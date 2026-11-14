import {describe,it,expect} from "vitest";
import {captureValidatedClockCertificate,clockEpochValue,createClockEpochAuthority,
  createFastClockReader,invalidateClockEpoch,refreshClockEpochBusy,retireClockEpoch,
  shareClockEpoch} from "../src/fast-clock-control";

function fixture(prepare?:()=>DataView[]) {
  const owner=createClockEpochAuthority(),binding={pid:1,tid:1,generation:1};
  const bytes=new Uint8Array(16).fill(0x7d);
  invalidateClockEpoch(owner);refreshClockEpochBusy(owner,false);
  const certificate=captureValidatedClockCertificate(owner,clockEpochValue(owner),binding,32,0,0)!;
  let samples=0;
  const read=createFastClockReader({epoch:shareClockEpoch(owner),binding,
    certificate:()=>certificate,sample:()=>({sec:BigInt(++samples),nsec:123n}),
    prepareOutput:prepare??(()=>[new DataView(bytes.buffer)])});
  return {owner,bytes,read,samples:()=>samples};
}
describe("direct clock epoch and output transaction",()=>{
  it("samples current time on every admitted call",()=>{
    const f=fixture();expect(f.read(32,0,0)).toBe(0);expect(f.read(32,0,0)).toBe(0);
    expect(f.samples()).toBe(2);expect(new DataView(f.bytes.buffer).getBigInt64(0,true)).toBe(2n);
    expect(new DataView(f.bytes.buffer).getBigInt64(8,true)).toBe(123n);
  });
  it("refuses stale certificates and retired authorities without output changes",()=>{
    for(const retire of [false,true]) {
      const f=fixture();if(retire)retireClockEpoch(f.owner);else invalidateClockEpoch(f.owner);
      expect(f.read(32,0,0)).toBe(1);expect(f.samples()).toBe(0);expect([...f.bytes]).toEqual(Array(16).fill(0x7d));
    }
  });
  it("rechecks the epoch after effectful output preflight",()=>{
    let f:ReturnType<typeof fixture>;
    f=fixture(()=>{invalidateClockEpoch(f.owner);return[new DataView(f.bytes.buffer)];});
    expect(f.read(32,0,0)).toBe(1);expect(f.samples()).toBe(1);expect([...f.bytes]).toEqual(Array(16).fill(0x7d));
  });
  it("rejects a mismatched output pointer before sampling",()=>{
    const f=fixture();expect(f.read(40,0,0)).toBe(1);expect(f.samples()).toBe(0);
    expect([...f.bytes]).toEqual(Array(16).fill(0x7d));
  });
  it("validates the whole split output before writing any byte",()=>{
    for(const size of [7,8]) {
      const a=new Uint8Array(8).fill(0x7d),b=new Uint8Array(size).fill(0x7d);
      const f=fixture(()=>[new DataView(a.buffer),new DataView(b.buffer)]);
      expect(f.read(32,0,0)).toBe(size===8?0:1);
      if(size===7){expect([...a,...b]).toEqual(Array(15).fill(0x7d));}
      else {expect(new DataView(a.buffer).getBigInt64(0,true)).toBe(1n);expect(new DataView(b.buffer).getBigInt64(0,true)).toBe(123n);}
    }
  });
  it("runs no replaceable iterator after the last epoch check",()=>{
    const f=fixture(),original=Array.prototype[Symbol.iterator];
    let visits=0,result:number|undefined;
    try {
      Array.prototype[Symbol.iterator]=function*(){
        if(++visits>1){invalidateClockEpoch(f.owner);throw Error("post-check iterator");}
        yield* original.call(this);
      };
      result=f.read(32,0,0);
    } finally {Array.prototype[Symbol.iterator]=original;}
    expect(result).toBe(0);expect(visits).toBe(1);
    expect(new DataView(f.bytes.buffer).getBigInt64(0,true)).toBe(1n);
  });
});
