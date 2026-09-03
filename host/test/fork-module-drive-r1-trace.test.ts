// Phase 6 item 3c — EMPIRICAL trace + regression cover for the GC DRIVE
// post-allocate integrity check, now reading the CORRECT store.
//
// WHAT THIS PINS DOWN
// -------------------
// The co-resident fork module's real topological GC drive plan
// (`fm_build_gc_plan`, crates/fork-codec/src/drive_plan.rs) emits a
// `DRIVE_OP_ALLOC` step for EVERY typed-GC recipe — struct, array, AND i31 —
// carrying that recipe's own id. The injected `fm_drive_execute` shim
// (crates/fork-module-inject) `call_indirect`s the guest's `_gc_allocate` for
// each ALLOC step and then verifies the guest published a live GC object.
//
// THE FIX (what this file now locks in). The shim's post-ALLOC integrity check
// reads STORE #2 — the shared Wasm-GC transit table `__wpk_fork_ref_gc_transit`,
// the table the guest's `allocate` export publishes every struct/array/i31 into
// at slot `recipe + 1` (crates/fork-instrument/src/module_gc_codec.rs) and that
// `_gc_fill` consumes — with a wasm `table.get` + `ref.is_null`, trapping only on
// a genuinely null (never-published) slot.
//
// Previously the shim `call`ed the module's Rust `fm_after_alloc(recipe)`, which
// read STORE #1: the HOST-externref transit through `host_transit_read`
// (host/src/fork-module-host-capabilities.ts), whose slot map is populated ONLY
// by PHASE B of `drive_reconstruction` (crates/fork-codec/src/reference_replay.rs)
// for externref LEAVES — NEVER for a struct/array/i31 AGGREGATE. So every typed
// drive read an unpublished slot and TRAPPED. The commit that added this file
// (db33d616f) measured that trap for struct→i31, struct↔array, mixed
// struct+externref, and bare i31. Those `THREW`/`MISS` expectations are the ones
// that FLIP here: with the store-#2 read, the guest's own `_gc_allocate` publish
// satisfies the check and the drive COMPLETES.
//
// In production STORE #1 and STORE #2 are the SAME `(ref null any)` table
// (`ForkActivationRegistry.gcTransit`): `host_transit_publish` (PHASE B) and the
// guest's `allocate` both write into it, at different slots. The bug was never
// two tables — it was the Rust R1 read consulting the HOST's slot MAP (which only
// tracks host-published externref leaves) instead of the table itself. This test
// uses ONE `ForkAnyrefTransitTable` for both, exactly like production.
//
// VEHICLE: the real `fork_module` + real `host_transit_*` seam
// (`createForkModuleHostCapabilities`) + a FAITHFUL guest double
// (`fork-module-faithful-guest.ts`) bound into the drive table, seeding a REAL
// multi-node reference graph (arena + `fm_begin_reference_replay`, running the
// REAL Rust PHASE A/B) plus the committed GC-codec fixture, then the REAL
// `fm_build_gc_plan` + `fm_drive_execute`. The faithful double's `gc_allocate`
// publishes a live identity into STORE #2 at `recipe + 1` — the store the shim's
// wasm check reads — mid-drive, mirroring the guest's real `table.set`. The seam
// is INSTRUMENTED by wrapping its import functions in the test only (production is
// byte-identical; no source or ABI change).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  createForkModuleHostCapabilities,
  type ForkModuleTransitAdapter,
} from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import { ForkModuleStateArena } from "../src/fork-module-state";
import type { ForkReferenceRecipeEntry } from "../src/fork-reference-recipes";
import {
  appendSegmentedForkReferenceTransaction,
  PagedForkReferenceVector,
  type ForkReferenceVector,
} from "../src/fork-reference-segments";
import { WPK_FORK_REFERENCE_TRANSACTION_OWNER } from "../src/generated/abi";
import { instantiateFaithfulGuest } from "./fork-module-faithful-guest";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
const PID = 7373;
const GENERATION_ID = 11;
const LEAF_HANDLE = 77;

