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

  it("keeps the identity-chunk-count field clear of the stats table", () => {
    // `fm_stats` answers `IDENTITY_CHUNK_COUNT_FIELD` from an `if` that runs
    // BEFORE the reference table, because the count is walked rather than
    // loaded from an `AtomicU64` and so cannot join the table. That ordering is
    // what makes this pin necessary: the table's indices are contiguous from 0
    // and grow by one per counter appended, so if the reserved field ever sat
    // inside that range, the next counter added would be intercepted and
    // `stat()` would return the chunk count under its name. The pin above
    // cannot see it -- it reads only the `let stats: [&AtomicU64;` block, and
    // the `if` is outside that window, so appending a counter would leave the
    // whole suite green.
    const match = /const IDENTITY_CHUNK_COUNT_FIELD: u32 = ([0-9_]+);/.exec(
      moduleSource,
    );
    expect(match, "the module no longer names IDENTITY_CHUNK_COUNT_FIELD")
      .not.toBeNull();
    expect(
      Number(match![1].replace(/_/g, "")),
      "a counter appended to the stats table must not be able to reach the " +
        "identity-chunk-count field; raise the field, do not lower this",
    ).toBeGreaterThanOrEqual(FORK_MODULE_STATS.length);
  });

  it("keeps every high fm_stats field clear of the stats table and of each other", () => {
    // Same reasoning as the identity-chunk-count pin above, for the fields the
    // storage conversion adds. `fm_stats` answers each from an `if` that runs
    // BEFORE the reference table, so a number reused between two of them is
    // not a compile error: the second arm is dead and the first answers both
    // reads. The module carries a const-assert (`FM_STATS_HIGH_FIELDS`) that
    // catches a reuse at BUILD time; this catches a field that drifts DOWN
    // into the table's contiguous index space, which the const-assert cannot
    // see because that space's length is a HOST constant.
    //
    // Later tasks of the same plan add their constant's name to this array in
    // the same commit that adds the field.
    const fields = [
      "ARENA_RECORD_CHUNK_COUNT_FIELD",
      "ARENA_DIRECTORY_CHUNK_COUNT_FIELD",
      "ARENA_DIRECTORY_ENTRY_COUNT_FIELD",
    ].map((name) => {
      const match = new RegExp(`const ${name}: u32 = ([0-9_]+);`).exec(moduleSource);
      expect(match, `the module no longer names ${name}`).not.toBeNull();
      return [name, Number(match![1].replace(/_/g, ""))] as const;
    });
    for (const [name, value] of fields) {
      expect(
        value,
        `${name} must stay above the stats table`,
      ).toBeGreaterThanOrEqual(FORK_MODULE_STATS.length);
    }
    expect(
      new Set(fields.map(([, v]) => v)).size,
      "two fields share a number",
    ).toBe(fields.length);
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
      ["wpk_fork_module_state_restore", constant("DRIVE_SLOT_RESTORE")],
      [
        "wpk_fork_module_state_finish_restore",
        constant("DRIVE_SLOT_FINISH_RESTORE"),
      ],
      ["wpk_fork_rewind_begin", constant("DRIVE_SLOT_REWIND_BEGIN")],
      ["wpk_fork_abort_begin", constant("DRIVE_SLOT_ABORT_BEGIN")],
      ["wpk_fork_unwind_end", constant("DRIVE_SLOT_UNWIND_END")],
      ["wpk_fork_rewind_end", constant("DRIVE_SLOT_REWIND_END")],
      ["wpk_fork_abort_end", constant("DRIVE_SLOT_ABORT_END")],
      ["wpk_fork_unwind_begin", constant("DRIVE_SLOT_UNWIND_BEGIN")],
      ["__wpk_fork_ref_gc_encode_slot", constant("DRIVE_SLOT_GC_ENCODE")],
      ["__wpk_fork_ref_gc_probe", constant("DRIVE_SLOT_GC_PROBE")],
      ["wpk_fork_module_state_save", constant("DRIVE_SLOT_MODULE_STATE_SAVE")],
      // The peer-table checkpoint's save walk. A DIFFERENT guest export from
      // the one above, which is why it needs a slot of its own: that one walks
      // globals, tables and the reference graph, and driving it for a table
      // checkpoint would publish far more than a checkpoint means.
      [
        "wpk_fork_module_table_state_save",
        constant("DRIVE_SLOT_MODULE_TABLE_STATE_SAVE"),
      ],
      // The activation's own tagged thrower. The module calls this one
      // DIRECTLY rather than from a plan step: a guest asking to re-raise a
      // recipe whose tag it does not own arrives mid-replay, not at a moment a
      // plan could have scheduled. Census 192.
      [
        "__wpk_fork_ref_exn_throw_recipe",
        constant("DRIVE_SLOT_EXN_THROW_RECIPE"),
      ],
    ]);
    expect(FORK_ACTIVATION_DRIVE_BINDINGS.length).toBe(expected.size);
    for (const { slot, name } of FORK_ACTIVATION_DRIVE_BINDINGS) {
      expect(slot, name).toBe(expected.get(name));
    }
  });

  it("leaves no slot in the stride unbound", () => {
    // The reason the lifecycle slots were added: the JS host bound five of
    // thirteen, so the module could drive typed reconstruction and nothing
    // else. Every unbound slot in the stride is a fork operation the module
    // cannot perform -- and it fails as a `call_indirect` on null, not as a
    // missing capability. A gap here is that class of bug, pre-committed.
    const bound = new Set(FORK_ACTIVATION_DRIVE_BINDINGS.map((b) => b.slot));
    const missing = [];
    for (let slot = 0; slot < FORK_ACTIVATION_DRIVE_SLOTS; slot += 1) {
      if (!bound.has(slot)) missing.push(slot);
    }
    expect(missing).toEqual([]);
  });

  it("requires exactly the exports every fork-capable guest emits", () => {
    // The unwind/rewind/abort quartet plus unwind_begin come from the
    // instrumentation runtime itself, so a guest without them is a broken
    // artifact and must fail loudly. Everything else is conditional on what the
    // guest CONTAINS -- no typed-GC codec, no allocate; no mutable globals, no
    // module-state save -- and the module emits no step for what is not there,
    // so marking one of those required would reject a perfectly good guest.
    const required = FORK_ACTIVATION_DRIVE_BINDINGS.filter((b) => b.required)
      .map((b) => b.name)
      .sort();
    expect(required).toEqual([
      "wpk_fork_abort_begin",
      "wpk_fork_abort_end",
      "wpk_fork_module_state_finish_restore",
      "wpk_fork_module_state_restore",
      "wpk_fork_module_state_save",
      "wpk_fork_rewind_begin",
      "wpk_fork_rewind_end",
      "wpk_fork_unwind_begin",
      "wpk_fork_unwind_end",
    ]);
  });

  it("reserves the stride fork-codec reserves", () => {
    // The module derives every slot from fm_drive_table_base. A host growing by
    // a smaller stride would leave later activations overlapping earlier ones.
    expect(FORK_ACTIVATION_DRIVE_SLOTS).toBe(constant("DRIVE_SLOTS_PER_ACTIVATION"));
  });

  it("binds no slot outside the per-activation slice", () => {
    // Without this, a binding at an offset past the stride would silently write
    // into the NEXT activation's slice and pass the mapping test above.
    for (const { slot, name } of FORK_ACTIVATION_DRIVE_BINDINGS) {
      expect(slot, name).toBeLessThan(FORK_ACTIVATION_DRIVE_SLOTS);
    }
  });
});
