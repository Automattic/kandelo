import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { MEMORY_PLAIN_FORM_SECTION } from "../src/fork-module-state";
import { instrumentProgram, instrumentSideModule } from "../src/memory-instrument";
import { MEMORY_REWRITE_AT_EXEC_SECTION } from "../src/program-rewriter";

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

// (module
//   (import "env" "memory" (memory 1 100 shared))
//   (func (export "increment") (param i32)
//     (loop
//       local.get 0 local.get 0 i32.load8_u i32.const 1 i32.add i32.store8
//       local.get 0 i32.load8_u i32.const 44 i32.lt_u br_if 0)))
const incrementModule = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x01, 0x7f, 0x00,
  0x02, 0x10, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x03, 0x01, 0x64,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0d, 0x01, 0x09, 0x69, 0x6e, 0x63, 0x72, 0x65, 0x6d, 0x65, 0x6e, 0x74, 0x00, 0x00,
  0x0a, 0x1e, 0x01, 0x1c, 0x00, 0x03, 0x40,
  0x20, 0x00, 0x20, 0x00, 0x2d, 0x00, 0x00, 0x41, 0x01, 0x6a, 0x3a, 0x00, 0x00,
  0x20, 0x00, 0x2d, 0x00, 0x00, 0x41, 0x2c, 0x49, 0x0d, 0x00, 0x0b, 0x0b,
]);

// (module
//   (import "env" "memory" (memory 1 100 shared))
//   (global (export "__heap_base") i32 (i32.const 65552))
//   (func (export "load") (param i32) (result i32) local.get 0 i32.load)
//   (data "foo"))
// followed by an empty custom section "kandelo.memory.rewrite_at_exec".
const markedProgram = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x02, 0x10, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x03, 0x01, 0x64,
  0x03, 0x02, 0x01, 0x00,
  0x06, 0x08, 0x01, 0x7f, 0x00, 0x41, 0x90, 0x80, 0x04, 0x0b,
  0x07, 0x16, 0x02, 0x04, 0x6c, 0x6f, 0x61, 0x64, 0x00, 0x00,
  0x0b, 0x5f, 0x5f, 0x68, 0x65, 0x61, 0x70, 0x5f, 0x62, 0x61, 0x73, 0x65, 0x03, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x28, 0x02, 0x00, 0x0b,
  0x0b, 0x06, 0x01, 0x01, 0x03, 0x66, 0x6f, 0x6f,
  0x00, 0x1f, 0x1e, ...new TextEncoder().encode(MEMORY_REWRITE_AT_EXEC_SECTION),
]);

describe("instrumentProgram", () => {
  it("drops the mark and records the hash of the plain form", () => {
    const rewritten = new WebAssembly.Module(instrumentProgram(instrumenter, markedProgram) as BufferSource);

    expect(WebAssembly.Module.customSections(rewritten, MEMORY_REWRITE_AT_EXEC_SECTION)).toEqual([]);
    expect(WebAssembly.Module.customSections(rewritten, MEMORY_PLAIN_FORM_SECTION).map((section) => Buffer.from(section)))
      .toEqual([createHash("sha256").update(markedProgram).digest()]);
  });
});

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

  it("copies a shared page once for a load and a store of the same address", () => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
    const words = new Int32Array(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    const tableBase = 2 * PAGE;
    const writeTableBase = tableBase + 4 * PAGE;
    const groupBase = 10 * PAGE;
    const sharers = groupBase + PAGE;
    const fresh = 16;
    words[tableBase / 4] = PAGE;
    words[writeTableBase / 4] = PAGE | 1;
    words[groupBase / 4] = fresh;
    words[sharers / 4 + 1] = 1;
    bytes[PAGE + 8] = 42;

    const rewritten = instrumentSideModule(instrumenter, incrementModule);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(rewritten as BufferSource), { env: { memory } });
    const exports = instance.exports as {
      __memory_table_base: WebAssembly.Global;
      __memory_group_base: WebAssembly.Global;
      increment(address: number): void;
    };
    exports.__memory_table_base.value = tableBase;
    exports.__memory_group_base.value = groupBase;
    exports.increment(8);

    expect(bytes[PAGE + 8]).toBe(42);
    expect(bytes[fresh * PAGE + 8]).toBe(44);
    expect(words[tableBase / 4]).toBe(fresh * PAGE);
    expect(words[writeTableBase / 4]).toBe(fresh * PAGE);
    expect(words[groupBase / 4]).toBe(fresh + 1);
    expect(words[sharers / 4 + 1]).toBe(0);
  });

  it("reports why the instrumenter refuses a module", () => {
    expect(() => instrumentSideModule(instrumenter, Uint8Array.from([0, 1, 2, 3])))
      .toThrow(/memory instrumentation failed: input uses a feature outside the supported set/);
  });
});
