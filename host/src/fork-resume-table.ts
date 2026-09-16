/**
 * The guest's `__wpk_fork_resume_table`: a `WebAssembly.Table` of resume thunks.
 *
 * The table object itself is host floor and cannot move into the fork module:
 * Rust cannot hold a funcref, the guest imports the table by name, and the
 * module's `resume_peek` returns an index INTO it. So a real
 * `WebAssembly.Table` has to exist here, and something on this side has to
 * `table.set` the thunks.
 *
 * # What this is NOT any more, and why that matters
 *
 * It is not a slot ALLOCATOR. It used to be, and the duplication was the
 * lane's most dangerous: this class and `fork_codec::ResumeSlotTable` each
 * implemented the same four rules -- slot 0 reserved, ordinals sorted
 * ascending, repeats rejected, freed slots reused smallest-first -- and the
 * guard in `host/test/fork-resume-table.test.ts` checked only that those rules
 * were still SPELLED the same in both places.
 *
 * The rules were never the problem. WHEN each table was built was. This one is
 * built per WORKER and mutated as activations come and go; the module built a
 * fresh one per FORK, so it never had freed slots to reuse:
 *
 *   dlopen A (1 target), dlopen B (2), dlclose A, dlopen C (2), then fork.
 *   host:   B at 4,5   C at 3,6      (3 was freed by A and reused first)
 *   module: B at 3,4   C at 5,6      (fresh table, ascending activation id)
 *
 * Three coordinates disagree, so the guest resumes into another activation's
 * thunk -- a real function of the right type, so nothing traps. A
 * rule-comparison guard cannot see this, because both sides follow the rules.
 *
 * The module now decides every slot once, when the host seeds that
 * activation's catalog, and this class ASKS (`fm_resume_slots`). There is one
 * allocator, so there is nothing left to diverge. Census 194.
 */

/** One fork-instrumented function a guest can be resumed into. */
export interface ForkResumeTarget {
  readonly functionOrdinal: number;
  readonly thunk: WebAssembly.ExportValue;
}

/** What this needs from the co-resident module: the slot, and its release. */
export interface ForkResumeSlots {
  resumeSlot(activationId: number, functionOrdinal: number): number;
  releaseResumeSlots(activationId: number): number;
}

export class ForkResumeTable {
  /** Slot 0 is the reserved "no event" sentinel, so the table starts at 1. */
  readonly table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });

  private readonly activationSlots = new Map<number, number[]>();
  private slots: ForkResumeSlots | null = null;

  constructor(private readonly label = "fork resume table") {}

  /**
   * Bind the module that decides the numbering.
   *
   * Late, and not incidentally: this table exists before the fork-module does
   * (the guest's import object is built first), so the binding cannot be a
   * constructor argument. Registering before it is bound is refused rather than
   * deferred -- a thunk placed at a slot nobody assigned is the silent
   * corruption this whole file exists to prevent.
   */
  bindSlots(slots: ForkResumeSlots): void {
    this.slots = slots;
  }

  /**
   * Place one activation's resume thunks at the slots the module assigned them.
   *
   * The ORDER of `targets` no longer matters here, because this no longer
   * decides anything: each thunk goes where `fm_resume_slots` says, and the
   * module made that decision from the catalog the host seeded for this same
   * activation.
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
    const slots = this.requireSlots();
    const placed: number[] = [];
    for (const target of targets) {
      if (!Number.isInteger(target.functionOrdinal) || target.functionOrdinal < 0) {
        throw new RangeError(
          `${this.label}: invalid resume function ordinal ${target.functionOrdinal}`,
        );
      }
      if (typeof target.thunk !== "function") {
        throw new TypeError(
          `${this.label}: resume target ${target.functionOrdinal} is not a Wasm ` +
            `function`,
        );
      }
      // A coordinate the module did not assign is refused HERE, naming it.
      // Reached when the catalog the host seeded and the exports it read
      // disagree -- which is a real mismatch, not a numbering question, and one
      // this class can no longer paper over by inventing a slot.
      const slot = slots.resumeSlot(activationId, target.functionOrdinal);
      this.grow(slot);
      this.table.set(slot, target.thunk);
      placed.push(slot);
    }
    this.activationSlots.set(activationId, placed);
  }

  /** Release an activation's slots for reuse, and null its entries. */
  unregisterActivation(activationId: number): void {
    const slots = this.activationSlots.get(activationId);
    if (slots === undefined) {
      throw new Error(
        `${this.label}: activation ${activationId} is not registered`,
      );
    }
    for (const slot of slots) this.table.set(slot, null);
    this.activationSlots.delete(activationId);
    // The module frees them; this side only stops pointing at them. Doing it
    // AFTER the nulling means a throw from the module leaves no live thunk at a
    // slot the module still believes is assigned.
    this.requireSlots().releaseResumeSlots(activationId);
  }

  /** Release every activation, highest id first. */
  clear(): void {
    for (const activationId of [...this.activationSlots.keys()].sort(
      (left, right) => right - left,
    )) {
      this.unregisterActivation(activationId);
    }
  }

  /** The slots one registered activation occupies, for tests and diagnostics. */
  slotsOf(activationId: number): readonly number[] {
    return this.activationSlots.get(activationId) ?? [];
  }

  private requireSlots(): ForkResumeSlots {
    if (!this.slots) {
      throw new Error(
        `${this.label}: no fork module bound, so no slot numbering exists. ` +
          `Call bindSlots() before registering an activation -- placing a ` +
          `thunk at a slot nobody assigned is how a guest resumes into the ` +
          `wrong function.`,
      );
    }
    return this.slots;
  }

  /** Grow so `slot` is addressable. The module numbers; this only sizes. */
  private grow(slot: number): void {
    if (slot < this.table.length) return;
    this.table.grow(slot - this.table.length + 1);
  }
}
