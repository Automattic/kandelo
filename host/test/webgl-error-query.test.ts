import { expect, it } from "vitest";
it("snapshots the old queue without consumption until Commit and preserves later distinct errors",async()=>{
  const {prepareGlErrorQuery}=await import("../src/webgl/error-query.js");
  const owner={errors:[0x501]}, result=prepareGlErrorQuery(owner,new Uint8Array())!;
  expect(result.value).toBe(0x501);expect(owner.errors).toEqual([0x501]);owner.errors.push(0x500);
  expect(result.publish()).toBe(true);expect(result.publish()).toBe(true);expect(owner.errors).toEqual([0x500]);
});
it("cancellation and empty snapshot leave actual queued flags pending",async()=>{
  const {prepareGlErrorQuery}=await import("../src/webgl/error-query.js");
  const owner={errors:[0x501]}, result=prepareGlErrorQuery(owner,new Uint8Array())!;
  result.cancel();expect(result.publish()).toBe(false);expect(owner.errors).toEqual([0x501]);
  const empty={errors:[] as number[]}, zero=prepareGlErrorQuery(empty,new Uint8Array())!;empty.errors.push(0x502);
  expect(zero.value).toBe(0);expect(zero.publish()).toBe(true);expect(empty.errors).toEqual([0x502]);
});

it("deduplicates masked fallback flags, preserves cancellation and rejects unsupported flags",async()=>{
  const {prepareGlErrorQuery}=await import("../src/webgl/error-query.js");
  const owner={errors:[0x501]}, bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,6,true);
  const prepared=prepareGlErrorQuery(owner,bytes)!;expect(prepared.value).toBe(0x501);expect(owner.errors).toEqual([0x501,0x502]);
  prepared.cancel();expect(owner.errors).toEqual([0x501,0x502]);
  new DataView(bytes.buffer).setUint32(0,8,true);expect(prepareGlErrorQuery(owner,bytes)).toBeNull();expect(owner.errors).toEqual([0x501,0x502]);
});
it("refuses stale error-head authority without consuming a different pending flag",async()=>{
  const {prepareGlErrorQuery}=await import("../src/webgl/error-query.js");const owner={errors:[0x501,0x500]}, candidate=prepareGlErrorQuery(owner,new Uint8Array())!;
  owner.errors.shift();expect(candidate.publish()).toBe(false);expect(candidate.publish()).toBe(false);expect(owner.errors).toEqual([0x500]);
});
