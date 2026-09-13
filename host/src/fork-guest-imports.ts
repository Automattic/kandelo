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
 * Every one of these either reads inside a reference or compares two of them:
 * `provenance_externref` reads a handle off a token and keys a map by object
 * identity; `encode_funcref` needs function equality, which no wasm instruction
 * provides on `funcref`; `table_state_owned` reports an election decided by
 * `WebAssembly.Table` object identity. The `table_mutation_*` trio is here for a
 * different reason -- it is implementable in wasm and not yet implemented, so it
 * is a to-do rather than a floor. The two `exn_*` throws must re-enter wasm
 * throwing, which a host import cannot do from JavaScript.
 */
export interface ForkGuestHostFloor {
  readonly __wpk_fork_ref_provenance_externref: (value: unknown) => unknown;
  readonly __wpk_fork_ref_encode_funcref: (fn: unknown) => number;
  readonly __wpk_fork_module_state_table_state_owned: (owner: number) => number;
  readonly __wpk_fork_module_state_table_mutation_begin: () => bigint;
  readonly __wpk_fork_module_state_table_mutation_commit: (
    owner: number,
    firstIndex: bigint,
    length: bigint,
  ) => void;
  readonly __wpk_fork_module_state_table_mutation_abort: () => void;
  readonly __wpk_fork_ref_exn_ingress_throw: (recipe: number) => void;
  readonly __wpk_fork_ref_exn_broker_throw_recipe: (recipe: number) => void;
}

/** The floor's member names, for callers that need to reason about the set. */
export const FORK_GUEST_HOST_FLOOR_NAMES = [
  "__wpk_fork_module_state_table_mutation_abort",
  "__wpk_fork_module_state_table_mutation_begin",
  "__wpk_fork_module_state_table_mutation_commit",
  "__wpk_fork_module_state_table_state_owned",
  "__wpk_fork_ref_encode_funcref",
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
  if (missing.length > 0) {
    throw new Error(
      `${label}: ${missing.length} fork import(s) have no implementation, ` +
        `neither in the fork module nor in the host floor: ${missing.join(", ")}`,
    );
  }
  return env;
}
