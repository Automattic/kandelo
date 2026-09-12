/**
 * The fork-module's host FUNCTION obligations, in one place, shared by both JS
 * hosts.
 *
 * The co-resident fork-module declares ten imports. Five are
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

/**
 * Handle -> live host reference. The host owns this registry because the handle
 * space is the host's: the module stores handles in its recipe graph and asks
 * for the value back during replay.
 *
 * Structural on purpose, so the host's real token cache satisfies it without an
 * adapter. `materialize` MUST be idempotent per handle -- the same handle has
 * to give back the identical object, or a child rebuilds two references where
 * the parent had one -- and MUST THROW for a handle it cannot honour rather
 * than return a sentinel.
 */
export interface ForkExternrefResolver {
  materialize(handle: number): object;
}

export interface ForkModuleHostCapabilitiesOptions {
  readonly tokens: ForkExternrefResolver;
}

/** The fork-module host imports that are functions. */
export interface ForkModuleHostImports {
  /**
   * `resolve_externref(handle) -> externref`.
   *
   * FLOOR: Wasm cannot manufacture an `externref`. Only the host can turn a
   * handle back into the live value it named.
   *
   * Errors PROPAGATE. An invalid handle is a `RangeError` out of the registry,
   * not a null sentinel: a sentinel would let a replay continue with a
   * reference it never actually restored.
   */
  readonly resolve_externref: (handle: number) => object;
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
}

export interface ForkModuleHostCapabilities {
  readonly imports: ForkModuleHostImports;
  /** Proof-of-use: how many times `resolve_externref` actually ran. */
  readonly resolvedCount: number;
  /**
   * How many distinct references identity has issued. Diagnostics: a capture
   * that splits one object into two recipes shows up here as a count larger
   * than the object graph.
   */
  readonly distinctReferenceCount: number;
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
function createReferenceIdentity() {
  const objects = new WeakMap<object, number>();
  const primitives = new Map<unknown, number>();
  let next = 1;
  let issued = 0;
  const identify = (value: unknown): number => {
    if (value === null || value === undefined) {
      // The generator publishes identity only for a value it is about to
      // claim, and it guards nulls before it gets here. A null arriving means
      // that guard did not run. Returning a sentinel would make this reference
      // indistinguishable from another in the module's map -- a fork-only
      // identity collision, and silent. Fail at the call instead.
      throw new RangeError(
        "__wpk_fork_host_ref_identity received a null reference: the guest " +
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
    issued += 1;
    return id;
  };
  return { identify, issued: () => issued };
}

export function createForkModuleHostCapabilities(
  options: ForkModuleHostCapabilitiesOptions,
): ForkModuleHostCapabilities {
  const identity = createReferenceIdentity();
  const { tokens } = options;
  let resolved = 0;
  const imports: ForkModuleHostImports = {
    resolve_externref: (handle: number) => {
      const value = tokens.materialize(handle);
      resolved += 1;
      return value;
    },
    __wpk_fork_host_ref_identity: identity.identify,
  };
  return {
    imports,
    get resolvedCount() {
      return resolved;
    },
    get distinctReferenceCount() {
      return identity.issued();
    },
  };
}
