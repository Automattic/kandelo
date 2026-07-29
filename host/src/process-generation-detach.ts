/**
 * Exact execution-generation teardown shared by the Node and browser hosts.
 *
 * A numeric PID is not an execution identity: exec keeps the PID while
 * replacing its worker and WebAssembly.Memory. Teardown must therefore retain
 * the captured generation until the kernel confirms that exact Memory is no
 * longer registered. A false return proves it was superseded; an exception
 * leaves ownership unknown and keeps the transaction retryable.
 */

export interface ExactProcessGenerationDetach<T extends object> {
  readonly pid: number;
  readonly generation: T;
  readonly memory: WebAssembly.Memory;
  /**
   * Remove the exact kernel registration. Returning false means another
   * generation currently owns the PID, which proves the captured Memory is
   * already superseded and must not make its lease wait for the successor.
   */
  readonly detach: (
    pid: number,
    memory: WebAssembly.Memory,
  ) => boolean | Promise<boolean>;
  /** Settle kernel-realm listeners that captured the retired Memory. */
  readonly settle: (
    pid: number,
    memory: WebAssembly.Memory,
  ) => void | Promise<void>;
  /**
   * Consume the exact generation's final host ownership/lease, then call
   * `commit` immediately after that single-owner operation succeeds.
   *
   * Code that can fail must run before consuming the lease. The explicit
   * marker lets the ledger distinguish a pre-commit failure (retry required)
   * from an exception after ownership was already consumed (never retry).
   */
  readonly retire: (commit: () => void) => void | Promise<void>;
}

export type ExactProcessGenerationDetachResult =
  | {
      readonly status: "released";
      readonly removedCurrent: boolean;
      /**
       * Edge-triggered authority for PID-wide follow-up such as host reaping.
       * Local map removal alone is insufficient when kernel detach reported
       * that this execution generation was already superseded.
       */
      readonly mayReapPid: boolean;
      readonly detachDisposition: "removed-or-absent" | "superseded";
      readonly postCommitError?: unknown;
    }
  | {
      readonly status: "retained-error";
      readonly removedCurrent: false;
      readonly mayReapPid: false;
      readonly error: unknown;
    };

interface PendingDetach<T extends object> {
  readonly transaction: ExactProcessGenerationDetach<T>;
  detached: boolean;
  detachDisposition?: "removed-or-absent" | "superseded";
  settled: boolean;
  retired: boolean;
  postCommitFailed: boolean;
  postCommitError?: unknown;
  active?: Promise<ExactProcessGenerationDetachResult>;
}

/**
 * Retains teardown authority for exact process generations across async races.
 *
 * The ledger deliberately keys by the generation object rather than PID. That
 * lets an old generation remain retryable after exec installs a successor in
 * the PID map. `removeCurrent` is called only after every awaited detach phase
 * and only when `current(pid)` still returns the captured object.
 */
export class ExactProcessGenerationDetachLedger<T extends object> {
  private readonly pending = new Map<T, PendingDetach<T>>();
  private readonly completed = new WeakMap<
    T,
    Extract<ExactProcessGenerationDetachResult, { status: "released" }>
  >();

