// Orchestration migration increment 1 — the module-owned wire-graph DECODE, the
// captured externref-handle READOUT, and the replay-orchestration RESTORE
// entries, proven end to end in a real WebAssembly engine (Node/V8).
//
// These `fm_*` exports are additive surfaces over the shared `fork_codec`
// engine (`reference_segments.rs` decode, `reference_replay.rs` driver/feed,
// `drive_plan.rs` build_drive_plan) — the same engine that backs
// `fm_begin_reference_replay`. They are what let the host retire its own
// wire-graph decode, its externref-handle scan, and its replay ENTRY wrapper.
//
// THE ARENA IS CAPTURED, NOT CONSTRUCTED. This file used to build its sealed
// KFMS arena in TypeScript with the set-aside `ForkModuleStateArena` and
// `appendSegmentedForkReferenceTransaction`, then assert the module decoded
// what that encoder wrote — which proves two implementations of a module-owned
// format agree, not that the module is right. A PARENT interns three durable
// externref handles and seals; a CHILD decodes and restores what it sealed.
//
// The SCAN half changed with it, because the surface it tested is gone. The
// host used to re-derive a fork's externref set by parsing the parked parent's
// arena; the module now RECORDS each handle as it is interned, and
// `fm_captured_externref_count` / `fm_captured_externref` read that set back.
// This file asserts the recorded set instead of a scan of the wire bytes.

import { describe, expect, it } from "vitest";

import { FORK_MODULE_STATS } from "../src/fork-module-backend";
import {
  INTERN_KIND_EXTERNREF,
  captureArena,
  childModule,
  fixture,
} from "./fork-module-capture-fixture";

const PID = 4242;
const EINVAL = 22;
// Distinct durable broker handles this fork's externrefs name (a canonical
// capture graph dedups externref by handle, so the graph has one node each).
const HANDLES = [11, 22, 33] as const;
// A zeroed, in-bounds address that is NOT a sealed chunk chain: below the
// module's own reserve, above the syscall channel, and never mapped by the
// fixture's responder.
const NOT_AN_ARENA = 1024 * 1024;
// The drive-plan step layout (mirrors crates/fork-codec/src/drive_plan.rs).
const DRIVE_STEP_SIZE = 16;
const DRIVE_STEP_OFF_OP = 0;
const DRIVE_STEP_OFF_RECIPE = 8;
const DRIVE_OP_EXTERNREF_TRANSIT = 4;

const GRAPHS_DECODED = FORK_MODULE_STATS.indexOf("referenceGraphsDecoded");
const EXTERNREFS_RESOLVED = FORK_MODULE_STATS.indexOf("externrefsResolved");

