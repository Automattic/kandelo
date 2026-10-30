import type { GlOperationStream } from "./operation-stream.js";
import { captureNativeGlErrors, type GlErrorState } from "./errors.js";
import { checkedGlCall, type CheckedGlOwner } from "./program-objects.js";
import {
  reserveNativeRetirement, repairNativeState, retireNativeRetirement,
  type NativeRetirement,
} from "./native-recovery.js";

type Fence = {
  token: number;
  owner: CheckedGlOwner;
  deletion: ["deleteSync", WebGLSync | null];
  retirement: NativeRetirement;
  published: boolean;
  destroyed: boolean;
  references: number;
};

/** A prepared fence is private until its reply has been accepted. */
export class GlFenceCandidate {
  constructor(private store: GlFenceOwner, private fence: Fence) {}
  get token(): number { return this.fence.token; }
  get context(): WebGL2RenderingContext { return this.fence.owner.gl!; }
  publish(): boolean { return this.store.publish(this.fence); }
  cancel(): void { this.store.cancel(this.fence); }
  /** A deferred result retains this candidate until native deletion completes.
   * Its caller captures the selected renderer's errors before retrying. */
  cancelRetirement(): boolean {
    if (this.fence.published) return true;
    this.store.cancel(this.fence);
    return retireNativeRetirement(this.fence.retirement);
  }
}

export type GlFenceSource = Readonly<{pid:number;sessionId:number;operations:GlOperationStream}>;

/** A waiter owns this lease independently of the public handle and creator.
 * It contains native/scalar ownership only, never a guest binding or memory. */
const fenceLeaseMint = Symbol("retained GL fence lease");
export class GlFenceLease {
  private released = false;
  constructor(private store: GlFenceOwner, private fence: Fence, authority: typeof fenceLeaseMint) {
    if (authority !== fenceLeaseMint) throw new Error("GL fence lease requires native owner authority");
  }
  get context(): WebGL2RenderingContext { return this.fence.owner.gl!; }
  get token(): number { return this.fence.token; }
  matchesSource(source: GlFenceSource): boolean {
    return !this.released && this.store.matchesSource(source);
  }
  /** Remove precisely the captured public fence, even after creator retirement.
   * Our reference keeps its native handle alive until subsequent retirement. */
  publishRelease(): boolean {
    return !this.released && this.store.destroyCaptured(this.fence);
  }
  releaseRetirement(): boolean {
    if (!this.released) {
      this.released = true;
      return this.store.release(this.fence);
    }
    return this.store.retryRetirement(this.fence);
  }
  poll(currentErrors: GlErrorState | null): boolean | null {
    if (this.released) return null;
    const gl = this.fence.owner.gl!;
    try {
      // The caller supplies the selected owner's flags (or captures them via
      // its muxer first). Internal fence failures are not guest GL errors.
      captureNativeGlErrors(gl, currentErrors);
      if (!repairNativeState(gl) || gl.isContextLost()) return null;
      let status: unknown;
      if (!checkedGlCall(this.fence.owner, () => {
        status = gl.getSyncParameter(this.fence.deletion[1]!, 0x9114);
      })) return null;
      if (status === 0x9119) return true; // SIGNALED
      if (status === 0x9118) return false; // UNSIGNALED
    } catch { /* No successful completion was observed. */ }
    return null;
  }
  release(): void {
    if (this.released) return;
    this.releaseRetirement();
  }
}

/** Display sync records can retain leases after an EGL context is destroyed.
 * A session owns publication authority; native lifetime is reference-counted
 * separately. Reusing a context in that session never reuses a fence token.
 * Before cancellation/destruction/release/close can retire a native handle,
 * its caller must capture the selected physical context's errors through its
 * muxer. Kernel and main-forward unbind do this even after context retirement.
 * No muxer or error-capture callback is retained by these ownership records. */
export class GlFenceOwner {
  private fences = new Map<number, Fence>();
  private serial = 0;
  private closed = false;
  private source: GlFenceSource | null;
  constructor(source?: GlFenceSource) {
    this.source = source ? Object.freeze({pid:source.pid,sessionId:source.sessionId,operations:source.operations}) : null;
  }
  matchesSource(source: GlFenceSource): boolean {
    return !!this.source && this.source.pid === source.pid && this.source.sessionId === source.sessionId
      && this.source.operations === source.operations;
  }

