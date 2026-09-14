/**
 * The process-owned `(ref null any)` transit table, as the host sees it.
 *
 * The table itself is the MODULE's: the injector defines and exports
 * `__wpk_fork_ref_gc_transit`, and growth is the module's `fm_transit_grow`.
 * What is left for a host is reading and writing slots, which Rust cannot do to
 * a reference-typed table.
 *
 * So this is a view, not an owner. The version it replaces minted its own table
 * when no fork module was present -- a branch that cannot happen now the module
 * is unconditional, and one that could silently give the guest, the module and
 * the host three different tables to disagree about.
 */

/** Slot 0 is the staging slot every publish passes through. */
export const FORK_TRANSIT_STAGING_SLOT = 0;

export class ForkAnyrefTransitTable {
  private readonly table: WebAssembly.Table;
  private readonly growTransit: (needed: number) => number;
  private readonly lastErrno: () => number;

  /**
   * Takes the module's EXPORTS, and names the one that is missing.
   *
   * All three are read by name because the one production call site passed the
   * transit TABLE instead of the exports. A table has no
   * `__wpk_fork_ref_gc_transit` property, so the old constructor rejected it
   * saying "the fork module exports no __wpk_fork_ref_gc_transit table" -- true
   * of the argument and useless about the mistake -- and anything that got past
   * that would have failed inside `grow` with `undefined is not a function`.
   */
  constructor(
    exports: Record<string, unknown>,
    private readonly label = "fork anyref transit",
  ) {
    const table = exports.__wpk_fork_ref_gc_transit;
    if (!(table instanceof WebAssembly.Table)) {
      throw new TypeError(
        `${label}: the fork module exports no __wpk_fork_ref_gc_transit table`,
      );
    }
    const grow = exports.fm_transit_grow;
    const errno = exports.fm_last_errno;
    if (typeof grow !== "function" || typeof errno !== "function") {
      throw new TypeError(
        `${label}: the fork module exports no ` +
          `${typeof grow !== "function" ? "fm_transit_grow" : "fm_last_errno"}()`,
      );
    }
    this.table = table;
    this.growTransit = grow as (needed: number) => number;
    this.lastErrno = errno as () => number;
  }

  get length(): number {
    return this.table.length;
  }

  /**
   * Reserve the canonical `recipe + 1` slot before generated wasm publishes an
   * identity there.
   *
   * The bound check is here rather than left to `table.grow` because an overflow
   * there is an engine-dependent trap, and a recipe id is host-supplied.
   */
  ensureRecipeSlot(recipeId: number): void {
    if (!Number.isInteger(recipeId) || recipeId <= 0 || recipeId > 0x7fff_fffe) {
      throw new RangeError(`${this.label}: invalid Wasm-GC recipe id ${recipeId}`);
    }
    const needed = recipeId + 2;
    if (this.table.length >= needed) return;
    // The MODULE grows its own table: it knows the element type and it is the
    // party that must still be able to index every slot afterwards.
    const grown = this.growTransit(needed);
    const errno = this.lastErrno();
    if (grown < 0 || errno !== 0) {
      throw new Error(
        `${this.label}: fm_transit_grow(${needed}) failed with errno ${errno}`,
      );
    }
  }

  get(slot: number): unknown {
    this.assertSlot(slot);
    return this.table.get(slot);
  }

  set(slot: number, value: unknown): void {
    this.assertSlot(slot);
    this.table.set(slot, value);
  }

  clearSlot(slot: number): void {
    this.assertSlot(slot);
    this.table.set(slot, null);
  }

  /**
   * Drop every reference the table holds.
   *
   * Slot by slot, not by growing a fresh table: the module and the guest both
   * hold this exact table object, so replacing it would leave them pointing at
   * references this host had abandoned.
   */
  clear(): void {
    for (let i = 0; i < this.table.length; i += 1) this.table.set(i, null);
  }

  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.table.length) {
      throw new RangeError(
        `${this.label}: slot ${slot} is outside the transit table (length ${this.table.length})`,
      );
    }
  }
}
