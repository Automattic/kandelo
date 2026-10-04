import { describe, expect, it } from "vitest";
import {
  LongTimeouts,
  MAX_ENGINE_TIMER_DELAY_MS,
} from "../src/long-timeout";

/** A manual clock and timer queue standing in for an engine. */
function fakeEngine() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; op: () => void }>();
  const delays: number[] = [];
  return {
    delays,
    timers,
    scheduler: {
      schedule(op: () => void, delayMs: number): number {
        // A real engine misbehaves past this; the class must never ask.
        expect(delayMs).toBeLessThanOrEqual(MAX_ENGINE_TIMER_DELAY_MS);
        delays.push(delayMs);
        const id = nextId++;
        timers.set(id, { at: now + delayMs, op });
        return id;
      },
      cancel(id: number): void {
        timers.delete(id);
      },
      now: () => now,
    },
    /** Advance to the next timer and run it. */
    step(): boolean {
      let first: [number, { at: number; op: () => void }] | undefined;
      for (const entry of timers) {
        if (!first || entry[1].at < first[1].at) first = entry;
      }
      if (!first) return false;
      timers.delete(first[0]);
      now = first[1].at;
      first[1].op();
      return true;
    },
    get now() {
      return now;
    },
  };
}

describe("LongTimeouts", () => {
  it("passes ordinary delays straight to the engine", () => {
    const engine = fakeEngine();
    const timers = new LongTimeouts(engine.scheduler);
    let fired = 0;
    const handle = timers.register(() => fired++, 250);
    expect(typeof handle).toBe("number");
    expect(engine.delays).toEqual([250]);
    engine.step();
    expect(fired).toBe(1);
    expect(engine.now).toBe(250);
  });

  it("fires a delay past the engine limit at its deadline, in chunks", () => {
    const engine = fakeEngine();
    const timers = new LongTimeouts(engine.scheduler);
    const delay = 30 * 24 * 60 * 60 * 1000; // 30 days
    let firedAt = -1;
    const token = timers.register(() => {
      firedAt = engine.now;
    }, delay);
    expect(typeof token).toBe("object");
    while (engine.step()) {}
    expect(firedAt).toBe(delay);
    expect(engine.delays).toEqual([
      MAX_ENGINE_TIMER_DELAY_MS,
      delay - MAX_ENGINE_TIMER_DELAY_MS,
    ]);
    expect(timers.pendingCount).toBe(0);
  });

  it("cancels a long timer between chunks", () => {
    const engine = fakeEngine();
    const timers = new LongTimeouts(engine.scheduler);
    let fired = 0;
    const token = timers.register(() => fired++, 3 * MAX_ENGINE_TIMER_DELAY_MS);
    engine.step(); // first chunk elapses; the next is armed
    expect(engine.timers.size).toBe(1);
    timers.cancel(token);
    expect(engine.timers.size).toBe(0);
    expect(timers.pendingCount).toBe(0);
    while (engine.step()) {}
    expect(fired).toBe(0);
  });

  it("cancels ordinary handles through the engine", () => {
    const engine = fakeEngine();
    const timers = new LongTimeouts(engine.scheduler);
    let fired = 0;
    timers.cancel(timers.register(() => fired++, 10));
    while (engine.step()) {}
    expect(fired).toBe(0);
  });
});
