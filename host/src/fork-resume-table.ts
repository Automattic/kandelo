/**
 * How an activation's resume thunks reach the guest's `__wpk_fork_resume_table`.
 *
 * # What this does, stated as what it is rather than what it was
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
 * ONE ALLOCATOR, which is why there is nothing here to keep in step. The
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
 * # What it no longer owns
 *
 * It was a class, `ForkResumeTable`, holding the module and its table as one
 * fact and asking the module for each activation's assignment. Lane F stage 1b
 * folded that ask into `fm_bind_activation`, whose row `ForkActivations`
 * already reads at registration, so what is left is the one guest call and
 * the one check that has to accompany it. The table object is the module's
 * export, bound by `buildForkGuestImports`, and nothing here needs it.
 *
 * # NO `Table.set` SURVIVES HERE, and the argument that kept the last one
 *
 * `unregisterActivation` used to null each slot it released, on the argument
 * that "Rust cannot hold a funcref, therefore the host has to clear the
 * table". The premise is true and the inference does not follow: clearing
 * writes `ref.null func`, which is not holding a funcref. The module owns the
 * table, and the injector already emits table primitives into it for exactly
 * this reason, so an emitted `table.set $resume (ref.null func)` now runs from
 * inside `resume_unregister_impl` -- reached by the `fm_resume_slots` op-1
 * release (issued by `ForkActivations.forget` now), because the release is
 * the only moment the nulling ever happened while it was here. The recorded
 * slot list went with it, along with the `slots` field of
 * `ForkResumeAssignment` and `slotsOf()`. The merged catalogs and the drive
 * table followed the same argument on 2026-09-23 (`__wpk_fork_table_null`).
 *
 * This is the SECOND time that exact "cannot hold a funcref, therefore host"
 * argument has been wrong about this one table. The first was the table
 * object itself (census 198), which the injector had been able to declare all
 * along. A floor claim that has been wrong here before is not evidence the
 * second time.
 */

/**
 * One activation's published `(ordinal, slot)` decision.
 *
 * `ptr` and `count` are handed to the guest untouched -- they address the
 * module's own buffer in the memory the guest shares. Nothing is decoded on
 * the way through: this side does not learn which slots the activation got,
 * because nothing on this side needs to know any more.
 */
export interface ForkResumeAssignment {
  readonly ptr: number;
  readonly count: number;
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

/**
 * Have one activation place its own resume thunks, from the assignment its
 * `fm_bind_activation` row carries.
 *
 * One guest call, whatever the activation's size. The host reads no thunk,
 * writes no thunk and chooses no slot. Placement is safe at registration for
 * the reason the placement plan turns on: the instance exists, so its catalog
 * table is populated -- the instrumenter emits that table with an ACTIVE
 * element segment added after `module_state::plan` has converted the guest's
 * original ones, so the engine fills it at instantiation and no bootstrap has
 * to run first.
 */
export function placeForkResumeThunks(
  label: string,
  activationId: number,
  instance: WebAssembly.Instance,
  { ptr, count }: ForkResumeAssignment,
): void {
  const place = instance.exports[PLACE_RESUME_THUNKS] as
    | ((pairs: number, count: number) => number)
    | undefined;
  if (typeof place !== "function") {
    throw new Error(
      `${label}: activation ${activationId} exports no ` +
        `${PLACE_RESUME_THUNKS}, so it cannot place its own resume thunks. ` +
        `A fork-instrumented artifact always carries it; this one was ` +
        `instrumented by an older toolchain or not at all.`,
    );
  }
  // THE ONE CHECK THAT SURVIVED THE PER-THUNK LOOP. The shim traps on an
  // out-of-range ordinal, so a guest with FEWER thunks than the module was
  // admitted with still fails loudly -- but a guest with MORE would place a
  // prefix and leave the rest at no slot at all, silently. Both ends are the
  // same fact: the instrumenter numbers resume thunks 0..n-1 in catalog order,
  // so an admitted catalog and its guest agree on the count or they are not
  // the same artifact.
  const catalog = instance.exports[RESUME_CATALOG] as
    | WebAssembly.Table
    | undefined;
  if (catalog?.length !== count) {
    throw new Error(
      `${label}: activation ${activationId} instantiated with ` +
        `${catalog?.length ?? "no"} resume thunks, but the module assigned ` +
        `${count} slots from the catalog it was admitted with. The admitted ` +
        `module and the instantiated one are not the same artifact.`,
    );
  }
  // The return is `max(count, 0)` -- what was ASKED for, not what succeeded.
  // Every failure mode inside the shim traps, so there is nothing to check
  // that would not be a check against itself.
  place(ptr, count);
}
