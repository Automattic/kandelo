import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The drive-op numbering is a contract between two files that do not import
 * each other, and it is enforced by a comment.
 *
 * `crates/fork-codec/src/drive_plan.rs` assigns every `DRIVE_OP_*` value.
 * `crates/fork-module-inject/src/main.rs` re-declares three of them as its own
 * `const`s and uses them as BAND BOUNDARIES to decide how the injected
 * `fm_drive_execute` shim calls a guest export:
 *
 *   op >= DRIVE_OP_UNWIND_END    -> `() -> ()`      (no argument)
 *   op >= DRIVE_OP_REWIND_BEGIN  -> `(ptr) -> ()`   (a continuation root)
 *   otherwise                    -> `(i32) -> ()`   (an activation id)
 *   op <  DRIVE_OP_RESTORE       -> also counts as a reconstruction step
 *
 * So the numbers are not labels. An op's VALUE decides the signature it is
 * called with, and the injector's copy of the boundaries decides where each
 * band starts. If the two files disagree — or if an op is added in the wrong
 * band — the shim calls a guest export with the wrong signature. That is a
 * `call_indirect` type mismatch at best and a wrong call at worst, and nothing
 * in either file would report it: the injector's own comment says "MUST match"
 * and nothing checks that it does.
 *
 * This file is that check. It exists so the numbering can be CHANGED safely —
 * adding an activation-argument op (a module-state save drive, say) means
 * widening the `(i32)` band and shifting everything above it, which is exactly
 * the edit these assertions are here to catch going half-done.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const drivePlan = readFileSync(
  join(repoRoot, "crates/fork-codec/src/drive_plan.rs"),
  "utf8",
);
const injector = readFileSync(
  join(repoRoot, "crates/fork-module-inject/src/main.rs"),
  "utf8",
);

/** Every `pub const DRIVE_OP_NAME: u32 = N;` in fork-codec, by name. */
function planOps(): Map<string, number> {
  const ops = new Map<string, number>();
  for (const [, name, value] of drivePlan.matchAll(
    /^pub const DRIVE_OP_([A-Z_]+): u32 = (\d+);/gm,
  )) {
    ops.set(name, Number(value));
  }
  return ops;
}

/** The injector's own re-declaration of one op constant. */
function injectorOp(name: string): number {
  const match = new RegExp(`^const DRIVE_OP_${name}: i32 = (\\d+);`, "m").exec(
    injector,
  );
  if (!match) throw new Error(`the injector no longer declares DRIVE_OP_${name}`);
  return Number(match[1]);
}

describe("drive-op numbering, across the two files that must agree", () => {
  const ops = planOps();

  it("re-declares the same value fork-codec assigns", () => {
    // The whole hazard in one assertion. The injector duplicates these because
    // it emits wasm and cannot depend on the crate; nothing but this test has
    // ever compared them.
    expect(ops.size).toBeGreaterThan(0);
    for (const name of ["ALLOC", "STATIC_ROOT", "RESTORE", "REWIND_BEGIN", "UNWIND_END"]) {
      expect(injectorOp(name), `DRIVE_OP_${name}`).toBe(ops.get(name));
    }
  });

  it("puts every op in the band whose call signature it needs", () => {
    // Derived from what each guest export actually takes, NOT from the current
    // numbering -- otherwise this would agree with any renumbering, including a
    // wrong one.
    const activationArg = ["RESTORE", "FINISH_RESTORE", "MODULE_STATE_SAVE"];
    const pointerArg = ["REWIND_BEGIN", "ABORT_BEGIN", "UNWIND_BEGIN"];
    const noArg = ["UNWIND_END", "REWIND_END", "ABORT_END"];
    const reconstruction = ["ALLOC", "FILL", "EXN", "STATIC_ROOT"];

    const restore = ops.get("RESTORE")!;
    const rewindBegin = ops.get("REWIND_BEGIN")!;
    const unwindEnd = ops.get("UNWIND_END")!;

    for (const name of reconstruction) {
      expect(ops.get(name), `${name} must count as reconstruction`).toBeLessThan(restore);
    }
    for (const name of activationArg) {
      const op = ops.get(name)!;
      expect(op, `${name} takes an activation id`).toBeGreaterThanOrEqual(restore);
      expect(op, `${name} takes an activation id`).toBeLessThan(rewindBegin);
    }
    for (const name of pointerArg) {
      const op = ops.get(name)!;
      expect(op, `${name} takes a root pointer`).toBeGreaterThanOrEqual(rewindBegin);
      expect(op, `${name} takes a root pointer`).toBeLessThan(unwindEnd);
    }
    for (const name of noArg) {
      expect(ops.get(name), `${name} takes no argument`).toBeGreaterThanOrEqual(unwindEnd);
    }
  });

  it("leaves no op unaccounted for", () => {
    // A new op added to fork-codec and not classified above lands in whichever
    // band its number happens to fall in, which is how an activation-argument
    // op gets called as a void one.
    const classified = new Set([
      "ALLOC", "FILL", "EXN", "STATIC_ROOT",
      "RESTORE", "FINISH_RESTORE", "MODULE_STATE_SAVE",
      "REWIND_BEGIN", "ABORT_BEGIN", "UNWIND_BEGIN",
      "UNWIND_END", "REWIND_END", "ABORT_END",
    ]);
    const unclassified = [...ops.keys()].filter((n) => !classified.has(n));
    expect(unclassified).toEqual([]);
  });

  it("numbers the ops contiguously from zero, but for the one retired value", () => {
    // The bands are half-open ranges over the op values, so a gap or a repeat
    // silently moves a boundary. Exactly one gap is deliberate: op 4 was
    // DRIVE_OP_EXTERNREF_TRANSIT, retired in externref stage E2 (a fork no
    // longer carries a raw host externref), and left unused so the ops after
    // it kept their values. It sits inside the reconstruction band, so it
    // moves no boundary.
    const RETIRED = [4];
    expect(drivePlan, "op 4 is documented as retired").toMatch(/`op` 4 is RETIRED/);
    expect([...ops.values()], "no op reuses a retired value").not.toContain(4);
    const values = [...ops.values(), ...RETIRED].sort((a, b) => a - b);
    expect(values).toEqual(values.map((_, i) => i));
    expect(RETIRED[0]!, "the retired value is inside the reconstruction band")
      .toBeLessThan(ops.get("RESTORE")!);
  });
});
