/**
 * Bind an instrumented guest's fork imports, the same way on every JS host.
 *
 * # Why this is driven off the generated table
 *
 * `WPK_FORK_REQUIRED_IMPORTS` is the authoritative list of what a
 * fork-instrumented guest needs. Binding by iterating it means this layer is
 * complete BY CONSTRUCTION: a new import added to the contract shows up here as
 * a loud failure naming it, not as a guest that instantiates and then traps
 * somewhere unrelated. Hand-written import objects are how gaps appear, because
 * a name nobody wrote is a name nobody notices.
 *
 * # What the host actually supplies
 *
 * Almost everything comes from the co-resident fork module's exports. What is
 * left is the FLOOR: the handful of imports that cannot be served from inside
 * wasm because they need to look inside a reference or compare two of them.
 * See `docs/plans/2026-09-12-lane-f-census.md` section 50. As the module takes
 * more of them over, entries leave `ForkGuestHostFloor` and nothing else here
 * changes.
 */

import {
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_REQUIRED_TABLE_IMPORTS,
} from "./generated/abi";

/**
 * The imports a JS host must implement itself, because wasm cannot.
 *
 * `provenance_externref` reads a handle off a token and keys a map by object
 * identity. `table_state_owned` reports an election decided by
 * `WebAssembly.Table` object identity -- which coordinates name one PHYSICAL
 * table is observable only by whoever holds those objects.
 *
 * `encode_funcref` and `table_mutation_commit` used to be here and are not any
 * more: the module serves both, given the one host capability they needed
 * (`__wpk_fork_host_func_identity`).
 *
 * The two `exn_*` throws are here for a different reason, and it is not an
 * identity one: they must re-enter wasm THROWING a tagged exception. A
 * JavaScript import cannot -- a JS `throw` crosses back as a foreign exception
 * carrying the wrong tag, so an instrumented catch clause does not recognise it.
 */
export interface ForkGuestHostFloor {
  readonly __wpk_fork_ref_provenance_externref: (value: unknown) => unknown;
  readonly __wpk_fork_module_state_table_state_owned: (owner: number) => number;
  readonly __wpk_fork_ref_exn_ingress_throw: (recipe: number) => void;
  readonly __wpk_fork_ref_exn_broker_throw_recipe: (recipe: number) => void;
}

/** The floor's member names, for callers that need to reason about the set. */
export const FORK_GUEST_HOST_FLOOR_NAMES = [
  "__wpk_fork_module_state_table_state_owned",
  "__wpk_fork_ref_exn_broker_throw_recipe",
  "__wpk_fork_ref_exn_ingress_throw",
  "__wpk_fork_ref_provenance_externref",
] as const;

export interface ForkGuestImportOptions {
  /** The co-resident fork module's exports, after injection. */
  readonly moduleExports: Record<string, unknown>;
  /** The host's implementations of what the module cannot serve. */
  readonly floor: ForkGuestHostFloor;
  /**
   * Non-function imports (tables, globals, the unwind tag).
   *
   * Their sources differ per host, so this layer does not resolve them -- but
   * it does CHECK the ones the contract names, because a missing table is
   * otherwise a `LinkError` that says a type is wrong rather than which import
   * nobody supplied.
   */
  readonly extras?: Record<string, unknown>;
  /**
   * The instrumented guest artifact, checked for completeness when supplied.
   *
   * The generated table says what to BIND; this says what the artifact actually
   * needs, and the two are not the same question. `WPK_FORK_REQUIRED_IMPORTS`
   * lists functions and `WPK_FORK_REQUIRED_TABLE_IMPORTS` lists tables -- so an
   * imported GLOBAL was covered by neither, and `fork-instrument` emits one
   * (`__wpk_fork_module_state_table_generation_addr`, the shared generation
   * fence address). Nothing checked it. A guest missing it fails inside
   * `WebAssembly.instantiate` with a type complaint that names no import.
   *
   * Asking the artifact closes that gap and every future one of its shape: an
   * import kind nobody thought to add a list for is still an import this sees.
   */
  readonly guestModule?: WebAssembly.Module;
  readonly label?: string;
}

