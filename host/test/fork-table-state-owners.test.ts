import { describe, expect, it } from "vitest";

import { ForkTableStateOwners } from "../src/fork-table-state-owners";

function table(): WebAssembly.Table {
  return new WebAssembly.Table({ element: "anyfunc", initial: 1 });
}

describe("ForkTableStateOwners", () => {
  it("makes the only coordinate on a table its owner", () => {
    const owners = new ForkTableStateOwners();
    owners.register(0, 7, table());
    expect(owners.ownsState(0, 7)).toBe(true);
  });

  it("does not make a second coordinate naming the SAME table an owner", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(0, 7, t);
    owners.register(0, 9, t);
    // The alias must not also write sparse state: two writers for one physical
    // table corrupt the child, and the corruption is silent.
    expect(owners.ownsState(0, 9)).toBe(false);
    expect(owners.ownsState(0, 7)).toBe(true);
  });

  it("elects the LOWEST coordinate, not the first registered", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(3, 5, t);
    owners.register(1, 9, t);
    // Activation 1 registered second but sorts first, so it displaces
    // activation 3. "First wins" would leave 3 owning the table -- and the two
    // rules agree whenever activations register in ascending order, which is
    // the common case and exactly why this is easy to get wrong.
    expect(owners.ownsState(1, 9)).toBe(true);
    expect(owners.ownsState(3, 5)).toBe(false);
  });

  it("breaks a tie on activation id by owner id", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(2, 9, t);
    owners.register(2, 4, t);
    expect(owners.ownsState(2, 4)).toBe(true);
    expect(owners.ownsState(2, 9)).toBe(false);
  });

  it("makes coordinates on DIFFERENT tables each an owner", () => {
    const owners = new ForkTableStateOwners();
    owners.register(0, 7, table());
    owners.register(1, 9, table());
    expect(owners.ownsState(0, 7)).toBe(true);
    expect(owners.ownsState(1, 9)).toBe(true);
  });

  it("keeps ownership when the owning coordinate re-registers", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(0, 7, t);
    owners.register(0, 7, t);
    // A re-register is not an alias. Recording it twice would leave the same
    // coordinate in the list at index 1 as well, where the election would mark
    // it a non-owner and the table would lose its only writer.
    expect(owners.ownsState(0, 7)).toBe(true);
  });

  it("answers false for a coordinate that never registered", () => {
    const owners = new ForkTableStateOwners();
    expect(owners.ownsState(0, 7)).toBe(false);
  });

  it("promotes the next coordinate when the owner's activation releases", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(0, 7, t);
    owners.register(1, 9, t);
    owners.releaseActivation(0, [t]);
    // Without re-election the table is left with NO writer, which loses every
    // subsequent sparse-state write rather than duplicating one.
    expect(owners.ownsState(1, 9)).toBe(true);
    expect(owners.ownsState(0, 7)).toBe(false);
  });

  it("rejects an activation id that is not a non-negative integer", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    expect(() => owners.register(-1, 7, t)).toThrow(/invalid activation id -1/);
    expect(() => owners.register(1.5, 7, t)).toThrow(/invalid activation id 1.5/);
  });

  it("rejects an owner id outside the wire range", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    // Owner 0 is not a coordinate; the registry it replaces rejected it too.
    expect(() => owners.register(0, 0, t)).toThrow(/invalid table owner id 0/);
    expect(() => owners.register(0, -1, t)).toThrow(/invalid table owner id -1/);
    expect(() => owners.register(0, 0x1_0000_0000, t)).toThrow(
      /invalid table owner id/,
    );
    // A rejected registration must leave no trace: if it recorded the table
    // first, the NEXT valid coordinate could be demoted by a phantom.
    owners.register(0, 1, t);
    expect(owners.ownsState(0, 1)).toBe(true);
  });
});
