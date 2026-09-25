import type { DestroyProgressEvent } from "./browser-kernel-protocol";

export interface DestroyProgressReporter {
  /** Phase 2 begins; `total` is the woken pid count. */
  startDraining(total: number): void;
  /** Phase 2 tick: how many of the woken set have exited so far. */
  drained(completedCount: number): void;
  /** Phase 3 begins; `stragglerCount` is added to the total. */
  startTerminating(stragglerCount: number): void;
  /** One straggler finished terminating. Increments; safe across sweeps. */
  terminatedOne(): void;
}

/**
 * Turns `performDestroy`'s phase counters into cumulative progress events.
 *
 * Emits only when `completed` moves, so a 15 ms drain poll does not produce a
 * message per tick. Never lowers `completed` or `total`: the denominator grows
 * once, when phase 3 discovers stragglers, and the UI marks it provisional
 * until then.
 */
export function createDestroyProgressReporter(
  emit: (event: DestroyProgressEvent) => void,
): DestroyProgressReporter {
  let phase: DestroyProgressEvent["phase"] = "draining";
  let drainTotal = 0;
  let total = 0;
  let completed = 0;
  let provisional = true;
  let emitted = false;

  const publish = (): void => {
    emit({ phase, completed, total, totalProvisional: provisional });
    emitted = true;
  };

  return {
    startDraining(next) {
      phase = "draining";
      drainTotal = Math.max(0, next);
      total = drainTotal;
      completed = 0;
      provisional = true;
      publish();
    },
    drained(count) {
      const next = Math.min(Math.max(count, completed), drainTotal);
      if (emitted && next === completed) return;
      completed = next;
      publish();
    },
    startTerminating(stragglerCount) {
      const added = Math.max(0, stragglerCount);
      const alreadyTerminating = phase === "terminating";
      if (alreadyTerminating && added === 0) return;
      phase = "terminating";
      total += added;
      provisional = false;
      publish();
    },
    terminatedOne() {
      const next = Math.min(completed + 1, total);
      if (next === completed) return;
      completed = next;
      publish();
    },
  };
}
