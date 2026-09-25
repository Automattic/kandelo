// Phase 6 item 3c — the GC drive's post-ALLOC store-#2 integrity check,
// against a graph the MODULE captured.
//
// WHAT THIS CHECK IS
//
// The drive plan emits a `DRIVE_OP_ALLOC` step for every typed-GC recipe. The
// injected `fm_drive_execute` shim `call_indirect`s the guest's `gc_allocate`
// for each, then verifies the guest actually published a live GC object --
// reading STORE #2, the shared `__wpk_fork_ref_gc_transit` table the guest
// publishes into at `recipe + 1`, with `table.get` + `ref.is_null`.
//
// The M2 R1 guard that used to live here -- a `DRIVE_OP_EXTERNREF_TRANSIT`
// step resolving a host externref through `env.resolve_externref` and trapping
// on a null read-back -- went with that step in externref stage E2: a fork no
// longer carries a raw host externref, so there is nothing to resolve.
//
// THE ARENA IS CAPTURED, NOT CONSTRUCTED. Every shape here used to be built in
// TypeScript with the set-aside `ForkModuleStateArena` and the segmented
// encoder. A PARENT captures through the module now and a CHILD drives what it
// sealed, so the plan under test is built from bytes the module wrote.
//
// WHAT MOVED OUT. The per-shape assertions about plan ORDER (allocate-all-first
// for a cycle, i31 getting its own ALLOC, an exnref emitting EXN and no
// store-#2 check) are asserted directly on captured graphs in
// `fork-module-gc-replay` and `fork-module-capture-drive`. What is irreducibly
// here is what only a REAL drive can show: the store-#2 read-back.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { instantiateFaithfulGuest } from "./fork-module-faithful-guest";
import {
  CAPTURE_KIND_ARRAY,
  CAPTURE_KIND_STRUCT,
  CHILD_MODULE_BASE,
  INTERN_KIND_I31,
  captureGraph,
  admitInto,
  driveBase,
  fixture,
} from "./fork-module-capture-fixture";

const PID = 7373;
/** Drive-plan op codes, shared with `fork_codec::drive_plan`. */
const DRIVE_OP_ALLOC = 0;
const DRIVE_OP_FILL = 1;
const STEP_SIZE = 16;
/** The committed KFGC fixture: layout 1 is a two-reference struct, layout 4 a
 *  one-reference array, both activation 0. */
const GC_CODEC = new Uint8Array(
  readFileSync(
    new URL("../../crates/fork-codec/testdata/gc-codec-wasm32.bin", import.meta.url),
  ),
);

interface DriveExports {
  fm_restore_from_arena: (root: number, pid: number) => number;
  fm_gc_plan_count: () => number;
  fm_drive_execute: (ptr: number, count: number) => void;
  fm_last_errno: () => number;
}

interface Trace {
  steps: { op: number; recipe: number }[];
  published: readonly number[];
  liveSlots: number[];
  threw: boolean;
}

/**
 * Capture one graph, then drive it in a CHILD with the faithful guest bound and
 * the real transit table, returning everything the drive did.
 */
function driveCaptured(
  build: (f: ReturnType<typeof fixture>) => { root: number },
): Trace {
  const f = fixture();
  const { root } = build(f);

  // The child's region sits above everything the fixture placed; growing the
  // shared memory to hold it is the caller's job (the fixture's own
  // `childInstance` does the same).
  const needed = CHILD_MODULE_BASE + 8 * 1024 * 1024;
  if (f.memory.buffer.byteLength < needed) {
    f.memory.grow(Math.ceil((needed - f.memory.buffer.byteLength) / 65536));
  }
  const child = instantiateForkModule({
    module: new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    ),
    memory: f.memory,
    reserve: () => CHILD_MODULE_BASE,
    label: "r1 trace child",
  });
  const x = child.exports as unknown as DriveExports;
  (child.exports.fm_set_format as (...a: number[]) => void)(4, 0, 0, 4 * 65536);

  expect(
    admitInto(child.exports as Record<string, unknown>, f.memory, 0, { gcCodec: GC_CODEC }),
    "the child admits its GC codec",
  ).toBe(0);

  // STORE #2 is the module's OWN exported transit table -- the same object the
  // guest publishes into and the shim reads back.
  const transit = child.exports.__wpk_fork_ref_gc_transit as WebAssembly.Table;
  const { guest, published } = instantiateFaithfulGuest(child.exports);

  const planPtr = x.fm_restore_from_arena(root, PID);
  expect(x.fm_last_errno(), "the child restores the sealed graph").toBe(0);
  const count = x.fm_gc_plan_count();
  const view = new DataView(f.memory.buffer);
  const steps = Array.from({ length: count }, (_, i) => ({
    op: view.getUint32(planPtr + i * STEP_SIZE, true),
    recipe: view.getUint32(planPtr + i * STEP_SIZE + 8, true),
  }));

  // Bind the guest's own allocate/fill/exn where the shim `call_indirect`s.
  const base = driveBase(0);
  if (child.driveTable.length < base + 3) {
    child.driveTable.grow(base + 3 - child.driveTable.length);
  }
  child.driveTable.set(base + DRIVE_OP_ALLOC, guest.gc_allocate as never);
  child.driveTable.set(base + DRIVE_OP_FILL, guest.gc_fill as never);
  child.driveTable.set(base + 2, guest.exception_materialize as never);

  let threw = false;
  try {
    x.fm_drive_execute(planPtr, count);
  } catch {
    threw = true;
  }

  const liveSlots: number[] = [];
  for (let slot = 1; slot < transit.length; slot += 1) {
    if (transit.get(slot) !== null) liveSlots.push(slot);
  }
  return { steps, published, liveSlots, threw };
}

describe("the GC drive reads store #2", () => {
  it("POSITIVE: every ALLOC recipe publishes a live store-#2 slot and the drive completes", () => {
    // struct -> array -> i31: one of each ALLOC-emitting kind, so the shim's
    // post-ALLOC read-back runs against all three.
    const trace = driveCaptured((f) =>
      captureGraph(
        f,
        [[INTERN_KIND_I31, 9, 0]],
        [
          {
            kind: CAPTURE_KIND_ARRAY,
            activation: 0,
            typeOrdinal: 3,
            layoutId: 4,
            edges: ({ leaves }) => [leaves[0]!],
          },
          {
            kind: CAPTURE_KIND_STRUCT,
            activation: 0,
            typeOrdinal: 0,
            layoutId: 1,
            scalars: new Uint8Array(4),
            edges: ({ aggregates }) => [aggregates[0]!, aggregates[0]!],
          },
        ],
      ),
    );

    const allocs = trace.steps.filter((s) => s.op === DRIVE_OP_ALLOC)
      .map((s) => s.recipe);
    expect(allocs.length, "every typed recipe allocates").toBeGreaterThan(0);
    // The guest published a live identity for each, and the shim read every
    // one back without trapping -- which is the whole claim.
    expect(new Set(trace.published)).toEqual(new Set(allocs));
    for (const recipe of allocs) expect(trace.liveSlots).toContain(recipe + 1);
    expect(trace.threw, "the drive completed").toBe(false);
  });
});
