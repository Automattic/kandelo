/**
 * Read the fork coordinator's phase from the resident fork-module.
 *
 * The module owns the phase machine (`crates/fork-module/src/lib.rs`: the
 * `PHASE_*` constants and `require_phase`). Every coordinator entry point there
 * refuses a call that is not legal from the current phase, answering `EBUSY`.
 * The host used to keep its own `phase` field alongside that and answer from
 * the copy -- two authorities for one fact, and the copy was the one that could
 * enforce nothing. This file is the whole of what replaces that field: a
 * numeric read and a name for the number. It holds no state.
 *
 * PREFER ACTING TO ASKING. A phase read followed by the call it guards is two
 * steps the module cannot make atomic, so the answer is stale in principle by
 * the time the caller branches on it, while `EBUSY` from the call itself is
 * not. Read the phase only where there is nothing to attempt and catch:
 * choosing WHICH entry point to run, and asserting an invariant.
 */

/**
 * Phase names, ordered so that the index IS the module's `PHASE_*` value.
 *
 * The order is the contract with `fm_phase`. Reordering this array silently
 * renames every phase, so the paired test pins the mapping value by value
 * against the Rust constants rather than against this array.
 */
export const FORK_PHASES = [
  "idle",
  "capture",
  "sealed-parent",
  "parent-replay",
  "child-replay",
  "abort-replay",
] as const;

export type ForkPhase = (typeof FORK_PHASES)[number];

/** The module export this reads. */
export const FORK_PHASE_EXPORT = "fm_phase";

/**
 * The phase the module is in.
 *
 * `null` exports mean this worker has no fork-module, so it is not
 * fork-instrumented and no capture can ever have begun in it. `idle` is the
 * truthful answer there, not a convenient default: there is no phase machine to
 * be at odds with, rather than one we are declining to consult.
 *
 * Throws when the module answers a value this host has no name for, rather than
 * returning `undefined`. An unnamed phase means the module gained one the host
 * was not rebuilt for, and every caller branches on the name -- so `undefined`
 * would take the `else` of each branch and run the wrong entry point on a
 * process mid-fork. A drifted pair has to fail where it drifted.
 */
export function forkPhase(
  exports: Record<string, unknown> | null,
  pid: number,
): ForkPhase {
  if (exports === null) return "idle";
  const read = exports[FORK_PHASE_EXPORT];
  if (typeof read !== "function") {
    throw new Error(`pid=${pid}: fork-module exports no ${FORK_PHASE_EXPORT}()`);
  }
  const value = (read as () => number)();
  const name = FORK_PHASES[value];
  if (name === undefined) {
    throw new Error(
      `pid=${pid}: fork-module reported phase ${value}, which this host has no name for`,
    );
  }
  return name;
}
