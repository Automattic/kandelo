import { describe, expect, it } from "vitest";

import { ForkTableStateOwners } from "../src/fork-table-state-owners";

function table(): WebAssembly.Table {
  return new WebAssembly.Table({ element: "anyfunc", initial: 1 });
}

/**
 * An election observed the way the fork module observes it: through the
 * publish sink. `owns` answers what the module would answer for a coordinate
 * -- the last result published for it, and no owner for one never published.
 */
function electing(): {
  owners: ForkTableStateOwners;
  owns: (activationId: number, ownerId: number) => boolean;
} {
  const latest = new Map<string, boolean>();
  const owners = new ForkTableStateOwners((activationId, ownerId, owns) =>
    latest.set(`${activationId}:${ownerId}`, owns),
  );
  return {
    owners,
    owns: (activationId, ownerId) => latest.get(`${activationId}:${ownerId}`) === true,
  };
}

describe("ForkTableStateOwners", () => {
  it("makes the only coordinate on a table its owner", () => {
    const { owners, owns } = electing();
    owners.register(0, 7, table());
    expect(owns(0, 7)).toBe(true);
  });

  it("does not make a second coordinate naming the SAME table an owner", () => {
    const { owners, owns } = electing();
    const t = table();
    owners.register(0, 7, t);
    owners.register(0, 9, t);
    // The alias must not also write sparse state: two writers for one physical
    // table corrupt the child, and the corruption is silent.
    expect(owns(0, 9)).toBe(false);
    expect(owns(0, 7)).toBe(true);
  });

  it("elects the LOWEST coordinate, not the first registered", () => {
    const { owners, owns } = electing();
    const t = table();
    owners.register(3, 5, t);
    owners.register(1, 9, t);
    // Activation 1 registered second but sorts first, so it displaces
    // activation 3. "First wins" would leave 3 owning the table -- and the two
    // rules agree whenever activations register in ascending order, which is
    // the common case and exactly why this is easy to get wrong.
    expect(owns(1, 9)).toBe(true);
    expect(owns(3, 5)).toBe(false);
  });

  it("breaks a tie on activation id by owner id", () => {
    const { owners, owns } = electing();
    const t = table();
    owners.register(2, 9, t);
    owners.register(2, 4, t);
    expect(owns(2, 4)).toBe(true);
    expect(owns(2, 9)).toBe(false);
  });

  it("makes coordinates on DIFFERENT tables each an owner", () => {
    const { owners, owns } = electing();
    owners.register(0, 7, table());
    owners.register(1, 9, table());
    expect(owns(0, 7)).toBe(true);
    expect(owns(1, 9)).toBe(true);
  });

  it("keeps ownership when the owning coordinate re-registers", () => {
    const { owners, owns } = electing();
    const t = table();
    owners.register(0, 7, t);
    owners.register(0, 7, t);
    // A re-register is not an alias. Recording it twice would leave the same
    // coordinate in the list at index 1 as well, where the election would mark
    // it a non-owner and the table would lose its only writer.
    expect(owns(0, 7)).toBe(true);
  });

  it("promotes the next coordinate when the owner's activation releases", () => {
    const { owners, owns } = electing();
    const t = table();
    owners.register(0, 7, t);
    owners.register(1, 9, t);
    owners.releaseActivation(0, [t]);
    // Without re-election the table is left with NO writer, which loses every
    // subsequent sparse-state write rather than duplicating one. (The released
    // coordinate is not demoted through the sink: its activation's records
    // leave the module with the activation.)
    expect(owns(1, 9)).toBe(true);
  });

  it("publishes each election result exactly once, on change", () => {
    const seen: Array<[number, number, boolean]> = [];
    const owners = new ForkTableStateOwners((a, o, w) => seen.push([a, o, w]));
    const t = table();
    owners.register(3, 5, t);
    owners.register(1, 9, t);
    // 3:5 is elected, then DEMOTED when the lower 1:9 arrives and is elected.
    // The demotion must come FIRST: the other order leaves a window in which
    // the module answers 1 for both coordinates, and two writers for one
    // physical table rebuild the child wrong without trapping.
    expect(seen).toEqual([
      [3, 5, true],
      [3, 5, false],
      [1, 9, true],
    ]);
  });

  it("does not republish an unchanged election", () => {
    const seen: Array<[number, number, boolean]> = [];
    const owners = new ForkTableStateOwners((a, o, w) => seen.push([a, o, w]));
    const t = table();
    owners.register(1, 5, t);
    owners.register(2, 6, t);
    owners.register(3, 7, t);
    // Each registration re-elects the whole table, but 1:5 stays the owner and
    // 2:6 stays an alias. Republishing on every registration would make the
    // module see a demote/promote flicker for the incumbent -- and the guest
    // can call `table_state_owned` between those two seeds.
    expect(seen).toEqual([
      [1, 5, true],
      [2, 6, false],
      [3, 7, false],
    ]);
  });

  it("publishes the promotion when the owner's activation releases", () => {
    const seen: Array<[number, number, boolean]> = [];
    const owners = new ForkTableStateOwners((a, o, w) => seen.push([a, o, w]));
    const t = table();
    owners.register(1, 5, t);
    owners.register(2, 6, t);
    seen.length = 0;
    owners.releaseActivation(1, [t]);
    // Without this the module keeps answering 0 for 2:6 and the table has no
    // writer at all -- every later sparse write is lost rather than duplicated.
    expect(seen).toEqual([[2, 6, true]]);
  });

  it("publishes ownership again for a library that reuses a closed id", () => {
    // `dlopen` reuses a `dlclose`d id, and the module's release drops every
    // election result it served for that id, so it answers "not owned" until
    // told otherwise. If this side still remembered publishing "owned" for
    // the coordinate, it would never say so again, and the new library's
    // table would have no sparse-state writer. The release is what forgets.
    const published: string[] = [];
    const owners = new ForkTableStateOwners((a, o, owned) => void published.push(`${a}:${o}=${owned}`));
    const closed = table();
    owners.register(3, 1, closed);
    owners.releaseActivation(3, [closed]);
    owners.register(3, 1, table());
    expect(published).toEqual(["3:1=true", "3:1=true"]);
    expect(owners.canonical(closed), "the closed table has no coordinate").toBeUndefined();
  });

  it("rejects an activation id that is not a non-negative integer", () => {
    const { owners } = electing();
    const t = table();
    expect(() => owners.register(-1, 7, t)).toThrow(/invalid activation id -1/);
    expect(() => owners.register(1.5, 7, t)).toThrow(/invalid activation id 1.5/);
  });

  it("rejects an owner id outside the wire range", () => {
    const { owners, owns } = electing();
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
    expect(owns(0, 1)).toBe(true);
  });
});
