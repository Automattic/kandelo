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
    locateFunction: () => undefined,
    ownsTableState: () => true,
    commitTableMutation: () => undefined,
    moduleExports: { fm_capture_intern: () => 7 },
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

  it("records nothing for a value with no self-describing handle", () => {
    const plain = {};
    const { floor, provenanceOf } = createForkGuestHostFloor(deps());
    expect(floor.__wpk_fork_ref_provenance_externref(plain)).toBe(plain);
    expect(provenanceOf(plain)).toBeUndefined();
    // Primitives are not recordable and must not throw on the way through.
    expect(floor.__wpk_fork_ref_provenance_externref(5)).toBe(5);
    expect(floor.__wpk_fork_ref_provenance_externref(null)).toBe(null);
  });

  it("interns a located function through the MODULE, not itself", () => {
    const seen: unknown[] = [];
    const fn = () => undefined;
    const { floor } = createForkGuestHostFloor(
      deps({
        locateFunction: (f) => (f === fn ? { activationId: 3, ordinal: 9 } : undefined),
        moduleExports: {
          fm_capture_intern: (...args: unknown[]) => {
            seen.push(args);
            return 11;
          },
        },
      }),
    );
    expect(floor.__wpk_fork_ref_encode_funcref(fn)).toBe(11);
    // The host resolved the coordinate; the recipe is the module's. If this
    // file ever computed the recipe itself, two encoders would exist.
    expect(seen).toEqual([[1, 3, 9]]);
  });

  it("refuses a function the loader never catalogued", () => {
    const { floor } = createForkGuestHostFloor(deps());
    // Inventing a coordinate would put a recipe in the graph that decodes to
    // the WRONG function in the child -- worse than a refusal.
    expect(floor.__wpk_fork_ref_encode_funcref(() => undefined)).toBe(-1);
    expect(floor.__wpk_fork_ref_encode_funcref(null)).toBe(0);
  });

  it("fails loud on the two throws rather than silently doing nothing", () => {
    const { floor } = createForkGuestHostFloor(deps());
    // These must re-enter wasm THROWING a tagged exception, which JavaScript
    // cannot do. Returning quietly would let a fork replay continue past an
    // exception it never delivered.
    expect(() => floor.__wpk_fork_ref_exn_ingress_throw(1)).toThrow(/not implemented/);
    expect(() => floor.__wpk_fork_ref_exn_broker_throw_recipe(1)).toThrow(
      /not implemented/,
    );
  });
});
