// Maps kernel teardown events onto the host's machine-progress record.
//
// Pure and framework-free by design: this module carries the review-focus
// invariants (no fabricated 0-of-0 totals, no leaking a superseded switch's
// events) so they can be tested without React or a live kernel.

import type {
  DestroyProgressEvent,
  MachineProgress,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

/**
 * What the overlay shows before teardown has any count to report.
 *
 * Phase 1 of `performDestroy` is a single awaited call, so there is a real gap
 * with no measurement. Omitting `total` renders it indeterminate rather than
 * inventing a starting denominator.
 */
export function initialDestroyProgress(label: string): MachineProgress {
  return {
    phase: "destroying",
    label,
    completed: 0,
    unit: "processes",
    status: "loading",
  };
}

/**
 * Subscribe to a kernel's teardown progress, if it reports any.
 *
 * `subscribeDestroyProgress` is optional on `KernelLike`, so a kernel without
 * it yields a no-op unsubscribe and the phase stays indeterminate rather than
 * throwing. `isCurrent` drops events from a switch that has been superseded:
 * a stale kernel can finish its teardown after a newer one has taken over.
 */
export function subscribeDestroyProgress(
  kernel: {
    subscribeDestroyProgress?(
      cb: (event: DestroyProgressEvent) => void,
    ): () => void;
  },
  label: string,
  isCurrent: () => boolean,
  publish: (progress: MachineProgress) => void,
): () => void {
  return kernel.subscribeDestroyProgress?.((event) => {
    if (!isCurrent()) return;
    publish(destroyProgressToMachineProgress(label, event));
  }) ?? (() => {});
}

/**
 * Map one teardown event onto the host's machine-progress record.
 *
 * A zero total means there was nothing to reap; it is dropped so the bar stays
 * indeterminate instead of rendering 0 of 0 as a finished bar.
 */
export function destroyProgressToMachineProgress(
  label: string,
  event: DestroyProgressEvent,
): MachineProgress {
  return {
    phase: "destroying",
    label,
    completed: event.completed,
    ...(event.total > 0
      ? { total: event.total, totalProvisional: event.totalProvisional }
      : {}),
    unit: "processes",
    status: "loading",
  };
}
