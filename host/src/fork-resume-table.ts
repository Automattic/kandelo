/**
 * The guest's `__wpk_fork_resume_table`: a `WebAssembly.Table` of resume thunks.
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
 * activation's catalog. There is one allocator, so there is nothing left to
 * diverge. Census 194.
 *
 * # It is not a slot WRITER either, as of the placement cutover
 *
 * The header used to open by calling the table "host floor", on the argument
 * that Rust cannot hold a funcref, so something on this side has to
 * `table.set` the thunks. The premise is true and the conclusion does not
 * follow -- the same shape of error `forkModuleInjectorHelpers` records for
 * the table OBJECT, which the injector declares and the module exports. The
 * copy is between two tables the GUEST holds: its own resume catalog, and the
 * process resume table it imports. So the guest does it, in wasm the
 * instrumenter emits (`__wpk_fork_place_resume_thunks`), over a decision the
 * module publishes. No funcref crosses into JavaScript in either direction.
 *
 * What is left here is a lifetime record: which activations are registered,
 * and which slots each holds, so `dlclose` can null exactly those entries.
 * The `table.set` in `unregisterActivation` is the only one in this file.
 */

/**
 * One activation's published `(ordinal, slot)` decision.
 *
 * `ptr` and `count` are handed to the guest untouched -- they address the
 * module's own buffer in the memory the guest shares. `slots` is the copy this
 * class keeps, and the only reason it keeps one is `unregisterActivation`.
 */
export interface ForkResumeAssignment {
  readonly ptr: number;
  readonly count: number;
  readonly slots: readonly number[];
}

/** What this needs from the co-resident module: the assignment, and its release. */
export interface ForkResumeSlots {
  publishResumeAssignment(activationId: number): ForkResumeAssignment;
  releaseResumeSlots(activationId: number): number;
}

/**
 * The guest export that performs the placement.
 *
 * Emitted into every fork-instrumented artifact by
 * `crates/fork-instrument/src/instrument.rs` (`emit_resume_placement_shim`),
 * whose name constant is `runtime::names::EXPORT_PLACE_RESUME_THUNKS`. It
 * grows the resume table itself, traps on the reserved slot 0 and on an
 * out-of-range ordinal or slot, and returns the count it was ASKED for -- not
 * a success tally, because every failure mode in it traps.
 */
const PLACE_RESUME_THUNKS = "__wpk_fork_place_resume_thunks";

/**
 * The guest's own table of resume thunks, which the shim copies OUT of.
 *
 * Read here only for its length. It is `RESUME_CATALOG_EXPORT` in
 * `crates/fork-instrument/src/instrument.rs`, sized to the thunk count with an
 * ACTIVE element segment, so it is full the moment the instance exists.
 */
const RESUME_CATALOG = "__wpk_fork_resume_catalog";

export class ForkResumeTable {
  private readonly activationSlots = new Map<number, readonly number[]>();
  /**
   * The numbering and the table it indexes, as ONE thing.
   *
   * They are set together and they are unusable apart -- a slot is an index
   * into that table -- so one field means one guard rather than two that can
   * only ever disagree by a bug.
   */
  private bound: { slots: ForkResumeSlots; table: WebAssembly.Table } | null = null;

  constructor(private readonly label = "fork resume table") {}

  /**
   * Bind the module that owns the table and decides the numbering.
   *
   * BOTH come from the module now, and they arrive together because they are
   * the same fact: a slot is an index into that table. The host used to mint a
   * `WebAssembly.Table` here and hand it to the guest in `extras`, which made
   * "the guest's table" and "the table the module numbers" a per-caller
   * convention rather than one object.
   *
   * Late, and not incidentally: this class exists before the fork-module does,
   * because the guest's import object is assembled around it. Registering
   * before it is bound is refused rather than deferred -- a thunk placed at a
   * slot nobody assigned is the silent corruption this file exists to prevent.
   */
  bindSlots(slots: ForkResumeSlots, table: WebAssembly.Table): void {
    this.bound = { slots, table };
  }

  /** The module's table, for callers that need the object itself. */
  get resumeTable(): WebAssembly.Table {
    return this.require().table;
  }

