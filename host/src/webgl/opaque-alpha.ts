import type { GlBinding } from "./registry.js";
import { renderbufferNative, textureNative } from "./image-storage.js";
import type { NativeCall, NativeChange } from "./native-recovery.js";
import { nativeInverse } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";

/**
 * Color formats without alpha that WebGL 2 can only store with alpha: an
 * RGB16F_EXT renderbuffer (GL_EXT_color_buffer_half_float; WebGL 2 has no
 * renderable RGB16F) is stored as RGBA16F, and XRGB8888/XBGR8888 GPU buffers
 * as RGBA8. As ANGLE does for RGB formats on RGBA storage, the stored alpha is
 * initialized to 1.0 and never written: while such storage is the draw
 * framebuffer's color attachment, draws and clears run with the native alpha
 * write mask off (the guest's logical COLOR_WRITEMASK is unchanged). Every
 * read of the storage (ReadPixels, CopyTex*, DST_ALPHA blending, sampling)
 * then observes alpha = 1, exactly the semantics of a format without alpha.
 *
 * Keyed by native storage, so EGLImage siblings that share the storage and
 * private views of it are covered too.
 */
const opaqueStorage = new WeakSet<object>();

export function setOpaqueAlphaStorage(native: object | null, opaque: boolean): void {
  if (!native) return;
  if (opaque) opaqueStorage.add(native); else opaqueStorage.delete(native);
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

/** True when draws and clears must not write native alpha: the guest writes
 * alpha (logical mask) into a draw framebuffer whose color storage has none. */
export function drawTargetLocksAlpha(b: GlBinding): boolean {
  const s = b.shadow;
  if (!s.colorMask[3] || !s.fbo) return false;
  const image = b.framebufferAttachments.get(s.fbo)?.get(0x8ce0);
  if (!image) return false;
  const native = image.kind === "texture" ? textureNative(b, image.object) : renderbufferNative(b, image.object);
  return isOpaqueAlphaStorage(native);
}

/** The native alpha lock as a journalled change plus its finalizer group,
 * restoring the guest's logical mask on success and on failure. */
export function alphaLock(b: GlBinding): { change: NativeChange; restore: NativeCall[] } {
  const gl = b.gl!, [r, g, bl, a] = b.shadow.colorMask;
  const restore: NativeCall[] = [["colorMask", r, g, bl, a]];
  return { restore, change: { apply: () => checkedGlCall(b, () => gl.colorMask(r, g, bl, false)),
    restore: nativeInverse(b, restore) } };
}
