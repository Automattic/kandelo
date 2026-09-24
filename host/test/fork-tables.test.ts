import { describe, expect, it } from "vitest";

import { ForkTableStateOwners } from "../src/fork-table-state-owners";
import { ForkTables } from "../src/fork-tables";

function table(length: number): WebAssembly.Table {
  return new WebAssembly.Table({ element: "anyfunc", initial: length });
}

/**
 * A `ForkTables` over the real owner election, which is where a table's
 * canonical coordinate comes from: `ForkTables` keeps no copy of it.
 */
function build() {
  const marks: [number, bigint, bigint][] = [];
  const owners = new ForkTableStateOwners(() => {});
  const forkTables = new ForkTables(
    {
      markTablePages: (owner, first, count) => {
        // The real export takes `u64` pages, so anything but a BigInt throws
        // "Cannot convert 0 to a BigInt" from inside the module. Asserting the
        // TYPE here is what a stub sink can still check.
        expect(typeof first, "first page is a BigInt").toBe("bigint");
        expect(typeof count, "page count is a BigInt").toBe("bigint");
        marks.push([owner, first, count]);
      },
    },
    owners,
    "test fork tables",
  );
  const tables = Object.assign(forkTables, {
    /** What registration publishes: the table's owner election. */
    register(activationId: number, ownerId: number, t: WebAssembly.Table): void {
      owners.register(activationId, ownerId, t);
    },
  });
  return { tables, marks };
}

describe("fork tables", () => {
  it("marks a mutation under the canonical coordinate, in pages", () => {
    // Aliases name ONE physical table. Marking each separately would journal
    // the same pages under coordinates whose sparse state nobody writes.
    const { tables, marks } = build();
    const shared = table(4096);
    tables.register(3, 9, shared);
    tables.register(1, 2, shared); // the lower coordinate: canonical
    tables.markTableMutation(shared, 1023, 2);
    // Page shift is 10, so indices 1023 and 1024 straddle pages 0 and 1.
    expect(marks).toEqual([[2, 0n, 2n]]);
  });

  it("marks nothing for an empty range", () => {
    const { tables, marks } = build();
    const t = table(16);
    tables.register(0, 1, t);
    tables.markTableMutation(t, 4, 0);
    expect(marks).toEqual([]);
  });

  it("refuses to mark a table it never saw", () => {
    const { tables } = build();
    expect(() => tables.markTableMutation(table(4), 0, 1)).toThrow(
      /outside the registered fork catalogs/,
    );
    expect(() =>
      tables.markTableMutation({} as WebAssembly.Table, 0, 1),
    ).toThrow(/not a Table/);
  });
  // The funcref patch capture/apply cases went with the methods: the fork
  // module reads and writes guest tables through the guest's own shims now
  // (host/test/dlopen-pthread-table-replication.test.ts covers the behavior).
});
