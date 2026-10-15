/**
 * Result of the kernel worker's best-effort graceful ownership teardown.
 *
 * A false value does not ask the main thread to keep the worker alive. The
 * worker realm itself is the final containment boundary: after its nested
 * process and pthread workers have been terminated, terminating the kernel
 * worker drops any aliases that an incomplete graceful detach left behind.
 */
export interface KernelRealmDestroyResult {
  readonly gracefulDetachComplete: boolean;
  readonly persistenceSyncFailure?: string;
}

export function kernelRealmDestroyResult(
  gracefulDetachComplete: boolean,
  persistenceSyncFailure?: string,
): KernelRealmDestroyResult {
  return Object.freeze({ gracefulDetachComplete, persistenceSyncFailure });
}

export function readKernelRealmDestroyResult(
  value: unknown,
): KernelRealmDestroyResult | null {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as { gracefulDetachComplete?: unknown })
      .gracefulDetachComplete !== "boolean"
    || ("persistenceSyncFailure" in value
      && (value as { persistenceSyncFailure?: unknown }).persistenceSyncFailure !== undefined
      && typeof (value as { persistenceSyncFailure?: unknown }).persistenceSyncFailure !== "string")
  ) {
    return null;
  }
  return {
    gracefulDetachComplete: (
      value as { gracefulDetachComplete: boolean }
    ).gracefulDetachComplete,
    persistenceSyncFailure: (value as KernelRealmDestroyResult).persistenceSyncFailure,
  };
}

/**
 * Wait for the worker's bounded graceful phase without making it final
 * ownership authority. The caller must terminate the worker realm afterward
 * whether this returns success or a diagnostic.
 */
export async function awaitGracefulKernelRealmDestroyOutcome(
  request: () => Promise<unknown>,
  timeoutMs: number,
): Promise<{ result: KernelRealmDestroyResult | null; failure?: string }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      request().then((result) => ({ type: "response" as const, result })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ type: "timeout" }),
          timeoutMs,
        );
      }),
    ]);
    if (outcome.type === "timeout") {
      return { result: null, failure: `graceful kernel-worker detach timed out after ${timeoutMs}ms` };
    }
    const result = readKernelRealmDestroyResult(outcome.result);
    if (!result) {
      return { result: null, failure: "kernel worker returned an invalid destroy result" };
    }
    const failures = [
      !result.gracefulDetachComplete
        ? "kernel worker reported incomplete graceful generation detach"
        : undefined,
      result.persistenceSyncFailure,
    ].filter((failure): failure is string => failure !== undefined);
    return { result, failure: failures.length > 0 ? failures.join("; ") : undefined };
  } catch (error) {
    return { result: null, failure: "graceful kernel-worker detach failed: " +
      (error instanceof Error ? error.message : String(error)) };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function awaitGracefulKernelRealmDestroy(
  request: () => Promise<unknown>,
  timeoutMs: number,
): Promise<string | undefined> {
  return (await awaitGracefulKernelRealmDestroyOutcome(request, timeoutMs)).failure;
}
