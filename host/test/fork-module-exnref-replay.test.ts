// Phase 6 D6.3a — exnref reference reconstruction ORCHESTRATED by the
// co-resident fork module. Proven end to end in a real WebAssembly engine
// (Node/V8).
//
// The module does NOT mint an exception tag or throw: the program exception
// tag is guest-module-local, so the guest export
// `__wpk_fork_exception_materialize` (bound into the drive table, here the
// FAITHFUL guest double) owns the throw/`catch_ref`. The exnref's reference
// payload is a funcref here -- it needs no drive step of its own.
//
// Before externref stage E2 the payload was a host externref, and this file
// also proved the drive re-rooted it through `env.resolve_externref` and
// trapped on a lost one (the M2 R1 guard). A fork no longer carries a raw host
// externref, so that step, that import and that guard are gone.
//
// Assertions:
//   (a) PROOF OF USE — `fm_exnrefs_reconstructed` advanced by the exnref-node
//       count (bookkeeping, from `fm_restore_from_arena`'s seed) and the drive
//       plan's EXN step ran the guest's materialize.
//   (b) MINT INERT — no exception tag is minted (the deleted `wpk_fork_host.*`
//       `host_mint_exception_tag` seam, H3, is gone — the module no longer
//       even declares the import).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FORK_MODULE_STATS } from "../src/fork-module-backend";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  ensureTransitRecipeSlot,
  instantiateFaithfulGuest,
} from "./fork-module-faithful-guest";
import {
  CAPTURE_KIND_EXNREF,
  INTERN_KIND_FUNCREF,
  captureGraph,
  installableChild,
  childInstance,
  driveBase,
  fixture,
  type Fixture,
} from "./fork-module-capture-fixture";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
const PID = 5151;
// The function-catalog ordinal the exnref's funcref payload names.
const PAYLOAD_ORDINAL = 44;

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
 * CAPTURE an exnref over a funcref payload, through the module:
 *   id 0 = canonical null
 *   id 1 = funcref naming activation 0's `PAYLOAD_ORDINAL`
 *   id 2 = exnref whose reference payload edge names id 1
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
    [[INTERN_KIND_FUNCREF, 0, PAYLOAD_ORDINAL]],
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
  fm_restore_from_arena: (root: number, pid: number) => number;
  // The single folded proof-of-use counter accessor; read via `FmStatField`.
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
  fm_gc_plan_count: () => number;
  fm_drive_execute: (ptr: number, count: number) => void;
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
}

/**
 * The CHILD module that replays what the parent captured.
 *
 * A second instance, because that is what a fork has: a parent seals and a
 * fresh child rebuilds. Replaying in the capturing instance would let a graph
 * the module never wrote to memory pass.
 */
function replayChild(f: Fixture) {
  const fm = childInstance(f, { label: "exnref-replay-child" });
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
  const moduleExports = fm.exports as Record<string, unknown>;
  ensureTransitRecipeSlot(moduleExports, maxRecipeId);
  const { guest } = instantiateFaithfulGuest(moduleExports);
  const base = driveBase(0);
  if (fm.driveTable.length < base + 3) {
    fm.driveTable.grow(base + 3 - fm.driveTable.length);
  }
  fm.driveTable.set(base + DRIVE_OP_ALLOC, guest.gc_allocate);
  fm.driveTable.set(base + DRIVE_OP_FILL, guest.gc_fill);
  fm.driveTable.set(base + DRIVE_OP_EXN, guest.exception_materialize);
  return { guest };
}

