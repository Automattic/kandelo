// Phase 6 D6.3a / M2 — exnref reference reconstruction ORCHESTRATED by the
// co-resident fork module, with the anyref TRANSIT rooting the exnref's
// reachable externref payload through the injected drive plan. Proven end to
// end in a real WebAssembly engine (Node/V8).
//
// This is the exnref analogue of `fork-module-externref-replay.test.ts`. The
// crucial addition over the plain externref (D6.2) case: the graph has an
// EXNREF whose reference payload names an externref, so the externref is
// TRANSIT-REACHABLE. Since M2 this is no longer a host PHASE A/B round-trip:
// `fork_codec::build_drive_plan` emits a `DRIVE_OP_EXTERNREF_TRANSIT` step for
// the reachable payload (Phase 0, before the EXN step), and the injected
// `fm_drive_execute` shim resolves it through the single residual
// `env.resolve_externref` host import, internalizes it (`any.convert_extern`),
// `table.set`s it into the anyref transit at `recipe + 1`, and asserts non-null
// — the M2 replacement for the retired host `Object.is` R1 read-back guard (see
// the design ruling in
// `docs/superpowers/plans/2026-09-03-m2-externref-into-module.md`). The module
// does NOT mint an exception tag or throw: the program exception tag is
// guest-module-local, so the guest export
// `__wpk_fork_exception_materialize` (bound into the drive table, here the
// FAITHFUL guest double) owns the throw/`catch_ref`.
//
// Assertions:
//   (a) TRANSIT IDENTITY (silent-corruption-critical) — the token the injected
//       drive step publishes into the real anyref transit reads back
//       `Object.is`-identical to `tokens.materialize(handle)` (the canonical
//       token the module's lazy externref decode would also return).
//   (b) PROOF OF USE — `fm_exnrefs_reconstructed` advanced by the exnref-node
//       count (bookkeeping, from `fm_begin_reference_replay`) and the drive plan
//       actually resolved the payload exactly once through the host seam.
//   (c) MINT INERT — no exception tag is minted (the deleted `wpk_fork_host.*`
//       `host_mint_exception_tag` seam, H3, is gone — the module no longer
//       even declares the import).
//   (d) R1 GUARD IS LOAD-BEARING — when the host loses the reachable payload's
//       identity (`resolve_externref` returns null for it), the injected
//       non-null check TRAPS the drive rather than silently rooting a null/wrong
//       identity the guest's exception materialize would then throw with.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FORK_MODULE_STATS } from "../src/fork-module-backend";
import { instantiateForkModule } from "../src/fork-module-instance";
import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import { instantiateFaithfulGuest } from "./fork-module-faithful-guest";
import {
  CAPTURE_KIND_EXNREF,
  INTERN_KIND_EXTERNREF,
  captureGraph,
  childInstance,
  fixture,
  type Fixture,
} from "./fork-module-capture-fixture";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
const PID = 5151;
const GENERATION_ID = 9;
// The durable broker handle the exnref's reference payload names.
const PAYLOAD_HANDLE = 44;

/** `fm_stats` field indices, read from the one list the backend pins. */
const STAT = Object.fromEntries(
  FORK_MODULE_STATS.map((name, index) => [name, index]),
) as Record<(typeof FORK_MODULE_STATS)[number], number>;

/** The committed KFEC fixture: an activation declaring tags {0, 1, 2}. */
const EXCEPTION_CODEC = new Uint8Array(
  readFileSync(
    new URL("../../crates/fork-codec/testdata/exception-codec-wasm32.bin", import.meta.url),
  ),
);

const DRIVE_OP_ALLOC = 0;
const DRIVE_OP_FILL = 1;
const DRIVE_OP_EXN = 2;

/**
 * Build a sealed KFMS arena holding an exnref-over-externref graph:
 *   id 0 = canonical null
 *   id 1 = externref naming `PAYLOAD_HANDLE`
 *   id 2 = exnref whose reference payload edge names id 1 (transit-reachable)
 */
/**
 * CAPTURE an exnref over an externref payload, through the module.
 *
 * Constructed in TypeScript before, with the set-aside arena encoders, and then
 * asserted against recipe ids this file had chosen. The ids are the module's;
 * they come back from it now. For an exnref the aggregate's "type ordinal" IS
 * its TAG ordinal, which is what the admission gate below checks against the
 * tags an activation declared.
 */
