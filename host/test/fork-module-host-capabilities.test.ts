// M2 t4 — the shrunk externref host seam is a SINGLE reference-returning
// import: `resolve_externref(handle) -> externref`. This is a narrow unit
// test of `createForkModuleHostCapabilities` in isolation (no wasm instance);
// the real-module instantiation path is covered by
// `fork-module-instance.test.ts` and the full reference-replay wiring is
// covered by the M2 t6 harness rewire.

import { describe, expect, it } from "vitest";

import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";

describe("createForkModuleHostCapabilities (M2)", () => {
  it("returns exactly the four imports a host must implement", () => {
    // Pinned as a SET, and deliberately exact: this is the host obligation the
    // campaign exists to keep small, so a fifth appearing silently is the thing
    // to catch. Each was approved on its own evidence -- the two identity
    // imports answer "are these the same reference?" for the `any` and `func`
    // hierarchies, which wasm cannot do because `ref.eq` validates only on
    // `eqref`, and the two externref imports are one capability in both
    // directions: `resolve_externref` turns a broker handle back into the live
    // value for a child, and `__wpk_fork_host_externref_handle` says which
    // handle names a live value so a parent's capture can record it.
    //
    // The fourth was THREE until 2026-09-15, and its absence was not a smaller
    // obligation -- it was a fork that could not carry a host externref at all
    // (census section 188).
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(Object.keys(caps.imports).sort()).toEqual([
      "__wpk_fork_host_externref_handle",
      "__wpk_fork_host_func_identity",
      "__wpk_fork_host_ref_identity",
      "resolve_externref",
    ]);
    expect(typeof caps.imports.resolve_externref).toBe("function");
  });

  it("answers a handle for a token it issued, and 0 for anything else", () => {
    // The capture asks this about every value that matched no GC layout, so
    // "not a reference the host owns" is an ordinary answer and has to be a
    // number, not a throw: 0 is not a valid broker handle.
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });
    const handle = caps.imports.__wpk_fork_host_externref_handle;

    expect(handle(tokens.materialize(7)), "a token this cache issued").toBe(7);
    expect(handle({}), "a plain object the broker never saw").toBe(0);
    expect(handle(null), "and null, which a cleared transit slot can hold").toBe(0);
  });

  it("gives functions and references SEPARATE identity numbering", () => {
    // `funcref` and `anyref` are disjoint hierarchies, so a function and a GC
    // object can never be the same value. Sharing one counter would couple two
    // independent numberings and make a collision between them expressible.
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });
    const fn = () => undefined;
    const obj = {};
    expect(caps.imports.__wpk_fork_host_func_identity(fn)).toBe(
      caps.imports.__wpk_fork_host_ref_identity(obj),
    );
    // Same number from two independent pools -- which is exactly why they must
    // never be compared across hierarchies.
    expect(caps.imports.__wpk_fork_host_func_identity(fn)).toBe(
      caps.imports.__wpk_fork_host_func_identity(fn),
    );
  });

  it("resolve_externref returns the SAME canonical token materialize() returns for that handle", () => {
    const tokens = new ForkExternrefTokenCache(7);
    const caps = createForkModuleHostCapabilities({ tokens });

    const expected = tokens.materialize(42);
    const resolved = caps.imports.resolve_externref(42);

    expect(resolved).toBe(expected); // identity, not just equality
  });

  it("is idempotent: repeated resolves of the same handle return the identical object", () => {
    const tokens = new ForkExternrefTokenCache(3);
    const caps = createForkModuleHostCapabilities({ tokens });

    const first = caps.imports.resolve_externref(11);
    const second = caps.imports.resolve_externref(11);

    expect(second).toBe(first);
  });

  it("distinct handles resolve to distinct tokens", () => {
    const tokens = new ForkExternrefTokenCache(3);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(caps.imports.resolve_externref(1)).not.toBe(
      caps.imports.resolve_externref(2),
    );
  });

  it("advances resolvedCount once per resolve (proof-of-use)", () => {
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(caps.resolvedCount).toBe(0);
    caps.imports.resolve_externref(5);
    caps.imports.resolve_externref(6);
    expect(caps.resolvedCount).toBe(2);
  });

  it("propagates a truthful RangeError for an invalid handle instead of a soft failure sentinel", () => {
    const tokens = new ForkExternrefTokenCache(1);
    const caps = createForkModuleHostCapabilities({ tokens });

    expect(() => caps.imports.resolve_externref(0)).toThrow(RangeError);
  });
});
