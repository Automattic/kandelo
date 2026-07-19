import { describe, expect, it } from "vitest";
import { buildDlopenImports } from "../src/worker-main";

type WasmPointer = number | bigint;

type DlopenImport = (
  bytesPtr: WasmPointer,
  bytesLen: number,
  namePtr: WasmPointer,
  nameLen: number,
) => number;

type DlsymImport = (
  handle: number,
  namePtr: WasmPointer,
  nameLen: number,
) => number;

type DlerrorImport = (bufPtr: WasmPointer, bufMax: number) => number;

function createImports(ptrWidth: 4 | 8): {
  memory: WebAssembly.Memory;
  pointer: (value: number) => WasmPointer;
  dlopen: DlopenImport;
  dlsym: DlsymImport;
  dlerror: DlerrorImport;
} {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  const stackPointer = new WebAssembly.Global(
    { value: ptrWidth === 8 ? "i64" : "i32", mutable: true },
    ptrWidth === 8 ? 32_768n : 32_768,
  );
  const support = buildDlopenImports(
    memory,
    4_096,
    128,
    () => table,
    () => stackPointer,
    () => undefined,
    ptrWidth,
    undefined,
    undefined,
    false,
  );
  const pointer = (value: number): WasmPointer => ptrWidth === 8 ? BigInt(value) : value;

  return {
    memory,
    pointer,
    dlopen: support.imports.__wasm_dlopen as DlopenImport,
    dlsym: support.imports.__wasm_dlsym as DlsymImport,
    dlerror: support.imports.__wasm_dlerror as DlerrorImport,
  };
}

describe("dlopen host import pointer widths", () => {
  it.each([4, 8] as const)(
    "reads memory%d pointers without changing int handles, lengths, or results",
    (ptrWidth) => {
      const { memory, pointer, dlopen, dlsym, dlerror } = createImports(ptrWidth);
      const bytes = new Uint8Array(memory.buffer);
      const invalidModule = new Uint8Array([0, 1, 2, 3]);
      const libraryName = new TextEncoder().encode("libinvalid.so");
      const symbolName = new TextEncoder().encode("missing_symbol");
      const moduleOffset = 256;
      const libraryNameOffset = 512;
      const symbolNameOffset = 768;
      const errorOffset = 1_024;
      bytes.set(invalidModule, moduleOffset);
      bytes.set(libraryName, libraryNameOffset);
      bytes.set(symbolName, symbolNameOffset);

      // Pointer arguments follow the memory width, but dlopen.c declares all
      // lengths, handles, and results as int for both targets.
      expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
      expect(dlopen(
        pointer(moduleOffset),
        invalidModule.length,
        pointer(libraryNameOffset),
        libraryName.length,
      )).toBe(0);
      expect(dlsym(0, pointer(symbolNameOffset), symbolName.length)).toBe(0);

      const errorLength = dlerror(pointer(errorOffset), 128);
      expect(errorLength).toBeGreaterThan(0);
      expect(new TextDecoder().decode(bytes.subarray(errorOffset, errorOffset + errorLength)))
        .toBe("symbol not found: missing_symbol");
    },
  );

  it("rejects a memory64 pointer that JavaScript cannot represent exactly", () => {
    const { pointer, dlopen } = createImports(8);
    const unsafePointer = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    expect(() => dlopen(unsafePointer, 1, pointer(0), 0))
      .toThrow("__wasm_dlopen bytes: pointer exceeds JavaScript's exact address range");
    // The checked failure must still release the process-wide dlopen lock.
    expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
  });

  it("rejects a memory32 range that crosses the end of linear memory", () => {
    const { memory, pointer, dlopen } = createImports(4);

    expect(() => dlopen(pointer(memory.buffer.byteLength - 1), 2, pointer(0), 0))
      .toThrow(/__wasm_dlopen bytes: memory range .* exceeds 65536 bytes/);
    expect(dlopen(pointer(0), 0, pointer(0), 0)).toBe(1);
  });
});
