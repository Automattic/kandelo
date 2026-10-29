/**
 * Buffered submit lanes for the multiplexer (plan 3 §B3).
 *
 * Compositor entries (`isCompositor(binding)` true) jump ahead of every
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

export interface SubmitExecutionOwner {
  readonly binding: GlBinding;
  readonly admitted: boolean;
  run<T>(work: () => T): T;
  release(): boolean;
}

const Bytes = Uint8Array;
const apply = Reflect.apply;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray,"buffer")!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray,"byteOffset")!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray,"byteLength")!.get!;
const setBytes = Uint8Array.prototype.set;

/** An owned command snapshot. Validation and dispatch inspect the same bytes,
 * never a guest view that can change after preflight or acknowledgement. */
export class SubmitFrame {
  #bytes: Uint8Array | null;
  #claimed = false;
  #running = false;
  #execution: SubmitExecutionOwner | null = null;
  readonly byteLength: number;
  constructor(source: Uint8Array, offset: number, length: number) {
    const size = apply(lengthOf,source,[]) as number;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || offset > size || length > size-offset) throw new RangeError("invalid GL submission span");
    const bytes = new Bytes(length);
    const input = new Bytes(apply(bufferOf,source,[]) as ArrayBufferLike,
      (apply(offsetOf,source,[]) as number)+offset,length);
    apply(setBytes,bytes,[input]);
    this.#bytes = bytes;
    this.byteLength = length;
  }
  validate(check: (bytes: Uint8Array, offset: number, length: number) => number): number {
    return this.#bytes ? check(this.#bytes,0,this.byteLength) : -5;
  }
  claim(): void {
    if (this.#claimed || !this.#bytes) throw new Error("GL submission already admitted");
    this.#claimed = true;
  }
  attachExecution(owner: SubmitExecutionOwner): void {
    if (this.#execution) throw new Error("GL submission already owns an execution");
    this.#execution = owner;
  }
  get consumed(): boolean { return this.#bytes === null && !this.#running; }
  retryCleanup(): boolean {
    if (this.#running) return false;
    if (!this.#execution) return true;
    if (!this.#execution.release()) return false;
    this.#execution = null;
    return true;
  }
  /** The temporary device view never becomes the binding's cached guest view.
   * A rebind/teardown during dispatch owns its replacement; do not revive the
   * old guest backing in finally. A consumed or failed frame cannot replay. */
  run<T>(binding: GlBinding, work: () => T): T {
    const bytes = this.#bytes;
    if (!bytes) throw new Error("GL submission already consumed");
    this.#bytes = null;
    this.#running = true;
    const previous = binding.cmdbufView;
    binding.cmdbufView = bytes;
    try {
      if (this.#execution && this.#execution.binding !== binding) throw new Error("GL execution identity mismatch");
      return this.#execution ? this.#execution.run(work) : work();
    } finally {
      if (binding.cmdbufView === bytes) binding.cmdbufView = previous;
      this.#running = false;
      this.retryCleanup();
    }
  }
  discard(): void { this.#bytes = null; this.retryCleanup(); }
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
  private ownedFrames = new Set<SubmitFrame>();

  /** Only the caller's exact binding authority selects the compositor lane.
   * Unclassified bindings remain ordinary FIFO clients. */
  constructor(
    private isCompositor: (binding: GlBinding) => boolean = () => false,
    private captureExecution?: (binding: GlBinding) => SubmitExecutionOwner | null,
  ) {}

  enqueue(binding: GlBinding, frame: SubmitFrame): void {
    frame.claim();
    // Reserve retry ownership before acquiring context/native storage holds.
    this.ownedFrames.add(frame);
    const key = `${binding.pid}:${binding.sessionId}:${binding.contextId ?? "_"}`;
    const existing = this.byKey.get(key);
    let entry: QueueEntry | undefined;
    let lane = this.clients;
    try {
      lane = this.isCompositor(binding) ? this.compositor : this.clients;
      if (this.captureExecution) {
        const execution = this.captureExecution(binding);
        if (!execution) throw new Error("GL execution capture failed");
        frame.attachExecution(execution);
        if (!execution.admitted) throw new Error("GL drawable capture failed");
      }
      if (existing) existing.frames.push(frame);
      else {
        entry = {key,binding,frames:[frame]};
        lane.push(entry);
        this.byKey.set(key,entry);
      }
    } catch (error) {
      frame.discard();
      this.complete(frame);
      if (entry) {
        const index = lane.indexOf(entry);
        if (index >= 0) lane.splice(index,1);
        this.byKey.delete(key);
      }
      throw error;
    }
  }

  /** Returns the next entry to drain (or null if empty). Caller shifts
   *  one frame off the returned entry then calls `releaseIfEmpty(entry)`
   *  to evict it once exhausted. Round-robin advance for the client lane
   *  happens here (head → tail) before the entry is returned, so the
   *  next pickNext lands on the next client even if this one still has
   *  frames buffered. */
  pickNext(): QueueEntry | null {
    this.retryRetirements();
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
    // Admission chose a lane using the exact binding's then-current file
    // authority. Cleanup must remove that owned entry even after handoff,
    // without consulting a changed classifier or retaining its guest view.
    const compositorIndex = this.compositor.indexOf(entry);
    if (compositorIndex >= 0) this.compositor.splice(compositorIndex, 1);
    const clientIndex = this.clients.indexOf(entry);
    if (clientIndex >= 0) this.clients.splice(clientIndex, 1);
  }

  /**
   * Purge every queued frame for an exiting process.
   *
   * The current drain is synchronous, but this backstop keeps a thrown decoder
   * or future deferred drain from retaining copied commands after the process
   * generation is gone. Frames never retain the original guest buffer.
   */
  removePid(pid: number): void { this.removeSession(pid); }

  removeSession(pid: number, sessionId?: number): void {
    if (sessionId !== undefined) sessionId >>>= 0;
    for (const [key, entry] of Array.from(this.byKey)) {
      if (entry.binding.pid !== pid || (sessionId !== undefined && entry.binding.sessionId !== sessionId)) continue;
      for (const frame of entry.frames) { frame.discard(); this.complete(frame); }
      entry.frames.length = 0;
      this.byKey.delete(key);
      const compositorIndex = this.compositor.indexOf(entry);
      if (compositorIndex >= 0) {
        this.compositor.splice(compositorIndex, 1);
      }
      const clientIndex = this.clients.indexOf(entry);
      if (clientIndex >= 0) this.clients.splice(clientIndex, 1);
    }
  }

  complete(frame: SubmitFrame): void {
    if (frame.consumed && frame.retryCleanup()) this.ownedFrames.delete(frame);
  }

  retryRetirements(): void {
    for (const frame of this.ownedFrames) this.complete(frame);
  }

  isEmpty(): boolean {
    return this.byKey.size === 0;
  }
}
