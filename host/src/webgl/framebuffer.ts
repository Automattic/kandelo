import type { GlBinding } from "./registry.js";
import { repairNativeState } from "./native-recovery.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

export const GL_FRAMEBUFFER = 0x8d40;
export const GL_READ_FRAMEBUFFER = 0x8ca8;
export const GL_DRAW_FRAMEBUFFER = 0x8ca9;
export const GL_FRAMEBUFFER_UNDEFINED = 0x8219;

/** Guest-visible framebuffer targets. GLES 2.0.25 section 4.4.1 has only
 * FRAMEBUFFER; WebGL 2's READ_/DRAW_FRAMEBUFFER selectors stay private to
 * host internals, which bind them natively without this guest check. */
export function validFramebufferTarget(target: number): boolean {
  return target === GL_FRAMEBUFFER;
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

/** GLES draw framebuffer errors remain observable with no installed program.
 * WebGL's draw validation can reject that program state before framebuffer
 * completeness. Check the actual selected target before dependent draw work;
 * installed executables continue through ordinary native draw validation. */
export function validateDrawFramebufferWithoutProgram(b: GlBinding): boolean {
  if (b.currentProgram) return true;
  if (!b.gl || !repairNativeState(b.gl)) return false;
  let status: unknown;
  if (!checkedGlCall(b, () => { status = b.gl!.checkFramebufferStatus(GL_DRAW_FRAMEBUFFER); })) return false;
  if (typeof status !== "number" || !Number.isInteger(status) || status <= 0 || status > 0xffff_ffff) {
    recordGlError(b, 0x502); return false;
  }
  if (status !== 0x8cd5) { recordGlError(b, 0x506); return false; }
  return true;
}
