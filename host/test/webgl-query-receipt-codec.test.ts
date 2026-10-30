import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ERRNO } from "../src/generated/abi.js";
import { GL_QUERY_NEEDS_OWNED_ADMISSION, KERNEL_GL_QUERY_CONTROL } from "../src/webgl/ops.js";
import { decodeQueryReply, decodeQueryRequest, encodeQueryReply, encodeQueryRequest,
  type ExpectedQueryReply, type QueryControl, type QueryReceiptRequest } from "../src/webgl/query-receipt-codec.js";
const control = new Map<number,QueryControl>([[1,"begin"],[2,"poll"],[3,"commit"],[4,"cancel"],[6,"forget"]]);
const begin = (): QueryReceiptRequest => ({control:"begin",token:1n,
  begin:{op:49,capacity:4,hasCurrent:true,context:7,draw:0,read:0,input:Uint8Array.of(1,2)}});
function patch(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const result = bytes.slice(), v = new DataView(result.buffer);
  if (offset === 4 || offset === 6) v.setUint16(offset,value,true); else v.setUint32(offset,value,true);
  return result;
}
const e: ExpectedQueryReply = {control:"poll",token:0x20_0000_0000_0001n,capacity:4};
describe("unwired owned-query receipt codec", () => {
  it("shares exact Rust wire vectors, including tokens above Number precision", () => {
    const source = readFileSync(new URL("../../tests/graphics/gl-query-receipt-wire-v1.tsv",import.meta.url),"utf8");
    expect(source).toContain(`# reservation\t${KERNEL_GL_QUERY_CONTROL}\t${GL_QUERY_NEEDS_OWNED_ADMISSION}`);
    const vectors = source.split("\n").filter(line => line && !line.startsWith("#"));
    expect(vectors).toHaveLength(14);
    for (const line of vectors) {
      const [name,kind,tag,token,capacity,mode,hex] = line.split("\t");
      const bytes = Uint8Array.from(Buffer.from(hex,"hex"));
      if (kind === "request") {
        const decoded = decodeQueryRequest(bytes);
        expect(decoded.control).toBe(control.get(Number(tag))); expect(decoded.token).toBe(BigInt(token));
        if (name === "begin-current") expect(decoded.begin).toEqual({op:49,capacity:4,hasCurrent:true,context:7,draw:8,read:9,input:Uint8Array.of(0xde,0xad)});
        expect(encodeQueryRequest(decoded)).toEqual(bytes);
      } else {
        const expected: ExpectedQueryReply = {control:control.get(Number(tag))!,token:BigInt(token),capacity:Number(capacity),
          ...(mode === "0" ? {} : {retirementMode:mode === "1" ? "commit" as const : "cancel" as const})};
        const decoded = decodeQueryReply(bytes,expected);
        if (name === "ready") expect(decoded).toEqual({phase:"ready",result:3,bytes:Uint8Array.of(97,98,99)});
        expect(encodeQueryReply(decoded,expected)).toEqual(bytes);
      }
    }
  });
  it("rejects malformed header, lengths, flags, identities and unimplemented Detach", () => {
    const original = encodeQueryRequest(begin());
    for (const [offset,value] of [[0,0],[4,2],[6,5],[6,99],[8,0],[12,0x8000_0000],
      [16,KERNEL_GL_QUERY_CONTROL],[20,3],[24,65537],[28,4],[28,2],[28,1],[32,0],[44,1]]) {
      expect(() => decodeQueryRequest(patch(original,offset,value)),`${offset}:${value}`).toThrow();
    }
    for (let len=0;len<48;len++) expect(() => decodeQueryRequest(original.slice(0,len))).toThrow();
    expect(() => decodeQueryRequest(Uint8Array.from([...original,0]))).toThrow();
    const poll=encodeQueryRequest({control:"poll",token:1n}); expect(() => decodeQueryRequest(patch(poll,16,1))).toThrow();
    for (const token of [0n,1n<<63n,0xffff_ffff_ffff_ffffn,9007199254740992 as unknown as bigint]) {
      expect(() => encodeQueryRequest({...begin(),token})).toThrow();
    }
    for (const value of [-1,1.5,Number.NaN,Number.POSITIVE_INFINITY,0x1_0000_0000]) {
      expect(() => encodeQueryRequest({...begin(),begin:{...begin().begin!,op:value}})).toThrow();
    }
    expect(() => encodeQueryRequest({...begin(),begin:{...begin().begin!,input:new Uint8Array(65537)}})).toThrow();
  });
  it("requires bounded exact results and expected token; the preentry sentinel is never a result", () => {
    const original=encodeQueryReply({phase:"ready",result:3,bytes:Uint8Array.of(1,2,3)},e);
    for (const [offset,value] of [[0,0],[4,2],[6,5],[6,99],[8,2],[12,0x8000_0000],
      [16,2],[16,5],[16,0x8000_0000],[20,2],[24,1],[28,1]]) {
      expect(() => decodeQueryReply(patch(original,offset,value),e),`${offset}:${value}`).toThrow();
    }
    for (let len=0;len<32;len++) expect(() => decodeQueryReply(original.slice(0,len),e)).toThrow();
    expect(() => decodeQueryReply(original,{...e,capacity:2})).toThrow();
    for (const result of [GL_QUERY_NEEDS_OWNED_ADMISSION,-999,1.5,Number.NaN]) {
      expect(() => encodeQueryReply({phase:"ready",result,bytes:new Uint8Array()},e)).toThrow();
    }
    expect(decodeQueryReply(encodeQueryReply({phase:"ready",result:-ERRNO.EIO,bytes:new Uint8Array()},e),e))
      .toEqual({phase:"ready",result:-ERRNO.EIO,bytes:new Uint8Array()});
  });
  it("rejects late or wrong-mode ACKs and requires positive cancellation acceptance", () => {
    const cancel: ExpectedQueryReply={...e,control:"cancel",retirementMode:"cancel"};
    const ack={phase:"retired" as const,mode:"cancel" as const,accepted:true};
    const bytes=encodeQueryReply(ack,cancel); expect(decodeQueryReply(bytes,cancel)).toEqual(ack);
    for (const context of [{...cancel,token:e.token+1n},{...e,control:"begin" as const},
      {...e,control:"commit" as const,retirementMode:"commit" as const}]) expect(() => decodeQueryReply(bytes,context)).toThrow();
    for (const flags of [0,1,2,3,7,8]) expect(() => decodeQueryReply(patch(bytes,24,flags),cancel)).toThrow();
    expect(() => decodeQueryReply(encodeQueryReply({phase:"pending"},e),cancel)).toThrow();
    const rejected=encodeQueryReply({phase:"rejected",error:ERRNO.ENOMEM},{...e,control:"begin"});
    expect(() => decodeQueryReply(rejected,cancel)).toThrow();
    const retiring=encodeQueryReply({phase:"retiring",mode:"cancel"},cancel);
    expect(() => decodeQueryReply(retiring,{...cancel,control:"forget"})).toThrow();
    const failed={phase:"retired" as const,mode:"commit" as const,accepted:false};
    const commit:ExpectedQueryReply={...e,control:"commit",retirementMode:"commit"};
    expect(decodeQueryReply(encodeQueryReply(failed,commit),commit)).toEqual(failed);
  });
  it("copies decoded payloads and permits exactly64KiB plus envelope", () => {
    const r=begin(); r.begin!.input=new Uint8Array(65536).fill(9);r.begin!.capacity=65536;
    const encoded=encodeQueryRequest(r), captured=decodeQueryRequest(encoded); encoded[48]=0;
    expect(captured.begin!.input[0]).toBe(9); expect(encoded.byteLength).toBe(48+65536);
    const context={...e,token:0x7fff_ffff_ffff_ffffn,capacity:65536};
    const reply={phase:"ready" as const,result:65536,bytes:new Uint8Array(65536).fill(8)};
    const bytes=encodeQueryReply(reply,context), decoded=decodeQueryReply(bytes,context);bytes[32]=0;
    expect(decoded).toEqual(reply);expect(bytes.byteLength).toBe(32+65536);
    expect(() => encodeQueryReply({...reply,result:65537,bytes:new Uint8Array(65537)},context)).toThrow();
  });
});
