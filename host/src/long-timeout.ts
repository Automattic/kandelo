/**
 * Timers whose delay exceeds what an engine's setTimeout honours.
 *
 * WHY: engines cap a timer delay at 2^31-1 ms (~24.8 days) and disagree past
 * it. Node fires after 1 ms; browsers wrap the delay to 32 bits. A guest
 * poll, ppoll, sleep or POSIX timer with a longer timeout therefore ended at
 * once on Node and at an arbitrary time in the browser. A long delay gets a
 * stable token instead, and the engine timer behind it is re-armed in capped
 * chunks until the absolute deadline, the same on every host. Callers keep
 * comparing and cancelling the token as they would an engine handle.
 */

/** Largest delay every engine's setTimeout honours (2^31-1 ms). */
export const MAX_ENGINE_TIMER_DELAY_MS = 0x7fffffff;

export interface LongTimeoutScheduler<Handle> {
  schedule(operation: () => void, delayMs: number): Handle;
  cancel(handle: Handle): void;
  now(): number;
}

export class LongTimeouts<Handle> {
  readonly #armed = new Map<object, Handle>();

  constructor(private readonly scheduler: LongTimeoutScheduler<Handle>) {}

  /** Schedule `operation` after `delayMs`; long delays return a token. */
  register(operation: () => void, delayMs: number): Handle | object {
    if (!(delayMs > MAX_ENGINE_TIMER_DELAY_MS)) {
      return this.scheduler.schedule(operation, delayMs);
    }
    const token = {};
    const deadline = this.scheduler.now() + delayMs;
    const arm = (remainingMs: number): void => {
      this.#armed.set(
        token,
        this.scheduler.schedule(() => {
          if (!this.#armed.has(token)) return;
          const left = deadline - this.scheduler.now();
          if (left > 0) {
            arm(left);
            return;
          }
          this.#armed.delete(token);
          operation();
        }, Math.min(remainingMs, MAX_ENGINE_TIMER_DELAY_MS)),
      );
    };
    arm(delayMs);
    return token;
  }

  /** Cancel a handle or token returned by `register`. */
  cancel(timer: Handle | object): void {
    if (typeof timer === "object" && timer !== null) {
      const armed = this.#armed.get(timer);
      if (armed !== undefined) {
        this.#armed.delete(timer);
        this.scheduler.cancel(armed);
        return;
      }
    }
    this.scheduler.cancel(timer as Handle);
  }

  /** Long timers currently waiting (for tests and diagnostics). */
  get pendingCount(): number {
    return this.#armed.size;
  }
}
