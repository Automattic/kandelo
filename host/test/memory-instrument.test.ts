import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instrumentSideModule } from "../src/memory-instrument";

const PAGE = 65536;

const instrumenter = new WebAssembly.Module(
  readFileSync(resolveBinary("kandelo_memory_instrument32.wasm")),
);

// (module
//   (import "env" "memory" (memory 1 100 shared))
//   (func (export "load") (param i32) (result i32) local.get 0 i32.load))
const sideModule = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x02, 0x10, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x03, 0x01, 0x64,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x08, 0x01, 0x04, 0x6c, 0x6f, 0x61, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x28, 0x02, 0x00, 0x0b,
]);

describe("instrumentSideModule", () => {
  it("routes a load of the side module through the page table of the process", () => {
    const memory = new WebAssembly.Memory({ initial: 8, maximum: 65536, shared: true });
    const words = new Int32Array(memory.buffer);
    const tableBase = 2 * PAGE;
    words[tableBase / 4] = PAGE;
    words[(PAGE + 8) / 4] = 42;

    const rewritten = instrumentSideModule(instrumenter, sideModule);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(rewritten as BufferSource), { env: { memory } });
    const exports = instance.exports as {
      __memory_table_base: WebAssembly.Global;
      __memory_group_base: WebAssembly.Global;
      load(address: number): number;
    };
    exports.__memory_table_base.value = tableBase;

    expect(exports.__memory_group_base.value).toBe(0);
    expect(exports.load(8)).toBe(42);
  });

  it("reports why the instrumenter refuses a module", () => {
    expect(() => instrumentSideModule(instrumenter, Uint8Array.from([0, 1, 2, 3])))
      .toThrow(/memory instrumentation failed: input uses a feature outside the supported set/);
  });
});
