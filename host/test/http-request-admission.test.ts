import { afterEach, expect, test, vi } from "vitest";
import { HttpRequestAdmission } from "../src/networking/http-request-admission";

afterEach(() => vi.useRealTimers());

test("HTTP admission drains FIFO after exact-once release", async () => {
  const admission = new HttpRequestAdmission(2);
  const release = (await admission.acquire(1, 1000))!;
  const order: number[] = [];
  const first = admission.acquire(1, 1000).then(value => { order.push(1); return value!; });
  const second = admission.acquire(1, 1000).then(value => { order.push(2); return value!; });
  await expect(admission.acquire(1, 1000)).rejects.toThrow("queue is full");
  release();
  release();
  const releaseFirst = await first;
  expect(order).toEqual([1]);
  releaseFirst();
  (await second)();
  expect(order).toEqual([1, 2]);
});

test("expired HTTP waiters never acquire connection admission", async () => {
  vi.useFakeTimers();
  const admission = new HttpRequestAdmission();
  const release = (await admission.acquire(1, 100))!;
  const pending = admission.acquire(1, 10);
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toBeNull();
  release();
  (await admission.acquire(1, 100))!();
  expect(vi.getTimerCount()).toBe(0);
});

test("kernel failure rejects queued HTTP work without permitting later injection", async () => {
  vi.useFakeTimers();
  const admission = new HttpRequestAdmission();
  const release = (await admission.acquire(1, 100))!;
  const pending = admission.acquire(1, 100);
  const failure = new Error("kernel stopped");
  const refused = expect(pending).rejects.toBe(failure);
  admission.close(failure);
  release();
  await refused;
  await expect(admission.acquire(1, 100)).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

test("HTTP admission validates timer bounds and admits no zero-deadline work", async () => {
  const admission = new HttpRequestAdmission();
  for (const timeout of [NaN, Infinity, -1, 0x80000000]) {
    await expect(admission.acquire(1, timeout)).rejects.toThrow(RangeError);
  }
  await expect(admission.acquire(0, 100)).rejects.toThrow(RangeError);
  expect(await admission.acquire(1, 0)).toBeNull();
});
