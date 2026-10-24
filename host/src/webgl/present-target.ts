/**
 * Canvas-backed present target: the offscreen FBO a KMS master renders
 * into, blitted to the real default framebuffer once per `GLIO_PRESENT`.
 *
 * A guest draws one frame across many syscalls, and each syscall batch is
 * a separate kernel-worker task. The browser composites an OffscreenCanvas
 * at the end of any task that touched it, so a guest rendering straight to
 * the default framebuffer has its clear and its half-finished draws put on
 * screen — the whole picture blinks while a program that redraws its scene
 * every frame is running. Real double buffering hides exactly this: the
 * scanout keeps showing the front buffer until a flip completes.
 *
 * Interposing an FBO restores that property with no guest-visible change.
 * `bridge.ts` already redirects "bind framebuffer 0" to
 * `binding.renderTargetFbo`, so pointing that at this FBO sends every
 * default-framebuffer draw offscreen; the blit here is the flip.
 *
 * GPU-tier producers already render into a bo's FBO and are left alone —
 * their output is sampled by a compositor, never composited by the browser.
 */
import type { GlBinding } from "./registry.js";
import { repairNativeState } from "./native-recovery.js";
import { replaceSurfaceTarget, type GlSurfaceResources } from "./surface-resources.js";

const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_DRAW_FRAMEBUFFER = 0x8ca9;
const GL_READ_FRAMEBUFFER_BINDING = 0x8caa;
const GL_DRAW_FRAMEBUFFER_BINDING = 0x8ca6;

/** Point `b.renderTargetFbo` at an offscreen color buffer matching the
 *  canvas, creating or resizing it as needed. No-op for a session that
 *  already renders into a GPU bo, or one without a canvas. Returns true
 *  when the binding has a usable present target. */
export function ensurePresentTarget(b: GlBinding): boolean {
  const canvas = b.canvas;
  const size = b.surface.fixedSize ? b.surfaceSize : null;
  return canvas ? resizeSurfaceTarget(b, size?.width ?? canvas.width, size?.height ?? canvas.height) : false;
}

/** Allocate one surface's storage on its renderer. Explicit dimensions also
 * support independently sized offscreen draw/read targets; allocation does
 * not require another canvas or WebGL context. */
export function resizeSurfaceTarget(b: GlBinding, w: number, h: number): boolean {
  const gl = b.gl;
  if (!gl || gl.isContextLost() || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1
      || w > 0x7fff_ffff || h > 0x7fff_ffff) return false;
  if (b.renderTargetFbo && !b.presentTarget) return false;
  if (b.surface.gl && b.surface.gl !== gl) return false;
  if (!repairNativeState(gl)) return false;
  const existing = b.presentTarget;
  if (existing && existing.w === w && existing.h === h) return true;
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevRead = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevDraw = gl.getParameter(GL_DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevRbo = gl.getParameter(gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null;
  let depthStencil: WebGLRenderbuffer | null = null;
  let tex: WebGLTexture | null = null;
  let fbo: WebGLFramebuffer | null = null;
  let accepted = false;
  try {
    // Resize into a candidate. Mutating the old texture/renderbuffer would
    // destroy the last valid drawable before allocation can be acknowledged.
    depthStencil = gl.createRenderbuffer(); tex = gl.createTexture(); fbo = gl.createFramebuffer();
    if (!tex || !fbo || !depthStencil) return false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(GL_DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    gl.framebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthStencil);
    if (gl.checkFramebufferStatus(GL_DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
    accepted = true;
  } catch { return false; }
  finally {
    gl.bindRenderbuffer(gl.RENDERBUFFER, prevRbo);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    // A successful resize preserves the logical default binding. User FBOs
    // and independent read/draw selections keep their original bindings.
    gl.bindFramebuffer(GL_READ_FRAMEBUFFER, accepted && existing && prevRead === existing.fbo ? fbo : prevRead);
    gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, accepted && existing && prevDraw === existing.fbo ? fbo : prevDraw);
    if (!accepted) {
      if (fbo) gl.deleteFramebuffer(fbo);
      if (tex) gl.deleteTexture(tex);
      if (depthStencil) gl.deleteRenderbuffer(depthStencil);
    }
  }
  b.surface.gl = gl;
  replaceSurfaceTarget(b.surface, { fbo: fbo!, tex: tex!, depthStencil: depthStencil!, w, h }, b);
  if (existing) {
    gl.deleteFramebuffer(existing.fbo); gl.deleteTexture(existing.tex); gl.deleteRenderbuffer(existing.depthStencil);
  }
  return true;
}

/** Blit the present target onto the real default framebuffer. This is the
 *  buffer flip: the first composite after it shows a whole frame. */
export function blitPresentTarget(b: GlBinding, surface: GlSurfaceResources = b.drawSurface ?? b.surface): void {
  const gl = b.gl;
  const target = surface.presentTarget;
  if (!gl || !target) return;

  const prevRead = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevDraw = gl.getParameter(GL_DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const scissor = gl.getParameter(gl.SCISSOR_TEST) as boolean;
  // A guest scissor would clip the blit to its last draw's rectangle.
  if (scissor) gl.disable(gl.SCISSOR_TEST);

  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, target.fbo);
  gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(
    0, 0, target.w, target.h,
    0, 0, target.w, target.h,
    gl.COLOR_BUFFER_BIT, gl.NEAREST,
  );

  if (scissor) gl.enable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, prevRead);
  gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, prevDraw);
}

/** Show a GPU-tier scanout buffer: blit `bo`'s FBO onto the default
 *  framebuffer of the canvas `b` claimed. A renderer that draws into its
 *  own scanout buffers (wlroots) never presents a window surface; the
 *  page flip that latches the buffer is its present. KMS buffers hold the
 *  top row first, so the blit flips Y onto the bottom-up default
 *  framebuffer. */
export function blitGpuScanout(
  b: GlBinding,
  bo: { fbo: WebGLFramebuffer },
  width: number,
  height: number,
): void {
  const gl = b.gl;
  if (!gl) return;

  const prevRead = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevDraw = gl.getParameter(GL_DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const scissor = gl.getParameter(gl.SCISSOR_TEST) as boolean;
  if (scissor) gl.disable(gl.SCISSOR_TEST);

  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, bo.fbo);
  gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(
    0, 0, width, height,
    0, height, width, 0,
    gl.COLOR_BUFFER_BIT, gl.NEAREST,
  );

  if (scissor) gl.enable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, prevRead);
  gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, prevDraw);
}
