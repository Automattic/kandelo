import type { GlBinding } from "./registry.js";
import { retireNativeRetirement, retainNativeRetirement, type NativeRetirement, type NativeRetirementLease } from "./native-recovery.js";
import type { GlErrorState } from "./errors.js";
import type { GlMultisampleTarget } from "./multisample.js";

export type GlPresentTarget = {
  /** A multisampled surface's present target is its resolve destination
   * and has no depth/stencil buffer of its own. */
  fbo: WebGLFramebuffer; tex: WebGLTexture; depthStencil: WebGLRenderbuffer | null;
  w: number; h: number;
  retirement: NativeRetirement;
};
export type GlBorrowedTarget = {
  gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number;
  retirement: NativeRetirement;
};

export type GlSurfaceFields = {
  /** Current kernel surface identity, or null before surface creation. */
  surfaceId: number | null;
  /** Dimensions may arrive before a context/native target exists. */
  surfaceSize: { width: number; height: number } | null;
  /** The guest's default framebuffer: the multisampled framebuffer of a
   * multisampled surface, otherwise its borrowed GPU BO FBO or owned
   * presentation target. */
  renderTargetFbo: WebGLFramebuffer | null;
  presentTarget: GlPresentTarget | null;
  /** Producer surface created before its context; resolve on that renderer. */
  pendingRenderTargetBoId: number;
};

/** Device storage belongs to the surface, independently of the contexts
 * selecting it. A retired owner cannot grant a new binding, but existing
 * draw/read references keep the native target alive until release. */
export type GlSurfaceResources = GlSurfaceFields & {
  gl: WebGL2RenderingContext | null;
  pid: number;
  ownerAlive: boolean;
  /** Explicit surface storage keeps its acknowledged dimensions. */
  fixedSize: boolean;
  kind: number;
  borrowedTarget: GlBorrowedTarget | null;
  /** EGL config sample count; zero for a single-sampled surface. */
  samples: number;
  /** Multisampled rendering storage, resolved into the present target or
   * borrowed target. Present exactly when `samples` is nonzero and the
   * surface has storage. */
  multisample: GlMultisampleTarget | null;
  users: Set<GlBinding>;
};

export function createSurfaceResources(pid: number): GlSurfaceResources {
  return {
    surfaceId: null, surfaceSize: null, renderTargetFbo: null,
    presentTarget: null, pendingRenderTargetBoId: 0,
    gl: null, pid, ownerAlive: true, fixedSize: false, kind: 1, borrowedTarget: null,
    samples: 0, multisample: null, users: new Set(),
  };
}

/** Preserve the existing renderer API while its fields address the one
 * canonical surface record rather than copied context-owned resources. */
export function exposeSurfaceResources<T extends { surface: GlSurfaceResources }>(b: T): T & GlSurfaceFields {
  for (const name of ["surfaceId", "surfaceSize", "renderTargetFbo", "presentTarget", "pendingRenderTargetBoId"] as const) {
    Object.defineProperty(b, name, {
      enumerable: true,
      get: () => b.surface[name],
      set: value => {
        Reflect.set(b.surface, name, value);
        if ((name === "renderTargetFbo" || name === "presentTarget") && value !== null) {
          b.surface.gl ??= Reflect.get(b, "gl") as WebGL2RenderingContext | null;
        }
      },
    });
  }
  return b as T & GlSurfaceFields;
}

function collectSurface(s: GlSurfaceResources): void {
  if (s.ownerAlive || s.users.size) return;
  const target = s.presentTarget;
  // A BO-backed FBO is borrowed. Its kernel BO lifetime is the deletion fence.
  if (target) {
    retireNativeRetirement(target.retirement);
  }
  if (s.multisample) retireNativeRetirement(s.multisample.retirement);
  s.presentTarget = null; s.borrowedTarget = null; s.renderTargetFbo = null; s.multisample = null;
  s.surfaceId = null; s.surfaceSize = null; s.pendingRenderTargetBoId = 0;
  s.gl = null;
}

/** Captures an allocation, not the mutable logical surface or its users.
 * Resize may publish a new target while queued work still owns this one. */
