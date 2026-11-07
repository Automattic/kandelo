import type { GlBinding } from "./registry.js";
import { hasNativeRepair, repairNativeState, rethrowNativeGlFault } from "./native-recovery.js";
import { createSurfaceResources, exposeSurfaceResources, retireSurface } from "./surface-resources.js";
import { resizeSurfaceTarget } from "./present-target.js";
import type { NativeRetirement } from "./native-recovery.js";
import { allocateMultisampleTarget, surfaceConfigSamples, surfaceSampleMask } from "./multisample.js";

/** Reviewed scalars only. No guest memory crosses a renderer boundary. */
export type GlSurfaceCreation = {
  surfaceId: number; kind: number; width: number; height: number;
  configId: number; targetBoId: number;
};
export type GlSurfaceTarget = { gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number; retirement?: NativeRetirement };
export const GL_SURFACE_WIRE_BYTES = 36;

export function validSurfaceCreation(v: GlSurfaceCreation): boolean {
  return Number.isInteger(v.surfaceId) && v.surfaceId > 0 && v.surfaceId <= 0xffff_ffff
    && (v.kind === 1 || v.kind === 2) && surfaceConfigSamples(v.configId) !== null
    && Number.isInteger(v.width) && v.width >= 0 && v.width <= 0x7fff_ffff
    && Number.isInteger(v.height) && v.height >= 0 && v.height <= 0x7fff_ffff
    && Number.isInteger(v.targetBoId) && v.targetBoId >= 0 && v.targetBoId <= 0xffff_ffff
    && (v.kind === 1 || v.targetBoId === 0);
}

/** Allocate privately. Commit/cancel in this synchronous renderer turn.
 * `deviceRenderer` is the renderer a context of this session would adopt
 * when the session has neither a renderer nor a canvas; only a pbuffer,
 * which needs storage but no presentation, may allocate on it. */
export function prepareSurfaceCreation(b: GlBinding, v: GlSurfaceCreation,
  target?: GlSurfaceTarget, canvas = b.canvas, captureErrors?: (gl: WebGL2RenderingContext) => void,
  deviceRenderer?: () => WebGL2RenderingContext | null): { rc: number; prepared?: {
    width: number; height: number; commit(): void; cancel(): void;
  } } {
  if (!validSurfaceCreation(v)) return { rc: -22 };
  if (b.surfaceId !== null) return { rc: -16 };
  if (v.targetBoId && !target) return { rc: -2 };
  if ((b.gl && !repairNativeState(b.gl)) || (target && !repairNativeState(target.gl))) return {rc:-5};
  const candidate = createSurfaceResources(b.pid);
  candidate.surfaceId = v.surfaceId; candidate.fixedSize = true; candidate.kind = v.kind;
  candidate.samples = surfaceConfigSamples(v.configId)!;
  let width = v.width, height = v.height;
  // EGL configs advertise only counts this renderer allocates exactly; a
  // request for another count is a malformed configuration, not a fallback.
  const supported = (gl: WebGL2RenderingContext): boolean => {
    if (!candidate.samples) return true;
    const mask = surfaceSampleMask({gl,errors:[]});
    if (mask === null) throw new Error("Renderer sample-count query failed");
    return (mask & (1 << candidate.samples)) !== 0;
  };
  try {
    if (target) {
      if (target.gl.isContextLost() || (b.gl && b.gl !== target.gl)) return { rc: -5 };
      if ((width && width !== target.w) || (height && height !== target.h)) return { rc: -22 };
      width = target.w; height = target.h;
      candidate.gl = target.gl; candidate.renderTargetFbo = target.fbo;
      candidate.borrowedTarget = target.retirement ? {gl:target.gl,fbo:target.fbo,w:target.w,h:target.h,retirement:target.retirement} : null;
      candidate.pendingRenderTargetBoId = v.targetBoId;
      if (candidate.samples) {
        // The borrowed BO is the resolve destination; rendering goes to
        // multisampled storage on the BO's renderer. Retained work must be
        // able to hold that destination, so it needs its retirement record.
        if (!candidate.borrowedTarget) throw new Error("Multisampled surface storage has no retirement owner");
        captureErrors?.(target.gl);
        if (!supported(target.gl)) { retireSurface(candidate); return { rc: -22 }; }
        const owner = {gl:target.gl,errors:[] as number[]};
        const multisample = allocateMultisampleTarget(owner,candidate.samples,target.w,target.h);
        if (!multisample) { retireSurface(candidate); return { rc: !hasNativeRepair(target.gl) && owner.errors.includes(0x505) ? -12 : -5 }; }
        candidate.multisample = multisample; candidate.renderTargetFbo = multisample.fbo;
      }
    } else {
      // EGL 1.5 section 3.5.2: a pbuffer is created from a display and a
      // config alone; no context need exist. Before this session creates a
      // context it has no renderer of its own, so the pbuffer is allocated on
      // the device renderer its context will adopt (host_gl_create_context).
      // A window surface still requires its canvas or target BO.
      const gl = b.gl ?? (canvas ? canvas.getContext("webgl2", {
        antialias: false, premultipliedAlpha: false, depth: true, stencil: true, preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null : v.kind === 2 ? deviceRenderer?.() ?? null : null);
      if (!gl || gl.isContextLost()) return { rc: -19 };
      captureErrors?.(gl);
      if (!supported(gl)) { retireSurface(candidate); return { rc: -22 }; }
      if (v.kind === 1) { width ||= canvas?.width ?? 0; height ||= canvas?.height ?? 0; }
      const staging = exposeSurfaceResources({ ...b, surface: candidate, gl,
        shadow: { ...b.shadow }, drawSurface: null, readSurface: null, currentDrawable: null });
      if (!resizeSurfaceTarget(staging, width, height)) { retireSurface(candidate); return { rc: hasNativeRepair(gl) ? -5 : -12 }; }
    }
    candidate.surfaceSize = { width, height };
    let pending = true;
    return { rc: 0, prepared: { width, height,
      commit() {
        if (!pending) return;
        pending = false;
        const old = b.surface;
        const drawDefault = !b.drawSurface && b.shadow.fbo === old.renderTargetFbo;
        const readDefault = !b.readSurface && b.shadow.readFbo === old.renderTargetFbo;
        b.surface = candidate;
        if (drawDefault) b.shadow.fbo = candidate.renderTargetFbo;
        if (readDefault) b.shadow.readFbo = candidate.renderTargetFbo;
        retireSurface(old);
      },
      cancel() { if (pending) { pending = false; retireSurface(candidate); } },
    } };
  } catch (caught) { retireSurface(candidate); rethrowNativeGlFault(caught); return { rc: -5 }; }
}
