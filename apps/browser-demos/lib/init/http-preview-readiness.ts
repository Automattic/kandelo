/** Probe ownership belongs to one machine activation, not the reused page. */
export async function waitForHttpPreview(
  url: string,
  timeoutMs: number,
  options: { requireOk?: boolean; signal: AbortSignal },
): Promise<void> {
  const { signal } = options;
  const started = performance.now();
  let delayMs = 250;
  let lastError = "";
  while (performance.now() - started < timeoutMs) {
    signal.throwIfAborted();
    try {
      const response = await fetchWithTimeout(url, 5_000, signal);
      // A response can already be queued when its owner is retired. Neither
      // that result nor a retry may resurrect the outgoing preview.
      signal.throwIfAborted();
      if (options.requireOk ? response.ok : response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      // WHY: only this activation's explicit cancellation ends its loop.
      // Per-request timeout and real HTTP/transport failures keep the same
      // retry/deadline behavior and remain visible to the current machine.
      signal.throwIfAborted();
      lastError = error instanceof Error ? error.message : String(error);
    }
    await waitToRetry(delayMs, signal);
    delayMs = Math.min(1_500, Math.floor(delayMs * 1.4));
  }
  signal.throwIfAborted();
  throw new Error(lastError || "timed out");
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

function waitToRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    // WHY: guarding only the eventual UI callback leaves both this timer and
    // the next HTTP request alive after its machine's bridge was destroyed.
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
