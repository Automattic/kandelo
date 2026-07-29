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
}

export function kernelRealmDestroyResult(
  gracefulDetachComplete: boolean,
): KernelRealmDestroyResult {
  return Object.freeze({ gracefulDetachComplete });
}

export function readKernelRealmDestroyResult(
  value: unknown,
): KernelRealmDestroyResult | null {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as { gracefulDetachComplete?: unknown })
      .gracefulDetachComplete !== "boolean"
  ) {
    return null;
  }
  return {
    gracefulDetachComplete: (
      value as { gracefulDetachComplete: boolean }
    ).gracefulDetachComplete,
  };
}

/**
 * Wait for the worker's bounded graceful phase without making it final
 * ownership authority. The caller must terminate the worker realm afterward
 * whether this returns success or a diagnostic.
 */
export async function awaitGracefulKernelRealmDestroy(
  request: () => Promise<unknown>,
  timeoutMs: number,
): Promise<string | undefined> {
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
      return `graceful kernel-worker detach timed out after ${timeoutMs}ms`;
    }
    const result = readKernelRealmDestroyResult(outcome.result);
    if (!result) {
      return "kernel worker returned an invalid destroy result";
    }
    if (!result.gracefulDetachComplete) {
      return "kernel worker reported incomplete graceful generation detach";
    }
    return undefined;
  } catch (error) {
    return "graceful kernel-worker detach failed: " +
      (error instanceof Error ? error.message : String(error));
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
