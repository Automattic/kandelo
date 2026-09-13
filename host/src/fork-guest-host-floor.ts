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
  // WHY THE RECORDING IS NOT REDUNDANT WITH THIS LOOKUP, which is the obvious
  // simplification and an unsound one.
  //
  // `tryEncodeExternref(v)` answers "does this value carry a handle?", and it
  // answers the same whenever it is asked. The provenance map answers a
  // different question: "was this value PRODUCED by a host import during this
  // capture?" -- and that is true only for values that passed through the
  // production site below, at the moment they crossed it.
  //
  // Collapsing the two would make a reverse lookup at CAPTURE time, and the
  // attic's `ForkExternrefProvenanceTable` states what that costs: such a
  // lookup "cannot distinguish a genuine host-import production from a
  // GC-internalized value that merely reached the same code path". Native's
  // `ExternrefProvenanceRegistry` records at production for the same reason.
  // See docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md §1
  // and census section 108.
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

    // NOT IMPLEMENTED HERE, and the reason is narrower than it once said.
    //
    // This file used to claim these two "must re-enter wasm THROWING a tagged
    // exception, which a JavaScript import cannot do". The first half is true
    // and the conclusion was wrong. A JS `throw` does cross back as a foreign
    // exception with the wrong tag -- but the host import does not have to
    // throw. `fork-exception-provider` in the attic implements both by CALLING
    // A GUEST EXPORT that throws (`FORK_EXCEPTION_THROW_RECIPE_EXPORT`), and
    // wasm raising its own tagged exception is exactly right.
    //
    // So these are implementable, and by the same route the module could serve
    // them: it already calls guest exports through `__wpk_fork_drive_table`.
    // They stay unimplemented because the MAINTAINER deferred them to last, not
    // because they cannot be done. See census section 109.
    __wpk_fork_ref_exn_ingress_throw(recipe: number): void {
      throw new Error(
        `${label}: __wpk_fork_ref_exn_ingress_throw(${recipe}) is not bound. `
          + `It is implementable -- call the activation's exported thrower, as `
          + `fork-exception-provider does -- and is deferred by maintainer `
          + `decision, not by a capability limit. A host reaching this has `
          + `replaced a working exception path with this floor.`,
      );
    },

    __wpk_fork_ref_exn_broker_throw_recipe(recipe: number): void {
      throw new Error(
        `${label}: __wpk_fork_ref_exn_broker_throw_recipe(${recipe}) is not `
          + `bound, for the reason __wpk_fork_ref_exn_ingress_throw is not.`,
      );
    },
  };

  return { floor, provenanceOf: (value) => provenance.get(value) };
}
