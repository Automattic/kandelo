import { describe, expect, it, vi } from "vitest";

import {
  registerWasmModuleReflection,
  wasmModuleExports,
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
