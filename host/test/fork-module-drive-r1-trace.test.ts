// Phase 6 item 3c — EMPIRICAL trace + permanent regression cover for the GC
// DRIVE `fm_after_alloc` R1 transit-read gap.
//
// WHAT THIS PINS DOWN
// -------------------
// The co-resident fork module's real topological GC drive plan
// (`fm_build_gc_plan`, crates/fork-codec/src/drive_plan.rs) emits a
// `DRIVE_OP_ALLOC` step for EVERY typed-GC recipe — struct, array, AND i31 —
// carrying that recipe's own id. The injected `fm_drive_execute` shim
// (crates/fork-module-inject) `call`s the module's Rust `fm_after_alloc(recipe)`
// after each ALLOC step (crates/fork-module/src/lib.rs:2775 -> after_alloc_impl
// :831). `after_alloc_impl` reads `host_transit_read(generation, recipe + 1)`
// through the engine-floor seam (host/src/fork-module-host-capabilities.ts:137)
// and TRAPS (`unreachable`) on any non-success.
//
// The seam's `host_transit_read` only succeeds for a slot the HOST previously
// staged via `host_transit_publish` (line 133). The ONLY caller of
// `host_transit_publish` in the whole drive is PHASE B of the Rust
// `drive_reconstruction` (crates/fork-codec/src/reference_replay.rs:391), which
// publishes slots ONLY for `transit_rooted_recipes()` — the externref LEAVES
// reachable from an aggregate/exnref consumer. It NEVER publishes a slot for a
// struct/array/i31 AGGREGATE recipe (those aggregates never get a host identity;
// their identity is a guest GC object).
//
// CONSEQUENCE (measured below): for any graph that contains a typed-GC node, the
// aggregate's ALLOC drives `fm_after_alloc(aggregate_id)` -> `host_transit_read(
// aggregate_id + 1)`, a slot nobody published, so the seam returns EINVAL and the
// drive TRAPS. This is why item 3c (the flag flip) is NOT wired: driving a real
// multi-node typed graph through the module traps today. These tests capture the
// exact seam trace and lock the shapes so the gap can never again be silently
// uncovered. When the 3c fix lands (so the aggregate slot is legitimately
// available at the R1 read, or the R1 assert is scoped to host-rooted leaves),
// these `THREW`/`MISS` expectations flip to `completes`/`HIT` and the skipped
// flag-on == flag-off equivalence test at the bottom becomes the gate.
//
// VEHICLE: the same real `fork_module` + real `host_transit_*` seam
// (`createForkModuleHostCapabilities`) + a controlled mock guest bound into the
// drive table as `fork-module-drive-shim.test.ts`, but seeding a REAL multi-node
// reference graph (arena + `fm_begin_reference_replay`, which runs the REAL Rust
// PHASE A/B and so populates the seam) plus the committed GC-codec fixture, then
// the REAL `fm_build_gc_plan` + `fm_drive_execute`. `transitSlots` population is
// done by PHASE B (deterministic Rust), independent of the guest, so the mock
// guest is faithful for the trap: the gating check is the host-side published-slot
// map, not anything the guest writes. The seam is INSTRUMENTED by wrapping its
// import functions in the test only (production is byte-identical; no source or
// ABI change).

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

// A mock guest exporting the three drive-table callees, each `(i32) -> ()`:
// `gc_allocate`, `gc_fill`, `exception_materialize`. Each records its last arg
// and packs an ordered call trace (alloc=1, fill=2, exn=3 -> `order()`), so the
// test can prove which guest export ran. Compiled once with wat2wasm; embedded so
// the test needs no build tooling (mirrors `fork-module-drive-shim.test.ts`).
// prettier-ignore
const MOCK_GUEST_BYTES = new Uint8Array([
  0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,3,9,8,0,0,0,1,1,1,1,1,6,26,5,127,1,65,127,11,127,1,65,127,11,127,1,65,127,11,127,1,65,0,11,127,1,65,0,11,7,96,8,11,103,99,95,97,108,108,111,99,97,116,101,0,0,7,103,99,95,102,105,108,108,0,1,21,101,120,99,101,112,116,105,111,110,95,109,97,116,101,114,105,97,108,105,122,101,0,2,9,97,108,108,111,99,95,97,114,103,0,3,8,102,105,108,108,95,97,114,103,0,4,7,101,120,110,95,97,114,103,0,5,3,115,101,113,0,6,5,111,114,100,101,114,0,7,10,98,8,23,0,32,0,36,0,35,3,65,1,106,36,3,35,4,65,10,108,65,1,106,36,4,11,23,0,32,0,36,1,35,3,65,1,106,36,3,35,4,65,10,108,65,2,106,36,4,11,23,0,32,0,36,2,35,3,65,1,106,36,3,35,4,65,10,108,65,3,106,36,4,11,4,0,35,0,11,4,0,35,1,11,4,0,35,2,11,4,0,35,3,11,4,0,35,4,11,
]);

