import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ForkResumeTable,
  type ForkResumeTarget,
} from "../src/fork-resume-table";

/**
 * The resume-slot PARITY contract, from the host side.
 *
 * The module's `resume_peek` returns an index into the table this class holds,
 * so a slot the two sides number differently makes the guest `call_indirect`
 * into a real function that is the wrong one. Nothing traps; the process simply
 * resumes at the wrong place. That is why every assertion here is about WHICH
 * slot, not merely that a slot was assigned.
 */

const repoRoot = join(import.meta.dirname, "..", "..");

function target(functionOrdinal: number): ForkResumeTarget {
  // Any live Wasm function works: the table only needs a funcref, and the
  // identity of the thunk is irrelevant to the numbering under test.
  const module = new WebAssembly.Module(
    new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00,
      0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
      0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
    ]),
  );
  const instance = new WebAssembly.Instance(module, {});
  return { functionOrdinal, thunk: instance.exports.f };
}

describe("ForkResumeTable", () => {
  it("reserves slot 0 and numbers from 1", () => {
    const table = new ForkResumeTable();
    expect(table.table.length).toBe(1);
    table.registerActivation(0, [target(5)]);
    expect(table.slotsOf(0)).toEqual([1]);
    expect(table.table.get(0)).toBeNull();
  });

  it("assigns slots by SORTED ordinal, not registration order", () => {
    const table = new ForkResumeTable();
    const nine = target(9);
    const two = target(2);
    const seven = target(7);
    table.registerActivation(0, [nine, two, seven]);
    // Asserting the SLOT NUMBERS here would prove nothing: they come out
    // [1, 2, 3] whether or not the batch was sorted, because they are pushed in
    // iteration order either way. What distinguishes a sorted host from an
    // unsorted one is WHICH THUNK each slot holds -- and that is exactly what
    // the module gets wrong when the two sides disagree.
    expect(table.table.get(1)).toBe(two.thunk);
    expect(table.table.get(2)).toBe(seven.thunk);
    expect(table.table.get(3)).toBe(nine.thunk);
  });

  it("continues numbering across activations", () => {
    const table = new ForkResumeTable();
    table.registerActivation(0, [target(1), target(2)]);
    table.registerActivation(1, [target(1), target(2)]);
    // The slot space is GLOBAL, not per-activation: activation 1's ordinal 1 is
    // slot 3, not slot 1. The two activations repeat ordinals, so a per-
    // activation space would collide them onto the same slots.
    expect(table.slotsOf(0)).toEqual([1, 2]);
    expect(table.slotsOf(1)).toEqual([3, 4]);
  });

  it("reuses freed slots smallest-first before growing", () => {
    const table = new ForkResumeTable();
    table.registerActivation(0, [target(1), target(2)]);
    table.registerActivation(1, [target(1), target(2)]);
    table.unregisterActivation(0);
    const grown = table.table.length;
    table.registerActivation(2, [target(4)]);
    // Slot 1 was freed, so it is taken again and the table does NOT grow. A
    // host that always grew would leave slot 1 holding a null the module still
    // believes is live.
    expect(table.slotsOf(2)).toEqual([1]);
    expect(table.table.length).toBe(grown);
  });

  it("nulls the entries of an unregistered activation", () => {
    const table = new ForkResumeTable();
    table.registerActivation(0, [target(1)]);
    table.unregisterActivation(0);
    expect(table.table.get(1)).toBeNull();
  });

  it("clears every activation", () => {
    const table = new ForkResumeTable();
    table.registerActivation(0, [target(1)]);
    table.registerActivation(1, [target(2)]);
    table.clear();
    expect(table.slotsOf(0)).toEqual([]);
    expect(table.slotsOf(1)).toEqual([]);
    expect(table.table.get(1)).toBeNull();
    expect(table.table.get(2)).toBeNull();
  });

  it("refuses a repeated ordinal in one activation", () => {
    const table = new ForkResumeTable();
    expect(() =>
      table.registerActivation(0, [target(3), target(3)]),
    ).toThrow(/repeats function ordinal 3/);
  });

  it("refuses a re-registered activation", () => {
    const table = new ForkResumeTable();
    table.registerActivation(0, [target(1)]);
    expect(() => table.registerActivation(0, [target(2)])).toThrow(
      /already registered/,
    );
  });

  it("refuses to unregister an activation that was never registered", () => {
    const table = new ForkResumeTable();
    expect(() => table.unregisterActivation(4)).toThrow(/is not registered/);
  });

  it("refuses a target that is not a Wasm function", () => {
    const table = new ForkResumeTable();
    expect(() =>
      table.registerActivation(0, [
        { functionOrdinal: 1, thunk: 7 as unknown as WebAssembly.ExportValue },
      ]),
    ).toThrow(/is not a Wasm function/);
  });

  it("implements the same four rules the Rust allocator states", () => {
    // The placement rule is duplicated between this class and
    // `ResumeSlotTable` in crates/fork-codec, because the module cannot write a
    // `WebAssembly.Table` and the host cannot be the numbering authority. This
    // pins the duplication to the Rust the module actually compiles: if someone
    // changes the allocator there, this fails rather than the guest silently
    // resuming into the wrong function.
    const rust = readFileSync(
      join(repoRoot, "crates/fork-codec/src/replay_journal.rs"),
      "utf8",
    );
    // 1. slot 0 reserved, numbering starts at 1
    expect(rust).toMatch(/next_slot:\s*1,/);
    // 2. each activation's ordinals sorted ascending
    expect(rust).toMatch(/sorted\.sort_unstable\(\);/);
    // 3. a repeated ordinal is rejected
    expect(rust).toMatch(/if window\[0\] == window\[1\]/);
    // 4. freed slots reused smallest-first before growing
    expect(rust).toMatch(/free_slots\.iter\(\)\.next\(\)/);
  });
});
