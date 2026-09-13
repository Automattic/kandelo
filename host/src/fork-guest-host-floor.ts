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

/** A reference kind the module's capture builder interns. */
const CAPTURE_KIND_FUNCREF = 1;

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
  /** The catalog coordinate the loader assigned this function, if any. */
  readonly locateFunction: (
    fn: unknown,
  ) => { readonly activationId: number; readonly ordinal: number } | undefined;
  /** Whether this coordinate owns the physical table's sparse state. */
  readonly ownsTableState: (owner: number) => boolean;
  /** Publish a guest table mutation and release the archive writer. */
  readonly commitTableMutation: (
    owner: number,
    firstIndex: bigint,
    length: bigint,
  ) => void;
  /** The fork module, for turning a resolved coordinate into a recipe. */
  readonly moduleExports: Record<string, unknown>;
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
  const intern = deps.moduleExports.fm_capture_intern as
    | ((kind: number, a: number, b: number) => number)
    | undefined;

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

    __wpk_fork_ref_encode_funcref(fn: unknown): number {
      if (fn === null || fn === undefined) return 0;
      const located = deps.locateFunction(fn);
      if (located === undefined || intern === undefined) {
        // A function the loader never catalogued has no coordinate to name, and
        // inventing one would put a recipe in the graph that decodes to the
        // wrong function in the child.
        return -1;
      }
      // The host resolved the coordinate; the module owns the recipe.
      return intern(CAPTURE_KIND_FUNCREF, located.activationId, located.ordinal);
    },

    __wpk_fork_module_state_table_state_owned(owner: number): number {
      return deps.ownsTableState(owner) ? 1 : 0;
    },

    __wpk_fork_module_state_table_mutation_commit(
      owner: number,
      firstIndex: bigint,
      length: bigint,
    ): void {
      deps.commitTableMutation(owner, firstIndex, length);
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
