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

  it("run-length encodes a funcref range by catalog coordinate", () => {
    const { tables } = build();
    const catalog = table(4);
    catalog.set(0, FUNCS[0] as never);
    catalog.set(1, FUNCS[1] as never);
    tables.registerCatalog(7, catalog);
    const t = table(6);
    t.set(0, FUNCS[0] as never);
    t.set(1, FUNCS[0] as never);
    t.set(2, FUNCS[1] as never);
    tables.register(7, 1, t);

    const patch = tables.captureFuncrefTablePatch(7, 1, 0, 5);
    expect(patch).not.toBeNull();
    expect(patch!.runs).toEqual([
      { length: 2, function: { activationId: 7, ordinal: 0 } },
      { length: 1, function: { activationId: 7, ordinal: 1 } },
      { length: 2, function: null },
    ]);
    expect(patch!.tableLength).toBe(6);
  });

  it("gives up on a function no catalog claims", () => {
    // Not an error: `null` means this range needs the module's typed
    // checkpoint instead, which is where anything JavaScript cannot name goes.
    const { tables } = build();
    tables.registerCatalog(7, table(1));
    const t = table(2);
    t.set(0, FUNCS[2] as never);
    tables.register(7, 1, t);
    expect(tables.captureFuncrefTablePatch(7, 1, 0, 1)).toBeNull();
  });

  it("refuses a capture range that is not the table's", () => {
    const { tables } = build();
    tables.register(7, 1, table(4));
    expect(() => tables.captureFuncrefTablePatch(7, 1, 0, 0)).toThrow(
      /empty table mutation/,
    );
    expect(() => tables.captureFuncrefTablePatch(7, 1, 2, 4)).toThrow(
      /does not match its final Table/,
    );
    expect(() => tables.captureFuncrefTablePatch(9, 1, 0, 1)).toThrow(
      /no table is registered at 9:1/,
    );
  });

  it("applies a published patch with this worker's own functions", () => {
    const { tables, marks } = build();
    const catalog = table(4);
    catalog.set(0, FUNCS[0] as never);
    catalog.set(1, FUNCS[1] as never);
    tables.registerCatalog(7, catalog);
    const t = table(4);
    tables.register(7, 1, t);

    tables.applyFuncrefTablePatch({
      generation: 3,
      activationId: 7,
      ownerId: 1,
      start: 1,
      tableLength: 4,
      runs: [
        { length: 2, function: { activationId: 7, ordinal: 1 } },
        { length: 1, function: null },
      ],
    });
    expect(t.get(1)).toBe(FUNCS[1]);
    expect(t.get(2)).toBe(FUNCS[1]);
    expect(t.get(3)).toBeNull();
    expect(marks, "applying is itself a mutation to journal").toEqual([[1, 0n, 1n]]);
  });

  it("grows a shorter local table using a value the patch supplies", () => {
    // A non-nullable typed function table cannot grow with null, so the
    // initializer has to come from the patch's own runs.
    const { tables } = build();
    const catalog = table(2);
    catalog.set(0, FUNCS[0] as never);
    tables.registerCatalog(7, catalog);
    const t = table(2);
    tables.register(7, 1, t);
    tables.applyFuncrefTablePatch({
      generation: 1,
      activationId: 7,
      ownerId: 1,
      start: 0,
      tableLength: 4,
      runs: [{ length: 4, function: { activationId: 7, ordinal: 0 } }],
    });
    expect(t.length).toBe(4);
    expect(t.get(3)).toBe(FUNCS[0]);
  });

  it("refuses a patch it cannot apply honestly", () => {
    const { tables } = build();
    tables.registerCatalog(7, table(1));
    const t = table(4);
    tables.register(7, 1, t);
    const base: DylinkTablePatch = {
      generation: 1,
      activationId: 7,
      ownerId: 1,
      start: 0,
      tableLength: 4,
      runs: [{ length: 1, function: null }],
    };
    expect(() =>
      tables.applyFuncrefTablePatch({ ...base, generation: undefined }),
      "an unpublished recipe",
    ).toThrow(/not a published recipe/);
    expect(() =>
      tables.applyFuncrefTablePatch({ ...base, runs: [{ length: 0, function: null }] }),
    ).toThrow(/invalid run/);
    expect(() =>
      tables.applyFuncrefTablePatch({
        ...base,
        runs: [{ length: 5, function: null }],
      }),
      "longer than the table it claims",
    ).toThrow(/exceeds its final length/);
    expect(() =>
      tables.applyFuncrefTablePatch({ ...base, tableLength: 2 }),
      "a local table longer than the patch",
    ).toThrow(/longer than its patch/);
    expect(() =>
      tables.applyFuncrefTablePatch({
        ...base,
        activationId: 7,
        runs: [{ length: 1, function: { activationId: 9, ordinal: 0 } }],
      }),
      "a catalog this worker does not have",
    ).toThrow(/no registered function catalog/);
    expect(() =>
      tables.applyFuncrefTablePatch({
        ...base,
        runs: [{ length: 1, function: { activationId: 7, ordinal: 0 } }],
      }),
      "an empty catalog slot",
    ).toThrow(/holds no function/);
  });

  it("refuses to grow when the patch starts past the local end", () => {
    const { tables } = build();
    tables.registerCatalog(7, table(1));
    const t = table(1);
    tables.register(7, 1, t);
    expect(() =>
      tables.applyFuncrefTablePatch({
        generation: 1,
        activationId: 7,
        ownerId: 1,
        start: 2,
        tableLength: 4,
        runs: [{ length: 2, function: null }],
      }),
    ).toThrow(/cannot reconstruct its growth gap/);
  });
});