// The drive-plan op codes and step layout are the contract shared with the Rust
// `drive_plan` module and the injected shim (16-byte steps: op@0, slot@4,
// recipe@8, arg@12).
const DRIVE_OP_ALLOC = 0;
const DRIVE_OP_FILL = 1;
const DRIVE_OP_EXN = 2;
const STEP_SIZE = 16;

// The committed GC-codec (KFGC) fixture the Rust `fork-codec` decoder tests use.
// Its layout 1 is a struct (type ordinal 0, DEFAULTABLE_SHELL, two reference
// fields); its layout 4 is a generic array (type ordinal 3, one reference
// element, no constructor dependencies). Both are activation-0 layouts. Seeding
// it lets `fm_build_gc_plan` resolve the struct/array coordinates and the i31
// owner (the smallest GC-declaring activation = 0).
const GC_CODEC = new Uint8Array(
  readFileSync(new URL("../../crates/fork-codec/testdata/gc-codec-wasm32.bin", import.meta.url)),
);

const MODULE = new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));

/** A REAL transit adapter over the production `(ref null any)` table (recipeId+1
 *  slot), exactly what `fork-module-gc-replay.test.ts` wires. In production this
 *  is the SAME table the guest publishes aggregates into and the shim reads. */
function realTransit(table: ForkAnyrefTransitTable): ForkModuleTransitAdapter {
  return {
    publish: (recipeId, value) => {
      table.ensureRecipeSlot(recipeId);
      table.set(recipeId + 1, value);
    },
    read: (recipeId) => table.get(recipeId + 1),
  };
}

/** Seed a sealed KFMS arena holding `nodes`, then place the GC-codec fixture
 *  bytes just past it so `fm_set_activation_gc_codec` can copy them from guest
 *  memory. Node 0 MUST be the canonical null (the capture validator requires it). */
function buildArena(memory: WebAssembly.Memory, nodes: ForkReferenceRecipeEntry[]): {
  root: number;
  codecPtr: number;
} {
  let next = PAGE;
  const allocate = (size: number): number => {
    const addr = next;
    next += size;
    if (next > memory.buffer.byteLength) {
      memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE));
    }
    return addr;
  };
  const arena = new ForkModuleStateArena(memory, PTR_WIDTH, allocate, () => {}, "r1-trace");
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];
  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xa0) });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    nodes,
    vectors,
    { segmentDataBytes: 48 },
  );
  arena.seal();
  const codecPtr = allocate(GC_CODEC.byteLength);
  new Uint8Array(memory.buffer, codecPtr, GC_CODEC.byteLength).set(GC_CODEC);
  return { root, codecPtr };
}