function captureExnref(
  f: Fixture,
  tagOrdinal = 0,
): { root: number; exnId: number; payloadId: number } {
  const { root, recipes, aggregateRecipes } = captureGraph(
    f,
    [[INTERN_KIND_EXTERNREF, PAYLOAD_HANDLE, 0]],
    [
      {
        kind: CAPTURE_KIND_EXNREF,
        activation: 0,
        typeOrdinal: tagOrdinal,
        layoutId: 0,
        edges: ({ leaves }) => [leaves[0]!],
      },
    ],
  );
  return { root, exnId: aggregateRecipes[0]!, payloadId: recipes[0]! };
}

interface ForkModuleRefExports {
  fm_set_format: (pw: number, fixedPrefix: number) => void;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  // The single folded proof-of-use counter accessor; read via `FmStatField`.
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  fm_build_gc_plan: (pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_drive_execute: (ptr: number, count: number) => void;
  fm_drive_table_base: (act: number) => number;
  __wpk_fork_ref_exn_route: (recipeId: number, expectedActivation: number) => number;
  __wpk_fork_ref_exn_load: (
    recipeId: number,
    moduleActivation: number,
    tagOrdinal: number,
    layoutId: number,
    scalarDestination: number,
    scalarByteLength: number,
    referenceIdsDestination: number,
    referenceCount: number,
  ) => number;
  __wpk_fork_ref_exn_cache_index: (recipeId: number) => number;
  // The exnref tag-validity admission gate: seed one activation's declared tag
  // ordinals, then the child-install entry re-checks the graph against them.
  fm_set_activation_exception_codec: (
    activation: number,
    ptr: number,
    count: number,
  ) => void;
  fm_attach_child: (root: number, pid: number) => number;
}

/**
 * The CHILD module that replays what the parent captured.
 *
 * A second instance, because that is what a fork has: a parent seals and a
 * fresh child rebuilds. Replaying in the capturing instance would let a graph
 * the module never wrote to memory pass.
 */
function replayChild(f: Fixture, resolveExternref: (handle: number) => unknown) {
  const fm = childInstance(f, { label: "exnref-replay-child", resolveExternref });
  return { fm, x: fm.exports as unknown as ForkModuleRefExports };
}

/** Bind the FAITHFUL guest's `exception_materialize` (and, defensively, its
 *  alloc/fill) into the module's drive table at activation 0's slice, so the
 *  drive's DRIVE_OP_EXN `call_indirect` resolves. Also presizes the anyref
 *  transit table for the graph's max recipe id, mirroring the production
 *  `ForkActivationRegistry.ensureRecipeSlot(maxRecipeId)` presize the injected
 *  drive's `table.set` (unlike the retired host PHASE B) does NOT do itself. */
function bindFaithfulGuest(
  fm: ReturnType<typeof instantiateForkModule>,
  x: ForkModuleRefExports,
  maxRecipeId: number,
) {
  // The module's EXPORTS, not its transit TABLE: this wrapper reads
  // `__wpk_fork_ref_gc_transit`, `fm_transit_grow` and `fm_last_errno` off them.
  const transitTable = new ForkAnyrefTransitTable(
    fm.exports as Record<string, unknown>,
    "exnref-replay transit",
  );
  transitTable.ensureRecipeSlot(maxRecipeId);
  const { guest } = instantiateFaithfulGuest(transitTable);
  const base = x.fm_drive_table_base(0);
  if (fm.driveTable.length < base + 3) {
    fm.driveTable.grow(base + 3 - fm.driveTable.length);
  }
  fm.driveTable.set(base + DRIVE_OP_ALLOC, guest.gc_allocate);
  fm.driveTable.set(base + DRIVE_OP_FILL, guest.gc_fill);
  fm.driveTable.set(base + DRIVE_OP_EXN, guest.exception_materialize);
  return { transitTable, guest };
}

describe("fork-module exnref reference reconstruction + transit into production (Phase 6 D6.3a / M2)", () => {
  it("roots the exnref's reachable externref payload in the real anyref transit with identity parity, advances the counters, and never mints a tag", () => {
    const f = fixture();
    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    const hostCapabilities = createForkModuleHostCapabilities({ tokens });

    const { root, exnId, payloadId } = captureExnref(f);
    const { fm, x } = replayChild(f, hostCapabilities.imports.resolve_externref);

    const externrefsBefore = Number(x.fm_stats(STAT.externrefsResolved));
    const exnrefsBefore = Number(x.fm_stats(STAT.exnrefsReconstructed));

    // Seed the reference graph (bookkeeping only).
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (b) PROOF OF USE (graph admission) — one exnref admitted, one externref
    // node counted, purely from bookkeeping.
    expect(Number(x.fm_stats(STAT.exnrefsReconstructed)) - exnrefsBefore).toBe(1);
    expect(Number(x.fm_stats(STAT.externrefsResolved)) - externrefsBefore).toBe(1);

    // Build + execute the real drive plan: PHASE 0 publishes the reachable
    // externref payload into the anyref transit; the EXN step then drives the
    // guest's exception materialize.
    const planPtr = x.fm_build_gc_plan(PID);
    expect(x.fm_last_errno()).toBe(0);
    const count = x.fm_gc_plan_count();

    const { transitTable, guest } = bindFaithfulGuest(fm, x, 2);

    x.fm_drive_execute(planPtr, count);

    // (a) TRANSIT IDENTITY — the token the drive published for the payload is
    // the SAME object `tokens.materialize(handle)` returns (idempotent cache),
    // and it is what actually sits in the real anyref transit slot (recipe_id 1
    // -> slot 2).
    const canonical = tokens.materialize(PAYLOAD_HANDLE);
    expect(transitTable.get(2)).toBe(canonical);
    expect(hostCapabilities.resolvedCount).toBe(1);

    // The EXN step actually ran (the guest's exception_materialize order code).
    expect(guest.order()).toBe(3);

    // (c) MINT INERT — the drive never mints an exception tag: the guest
    // export owns exception materialization. This used to be proven by
    // spying on a `host_mint_exception_tag` stub (`wpk_fork_host.*` seam);
    // that seam was deleted (H3, 2026-09-06) because it was never wired to
    // any guest, so the proof is now structural: the module no longer even
    // declares the import.
  });

  it("R1 GUARD (wasm-level): a resolved-but-lost externref payload TRAPS the drive, never silently mis-roots the exnref's identity", () => {
    // The retired host `Object.is` R1 guard is replaced, in M2, by the injected
    // `fm_drive_execute` shim's non-null structural check on the transit slot
    // (see the design ruling). Simulate the host losing the payload's identity
    // (`resolve_externref` returns null for it): the DRIVE_OP_EXTERNREF_TRANSIT
    // step internalizes null, `table.set`s it, reads it back, and TRAPS —
    // failing loud rather than letting the guest's exception materialize
    // consume a null/wrong payload.
    const f = fixture();
    const { root, payloadId } = captureExnref(f);
    const { fm, x } = replayChild(f, () => null);

    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const planPtr = x.fm_build_gc_plan(PID);
    expect(x.fm_last_errno()).toBe(0);
    const count = x.fm_gc_plan_count();

    // Presize the transit table (mirrors production's `ensureRecipeSlot`) so the
    // trap below is the intended non-null structural check, not an unrelated
    // out-of-bounds `table.set` on a too-small default table.
    new ForkAnyrefTransitTable(
      fm.exports as Record<string, unknown>,
      "exnref R1 transit",
    ).ensureRecipeSlot(payloadId + 1);

    expect(() => x.fm_drive_execute(planPtr, count)).toThrowError(/unreachable/i);
  });

  it("serves the exnref RESTORE data-feed through the module (item 3a): route, cache index, and scalar/reference loads match the decoded graph", () => {
    // Phase 6 item 3a: the exnref restore imports the guest exception codec used
    // to call on the JS reference provider now resolve to the module's `fm_ref_*`
    // exports. Drive them directly against the seeded feed and prove the MODULE
    // produced JS-identical results, in a real WebAssembly engine. This data
    // feed does not touch the externref transit at all, so a resolver that is
    // never expected to be called is enough.
    const f = fixture();
    const memory = f.memory;
    const { root, exnId, payloadId } = captureExnref(f);
    const { x } = replayChild(f, () => {
      throw new Error("resolve_externref should not be called by the data feed");
    });
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const readsBefore = Number(x.fm_stats(STAT.referenceFeedReads));

    // The exnref: activation 0, tag 0, layout 0, no scalars, one payload edge.
    // Ids are the module's, read back from the capture.
    expect(x.__wpk_fork_ref_exn_route(exnId, 0)).toBe(0); // layout id
    expect(x.__wpk_fork_ref_exn_route(exnId, 9)).toBe(-1); // wrong activation
    expect(x.__wpk_fork_ref_exn_cache_index(exnId)).toBe(1); // first (only) exnref

    // Load the exnref: no scalar bytes, one reference-payload recipe id (LE u32).
    const refIdsDst = 13 * 1024 * 1024;
    expect(x.__wpk_fork_ref_exn_load(exnId, 0, 0, 0, refIdsDst, 0, refIdsDst, 1)).toBe(1);
    expect(new Uint32Array(memory.buffer, refIdsDst, 1)[0]).toBe(payloadId);

    // PROOF OF USE: the module served every one of these feed reads.
    expect(Number(x.fm_stats(STAT.referenceFeedReads)) - readsBefore).toBeGreaterThan(0);
  });
});

// Exnref tag-validity ADMISSION gate (moved out of the host into the module's
// child-install entry). The gate is a fail-loud SECURITY boundary: an exnref
// recipe whose wasm tag its owning activation's exception codec never declared
// must be REJECTED (`EINVAL`) BEFORE the module drives the DRIVE_OP_EXN
// materialize step, so a corrupt / mismatched exception recipe dies truthfully
// rather than being `call_indirect`-driven blindly through the guest export.
// This is the module-side successor to the deleted host boundary
// `assertForkModuleExnrefTagsDeclared`.
describe("fork-module exnref tag-validity admission gate (fm_attach_child)", () => {
  const EINVAL = 22;

  /** Seed activation 0's declared exnref tags, then invoke the coarse
   *  child-install entry against `root` and return its `fm_last_errno`. */
  /**
   * Attach a child after declaring an activation's exception tags -- or not.
   *
   * The tags arrive as the guest's own KFEC SECTION, not as a host-decoded u32
   * array. `fm_set_activation_exception_tags` took the array and was DELETED
   * for exactly that reason: decoding the section to produce it made the host a
   * second decoder of a module-owned format. The committed fixture declares
   * tags {0, 1, 2}, which is what `declareTags` seeds; `false` seeds nothing,
   * for the activation-declared-no-codec case.
   */
  function attachWithSeededTags(
    f: Fixture,
    root: number,
    declareTags: boolean,
  ): { errno: number; x: ForkModuleRefExports } {
    const memory = f.memory;
    const { x } = replayChild(f, () => {
      throw new Error("resolve_externref must not run: the gate rejects first");
    });

    if (declareTags) {
      const scratch = memory.buffer.byteLength;
      memory.grow(1);
      new Uint8Array(memory.buffer, scratch, EXCEPTION_CODEC.byteLength).set(
        EXCEPTION_CODEC,
      );
      x.fm_set_activation_exception_codec(0, scratch, EXCEPTION_CODEC.byteLength);
      expect(x.fm_last_errno(), "the codec section is accepted").toBe(0);
    }

    x.fm_attach_child(root, PID);
    return { errno: x.fm_last_errno(), x };
  }

  it("REJECTS an exnref recipe naming a tag its activation never declared (EINVAL)", () => {
    const f = fixture();
    // The captured exnref names tag 7, but activation 0's exception codec
    // declares {0, 1, 2}: a corrupt / mismatched recipe the gate must reject.
    const { root } = captureExnref(f, 7);
    const { errno } = attachWithSeededTags(f, root, true);
    expect(errno).toBe(EINVAL);
  });

  it("REJECTS an exnref whose activation declared no exception tags at all (EINVAL)", () => {
    const f = fixture();
    // A well-formed tag ordinal (0), but NOTHING seeded for activation 0: an
    // exnref naming an activation with no declared codec is still a violation,
    // never a silent admit.
    const { root } = captureExnref(f, 0);
    const { errno } = attachWithSeededTags(f, root, false);
    expect(errno).toBe(EINVAL);
  });

  it("ADMITS an exnref recipe whose tag its activation declares (well-formed fork)", () => {
    const f = fixture();
    // The well-formed case: tag 0 is declared, so the gate passes and the
    // child-install entry builds the reconstruction plan (errno 0).
    const { root } = captureExnref(f, 0);
    const { errno } = attachWithSeededTags(f, root, true);
    expect(errno).toBe(0);
  });
});
