/**
 * The merged STATIC-ROOT catalog the co-resident fork-module imports.
 *
 * The twin of `ForkMergedFunctionCatalog`, and merged for the same reason: the
 * module is instantiated before its guests, so it cannot import a guest's
 * `__wpk_fork_static_root_catalog` directly. Activation `a`'s roots occupy
 * `[base(a), base(a) + len_a)` in the one table the module imported, and the
 * module is told each base.
 *
 * Both directions read it, which is what makes it the PARENT's business too:
 * the child's replay turns a static-root recipe into `base + ordinal` and
 * `table.get`s it, and the parent's CAPTURE walks the same table to turn a live
 * reference back into that coordinate. Without the parent half a statically
 * initialised reference is captured as an ordinary struct, and the child then
 * rebuilds a second object where the module's own instantiation already made
 * one -- the fork-only identity split `fork-instrument`'s catalog exists to
 * prevent (census section 189).
 *
 * VALUES ARE HELD ONLY FOR THE DURATION OF A FORK. The base map is settled at
 * registration, where it costs nothing; the references themselves are copied in
 * when a fork opens and cleared when it finishes, so this table never becomes
 * the thing that keeps a collectable root alive. That is the same reason
 * `fork-instrument` made the guest's own catalog a harvest buffer rather than
 * module-instance storage.
 */
export class ForkMergedStaticRoots {
  /** The next free slot: the running sum of every catalog registered so far. */
  private next = 0;
  private readonly registered = new Map<number, { base: number; catalog: WebAssembly.Table }>();

  constructor(
    private readonly mirror: WebAssembly.Table,
    private readonly publishBase: (activationId: number, base: number) => void,
    private readonly label: string,
  ) {}

  /**
   * Give one activation its slice, in the ascending activation order every
   * reader assumes. No reference is copied here.
   */
  take(activationId: number, catalog: WebAssembly.Table): void {
    if (this.registered.has(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} registered twice`);
    }
    const base = this.next;
    const needed = base + catalog.length;
    if (!Number.isSafeInteger(needed)) {
      throw new Error(`${this.label}: merged length ${needed} is not an index`);
    }
    if (this.mirror.length < needed) {
      this.mirror.grow(needed - this.mirror.length, null);
    }
    this.registered.set(activationId, { base, catalog });
    this.publishBase(activationId, base);
    this.next = needed;
  }

  /** Copy every registered activation's live roots in, for one fork. */
  fill(): void {
    for (const { base, catalog } of this.registered.values()) {
      for (let slot = 0; slot < catalog.length; slot += 1) {
        this.mirror.set(base + slot, catalog.get(slot));
      }
    }
  }

  /** Drop every reference again, so a finished fork pins nothing. */
  clear(): void {
    for (let slot = 0; slot < this.next; slot += 1) this.mirror.set(slot, null);
  }
}
