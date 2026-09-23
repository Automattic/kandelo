// Phase 6 D7a.1b — MULTI-ACTIVATION funcref reference reconstruction through the
// co-resident fork module, proven end to end in a real WebAssembly engine.
//
// The single-activation analogue is `fork-module-funcref-replay.test.ts` (D6.1),
// which resolves every funcref against ONE catalog. D7a.1b removes that
// restriction with a MERGED, activation-namespaced catalog: the host lays each
// activation's function catalog at a distinct BASE inside one imported table, the
// base the module places with `fm_place_activation_catalog`.
// `fm_funcref_ordinal` then returns the GLOBAL slot
// `base(module_activation) + function_ordinal`, and the injected
// `__wpk_fork_ref_decode_funcref` shim `table.get`s that slot.
//
// THE LOAD-BEARING CASE: a funcref minted in activation A and a funcref minted in
// activation B live in the SAME reference graph. Each must resolve against its
// OWN activation's catalog — never the other's — even though both activations'
// functions share the one merged table. A wrong base would silently return the
// other activation's function; this test calls each reconstructed funcref and
// asserts the value proves the correct catalog.
//
// THE ARENA IS CAPTURED, NOT CONSTRUCTED, and it is captured by a TWO-ACTIVATION
// fork. This file used to build its sealed KFMS arena in TypeScript with the
// set-aside `ForkModuleStateArena`, append both `Module` records by hand, and
// decode recipe ids it had written itself — which proves two implementations
// agree, not that the module is right. Now a PARENT with a side activation
// interns the cross-activation funcrefs and seals; a CHILD reads what it sealed.
// The JS `ForkFunctionCatalog` oracle went with the same change: it answered
// "what should `(activation, ordinal)` decode to?", and the line beneath each of
// its assertions already answered it better — `catalog.get(ordinal)`, the real
// table.

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

const PID = 4343;
// The main module (activation 0) and its dlopen'd side module (activation 1),
// each with its OWN function catalog — the exact shape a real dlopen fork's
// reference graph takes (see fork-dlopen-replay-e2e).
const ACTIVATION_A = 0;
const ACTIVATION_B = 1;
/** `fm_stats` field index, read from the one list the backend pins. */
const REFERENCES_RECONSTRUCTED =
  FORK_MODULE_STATS.indexOf("referencesReconstructed");

/**
 * A guest-like `__wpk_fork_function_catalog` funcref table whose functions each
 * return `base + index`, so a reconstructed funcref's call result uniquely
 * identifies WHICH activation's catalog served it.
 */
function catalogTable(base: number, count: number): WebAssembly.Table {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-multi-funcref-"));
  const wat = join(dir, "catalog.wat");
  const wasm = join(dir, "catalog.wasm");
  const funcs = Array.from(
    { length: count },
    (_, i) => `(func $f${i} (result i32) i32.const ${base + i})`,
  ).join("\n      ");
  const elems = Array.from({ length: count }, (_, i) => `$f${i}`).join(" ");
  writeFileSync(
    wat,
    `(module
      (table $catalog (export "__wpk_fork_function_catalog") ${count} ${count} funcref)
      ${funcs}
      (elem (table $catalog) (i32.const 0) func ${elems}))`,
  );
  execFileSync("wat2wasm", [wat, "-o", wasm]);
  const module = new WebAssembly.Module(readFileSync(wasm));
  return new WebAssembly.Instance(module).exports
    .__wpk_fork_function_catalog as WebAssembly.Table;
}

interface ForkModuleRefExports {
  fm_place_activation_catalog: (activationId: number, length: number) => number;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  __wpk_fork_ref_decode_funcref: (recipeId: number) => unknown;
}

