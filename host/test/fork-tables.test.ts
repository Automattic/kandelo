import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ForkTables } from "../src/fork-tables";
import type { DylinkTablePatch } from "../src/dylink-planner-wire";

/** Three distinct exported wasm functions, for identity in the catalogs. */
const FUNCS = (() => {
  const directory = mkdtempSync(join(tmpdir(), "fork-tables-"));
  try {
    const watPath = join(directory, "m.wat");
    const wasmPath = join(directory, "m.wasm");
    writeFileSync(
      watPath,
      "(module (func (export \"a\")) (func (export \"b\")) (func (export \"c\")))",
    );
    execFileSync("wat2wasm", [watPath, "-o", wasmPath]);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(readFileSync(wasmPath)),
    );
    return [
      instance.exports.a as CallableFunction,
      instance.exports.b as CallableFunction,
      instance.exports.c as CallableFunction,
    ];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

function table(length: number): WebAssembly.Table {
  return new WebAssembly.Table({ element: "anyfunc", initial: length });
}

function build() {
  const marks: [number, bigint, bigint][] = [];
  const tables = new ForkTables(
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
    "test fork tables",
  );
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
