/**
 * Queue-aware drain step that pairs `SubmitQueue.pickNext` with a muxer
 * `switchTo` and the TLV dispatcher (plan 3 §B4).
 *
 * The caller passes a `muxerFor(binding)` factory so the worker-side
 * kernel can hand out one muxer per `WebGL2RenderingContext` (shared
 * across pids that attach the same canvas) while tests can stub the
 * call-count side. `muxerFor` returns `null` when the binding has no
 * live context yet (pre-canvas-attach) — drain still dispatches via the
 * provided `dispatch` callback so the queue empties cleanly; the
 * dispatcher itself bails when `b.gl` is null.
 *
 * Drain is synchronous on purpose: the centralized-kernel model has the
 * C process blocked on its `host_gl_submit` syscall for the duration of
 * this call, so the SAB-backed cmdbuf bytes referenced by
 * `(off, len)` cannot be overwritten between enqueue and drain. A
 * microtask defer would race the C side as soon as the kernel
 * acknowledges the syscall.
 */
import type { GlBinding } from "./registry.js";
import type { GlMuxer } from "./muxer.js";
import type { SubmitQueue } from "./submit-queue.js";

export type GlMuxerFor = (b: GlBinding) => GlMuxer | null;
export type GlDispatch = (b: GlBinding, off: number, len: number) => number | void;

export function drainSubmitQueue(
  queue: SubmitQueue,
  muxerFor: GlMuxerFor,
  dispatch: GlDispatch,
): number {
  while (true) {
    const entry = queue.pickNext();
    if (!entry) return 0;
    const frame = entry.frames.shift()!;
    const mux = muxerFor(entry.binding);
    if (mux) mux.switchTo(entry.binding);
    const rc = dispatch(entry.binding, frame.off, frame.len);
    queue.releaseIfEmpty(entry);
    if (typeof rc === "number" && rc < 0) return rc;
  }
}