  constructor(
    private readonly current: (pid: number) => T | undefined,
    private readonly removeCurrent: (pid: number, generation: T) => void,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  hasPending(generation: T): boolean {
    return this.pending.has(generation);
  }

  async detach(
    transaction: ExactProcessGenerationDetach<T>,
  ): Promise<ExactProcessGenerationDetachResult> {
    const completed = this.completed.get(transaction.generation);
    if (completed) {
      // Map removal and PID-wide follow-up are edge-triggered. Replaying either
      // later could act on an exec successor.
      return {
        ...completed,
        removedCurrent: false,
        mayReapPid: false,
      };
    }
    let pending = this.pending.get(transaction.generation);
    if (pending) {
      const original = pending.transaction;
      if (
        original.pid !== transaction.pid ||
        original.memory !== transaction.memory
      ) {
        throw new Error(
          "process generation was queued with conflicting detach identity",
        );
      }
    } else {
      pending = {
        transaction,
        detached: false,
        settled: false,
        retired: false,
        postCommitFailed: false,
      };
      this.pending.set(transaction.generation, pending);
    }
    return this.run(pending);
  }

  /**
   * Retry every retained transaction once.
   *
   * Destroy calls this after ordinary cleanup. Transactions are retained only
   * when detach or a later retirement phase threw before ownership was proven.
   */
  async retryPending(): Promise<ExactProcessGenerationDetachResult[]> {
    const results: ExactProcessGenerationDetachResult[] = [];
    for (const pending of [...this.pending.values()]) {
      results.push(await this.run(pending));
    }
    return results;
  }

  private async run(
    pending: PendingDetach<T>,
  ): Promise<ExactProcessGenerationDetachResult> {
    if (pending.active) {
      const result = await pending.active;
      if (result.status !== "released") return result;
      // A concurrent observer must not replay map-removal or reaping edges.
      return { ...result, removedCurrent: false, mayReapPid: false };
    }
    const active = this.perform(pending);
    pending.active = active;
    try {
      return await active;
    } finally {
      if (pending.active === active) pending.active = undefined;
    }
  }

  private async perform(
    pending: PendingDetach<T>,
  ): Promise<ExactProcessGenerationDetachResult> {
    const { transaction } = pending;
    try {
      if (!pending.detached) {
        const detached = await transaction.detach(
          transaction.pid,
          transaction.memory,
        );
        pending.detached = true;
        pending.detachDisposition = detached
          ? "removed-or-absent"
          : "superseded";
      }

      if (!pending.settled) {
        await transaction.settle(transaction.pid, transaction.memory);
        pending.settled = true;
      }

      if (!pending.retired) {
        try {
          await transaction.retire(() => {
            if (pending.retired) {
              throw new Error(
                "process generation retirement committed more than once",
              );
            }
            pending.retired = true;
          });
          if (!pending.retired) {
            throw new Error(
              "process generation retirement returned without committing",
            );
          }
        } catch (error) {
          if (!pending.retired) throw error;
          // Ownership is already consumed. Preserve the diagnostic, but never
          // invoke the single-owner callback again on retry.
          pending.postCommitFailed = true;
          pending.postCommitError = error;
        }
      }

      // WHY: detach/settle/retire can all yield. Exec may install a successor
      // during any await, so PID-only deletion here would erase the new image.
      let removedCurrent = false;
      if (this.current(transaction.pid) === transaction.generation) {
        this.removeCurrent(transaction.pid, transaction.generation);
        if (this.current(transaction.pid) === transaction.generation) {
          throw new Error(
            "exact process generation cleanup left the generation current",
          );
        }
        removedCurrent = true;
      }

      const result = {
        status: "released",
        removedCurrent,
        // WHY: false detach means the kernel has already assigned this PID to
        // another generation. We may drop a stale host-map object, but reaping
        // the numeric PID would then reap its successor.
        mayReapPid:
          removedCurrent
          && pending.detachDisposition === "removed-or-absent",
        detachDisposition: pending.detachDisposition!,
        ...(!pending.postCommitFailed
          ? {}
          : { postCommitError: pending.postCommitError }),
      } as const;
      // WHY: terminate, exit, and destroy can capture the same object before
      // either awaits Worker shutdown. Keep a weak completion tombstone so the
      // later path cannot consume the single-owner memory lease twice.
      this.completed.set(transaction.generation, result);
      this.pending.delete(transaction.generation);
      return result;
    } catch (error) {
      // Keep the transaction and its completed phase markers. A later retry
      // resumes at the first incomplete phase without double-consuming a lease.
      return {
        status: "retained-error",
        removedCurrent: false,
        mayReapPid: false,
        error,
      };
    }
  }
}
