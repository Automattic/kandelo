import type { RegisteredForkActivation } from "./fork-activations";
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
   * The module places each catalog (`fm_bind_activation`'s `static_root_base`)
   * and `ForkActivations` keeps the base with the live activation, so nothing
   * here remembers one and a released activation leaves nothing behind: the
   * module clears its range and drops its record.
   */
  constructor(private readonly mirror: WebAssembly.Table) {}

  /** Give one activation its slice at registration. No reference is copied. */
  take(base: number, catalog: WebAssembly.Table): void {
    const needed = base + catalog.length;
    if (this.mirror.length < needed) {
      this.mirror.grow(needed - this.mirror.length, null);
    }
  }

  /** Copy every live activation's roots in, for one fork. */
  fill(activations: readonly RegisteredForkActivation[]): void {
    for (const { instance, staticRootBase } of activations) {
      const catalog = instance.exports[WPK_FORK_STATIC_ROOT_CATALOG_EXPORT] as WebAssembly.Table;
      for (let slot = 0; slot < catalog.length; slot += 1) {
        this.mirror.set(staticRootBase + slot, catalog.get(slot));
      }
    }
  }
}
