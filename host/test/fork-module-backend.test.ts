import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FORK_ACTIVATION_DRIVE_BINDINGS,
  FORK_MODULE_STATS,
} from "../src/fork-module-backend";
import {
  encodeForkAdmission,
  FORK_ADMISSION_BORROWED_CHILD,
  FORK_ADMISSION_FORK_CHILD,
  FORK_ADMISSION_SECTIONS,
} from "../src/fork-guest-sections";

/** The per-activation drive stride: one slot per binding. */
const FORK_ACTIVATION_DRIVE_SLOTS = FORK_ACTIVATION_DRIVE_BINDINGS.length;

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
    // Same reasoning as the identity-chunk-count pin above, for every field
    // `fm_stats` answers from an `if` that runs BEFORE the reference table. A
    // number reused between two of them is not a compile error: the second arm
    // is dead and the first answers both reads.
    //
    // DERIVED FROM `fm_stats`'S OWN ARMS, not from a list someone maintains.
    // The module carries a const-assert (`FM_STATS_HIGH_FIELDS`) that catches
    // a reuse at BUILD time, but it compares a hand-written array against
    // itself: a task that adds an `if field == NEW_FIELD` arm and forgets the
    // array gets no protection from it. A second hand-list here would guard
    // against forgetting to update a list -- the same "second tally of one
    // event" shape that got the maintained directory counter deleted. So this
    // reads the arms out of the function body and holds BOTH the numbers and
    // the const-assert's membership to them.
    const body = moduleSource.slice(
      moduleSource.indexOf("pub extern \"C\" fn fm_stats(field: u32) -> i64 {"),
      moduleSource.indexOf("match stats.get("),
    );
    expect(body, "fm_stats no longer has the shape this pin reads").not.toBe("");
    const armed = [...body.matchAll(/if field == ([A-Z][A-Z_0-9]*)\s*\{/g)].map(
      (m) => m[1],
    );
    expect(armed.length, "fm_stats answers no high field at all").toBeGreaterThan(0);

    const valueOf = (name: string): number => {
      const match = new RegExp(`const ${name}: u32 = ([0-9_]+);`).exec(moduleSource);
      expect(match, `the module answers ${name} but never defines it`).not.toBeNull();
      return Number(match![1].replace(/_/g, ""));
    };

    // (i) every armed field sits above the reference table's contiguous index
    // space, which the const-assert cannot see because that space's length is
    // a HOST constant.
    for (const name of armed) {
      expect(
        valueOf(name),
        `${name} must stay above the stats table; raise the field, do not ` +
          "lower this",
      ).toBeGreaterThanOrEqual(FORK_MODULE_STATS.length);
    }

    // (ii) no two armed fields share a number.
    const numbers = armed.map(valueOf);
    expect(
      new Set(numbers).size,
      `two fm_stats arms share a number: ${armed.join(", ")} are ` +
        `${numbers.join(", ")}. The second arm is dead and the first answers ` +
        "both reads.",
    ).toBe(numbers.length);

    // (iii) the const-assert's array lists exactly the armed fields. This is
    // what keeps `FM_STATS_HIGH_FIELDS` from silently going stale: it can only
    // catch a collision between fields someone remembered to register, so the
    // registration itself has to be checked against the arms.
    const table = /const FM_STATS_HIGH_FIELDS: \[u32; [0-9]+\] = \[([^\]]*)\];/.exec(
      moduleSource,
    );
    expect(table, "the module no longer names FM_STATS_HIGH_FIELDS").not.toBeNull();
    const registered = [...table![1].matchAll(/([A-Z][A-Z_0-9]*)\s*,/g)].map((m) => m[1]);
    expect(
      [...registered].sort(),
      "FM_STATS_HIGH_FIELDS must list exactly the fields fm_stats arms on; an " +
        "arm missing from it is a collision the build-time assert cannot see",
    ).toEqual([...armed].sort());
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
      // The guest's table shims: the ONLY way the module reads or writes a
      // guest table. Binding read at apply's slot would have the module apply
      // a patch by calling a reader -- a silent no-op, not a trap.
      ["wpk_fork_module_table_read", constant("DRIVE_SLOT_TABLE_READ")],
      ["wpk_fork_module_table_length", constant("DRIVE_SLOT_TABLE_LENGTH")],
      ["wpk_fork_module_table_apply", constant("DRIVE_SLOT_TABLE_APPLY")],
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
      "wpk_fork_module_table_apply",
      "wpk_fork_module_table_length",
      "wpk_fork_module_table_read",
      "wpk_fork_rewind_begin",
      "wpk_fork_rewind_end",
      "wpk_fork_unwind_begin",
      "wpk_fork_unwind_end",
    ]);
  });

  it("reserves the stride fork-codec reserves", () => {
    // The module derives every slot from the drive base. A host growing by
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

describe("activation admission descriptor", () => {
  // The host WRITES `KFAA` and the module decodes it, so every number the TS
  // writer hard-codes is a duplicate of `fork_codec::activation_admission`.
  // A drifted kind number files a GC codec as a resume catalog -- refused, at
  // best -- and a drifted header offset moves the template id; both are pinned
  // here against the Rust source. `fork-module-admission.test.ts` has the
  // real module admit what the writer produces for a real guest.
  const admission = readFileSync(
    join(import.meta.dirname, "..", "..", "crates/fork-codec/src/activation_admission.rs"),
    "utf8",
  );
  function constant(name: string): string {
    const match = new RegExp(`pub const ${name}: [a-z0-9;\\[\\] ]+ = ([^;]+);`).exec(admission);
    if (!match) throw new Error(`activation_admission.rs no longer defines ${name}`);
    return match[1]!.trim();
  }

  it("writes the codec's header layout and flag bits", () => {
    expect(constant("ADMISSION_MAGIC")).toBe('*b"KFAA"');
    expect(constant("ADMISSION_VERSION")).toBe("1");
    expect(constant("ADMISSION_HEADER_SIZE")).toBe("64");
    expect(constant("ADMISSION_SECTION_REF_SIZE")).toBe("12");
    expect(constant("ADMISSION_TEMPLATE_ID_OFFSET")).toBe("16");
    expect(constant("ADMISSION_TEMPLATE_ID_SIZE")).toBe("32");
    expect(constant("ADMISSION_FLAG_BORROWED_CHILD")).toBe(`1 << ${Math.log2(FORK_ADMISSION_BORROWED_CHILD)}`);
    expect(constant("ADMISSION_FLAG_FORK_CHILD")).toBe(`1 << ${Math.log2(FORK_ADMISSION_FORK_CHILD)}`);
    // And the writer puts them where the constants say.
    const empty = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const desc = encodeForkAdmission(9, 3, new Uint8Array(32).fill(7), empty);
    const view = new DataView(desc.buffer);
    expect(desc.length).toBe(64);
    expect(new TextDecoder().decode(desc.subarray(0, 4))).toBe("KFAA");
    expect([view.getUint16(4, true), view.getUint16(6, true)]).toEqual([1, 64]);
    expect([view.getUint32(8, true), view.getUint32(12, true), view.getUint32(48, true)]).toEqual([9, 3, 0]);
    expect([...desc.subarray(16, 48)].every((b) => b === 7)).toBe(true);
  });

  it("numbers each section kind as the codec does", () => {
    // Each `AdmissionSectionKind` variant carries its section name in its doc
    // comment and its wire number as its discriminant.
    const variants = [...admission.matchAll(
      /\/\/\/ `(kandelo\.wpk_fork\.[a-z_]+)`[^\n]*\n\s*([A-Z][A-Za-z]+) = ([0-9]+),/g,
    )].map((m) => [Number(m[3]), m[1]] as const);
    expect(variants.length).toBe(FORK_ADMISSION_SECTIONS.length);
    for (const [kind, name] of variants) {
      expect(FORK_ADMISSION_SECTIONS[kind - 1], `kind ${kind}`).toBe(name);
    }
  });
});