const MODULE = new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));
const MOCK_GUEST_MODULE = new WebAssembly.Module(MOCK_GUEST_BYTES);

interface MockGuest {
  gc_allocate: WebAssembly.ExportValue;
  gc_fill: WebAssembly.ExportValue;
  exception_materialize: WebAssembly.ExportValue;
  order: () => number;
  seq: () => number;
}

/** A REAL transit adapter over the production `(ref null any)` table (recipeId+1
 *  slot), exactly what `fork-module-gc-replay.test.ts` wires. */
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
  /** `host_transit_read` calls made DURING `fm_drive_execute` (the R1 asserts). */
  driveReads: SeamCall[];
  /** `host_transit_read` calls made during PHASE B of `fm_begin_reference_replay`. */
  phaseBReads: SeamCall[];
  threw: boolean;
  guestOrder: number;
}

/** Drive one graph shape through the real module + real seam and capture the
 *  full trace. The seam is instrumented by wrapping its imports (test only). */
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

  // Bind the mock guest exports into the host-owned drive table so the shim's
  // `call_indirect`s resolve (base+ALLOC, base+FILL, base+EXN).
  const guest = new WebAssembly.Instance(MOCK_GUEST_MODULE).exports as unknown as MockGuest;
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

  return {
    replayErr,
    planErr,
    planBuilt: planPtr !== 0,
    steps,
    publishes: log.filter((c) => c.name === "host_transit_publish"),
    generations: log.filter((c) => c.name === "host_begin_generation").map((c) => c.ret),
    driveReads: driveLog.filter((c) => c.name === "host_transit_read"),
    phaseBReads,
    threw,
    guestOrder: guest.order(),
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

describe("fork-module GC drive R1 transit-read trace (Phase 6 item 3c gap)", () => {
  // KNOWN-GAP NOTE (all struct/array/i31 shapes below): the drive TRAPS today
  // because `fm_after_alloc(aggregate)` reads a transit slot nobody published.
  // These `expect(trace.threw).toBe(true)` assertions DOCUMENT the current trap;
  // they are the regression cover that must FLIP (to `false`) when item 3c lands
  // the fix. See the file header and the skipped equivalence gate at the bottom.

  it("Shape 1 — single struct over i31 leaves (typed, NO externref): every ALLOC reads an unpublished slot and the drive TRAPS", () => {
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
    // NOTHING is ever published (no externref leaf), so no aggregate slot exists.
    expect(t.publishes).toHaveLength(0);
    // A generation IS opened (here by `fm_build_gc_plan`, since the no-externref
    // reconstruction opened none) — settling that the generation value is not the
    // blocker.
    expect(t.generations).toEqual([GENERATION_ID]);
    // The drive traps: the first ALLOC (struct recipe 1) reads slot recipe+1 = 2,
    // which returns EINVAL (0 == miss) because it was never published.
    expect(t.driveReads[0]).toMatchObject({ args: [GENERATION_ID, 2], ret: 0 });
    expect(t.threw).toBe(true);
  });

  it("Shape 2 — struct<->array cycle (NO externref leaf): the aggregate ALLOC reads an unpublished slot and TRAPS", () => {
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
    expect(t.publishes).toHaveLength(0);
    // Traps on the first aggregate ALLOC (struct recipe 1 -> slot 2, miss).
    expect(t.driveReads[0]).toMatchObject({ args: [GENERATION_ID, 2], ret: 0 });
    expect(t.threw).toBe(true);
  });

  it("Shape 3 — struct with ONE externref-leaf field (MIXED): the LEAF slot is published and reads back HIT, but the AGGREGATE slot is unpublished and TRAPS", () => {
    // struct(1) [layout 1] fields -> externref(2). This is the diagnostic shape:
    // the externref leaf DOES get a transit slot; the struct does not.
    const t = runShape([NULL, struct(1, [2, 2]), externref(2, LEAF_HANDLE)]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    // Only the struct drives (ALLOC + FILL); the externref emits no drive step.
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([
      [DRIVE_OP_ALLOC, 1],
      [DRIVE_OP_FILL, 1],
    ]);
    // PHASE B published EXACTLY the externref leaf's slot: recipe 2 -> slot 3.
    // NOT the struct's slot (recipe 1 -> slot 2).
    expect(t.publishes.map((c) => c.args[1])).toEqual([3]);
    // PHASE B read the leaf slot back with a HIT (returns the rooted ordinal, !=0).
    expect(t.phaseBReads.map((c) => [c.args[1], c.ret === 0 ? "MISS" : "HIT"])).toEqual([[3, "HIT"]]);
    // The DRIVE's R1 assert reads the AGGREGATE slot (recipe 1 -> slot 2), a MISS.
    expect(t.driveReads[0]).toMatchObject({ args: [GENERATION_ID, 2], ret: 0 });
    expect(t.threw).toBe(true);
  });

  it("Shape 4 — a bare i31 leaf: even a scalar i31 ALLOC reads an unpublished slot and TRAPS", () => {
    // A pure i31 needs no host identity and no transit at all, yet it still gets
    // an ALLOC step and so still drives the R1 read — the trap is broader than
    // struct/array aggregates.
    const t = runShape([NULL, i31(1, -17)]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([[DRIVE_OP_ALLOC, 1]]);
    expect(t.publishes).toHaveLength(0);
    expect(t.driveReads[0]).toMatchObject({ args: [GENERATION_ID, 2], ret: 0 });
    expect(t.threw).toBe(true);
  });

  it("Shape 5 — a program exnref (no externref payload): emits an EXN step, runs NO R1 assert, and the drive COMPLETES (refutes a universal trap)", () => {
    // An exnref materialize is `DRIVE_OP_EXN`, which the shim does NOT follow with
    // `fm_after_alloc`. So an exnref-only graph drives cleanly — the trap is
    // specific to ALLOC-emitting (struct/array/i31) recipes.
    const t = runShape([NULL, exnref(1)]);

    expect(t.replayErr).toBe(0);
    expect(t.planBuilt).toBe(true);
    expect(t.steps.map((s) => [s.op, s.recipe])).toEqual([[DRIVE_OP_EXN, 1]]);
    // No R1 transit read happens during the drive, and it does not trap.
    expect(t.driveReads).toHaveLength(0);
    expect(t.threw).toBe(false);
    // The guest exception_materialize (order code 3) actually ran.
    expect(t.guestOrder).toBe(3);
  });

  // GATE the eventual 3c fix must satisfy. A multi-node typed graph driven with
  // the module (flag-on) must reconstruct the SAME references as the proven JS
  // `materializeTypedGraph` path (flag-off). This CANNOT pass until the R1/transit
  // gap the shapes above document is fixed (the flag-on drive traps today), so it
  // is skipped rather than asserted. When 3c lands, replace the body with a real
  // flag-on/flag-off reconstruction and drop `.skip`.
  it.skip("EQUIVALENCE GATE (3c): flag-on module drive == flag-off JS drive for a multi-node typed graph", () => {
    // Intent (see file header): with the fix, `fm_drive_execute` over Shape 2/3's
    // plan completes without trapping and the resulting struct/array/leaf identities
    // match the JS `ForkEarlyChildReferenceProvider` reconstruction of the same
    // graph. Until then the flag-on drive traps (asserted in Shapes 1-4), so the
    // 3c flip must stay unwired.
    expect(true).toBe(true);
  });
});
