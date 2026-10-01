import { describe, expect, it } from "vitest";
import type { DestroyProgressEvent } from "../src/browser-kernel-protocol";
import { createDestroyProgressReporter } from "../src/destroy-progress-reporter";

function collect() {
  const events: DestroyProgressEvent[] = [];
  return { events, emit: (e: DestroyProgressEvent) => events.push(e) };
}

describe("destroy progress reporter", () => {
  it("reports the woken total as provisional when draining starts", () => {
    const { events, emit } = collect();
    createDestroyProgressReporter(emit).startDraining(7);
    expect(events).toEqual([
      { phase: "draining", completed: 0, total: 7, totalProvisional: true },
    ]);
  });

  it("emits only when the completed count changes", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(0);
    r.drained(0);
    r.drained(2);
    r.drained(2);
    r.drained(3);
    expect(events.map((e) => e.completed)).toEqual([0, 2, 3]);
  });

  it("carries the drain total forward and marks it final when terminating", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(7);
    r.startTerminating(2);
    r.terminatedOne();
    expect(events.at(-2)).toEqual({
      phase: "terminating", completed: 7, total: 9, totalProvisional: false,
    });
    expect(events.at(-1)).toEqual({
      phase: "terminating", completed: 8, total: 9, totalProvisional: false,
    });
  });

  it("never lowers completed or total", () => {
    // Review Focus 3. The denominator may grow; neither number may shrink.
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(5);
    r.startTerminating(2);
    r.terminatedOne();
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.completed).toBeGreaterThanOrEqual(events[i - 1]!.completed);
      expect(events[i]!.total).toBeGreaterThanOrEqual(events[i - 1]!.total);
    }
  });

  it("does not synthesize completion when the drain times out", () => {
    // Review Focus 2. Three of seven exited, then teardown gave up.
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(3);
    const last = events.at(-1)!;
    expect(last.completed).toBe(3);
    expect(last.completed).not.toBe(last.total);
  });

  it("a second terminate sweep never lowers the total", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(7);
    r.startTerminating(2);
    r.terminatedOne();
    const before = events.at(-1)!;
    r.startTerminating(0);
    const after = events.at(-1)!;
    expect(after.total).toBe(9);
    expect(after.completed).toBeGreaterThanOrEqual(before.completed);
  });

  it("a second terminate sweep does not republish an unchanged total", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(7);
    r.startTerminating(2);
    r.terminatedOne();
    const countBefore = events.length;
    r.startTerminating(0);
    r.startTerminating(0);
    expect(events.length).toBe(countBefore);
  });

  it("completion survives a second terminate sweep", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(7);
    r.startTerminating(2);
    r.terminatedOne();
    // Second sweep: no new stragglers found, but one more straggler
    // (discovered by the first sweep) finishes terminating here.
    r.startTerminating(0);
    r.terminatedOne();
    const last = events.at(-1)!;
    expect(last.completed).toBe(9);
    expect(last.total).toBe(9);
    expect(last.completed).toBe(last.total);
  });

  it("a second terminate sweep adds its own stragglers to the total", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(7);
    r.startTerminating(2);
    r.terminatedOne();
    r.terminatedOne();
    r.startTerminating(1);
    expect(events.at(-1)!.total).toBe(10);
    r.terminatedOne();
    const last = events.at(-1)!;
    expect(last.completed).toBe(10);
    expect(last.total).toBe(10);
  });

  it("a sweep that finds nothing does not change the total", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(4);
    r.drained(4);
    r.startTerminating(1);
    r.terminatedOne();
    const countBefore = events.length;
    r.startTerminating(0);
    expect(events.at(-1)!.total).toBe(5);
    expect(events.length).toBe(countBefore);
  });

  it("reports a zero total rather than inventing one", () => {
    const { events, emit } = collect();
    createDestroyProgressReporter(emit).startDraining(0);
    expect(events).toEqual([
      { phase: "draining", completed: 0, total: 0, totalProvisional: true },
    ]);
  });
});
