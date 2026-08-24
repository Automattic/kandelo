import { KernelReentrantEntryError } from "./kernel-entry-gate";

export type KernelEntryRetryScheduler = (retry: () => void) => void;

export type KernelEntryGenerationResult<T> =
  | { status: "current"; value: T }
  | { status: "stale" };

const scheduleOnLaterHostTurn: KernelEntryRetryScheduler = (retry) => {
  setTimeout(retry, 0);
};

/**
 * Retry an immediate, result-bearing kernel entry after temporary contention.
 *
 * Result-bearing entries reject before retaining inputs or mutating kernel
 * state when another export owns the gate. Process-launch continuations have
 * already yielded to the host event loop, so unrelated HTTP, inspector, or
 * process activity may legitimately own that gate when they resume. Yielding
 * to a later host turn preserves serialization without translating contention
 * into a guest-visible fork, spawn, exec, or clone failure.
 */
export function retryKernelEntryResult<T>(
  operation: () => T,
  scheduleRetry: KernelEntryRetryScheduler = scheduleOnLaterHostTurn,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const attempt = (): void => {
      try {
        resolve(operation());
      } catch (error) {
        if (!(error instanceof KernelReentrantEntryError)) {
          reject(error);
          return;
        }
        try {
          scheduleRetry(attempt);
        } catch (scheduleError) {
          reject(scheduleError);
        }
      }
    };
    attempt();
  });
}

/**
 * Retry a kernel entry only while its exact host process generation remains
 * current.
 *
 * The generation predicate deliberately runs inside every retry attempt. A
 * retry yields to the host event loop, where exec may replace the process
 * registered for the same PID. Checking before the first attempt alone would
 * let the stale continuation mutate the replacement process through a
 * PID-only kernel export.
 */
export function retryKernelEntryResultForGeneration<T>(
  isCurrentGeneration: () => boolean,
  operation: () => T,
  scheduleRetry: KernelEntryRetryScheduler = scheduleOnLaterHostTurn,
): Promise<KernelEntryGenerationResult<T>> {
  return retryKernelEntryResult(
    () => isCurrentGeneration()
      ? { status: "current", value: operation() }
      : { status: "stale" },
    scheduleRetry,
  );
}
