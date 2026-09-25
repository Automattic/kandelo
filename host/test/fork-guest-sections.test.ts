import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  computeForkModuleTemplateId,
  encodeForkAdmission,
  FORK_ADMISSION_FORK_CHILD,
  readForkModuleStateRoot,
} from "../src/fork-guest-sections";

/** The smallest wasm module carrying the given custom sections, in order. */
function moduleWithSections(sections: readonly [string, Uint8Array][]): WebAssembly.Module {
  const uleb = (value: number): number[] => {
    const out: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      out.push(byte);
    } while (value !== 0);
    return out;
  };
  const custom = sections.flatMap(([name, payload]) => {
    const nameBytes = new TextEncoder().encode(name);
    const body = [...uleb(nameBytes.length), ...nameBytes, ...payload];
    return [0x00, ...uleb(body.length), ...body];
  });
  return new WebAssembly.Module(
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...custom]),
  );
}

const SECTION = "kandelo.wpk_fork.module_state";

describe("fork module section readers", () => {
  it("lays out an admission: header, one ref per located section, bytes verbatim", () => {
    // The host locates and copies; it decodes nothing and requires nothing.
    // A DUPLICATE section is passed through so the module refuses it by name
    // (`DuplicateSection`), and an absent one is simply not referenced -- an
    // empty stand-in would be a claim ("imports nothing") the guest never made.
    const state = new Uint8Array([1, 2, 3]);
    const again = new Uint8Array([4, 5]);
    const kfit = new Uint8Array([9]);
    const module = moduleWithSections([
      ["kandelo.wpk_fork.module_state", state],
      ["kandelo.wpk_fork.imported_tables", kfit],
      ["kandelo.wpk_fork.module_state", again],
      ["unrelated", new Uint8Array([7])],
    ]);
    const template = new Uint8Array(32).fill(0xab);
    const desc = encodeForkAdmission(5, FORK_ADMISSION_FORK_CHILD, template, module);
    const view = new DataView(desc.buffer);
    expect([...desc.subarray(0, 4)]).toEqual([0x4b, 0x46, 0x41, 0x41]);
    expect([view.getUint16(4, true), view.getUint16(6, true)]).toEqual([1, 64]);
    expect([view.getUint32(8, true), view.getUint32(12, true)]).toEqual([5, 2]);
    expect(desc.subarray(16, 48)).toEqual(template);
    expect(view.getUint32(48, true)).toBe(3);
    expect([...desc.subarray(52, 64)].every((b) => b === 0), "reserved").toBe(true);
    const refs = [0, 1, 2].map((i) => [64, 68, 72].map((at) => view.getUint32(at + i * 12, true)));
    // Wire order by kind: module state (2) twice, then imported tables (7).
    expect(refs).toEqual([[2, 100, 3], [2, 103, 2], [7, 105, 1]]);
    expect([...desc.subarray(100)]).toEqual([1, 2, 3, 4, 5, 9]);
  });

  it("reads the arena root out of a module buffer's prefix", () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const view = new DataView(memory.buffer);
    const buffer = 1024;
    view.setUint32(buffer + 4, 3 * 65_536, true); // word offset 1, ptrWidth 4
    expect(readForkModuleStateRoot(memory, buffer, 4)).toBe(3 * 65_536);
    view.setUint32(buffer + 4, 0, true);
    expect(readForkModuleStateRoot(memory, buffer, 4), "0 means none").toBe(0);
  });

  it("refuses a root that cannot be an arena", () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const view = new DataView(memory.buffer);
    view.setUint32(1024 + 4, 65_536 + 1, true);
    expect(() => readForkModuleStateRoot(memory, 1024, 4)).toThrow(
      /not page-aligned/,
    );
    expect(() => readForkModuleStateRoot(memory, 0, 4)).toThrow(
      /invalid module-state module buffer/,
    );
  });

  it("hashes module bytes the way SHA-256 does", () => {
    // Against node's own SHA-256, not against a recorded digest: a recorded one
    // would agree with this implementation's bugs. The lengths bracket the
    // block boundary, where the padding and the length word interact.
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
      expect(
        Buffer.from(computeForkModuleTemplateId(bytes)).toString("hex"),
        `length ${length}`,
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("hashes a view without hashing its neighbours", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const middle = backing.subarray(2, 6);
    expect(Buffer.from(computeForkModuleTemplateId(middle)).toString("hex")).toBe(
      createHash("sha256").update(Buffer.from([3, 4, 5, 6])).digest("hex"),
    );
  });
});
