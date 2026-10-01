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

const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_DRAW_FRAMEBUFFER = 0x8ca9;
const GL_READ_FRAMEBUFFER_BINDING = 0x8caa;
const GL_DRAW_FRAMEBUFFER_BINDING = 0x8ca6;

/** Point `b.renderTargetFbo` at an offscreen color buffer matching the
 *  canvas, creating or resizing it as needed. No-op for a session that
 *  already renders into a GPU bo, or one without a canvas. Returns true
 *  when the binding has a usable present target. */
export function ensurePresentTarget(b: GlBinding): boolean {
  const gl = b.gl;
  const canvas = b.canvas;
  if (!gl || !canvas) return false;
  // A GPU-tier producer owns its render target; never displace it.
  if (b.renderTargetFbo && !b.presentTarget) return false;

  const w = canvas.width;
  const h = canvas.height;
  if (!(w >= 1) || !(h >= 1)) return false;

  const existing = b.presentTarget;
  if (existing && existing.w === w && existing.h === h) return true;

  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevRead = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevDraw = gl.getParameter(GL_DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

  const tex = existing?.tex ?? gl.createTexture();
  const fbo = existing?.fbo ?? gl.createFramebuffer();
  if (!tex || !fbo) return false;

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    GL_DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0,
  );
  const complete =
    gl.checkFramebufferStatus(GL_DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

  gl.bindTexture(gl.TEXTURE_2D, prevTex);
  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, prevRead);
  gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER, prevDraw);

  if (!complete) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    b.presentTarget = null;
    // Leave renderTargetFbo alone: without a target the guest keeps
    // rendering straight to the canvas, which flickers but still draws.
    return false;
  }

  b.presentTarget = { fbo, tex, w, h };
  b.renderTargetFbo = fbo;
  b.shadow.fbo = fbo;
  return true;
}

/** Blit the present target onto the real default framebuffer. This is the
 *  buffer flip: the first composite after it shows a whole frame. */
export function blitPresentTarget(b: GlBinding): void {
  const gl = b.gl;
  const target = b.presentTarget;
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
