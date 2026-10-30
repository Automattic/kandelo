import { describe, expect, it, vi } from "vitest";
import {
  drainSubmitQueue,
  type GlDispatch,
  type GlMuxerFor,
} from "../src/webgl/submit-drain.js";
import {
  SubmitQueue,
  SubmitFrame,
} from "../src/webgl/submit-queue.js";
import type { GlBinding } from "../src/webgl/registry.js";
import type { GlMuxer } from "../src/webgl/muxer.js";

function mkBinding(pid: number, gl: object | null = {}): GlBinding {
  return { pid, contextId: null, gl } as unknown as GlBinding;
}

function mkFrame(tag: number): SubmitFrame {
  return new SubmitFrame(new Uint8Array([tag]),0,1);
}

interface FakeMuxer {
  switchTo: ReturnType<typeof vi.fn>;
}

function fakeMuxer(): FakeMuxer {
  return { switchTo: vi.fn() };
}

describe("drainSubmitQueue", () => {
  it.each(["switch", "dispatch"])("contains a failing renderer during %s without retaining its consumed frame", stage => {
    const q = new SubmitQueue(binding => binding.pid === 2);
    const binding = mkBinding(10);
    q.enqueue(binding, mkFrame(1));
    const fail = () => { throw new Error("renderer failed"); };
    const dispatch = vi.fn<GlDispatch>(stage === "dispatch" ? fail : () => 0);
    const muxer = { switchTo: stage === "switch" ? fail : () => {} } as unknown as GlMuxer;
    expect(drainSubmitQueue(q, () => muxer, dispatch)).toBe(-5);
    expect(dispatch).toHaveBeenCalledTimes(stage === "switch" ? 0 : 1);
    expect(q.isEmpty()).toBe(true);
    q.enqueue(binding, mkFrame(2));
    const retry = vi.fn<GlDispatch>();
    expect(drainSubmitQueue(q, () => null, retry)).toBe(0);
    expect(retry).toHaveBeenCalledWith(binding, 0, 1);
  });

  it("drives switchTo once per distinct binding then dispatches each frame", () => {
    const q = new SubmitQueue(binding => binding.pid === 2);
    const a = mkBinding(10);
    const b = mkBinding(11);
    q.enqueue(a, mkFrame(1));
    q.enqueue(a, mkFrame(2));
    q.enqueue(b, mkFrame(3));
    q.enqueue(b, mkFrame(4));

    const mux = fakeMuxer();
    const packets: Array<[number,number]> = [];
    const dispatch = vi.fn<GlDispatch>(binding=>{packets.push([binding.pid,binding.cmdbufView![0]]);});
    const muxerFor: GlMuxerFor = () => mux as unknown as GlMuxer;

    drainSubmitQueue(q, muxerFor, dispatch);

    const switchTargets = mux.switchTo.mock.calls.map((c) => (c[0] as GlBinding).pid);
    expect(switchTargets).toEqual([10, 11, 10, 11]);
    const dispatchOrder = dispatch.mock.calls.map(
      (c) => [(c[0] as GlBinding).pid, c[1] as number],
    );
    expect(dispatchOrder).toEqual([[10, 0], [11, 0], [10, 0], [11, 0]]);
    expect(packets).toEqual([[10,1],[11,3],[10,2],[11,4]]);
    expect(q.isEmpty()).toBe(true);
  });

  it("compositor pid drains before clients regardless of enqueue order", () => {
    const q = new SubmitQueue(binding => binding.pid === 2);
    const client = mkBinding(10);
    const comp = mkBinding(2);
    q.enqueue(client, mkFrame(1));
    q.enqueue(comp, mkFrame(2));

    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);

    expect(dispatch.mock.calls.map((c) => (c[0] as GlBinding).pid)).toEqual([2, 10]);
  });

  it("skips switchTo when muxerFor returns null", () => {
    const q = new SubmitQueue(binding => binding.pid === 2);
    q.enqueue(mkBinding(10, null), mkFrame(1));

    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("still dispatches when binding has a gl but muxerFor returns null", () => {
    const q = new SubmitQueue(binding => binding.pid === 2);
    q.enqueue(mkBinding(10), mkFrame(7));

    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);

    expect(dispatch.mock.calls).toEqual([[expect.objectContaining({ pid: 10 }), 0, 1]]);
  });

  it("each binding gets its own muxer when they hold distinct gl contexts", () => {
    const q = new SubmitQueue(binding => binding.pid === 2);
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
    const q = new SubmitQueue(binding => binding.pid === 2);
    const dispatch = vi.fn<GlDispatch>();
    drainSubmitQueue(q, () => null, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("releaseIfEmpty drops entries promptly so isEmpty flips after the last frame", () => {
    const q = new SubmitQueue(binding => binding.pid === 2);
    q.enqueue(mkBinding(10), mkFrame(1));
    drainSubmitQueue(q, () => null, vi.fn<GlDispatch>());
    expect(q.isEmpty()).toBe(true);
  });

  it("returns the first dispatch error and leaves later frames queued", () => {
    const q = new SubmitQueue(binding => binding.pid === 2);
    q.enqueue(mkBinding(10), mkFrame(1));
    q.enqueue(mkBinding(11), mkFrame(2));

    const dispatch = vi.fn<GlDispatch>().mockReturnValueOnce(-22);
    const rc = drainSubmitQueue(q, () => null, dispatch);

    expect(rc).toBe(-22);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(q.isEmpty()).toBe(false);
  });
});

it.each(["success","error","throw"])("restores the borrowed view and consumes the snapshot after %s", outcome => {
  const q=new SubmitQueue(binding => binding.pid === 2),binding=mkBinding(10),borrowed=new Uint8Array([99]);binding.cmdbufView=borrowed;
  const frame=mkFrame(7);q.enqueue(binding,frame);
  const rc=drainSubmitQueue(q,()=>null,(current,offset,length)=>{
    expect(current.cmdbufView).not.toBe(borrowed);expect([...current.cmdbufView!]).toEqual([7]);
    expect([offset,length]).toEqual([0,1]);
    if(outcome==="throw")throw new Error("accepted prefix failed");
    return outcome==="error"?-22:0;
  });
  expect(rc).toBe(outcome==="throw"?-5:outcome==="error"?-22:0);
  expect(binding.cmdbufView).toBe(borrowed);
  expect(frame.validate(()=>0)).toBe(-5);
  expect(()=>frame.run(binding,()=>0)).toThrow("already consumed");
  expect(q.isEmpty()).toBe(true);
});
it.each([null,new Uint8Array([42])])("does not resurrect a retired or rebound guest view", replacement => {
  const q=new SubmitQueue(binding => binding.pid === 2),binding=mkBinding(10);binding.cmdbufView=new Uint8Array([99]);
  q.enqueue(binding,mkFrame(7));
  expect(drainSubmitQueue(q,()=>null,current=>{current.cmdbufView=replacement;return 0;})).toBe(0);
  expect(binding.cmdbufView).toBe(replacement);
});
