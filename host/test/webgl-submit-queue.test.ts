import { describe, expect, it } from "vitest";
import {
  SubmitQueue,
  type SubmitFrame,
  type QueueEntry,
} from "../src/webgl/submit-queue.js";
import type { GlBinding } from "../src/webgl/registry.js";

function mkBinding(pid: number, contextId: number | null = null): GlBinding {
  return { pid, contextId } as unknown as GlBinding;
}

function mkFrame(tag = 0): SubmitFrame {
  return { memorySab: new SharedArrayBuffer(0), off: tag, len: 0 };
}

/** Mirror the drain side: take the head frame and release if exhausted. */
function drainOne(q: SubmitQueue): QueueEntry | null {
  const e = q.pickNext();
  if (!e) return null;
  e.frames.shift();
  q.releaseIfEmpty(e);
  return e;
}

describe("SubmitQueue", () => {
  it("compositor pid jumps ahead of clients enqueued earlier", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10), mkFrame());
    q.enqueue(mkBinding(11), mkFrame());
    q.enqueue(mkBinding(2), mkFrame());
    expect(q.pickNext()?.binding.pid).toBe(2);
  });

  it("drains compositor first, then clients in enqueue order", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10), mkFrame());
    q.enqueue(mkBinding(2), mkFrame());
    q.enqueue(mkBinding(11), mkFrame());

    expect(drainOne(q)?.binding.pid).toBe(2);
    expect(drainOne(q)?.binding.pid).toBe(10);
    expect(drainOne(q)?.binding.pid).toBe(11);
    expect(q.pickNext()).toBeNull();
    expect(q.isEmpty()).toBe(true);
  });

  it("round-robins among clients when each carries multiple frames", () => {
    const q = new SubmitQueue();
    const a = mkBinding(10);
    const b = mkBinding(11);
    const c = mkBinding(12);
    q.enqueue(a, mkFrame(1));
    q.enqueue(a, mkFrame(2));
    q.enqueue(b, mkFrame(3));
    q.enqueue(b, mkFrame(4));
    q.enqueue(c, mkFrame(5));
    q.enqueue(c, mkFrame(6));

    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const e = drainOne(q);
      if (e) seen.push(e.binding.pid);
    }
    expect(seen).toEqual([10, 11, 12, 10, 11, 12]);
    expect(q.isEmpty()).toBe(true);
  });

  it("multiple frames for the same (pid, ctx) coalesce into one entry", () => {
    const q = new SubmitQueue();
    const a = mkBinding(10, 7);
    q.enqueue(a, mkFrame(1));
    q.enqueue(a, mkFrame(2));
    q.enqueue(a, mkFrame(3));

    const e = q.pickNext();
    expect(e?.frames.length).toBe(3);
    expect(e?.frames.map((f) => f.off)).toEqual([1, 2, 3]);
  });

  it("same pid with different contextId produces two distinct entries", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10, 1), mkFrame(1));
    q.enqueue(mkBinding(10, 2), mkFrame(2));

    const e1 = drainOne(q);
    const e2 = drainOne(q);
    expect([e1?.binding.contextId, e2?.binding.contextId].sort()).toEqual([1, 2]);
    expect(q.isEmpty()).toBe(true);
  });

  it("releaseIfEmpty is a no-op when the entry still has frames", () => {
    const q = new SubmitQueue();
    const a = mkBinding(10);
    q.enqueue(a, mkFrame(1));
    q.enqueue(a, mkFrame(2));

    const e = q.pickNext()!;
    e.frames.shift();
    q.releaseIfEmpty(e);
    expect(q.isEmpty()).toBe(false);

    const e2 = q.pickNext();
    expect(e2).toBe(e);
    expect(e2!.frames.length).toBe(1);
  });

  it("releaseIfEmpty drops empty entries from byKey and the lane", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10), mkFrame());
    drainOne(q);
    expect(q.isEmpty()).toBe(true);
    expect(q.pickNext()).toBeNull();
  });

  it("pickNext on empty queue returns null and leaves isEmpty true", () => {
    const q = new SubmitQueue();
    expect(q.pickNext()).toBeNull();
    expect(q.isEmpty()).toBe(true);
  });

  it("isCompositor predicate override routes the chosen pid to the compositor lane", () => {
    const q = new SubmitQueue((pid) => pid === 99);
    q.enqueue(mkBinding(2), mkFrame());
    q.enqueue(mkBinding(10), mkFrame());
    q.enqueue(mkBinding(99), mkFrame());
    expect(q.pickNext()?.binding.pid).toBe(99);
  });

  it("compositor with multiple frames stays at the head until drained", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(2), mkFrame(1));
    q.enqueue(mkBinding(2), mkFrame(2));
    q.enqueue(mkBinding(10), mkFrame(3));

    expect(drainOne(q)?.binding.pid).toBe(2);
    expect(drainOne(q)?.binding.pid).toBe(2);
    expect(drainOne(q)?.binding.pid).toBe(10);
    expect(q.isEmpty()).toBe(true);
  });

  it("re-enqueuing after release creates a fresh entry at the tail", () => {
    const q = new SubmitQueue();
    const a = mkBinding(10);
    const b = mkBinding(11);
    q.enqueue(a, mkFrame(1));
    q.enqueue(b, mkFrame(2));

    drainOne(q); // pid=10 drained + released
    q.enqueue(a, mkFrame(3));

    expect(drainOne(q)?.binding.pid).toBe(11);
    expect(drainOne(q)?.binding.pid).toBe(10);
    expect(q.isEmpty()).toBe(true);
  });
});
