import { describe, expect, it } from "vitest";

import { createForkGuestHostFloor } from "../src/fork-guest-host-floor";
import {
  buildForkGuestImports,
  FORK_GUEST_HOST_FLOOR_NAMES,
} from "../src/fork-guest-imports";
import { WPK_FORK_REQUIRED_IMPORTS } from "../src/generated/abi";

function deps(overrides: Partial<Parameters<typeof createForkGuestHostFloor>[0]> = {}) {
  return { ...overrides };
}

describe("fork host identity floor", () => {
  it("implements exactly the floor the binder expects", () => {
    // The binder refuses a floor member it cannot find, so building a real
    // import object is the strongest statement that this file is complete.
    const { floor } = createForkGuestHostFloor(deps());
    for (const name of FORK_GUEST_HOST_FLOOR_NAMES) {
      expect(typeof (floor as Record<string, unknown>)[name], name).toBe("function");
    }
    const moduleExports: Record<string, unknown> = {};
    const floorNames = new Set<string>(FORK_GUEST_HOST_FLOOR_NAMES);
    for (const required of WPK_FORK_REQUIRED_IMPORTS) {
      if (required.module !== "env" || floorNames.has(required.name)) continue;
      moduleExports[required.name] = () => undefined;
    }
    expect(() =>
      buildForkGuestImports({
        moduleExports,
        floor,
        extras: {
          __wpk_fork_ref_gc_transit: new WebAssembly.Table({
            element: "anyref" as "anyfunc",
            initial: 1,
          }),
          __wpk_fork_resume_table: new WebAssembly.Table({
            element: "anyfunc",
            initial: 1,
          }),
        },
      }),
    ).not.toThrow();
  });

  it("delegates the throw to the activation's exported thrower", () => {
    // The implementation route section 109 established: the import does not
    // throw from JavaScript -- which would reach the guest with the wrong tag --
    // it calls a guest EXPORT that raises a tagged exception in wasm.
    const calls: Array<[string, number]> = [];
    const thrower = {
      throwRecipe: (recipe: number): never => {
        calls.push(["recipe", recipe]);
        throw new Error("wasm raised");
      },
    };
    const { floor } = createForkGuestHostFloor(
      deps({ exceptionThrower: () => thrower }),
    );
    expect(() => floor.__wpk_fork_ref_exn_broker_throw_recipe(22)).toThrow(
      /wasm raised/,
    );
    expect(calls).toEqual([["recipe", 22]]);
  });

  it("still fails loud if a bound thrower RETURNS instead of throwing", () => {
    // A thrower that returns normally is a defect, and letting it through would
    // continue the replay past an exception that was never delivered -- the
    // exact silent corruption the unbound case guards against.
    const { floor } = createForkGuestHostFloor(
      deps({
        exceptionThrower: () => ({
          throwRecipe: (() => undefined) as unknown as (r: number) => never,
        }),
      }),
    );
    expect(() => floor.__wpk_fork_ref_exn_broker_throw_recipe(1)).toThrow(
      /did not throw/,
    );
  });

  // The three provenance tests that stood here are gone with the member. The
  // import survives; the HOST implementation of it does not. It recorded a
  // `WeakMap` of value -> handle at the production site that nothing ever read,
  // so once the capture started asking the host for a handle directly it was a
  // pure identity function -- and an identity function over an `externref` is
  // something injected wasm can be, which is where it lives now.
  //
  // The two `encode_funcref` tests that stood here are gone with the member:
  // the module serves `__wpk_fork_ref_encode_funcref` now, given the one host
  // capability it needed. Its coverage moved to the V8 capture harness, where
  // the scan runs against a real catalog.

  it("fails loud on the throw rather than silently doing nothing", () => {
    const { floor } = createForkGuestHostFloor(deps());
    // Returning quietly would let a fork replay continue past an exception it
    // never delivered, which is the failure this guards.
    //
    // The message says "not bound", not "not implemented", and the difference
    // is the point. These ARE implementable: the import re-enters wasm by
    // calling a guest EXPORT that throws (`fork-exception-provider` does
    // exactly that), so wasm raises its own tagged exception and a JS `throw`
    // -- which would arrive with the wrong tag -- never happens. They are
    // unbound because the maintainer deferred them, not because a host cannot
    // do it. Census section 109.
    expect(() => floor.__wpk_fork_ref_exn_broker_throw_recipe(1)).toThrow(
      /did not throw/,
    );
    // And the message must not tell a reader it is impossible, which is what
    // sent this lane's census down the wrong path once already.
    let message = "";
    try {
      floor.__wpk_fork_ref_exn_broker_throw_recipe(1);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/cannot|impossible/i);
    expect(message).toContain("Deferred by maintainer decision");
  });
});
