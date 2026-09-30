import { describe, expect, it } from "vitest";
import { createDestroyProgressFanout } from "../src/destroy-progress-fanout";

describe("destroy_progress fanout", () => {
  it("delivers an event to every subscriber", () => {
    const fanout = createDestroyProgressFanout();
    const events1: unknown[] = [];
    const events2: unknown[] = [];

    fanout.subscribe((e) => events1.push(e));
    fanout.subscribe((e) => events2.push(e));

    const event = { phase: "draining" as const, completed: 1, total: 2, totalProvisional: true };
    fanout.emit(event);

    expect(events1).toEqual([event]);
    expect(events2).toEqual([event]);
  });

  it("stops delivery after unsubscribe", () => {
    const fanout = createDestroyProgressFanout();
    const events: unknown[] = [];

    const unsubscribe = fanout.subscribe((e) => events.push(e));
    const event1 = { phase: "draining" as const, completed: 1, total: 2, totalProvisional: true };
    fanout.emit(event1);

    unsubscribe();

    const event2 = { phase: "terminating" as const, completed: 2, total: 2, totalProvisional: false };
    fanout.emit(event2);

    expect(events).toEqual([event1]);
  });

  it("continues delivery to other subscribers when one throws", () => {
    const fanout = createDestroyProgressFanout();
    const events2: unknown[] = [];
    const events3: unknown[] = [];

    fanout.subscribe((e) => {
      throw new Error("subscriber 1 error");
    });
    fanout.subscribe((e) => events2.push(e));
    fanout.subscribe((e) => events3.push(e));

    const event = { phase: "draining" as const, completed: 1, total: 2, totalProvisional: true };
    fanout.emit(event);

    expect(events2).toEqual([event]);
    expect(events3).toEqual([event]);
  });
});
