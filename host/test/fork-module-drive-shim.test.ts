// Phase 6 item 3b — the call_indirect DRIVE-SHIM MECHANISM for driving the guest
// GC exports from the co-resident fork module, proven end to end in a real
// WebAssembly engine (Node/V8).
//
// The module cannot IMPORT the guest's `_gc_allocate`/`_gc_fill` exports (it is
// instantiated BEFORE the guest, to supply the frame-flip imports). So instead of
// the JS `materializeTypedGraph` drive-order calling those guest exports, the
// module drives them through a MUTABLE funcref table (`env.__wpk_fork_drive_table`)
// the host binds post-instantiation. Rust has no `call_indirect` intrinsic, so the
// split is: Rust serializes an ordered PLAN (`fm_build_trivial_plan`); the injected
// walrus shim `fm_drive_execute(plan_ptr, count)` loops the plan, `call_indirect`s
// the table slot for each step, and `call`s the Rust `fm_after_alloc(recipe)` after
// each ALLOC step for the R1 transit-read assert.
//
// This slice builds ONLY the mechanism, proven on a TRIVIAL single struct (ALLOC
// then FILL for one recipe). It does NOT flip the real JS drive-order to the module
// (that is item 3c); `materializeTypedGraph` keeps driving production forks.
//
// Assertions:
//   (a) MECHANISM — `fm_drive_execute` `call_indirect`s the GUEST's `_gc_allocate`
//       then `_gc_fill` (bound into the drive table), wasm->wasm, in that order,
//       each with the plan's arg (observable via guest counters/args).
//   (b) R1 ASSERT PASSES — with the transit slot `recipe+1` published, the
//       `fm_after_alloc` read-back succeeds and the drive completes.
//   (c) R1 ASSERT IS LOAD-BEARING — with NO transit published, `fm_after_alloc`
//       reads a null slot and TRAPS (`unreachable`), never a silent pass.

import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { readFileSync } from "node:fs";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  createForkModuleHostCapabilities,
  type ForkModuleTransitAdapter,
} from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";

const PTR_WIDTH = 4 as const;
const PID = 3131;
const GENERATION_ID = 9;
const LEAF_HANDLE = 55;

// The mock guest: observable `gc_allocate` / `gc_fill` exports, both (i32)->()
// like the frozen guest `__wpk_fork_ref_gc_{allocate,fill}`. `order()` packs the
// call sequence (alloc=1, fill=2 -> 12), `seq()` counts calls, `alloc_arg()` /
// `fill_arg()` echo the last argument the shim passed via call_indirect. Compiled
// once with wat2wasm; embedded so the test needs no build tooling.
// prettier-ignore
const MOCK_GUEST_BYTES = new Uint8Array([
  0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,3,7,6,0,0,1,1,1,1,6,21,4,
  127,1,65,127,11,127,1,65,127,11,127,1,65,0,11,127,1,65,0,11,7,62,6,11,103,99,
  95,97,108,108,111,99,97,116,101,0,0,7,103,99,95,102,105,108,108,0,1,9,97,108,
  108,111,99,95,97,114,103,0,2,8,102,105,108,108,95,97,114,103,0,3,5,111,114,100,
  101,114,0,4,3,115,101,113,0,5,10,69,6,23,0,32,0,36,0,35,3,65,1,106,36,3,35,2,
  65,10,108,65,1,106,36,2,11,23,0,32,0,36,1,35,3,65,1,106,36,3,35,2,65,10,108,65,
  2,106,36,2,11,4,0,35,0,11,4,0,35,1,11,4,0,35,2,11,4,0,35,3,11,
]);

interface MockGuest {
  gc_allocate: (x: number) => void;
  gc_fill: (x: number) => void;
  alloc_arg: () => number;
  fill_arg: () => number;
  order: () => number;
  seq: () => number;
}

interface DriveShimExports {
  fm_build_trivial_plan: (activation: number, recipe: number, pid: number) => number;
  fm_trivial_plan_count: () => number;
  fm_drive_execute: (planPtr: number, count: number) => void;
  fm_drive_table_base: (activation: number) => number;
  fm_last_errno: () => number;
}

const MODULE = new WebAssembly.Module(
  readFileSync(resolveBinary("fork_module32.wasm")),
);
const MOCK_GUEST_MODULE = new WebAssembly.Module(MOCK_GUEST_BYTES);