describe("fork-module multi-activation funcref reconstruction (Phase 6 D7a.1b)", () => {
  it("resolves each funcref against its OWN activation's catalog via the merged base map", () => {
    const f = fixture();

    // The EXACT graph a real fork-from-main dlopen fork produced (observed in
    // fork-dlopen-replay-e2e): seven activation-0 funcrefs with large ordinals
    // plus two activation-1 funcrefs, interleaved, after the canonical null.
    const graph = [
      [ACTIVATION_A, 23],
      [ACTIVATION_A, 20],
      [ACTIVATION_A, 40],
      [ACTIVATION_A, 58],
      [ACTIVATION_A, 59],
      [ACTIVATION_A, 60],
      [ACTIVATION_A, 61],
      [ACTIVATION_B, 2],
      [ACTIVATION_B, 3],
    ] as const;

    // The PARENT opens a capture with a SIDE activation and interns the graph.
    const { root, recipes, saved } = captureArena(
      f,
      graph.map(
        ([activation, ordinal]) =>
          [INTERN_KIND_FUNCREF, activation, ordinal] as const,
      ),
      { sideActivations: [ACTIVATION_B] },
    );
    expect(recipes).toHaveLength(graph.length);

    // The capture really was dlopen-shaped: the module drove the module-state
    // save of BOTH activations. Without this the test would pass against a
    // single-activation capture that merely RECORDED activation 1 as a
    // coordinate -- the graph would be identical, and the side module's
    // presence would be an assertion nothing made.
    expect(
      [...saved].sort(),
      "each activation's module state was saved into the capture",
    ).toEqual([ACTIVATION_A, ACTIVATION_B]);

    // Match a real dlopen fork's catalog sizes: activation 0's main-module
    // catalog is large (80 funcref slots), the side module's is small (6).
    const catalogA = catalogTable(1000, 80);
    const catalogB = catalogTable(2000, 6);

    // The CHILD's merged, activation-namespaced catalog: the module places A
    // at slots [0, 80) and B at [80, 86). Filling it is the host's job -- the
    // module is instantiated before its guests and cannot import their
    // exports.
    const child = childInstance(f, { label: "multi-funcref-replay-child" });
    const x = child.exports as unknown as ForkModuleRefExports;
    const BASE_A = x.fm_place_activation_catalog(ACTIVATION_A, catalogA.length);
    expect(x.fm_last_errno(), "activation A's catalog is placed").toBe(0);
    const BASE_B = x.fm_place_activation_catalog(ACTIVATION_B, catalogB.length);
    expect(x.fm_last_errno(), "activation B's catalog is placed").toBe(0);
    expect([BASE_A, BASE_B]).toEqual([0, catalogA.length]);
    const merged = child.functionCatalog;
    const span = BASE_B + catalogB.length;
    if (merged.length < span) merged.grow(span - merged.length);
    for (let i = 0; i < catalogA.length; i += 1) {
      merged.set(BASE_A + i, catalogA.get(i));
    }
    for (let i = 0; i < catalogB.length; i += 1) {
      merged.set(BASE_B + i, catalogB.get(i));
    }

    const before = x.fm_stats(REFERENCES_RECONSTRUCTED);

    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno(), "the child admits the sealed graph").toBe(0);

    graph.forEach(([activation, ordinal], index) => {
      const reconstructed = x.__wpk_fork_ref_decode_funcref(recipes[index]!);
      const catalog = activation === ACTIVATION_A ? catalogA : catalogB;
      // Identity parity with the real table this activation's catalog is.
      expect(
        reconstructed,
        `activation ${activation} ordinal ${ordinal} identity`,
      ).toBe(catalog.get(ordinal));
      // And the reconstructed funcref is that activation's callable function:
      // a wrong base would return the OTHER activation's function, which
      // returns a value from the other thousand.
      expect((reconstructed as () => number)()).toBe(
        (activation === ACTIVATION_A ? 1000 : 2000) + ordinal,
      );
    });

    // The canonical null recipe reconstructs null.
    expect(x.__wpk_fork_ref_decode_funcref(0)).toBe(null);

    // Proof of use: exactly the references decoded here (nine funcrefs plus the
    // null) drove the module, not a silent JS fallback.
    const after = x.fm_stats(REFERENCES_RECONSTRUCTED);
    expect(Number(after - before)).toBe(graph.length + 1);
  });
});