interface ForkDriveExports {
  fm_set_format: (pw: number, fp: number) => void;
  fm_set_activation_gc_codec: (act: number, ptr: number, len: number) => void;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_build_gc_plan: (pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_drive_execute: (ptr: number, count: number) => void;
  fm_drive_table_base: (act: number) => number;
  fm_last_errno: () => number;
}

interface SeamCall {
  name: string;
  args: number[];
  ret: number;
}
interface DriveStep {
  op: number;
  slot: number;
  recipe: number;
  arg: number;
}
interface ShapeTrace {
  replayErr: number;
  planErr: number;
  planBuilt: boolean;
  steps: DriveStep[];
  /** Every `host_transit_publish(gen, slot, value)` -> ret observed anywhere. */
  publishes: SeamCall[];
  /** `host_begin_generation` -> ret observed (settles "a generation is opened"). */
  generations: number[];
  /** `host_transit_read` calls made DURING `fm_drive_execute`. With the store-#2
   *  fix the drive no longer touches the host seam at all, so this is EMPTY. */
  driveReads: SeamCall[];
  /** `host_transit_read` calls made during PHASE B of `fm_begin_reference_replay`. */
  phaseBReads: SeamCall[];
  /** Recipe ids the guest's `gc_allocate` published into STORE #2, in order. */
  published: number[];
  /** The transit slots (`recipe + 1`) non-null in STORE #2 after the drive. */
  liveSlots: number[];
  threw: boolean;
  guestOrder: number;
  guestSeq: number;
}

/** Drive one graph shape through the real module + real seam + faithful guest and
 *  capture the full trace. The seam is instrumented by wrapping its imports (test
 *  only). ONE anyref transit table backs both the host seam (STORE #1 externref
 *  PHASE B) and the guest/shim (STORE #2 aggregates), exactly like production. */
function runShape(nodes: ForkReferenceRecipeEntry[]): ShapeTrace {
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 16384, shared: true });
  const tokens = new ForkExternrefTokenCache(GENERATION_ID);
  const transitTable = new ForkAnyrefTransitTable();
  const caps = createForkModuleHostCapabilities({
    tokens,
    generationId: GENERATION_ID,
    transit: realTransit(transitTable),
  });

  const log: SeamCall[] = [];
  const traced: Record<string, (...a: number[]) => number> = {};
  for (const k of Object.keys(caps.imports)) {
    traced[k] = (...args: number[]) => {
      const ret = caps.imports[k](...args);
      if (k === "host_begin_generation" || k === "host_transit_publish" || k === "host_transit_read") {
        log.push({ name: k, args: [...args], ret });
      }
      return ret;
    };
  }

  const { root, codecPtr } = buildArena(memory, nodes);
  const fm = instantiateForkModule({
    module: MODULE,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => 8 * 1024 * 1024,
    label: "r1-trace",
    hostCapabilities: traced,
    // STORE #2: the SAME table the guest publishes aggregates into. The shim's
    // post-ALLOC integrity check reads it back with a wasm table.get + ref.is_null.
    transitTable: transitTable.table,
  });
  const x = fm.exports as unknown as ForkDriveExports;

  x.fm_set_format(PTR_WIDTH, 0);
  x.fm_set_activation_gc_codec(0, codecPtr, GC_CODEC.byteLength);
  expect(x.fm_last_errno()).toBe(0);

  x.fm_begin_reference_replay(root, PID);
  const replayErr = x.fm_last_errno();
  const phaseBReads = log.filter((c) => c.name === "host_transit_read");

  const planPtr = x.fm_build_gc_plan(PID);
  const planErr = x.fm_last_errno();
  const count = x.fm_gc_plan_count();
  const dv = new DataView(memory.buffer);
  const steps: DriveStep[] = [];
  for (let i = 0; i < count; i++) {
    const b = planPtr + i * STEP_SIZE;
    steps.push({
      op: dv.getUint32(b, true),
      slot: dv.getUint32(b + 4, true),
      recipe: dv.getUint32(b + 8, true),
      arg: dv.getUint32(b + 12, true),
    });
  }

  // Bind the FAITHFUL guest exports into the host-owned drive table so the shim's
  // `call_indirect`s resolve (base+ALLOC, base+FILL, base+EXN). The guest's
  // `gc_allocate` publishes a live identity into STORE #2 (the shared
  // `transitTable`) at `recipe + 1` mid-drive.
  const { guest, published } = instantiateFaithfulGuest(transitTable);
  const base = x.fm_drive_table_base(0);
  if (fm.driveTable.length < base + 3) fm.driveTable.grow(base + 3 - fm.driveTable.length);
  fm.driveTable.set(base + DRIVE_OP_ALLOC, guest.gc_allocate);
  fm.driveTable.set(base + DRIVE_OP_FILL, guest.gc_fill);
  fm.driveTable.set(base + DRIVE_OP_EXN, guest.exception_materialize);

  const preDriveLen = log.length;
  let threw = false;
  if (planPtr !== 0) {
    try {
      x.fm_drive_execute(planPtr, count);
    } catch {
      threw = true;
    }
  }
  const driveLog = log.slice(preDriveLen);

  // Which STORE #2 slots hold a live (non-null) identity after the drive.
  const liveSlots: number[] = [];
  for (let slot = 1; slot < transitTable.table.length; slot++) {
    if (transitTable.get(slot) !== null) liveSlots.push(slot);
  }

  return {
    replayErr,
    planErr,
    planBuilt: planPtr !== 0,
    steps,
    publishes: log.filter((c) => c.name === "host_transit_publish"),
    generations: log.filter((c) => c.name === "host_begin_generation").map((c) => c.ret),
    driveReads: driveLog.filter((c) => c.name === "host_transit_read"),
    phaseBReads,
    published: [...published],
    liveSlots,
    threw,
    guestOrder: guest.order(),
    guestSeq: guest.seq(),
  };
}

