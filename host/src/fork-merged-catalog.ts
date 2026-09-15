/**
 * The merged funcref catalog the co-resident fork-module imports.
 *
 * The module is instantiated BEFORE its guests -- it supplies their frame-flip
 * imports -- so it cannot import a guest's `__wpk_fork_function_catalog`
 * directly. The host lays every activation's catalog into the ONE table the
 * module imported at init: activation `a`'s catalog occupies the slots
 * `[base(a), base(a) + len_a)`, and the module is told each `base`.
 *
 * Both directions read it. `fm_funcref_ordinal` turns a recipe into
 * `base(activation) + ordinal` for the injected decode shim to `table.get`; the
 * injected `__wpk_fork_ref_encode_funcref` SCAN walks the same table to turn a
 * live funcref back into a recipe. That second direction is why this is filled
 * on EVERY worker rather than only where a child is installed: while encode was
 * a host function reading the host's own per-activation catalogs, a parent
 * needed no merged table, and nothing filled one. Serving encode from the module
 * made it load-bearing for the parent too -- with an empty table the scan
 * answered `fm_funcref_uncatalogued` for every funcref, and the parent sealed a
 * table page whose every recipe was -1.
 *
 * Copying preserves funcref identity (`table.get` returns the same function
 * object), which is exactly what the scan's host identity oracle compares.
 */
export class ForkMergedFunctionCatalog {
  /** The next free slot: the running sum of every catalog taken so far. */
  private next = 0;

  constructor(
    private readonly mirror: WebAssembly.Table,
    private readonly module: {
      setActivationCatalogBase(activationId: number, base: number): void;
    },
    private readonly label: string,
  ) {}

  /**
   * Take one activation's catalog into the merged table and publish its base.
   *
   * Called as the activation registers, so the order is the ascending
   * activation order every reader assumes and activation 0 gets base 0.
   */
  take(activationId: number, catalog: WebAssembly.Table): void {
    const base = this.next;
    const needed = base + catalog.length;
    if (!Number.isSafeInteger(needed)) {
      throw new Error(`${this.label}: merged catalog length ${needed} is not an index`);
    }
    if (this.mirror.length < needed) this.mirror.grow(needed - this.mirror.length);
    for (let slot = 0; slot < catalog.length; slot += 1) {
      this.mirror.set(base + slot, catalog.get(slot));
    }
    this.module.setActivationCatalogBase(activationId, base);
    this.next = needed;
  }
}