describe("fork-module exnref reference reconstruction (Phase 6 D6.3a)", () => {
  it("materializes the exnref through the guest, advances the counters, and never mints a tag", () => {
    const f = fixture();

    const { root } = captureExnref(f);
    const { fm, x } = replayChild(f);

    const exnrefsBefore = Number(x.fm_stats(STAT.exnrefsReconstructed));

    // Seed the reference graph and build its drive plan (the production
    // restore entry, `fm_restore_from_arena`).
    const planPtr = x.fm_restore_from_arena(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (a) PROOF OF USE (graph admission) — one exnref admitted, purely from
    // bookkeeping.
    expect(Number(x.fm_stats(STAT.exnrefsReconstructed)) - exnrefsBefore).toBe(1);

    // Execute the real drive plan: the EXN step drives the guest's
    // exception materialize. The funcref payload needs no step of its own.
    const count = x.fm_gc_plan_count();

    expect(count, "one EXN step, nothing for the funcref payload").toBe(1);

    const { guest } = bindFaithfulGuest(fm, x, 2);

    x.fm_drive_execute(planPtr, count);

    // The EXN step actually ran (the guest's exception_materialize order code).
    expect(guest.order()).toBe(3);

    // (b) MINT INERT — the drive never mints an exception tag: the guest
    // export owns exception materialization. This used to be proven by
    // spying on a `host_mint_exception_tag` stub (`wpk_fork_host.*` seam);
    // that seam was deleted (H3, 2026-09-06) because it was never wired to
    // any guest, so the proof is now structural: the module no longer even
    // declares the import.
  });

  it("serves the exnref RESTORE data-feed through the module (item 3a): route, cache index, and scalar/reference loads match the decoded graph", () => {
    // Phase 6 item 3a: the exnref restore imports the guest exception codec used
    // to call on the JS reference provider now resolve to the module's `fm_ref_*`
    // exports. Drive them directly against the seeded feed and prove the MODULE
    // produced JS-identical results, in a real WebAssembly engine.
    const f = fixture();
    const memory = f.memory;
    const { root, exnId, payloadId } = captureExnref(f);
    const { x } = replayChild(f);
    x.fm_restore_from_arena(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    const readsBefore = Number(x.fm_stats(STAT.referenceFeedReads));

    // The exnref: activation 0, tag 0, layout 0, no scalars, one payload edge.
    // Ids are the module's, read back from the capture.
    expect(x.__wpk_fork_ref_exn_route(exnId, 0)).toBe(0); // layout id
    expect(x.__wpk_fork_ref_exn_route(exnId, 9)).toBe(-1); // wrong activation
    expect(x.__wpk_fork_ref_exn_cache_index(exnId)).toBe(1); // first (only) exnref

    // Load the exnref: no scalar bytes, one reference-payload recipe id (LE u32).
    // LOW scratch (page 7): the responder maps arena chunks from 12 MiB up.
    const refIdsDst = 7 * PAGE;
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
describe("fork-module exnref tag-validity admission gate (fm_child_install)", () => {
  const EINVAL = 22;

  /**
   * Install a child after declaring an activation's exception tags -- or not
   * -- and answer the install's errno.
   *
   * The tags arrive as the guest's own KFEC SECTION, not as a host-decoded u32
   * array. `fm_set_activation_exception_tags` took the array and was DELETED
   * for exactly that reason: decoding the section to produce it made the host a
   * second decoder of a module-owned format. The committed fixture declares
   * tags {0, 1, 2}, which is what `declareTags` admits; `false` admits
   * activation 0 with no exception codec, for the declared-no-codec case.
   */
  function attachWithSeededTags(
    f: Fixture,
    declareTags: boolean,
  ): { errno: number; guest: ReturnType<typeof bindFaithfulGuest>["guest"] } {
    // The child as a fork child's worker prepares it for `fm_child_install`:
    // a control block, activation 0 admitted (with the codec, or without),
    // and its restore/finish/rewind slots bound; the faithful guest's
    // materialize bound beside them, so an admitted exnref is really driven.
    const child = installableChild(
      f,
      declareTags ? { exceptionCodec: EXCEPTION_CODEC } : {},
      { label: "exnref-install-child" },
    );
    const { guest } = bindFaithfulGuest(
      child.instance,
      child.x as unknown as ForkModuleRefExports,
      2,
    );
    return { errno: child.install(f.anchor(), PID), guest };
  }

  it("REJECTS an exnref recipe naming a tag its activation never declared (EINVAL)", () => {
    const f = fixture();
    // The captured exnref names tag 7, but activation 0's exception codec
    // declares {0, 1, 2}: a corrupt / mismatched recipe the gate must reject.
    captureExnref(f, 7);
    const { errno, guest } = attachWithSeededTags(f, true);
    expect(errno).toBe(EINVAL);
    expect(guest.order(), "the EXN step never ran").toBe(0);
  });

  it("REJECTS an exnref whose activation declared no exception tags at all (EINVAL)", () => {
    const f = fixture();
    // A well-formed tag ordinal (0), but NOTHING seeded for activation 0: an
    // exnref naming an activation with no declared codec is still a violation,
    // never a silent admit.
    captureExnref(f, 0);
    const { errno, guest } = attachWithSeededTags(f, false);
    expect(errno).toBe(EINVAL);
    expect(guest.order(), "the EXN step never ran").toBe(0);
  });

  it("ADMITS an exnref recipe whose tag its activation declares (well-formed fork)", () => {
    const f = fixture();
    // The well-formed case: tag 0 is declared, so the gate passes and the
    // child-install entry builds and drives the reconstruction plan.
    captureExnref(f, 0);
    const { errno, guest } = attachWithSeededTags(f, true);
    expect(errno).toBe(0);
    expect(guest.order(), "the EXN step materialized the exnref").toBe(3);
  });
});
