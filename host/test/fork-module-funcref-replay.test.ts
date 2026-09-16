// Phase 6 D6.1 — funcref + null reference reconstruction through the co-resident
// module, proven end to end in a real WebAssembly engine (Node/V8).
//
// The module's injected `__wpk_fork_ref_decode_funcref(recipe) -> funcref`
// resolves a recipe to a slot in the MERGED function catalog it imported at
// init and `table.get`s it. A funcref is a value a Rust function cannot hold or
// return, which is why the decode is an injected wasm shim rather than a plain
// export -- and why this test has to run in an engine rather than against a
// mock.
//
// THE ARENA IS CAPTURED, NOT CONSTRUCTED. This file used to build its sealed
// KFMS arena in TypeScript with the set-aside `ForkModuleStateArena` and
// `appendSegmentedForkReferenceTransaction`, and decode recipe ids it had
// written itself -- which proves two implementations agree, not that the module
// is right. A PARENT module interns the funcrefs and seals; a CHILD module
// reads what it sealed.
//
// The JS `ForkFunctionCatalog` oracle went with the same change. It answered
// "what should `(activation, ordinal)` decode to?", and the line beneath every
// one of its assertions already answered it better: `catalog.get(ordinal)`, the
// real table. One oracle fewer, one fact more.

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

const PID = 4242;
const ACTIVATION = 0;
/** `fm_stats` field index, read from the one list the backend pins. */
const REFERENCES_RECONSTRUCTED =
  FORK_MODULE_STATS.indexOf("referencesReconstructed");

/**
 * A real guest funcref catalog: four callable functions at ordinals 0..3.
 *
 * Built through `wat2wasm` rather than hand-assembled, because the identities
 * under test are `WebAssembly.Table` entries and only a real instance has them.
 */
function catalogTable(): WebAssembly.Table {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-funcref-replay-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  writeFileSync(
    wat,
    `(module
      (table $catalog (export "__wpk_fork_function_catalog") 4 4 funcref)
      (func $f0 (result i32) i32.const 100)
      (func $f1 (result i32) i32.const 101)
      (func $f2 (result i32) i32.const 102)
      (func $f3 (result i32) i32.const 103)
      (elem (table $catalog) (i32.const 0) func $f0 $f1 $f2 $f3))`,
  );
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  const module = new WebAssembly.Module(readFileSync(wasm));
  return new WebAssembly.Instance(module).exports
    .__wpk_fork_function_catalog as WebAssembly.Table;
}

interface ForkModuleRefExports {
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  __wpk_fork_ref_decode_funcref: (recipeId: number) => unknown;
}

describe("fork-module funcref reference reconstruction (Phase 6 D6.1)", () => {
  it("reconstructs a captured funcref + null with identity parity and proof of use", () => {
    const f = fixture();
    const ordinals = [0, 1, 2, 3] as const;

    // The PARENT interns one funcref per catalog ordinal and seals.
    const { root, recipes } = captureArena(
      f,
      ordinals.map((ordinal) => [INTERN_KIND_FUNCREF, ACTIVATION, ordinal] as const),
    );
    expect(recipes).toHaveLength(ordinals.length);

    // The CHILD's merged catalog: one activation, so base 0 and the guest's
    // ordinals are the merged slots. Filling it is the host's job -- the module
    // is instantiated before its guests and cannot import their exports.
    const catalog = catalogTable();
    const child = childInstance(f, { label: "funcref-replay-child" });
    if (child.functionCatalog.length < catalog.length) {
      child.functionCatalog.grow(catalog.length - child.functionCatalog.length);
    }
    for (const ordinal of ordinals) {
      child.functionCatalog.set(ordinal, catalog.get(ordinal));
    }
    const x = child.exports as unknown as ForkModuleRefExports;

    const before = x.fm_stats(REFERENCES_RECONSTRUCTED);

    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno(), "the child admits the sealed graph").toBe(0);

    // Each funcref recipe reconstructs the identity the real catalog holds, and
    // the reconstructed value is a callable function, not a look-alike.
    ordinals.forEach((ordinal, index) => {
      const reconstructed = x.__wpk_fork_ref_decode_funcref(recipes[index]!);
      expect(reconstructed).toBe(catalog.get(ordinal));
      expect((reconstructed as () => number)()).toBe(100 + ordinal);
    });

    // Recipe 0 is the canonical null the module reserves; it decodes to
    // `ref.null func`, which reaches JavaScript as null.
    expect(x.__wpk_fork_ref_decode_funcref(0)).toBe(null);

    // Proof of use: the module reconstructed exactly what was decoded here
    // (four funcrefs plus the null), so this ran through the module.
    const after = x.fm_stats(REFERENCES_RECONSTRUCTED);
    expect(Number(after - before)).toBe(ordinals.length + 1);
  });
});
