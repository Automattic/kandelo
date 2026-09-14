import { describe, expect, it } from "vitest";

import { createForkGuestHostFloor } from "../src/fork-guest-host-floor";
import {
  buildForkGuestImports,
  FORK_GUEST_HOST_FLOOR_NAMES,
} from "../src/fork-guest-imports";
import { WPK_FORK_REQUIRED_IMPORTS } from "../src/generated/abi";

function deps(overrides: Partial<Parameters<typeof createForkGuestHostFloor>[0]> = {}) {
  return {
    tryEncodeExternref: () => undefined,
    ownsTableState: () => true,
    ...overrides,
  };
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

  it("records provenance at the production site and passes the value through", () => {
    const token = { handle: 42 };
    const { floor, provenanceOf } = createForkGuestHostFloor(
      deps({ tryEncodeExternref: (v) => (v === token ? 42 : undefined) }),
    );
    const returned = floor.__wpk_fork_ref_provenance_externref(token);
    // Pass-through matters: this runs at the value's production site, so
    // returning anything else would substitute a different reference into the
    // guest's own data flow.
    expect(returned).toBe(token);
    expect(provenanceOf(token)).toBe(42);
  });

  it("delegates both throws to the activation's exported throwers", () => {
    // The implementation route section 109 established: the import does not
    // throw from JavaScript -- which would reach the guest with the wrong tag --
    // it calls a guest EXPORT that raises a tagged exception in wasm.
    const calls: Array<[string, number]> = [];
    const thrower = {
      throwIngress: (token: number): never => {
        calls.push(["ingress", token]);
        throw new Error("wasm raised");
      },
      throwRecipe: (recipe: number): never => {
        calls.push(["recipe", recipe]);
        throw new Error("wasm raised");
      },
    };
    const { floor } = createForkGuestHostFloor(
      deps({ exceptionThrower: () => thrower }),
    );
    expect(() => floor.__wpk_fork_ref_exn_ingress_throw(11)).toThrow(/wasm raised/);
    expect(() => floor.__wpk_fork_ref_exn_broker_throw_recipe(22)).toThrow(
      /wasm raised/,
    );
    expect(calls).toEqual([
      ["ingress", 11],
      ["recipe", 22],
    ]);
  });

  it("still fails loud if a bound thrower RETURNS instead of throwing", () => {
    // A thrower that returns normally is a defect, and letting it through would
    // continue the replay past an exception that was never delivered -- the
    // exact silent corruption the unbound case guards against.
    const { floor } = createForkGuestHostFloor(
      deps({
        exceptionThrower: () => ({
          throwIngress: (() => undefined) as unknown as (t: number) => never,
          throwRecipe: (() => undefined) as unknown as (r: number) => never,
        }),
      }),
    );
    expect(() => floor.__wpk_fork_ref_exn_ingress_throw(1)).toThrow(
      /did not throw/,
    );
    expect(() => floor.__wpk_fork_ref_exn_broker_throw_recipe(1)).toThrow(
      /did not throw/,
    );
  });

  it("gives NO provenance to a handle-carrying value that never crossed the production site", () => {
    // The distinction the whole map exists for, and the one thing that makes it
    // more than a cache of `tryEncodeExternref`.
    //
    // Both values below carry a broker handle, so `tryEncodeExternref` answers
    // for both. Only `produced` passed through the host-import body. A capture
    // that treated `internalized` as host-produced would be the unsoundness the
    // attic's `ForkExternrefProvenanceTable` names: a reverse lookup at capture
    // time "cannot distinguish a genuine host-import production from a
    // GC-internalized value that merely reached the same code path".
    const produced = { tag: "produced" };
    const internalized = { tag: "internalized" };
    const { floor, provenanceOf } = createForkGuestHostFloor(
      deps({
        tryEncodeExternref: (v) =>
          v === produced ? 7 : v === internalized ? 9 : undefined,
      }),
    );
    floor.__wpk_fork_ref_provenance_externref(produced);
    expect(provenanceOf(produced)).toBe(7);
    // Never passed through the import body -- so no provenance, even though its
    // handle is readable. Answering 9 here would pass a lookup-only
    // implementation and lose the distinction entirely.
    expect(provenanceOf(internalized)).toBeUndefined();
  });

  it("records nothing for a value with no self-describing handle", () => {
    const plain = {};
    const { floor, provenanceOf } = createForkGuestHostFloor(deps());
    expect(floor.__wpk_fork_ref_provenance_externref(plain)).toBe(plain);
    expect(provenanceOf(plain)).toBeUndefined();
    // Primitives are not recordable and must not throw on the way through.
    expect(floor.__wpk_fork_ref_provenance_externref(5)).toBe(5);
    expect(floor.__wpk_fork_ref_provenance_externref(null)).toBe(null);
  });

  // The two `encode_funcref` tests that stood here are gone with the member:
  // the module serves `__wpk_fork_ref_encode_funcref` now, given the one host
  // capability it needed. Its coverage moved to the V8 capture harness, where
  // the scan runs against a real catalog.

  it("fails loud on the two throws rather than silently doing nothing", () => {
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
    expect(() => floor.__wpk_fork_ref_exn_ingress_throw(1)).toThrow(/did not throw/);
    expect(() => floor.__wpk_fork_ref_exn_broker_throw_recipe(1)).toThrow(
      /did not throw/,
    );
    // And the message must not tell a reader it is impossible, which is what
    // sent this lane's census down the wrong path once already.
    let message = "";
    try {
      floor.__wpk_fork_ref_exn_ingress_throw(1);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/cannot|impossible/i);
    expect(message).toContain("Deferred by maintainer decision");
  });
});