export class GlSurfaceStorageLease {
  #hold: NativeRetirementLease | null = null;
  /** A multisampled surface's rendering storage, held with its resolve
   * destination so retained work can still resolve for reads. */
  #multisampleHold: NativeRetirementLease | null = null;
  #framebuffer: WebGLFramebuffer;
  #resolveFramebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
  readonly surfaceId: number | null;
  private constructor(framebuffer: WebGLFramebuffer, resolveFramebuffer: WebGLFramebuffer | null,
    width: number, height: number, surfaceId: number | null) {
    this.#framebuffer = framebuffer; this.#resolveFramebuffer = resolveFramebuffer;
    this.width = width; this.height = height; this.surfaceId = surfaceId;
  }
  static acquire(surface: GlSurfaceResources): GlSurfaceStorageLease | null {
    const target = surface.presentTarget ?? surface.borrowedTarget, ms = surface.multisample;
    if (!target || !surface.gl || target.retirement.owner.gl !== surface.gl ||
        surface.renderTargetFbo !== (ms ? ms.fbo : target.fbo)) return null;
    if (ms && (ms.retirement.owner.gl !== surface.gl || ms.w !== target.w || ms.h !== target.h)) return null;
    let lease: GlSurfaceStorageLease | null = null;
    try {
      lease = new GlSurfaceStorageLease(ms ? ms.fbo : target.fbo, ms ? target.fbo : null, target.w, target.h, surface.surfaceId);
      lease.#hold = retainNativeRetirement(target.retirement);
      if (ms && lease.#hold) lease.#multisampleHold = retainNativeRetirement(ms.retirement);
      if (lease.#hold && (!ms || lease.#multisampleHold)) return lease;
    } catch { /* Release any partial hold below. */ }
    // A partial hold was never published; its release cannot be pending work.
    if (lease && lease.#hold) lease.#hold.release(null);
    return null;
  }
  /** Single-sampled resolve storage of a multisampled default framebuffer. */
  get resolveFramebuffer(): WebGLFramebuffer | null {
    if (!this.#hold?.active) throw new Error("Surface storage lease is released");
    return this.#resolveFramebuffer;
  }
  get context(): WebGL2RenderingContext | null { return this.#hold?.context ?? null; }
  get framebuffer(): WebGLFramebuffer {
    if (!this.#hold?.active) throw new Error("Surface storage lease is released");
    return this.#framebuffer;
  }
  clone(): GlSurfaceStorageLease | null {
    if (!this.#hold?.active || (this.#resolveFramebuffer && !this.#multisampleHold?.active)) return null;
    let lease: GlSurfaceStorageLease | null = null;
    try {
      lease = new GlSurfaceStorageLease(this.#framebuffer,this.#resolveFramebuffer,this.width,this.height,this.surfaceId);
      lease.#hold = this.#hold.clone();
      if (this.#multisampleHold && lease.#hold) lease.#multisampleHold = this.#multisampleHold.clone();
      if (lease.#hold && (!this.#multisampleHold || lease.#multisampleHold)) return lease;
    } catch { /* Release any partial hold below. */ }
    if (lease && lease.#hold) lease.#hold.release(null);
    return null;
  }
  /** Retryable: an allocation whose final deletion fails keeps its hold. */
  release(selectedErrors: GlErrorState | null): boolean {
    if (this.#multisampleHold) {
      if (!this.#multisampleHold.release(selectedErrors)) return false;
      this.#multisampleHold = null;
    }
    if (!this.#hold) return true;
    if (!this.#hold.release(selectedErrors)) return false;
    this.#hold = null;
    return true;
  }
}

export function retainSurfaceStorage(surface: GlSurfaceResources): GlSurfaceStorageLease | null {
  return GlSurfaceStorageLease.acquire(surface);
}

export function retireSurface(s: GlSurfaceResources): void {
  s.ownerAlive = false;
  collectSurface(s);
}

/** Called only after all bind preflight/allocation has succeeded. Membership
 * counts a context once even when it names the same surface for draw/read. */
export function selectSurfaceResources(b: GlBinding, draw: GlSurfaceResources | null, read: GlSurfaceResources | null): void {
  const previous = new Set([b.drawSurface, b.readSurface]);
  const next = new Set([draw, read]);
  for (const s of next) if (s) s.users.add(b);
  b.drawSurface = draw; b.readSurface = read;
  for (const s of previous) if (s && !next.has(s)) {
    s.users.delete(b);
    collectSurface(s);
  }
}

export function releaseSurfaceResources(b: GlBinding): void {
  // Removing a borrowed target must not turn its old native FBO into a user
  // container on the next bind. User FBO bindings remain context state.
  if (b.drawSurface && b.shadow.fbo === b.drawSurface.renderTargetFbo) b.shadow.fbo = null;
  if (b.readSurface && b.shadow.readFbo === b.readSurface.renderTargetFbo) b.shadow.readFbo = null;
  selectSurfaceResources(b, null, null);
}

/** An active frame keeps its captured allocation until dispatch ends. A
 * logical resize must not replace the physical selectors underneath it. */
export function surfaceExecutionUsesFramebuffer(s: GlSurfaceResources, owner: GlBinding,
  framebuffer: WebGLFramebuffer | null, read: boolean): boolean {
  if (!framebuffer) return false;
  for (const b of s.users) if ((read ? b.executionDrawable?.readFramebuffer : b.executionDrawable?.drawFramebuffer) === framebuffer) return true;
  return (read ? owner.executionDrawable?.readFramebuffer : owner.executionDrawable?.drawFramebuffer) === framebuffer;
}

/** A resize replaces native allocation, not the logical drawable. Update
 * every selecting context, including one which currently uses a user FBO. */
export function prepareSurfaceTargetReplacement(s: GlSurfaceResources, target: GlPresentTarget, owner: GlBinding,
  multisample: GlMultisampleTarget | null = null): () => void {
  const previous = s.renderTargetFbo;
  const size = {width:target.w,height:target.h};
  const updates = [...new Set([...s.users,owner])].map(b => ({b,
    draw:(b.drawSurface === s || (b === owner && !b.drawSurface)) && b.shadow.fbo === previous && b.executionDrawable?.drawFramebuffer !== previous,
    read:(b.readSurface === s || (b === owner && !b.readSurface)) && b.shadow.readFbo === previous && b.executionDrawable?.readFramebuffer !== previous,
  }));
  // Reserve every selecting context update before native allocation. Commit
  // must not fail after replacing the physical default-framebuffer bindings.
  return () => {
    // Native allocation fills the target in after this preparation.
    const next = multisample?.fbo ?? target.fbo;
    s.presentTarget = target; s.multisample = multisample; s.renderTargetFbo = next; s.surfaceSize = size;
    for (const {b,draw,read} of updates) {
      if (draw) b.shadow.fbo = b.currentDrawable?.drawSurfaceId === 0 ? b.undefinedDefaultFbo : next;
      if (read) b.shadow.readFbo = b.currentDrawable?.readSurfaceId === 0 ? b.undefinedDefaultFbo : next;
    }
  };
}

/** Prepare every selector's default references before replacing a borrowed
 * BO target. Publication performs no native calls or allocation, so failure
 * in preflight cannot leave some contexts pointing at the retired FBO. */
export function prepareBorrowedSurfaceTarget(owner: GlBinding,
  target: {gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number; retirement?: NativeRetirement}, boId: number,
  multisample: GlMultisampleTarget | null = null): () => void {
  // A multisampled surface keeps rendering into its multisampled storage;
  // the BO becomes its resolve destination.
  const s = owner.surface, previous = s.renderTargetFbo, next = multisample?.fbo ?? target.fbo;
  const allocation = target.retirement ? {gl:target.gl,fbo:target.fbo,w:target.w,h:target.h,retirement:target.retirement} : null;
  const size = {width:target.w,height:target.h};
  const users = new Set([...s.users,owner]);
  const updates = [...users].map(b => ({b,
    draw: (b.drawSurface === s || (b === owner && !b.drawSurface)) && b.shadow.fbo === previous && b.executionDrawable?.drawFramebuffer !== previous,
    read: (b.readSurface === s || (b === owner && !b.readSurface)) && b.shadow.readFbo === previous && b.executionDrawable?.readFramebuffer !== previous,
    drawable: b.currentDrawable?.drawSurfaceId === s.surfaceId ? {...b.currentDrawable,width:target.w,height:target.h} : b.currentDrawable,
  }));
  return () => {
    s.gl = target.gl; s.pendingRenderTargetBoId = boId;
    s.borrowedTarget = allocation;
    s.surfaceSize = size; s.renderTargetFbo = next; s.multisample = multisample;
    for (const {b,draw,read,drawable} of updates) {
      if (draw) b.shadow.fbo = b.currentDrawable?.drawSurfaceId === 0 ? b.undefinedDefaultFbo : next;
      if (read) b.shadow.readFbo = b.currentDrawable?.readSurfaceId === 0 ? b.undefinedDefaultFbo : next;
      b.currentDrawable = drawable;
    }
  };
}
