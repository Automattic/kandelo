import type { GlBinding } from "./registry.js";
import { captureNativeGlErrors } from "./errors.js";
import { defaultFramebuffer, isDefaultFramebuffer } from "./framebuffer.js";

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

export function applyCurrentDrawable(b: GlBinding, drawable: GlDrawableBinding): boolean {
  if (drawable.drawSurfaceId === 0 && b.gl && !b.undefinedDefaultFbo) {
    // The caller invalidates the native muxer first, preserving the outgoing
    // owner's errors. Allocation errors here belong to EGL's bind attempt.
    const framebuffer = b.gl.createFramebuffer();
    try { captureNativeGlErrors(b.gl, null); }
    catch (error) { if (framebuffer) b.gl.deleteFramebuffer(framebuffer); throw error; }
    if (!framebuffer) return false;
    b.undefinedDefaultFbo = framebuffer;
  }
  const drawDefault = isDefaultFramebuffer(b, b.shadow.fbo);
  const readDefault = isDefaultFramebuffer(b, b.shadow.readFbo);
  // EGL initializes viewport and scissor only the first time a context is
  // made current. Changing its drawable later must preserve client state.
  if (!b.hasBeenCurrent) {
    const width = drawable.drawSurfaceId === 0 ? 0 : drawable.width || b.canvas?.width || 0;
    const height = drawable.drawSurfaceId === 0 ? 0 : drawable.height || b.canvas?.height || 0;
    b.shadow.viewport = [0, 0, width, height];
    b.shadow.scissor.rect = [0, 0, width, height];
    b.hasBeenCurrent = true;
  }
  b.currentDrawable = {
    drawSurfaceId: drawable.drawSurfaceId, readSurfaceId: drawable.readSurfaceId,
    width: drawable.width, height: drawable.height,
  };
  if (drawDefault) b.shadow.fbo = defaultFramebuffer(b);
  if (readDefault) b.shadow.readFbo = defaultFramebuffer(b, true);
  return true;
}
