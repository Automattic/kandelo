import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpareWorkerPool } from "../src/spare-worker-pool";

interface FakeWorker {
  id: number;
  fail: () => void;
  discarded: boolean;
}

function fakePool(size = 2, options: { throwOn?: number } = {}) {
  const started: FakeWorker[] = [];
  const pool = new SpareWorkerPool<FakeWorker>(
    size,
    (failed) => {
      if (started.length + 1 === options.throwOn) {
        throw new Error("Worker constructor failed");
      }
      const worker = { id: started.length + 1, fail: failed, discarded: false };
      started.push(worker);
      return worker;
    },
    (worker) => { worker.discarded = true; },
  );
  return { pool, started };
}

describe("SpareWorkerPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts no spare before the first take", () => {
    const { pool, started } = fakePool();
    expect(pool.take()).toBeUndefined();
    expect(started).toEqual([]);
  });

  it("refills to its size on a later task and hands spares out in start order", () => {
    const { pool, started } = fakePool();
    pool.take();
    expect(started).toHaveLength(0);
    vi.runAllTimers();
    expect(started.map((worker) => worker.id)).toEqual([1, 2]);

    expect(pool.take()?.id).toBe(1);
    expect(started).toHaveLength(2);
    vi.runAllTimers();
    expect(started).toHaveLength(3);
    expect(pool.take()?.id).toBe(2);
    expect(pool.take()?.id).toBe(3);
  });

  it("discards a spare that failed before a launch took it", () => {
    const { pool, started } = fakePool();
    pool.take();
    vi.runAllTimers();
    started[0].fail();

    expect(pool.take()?.id).toBe(2);
    expect(started[0].discarded).toBe(true);
    expect(started[1].discarded).toBe(false);
  });

  it("returns nothing when every spare failed", () => {
    const { pool, started } = fakePool();
    pool.take();
    vi.runAllTimers();
    for (const worker of started) worker.fail();

    expect(pool.take()).toBeUndefined();
    expect(started.every((worker) => worker.discarded)).toBe(true);
  });

  it("stays short when a Worker constructor throws", () => {
    const { pool, started } = fakePool(2, { throwOn: 2 });
    pool.take();
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(started.map((worker) => worker.id)).toEqual([1]);
    expect(pool.take()?.id).toBe(1);
  });

  it("terminates its spares on dispose and starts no more", () => {
    const { pool, started } = fakePool();
    pool.take();
    vi.runAllTimers();
    pool.dispose();

    expect(started.every((worker) => worker.discarded)).toBe(true);
    expect(pool.take()).toBeUndefined();
    vi.runAllTimers();
    expect(started).toHaveLength(2);
  });

  it("cancels a scheduled refill on dispose", () => {
    const { pool, started } = fakePool();
    pool.take();
    pool.dispose();
    vi.runAllTimers();
    expect(started).toEqual([]);
  });
});