// -- Graph shape builders (node 0 is always the canonical null) ---------------
const NULL: ForkReferenceRecipeEntry = { id: 0, node: { kind: "null" } };
const struct = (id: number, fields: number[]): ForkReferenceRecipeEntry => ({
  id,
  // Fixture layout 1: struct, type ordinal 0, defaultable shell, two ref fields.
  node: { kind: "struct", moduleActivation: 0, typeOrdinal: 0, layoutId: 1, scalars: new Uint8Array(4), fields },
});
const array = (id: number, elements: number[]): ForkReferenceRecipeEntry => ({
  id,
  // Fixture layout 4: generic array, type ordinal 3, one ref element, no deps.
  node: { kind: "array", moduleActivation: 0, typeOrdinal: 3, layoutId: 4, scalars: new Uint8Array(0), elements },
});
const i31 = (id: number, value: number): ForkReferenceRecipeEntry => ({ id, node: { kind: "i31", value } });
const externref = (id: number, handle: number): ForkReferenceRecipeEntry => ({ id, node: { kind: "externref", handle } });
const exnref = (id: number): ForkReferenceRecipeEntry => ({
  id,
  node: { kind: "exnref", moduleActivation: 0, tagOrdinal: 0, layoutId: 0, scalars: new Uint8Array(0), payloads: [] },
});

