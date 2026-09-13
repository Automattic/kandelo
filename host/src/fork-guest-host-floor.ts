/**
 * The host half of the identity floor, for both JS hosts.
 *
 * `crates/fork-module` states the split this implements: "The host resolves
 * every coordinate with its per-host identity floor (the funcref catalog, the
 * externref broker's `WeakMap` provenance) BEFORE calling. The module never
 * sees a live reference, only scalars."
 *
 * So everything here is a lookup that answers ONE question -- which coordinate
 * is this reference? -- and then delegates. Nothing here decides anything about
 * fork; if a member of this file starts containing policy, it belongs in the
 * module instead. See docs/plans/2026-09-12-lane-f-census.md sections 50 and 58
 * for why each of these cannot move: wasm has no way to compare two `funcref`s
 * or to look inside an `externref`.
 */

import type { ForkGuestHostFloor } from "./fork-guest-imports";

/** What the host must be able to look up, supplied per host. */
export interface ForkGuestHostFloorDeps {
  /**
   * The broker handle a host-produced externref already carries, or undefined.
   *
   * "Already carries" is the whole contract: the handle is READ BACK, never
   * minted here. A value with no self-describing handle simply has no
   * provenance to record, which is a documented boundary rather than an error.
   */
  readonly tryEncodeExternref: (value: unknown) => number | undefined;
}

export interface ForkGuestHostFloorHandle {
  readonly floor: ForkGuestHostFloor;
  /** The broker handle recorded for `value` at its production site, if any. */
  readonly provenanceOf: (value: object) => number | undefined;
}

export function createForkGuestHostFloor(
  deps: ForkGuestHostFloorDeps,
  label = "fork host floor",
): ForkGuestHostFloorHandle {
  // Keyed by the value itself, so a reference the guest drops is not kept alive
  // by having once been recorded.
  const provenance = new WeakMap<object, number>();
  const floor: ForkGuestHostFloor = {
    __wpk_fork_ref_provenance_externref(value: unknown): unknown {
      // Pass-through by contract: this runs at the value's production site, and
      // its job is to REMEMBER, not to transform.
      if (
        (typeof value !== "object" || value === null)
        && typeof value !== "function"
      ) {
        return value;
      }
      const handle = deps.tryEncodeExternref(value);
      if (handle !== undefined) provenance.set(value as object, handle);
      return value;
    },

    __wpk_fork_ref_exn_ingress_throw(recipe: number): void {
      throw new Error(
        `${label}: __wpk_fork_ref_exn_ingress_throw(${recipe}) is not `
          + `implemented. It must re-enter wasm THROWING a tagged exception, `
          + `which a JavaScript import cannot do -- a JS throw crosses back as a `
          + `foreign exception with the wrong tag. Deferred by maintainer `
          + `decision; see docs/plans/2026-09-12-lane-f-census.md.`,
      );
    },

    __wpk_fork_ref_exn_broker_throw_recipe(recipe: number): void {
      throw new Error(
        `${label}: __wpk_fork_ref_exn_broker_throw_recipe(${recipe}) is not `
          + `implemented, for the reason __wpk_fork_ref_exn_ingress_throw is not.`,
      );
    },
  };

  return { floor, provenanceOf: (value) => provenance.get(value) };
}
