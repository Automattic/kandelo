import { describe, expect, it } from "vitest";

import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";

/** A stand-in for the module: a real anyref table plus a grow entry. */
function moduleWith(initial: number, growable = true) {
  const table = new WebAssembly.Table({
    element: "anyref" as "anyfunc",
    initial,
  });
  let errno = 0;
  return {
    table,
    exports: {
      __wpk_fork_ref_gc_transit: table,
      fm_transit_grow: (needed: number): number => {
        if (!growable) {
          errno = 12;
          return -1;
        }
        if (table.length < needed) table.grow(needed - table.length);
        errno = 0;
        return table.length;
      },
      fm_last_errno: () => errno,
    },
  };
}

describe("fork anyref transit", () => {
  it("views the module's table rather than minting one", () => {
    const { table, exports } = moduleWith(4);
    const transit = new ForkAnyrefTransitTable(exports);
    const value = {};
    transit.set(1, value);
    // Written through the view, visible in the MODULE's table. A version that
    // minted its own would leave the guest and the module reading a different
    // one, which is the disagreement this replaced.
    expect(table.get(1)).toBe(value);
    expect(transit.get(1)).toBe(value);
  });

  it("refuses a module with no transit table", () => {
    expect(
      () => new ForkAnyrefTransitTable({} as never),
    ).toThrow(/no __wpk_fork_ref_gc_transit/);
  });

  it("names the growth export it is missing, rather than failing at grow", () => {
    // The production call site passed the transit TABLE instead of the module's
    // exports, which the table check above rejected with a message about a
    // missing table -- true of the argument and useless about the mistake.
    // Anything that got past it would have failed much later, inside `grow`,
    // with `undefined is not a function`.
    const { table, exports } = moduleWith(2);
    expect(
      () => new ForkAnyrefTransitTable({ __wpk_fork_ref_gc_transit: table }),
    ).toThrow(/no fm_transit_grow/);
    expect(
      () =>
        new ForkAnyrefTransitTable({
          __wpk_fork_ref_gc_transit: table,
          fm_transit_grow: exports.fm_transit_grow,
        }),
    ).toThrow(/no fm_last_errno/);
  });

  it("grows through the MODULE for a recipe slot", () => {
    const { table, exports } = moduleWith(2);
    const transit = new ForkAnyrefTransitTable(exports);
    transit.ensureRecipeSlot(7);
    // recipe + 1 must be indexable, so the table must reach recipe + 2.
    expect(table.length).toBeGreaterThanOrEqual(9);
    transit.set(8, {});
  });

  it("rejects an out-of-range recipe id before reaching table.grow", () => {
    // An overflow inside `table.grow` is an engine-dependent trap, and the
    // recipe id arrives from the host side.
    const { exports } = moduleWith(2);
    const transit = new ForkAnyrefTransitTable(exports);
    for (const bad of [0, -1, 1.5, 0x7fff_ffff]) {
      expect(() => transit.ensureRecipeSlot(bad)).toThrow(/invalid Wasm-GC recipe id/);
    }
  });

  it("fails loud when the module refuses to grow", () => {
    const { exports } = moduleWith(2, false);
    const transit = new ForkAnyrefTransitTable(exports);
    expect(() => transit.ensureRecipeSlot(50)).toThrow(/fm_transit_grow\(52\) failed/);
  });

  it("refuses a slot outside the table", () => {
    const { exports } = moduleWith(3);
    const transit = new ForkAnyrefTransitTable(exports);
    expect(() => transit.get(3)).toThrow(/outside the transit table/);
    expect(() => transit.set(-1, {})).toThrow(/outside the transit table/);
  });

  it("clears EVERY grown slot, in place, keeping the object the module holds", () => {
    // "Every slot" is inherited from the test this file replaced: sampling two
    // would pass against a `clear()` that stopped at the original length and
    // left everything the table grew into still holding references.
    const { table, exports } = moduleWith(3);
    const transit = new ForkAnyrefTransitTable(exports);
    transit.ensureRecipeSlot(6);
    for (let i = 0; i < table.length; i += 1) transit.set(i, { slot: i });
    transit.clear();
    expect(
      Array.from({ length: table.length }, (_, i) => table.get(i)),
    ).toEqual(Array.from({ length: table.length }, () => null));
    // Same table object throughout: replacing it would strand the module and the
    // guest on references this host had abandoned.
    expect(exports.__wpk_fork_ref_gc_transit).toBe(table);
  });
});
