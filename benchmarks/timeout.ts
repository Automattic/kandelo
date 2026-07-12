export interface TimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemTimeoutScheduler: TimeoutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Bound an operation with a rejecting timer and always retire that timer. */
export async function withRejectingTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  scheduler: TimeoutScheduler = systemTimeoutScheduler,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = scheduler.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle !== undefined) scheduler.clearTimeout(timeoutHandle);
  }
}
