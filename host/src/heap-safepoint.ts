/**
 * Process heap safepoints: the host half of the bounded syscall wait in
 * `libc/glue/channel_syscall.c`.
 *
 * WHY: JavaScriptCore (Safari on every device, and Bun) keeps a worker's heap
 * access while the worker is blocked in `memory.atomic.wait32`. A garbage
 * collection that began in that worker's VM before it blocked is handed back
 * to the blocked thread, and it finishes only when that thread runs
 * JavaScript that reaches an allocation slow path. Until then the collection
 * keeps every shared GC helper thread that joined it. A Kandelo process waits
 * for each syscall in Wasm and never returns to JavaScript while it waits, so
 * idle processes (a shell at its prompt, a database waiting for a client) pin
 * all helpers. Other workers' collections then stall: the kernel's, and those
 * of exiting process workers, whose memory is never released. The machine
 * deadlocks once the kernel needs a collection to create a process's memory.
 *
 * On those engines the glue bounds each wait. After a timeout it calls
 * `kernel.kernel_heap_safepoint`, which allocates a small `ArrayBuffer` (an
 * allocation slow path at which JavaScriptCore finishes a handed-off
 * collection) and returns the next bound. V8 and SpiderMonkey do not need
 * safepoints, so they receive a negative bound and the glue waits without a
 * timeout from then on. See docs/browser-support.md, "JavaScriptCore garbage
 * collection and blocked workers".
 */

/** Bound between safepoints while a JavaScriptCore process is blocked. */
export const HEAP_SAFEPOINT_INTERVAL_NS = 100_000_000n;

/** Tells the glue to wait without a bound from now on. */
export const HEAP_SAFEPOINT_UNBOUNDED = -1n;

/**
 * Whether this engine keeps heap access while a worker is blocked in a
 * synchronous atomic wait. Only JavaScriptCore does; it identifies itself as
 * Safari (Chromium and Firefox advertise "Safari" too, but also their own
 * tokens) or as Bun.
 */
export function engineHoldsHeapAccessWhileWaiting(
  userAgent: string | undefined,
): boolean {
  if (userAgent === undefined) return false;
  if (/\bBun\//.test(userAgent)) return true;
  return /Safari/.test(userAgent)
    && !/Chrome|Chromium|Android|Firefox/.test(userAgent);
}

// Keep the newest allocation reachable so an optimizing compiler cannot
// remove it; it is replaced at the next safepoint.
let safepointAllocation: ArrayBuffer | undefined;

/**
 * Build the `kernel_heap_safepoint` import for one process or thread image.
 */
export function createHeapSafepointImport(
  userAgent: string | undefined =
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent,
): () => bigint {
  const bound = engineHoldsHeapAccessWhileWaiting(userAgent)
    ? HEAP_SAFEPOINT_INTERVAL_NS
    : HEAP_SAFEPOINT_UNBOUNDED;
  return () => {
    safepointAllocation = new ArrayBuffer(8);
    return bound;
  };
}

/** @internal The newest safepoint allocation, for tests. */
export function lastHeapSafepointAllocationForTest(): ArrayBuffer | undefined {
  return safepointAllocation;
}