describe("fork-module GC drive store-#2 integrity check (Phase 6 item 3c)", () => {
  // FLIPPED FROM THE GAP: each struct/array/i31 shape below now COMPLETES (the
  // db33d616f trace measured these as trapping). The shim's post-ALLOC check
  // reads STORE #2 (the guest's transit table), which the faithful guest's
  // `gc_allocate` publishes into — so the check passes and the drive runs to the
  // end. The drive touches the host seam ZERO times (driveReads is empty),
  // proving the read moved off store #1.

  it("Shape 1 — single struct over i31 leaves (typed, NO externref): every ALLOC publishes store #2 and the drive COMPLETES", () => {
    // struct(1) [layout 1] fields -> i31(2); no externref anywhere.
    const t = runShape([NULL, struct(1, [2, 2]), i31(2, 7)]);

    expect(t.replayErr).toBe(0); // reconstruction admits a typed-only graph
    expect(t.planBuilt).toBe(true); // the real plan builds
    // The plan ALLOCs the struct (recipe 1) AND the i31 (recipe 2) — proving i31
    // is an ALLOC-emitting recipe too, then FILLs the struct.
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([
      [DRIVE_OP_ALLOC, 1],
      [DRIVE_OP_ALLOC, 2],
      [DRIVE_OP_FILL, 1],
    ]);
    // The guest's gc_allocate published a live identity into STORE #2 for EACH
    // ALLOC recipe (struct 1, i31 2), at slots recipe+1 = 2 and 3.
    expect(t.published).toEqual([1, 2]);
    expect(t.liveSlots).toEqual([2, 3]);
    // No externref leaf -> PHASE B published nothing into store #1.
    expect(t.publishes).toHaveLength(0);
    // The drive reads STORE #2 in wasm, never the host seam: no host_transit_read
    // happens during the drive.
    expect(t.driveReads).toHaveLength(0);
    // Guest ran alloc, alloc, fill (order 1,1,2 -> 112) and did not trap.
    expect(t.guestSeq).toBe(3);
    expect(t.guestOrder).toBe(112);
    expect(t.threw).toBe(false);
  });

  it("Shape 2 — struct<->array cycle (NO externref leaf): allocate-all-first, both aggregates publish store #2, the drive COMPLETES", () => {
    // struct(1) <-> array(2), no externref leaf.
    const t = runShape([NULL, struct(1, [2, 2]), array(2, [1])]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    // Allocate-all-first breaks the cycle: ALLOC struct(1), ALLOC array(2), then
    // FILL both.
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([
      [DRIVE_OP_ALLOC, 1],
      [DRIVE_OP_ALLOC, 2],
      [DRIVE_OP_FILL, 1],
      [DRIVE_OP_FILL, 2],
    ]);
    expect(t.published).toEqual([1, 2]);
    expect(t.liveSlots).toEqual([2, 3]);
    expect(t.publishes).toHaveLength(0);
    expect(t.driveReads).toHaveLength(0);
    expect(t.guestSeq).toBe(4);
    expect(t.guestOrder).toBe(1122); // alloc,alloc,fill,fill
    expect(t.threw).toBe(false);
  });

  it("Shape 3 — struct with ONE externref-leaf field (MIXED): PHASE B publishes the LEAF into store #1 and the AGGREGATE publishes store #2; the drive COMPLETES", () => {
    // struct(1) [layout 1] fields -> externref(2). The diagnostic shape: the
    // externref leaf gets a host-published slot AND the struct publishes its own.
    const t = runShape([NULL, struct(1, [2, 2]), externref(2, LEAF_HANDLE)]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    // Only the struct drives (ALLOC + FILL); the externref emits no drive step.
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([
      [DRIVE_OP_ALLOC, 1],
      [DRIVE_OP_FILL, 1],
    ]);
    // PHASE B published EXACTLY the externref leaf's slot: recipe 2 -> slot 3.
    expect(t.publishes.map((c) => c.args[1])).toEqual([3]);
    // PHASE B read the leaf slot back with a HIT (returns the rooted ordinal, !=0).
    expect(t.phaseBReads.map((c) => [c.args[1], c.ret === 0 ? "MISS" : "HIT"])).toEqual([[3, "HIT"]]);
    // The guest published the struct aggregate into store #2 at slot 2.
    expect(t.published).toEqual([1]);
    // Both the aggregate (slot 2) and the PHASE-B externref leaf (slot 3) are live
    // in the SAME table.
    expect(t.liveSlots).toEqual([2, 3]);
    // The drive itself never reads the host seam.
    expect(t.driveReads).toHaveLength(0);
    expect(t.threw).toBe(false);
  });

  it("Shape 4 — a bare i31 leaf: even a scalar i31 ALLOC publishes store #2 and the drive COMPLETES", () => {
    // A pure i31 needs no host identity, yet it still gets an ALLOC step; the
    // guest's gc_allocate publishes its store-#2 slot so the shim's check passes.
    const t = runShape([NULL, i31(1, -17)]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([[DRIVE_OP_ALLOC, 1]]);
    expect(t.published).toEqual([1]);
    expect(t.liveSlots).toEqual([2]);
    expect(t.publishes).toHaveLength(0);
    expect(t.driveReads).toHaveLength(0);
    expect(t.guestSeq).toBe(1);
    expect(t.guestOrder).toBe(1);
    expect(t.threw).toBe(false);
  });

  it("Shape 5 — a program exnref (no externref payload): emits an EXN step, runs NO store-#2 check, and the drive COMPLETES", () => {
    // An exnref materialize is `DRIVE_OP_EXN`, which the shim does NOT follow with
    // the store-#2 integrity check. So an exnref-only graph drives cleanly and
    // publishes nothing — the check is specific to ALLOC-emitting recipes.
    const t = runShape([NULL, exnref(1)]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([[DRIVE_OP_EXN, 1]]);
    // No store-#2 publish (no ALLOC) and no host seam read during the drive.
    expect(t.published).toHaveLength(0);
    expect(t.driveReads).toHaveLength(0);
    expect(t.threw).toBe(false);
    // The guest exception_materialize (order code 3) actually ran.
    expect(t.guestOrder).toBe(3);
  });

  // POSITIVE store-#2 invariant. The repoint depends on the guest's `allocate`
  // publishing a live GC object into the transit table at `recipe + 1` for EVERY
  // ALLOC-emitting recipe kind (struct, array, i31). A multi-kind graph driven
  // through the module must leave all three aggregate slots non-null AND complete.
  // Asserting it here means a future guest-glue change that stops publishing
  // re-breaks THIS test (the shim would trap), not silently the whole drive.
  it("POSITIVE — struct, array, and i31 each publish a live store-#2 slot; the module drive completes reading them", () => {
    // struct(1) -> array(2) -> i31(3): one of each ALLOC-emitting kind.
    const t = runShape([NULL, struct(1, [2, 2]), array(2, [3]), i31(3, 9)]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    const allocRecipes = t.steps.filter((s) => s.op === DRIVE_OP_ALLOC).map((s) => s.recipe);
    // All three kinds allocate.
    expect(new Set(allocRecipes)).toEqual(new Set([1, 2, 3]));
    // The guest published a live store-#2 identity for each ALLOC recipe.
    expect(new Set(t.published)).toEqual(new Set([1, 2, 3]));
    // Every ALLOC recipe's slot (recipe + 1) is non-null in the transit table.
    for (const recipe of allocRecipes) {
      expect(t.liveSlots).toContain(recipe + 1);
    }
    // The module drove all three allocates + their fills to completion, reading
    // store #2 in wasm and never the host seam.
    expect(t.driveReads).toHaveLength(0);
    expect(t.threw).toBe(false);
    // Every plan step ran through a guest export (proof the drive completed).
    expect(t.guestSeq).toBe(t.steps.length);
  });

  // GATE for the full 3c PRODUCTION FLIP. A multi-node typed graph driven with
  // the module (flag-on) must reconstruct the SAME references as the proven JS
  // drive-order (flag-off).
  //
  // The REAL instrumented multi-node guest this gate needs now EXISTS:
  // `host/test/gc-reference-cycle-fresh-worker.test.ts` forks a struct<->array
  // cycle and its child self-verifies via ref.eq; it already passes flag-off AND
  // flag-on (parity). What is still missing is the production DRIVE flip itself:
  //
  //   1. The typed drive-ORDER for a forked child runs in the JS
  //      `ForkReferenceTransaction.materializeAllTyped`
  //      (host/src/fork-reference-transaction.ts) — NOT the imported-globals
  //      `ForkEarlyChildReferenceProvider.materializeTypedGraph`. It is invoked
  //      from `ForkActivationRegistry.restoreModuleState`, which the coordinator
  //      `ForkProcessContinuationCoordinator.attachModuleChild` calls at
  //      host/src/fork-process-continuation.ts ~line 1012, immediately AFTER
  //      `backend.beginReferenceReplay(arena.rootAddress())` (~line 1010). That
  //      gap is the clean seam: the module graph is already seeded there, and the
  //      coordinator holds BOTH `moduleBackend` and `registry`.
  //   2. Unbuilt production wiring for the flip: seed each activation's KFGC bytes
  //      via `fm_set_activation_gc_codec`, seed `fm_set_host_exception_owner`,
  //      then call `fm_build_gc_plan(pid)` + `fm_drive_execute(ptr,
  //      fm_gc_plan_count())` (the guest `_gc_allocate`/`_gc_fill` are already
  //      bound into the drive table at item 3b, worker-main.ts ~line 4708), while
  //      SUPPRESSING only the typed allocate/fill/exn sub-loop of
  //      `materializeAllTyped` (PHASE A/B externref publish + static-root pin must
  //      stay).
  //   3. A drive-proof counter distinct from the item-3a feed counter
  //      (`fm_gc_nodes_reconstructed`) must be added — the drive shim is
  //      walrus-injected (crates/fork-module-inject), so the counter bump belongs
  //      there plus a new `fm_*` export and a both-widths wasm rebuild.
  //
  // Until that flip lands and is validated across the fork suites, this stays
  // skipped rather than falsely green.
  it.skip("EQUIVALENCE GATE (3c prod flip): flag-on module drive == flag-off JS drive for a multi-node typed graph", () => {
    expect(true).toBe(true);
  });
});
