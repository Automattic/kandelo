import type { ForkActivation } from "./fork-activations";
import { WPK_FORK_STATIC_ROOT_CATALOG_EXPORT } from "./generated/abi";

/**
 * The merged STATIC-ROOT catalog the co-resident fork-module imports.
 *
 * Merged for the reason the function catalog is (`forkActivationCatalogSink`):
 * the module is instantiated before its guests, so it cannot import a guest's
 * `__wpk_fork_static_root_catalog` directly. Activation `a`'s roots occupy
 * `[base(a), base(a) + len_a)` in the one table the module imported, at the
 * base the module places them.
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
 * VALUES ARE MEANT TO BE HELD ONLY FOR THE DURATION OF A FORK. The layout is
 * settled at registration, where it costs nothing; the references themselves
 * are copied in when a fork opens. The child install nulls the table after its
 * drive; the parent does not clear it yet (the fork test-only removal plan's T4
 * bug 3), so until it does a parent's last fork pins these roots.
 */
export class ForkMergedStaticRoots {
  /**
   * `place` is the module's `fm_place_activation_static_roots`, which both
   * places a catalog and, asked again with the same length, answers where it
   * placed it. So nothing here remembers a base, and a released activation
   * leaves nothing behind: the module clears its range and drops its record.
   */
  constructor(
    private readonly mirror: WebAssembly.Table,
    private readonly place: (activationId: number, length: number) => number,
  ) {}

  /** Give one activation its slice at registration. No reference is copied. */
  take(activationId: number, catalog: WebAssembly.Table): void {
    const needed = this.place(activationId, catalog.length) + catalog.length;
    if (this.mirror.length < needed) {
      this.mirror.grow(needed - this.mirror.length, null);
    }
  }

  /** Copy every live activation's roots in, for one fork. */
  fill(activations: readonly ForkActivation[]): void {
    for (const { activationId, instance } of activations) {
      const catalog = instance.exports[WPK_FORK_STATIC_ROOT_CATALOG_EXPORT] as WebAssembly.Table;
      const base = this.place(activationId, catalog.length);
      for (let slot = 0; slot < catalog.length; slot += 1) {
        this.mirror.set(base + slot, catalog.get(slot));
      }
    }
  }
}
