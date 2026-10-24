import type { GlBinding } from "./registry.js";

export type GlPresentTarget = {
  fbo: WebGLFramebuffer; tex: WebGLTexture; depthStencil: WebGLRenderbuffer;
  w: number; h: number;
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
  users: Set<GlBinding>;
};

export function createSurfaceResources(pid: number): GlSurfaceResources {
  return {
    surfaceId: null, surfaceSize: null, renderTargetFbo: null,
    presentTarget: null, pendingRenderTargetBoId: 0,
    gl: null, pid, ownerAlive: true, users: new Set(),
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
    s.gl?.deleteFramebuffer(target.fbo);
    s.gl?.deleteTexture(target.tex);
    s.gl?.deleteRenderbuffer(target.depthStencil);
  }
  s.presentTarget = null; s.renderTargetFbo = null;
  s.surfaceId = null; s.surfaceSize = null; s.pendingRenderTargetBoId = 0;
  s.gl = null;
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
export function replaceSurfaceTarget(s: GlSurfaceResources, target: GlPresentTarget, owner: GlBinding): void {
  const previous = s.renderTargetFbo;
  s.presentTarget = target; s.renderTargetFbo = target.fbo;
  s.surfaceSize = { width: target.w, height: target.h };
  for (const b of new Set([...s.users, owner])) {
    if ((b.drawSurface === s || (b === owner && !b.drawSurface)) && b.shadow.fbo === previous)
      b.shadow.fbo = b.currentDrawable?.drawSurfaceId === 0 ? b.undefinedDefaultFbo : target.fbo;
    if ((b.readSurface === s || (b === owner && !b.readSurface)) && b.shadow.readFbo === previous)
      b.shadow.readFbo = b.currentDrawable?.readSurfaceId === 0 ? b.undefinedDefaultFbo : target.fbo;
  }
}
