import { describe, expect, it } from "vitest";

import {
  detectPtrWidth,
  describeWasmArtifactPolicyFailures,
  readWasmImportNames,
  wasmImportsKernelFork,
} from "../src/constants";

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

/**
 * A structurally parseable module whose function type follows a recursive GC
 * group. The fork artifact is intentionally incomplete: this fixture proves
 * the policy reader reports the missing ABI contract instead of losing type
 * indices or treating the struct/array definitions as malformed functions.
 */
function gcForkImportFixture(): ArrayBuffer {
  const typeSection = [
    ...uleb(1), // one explicit recursive group
    0x4e,
    ...uleb(3),
    // type 0: (struct (field (mut (ref null 0))))
    0x5f, ...uleb(1), 0x63, 0x00, 0x01,
    // type 1: (array (mut i32))
    0x5e, 0x7f, 0x01,
    // type 2: (func (param (ref null 0)) (result i32))
    0x60, ...uleb(1), 0x63, 0x00, ...uleb(1), 0x7f,
  ];
  const imports = [
    ...uleb(4),
    ...name("kernel"), ...name("kernel_fork"), 0x00, ...uleb(2),
    ...name("env"), ...name("gc_table"), 0x01,
    0x63, 0x00, // concrete nullable table reference
    0x00, ...uleb(1), // limits
    ...name("env"), ...name("gc_global"), 0x03,
    0x63, 0x00, // concrete nullable global reference
    0x01, // mutable
    ...name("env"), ...name("memory"), 0x02,
    0x04, ...uleb(1), // memory64 limits
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, typeSection),
    ...section(2, imports),
  ]).buffer;
}

describe("fork artifact parsing with recursive GC types", () => {
  it("keeps function type indices aligned across struct and array types", () => {
    const wasm = gcForkImportFixture();

    expect(readWasmImportNames(wasm)).toEqual([
      "kernel.kernel_fork",
      "env.gc_table",
      "env.gc_global",
      "env.memory",
    ]);
    expect(wasmImportsKernelFork(wasm)).toBe(true);
    expect(detectPtrWidth(wasm)).toBe(8);

    const failures = describeWasmArtifactPolicyFailures(wasm);
    expect(failures.join("\n")).not.toContain("cannot validate");
    expect(failures.join("\n")).not.toContain("non-function type");
    expect(failures).toContain(
      "missing required kandelo.wpk_fork.capabilities capability",
    );
  });
});
