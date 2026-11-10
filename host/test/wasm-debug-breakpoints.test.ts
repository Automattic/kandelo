import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { WasmDebugInfo } from "../src/wasm-debug-info";

function leb(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function section(id: number, payload: number[]): number[] { return [id, ...leb(payload.length), ...payload]; }
function fixture(files = ["/crate-a/src/main.rs", "/crate-b/src/main.rs"], withMap = true) {
  // Two real function bodies. Their one nop each gives an independently
  // known instruction offset; the length/count/local headers aren't code.
  const prefix = [0,97,115,109,1,0,0,0, ...section(1, [1,96,0,0]), ...section(3, [2,0,0])];
  const payload = [2,3,0,1,11,3,0,1,11];
  const start = prefix.length + 2;
  const pcs = [start + 3, start + 7];
  const code = new Uint8Array([...prefix, ...section(10, payload)]);
  if (!withMap) return { bytes: code.buffer, pcs, start, end: code.length };
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const vlq = (value: number) => {
    let encoded = "", remaining = Math.abs(value) * 2 + (value < 0 ? 1 : 0);
    do { const digit = remaining % 32; remaining = Math.floor(remaining / 32); encoded += alphabet[digit | (remaining ? 32 : 0)]; } while (remaining);
    return encoded;
  };
  const mappings = [[pcs[0],0,3,0],[pcs[0]+1],[pcs[1],1,3,1],[pcs[1]+1]];
  const last = [0,0,0,0];
  const encoded = mappings.map(fields => fields.map((value, index) => {
    const delta = value - last[index]; last[index] = value; return vlq(delta);
  }).join("")).join(",");
  const json = new TextEncoder().encode(JSON.stringify({ version: 3, sources: files, names: [], mappings: encoded }));
  const header = new Uint8Array(48);
  header.set([75,68,66,71,1,0,0,0]);
  new DataView(header.buffer).setBigUint64(8, BigInt(start), true);
  header.set(sha256(code.subarray(start)), 16);
  const name = new TextEncoder().encode("kandelo.debug.lines");
  return { bytes: new Uint8Array([...code, ...section(0, [...leb(name.length), ...name, ...header, ...json])]).buffer, pcs, start, end: code.length };
}

describe("source breakpoint authority", () => {
  it("requires an unambiguous file and a real mapped instruction", () => {
    const { bytes, pcs } = fixture();
    expect(WebAssembly.validate(bytes)).toBe(true);
    const info = new WasmDebugInfo(bytes);
    expect(() => info.breakpoints("main.rs", 4)).toThrow(/ambiguous/);
    expect(info.breakpoints("crate-a/src/main.rs", 4)).toEqual([{ pc: pcs[0], file: "/crate-a/src/main.rs", line: 4, column: 1 }]);
    expect(info.breakpoints("/crate-b/src/main.rs", 4, 2)).toEqual([{ pc: pcs[1], file: "/crate-b/src/main.rs", line: 4, column: 2 }]);
    expect(info.breakpoints("/crate-b/src/main.rs", 4, 1)).toEqual([]);
    expect(info.breakpoints("/missing/main.rs", 4)).toEqual([]);
    expect(info.breakpoints("/crate-a/src/main.rs", 5)).toEqual([]);
  });
  it("resolves program counters inside their actual function only", () => {
    const { bytes, pcs, start, end } = fixture();
    const info = new WasmDebugInfo(bytes);
    expect(info.resolvePc(pcs[0])).toMatchObject({ index: 0, location: { file: "/crate-a/src/main.rs", line: 4 } });
    expect(info.resolvePc(pcs[1])).toMatchObject({ index: 1, location: { file: "/crate-b/src/main.rs", line: 4 } });
    expect(info.resolvePc(pcs[0] + 1)?.location).toBeUndefined();
    for (const pc of [-1, NaN, Infinity, start, end, end + 1]) expect(info.resolvePc(pc)).toBeUndefined();
  });
  it("combines repeated source names without inventing a second file", () => {
    const { bytes, pcs } = fixture(["/src/main.rs", "/src/main.rs"]);
    expect(new WasmDebugInfo(bytes).breakpoints("main.rs", 4).map(value => value.pc)).toEqual(pcs);
  });
  it("reports missing maps honestly and rejects invalid queries", () => {
    const { bytes } = fixture(undefined, false);
    const info = new WasmDebugInfo(bytes);
    expect(info.breakpoints("main.rs", 4)).toEqual([]);
    for (const line of [0,-1,NaN,Infinity,1.1,2**32]) expect(() => info.breakpoints("main.rs", line)).toThrow(/line/);
    expect(() => info.breakpoints("", 4)).toThrow(/filename/);
    expect(() => info.breakpoints("main.rs\0", 4)).toThrow(/filename/);
    expect(() => info.breakpoints("main.rs", 4, 0)).toThrow(/column/);
  });
});
