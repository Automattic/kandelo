import { describe, expect, it } from "vitest";
import { patchWasmForThread } from "../src/worker-main";

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function name(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...uleb(bytes.byteLength), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function body(instructions: number[], locals: number[] = []): number[] {
  const payload = [
    ...uleb(locals.length === 0 ? 0 : 1),
    ...(locals.length === 0 ? [] : [...uleb(1), ...locals]),
    ...instructions,
    0x0b,
  ];
  return [...uleb(payload.length), ...payload];
}

/**
 * Current core-GC encoding, built directly because the repository's WABT
 * release still emits an older experimental GC binary format.
 */
function gcThreadStartFixture(): ArrayBuffer {
  const types = [
    ...uleb(1), // one recursive group
    0x4e,
    ...uleb(4),
    // type 0: (struct (field (mut (ref null 0))))
    0x5f, ...uleb(1), 0x63, 0x00, 0x01,
    // type 1: (array (mut i32))
    0x5e, 0x7f, 0x01,
    // type 2: (func)
    0x60, 0x00, 0x00,
    // type 3: (func (param i32)), valid exception-tag type
    0x60, 0x01, 0x7f, 0x00,
  ];
  const imports = [
    ...uleb(4),
    ...name("env"), ...name("imported_function"), 0x00, ...uleb(2),
    ...name("env"), ...name("gc_table"), 0x01,
    0x63, 0x00, // concrete nullable reference
    0x00, ...uleb(1), // limits: min 1
    ...name("env"), ...name("gc_global"), 0x03,
    0x63, 0x00, // concrete nullable reference
    0x01, // mutable
    ...name("env"), ...name("event"), 0x04,
    0x00, ...uleb(3), // tag attribute + function type
  ];
  const functions = [
    ...uleb(4),
    ...uleb(2), // ctor
    ...uleb(2), // __abi_version
    ...uleb(2), // __get_channel_base_addr
    ...uleb(2), // _start
  ];
  const exports = [
    ...uleb(3),
    ...name("__abi_version"), 0x00, ...uleb(2),
    ...name("__get_channel_base_addr"), 0x00, ...uleb(3),
    ...name("_start"), 0x00, ...uleb(4),
  ];
  const code = [
    ...uleb(4),
    ...body([]),
    ...body([0x10, ...uleb(1)], [0x63, 0x00]),
    ...body([0x10, ...uleb(1)], [0x63, 0x00]),
    ...body([0x10, ...uleb(1)], [0x63, 0x00]),
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, functions),
    ...section(7, exports),
    ...section(8, uleb(1)),
    ...section(10, code),
  ]).buffer;
}

describe("patchWasmForThread GC/reference parsing", () => {
  it("keeps section and function indexes aligned across concrete ref and tag imports", () => {
    const source = gcThreadStartFixture();
    expect(WebAssembly.validate(source)).toBe(true);
    const patched = patchWasmForThread(source);
    expect(WebAssembly.validate(patched)).toBe(true);
    expect(patched.byteLength).toBeLessThan(source.byteLength);
  });
});
