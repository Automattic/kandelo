import type { GlBinding } from "./registry.js";

export const GL_FRAMEBUFFER = 0x8d40;
export const GL_READ_FRAMEBUFFER = 0x8ca8;
export const GL_DRAW_FRAMEBUFFER = 0x8ca9;
export const GL_FRAMEBUFFER_UNDEFINED = 0x8219;

export function validFramebufferTarget(target: number): boolean {
  return target === GL_FRAMEBUFFER || target === GL_READ_FRAMEBUFFER || target === GL_DRAW_FRAMEBUFFER;
}

export function defaultFramebuffer(b: GlBinding, read = false): WebGLFramebuffer | null {
  if (b.executionDrawable) return read ? b.executionDrawable.readFramebuffer : b.executionDrawable.drawFramebuffer;
  return logicalDefaultFramebuffer(b, read);
}

/** Public drawable selection, independent of a currently executing snapshot. */
export function logicalDefaultFramebuffer(b: GlBinding, read = false): WebGLFramebuffer | null {
  const surface = read ? b.currentDrawable?.readSurfaceId : b.currentDrawable?.drawSurfaceId;
  const selected = read ? b.readSurface : b.drawSurface;
  return surface === 0 ? b.undefinedDefaultFbo : selected ? selected.renderTargetFbo : b.renderTargetFbo;
}

export function boundFramebuffer(b: GlBinding, target: number): WebGLFramebuffer | null {
  return target === GL_READ_FRAMEBUFFER ? b.shadow.readFbo : b.shadow.fbo;
}

export function isDefaultFramebuffer(b: GlBinding, framebuffer: WebGLFramebuffer | null): boolean {
  return framebuffer === b.executionDrawable?.drawFramebuffer || framebuffer === b.executionDrawable?.readFramebuffer
    || framebuffer === null || framebuffer === b.renderTargetFbo || framebuffer === b.undefinedDefaultFbo
    || framebuffer === b.drawSurface?.renderTargetFbo || framebuffer === b.readSurface?.renderTargetFbo;
}

/** A changed native window target must not displace a user FBO or the
 * incomplete framebuffer representing a currently surfaceless binding. */
export function replaceDefaultFramebuffer(b: GlBinding, previous: WebGLFramebuffer | null): void {
  if (b.shadow.fbo === previous) b.shadow.fbo = defaultFramebuffer(b);
  if (b.shadow.readFbo === previous) b.shadow.readFbo = defaultFramebuffer(b, true);
}
