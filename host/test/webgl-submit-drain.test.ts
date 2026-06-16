import { describe, expect, it, vi } from "vitest";
import {
  drainSubmitQueue,
  type GlDispatch,
  type GlMuxerFor,
} from "../src/webgl/submit-drain.js";
import {
  SubmitQueue,
  type SubmitFrame,
} from "../src/webgl/submit-queue.js";
import type { GlBinding } from "../src/webgl/registry.js";
import type { GlMuxer } from "../src/webgl/muxer.js";

function mkBinding(pid: number, gl: object | null = {}): GlBinding {
  return { pid, contextId: null, gl } as unknown as GlBinding;
}

function mkFrame(tag: number): SubmitFrame {
  return { memorySab: new SharedArrayBuffer(0), off: tag, len: 1 };
}

interface FakeMuxer {
  switchTo: ReturnType<typeof vi.fn>;
}

function fakeMuxer(): FakeMuxer {
  return { switchTo: vi.fn() };
}

describe("drainSubmitQueue", () => {
  it("drives switchTo once per distinct binding then dispatches each frame", () => {
    const q = new SubmitQueue();
    const a = mkBinding(10);
    const b = mkBinding(11);
    q.enqueue(a, mkFrame(1));
    q.enqueue(a, mkFrame(2));
    q.enqueue(b, mkFrame(3));
    q.enqueue(b, mkFrame(4));

    const mux = fakeMuxer();
    const dispatch = vi.fn<GlDispatch>();
    const muxerFor: GlMuxerFor = () => mux as unknown as GlMuxer;

    drainSubmitQueue(q, muxerFor, dispatch);

    const switchTargets = mux.switchTo.mock.calls.map((c) => (c[0] as GlBinding).pid);
    expect(switchTargets).toEqual([10, 11, 10, 11]);
    const dispatchOrder = dispatch.mock.calls.map(
      (c) => [(c[0] as GlBinding).pid, c[1] as number],
    );
    expect(dispatchOrder).toEqual([[10, 1], [11, 3], [10, 2], [11, 4]]);
    expect(q.isEmpty()).toBe(true);
  });

  it("compositor pid drains before clients regardless of enqueue order", () => {
    const q = new SubmitQueue();
    const client = mkBinding(10);
    const comp = mkBinding(2);
    q.enqueue(client, mkFrame(1));
    q.enqueue(comp, mkFrame(2));

    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);

    expect(dispatch.mock.calls.map((c) => (c[0] as GlBinding).pid)).toEqual([2, 10]);
  });

  it("skips switchTo when muxerFor returns null", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10, null), mkFrame(1));

    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("still dispatches when binding has a gl but muxerFor returns null", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10), mkFrame(7));

    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);

    expect(dispatch.mock.calls).toEqual([[expect.objectContaining({ pid: 10 }), 7, 1]]);
  });

  it("each binding gets its own muxer when they hold distinct gl contexts", () => {
    const q = new SubmitQueue();
    const glA = {};
    const glB = {};
    const ba = mkBinding(10, glA);
    const bb = mkBinding(11, glB);
    q.enqueue(ba, mkFrame(1));
    q.enqueue(bb, mkFrame(2));

    const muxA = fakeMuxer();
    const muxB = fakeMuxer();
    const muxerFor: GlMuxerFor = (b) => {
      if (b.gl === glA) return muxA as unknown as GlMuxer;
      if (b.gl === glB) return muxB as unknown as GlMuxer;
      return null;
    };

    drainSubmitQueue(q, muxerFor, vi.fn<GlDispatch>());
    expect(muxA.switchTo).toHaveBeenCalledTimes(1);
    expect(muxB.switchTo).toHaveBeenCalledTimes(1);
  });

  it("returns immediately on an empty queue", () => {
    const q = new SubmitQueue();
    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("releaseIfEmpty drops entries promptly so isEmpty flips after the last frame", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10), mkFrame(1));
    drainSubmitQueue(q, () => null, vi.fn<GlDispatch>());
    expect(q.isEmpty()).toBe(true);
  });

  it("returns the first dispatch error and leaves later frames queued", () => {
    const q = new SubmitQueue();
    q.enqueue(mkBinding(10), mkFrame(1));
    q.enqueue(mkBinding(11), mkFrame(2));

    const dispatch = vi.fn<GlDispatch>().mockReturnValueOnce(-22);
    const rc = drainSubmitQueue(q, () => null, dispatch);

    expect(rc).toBe(-22);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(q.isEmpty()).toBe(false);
  });
});
