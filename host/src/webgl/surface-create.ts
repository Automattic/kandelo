import type { GlBinding } from "./registry.js";
import { createSurfaceResources, exposeSurfaceResources, retireSurface } from "./surface-resources.js";
import { resizeSurfaceTarget } from "./present-target.js";

/** Reviewed scalars only. No guest memory crosses a renderer boundary. */
export type GlSurfaceCreation = {
  surfaceId: number; kind: number; width: number; height: number;
  configId: number; targetBoId: number;
};
export type GlSurfaceTarget = { gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number };
export const GL_SURFACE_WIRE_BYTES = 36;

export function validSurfaceCreation(v: GlSurfaceCreation): boolean {
  return Number.isInteger(v.surfaceId) && v.surfaceId > 0 && v.surfaceId <= 0xffff_ffff
    && (v.kind === 1 || v.kind === 2) && v.configId === 1
    && Number.isInteger(v.width) && v.width >= 0 && v.width <= 0x7fff_ffff
    && Number.isInteger(v.height) && v.height >= 0 && v.height <= 0x7fff_ffff
    && Number.isInteger(v.targetBoId) && v.targetBoId >= 0 && v.targetBoId <= 0xffff_ffff
    && (v.kind === 1 || v.targetBoId === 0);
}

/** Allocate privately. Commit/cancel in this synchronous renderer turn;
 * forwarded callers commit only when the reply mailbox accepts completion. */
export function prepareSurfaceCreation(b: GlBinding, v: GlSurfaceCreation,
  target?: GlSurfaceTarget, canvas = b.canvas): { rc: number; prepared?: {
    width: number; height: number; commit(): void; cancel(): void;
  } } {
  if (!validSurfaceCreation(v)) return { rc: -22 };
  if (b.surfaceId !== null) return { rc: -16 };
  if (v.targetBoId && !target) return { rc: -2 };
  const candidate = createSurfaceResources(b.pid);
  candidate.surfaceId = v.surfaceId; candidate.fixedSize = true;
  let width = v.width, height = v.height;
  try {
    if (target) {
      if (target.gl.isContextLost() || (b.gl && b.gl !== target.gl)) return { rc: -5 };
      if ((width && width !== target.w) || (height && height !== target.h)) return { rc: -22 };
      width = target.w; height = target.h;
      candidate.gl = target.gl; candidate.renderTargetFbo = target.fbo;
      candidate.pendingRenderTargetBoId = v.targetBoId;
    } else {
      const gl = b.gl ?? canvas?.getContext("webgl2", {
        antialias: false, premultipliedAlpha: false, depth: true, stencil: true, preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;
      if (!gl || gl.isContextLost()) return { rc: -19 };
      if (v.kind === 1) { width ||= canvas?.width ?? 0; height ||= canvas?.height ?? 0; }
      const staging = exposeSurfaceResources({ ...b, surface: candidate, gl,
        shadow: { ...b.shadow }, drawSurface: null, readSurface: null, currentDrawable: null });
      if (!resizeSurfaceTarget(staging, width, height)) { retireSurface(candidate); return { rc: -12 }; }
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
  } catch { retireSurface(candidate); return { rc: -5 }; }
}