  /**
   * Have one activation place its own resume thunks.
   *
   * # What this stopped doing, and why it is the point of the change
   *
   * It used to loop: ask `fm_resume_slots` op 0 for a slot, grow the table,
   * `table.set` the thunk, once per fork-instrumented function. The thunks
   * themselves came from `forkResumeTargetsFromInstance`, which was another
   * per-function loop reading the guest's catalog table with `table.get`. For
   * php that is 19,025 of each per process start, and every one of them
   * crossed the JS/wasm boundary to move a funcref between two tables the
   * GUEST already holds.
   *
   * Now the module publishes the whole decision into memory the guest shares,
   * and the guest's own emitted shim applies it. Two calls per activation,
   * whatever its size, and no funcref crosses into JavaScript at all.
   *
   * # What the host still does here, and why each is not the guest's
   *
   * It refuses a double registration, because whether an activation is
   * registered is a HOST lifetime question -- the module answers "holds no
   * slots" for an activation that was never seeded AND for one whose catalog
   * is legitimately empty, which is the `libneeded-provider.so` case that cost
   * a real fork. And it keeps the published slot list, because
   * `unregisterActivation` must null exactly those entries when `dlclose`
   * releases them.
   *
   * `instance` is the guest being registered. It is available at all three
   * call sites (`host/src/worker-main.ts:1034`, `:4662`, `:6971`), all of
   * which already had it, and placement is safe there for the reason the plan
   * turns on: the instance exists, so its catalog table is populated -- the
   * instrumenter emits that table with an ACTIVE element segment added after
   * `module_state::plan` has converted the guest's original ones, so the
   * engine fills it at instantiation and no bootstrap has to run first.
   */
  registerActivation(
    activationId: number,
    instance: WebAssembly.Instance,
  ): void {
    if (!Number.isInteger(activationId) || activationId < 0) {
      throw new RangeError(`${this.label}: invalid activation id ${activationId}`);
    }
    if (this.activationSlots.has(activationId)) {
      throw new Error(
        `${this.label}: activation ${activationId} is already registered`,
      );
    }
    const place = instance.exports[PLACE_RESUME_THUNKS] as
      | ((pairs: number, count: number) => number)
      | undefined;
    if (typeof place !== "function") {
      throw new Error(
        `${this.label}: activation ${activationId} exports no ` +
          `${PLACE_RESUME_THUNKS}, so it cannot place its own resume thunks. ` +
          `A fork-instrumented artifact always carries it; this one was ` +
          `instrumented by an older toolchain or not at all.`,
      );
    }
    const { ptr, count, slots } = this.require().slots.publishResumeAssignment(
      activationId,
    );
    // THE ONE CHECK THAT SURVIVED THE PER-THUNK LOOP, and it is O(1) where the
    // old one was O(n). `forkResumeTargetsFromInstance` used to read every
    // catalog entry and refuse a slot the module had not assigned, which is
    // how a guest seeded from one artifact and instantiated from another was
    // caught. The shim traps on an out-of-range ordinal, so a guest with FEWER
    // thunks than the module was seeded with still fails loudly -- but a guest
    // with MORE would place a prefix and leave the rest at no slot at all,
    // silently. Both ends are the same fact: the instrumenter numbers resume
    // thunks 0..n-1 in catalog order, so a seeded catalog and its guest agree
    // on the count or they are not the same artifact.
    const catalog = instance.exports[RESUME_CATALOG] as
      | WebAssembly.Table
      | undefined;
    if (catalog?.length !== count) {
      throw new Error(
        `${this.label}: activation ${activationId} instantiated with ` +
          `${catalog?.length ?? "no"} resume thunks, but the module assigned ` +
          `${count} slots from the catalog it was seeded with. The seeded ` +
          `module and the instantiated one are not the same artifact.`,
      );
    }
    // The return is `max(count, 0)` -- what was ASKED for, not what succeeded.
    // Every failure mode inside the shim traps, so there is nothing here to
    // check that would not be a check against itself.
    place(ptr, count);
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
    for (const slot of slots) this.resumeTable.set(slot, null);
    this.activationSlots.delete(activationId);
    // The module frees them; this side only stops pointing at them. Doing it
    // AFTER the nulling means a throw from the module leaves no live thunk at a
    // slot the module still believes is assigned.
    this.require().slots.releaseResumeSlots(activationId);
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

  private require(): { slots: ForkResumeSlots; table: WebAssembly.Table } {
    if (!this.bound) {
      throw new Error(
        `${this.label}: no fork module bound, so there is no resume table and ` +
          `no slot numbering. Call bindSlots() first -- placing a thunk at a ` +
          `slot nobody assigned is how a guest resumes into the wrong function.`,
      );
    }
    return this.bound;
  }
}
