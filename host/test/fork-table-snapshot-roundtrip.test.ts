// Path-A A3/A4 — the peer-table snapshot round-trip, in a real engine.
//
// `process-table-replication.test.ts` MOCKS the capture/restore engine, so it
// proves only the patch-journal orchestration. This drives the ACTUAL module
// surface a peer-table snapshot composes and asserts the two invariants such a
// snapshot must hold:
//
//   (a) CAPTURE <-> RESTORE identity -- a funcref captured through the module's
//       reference-graph builder reconstructs to the SAME function when
//       restored through the module's decoded graph;
//   (b) CROSS-WORKER ORDINAL STABILITY -- the identical captured graph,
//       restored against a DIFFERENT worker's own catalog, resolves each
//       recipe to THAT worker's function at the same ordinal, never the
//       capturer's. This is the dlopen replication invariant: every worker
//       re-materialises a recipe into its own table by coordinate.
//
// THE ARENA IS CAPTURED, NOT CONSTRUCTED. This file used to drive the host
// wrappers `ForkCaptureSession` and `ForkTableReconstruction` over an arena it
// built in TypeScript. Both are gone: the module is the capture graph and the
// decoded graph, and a test that rebuilds either in TypeScript proves two
// implementations agree rather than that the module is right. A PARENT interns
// the table's funcrefs and seals; two CHILDREN with DIFFERENT catalogs read
// what it sealed.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FORK_MODULE_STATS } from "../src/fork-module-backend";
import {
  INTERN_KIND_FUNCREF,
  captureArena,
  childInstance,
  fixture,
} from "./fork-module-capture-fixture";

const ACTIVATION = 0;
const REFERENCES_RECONSTRUCTED =
  FORK_MODULE_STATS.indexOf("referencesReconstructed");

/**
 * One worker's own function catalog: four callables whose results identify the
 * WORKER as well as the ordinal, so a recipe resolved against the wrong
 * worker's table is visible rather than merely equal-shaped.
 */
function workerCatalog(base: number): WebAssembly.Table {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-peer-table-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  const funcs = Array.from(
    { length: 4 },
    (_, i) => `(func $f${i} (result i32) i32.const ${base + i})`,
  ).join("\n      ");
  writeFileSync(
    wat,
    `(module
      (table $catalog (export "__wpk_fork_function_catalog") 4 4 funcref)
      ${funcs}
      (elem (table $catalog) (i32.const 0) func $f0 $f1 $f2 $f3))`,
  );
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  return new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm)))
    .exports.__wpk_fork_function_catalog as WebAssembly.Table;
}

interface ReplayExports {
  fm_restore_from_arena: (root: number, pid: number) => number;
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  __wpk_fork_ref_decode_funcref: (recipeId: number) => unknown;
}

/** A worker that has the sealed graph resident and its own catalog filled. */
function worker(
  f: ReturnType<typeof fixture>,
  catalog: WebAssembly.Table,
  root: number,
  pid: number,
  label: string,
  moduleBase: number,
): ReplayExports {
  // Each peer worker gets its OWN module region: the module's statics live in
  // the guest's memory, so two instances at one base would share a decoded
  // graph and a catalog base map -- and the cross-worker claim below would be
  // asserting one worker against itself.
  const child = childInstance(f, { label, moduleBase });
  if (child.functionCatalog.length < catalog.length) {
    child.functionCatalog.grow(catalog.length - child.functionCatalog.length);
  }
  for (let slot = 0; slot < catalog.length; slot += 1) {
    child.functionCatalog.set(slot, catalog.get(slot));
  }
  const x = child.exports as unknown as ReplayExports;
  x.fm_restore_from_arena(root, pid);
  expect(x.fm_last_errno(), `${label} admits the sealed graph`).toBe(0);
  return x;
}

describe("fork peer-table snapshot round-trip (Path-A A3/A4)", () => {
  it("restores each captured slot to its OWN worker's function, not the capturer's", () => {
    const f = fixture();
    // The peer table's four slots, captured as funcref recipes by coordinate.
    const ordinals = [0, 1, 2, 3] as const;
    const { root, recipes } = captureArena(
      f,
      ordinals.map((o) => [INTERN_KIND_FUNCREF, ACTIVATION, o] as const),
    );
    expect(recipes).toHaveLength(ordinals.length);

    // Two workers, two DIFFERENT catalogs at the same coordinates.
    const first = workerCatalog(1000);
    const second = workerCatalog(2000);
    const a = worker(f, first, root, 4242, "peer worker A", 20 * 1024 * 1024);
    const b = worker(f, second, root, 4343, "peer worker B", 32 * 1024 * 1024);

    const beforeA = a.fm_stats(REFERENCES_RECONSTRUCTED);
    ordinals.forEach((ordinal, index) => {
      const recipe = recipes[index]!;
      // (a) identity: each worker gets the function its OWN table holds.
      expect(a.__wpk_fork_ref_decode_funcref(recipe)).toBe(first.get(ordinal));
      expect(b.__wpk_fork_ref_decode_funcref(recipe)).toBe(second.get(ordinal));
      // (b) and calling proves it is that worker's function, not a look-alike
      // at the same coordinate.
      expect((a.__wpk_fork_ref_decode_funcref(recipe) as () => number)())
        .toBe(1000 + ordinal);
      expect((b.__wpk_fork_ref_decode_funcref(recipe) as () => number)())
        .toBe(2000 + ordinal);
    });

    // The same recipes in both workers: replication is by COORDINATE, and the
    // recipe ids do not depend on who restores them.
    expect(recipes).toEqual([...recipes].sort((l, r) => l - r));

    // Proof of use: the decodes above ran through the module.
    expect(Number(a.fm_stats(REFERENCES_RECONSTRUCTED) - beforeA))
      .toBeGreaterThan(0);
  });

  it("carries the canonical null slot across as null in every worker", () => {
    // A peer table's empty slots are not an absence of a recipe: recipe 0 is
    // the canonical null every capture reserves, and a worker that answered
    // anything else for it would fill an empty slot with a function.
    const f = fixture();
    const { root } = captureArena(f, [[INTERN_KIND_FUNCREF, ACTIVATION, 0]]);
    const a = worker(f, workerCatalog(1000), root, 4444, "null slot worker", 20 * 1024 * 1024);
    expect(a.__wpk_fork_ref_decode_funcref(0)).toBe(null);
  });
});