  prepare(source: CheckedGlOwner, requestToken?: number): GlFenceCandidate | null {
    this.pruneCompleted();
    const gl = source.gl;
    const token = requestToken ?? this.serial + 1;
    if (this.closed || !gl || !Number.isInteger(token) || token <= this.serial || token > 0xffff_ffff) return null;
    let fence: Fence | undefined;
    let retirement: NativeRetirement | null = null;
    try {
      captureNativeGlErrors(gl, source);
      if (!repairNativeState(gl) || gl.isContextLost()) return null;
      // Allocate publication and cleanup records before native allocation.
      // Retirements preserve just native handles and private error flags.
      const owner = { gl, errors: [] as number[] };
      const deletion: ["deleteSync", WebGLSync | null] = ["deleteSync", null];
      retirement = reserveNativeRetirement(owner, [deletion]);
      if (!retirement) return null;
      this.serial = token;
      fence = { token, owner, deletion, retirement,
        published: false, destroyed: false, references: 0 };
      const candidate = new GlFenceCandidate(this, fence);
      this.fences.set(fence.token, fence);
      const accepted = checkedGlCall(owner, () => {
        deletion[1] = gl.fenceSync(0x9117, 0); // SYNC_GPU_COMMANDS_COMPLETE
      });
      if (!accepted || !deletion[1]) { this.cancel(fence); return null; }
      return candidate;
    } catch {
      if (fence) this.cancel(fence);
      else if (retirement) retireNativeRetirement(retirement);
      return null;
    }
  }

  publish(fence: Fence): boolean {
    if (this.closed || fence.destroyed || this.fences.get(fence.token) !== fence) return false;
    fence.published = true;
    return true;
  }
  cancel(fence: Fence): void {
    if (fence.published || fence.destroyed) return;
    fence.destroyed = true;
    this.collect(fence);
  }
  acquire(token: number): GlFenceLease | null {
    const fence = this.fences.get(token);
    if (!fence?.published || fence.destroyed || fence.references >= Number.MAX_SAFE_INTEGER) return null;
    // A failed lease allocation must not increment its reference count.
    try {
      const lease = new GlFenceLease(this, fence, fenceLeaseMint);
      fence.references++;
      return lease;
    } catch { return null; }
  }
  has(token: number): boolean {
    const fence = this.fences.get(token);
    return !!fence?.published && !fence.destroyed;
  }
  /** The client knows this token before creation, so a lost reply can be
   * cancelled. Advance the high-water mark even if cancellation beats a late
   * create request; that older request must never revive the abandoned sync. */
  abandon(token: number): boolean {
    if (!Number.isInteger(token) || token < 1 || token > 0xffff_ffff) return false;
    this.serial = Math.max(this.serial, token);
    const fence = this.fences.get(token);
    if (fence && !fence.destroyed) {
      fence.destroyed = true;
      this.collect(fence);
    }
    return true;
  }
  destroy(token: number): boolean {
    const fence = this.fences.get(token);
    if (!fence?.published || fence.destroyed) return false;
    fence.destroyed = true;
    this.collect(fence);
    return true;
  }
  destroyCaptured(fence: Fence): boolean {
    if (this.fences.get(fence.token) !== fence || !fence.published) return false;
    // An already-destroyed captured public name is an accepted idempotent
    // release; its retained lease still owns the exact original native fence.
    fence.destroyed = true;
    return true;
  }
  release(fence: Fence): boolean {
    fence.references--;
    return this.collect(fence);
  }
  retryRetirement(fence: Fence): boolean { return this.collect(fence); }
  private collect(fence: Fence): boolean {
    if (!fence.destroyed || fence.references !== 0) return true;
    // Rejected native deletion remains in the preallocated retirement owner,
    // fences physical-context admission and survives this session's removal.
    // Keep failed receipts discoverable by teardown even after the logical
    // context disappears. Public lookup already rejects destroyed records.
    if (!retireNativeRetirement(fence.retirement)) return false;
    this.fences.delete(fence.token);
    return true;
  }
  private pruneCompleted(): void {
    for (const [token, fence] of this.fences) {
      if (fence.destroyed && fence.references === 0 && fence.retirement.complete) this.fences.delete(token);
    }
  }
  contexts(): Set<WebGL2RenderingContext> {
    this.pruneCompleted();
    return new Set([...this.fences.values()].map(fence => fence.owner.gl!));
  }
  close(): void {
    this.closed = true;
    for (const fence of this.fences.values()) {
      fence.destroyed = true;
      this.collect(fence);
    }
  }
}
