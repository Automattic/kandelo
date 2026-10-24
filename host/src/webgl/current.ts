import type { GlBinding } from "./registry.js";
import { captureNativeGlErrors } from "./errors.js";
import { defaultFramebuffer, isDefaultFramebuffer } from "./framebuffer.js";
import { selectSurfaceResources, type GlSurfaceResources } from "./surface-resources.js";

/** Zero surfaces mean surfaceless; release itself is kernel authority and
 * needs no renderer operation. These values contain no guest memory. */
export type GlDrawableBinding = {
  drawSurfaceId: number;
  readSurfaceId: number;
  width: number;
  height: number;
};

export function validCurrentDrawable(value: GlDrawableBinding): boolean {
  return Number.isInteger(value.drawSurfaceId) && value.drawSurfaceId >= 0 && value.drawSurfaceId <= 0xffff_ffff
    && Number.isInteger(value.readSurfaceId) && value.readSurfaceId >= 0 && value.readSurfaceId <= 0xffff_ffff
    && (value.drawSurfaceId === 0) === (value.readSurfaceId === 0)
    && Number.isInteger(value.width) && value.width >= 0 && value.width <= 0x7fff_ffff
    && Number.isInteger(value.height) && value.height >= 0 && value.height <= 0x7fff_ffff;
}

/** Surface identity and renderer preflight. Display-generation authority is
 * checked by the kernel before a guest request reaches this renderer. */
export function resolveDrawableSurfaces(registry: { getSurface(pid: number, id: number): GlSurfaceResources | undefined },
  b: GlBinding, drawId: number, readId: number): GlDrawableSurfaces | null {
  const draw = registry.getSurface(b.pid,drawId), read = registry.getSurface(b.pid,readId);
  if (!draw || !read) return null;
  if ((draw.gl && draw.gl !== b.gl) || (read.gl && read.gl !== b.gl)) return null;
  if ((!draw.gl && draw !== b.surface && b.gl) || (!read.gl && read !== b.surface && b.gl)) return null;
  return {draw,read};
}

export type GlDrawableSurfaces = { draw: GlSurfaceResources; read: GlSurfaceResources };

/** Prepare native storage without changing current ownership. Forwarded
 * callers commit only after the reply mailbox accepts acknowledgement.
 * Complete or cancel within the same synchronous renderer turn. */
export function prepareCurrentDrawable(b: GlBinding, drawable: GlDrawableBinding,
  surfaces?: GlDrawableSurfaces): { commit(): void; cancel(): void } | null {
  if (!validCurrentDrawable(drawable)) return null;
  const draw = drawable.drawSurfaceId === 0 ? null : surfaces?.draw ?? b.surface;
  const read = drawable.readSurfaceId === 0 ? null : surfaces?.read ?? b.surface;
  if (surfaces && (drawable.drawSurfaceId === 0 || !draw?.ownerAlive || !read?.ownerAlive
      || draw.surfaceId !== drawable.drawSurfaceId || read.surfaceId !== drawable.readSurfaceId
      || draw.pid !== b.pid || read.pid !== b.pid
      || (draw.gl !== b.gl && !(draw === b.surface && draw.gl === null))
      || (read.gl !== b.gl && !(read === b.surface && read.gl === null)))) return null;
  if ((draw?.gl && draw.gl !== b.gl) || (read?.gl && read.gl !== b.gl)) return null;
  let framebuffer: WebGLFramebuffer | null = null;
  const gl = b.gl;
  if (drawable.drawSurfaceId === 0 && gl && !b.undefinedDefaultFbo) {
    framebuffer = gl.createFramebuffer();
    try { captureNativeGlErrors(gl, null); }
    catch (error) { if (framebuffer) gl.deleteFramebuffer(framebuffer); throw error; }
    if (!framebuffer) return null;
  }
  const drawDefault = isDefaultFramebuffer(b, b.shadow.fbo);
  const readDefault = isDefaultFramebuffer(b, b.shadow.readFbo);
  // Capture only reviewed drawable scalars, never a caller's extra fields.
  const next = { drawSurfaceId: drawable.drawSurfaceId, readSurfaceId: drawable.readSurfaceId,
    width: drawable.width, height: drawable.height };
  let pending = true;
  return {
    commit() {
      if (!pending) return;
      pending = false;
      if (framebuffer) b.undefinedDefaultFbo = framebuffer;
      if (!b.hasBeenCurrent) {
        const width = next.drawSurfaceId === 0 ? 0 : next.width || b.canvas?.width || 0;
        const height = next.drawSurfaceId === 0 ? 0 : next.height || b.canvas?.height || 0;
        b.shadow.viewport = [0, 0, width, height]; b.shadow.scissor.rect = [0, 0, width, height];
        b.hasBeenCurrent = true;
      }
      selectSurfaceResources(b, draw, read);
      b.currentDrawable = next;
      if (drawDefault) b.shadow.fbo = defaultFramebuffer(b);
      if (readDefault) b.shadow.readFbo = defaultFramebuffer(b, true);
    },
    cancel() {
      if (!pending) return;
      pending = false;
      if (framebuffer) gl?.deleteFramebuffer(framebuffer);
    },
  };
}

export function applyCurrentDrawable(b: GlBinding, drawable: GlDrawableBinding, surfaces?: GlDrawableSurfaces): boolean {
  const prepared = prepareCurrentDrawable(b, drawable, surfaces);
  if (!prepared) return false;
  prepared.commit();
  return true;
}
