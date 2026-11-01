import type { GlBinding } from "./registry.js";
import type { GlShadowState } from "./shadow.js";
import { attachedNativeStorage } from "./image-storage.js";
import { framebufferInputsChanged, framebufferInputsRevision } from "./framebuffer-revision.js";

/**
 * Color formats without alpha that WebGL 2 can only store with alpha: an
 * RGB16F_EXT renderbuffer (GL_EXT_color_buffer_half_float; WebGL 2 has no
 * renderable RGB16F) is stored as RGBA16F, and XRGB8888/XBGR8888 GPU buffers
 * as RGBA8. As ANGLE does for RGB formats on RGBA storage, the stored alpha is
 * initialized to 1.0 and never written: while such storage is the draw
 * framebuffer's color attachment, the native alpha write mask is held off
 * (the guest's logical COLOR_WRITEMASK, which queries report, is unchanged).
 * Every read of the storage (ReadPixels, CopyTex*, DST_ALPHA blending,
 * sampling) then observes alpha = 1, exactly the semantics of a format
 * without alpha.
 *
 * Keyed by the native storage an attachment actually references, so
 * EGLImage siblings that share the storage (a GBM XRGB8888 buffer imported
 * as a renderbuffer or texture) and private views of it are covered too.
 *
 * The lock is native state derived from the draw framebuffer, not a per-draw
 * override: a compositor issues many draws per framebuffer binding, so the
 * lock is re-derived only when the framebuffer, its attachments or their
 * storage changed (framebuffer-revision.ts), and the native mask is written
 * only when the lock or the guest mask changes.
 */
const opaqueStorage = new WeakSet<object>();

export function setOpaqueAlphaStorage(native: object | null, opaque: boolean): void {
  if (!native) return;
  if (opaque) opaqueStorage.add(native); else opaqueStorage.delete(native);
  framebufferInputsChanged();
}

export function isOpaqueAlphaStorage(native: object | null | undefined): boolean {
  return !!native && opaqueStorage.has(native);
}

/** Set the alpha of newly allocated storage to 1.0. `attach` attaches the
 * storage to the bound temporary draw framebuffer. Native state is read
 * first and restored exactly; throws on native failure (callers run inside
 * checkedGlCall). */
export function clearStorageAlphaToOne(gl: WebGL2RenderingContext, attach: (target: number) => void): void {
  const DRAW = 0x8ca9, SCISSOR = 0x0c11;
  const draw = gl.getParameter(0x8ca6) as WebGLFramebuffer | null;
  const scissor = gl.isEnabled(SCISSOR);
  const mask = Array.from(gl.getParameter(0x0c23) as ArrayLike<boolean>) as [boolean, boolean, boolean, boolean];
  const clear = Array.from(gl.getParameter(0x0c22) as ArrayLike<number>) as [number, number, number, number];
  const framebuffer = gl.createFramebuffer();
  try {
    gl.bindFramebuffer(DRAW, framebuffer);
    attach(DRAW);
    gl.disable(SCISSOR);
    gl.colorMask(false, false, false, true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(0x4000);
  } finally {
    gl.bindFramebuffer(DRAW, draw);
    if (scissor) gl.enable(SCISSOR);
    gl.colorMask(...mask);
    gl.clearColor(...clear);
    gl.deleteFramebuffer(framebuffer);
  }
}

/** The draw framebuffer's color attachment is storage without alpha. */
function drawColorStorageOpaque(b: GlBinding): boolean {
  const framebuffer = b.shadow.fbo;
  const image = framebuffer ? b.framebufferAttachments.get(framebuffer)?.get(0x8ce0) : undefined;
  return !!image && isOpaqueAlphaStorage(attachedNativeStorage(b, image));
}

/** The native COLOR_WRITEMASK for the guest mask: alpha off while locked.
 * Every writer of the native mask from guest state uses this. */
export function nativeColorMask(s: GlShadowState): [boolean, boolean, boolean, boolean] {
  const [r, g, b, a] = s.colorMask;
  return [r, g, b, a && !s.alphaWriteLock.locked];
}

/** Before a draw or clear: re-derive the lock only if the draw framebuffer,
 * its attachments or their storage changed since it was derived, and write
 * the native mask only if the lock changed while the guest writes alpha.
 * Otherwise this is two comparisons. */
export function syncAlphaWriteLock(b: GlBinding): void {
  const s = b.shadow, lock = s.alphaWriteLock, revision = framebufferInputsRevision();
  if (lock.fbo === s.fbo && lock.revision === revision) return;
  const locked = drawColorStorageOpaque(b);
  lock.fbo = s.fbo; lock.revision = revision;
  if (lock.locked === locked) return;
  lock.locked = locked;
  if (s.colorMask[3]) b.gl!.colorMask(...nativeColorMask(s));
}
