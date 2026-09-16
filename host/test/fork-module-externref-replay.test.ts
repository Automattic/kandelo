// Phase 6 D6.2 / M2 — externref reference reconstruction for a PLAIN, directly
// held externref (no aggregate consumer), proven end to end in a real
// WebAssembly engine (Node/V8).
//
// M2 moved externref decode out of the host: the co-resident module's injected
// `__wpk_fork_ref_decode_externref(recipe) -> externref` export now calls the
// single residual `env.resolve_externref(handle) -> externref` host import
// DIRECTLY (no table, no generation, no PHASE A/B host round-trip). A plain
// externref-in-a-local graph (this file's case) has no GC/exnref consumer, so
// `fm_begin_reference_replay`'s bookkeeping pass never calls the host seam
// itself (it is host-free, see `ReconstructionState`'s doc in
// `crates/fork-codec/src/reference_replay.rs`); resolution only happens when
// something actually DECODES a recipe.
//
// THE ARENA IS CAPTURED, NOT CONSTRUCTED. This file used to build its sealed
// KFMS arena in TypeScript with the set-aside `ForkModuleStateArena` and
// `appendSegmentedForkReferenceTransaction`. That is a second implementation of
// a module-owned binary format, and a test written against it proves the two
// implementations agree rather than that the module is right. A PARENT module
// now interns the externrefs and seals; a CHILD module reads what it sealed --
// which is the shape a real fork has, and the only one that can catch a
// capture/replay disagreement at all.
//
// This asserts:
//   (a) PARITY — the value `__wpk_fork_ref_decode_externref(recipe)` returns for
//       a broker handle is `Object.is`-identical to
//       `tokenCache.materialize(handle)` (the same canonical token the JS decode
//       path returns), so module and JS agree on identity.
//   (b) PROOF OF USE — `fm_externrefs_resolved` advances by the externref node
//       count on admission, AND the host `resolve_externref` body observes one
//       call per decode this test drives.

import { describe, expect, it } from "vitest";

import { FORK_MODULE_STATS } from "../src/fork-module-backend";
import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
import {
  INTERN_KIND_EXTERNREF,
  captureArena,
  childModule,
  fixture,
} from "./fork-module-capture-fixture";

/** `fm_stats` field index, read from the one list the backend pins. */
const EXTERNREFS_RESOLVED = FORK_MODULE_STATS.indexOf("externrefsResolved");

const PID = 4242;
const GENERATION_ID = 7;
/** The durable broker handles this fork's externrefs name. */
const HANDLES = [11, 22, 33] as const;

interface ForkModuleRefExports {
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  __wpk_fork_ref_decode_externref: (recipeId: number) => unknown;
}

describe("fork-module externref reference reconstruction (Phase 6 D6.2 / M2)", () => {
  it("decodes a captured externref through the module with identity parity and proof of use", () => {
    const f = fixture();

    // The PARENT interns three durable externrefs and seals. `recipes` is what
    // the module assigned them -- read back rather than assumed, because the
    // numbering is the module's to choose.
    const { root, recipes } = captureArena(
      f,
      HANDLES.map((handle) => [INTERN_KIND_EXTERNREF, handle, 0] as const),
    );
    expect(recipes).toHaveLength(HANDLES.length);

    // The child worker's externref token cache — the SAME cache the still-JS
    // reference path would use, so the value the module's decode returns is
    // byte-for-byte the canonical identity JS returns.
    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    let resolveCalls = 0;
    const hostCapabilities = createForkModuleHostCapabilities({ tokens });
    // Wrapped to count invocations independent of the module's own
    // `fm_externrefs_resolved` bookkeeping (which — since M2 — is a host-free,
    // graph-derived count, not a live per-call tally).
    const child = childModule(f, {
      label: "externref-replay-child",
      resolveExternref: (handle: number): unknown => {
        resolveCalls += 1;
        return hostCapabilities.imports.resolve_externref(handle);
      },
    }) as unknown as ForkModuleRefExports;

    const before = Number(child.fm_stats(EXTERNREFS_RESOLVED));

    // Seed the reference graph (bookkeeping only — since M2 this does NOT call
    // the host seam).
    child.fm_begin_reference_replay(root, PID);
    expect(child.fm_last_errno(), "the child admits the sealed graph").toBe(0);

    // (b) PROOF OF USE (graph admission) — the module's bookkeeping counter
    // advanced by the externref node count purely from admitting the graph.
    const after = Number(child.fm_stats(EXTERNREFS_RESOLVED));
    expect(after - before).toBe(HANDLES.length);
    // Admission alone calls the host seam zero times (M2: host-free bookkeeping).
    expect(resolveCalls).toBe(0);

    // (a) PARITY + (b) PROOF OF USE (actual decode) — decoding each recipe
    // through the module's injected `__wpk_fork_ref_decode_externref` export
    // calls `resolve_externref` exactly once per decode and returns the SAME
    // canonical token `tokenCache.materialize(handle)` returns.
    HANDLES.forEach((handle, index) => {
      const decoded = child.__wpk_fork_ref_decode_externref(recipes[index]!);
      expect(decoded).toBe(tokens.materialize(handle));
    });
    expect(resolveCalls).toBe(HANDLES.length);

    // The decoded tokens are the canonical, worker-generation-tagged identities.
    expect(child.__wpk_fork_ref_decode_externref(recipes[0]!)).not.toBe(
      child.__wpk_fork_ref_decode_externref(recipes[1]!),
    );
  });
});