function realTransit(table: ForkAnyrefTransitTable): ForkModuleTransitAdapter {
  return {
    publish: (recipeId, value) => {
      table.ensureRecipeSlot(recipeId);
      table.set(recipeId + 1, value);
    },
    read: (recipeId) => table.get(recipeId + 1),
  };
}

function setup() {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
  const tokens = new ForkExternrefTokenCache(GENERATION_ID);
  const transitTable = new ForkAnyrefTransitTable();
  const caps = createForkModuleHostCapabilities({
    tokens,
    generationId: GENERATION_ID,
    transit: realTransit(transitTable),
  });
  const fm = instantiateForkModule({
    module: MODULE,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => 8 * 1024 * 1024,
    label: "drive-shim-test",
    hostCapabilities: caps.imports,
  });
  const x = fm.exports as unknown as DriveShimExports;

  // The guest instances only exist AFTER the module — bind their exports into the
  // host-owned drive table now (base(0) = 0 -> ALLOC slot 0, FILL slot 1).
  const guestExports = new WebAssembly.Instance(MOCK_GUEST_MODULE).exports;
  const guest = guestExports as unknown as MockGuest;
  const base = x.fm_drive_table_base(0);
  expect(base).toBe(0);
  if (fm.driveTable.length < base + 2) {
    fm.driveTable.grow(base + 2 - fm.driveTable.length);
  }
  fm.driveTable.set(base + 0, guestExports.gc_allocate as WebAssembly.ExportValue);
  fm.driveTable.set(base + 1, guestExports.gc_fill as WebAssembly.ExportValue);

  return { x, guest, caps, transitTable };
}

describe("fork-module call_indirect drive-shim mechanism (Phase 6 item 3b)", () => {
  it("call_indirects the guest _gc_allocate then _gc_fill via the drive table and passes the R1 transit-read assert", () => {
    const { x, guest, caps } = setup();
    const recipe = 7;

    // Rust serializes the trivial ALLOC-then-FILL plan and opens the host
    // generation `fm_after_alloc` reads the transit under.
    const planPtr = x.fm_build_trivial_plan(0, recipe, PID);
    expect(x.fm_last_errno()).toBe(0);
    expect(planPtr).not.toBe(0);
    expect(x.fm_trivial_plan_count()).toBe(2);

    // Simulate the guest _gc_allocate + PHASE-B rooting: publish a live identity
    // into the transit slot recipe+1 so the R1 read-back succeeds.
    const ordinal = caps.imports.host_resolve_externref(GENERATION_ID, LEAF_HANDLE);
    expect(ordinal).not.toBe(0);
    expect(caps.imports.host_transit_publish(GENERATION_ID, recipe + 1, ordinal)).toBe(0);

    // Nothing has run yet.
    expect(guest.seq()).toBe(0);

    // Drive: the shim loops the plan and call_indirects the bound guest exports.
    x.fm_drive_execute(planPtr, x.fm_trivial_plan_count());

    // (a) MECHANISM — guest _gc_allocate ran first, then _gc_fill, each once, each
    // with the plan's arg (== recipe for the trivial plan).
    expect(guest.seq()).toBe(2);
    expect(guest.order()).toBe(12); // 1 (alloc) then 2 (fill)
    expect(guest.alloc_arg()).toBe(recipe);
    expect(guest.fill_arg()).toBe(recipe);
    // (b) R1 ASSERT PASSED — fm_after_alloc did not trap; errno stayed clean.
    expect(x.fm_last_errno()).toBe(0);
  });

  it("TRAPS in fm_after_alloc when the transit slot is null (R1 assert is load-bearing)", () => {
    const { x, guest } = setup();
    const recipe = 4;

    const planPtr = x.fm_build_trivial_plan(0, recipe, PID);
    expect(x.fm_last_errno()).toBe(0);

    // Do NOT publish the transit slot: fm_after_alloc must read a null slot and
    // trap, never silently pass an R1 assert with no rooted identity.
    expect(() => x.fm_drive_execute(planPtr, x.fm_trivial_plan_count())).toThrow();

    // The guest _gc_allocate DID run (call_indirect happened before the trap); the
    // trap fired in the post-ALLOC R1 assert, before _gc_fill.
    expect(guest.order()).toBe(1); // only alloc, then trap
  });
});