interface ForkModuleExports {
  fm_decode_reference_graph: (root: number) => number;
  fm_decoded_node_count: () => number;
  fm_restore_from_arena: (root: number, pid: number) => number;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_build_gc_plan: (pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
}

/** Capture the externref-only graph and hand back the child that reads it. */
function captured(): {
  root: number;
  recipes: number[];
  parent: ReturnType<typeof fixture>;
  x: ForkModuleExports;
  memory: WebAssembly.Memory;
} {
  const f = fixture();
  const { root, recipes } = captureArena(
    f,
    HANDLES.map((handle) => [INTERN_KIND_EXTERNREF, handle, 0] as const),
  );
  const x = childModule(f, {
    label: "decode-restore-child",
    // The plan is BUILT here, never driven, so this must not be called. If it
    // is, the handle it was asked for names what went wrong.
    resolveExternref: (handle: number) => {
      throw new Error(`nothing should resolve during a build (handle ${handle})`);
    },
  }) as unknown as ForkModuleExports;
  return { root, recipes, parent: f, x, memory: f.memory };
}

function readPlan(memory: WebAssembly.Memory, ptr: number, count: number): number[][] {
  const view = new DataView(memory.buffer);
  const steps: number[][] = [];
  for (let i = 0; i < count; i++) {
    const base = ptr + i * DRIVE_STEP_SIZE;
    steps.push([
      view.getUint32(base + DRIVE_STEP_OFF_OP, true),
      view.getUint32(base + DRIVE_STEP_OFF_RECIPE, true),
    ]);
  }
  return steps;
}

function readRawPlan(memory: WebAssembly.Memory, ptr: number, count: number): Uint8Array {
  return new Uint8Array(memory.buffer).slice(ptr, ptr + count * DRIVE_STEP_SIZE);
}

describe("fork-module decode / captured-externrefs / restore (orchestration migration increment 1)", () => {
  it("decodes a captured KFMS arena and reports the node count with proof of use", () => {
    const { root, x } = captured();

    const before = Number(x.fm_stats(GRAPHS_DECODED));
    const nodeCount = x.fm_decode_reference_graph(root);
    expect(x.fm_last_errno()).toBe(0);
    // One canonical null + one node per distinct externref handle.
    expect(nodeCount).toBe(1 + HANDLES.length);
    expect(x.fm_decoded_node_count()).toBe(1 + HANDLES.length);
    expect(Number(x.fm_stats(GRAPHS_DECODED)) - before).toBe(1);

    // A second decode makes the graph resident again and advances the counter.
    expect(x.fm_decode_reference_graph(root)).toBe(1 + HANDLES.length);
    expect(Number(x.fm_stats(GRAPHS_DECODED)) - before).toBe(2);
  });

  it("reads back the externref handles the capture recorded, in intern order", () => {
    const f = fixture();
    captureArena(
      f,
      HANDLES.map((handle) => [INTERN_KIND_EXTERNREF, handle, 0] as const),
    );

    // Neither readout sets errno -- they answer -1 -- so there is nothing to
    // check there, and checking it would only read whatever the seal left.
    const count = (f.x.fm_captured_externref_count as () => number)();
    expect(count, "the capture recorded its externrefs").toBe(HANDLES.length);
    const read = f.x.fm_captured_externref as (index: number) => bigint;
    HANDLES.forEach((handle, index) => {
      expect(Number(read(index)), `handle at index ${index}`).toBe(handle);
    });
    // One past the end is a truthful failure, not a fabricated handle.
    expect(Number(read(HANDLES.length))).toBeLessThan(0);
  });

  it("fails cleanly on a malformed arena root", () => {
    const { x } = captured();

    // A zeroed in-bounds region is not a valid sealed chunk chain.
    expect(x.fm_decode_reference_graph(NOT_AN_ARENA)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EINVAL);
    // A failed decode leaves no resident graph.
    expect(x.fm_decoded_node_count()).toBe(-1);
  });

  it("fm_restore_from_arena seeds the driver and builds a plan identical to begin + build", () => {
    const { root, x, memory } = captured();

    // (1) The single restore entry: seed + build in one call.
    const beforeResolved = Number(x.fm_stats(EXTERNREFS_RESOLVED));
    const planPtr = x.fm_restore_from_arena(root, PID);
    expect(x.fm_last_errno()).toBe(0);
    expect(planPtr).not.toBe(0);

    const count = x.fm_gc_plan_count();
    // Every externref recipe gets a Phase-0b transit-publish step.
    expect(count).toBe(HANDLES.length);
    // Restore seeded the driver AND admitted the graph (bookkeeping advanced).
    expect(Number(x.fm_stats(EXTERNREFS_RESOLVED)) - beforeResolved).toBe(
      HANDLES.length,
    );

    // The plan is exactly the externref-transit steps, one per recipe (1..N).
    const steps = readPlan(memory, planPtr, count);
    steps.forEach(([op, recipe], index) => {
      expect(op).toBe(DRIVE_OP_EXTERNREF_TRANSIT);
      expect(recipe).toBe(index + 1);
    });
    const restoreRaw = readRawPlan(memory, planPtr, count);

    // (2) The two-step path restore collapses: begin_reference_replay + build.
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);
    const planPtr2 = x.fm_build_gc_plan(PID);
    expect(planPtr2).not.toBe(0);
    const count2 = x.fm_gc_plan_count();
    expect(count2).toBe(count);
    const twoStepRaw = readRawPlan(memory, planPtr2, count2);

    // Byte-for-byte identical: fm_restore_from_arena is the composition.
    expect(Array.from(restoreRaw)).toEqual(Array.from(twoStepRaw));
  });

  it("fm_restore_from_arena fails cleanly on a malformed arena root", () => {
    const { x } = captured();

    expect(x.fm_restore_from_arena(NOT_AN_ARENA, PID)).toBe(0);
    expect(x.fm_last_errno()).not.toBe(0);
  });
});