/**
 * Build the `env` object an instrumented guest is instantiated with.
 *
 * Fails loud, once, listing EVERY unbound name rather than the first: a caller
 * fixing them one instantiation at a time learns the shape of the gap far more
 * slowly than one that sees it whole.
 */
export function buildForkGuestImports(
  options: ForkGuestImportOptions,
): Record<string, unknown> {
  const { moduleExports, floor, extras } = options;
  const label = options.label ?? "fork guest imports";
  const env: Record<string, unknown> = { ...extras };
  const missing: string[] = [];
  // The module's NON-function exports, bound by name before anything else.
  //
  // Two of the guest's five non-function `env` imports are things the module
  // itself owns -- the `__wpk_fork_ref_gc_transit` anyref table and the
  // `__wpk_fork_unwind` tag -- and until now every host supplied them by hand.
  // That made them a per-caller convention: a host that forgot got a link
  // error, and a host that minted its OWN tag got something worse, because the
  // module and the guest then disagree about the tag the moment the module
  // throws one (see `forkUnwindTagFrom`).
  //
  // Binding them here removes two entries from every host's obligation and
  // makes the module the single owner, which is the direction this whole lane
  // travels. They are bound BEFORE `extras` is consulted for the same reason
  // functions are: the module is the authority on what it owns.
  for (const [name, value] of Object.entries(moduleExports)) {
    if (typeof value === "function") continue;
    if (
      value instanceof WebAssembly.Table
      || value instanceof WebAssembly.Global
      || (typeof WebAssembly.Tag === "function" && value instanceof WebAssembly.Tag)
    ) {
      env[name] = value;
    }
  }
  for (const required of WPK_FORK_REQUIRED_IMPORTS) {
    if (required.module !== "env") continue;
    const fromModule = moduleExports[required.name];
    if (typeof fromModule === "function") {
      env[required.name] = fromModule;
      continue;
    }
    const fromFloor = (floor as unknown as Record<string, unknown>)[
      required.name
    ];
    if (typeof fromFloor === "function") {
      env[required.name] = fromFloor;
      continue;
    }
    missing.push(required.name);
  }
  for (const table of WPK_FORK_REQUIRED_TABLE_IMPORTS) {
    if (table.module !== "env") continue;
    if (!(env[table.name] instanceof WebAssembly.Table)) {
      missing.push(`${table.name} (a ${table.element} table)`);
    }
  }
  // The artifact's own account of what it needs, which catches the kinds the
  // two generated lists do not enumerate. Reported with the kind, because
  // "nobody bound this global" and "nobody bound this function" are fixed in
  // different places.
  if (options.guestModule !== undefined) {
    for (const required of WebAssembly.Module.imports(options.guestModule)) {
      if (required.module !== "env") continue;
      if (required.name in env) continue;
      if (missing.some((entry) => entry.startsWith(required.name))) continue;
      missing.push(`${required.name} (a ${required.kind})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${label}: ${missing.length} fork import(s) have no implementation, ` +
        `neither in the fork module nor in the host floor: ${missing.join(", ")}`,
    );
  }
  return env;
}

/**
 * Slots per activation in the module's `__wpk_fork_activation_trampolines`
 * table, and the order they are emitted in.
 *
 * DUPLICATED from `TRAMPOLINE_SLOTS` and the target list in
 * `crates/fork-module-inject`, which is the source of truth. Reading the wrong
 * slot binds one frame import to another's entry point, which is a wrong answer
 * rather than a trap -- so `host/test/fork-guest-imports.test.ts` pins the order
 * against the injector.
 */
export const FORK_ACTIVATION_TRAMPOLINE_SLOTS = [
  "__wpk_fork_frame_reserve",
  "__wpk_fork_frame_commit",
  "__wpk_fork_frame_peek",
  "__wpk_fork_frame_next",
  "__wpk_fork_resume_peek",
] as const;

/**
 * One activation's five frame/resume imports, read from the module's own table.
 *
 * These are the imports whose guest signature is frozen at one argument while
 * the module's export takes `(activation_id, arg)`. The module emits an entry
 * per activation with the id already folded in, so the host does no code
 * generation and no per-activation caching -- it indexes a table.
 */
export function forkActivationFrameImports(
  moduleExports: Record<string, unknown>,
  activationId: number,
  label = "fork activation frame imports",
): Record<string, unknown> {
  const table = moduleExports.__wpk_fork_activation_trampolines;
  if (!(table instanceof WebAssembly.Table)) {
    throw new Error(
      `${label}: the fork module exports no activation trampoline table; it ` +
        `cannot serve per-activation frame imports`,
    );
  }
  const base = activationId * FORK_ACTIVATION_TRAMPOLINE_SLOTS.length;
  if (!Number.isInteger(activationId) || activationId < 0
    || base + FORK_ACTIVATION_TRAMPOLINE_SLOTS.length > table.length) {
    // The module caps activations; asking past the cap must say so rather than
    // trap inside `table.get` with no mention of which activation was wanted.
    throw new RangeError(
      `${label}: activation ${activationId} is outside the module's table of ` +
        `${table.length / FORK_ACTIVATION_TRAMPOLINE_SLOTS.length} activations`,
    );
  }
  const imports: Record<string, unknown> = {};
  FORK_ACTIVATION_TRAMPOLINE_SLOTS.forEach((name, slot) => {
    imports[name] = table.get(base + slot);
  });
  return imports;
}

/**
 * The process-owned fork unwind tag, taken from the module that defines it.
 *
 * `fork-module-inject` defines and exports this tag so a host does not have to
 * mint one: "It was minted in JavaScript, which made every host responsible for
 * creating one and handing it over. It does not have to be." A host that mints
 * its own leaves that export dead AND makes the module and the guest disagree
 * about the tag the moment the module throws one itself.
 */
export function forkUnwindTagFrom(
  moduleExports: Record<string, unknown>,
  label = "fork unwind tag",
): WebAssembly.Tag {
  const tag = moduleExports.__wpk_fork_unwind;
  if (typeof WebAssembly.Tag !== "function") {
    throw new Error(`${label}: WebAssembly exception tags are unavailable`);
  }
  if (!(tag instanceof WebAssembly.Tag)) {
    throw new TypeError(
      `${label}: the fork module exports no __wpk_fork_unwind tag, so it ` +
        `cannot supply the process's unwind transport`,
    );
  }
  return tag;
}

/**
 * Assert a value is the process-owned fork unwind tag.
 *
 * Kept as a check rather than a cast because the tag crosses several plumbing
 * layers as an optional, and a `null` reaching `WebAssembly.instantiate` reports
 * a type mismatch that names neither the import nor who should have supplied it.
 */
export function requireForkUnwindTag(
  tag: unknown,
  context: string,
): WebAssembly.Tag {
  if (typeof WebAssembly.Tag !== "function") {
    throw new Error(`${context}: WebAssembly exception tags are unavailable`);
  }
  if (!(tag instanceof WebAssembly.Tag)) {
    throw new TypeError(
      `${context}: missing valid process-owned fork unwind tag`,
    );
  }
  return tag;
}

/**
 * Whether a caught value is the fork unwind transport rather than a program
 * exception.
 *
 * The distinction is the whole point of a private tag: instrumented catch-all
 * clauses rethrow this one, and only the worker entry boundary consumes it.
 */
export function isForkUnwindException(
  value: unknown,
  tag: WebAssembly.Tag,
): value is WebAssembly.Exception {
  return (
    typeof WebAssembly.Exception === "function"
    && value instanceof WebAssembly.Exception
    && value.is(tag)
  );
}
