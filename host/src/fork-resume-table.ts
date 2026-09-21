/**
 * The host's lifetime record for the guest's `__wpk_fork_resume_table`.
 *
 * # What this class does, stated as what it is rather than what it was
 *
 * It does not allocate slots. It does not write thunks. It does not ask for a
 * slot one coordinate at a time. The module decides every slot once, when the
 * host seeds that activation's catalog, and publishes the whole decision into
 * memory the co-resident guest shares; the guest's own emitted
 * `__wpk_fork_place_resume_thunks` then copies each thunk out of its catalog
 * table into the process resume table. No funcref crosses into JavaScript in
 * either direction.
 *
 * Measured over the two-activation fixture the placement baseline records (86
 * ordinals in the main program, 1 in the side module it dlopens): 87 calls
 * into the module became 2, and 348 JS/wasm boundary crossings -- 87 op-0
 * queries, 87 `table.get`, 87 `table.set`, 87 `table.grow` -- became 4. The
 * ratio is per-thunk, so it scales: php's 19,025 resume thunks per process
 * start, the figure `docs/surface-budget.json` quotes, is 76,100 crossings
 * under the old path and 2 under this one.
 *
 * ONE ALLOCATOR, which is why there is nothing here to keep in step. This
 * class used to run the module's four rules again -- slot 0 reserved, ordinals
 * sorted ascending, repeats rejected, freed slots reused smallest-first -- and
 * the guard that watched the pair only checked that both still SPELLED them
 * the same. The rules were never the problem; WHEN each table was built was.
 * This side's was per WORKER and mutated as activations came and went, the
 * module's was fresh per FORK and so never had a freed slot to reuse, and
 * `dlclose` of a library while a later-loaded one is still open makes them
 * differ on three coordinates. The guest then resumes into another
 * activation's thunk: a real function of the right type, so nothing traps.
 * Census 194.
 *
 * # What it still owns
 *
 * A lifetime record, and two guards that need it:
 *
 *  - WHICH ACTIVATIONS ARE REGISTERED. A host question: the module answers
 *    "holds no slots" both for an activation that was never seeded and for one
 *    whose catalog is legitimately empty, and reading the second as the first
 *    cost a real fork (`libneeded-provider.so`).
 *  - WHICH SLOTS EACH HOLDS, so `dlclose` can null exactly those entries.
 *  - THE MODULE AND ITS TABLE AS ONE FACT, because a slot is an index into
 *    that table and the two are unusable apart.
 *
 * # The one `Table.set` that is left, and why it is not a floor
 *
 * `unregisterActivation` nulls the slots it releases. It is the only write to
 * the resume table anywhere in `host/src`, and the argument that keeps it here
 * -- "Rust cannot hold a funcref, therefore the host has to clear the table"
 * -- does not follow. Clearing writes `ref.null func`, which is not holding a
 * funcref, and the injector already emits table primitives into this module
 * for precisely that reason: `fm_transit_grow` is `table.size` + `table.grow`
 * on the anyref transit table, emitted by
 * `crates/fork-module-inject/src/main.rs` and called from Rust through a
 * rewritten placeholder import. The same shape -- an emitted
 * `table.set $resume (ref.null func)`, called from the `fm_resume_slots` op-1
 * release the host already issues -- would take the nulling with it, and the
 * recorded slot list and the `slots` field of `ForkResumeAssignment` with
 * that.
 *
 * Not done here: it adds an injected module export and changes two crates this
 * change does not own. Recorded in the code rather than only in a report, so
 * that it stays a decision someone took instead of a rule nobody noticed.
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
   * BOTH come from the module, and they arrive together because they are the
   * same fact: a slot is an index into that table. The host used to mint a
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
   * Two calls, whatever the activation's size: one to the module for the
   * published `(ptr, count)`, one to the guest's own shim to apply it. The
   * host reads no thunk, writes no thunk and chooses no slot.
   *
   * # What the host does here, and why each is not the guest's
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
   * call sites (`host/src/worker-main.ts:1031`, `:4656`, `:6962`), all of
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
    // check that would not be a check against itself. Nothing compensates for
    // a shim that does nothing, either: the table simply stays empty at those
    // slots, which is the failure being visible rather than papered over.
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

  /**
   * Release every activation, highest id first.
   *
   * The ORDER is this side's choice and nothing downstream reads it: the
   * module frees into a bitmap, which is order-independent. It mirrors reverse
   * load order, which is the order a process tears down its libraries in.
   */
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
