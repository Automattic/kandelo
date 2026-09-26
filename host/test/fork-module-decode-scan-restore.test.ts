// Orchestration migration increment 1 — the module-owned wire-graph DECODE and
// the replay-orchestration RESTORE entries, proven end to end in a real
// WebAssembly engine (Node/V8).
//
// These `fm_*` exports are additive surfaces over the shared `fork_codec`
// engine (`reference_segments.rs` decode, `reference_replay.rs` driver/feed,
// `drive_plan.rs` build_drive_plan) — the same engine a fork child's
// `fm_child_install` runs. They are what let the host retire its own
// wire-graph decode, and its replay ENTRY wrapper.
//
// THE ARENA IS CAPTURED, NOT CONSTRUCTED. This file used to build its sealed
// KFMS arena in TypeScript with the set-aside `ForkModuleStateArena` and
// `appendSegmentedForkReferenceTransaction`, then assert the module decoded
// what that encoder wrote — which proves two implementations of a module-owned
// format agree, not that the module is right. A PARENT interns three static
// roots and seals; a CHILD decodes and restores what it sealed.
//
// The SCAN half is gone. It read back the host-externref handles a capture
// recorded, and a fork no longer carries a raw host externref (externref stage
// E2), so there is no such set: `fm_captured_externref*` left the module.

import { describe, expect, it } from "vitest";

import {
  INTERN_KIND_STATIC_ROOT,
  captureArena,
  childModule,
  fixture,
} from "./fork-module-capture-fixture";

const PID = 4242;
const EINVAL = 22;
// Distinct static-root ordinals of activation 0 (a canonical capture graph
// dedups a static root by coordinate, so the graph has one node each).
const ORDINALS = [0, 1, 2] as const;
// A zeroed, in-bounds address that is NOT a sealed chunk chain: below the
// module's own reserve, above the syscall channel, and never mapped by the
// fixture's responder.
const NOT_AN_ARENA = 1024 * 1024;
// The drive-plan step layout (mirrors crates/fork-codec/src/drive_plan.rs).
const DRIVE_STEP_SIZE = 16;
const DRIVE_STEP_OFF_OP = 0;
const DRIVE_STEP_OFF_RECIPE = 8;
const DRIVE_OP_STATIC_ROOT = 3;

interface ForkModuleExports {
  fm_restore_from_arena: (root: number, pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_stats: (field: number) => bigint;
  fm_last_errno: () => number;
}

/** Capture the static-root-only graph and hand back the child that reads it. */
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
    ORDINALS.map((ordinal) => [INTERN_KIND_STATIC_ROOT, 0, ordinal] as const),
  );
  const x = childModule(f, {
    label: "decode-restore-child",
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

describe("fork-module decode / restore (orchestration migration increment 1)", () => {
  // The two DECODE cases went with `fm_decode_reference_graph` and
  // `fm_decoded_node_field` (lane F stage 1G): the graph is made resident
  // only inside the module now, by `fm_child_plan` and the throw path.
  it("fm_restore_from_arena seeds the driver and builds the plan", () => {
    const { root, x, memory } = captured();

    // (1) The single restore entry: seed + build in one call.
    const planPtr = x.fm_restore_from_arena(root, PID);
    expect(x.fm_last_errno()).toBe(0);
    expect(planPtr).not.toBe(0);

    const count = x.fm_gc_plan_count();
    // Every static-root recipe gets a Phase-0 publish step.
    expect(count).toBe(ORDINALS.length);

    // The plan is exactly the static-root steps, one per recipe (1..N).
    const steps = readPlan(memory, planPtr, count);
    steps.forEach(([op, recipe], index) => {
      expect(op).toBe(DRIVE_OP_STATIC_ROOT);
      expect(recipe).toBe(index + 1);
    });
  });

  it("fm_restore_from_arena fails cleanly on a malformed arena root", () => {
    const { x } = captured();

    expect(x.fm_restore_from_arena(NOT_AN_ARENA, PID)).toBe(0);
    expect(x.fm_last_errno()).not.toBe(0);
  });
});
