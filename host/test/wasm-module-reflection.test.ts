import { describe, expect, it, vi } from "vitest";

import {
  registerWasmModuleReflection,
  wasmModuleExports,
  wasmModuleGlobalExportMutability,
  wasmModuleImports,
} from "../src/wasm-module-reflection";

const fixture = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
  // type: () -> ()
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  // import env.callback as function type 0
  0x02, 0x10, 0x01,
  0x03, 0x65, 0x6e, 0x76,
  0x08, 0x63, 0x61, 0x6c, 0x6c, 0x62, 0x61, 0x63, 0x6b,
  0x00, 0x00,
  // export the imported function as callback
  0x07, 0x0c, 0x01,
  0x08, 0x63, 0x61, 0x6c, 0x6c, 0x62, 0x61, 0x63, 0x6b,
  0x00, 0x00,
]).buffer;

const globalsFixture = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
  // import env.foo as an immutable i32 global
  0x02, 0x0c, 0x01,
  0x03, 0x65, 0x6e, 0x76,
  0x03, 0x66, 0x6f, 0x6f,
  0x03, 0x7f, 0x00,
  // immutable i32, mutable i32, immutable i32 with an initializer that the
  // parser cannot skip, immutable i32
  0x06, 0x18, 0x04,
  0x7f, 0x00, 0x41, 0x0b, 0x0b,
  0x7f, 0x01, 0x41, 0x01, 0x0b,
  0x7f, 0x00, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x0b,
  0x7f, 0x00, 0x41, 0x03, 0x0b,
  // export foo, bar, baz, qux, a second name for bar, and corge
  0x07, 0x28, 0x06,
  0x03, 0x66, 0x6f, 0x6f, 0x03, 0x00,
  0x03, 0x62, 0x61, 0x72, 0x03, 0x01,
  0x03, 0x62, 0x61, 0x7a, 0x03, 0x02,
  0x03, 0x71, 0x75, 0x78, 0x03, 0x03,
  0x04, 0x71, 0x75, 0x75, 0x78, 0x03, 0x01,
  0x05, 0x63, 0x6f, 0x72, 0x67, 0x65, 0x03, 0x04,
]).buffer;

describe("exact Wasm module reflection", () => {
  it("uses registered artifact descriptors when engine reflection is unavailable", () => {
    const module = new WebAssembly.Module(fixture);
    registerWasmModuleReflection(module, fixture);
    const imports = vi.spyOn(WebAssembly.Module, "imports").mockImplementation(
      () => {
        throw new TypeError("engine cannot reflect this module");
      },
    );
    const exports = vi.spyOn(WebAssembly.Module, "exports").mockImplementation(
      () => {
        throw new TypeError("engine cannot reflect this module");
      },
    );
    try {
      expect(wasmModuleImports(module)).toEqual([
        { module: "env", name: "callback", kind: "function" },
      ]);
      expect(wasmModuleExports(module)).toEqual([
        { name: "callback", kind: "function" },
      ]);
      expect(imports).not.toHaveBeenCalled();
      expect(exports).not.toHaveBeenCalled();
    } finally {
      imports.mockRestore();
      exports.mockRestore();
    }
  });

  it("reads the mutability of the exported globals that it can reach", () => {
    const module = new WebAssembly.Module(globalsFixture);
    registerWasmModuleReflection(module, globalsFixture);

    expect([...wasmModuleGlobalExportMutability(module)]).toEqual([
      ["bar", false],
      ["quux", false],
      ["baz", true],
      ["qux", false],
    ]);
  });

  it("has no global mutability for a module without registered bytes", () => {
    const module = new WebAssembly.Module(globalsFixture);

    expect(wasmModuleGlobalExportMutability(module).size).toBe(0);
  });

  it("retains native reflection for modules without registered bytes", () => {
    const module = new WebAssembly.Module(fixture);

    expect(wasmModuleImports(module)).toEqual(
      WebAssembly.Module.imports(module),
    );
    expect(wasmModuleExports(module)).toEqual(
      WebAssembly.Module.exports(module),
    );
  });
});
