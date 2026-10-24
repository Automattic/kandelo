import type { GlBinding } from "./registry.js";
import { retireNativeRetirement, retainNativeRetirement, type NativeRetirement, type NativeRetirementLease } from "./native-recovery.js";
import type { GlErrorState } from "./errors.js";

export type GlPresentTarget = {
  fbo: WebGLFramebuffer; tex: WebGLTexture; depthStencil: WebGLRenderbuffer;
  w: number; h: number;
  retirement: NativeRetirement;
};

export type GlSurfaceFields = {
  /** Current kernel surface identity, or null before surface creation. */
  surfaceId: number | null;
  /** Dimensions may arrive before a context/native target exists. */
  surfaceSize: { width: number; height: number } | null;
  /** Borrowed GPU BO FBO or this surface's owned presentation target. */
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
  users: Set<GlBinding>;
};

export function createSurfaceResources(pid: number): GlSurfaceResources {
  return {
    surfaceId: null, surfaceSize: null, renderTargetFbo: null,
    presentTarget: null, pendingRenderTargetBoId: 0,
    gl: null, pid, ownerAlive: true, fixedSize: false, kind: 1, users: new Set(),
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
  s.presentTarget = null; s.renderTargetFbo = null;
  s.surfaceId = null; s.surfaceSize = null; s.pendingRenderTargetBoId = 0;
  s.gl = null;
}

/** Captures an allocation, not the mutable logical surface or its users.
 * Resize may publish a new target while queued work still owns this one. */
export class GlSurfaceStorageLease {
  #hold: NativeRetirementLease | null = null;
  #framebuffer: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
  readonly surfaceId: number | null;
  private constructor(framebuffer: WebGLFramebuffer, width: number, height: number, surfaceId: number | null) {
    this.#framebuffer = framebuffer; this.width = width; this.height = height; this.surfaceId = surfaceId;
  }
  static acquire(surface: GlSurfaceResources): GlSurfaceStorageLease | null {
    const target = surface.presentTarget;
    if (!target || !surface.gl || target.retirement.owner.gl !== surface.gl ||
        surface.renderTargetFbo !== target.fbo) return null;
    try {
      const lease = new GlSurfaceStorageLease(target.fbo,target.w,target.h,surface.surfaceId);
      lease.#hold = retainNativeRetirement(target.retirement);
      return lease.#hold ? lease : null;
    } catch { return null; }
  }
  get context(): WebGL2RenderingContext | null { return this.#hold?.context ?? null; }
  get framebuffer(): WebGLFramebuffer {
    if (!this.#hold?.active) throw new Error("Surface storage lease is released");
    return this.#framebuffer;
  }
  clone(): GlSurfaceStorageLease | null {
    if (!this.#hold?.active) return null;
    try {
      const lease = new GlSurfaceStorageLease(this.#framebuffer,this.width,this.height,this.surfaceId);
      lease.#hold = this.#hold.clone();
      return lease.#hold ? lease : null;
    } catch { return null; }
  }
  release(selectedErrors: GlErrorState | null): boolean {
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

/** A resize replaces native allocation, not the logical drawable. Update
 * every selecting context, including one which currently uses a user FBO. */
export function prepareSurfaceTargetReplacement(s: GlSurfaceResources, target: GlPresentTarget, owner: GlBinding): () => void {
  const previous = s.renderTargetFbo;
  const size = {width:target.w,height:target.h};
  const updates = [...new Set([...s.users,owner])].map(b => ({b,
    draw:(b.drawSurface === s || (b === owner && !b.drawSurface)) && b.shadow.fbo === previous,
    read:(b.readSurface === s || (b === owner && !b.readSurface)) && b.shadow.readFbo === previous,
  }));
  // Reserve every selecting context update before native allocation. Commit
  // must not fail after replacing the physical default-framebuffer bindings.
  return () => {
    s.presentTarget = target; s.renderTargetFbo = target.fbo; s.surfaceSize = size;
    for (const {b,draw,read} of updates) {
      if (draw) b.shadow.fbo = b.currentDrawable?.drawSurfaceId === 0 ? b.undefinedDefaultFbo : target.fbo;
      if (read) b.shadow.readFbo = b.currentDrawable?.readSurfaceId === 0 ? b.undefinedDefaultFbo : target.fbo;
    }
  };
}

/** Prepare every selector's default references before replacing a borrowed
 * BO target. Publication performs no native calls or allocation, so failure
 * in preflight cannot leave some contexts pointing at the retired FBO. */
export function prepareBorrowedSurfaceTarget(owner: GlBinding,
  target: {gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number}, boId: number): () => void {
  const s = owner.surface, previous = s.renderTargetFbo;
  const size = {width:target.w,height:target.h};
  const users = new Set([...s.users,owner]);
  const updates = [...users].map(b => ({b,
    draw: (b.drawSurface === s || (b === owner && !b.drawSurface)) && b.shadow.fbo === previous,
    read: (b.readSurface === s || (b === owner && !b.readSurface)) && b.shadow.readFbo === previous,
    drawable: b.currentDrawable?.drawSurfaceId === s.surfaceId ? {...b.currentDrawable,width:target.w,height:target.h} : b.currentDrawable,
  }));
  return () => {
    s.gl = target.gl; s.pendingRenderTargetBoId = boId;
    s.surfaceSize = size; s.renderTargetFbo = target.fbo;
    for (const {b,draw,read,drawable} of updates) {
      if (draw) b.shadow.fbo = b.currentDrawable?.drawSurfaceId === 0 ? b.undefinedDefaultFbo : target.fbo;
      if (read) b.shadow.readFbo = b.currentDrawable?.readSurfaceId === 0 ? b.undefinedDefaultFbo : target.fbo;
      b.currentDrawable = drawable;
    }
  };
}
