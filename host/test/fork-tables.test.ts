import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FORK_TABLE_DIRTY_GROUP_FLAG, ForkTables } from "../src/fork-tables";

function table(length: number): WebAssembly.Table {
  return new WebAssembly.Table({ element: "anyfunc", initial: length });
}

/**
 * A `ForkTables` over a recording sink. Which coordinate a group's pages land
 * under is the fork module's election; `fork-table-state-election.test.ts`
 * drives that through the real module.
 */
function build() {
  const marks: [number, bigint, bigint][] = [];
  const tables = new ForkTables(
    {
      markTablePages: (groupMark, first, count) => {
        // The real export takes `u64` pages, so anything but a BigInt throws
        // "Cannot convert 0 to a BigInt" from inside the module. Asserting the
        // TYPE here is what a stub sink can still check.
        expect(typeof first, "first page is a BigInt").toBe("bigint");
        expect(typeof count, "page count is a BigInt").toBe("bigint");
        marks.push([groupMark, first, count]);
      },
    },
    "test fork tables",
  );
  return { tables, marks };
}

describe("fork tables", () => {
  it("marks a mutation under the table's identity group, in pages", () => {
    // Aliases name ONE physical table and share its group; the module
    // journals the pages under the coordinate it elected for that group.
    const { tables, marks } = build();
    const shared = table(4096);
    tables.track(shared, 7);
    tables.markTableMutation(shared, 1023, 2);
    // Page shift is 10, so indices 1023 and 1024 straddle pages 0 and 1.
    expect(marks).toEqual([[(FORK_TABLE_DIRTY_GROUP_FLAG | 7) >>> 0, 0n, 2n]]);
  });

  it("marks nothing for an empty range", () => {
    const { tables, marks } = build();
    const t = table(16);
    tables.track(t, 1);
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

  it("sets the group bit the module decodes", () => {
    // A mark without the bit is read as a guest's owner ordinal, and the pages
    // land under a coordinate that may not write the table at all -- a wrong
    // journal, not a trap. So the host's copy is pinned to the module's.
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "crates/fork-codec/src/bindings.rs"),
      "utf8",
    );
    const match = /pub const TABLE_DIRTY_GROUP_FLAG: u32 = (0x[0-9a-f_]+);/.exec(source);
    expect(match, "fork-codec still defines TABLE_DIRTY_GROUP_FLAG").not.toBeNull();
    expect(FORK_TABLE_DIRTY_GROUP_FLAG).toBe(Number(match![1].replace(/_/g, "")));
  });
  // The funcref patch capture/apply cases went with the methods: the fork
  // module reads and writes guest tables through the guest's own shims now
  // (host/test/dlopen-pthread-table-replication.test.ts covers the behavior).
});
