/**
 * The host half of the identity floor, for both JS hosts.
 *
 * What is left here is not a lookup at all any more. The lookups moved: the
 * module asks the host for a coordinate when it needs one, through the
 * `__wpk_fork_host_*` capabilities, rather than having the host answer a guest
 * import on its behalf. These two remain because they must re-enter wasm
 * RAISING a tagged exception, and they do it by calling a guest export -- the
 * maintainer deferred moving that call into the module, which census section
 * 174 shows is possible. Nothing here decides anything about fork; if a member
 * of this file starts containing policy, it belongs in the module instead.
 */

import type { ForkGuestHostFloor } from "./fork-guest-imports";

/** What the host must be able to look up, supplied per host. */
export interface ForkGuestHostFloorDeps {
  /**
   * The activation's exported throwers, resolved lazily.
   *
   * OPTIONAL, and its absence is the interesting case. Both `exn_*` members
   * below must re-enter wasm raising a TAGGED exception, which they do by
   * calling a guest EXPORT that throws -- never by throwing from JavaScript,
   * which would arrive with the wrong tag (census section 109). When this is
   * supplied they delegate; when it is not they refuse loudly, because a fork
   * replay that continues past an exception it never delivered is silent
   * corruption.
   *
   * Lazy because the exports do not exist when the import object is built: the
   * instance that owns them is created FROM that object. The caller resolves it
   * after registration; `host/src/fork-exception-broker.ts` is what it resolves
   * to in production.
   */
  readonly exceptionThrower?: () => ForkGuestExceptionThrower;
}

/** The two guest exports that raise a tagged exception back into wasm. */
export interface ForkGuestExceptionThrower {
  /** Throw the exception an ingress token names. Never returns normally. */
  readonly throwIngress: (token: number) => never;
  /** Throw the exception a recipe id names. Never returns normally. */
  readonly throwRecipe: (recipe: number) => never;
}

export interface ForkGuestHostFloorHandle {
  readonly floor: ForkGuestHostFloor;
}

export function createForkGuestHostFloor(
  deps: ForkGuestHostFloorDeps,
  label = "fork host floor",
): ForkGuestHostFloorHandle {
  const floor: ForkGuestHostFloor = {
    // DELEGATED, not implemented here, and the delegate is the point.
    //
    // This file used to claim these two "must re-enter wasm THROWING a tagged
    // exception, which a JavaScript import cannot do". The first half is true
    // and the conclusion was wrong. A JS `throw` does cross back as a foreign
    // exception with the wrong tag -- but the host import does not have to
    // throw. It can CALL A GUEST EXPORT that throws, and wasm raising its own
    // tagged exception is exactly right.
    //
    // `host/src/fork-exception-broker.ts` does that now: it reads which
    // activation owns the recipe out of the module's decoded graph and calls
    // that activation's `__wpk_fork_ref_exn_throw_recipe`. The refusals below
    // are reached only with no thrower bound. The same route is open to the
    // MODULE, which would delete both members; census 174 states its shape.
    __wpk_fork_ref_exn_ingress_throw(token: number): void {
      deps.exceptionThrower?.().throwIngress(token);
      // Only reachable with no thrower bound, or if one returned without
      // throwing -- which is itself a defect worth naming rather than letting
      // the replay continue past an exception it never delivered.
      throw new Error(
        `${label}: __wpk_fork_ref_exn_ingress_throw(${token}) did not throw. `
          + `Bind an exceptionThrower so this can call the activation's `
          + `exported thrower; a JavaScript throw here would reach the guest `
          + `with the wrong tag. Deferred by maintainer decision, not by a `
          + `capability limit -- see census section 109.`,
      );
    },

    __wpk_fork_ref_exn_broker_throw_recipe(recipe: number): void {
      deps.exceptionThrower?.().throwRecipe(recipe);
      throw new Error(
        `${label}: __wpk_fork_ref_exn_broker_throw_recipe(${recipe}) did not `
          + `throw, for the reason __wpk_fork_ref_exn_ingress_throw did not.`,
      );
    },
  };

  return { floor };
}
