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
 * Frames own copied bytes before validation and admission. Drain remains
 * synchronous; deferred server ordering still needs execution/surface lifetime
 * pins and query/presentation barriers. Owning bytes alone does not provide it.
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
    let rc: number | void;
    try {
      rc = frame.run(entry.binding, () => {
        const mux = muxerFor(entry.binding);
        if (mux) mux.switchTo(entry.binding);
        return dispatch(entry.binding,0,frame.byteLength);
      });
    } catch {
      // Renderer failure is an I/O result, not an exception into kernel Wasm.
      return -5;
    } finally {
      queue.releaseIfEmpty(entry);
    }
    if (typeof rc === "number" && rc < 0) return rc;
  }
}
