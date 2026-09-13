import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FORK_ACTIVATION_DRIVE_BINDINGS,
  FORK_ACTIVATION_DRIVE_SLOTS,
  FORK_MODULE_RESUME_CATALOG_CAP,
  FORK_MODULE_STATS,
} from "../src/fork-module-backend";

const moduleSource = readFileSync(
  join(import.meta.dirname, "..", "..", "crates/fork-module/src/lib.rs"),
  "utf8",
);

describe("fork-module backend constants", () => {
  it("lists the module's stats in the module's own order", () => {
    // The host indexes fm_stats by POSITION. Reading the wrong index returns a
    // plausible number from the wrong counter -- a wrong diagnostic rather than
    // an error, which is the kind of drift nothing else would catch.
    const block = moduleSource.slice(
      moduleSource.indexOf("let stats: [&AtomicU64;"),
      moduleSource.indexOf("match stats.get("),
    );
    const emitted = [...block.matchAll(/&([A-Z][A-Z_0-9]+),/g)].map((m) => m[1]);
    expect(emitted.length).toBe(FORK_MODULE_STATS.length);
    // The module names them SCREAMING_SNAKE; the host names them camelCase.
    const asSnake = FORK_MODULE_STATS.map((name) =>
      name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase(),
    );
    expect(emitted).toEqual(asSnake);
  });

  it("matches the module's resume-catalog capacity", () => {
    // The module sizes a static `[u32; CAP]` arena from this. A host that staged
    // more than the cap would write past the end of that arena.
    const match = /const RESUME_CATALOG_CAP: usize = ([0-9_]+);/.exec(moduleSource);
    expect(match).not.toBeNull();
    expect(Number(match![1].replace(/_/g, ""))).toBe(
      FORK_MODULE_RESUME_CATALOG_CAP,
    );
  });
});

describe("activation drive bindings", () => {
  const drivePlan = readFileSync(
    join(import.meta.dirname, "..", "..", "crates/fork-codec/src/drive_plan.rs"),
    "utf8",
  );

  /** `pub const NAME: u32 = N;` from drive_plan.rs. */
  function constant(name: string): number {
    const match = new RegExp(`pub const ${name}: u32 = ([0-9]+);`).exec(drivePlan);
    if (!match) throw new Error(`drive_plan.rs no longer defines ${name}`);
    return Number(match[1]);
  }

  it("binds each guest export at the slot fork-codec assigns it", () => {
    // Binding the wrong slot makes the module call the wrong guest function with
    // arguments that look right -- an allocate driven as a fill, say. Nothing
    // traps; the child is simply rebuilt wrong.
    const expected = new Map<string, number>([
      ["__wpk_fork_ref_gc_allocate", constant("DRIVE_OP_ALLOC")],
      ["__wpk_fork_ref_gc_fill", constant("DRIVE_OP_FILL")],
      ["__wpk_fork_exception_materialize", constant("DRIVE_OP_EXN")],
      ["__wpk_fork_ref_gc_encode_slot", constant("DRIVE_SLOT_GC_ENCODE")],
      ["__wpk_fork_ref_gc_probe", constant("DRIVE_SLOT_GC_PROBE")],
    ]);
    expect(FORK_ACTIVATION_DRIVE_BINDINGS.length).toBe(expected.size);
    for (const [slot, name] of FORK_ACTIVATION_DRIVE_BINDINGS) {
      expect(slot, name).toBe(expected.get(name));
    }
  });

  it("reserves the stride fork-codec reserves", () => {
    // The module derives every slot from fm_drive_table_base. A host growing by
    // a smaller stride would leave later activations overlapping earlier ones.
    expect(FORK_ACTIVATION_DRIVE_SLOTS).toBe(constant("DRIVE_SLOTS_PER_ACTIVATION"));
  });

  it("binds no slot outside the per-activation slice", () => {
    // Without this, a binding at an offset past the stride would silently write
    // into the NEXT activation's slice and pass the mapping test above.
    for (const [slot, name] of FORK_ACTIVATION_DRIVE_BINDINGS) {
      expect(slot, name).toBeLessThan(FORK_ACTIVATION_DRIVE_SLOTS);
    }
  });
});
