import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkerQuiescence,
  runWithProcessWorkerQuiescence,
  waitForExecRetirement,
  waitForWorkerQuiescence,
} from "../src/worker-quiescence";

afterEach(() => {
  vi.useRealTimers();
});

describe("exact process Worker quiescence fences", () => {
  it("publishes the exact terminal identity before closing the realm", async () => {
    const events: unknown[] = [];
    await runWithProcessWorkerQuiescence(
      {
        postMessage: (message) => events.push(message),
        close: () => events.push("close"),
      },
      { pid: 41, tid: 43 },
      async () => {
        events.push("worker-main returned");
      },
      (error) => events.push(error),
    );

    expect(events).toEqual([
      "worker-main returned",
      { type: "memory_quiescent", pid: 41, tid: 43 },
      "close",
    ]);
  });

  it("still fences and closes after worker-main rejects", async () => {
    const events: unknown[] = [];
    const failure = new Error("trap");
    await runWithProcessWorkerQuiescence(
      {
        postMessage: (message) => events.push(message),
        close: () => events.push("close"),
      },
      { pid: 41 },
      async () => {
        throw failure;
      },
      (error) => events.push(error),
    );

    expect(events).toEqual([
      failure,
      { type: "memory_quiescent", pid: 41 },
      "close",
    ]);
  });

  it("settles one terminal ownership fence idempotently", async () => {
    const quiescence = createWorkerQuiescence();
    expect(quiescence.settled).toBe(false);

    const waiting = waitForWorkerQuiescence(quiescence, 1_000);
    quiescence.settle();
    quiescence.settle();

    await expect(waiting).resolves.toBe(true);
    expect(quiescence.settled).toBe(true);
  });

  it("bounds a missing terminal message without treating timeout as proof", async () => {
    vi.useFakeTimers();
    const quiescence = createWorkerQuiescence();
    const waiting = waitForWorkerQuiescence(quiescence, 25);

    await vi.advanceTimersByTimeAsync(25);

    await expect(waiting).resolves.toBe(false);
    expect(quiescence.settled).toBe(false);
  });

  it("requires both exec retirement and final memory quiescence", async () => {
    vi.useFakeTimers();
    const retirement = createWorkerQuiescence();
    const quiescence = createWorkerQuiescence();
    const incomplete = waitForExecRetirement(
      retirement,
      quiescence,
      25,
    );
    retirement.settle();

    await vi.advanceTimersByTimeAsync(25);
    await expect(incomplete).resolves.toBe(false);

    const complete = waitForExecRetirement(
      retirement,
      quiescence,
      25,
    );
    quiescence.settle();
    await expect(complete).resolves.toBe(true);
  });
});
