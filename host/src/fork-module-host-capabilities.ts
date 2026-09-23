/**
 * The fork-module's host FUNCTION obligations, in one place, shared by both JS
 * hosts.
 *
 * The co-resident fork-module declares eight imports. Five are
 * position-independent-code linking boilerplate any `--pie` side module has
 * (`env.memory`, `__indirect_function_table`, `__stack_pointer`,
 * `__memory_base`, `__table_base`). Three are reference-typed tables, which
 * `fork-module-instance` owns because it also owns the region reservation and
 * exposes them as `functionCatalog` / `driveTable` / `staticRootCatalog`.
 *
 * The two that remain are this file, and each is a Wasm CAPABILITY FLOOR --
 * something the module cannot do for itself no matter how much logic moves
 * into Rust. The reason is recorded beside each one, because a responsibility
 * whose reason is not written down is a responsibility that grows.
 *
 * The set is pinned against the built artifact by
 * `EXPECTED_FORK_MODULE_HOST_IMPORT_COUNT` in `crates/host-native/src/lib.rs`,
 * whose test asserts these exact names alongside the three tables, and by the
 * `forkModuleHostImports` surface budget.
 */

/** The fork-module host imports that are functions. */
export interface ForkModuleHostImports {
  /**
   * `__wpk_fork_host_ref_identity(anyref) -> i32`.
   *
   * FLOOR: deciding whether two references are the SAME object. `ref.eq`
   * validates only on `eqref`, there is no `ref.hash`, and no cast rescues a
   * host reference into the eq hierarchy -- so a reference cannot key a map
   * inside the module. The host can key one, so the host issues a stable
   * integer and the module keys on that.
   */
  readonly __wpk_fork_host_ref_identity: (value: unknown) => number;
  /**
   * `__wpk_fork_host_func_identity(funcref) -> i32`: a stable integer per
   * distinct function.
   *
   * The funcref twin of the line above, and needed for the same reason: wasm
   * cannot compare two references. It is a SEPARATE pool because `funcref` and
   * `anyref` are disjoint hierarchies -- a function and a GC object can never be
   * the same value, so sharing one counter would only couple them.
   */
  readonly __wpk_fork_host_func_identity: (fn: unknown) => number;
  // No externref import. `resolve_externref` and
  // `__wpk_fork_host_externref_handle` left in externref stage E2: a fork does
  // not carry a raw host externref, so the module never names a host object or
  // rebuilds one, and the capture refuses one with EOPNOTSUPP inside the module.
}

export interface ForkModuleHostCapabilities {
  readonly imports: ForkModuleHostImports;
}

/**
 * A stable integer per distinct reference, for this worker's lifetime.
 *
 * Two maps, not one: `WeakMap` cannot key a primitive, and an `i31ref` arrives
 * at this boundary as a JavaScript number. Objects go in the `WeakMap` so a
 * captured value is not pinned alive by the identity map; primitives go in a
 * `Map` keyed by value, which is correct precisely because equal i31 payloads
 * ARE the same reference.
 */
function createReferenceIdentity(importName: string) {
  const objects = new WeakMap<object, number>();
  const primitives = new Map<unknown, number>();
  let next = 1;
  const identify = (value: unknown): number => {
    if (value === null || value === undefined) {
      // The generator publishes identity only for a value it is about to
      // claim, and it guards nulls before it gets here. A null arriving means
      // that guard did not run. Returning a sentinel would make this reference
      // indistinguishable from another in the module's map -- a fork-only
      // identity collision, and silent. Fail at the call instead.
      throw new RangeError(
        `${importName} received a null reference: the guest ` +
          "generator publishes identity only for values it claims, so this " +
          "is a missing null guard, not a capturable value",
      );
    }
    const isObject = typeof value === "object" || typeof value === "function";
    const existing = isObject
      ? objects.get(value as object)
      : primitives.get(value);
    if (existing !== undefined) return existing;
    // Identity 0 is never issued: the module reads 0 back from
    // `fm_gc_identity_find` as "no recipe bound to this identity".
    const id = next++;
    if (isObject) objects.set(value as object, id);
    else primitives.set(value, id);
    return id;
  };
  return identify;
}

export function createForkModuleHostCapabilities(): ForkModuleHostCapabilities {
  const identity = createReferenceIdentity("__wpk_fork_host_ref_identity");
  const functionIdentity = createReferenceIdentity("__wpk_fork_host_func_identity");
  const imports: ForkModuleHostImports = {
    __wpk_fork_host_ref_identity: identity,
    // A SEPARATE pool from the reference one: `funcref` and `anyref` are
    // disjoint hierarchies, so a function and a GC object can never be the same
    // value and one counter would only couple two independent numberings.
    __wpk_fork_host_func_identity: functionIdentity,
  };
  return { imports };
}
