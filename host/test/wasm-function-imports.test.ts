import { describe, expect, it } from "vitest";
import {
  describeWasmForkArtifactContractFailures,
  readWasmFunctionArity,
  readWasmFunctionImports,
} from "../src/constants";

function uleb(value: number): number[] {
  const result: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    result.push(byte);
  } while (value !== 0);
  return result;
}

function name(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, bytes: number[]): number[] {
  return [id, ...uleb(bytes.length), ...bytes];
}

function moduleBytes(...sections: number[][]): ArrayBuffer {
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sections.flat(),
  ]).buffer;
}

const types = section(1, [
  2,
  0x60, 1, 0x7f, 1, 0x7e,
  0x60, 0, 0,
]);
const imports = section(2, [
  3,
  ...name("host"), ...name("same"), 0, 0,
  ...name("env"), ...name("global"), 3, 0x7f, 1,
  ...name("host"), ...name("same"), 0, 1,
]);
const functions = section(3, [1, 1]);
const exportedFunction = (index: number) =>
  section(7, [1, ...name("exported"), 0, ...uleb(index)]);

describe("function-import metadata", () => {
  it("retains duplicate import signatures and both index spaces", () => {
    const result = readWasmFunctionImports(
      moduleBytes(types, imports, functions, exportedFunction(2)),
    );
    expect(result.map((entry) => ({
      module: entry.module,
      name: entry.name,
      importOrdinal: entry.importOrdinal,
      functionIndex: entry.functionIndex,
      params: entry.signature.params,
      results: entry.signature.results,
    }))).toEqual([
      {
        module: "host", name: "same", importOrdinal: 0, functionIndex: 0,
        params: [0x7f], results: [0x7e],
      },
      {
        module: "host", name: "same", importOrdinal: 2, functionIndex: 1,
        params: [], results: [],
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    for (const entry of result) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.signature)).toBe(true);
      for (const value of [
        entry.signature.params, entry.signature.results,
        entry.signature.paramTypes, entry.signature.resultTypes,
        ...entry.signature.paramTypes, ...entry.signature.resultTypes,
      ]) expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("validates an unused exported function's signature", () => {
    expect(() => readWasmFunctionImports(
      moduleBytes(types, imports, functions, exportedFunction(99)),
    )).toThrow("function exported refers to an unknown type");
  });

  it("validates exports even when there are no function imports", () => {
    expect(() => readWasmFunctionImports(
      moduleBytes(types, exportedFunction(0)),
    )).toThrow("function exported refers to an unknown type");
  });

  it("finishes structural parsing before resolving pending export signatures", () => {
    // The earlier bad export must not mask the later malformed section.
    expect(() => readWasmFunctionImports(
      moduleBytes(types, imports, exportedFunction(99), section(3, [2, 1])),
    )).toThrow("malformed wasm section 3");
  });

  it("keeps pending resolution independent of section order", () => {
    expect(readWasmFunctionImports(
      moduleBytes(types, imports, exportedFunction(2), functions),
    )).toHaveLength(2);
  });

  it("preserves concrete heap types and nullability in recursive groups", () => {
    const recursiveTypes = section(1, [
      1, 0x4e, 2,
      0x5f, 0,
      0x60, 2, 0x63, 0, 0x64, 0, 1, 0x63, 0,
    ]);
    const typedImport = section(2, [
      1, ...name("host"), ...name("typed"), 0, 1,
    ]);
    const [entry] = readWasmFunctionImports(
      moduleBytes(recursiveTypes, typedImport),
    );
    expect(entry!.signature.paramTypes).toEqual([
      { code: 0x63, heapType: 0, shared: false },
      { code: 0x64, heapType: 0, shared: false },
    ]);
    expect(entry!.signature.resultTypes).toEqual([
      { code: 0x63, heapType: 0, shared: false },
    ]);
  });

  it("does not reuse signatures when a caller changes its byte buffer", () => {
    const bytes = moduleBytes(types, imports);
    const first = readWasmFunctionImports(bytes);
    // The first declared result changes from i64 to f64, at fixed length.
    const view = new Uint8Array(bytes);
    expect(view[15]).toBe(0x7e);
    view[15] = 0x7c;
    const second = readWasmFunctionImports(bytes);
    expect(first[0]!.signature.results).toEqual([0x7e]);
    expect(second[0]!.signature.results).toEqual([0x7c]);
  });

  it("leaves full-facts consumers' function and contract validation intact", () => {
    const valid = moduleBytes(types, imports, functions, exportedFunction(2));
    expect(readWasmFunctionArity(valid, 0)).toEqual({ parameters: 1, results: 1 });
    expect(readWasmFunctionArity(valid, 2)).toEqual({ parameters: 0, results: 0 });
    const invalid = moduleBytes(types, imports, exportedFunction(99));
    expect(describeWasmForkArtifactContractFailures(invalid)).toEqual([
      "cannot validate ABI 43 fork-artifact contract: function exported refers to an unknown type",
    ]);
  });
});
