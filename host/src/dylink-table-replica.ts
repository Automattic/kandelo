/**
 * One Worker's view of the process's published funcref table state.
 *
 * # Why this is not in the planner
 *
 * Everything else the fork archive holds is loader state, and the loader is
 * `crates/dylink`. The funcref table graph is not: it belongs to the fork
 * activation coordinator, which lives on this side because it owns
 * `WebAssembly.Table` objects and typed reference codecs. The archive carries
 * it because the two must be published under ONE generation fence — a peer that
 * saw new modules beside an old table graph would call into slots the new
 * modules had not written yet.
 *
 * So this file holds exactly the part that is not the planner's: which
 * generation this Worker has applied, and when to ask the coordinator to catch
 * up. The archive's layout, its record chain, its immutability rules and the
 * ordering of its generation write are all decided in `crates/dylink::archive`
 * and performed by `DylinkLoader`.
 */

import type { DylinkLoader, LoaderTableState } from "./dylink-loader";

/**
 * What a Worker does when the process publishes a newer table state.
 *
 * `previousGeneration` is what this Worker had applied, so the callback can
 * apply only the patches newer than that rather than replaying the journal.
 */
export type DylinkTableStateApply = (
  state: LoaderTableState,
  previousGeneration: number,
) => void;

export class DylinkForkTableReplica {
  #appliedGeneration = 0;

  constructor(
    private readonly loader: DylinkLoader,
    private readonly apply: DylinkTableStateApply,
    private readonly label: string,
  ) {}

  /** The generation this Worker has applied. */
  generation(): number {
    return this.#appliedGeneration;
  }

  /**
   * Adopt a generation this Worker itself published, or one it is known to
   * already reflect.
   *
   * A publication is not a change to catch up on: the Worker that made it has
   * the state by construction. Re-applying it would replay its own patches.
   */
  adoptPublishedGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new RangeError(`${this.label}: invalid published generation ${generation}`);
    }
    if (generation < this.#appliedGeneration) {
      // Going backwards would mean two Workers disagreed about which
      // publication is newest, which no later comparison could recover from.
      throw new Error(
        `${this.label}: published generation ${generation} is older than the ` +
          `applied generation ${this.#appliedGeneration}`,
      );
    }
    this.#appliedGeneration = generation;
  }

  /**
   * Catch up with whatever the process has published. Returns whether anything
   * changed.
   *
   * The caller holds the process archive lock: the fast-path generation read
   * below is a hint about whether work is needed, not permission to consume an
   * archive another Worker is still writing.
   */
  reconcile(): boolean {
    const published = this.loader.generation();
    if (published === this.#appliedGeneration) return false;
    this.loader.readArchive();
    const state = this.loader.tableState();
    const previous = this.#appliedGeneration;
    this.apply(state, previous);
    this.#appliedGeneration = Math.max(published, state.generation);
    return true;
  }
}
