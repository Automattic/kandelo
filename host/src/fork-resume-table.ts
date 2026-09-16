/**
 * The guest's `__wpk_fork_resume_table`: a `WebAssembly.Table` of resume thunks.
 *
 * This is host floor and cannot move into the fork module. The module's
 * `resume_peek` returns a slot INDEX, and something has to hold the funcrefs
 * that index selects -- Rust cannot hold a funcref, and the guest imports the
 * table by name, so it must be a real `WebAssembly.Table` a host constructs.
 *
 * # What this is NOT
 *
 * It is not the slot-selection AUTHORITY. `ResumeSlotTable` in
 * `crates/fork-codec/src/replay_journal.rs` is, and the module resolves every
 * `(activation, ordinal)` coordinate to a slot itself. The version of this class
 * in the attic also carried a `targets` map and a `slotFor()` that answered the
 * same question in JavaScript; both are gone, because two implementations of one
 * numbering is the drift this campaign exists to remove.
 *
 * # Why the placement rule is still duplicated
 *
 * What remains duplicated is unavoidable and narrow: WHERE each thunk goes. The
 * module cannot write this table, so the host must put thunk `k` in the slot the
 * module will name, which means both sides run the same rule --
 *
 *   slot 0 is reserved; each activation's ordinals are sorted ascending and take
 *   the smallest free slots, freed slots before freshly grown ones
 *
 * -- and the module's comment calls this out as the resume-slot PARITY contract:
 * "both sides sort the identical ordinal set and assign slots the same way, so
 * `call_indirect` never targets the wrong thunk". Getting it wrong is silent: the
 * guest resumes into a real function that is the wrong one.
 *
 * WHAT GUARDS IT, STATED ACCURATELY. `host/test/fork-resume-table.test.ts`
 * does NOT drive the same sequences through both -- this comment used to say it
 * did. It matches four REGEXES against
 * `crates/fork-codec/src/replay_journal.rs` (numbering starts at 1, ordinals
 * sorted ascending, a repeated ordinal rejected, freed slots reused
 * smallest-first). So it fails if someone edits those four lines, and passes if
 * someone changes the allocator's BEHAVIOUR without touching their text. That
 * is a tripwire, and worth having; it is not parity.
 *
 * The fix is not a better test. It is for this class to stop existing: the
 * module can own the funcref table the way it already owns the anyref transit
 * table (the injector defines and exports it), with an injected
 * `(activation, ordinal, funcref) -> slot` binder doing the `table.set` Rust
 * cannot. Then there is one numbering. See "What is required to close lane F"
 * in docs/plans/2026-09-11-MASTER-PLAN.md.
 */

/** One fork-instrumented function a guest can be resumed into. */
export interface ForkResumeTarget {
  readonly functionOrdinal: number;
  readonly thunk: WebAssembly.ExportValue;
}

export class ForkResumeTable {
  /** Slot 0 is the reserved "no event" sentinel, so the table starts at 1. */
  readonly table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });

  private readonly activationSlots = new Map<number, number[]>();
  private readonly freeSlots: number[] = [];

  constructor(private readonly label = "fork resume table") {}

  /**
   * Place one activation's resume thunks, in the order the module will number
   * them.
   *
   * Rejects a repeated ordinal rather than letting the later thunk win: the
   * module rejects the same catalog with EINVAL, and a host that quietly
   * accepted it would place N-1 thunks where the module expects N and shift
   * every later slot by one.
   */
  registerActivation(
    activationId: number,
    targets: readonly ForkResumeTarget[],
  ): void {
    if (!Number.isInteger(activationId) || activationId < 0) {
      throw new RangeError(`${this.label}: invalid activation id ${activationId}`);
    }
    if (this.activationSlots.has(activationId)) {
      throw new Error(
        `${this.label}: activation ${activationId} is already registered`,
      );
    }
    const ordered = [...targets].sort(
      (left, right) => left.functionOrdinal - right.functionOrdinal,
    );
    const slots: number[] = [];
    let previous: number | undefined;
    for (const target of ordered) {
      if (!Number.isInteger(target.functionOrdinal) || target.functionOrdinal < 0) {
        throw new RangeError(
          `${this.label}: invalid resume function ordinal ${target.functionOrdinal}`,
        );
      }
      if (previous === target.functionOrdinal) {
        throw new Error(
          `${this.label}: activation ${activationId} repeats function ordinal ` +
            `${previous}`,
        );
      }
      previous = target.functionOrdinal;
      if (typeof target.thunk !== "function") {
        throw new TypeError(
          `${this.label}: resume target ${target.functionOrdinal} is not a Wasm ` +
            `function`,
        );
      }
      const slot = this.allocateSlot();
      this.table.set(slot, target.thunk);
      slots.push(slot);
    }
    this.activationSlots.set(activationId, slots);
  }

  /** Release an activation's slots for reuse, and null its entries. */
  unregisterActivation(activationId: number): void {
    const slots = this.activationSlots.get(activationId);
    if (slots === undefined) {
      throw new Error(
        `${this.label}: activation ${activationId} is not registered`,
      );
    }
    for (const slot of slots) {
      this.table.set(slot, null);
      this.freeSlots.push(slot);
    }
    this.freeSlots.sort((left, right) => left - right);
    this.activationSlots.delete(activationId);
  }

  /** Release every activation, highest id first. */
  clear(): void {
    for (const activationId of [...this.activationSlots.keys()].sort(
      (left, right) => right - left,
    )) {
      this.unregisterActivation(activationId);
    }
    this.freeSlots.length = 0;
  }

  /** The slots one registered activation occupies, for tests and diagnostics. */
  slotsOf(activationId: number): readonly number[] {
    return this.activationSlots.get(activationId) ?? [];
  }

  /** Smallest free slot, else a freshly grown one. Mirrors `allocate_slot`. */
  private allocateSlot(): number {
    const reused = this.freeSlots.shift();
    if (reused !== undefined) return reused;
    const slot = this.table.length;
    this.table.grow(1);
    return slot;
  }
}
