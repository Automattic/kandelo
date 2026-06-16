/**
 * Buffered submit lanes for the multiplexer (plan 3 §B3).
 *
 * Compositor entries (`isCompositor(pid)` true) jump ahead of every
 * client; clients FIFO-rotate between drains so a chatty client cannot
 * starve a slow peer. A never-emptying compositor will starve clients —
 * acceptable for v2 (the compositor is well-behaved by construction);
 * v3 may add a watchdog or token-bucket.
 *
 * Eviction is driven by the caller: drain pops the head frame, then
 * calls `releaseIfEmpty` so the now-exhausted entry drops out of its
 * lane and `byKey` promptly instead of lingering until the next rotation
 * cycles it back to the head.
 */
import type { GlBinding } from "./registry.js";

export interface SubmitFrame {
  /** The backing buffer of the binding's `cmdbufView` at enqueue time.
   *  Kept on the frame so async-drain variants (deferred to a later
   *  iteration) have a stable reference even if the binding's view is
   *  rebound by `Memory.grow()`. The sync drain in §B4 doesn't read this
   *  — it goes through `binding.cmdbufView` directly. Typed as
   *  `ArrayBufferLike` so Node (non-shared) and browser (SAB) both fit. */
  memorySab: ArrayBufferLike;
  off: number;
  len: number;
}

export interface QueueEntry {
  key: string;
  binding: GlBinding;
  frames: SubmitFrame[];
}

export class SubmitQueue {
  private compositor: QueueEntry[] = [];
  private clients: QueueEntry[] = [];
  private byKey = new Map<string, QueueEntry>();

  /** Default predicate keeps the queue's unit tests independent of a
   *  KmsRegistry. Production wires `(pid) => kms.isMasterPid(pid)` so
   *  the compositor lane tracks DRM_MASTER. */
  constructor(
    private isCompositor: (pid: number) => boolean = (pid) => pid === 2,
  ) {}

  enqueue(binding: GlBinding, frame: SubmitFrame): void {
    const key = `${binding.pid}:${binding.contextId ?? "_"}`;
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { key, binding, frames: [] };
      this.byKey.set(key, entry);
      (this.isCompositor(binding.pid) ? this.compositor : this.clients).push(entry);
    }
    entry.frames.push(frame);
  }

  /** Returns the next entry to drain (or null if empty). Caller shifts
   *  one frame off the returned entry then calls `releaseIfEmpty(entry)`
   *  to evict it once exhausted. Round-robin advance for the client lane
   *  happens here (head → tail) before the entry is returned, so the
   *  next pickNext lands on the next client even if this one still has
   *  frames buffered. */
  pickNext(): QueueEntry | null {
    while (this.compositor.length > 0) {
      const e = this.compositor[0];
      if (e.frames.length > 0) return e;
      this.compositor.shift();
      this.byKey.delete(e.key);
    }
    while (this.clients.length > 0) {
      const e = this.clients[0];
      if (e.frames.length > 0) {
        this.clients.shift();
        this.clients.push(e);
        return e;
      }
      this.clients.shift();
      this.byKey.delete(e.key);
    }
    return null;
  }

  releaseIfEmpty(entry: QueueEntry): void {
    if (entry.frames.length > 0) return;
    this.byKey.delete(entry.key);
    const lane = this.isCompositor(entry.binding.pid) ? this.compositor : this.clients;
    const i = lane.indexOf(entry);
    if (i >= 0) lane.splice(i, 1);
  }

  isEmpty(): boolean {
    return this.byKey.size === 0;
  }
}
