import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerAbsence, DeferredWorkerHandle } from "../src/deferred-worker-handle";
import { MockWorkerAdapter } from "../src/worker-adapter";

import {
  createWorkerQuiescence,
  retireWorkerBatch,
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

describe("terminal worker batch retirement", () => {
  const workers = (count: number) => Array.from({ length: count }, () => ({
    fence: createWorkerQuiescence(),
    stopped: false,
    released: false,
  }));

  it("overlaps eleven acknowledged settle intervals without releasing metadata early", async () => {
    vi.useFakeTimers();
    const batch = workers(11);
    for (const worker of batch) worker.fence.settle();
    const terminate = vi.fn(async (worker: typeof batch[number]) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      worker.stopped = true;
    });
    const retirement = retireWorkerBatch({
      workers: batch,
      mayRetireTogether: true,
      retirementProven: (worker) => worker.fence.settled,
      terminate,
      release: (worker) => {
        expect(worker.stopped).toBe(true);
        worker.released = true;
      },
    });
    expect(terminate).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(249);
    expect(batch.some((worker) => worker.released)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(retirement).resolves.toBe(true);
    expect(batch.every((worker) => worker.released)).toBe(true);
  });

  it.each(["thread", "main"])("keeps containment serial without the %s fence", async (missing) => {
    vi.useFakeTimers();
    const batch = workers(2);
    if (missing === "main") for (const worker of batch) worker.fence.settle();
    const terminate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const retirement = retireWorkerBatch({
      workers: batch,
      mayRetireTogether: missing !== "main",
      retirementProven: (worker) => worker.fence.settled,
      terminate,
      release: () => {},
    });
    expect(terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(terminate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    await expect(retirement).resolves.toBe(missing === "main");
  });

  it("accepts a late real acknowledgement and never manufactures one", async () => {
    const batch = workers(2);
    const retirement = retireWorkerBatch({
      workers: batch,
      mayRetireTogether: false,
      retirementProven: (worker) => worker.fence.settled,
      terminate: async (worker) => { worker.fence.settle(); },
      release: () => {},
    });
    await expect(retirement).resolves.toBe(true);
  });

  it("waits for remaining retirements after an independent termination fails", async () => {
    const batch = workers(2);
    for (const worker of batch) worker.fence.settle();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const failure = new Error("worker did not terminate");
    const released: unknown[] = [];
    const retirement = retireWorkerBatch({
      workers: batch,
      mayRetireTogether: true,
      retirementProven: (worker) => worker.fence.settled,
      terminate: (worker) => worker === batch[0] ? Promise.reject(failure) : blocked,
      release: (worker) => { released.push(worker); },
    });
    const rejected = expect(retirement).rejects.toBe(failure);
    await Promise.resolve();
    expect(released).toEqual([]);
    finish();
    await rejected;
    expect(released).toEqual([batch[1]]);
  });
});


it("batches sealed absence with an ACK without manufacturing either fence", async () => {
  const never = new DeferredWorkerHandle(() => { throw Error("must not construct"); });
  const absent = createWorkerAbsence(never, () => {});
  const ack = createWorkerQuiescence(), none = createWorkerQuiescence();
  ack.settle(); expect(absent.seal()).toBe(true);
  const batch = [{ fence: ack, absent: false }, { fence: none, absent: absent.proven }];
  const terminate = vi.fn(async () => {});
  await expect(retireWorkerBatch({ workers: batch, mayRetireTogether: true,
    retirementProven: worker => worker.absent || worker.fence.settled,
    terminate, release: () => {},
  })).resolves.toBe(true);
  expect(terminate).toHaveBeenCalledTimes(2);
  expect(none.settled).toBe(false);
  expect(never.start()).toBe(false);
});

it.each(["attempted", "started", "unknown"] as const)(
  "a %s realm without an ACK keeps serial containment and missing proof", async mode => {
    const backing = new MockWorkerAdapter().createWorker({});
    const handle = mode === "unknown" ? backing : new DeferredWorkerHandle(() => {
      if (mode === "attempted") throw Error("unknown construction outcome");
      return backing;
    });
    if (handle instanceof DeferredWorkerHandle) {
      if (mode === "attempted") expect(() => handle.start()).toThrow("unknown construction");
      else handle.start();
    }
    await handle.terminate();
    const absent = createWorkerAbsence(handle, () => { throw Error("false absence"); });
    expect(absent.seal()).toBe(false);
    const fence = createWorkerQuiescence();
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const stop = vi.fn(async (index: number) => { if (index === 0) await blocked; });
    const result = retireWorkerBatch({ workers: [0, 1], mayRetireTogether: true,
      retirementProven: () => absent.proven || fence.settled,
      terminate: stop, release: () => {},
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith(0);
    unblock(); await expect(result).resolves.toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(fence.settled).toBe(false);
  },
);
