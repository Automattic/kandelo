import { describe, expect, it } from "vitest";

import { ForkTableStateOwners } from "../src/fork-table-state-owners";

function table(): WebAssembly.Table {
  return new WebAssembly.Table({ element: "anyfunc", initial: 1 });
}

describe("ForkTableStateOwners", () => {
  it("makes the first coordinate registered for a table its owner", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(7, t);
    expect(owners.ownsState(7)).toBe(true);
  });

  it("does not make a second coordinate naming the SAME table an owner", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(7, t);
    owners.register(9, t);
    // The alias must not also write sparse state: two writers for one physical
    // table corrupt the child, and the corruption is silent.
    expect(owners.ownsState(9)).toBe(false);
    expect(owners.ownsState(7)).toBe(true);
  });

  it("makes coordinates on DIFFERENT tables each an owner", () => {
    const owners = new ForkTableStateOwners();
    owners.register(7, table());
    owners.register(9, table());
    expect(owners.ownsState(7)).toBe(true);
    expect(owners.ownsState(9)).toBe(true);
  });

  it("keeps ownership when the owning coordinate re-registers", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(7, t);
    owners.register(7, t);
    // A re-register is not an alias. Treating it as one would silently demote
    // the only owner and leave the table with no writer at all.
    expect(owners.ownsState(7)).toBe(true);
  });

  it("answers false for a coordinate that never registered", () => {
    const owners = new ForkTableStateOwners();
    expect(owners.ownsState(7)).toBe(false);
  });

  it("forgets a released coordinate", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    owners.register(7, t);
    owners.release(7);
    expect(owners.ownsState(7)).toBe(false);
  });

  it("rejects an owner id that is not a non-negative integer", () => {
    const owners = new ForkTableStateOwners();
    const t = table();
    expect(() => owners.register(-1, t)).toThrow(/invalid table owner id -1/);
    expect(() => owners.register(1.5, t)).toThrow(/invalid table owner id 1.5/);
    expect(() => owners.register(Number.NaN, t)).toThrow(/invalid table owner id/);
    // A rejected registration must leave no trace: if it recorded the table
    // first, the NEXT (valid) coordinate would be demoted to an alias of a
    // registration that never happened.
    owners.register(0, t);
    expect(owners.ownsState(0)).toBe(true);
  });
});
