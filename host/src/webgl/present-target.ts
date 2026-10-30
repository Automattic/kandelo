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
import { applyNativeChanges, nativeInverse, repairNativeState, reserveNativeRetirement, retireNativeRetirement } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";
import { prepareSurfaceTargetReplacement, surfaceExecutionUsesFramebuffer, type GlPresentTarget, type GlSurfaceResources } from "./surface-resources.js";

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
  if (!gl || gl.isContextLost() || !Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0
      || w > 0x7fff_ffff || h > 0x7fff_ffff) return false;
  if (b.renderTargetFbo && !b.presentTarget) return false;
  if (b.surface.gl && b.surface.gl !== gl) return false;
  if (!repairNativeState(gl)) return false;
  const existing = b.presentTarget;
  if (existing && existing.w === w && existing.h === h) return true;
  // EGL-private allocation failures use their own error channel. The caller
  // captures the outgoing logical owner's errors before entering this utility.
  const owner = {gl,errors:[] as number[]};
  let active = 0, prevTex: WebGLTexture|null = null, prevRead: WebGLFramebuffer|null = null;
  let prevDraw: WebGLFramebuffer|null = null, prevRbo: WebGLRenderbuffer|null = null;
  if (!checkedGlCall(owner, () => {
    active = gl.getParameter(0x84e0);
    prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    prevRead = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING);
    prevDraw = gl.getParameter(GL_DRAW_FRAMEBUFFER_BINDING);
    prevRbo = gl.getParameter(gl.RENDERBUFFER_BINDING);
  })) return false;
  if (!Number.isInteger(active) || active < 0x84c0) return false;
  const retirement = reserveNativeRetirement(owner,[["deleteFramebuffer",null],["deleteTexture",null],["deleteRenderbuffer",null]]);
  if (!retirement) return false;
  let published = false;
  try {
    const target = {w,h,retirement,fbo:null,tex:null,depthStencil:null} as unknown as GlPresentTarget;
    const commit = prepareSurfaceTargetReplacement(b.surface,target,b);
    const utility = nativeInverse(owner,[["bindRenderbuffer",0x8d41,prevRbo]],
      [["activeTexture",active],["bindTexture",0x0de1,prevTex]]);
    const selectors = nativeInverse(owner,[["bindFramebuffer",GL_READ_FRAMEBUFFER,prevRead]],
      [["bindFramebuffer",GL_DRAW_FRAMEBUFFER,prevDraw]]);
    const accepted = applyNativeChanges({...owner,shadow:b.shadow},[
      {restore:{owner,groups:[...utility.groups,...selectors.groups]},apply:() => {
        if (!checkedGlCall(owner,()=>{ retirement.calls[2][1] = target.depthStencil = gl.createRenderbuffer()!; }) || !target.depthStencil) return false;
        if (!checkedGlCall(owner,()=>{ retirement.calls[1][1] = target.tex = gl.createTexture()!; }) || !target.tex) return false;
        if (!checkedGlCall(owner,()=>{ retirement.calls[0][1] = target.fbo = gl.createFramebuffer()!; }) || !target.fbo) return false;
        if (!checkedGlCall(owner,()=>gl.bindTexture(0x0de1,target.tex)) ||
            !checkedGlCall(owner,()=>gl.texImage2D(0x0de1,0,0x1908,Math.max(1,w),Math.max(1,h),0,0x1908,0x1401,null))) return false;
        for (const [pname,value] of [[0x2801,0x2601],[0x2800,0x2601],[0x2802,0x812f],[0x2803,0x812f]])
          if (!checkedGlCall(owner,()=>gl.texParameteri(0x0de1,pname,value))) return false;
        if (!checkedGlCall(owner,()=>gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER,target.fbo)) ||
            !checkedGlCall(owner,()=>gl.framebufferTexture2D(GL_DRAW_FRAMEBUFFER,0x8ce0,0x0de1,target.tex,0)) ||
            !checkedGlCall(owner,()=>gl.bindRenderbuffer(0x8d41,target.depthStencil)) ||
            !checkedGlCall(owner,()=>gl.renderbufferStorage(0x8d41,0x88f0,Math.max(1,w),Math.max(1,h))) ||
            !checkedGlCall(owner,()=>gl.framebufferRenderbuffer(GL_DRAW_FRAMEBUFFER,0x821a,0x8d41,target.depthStencil))) return false;
        let status = 0;
        return checkedGlCall(owner,()=>{status = gl.checkFramebufferStatus(GL_DRAW_FRAMEBUFFER);}) && status === 0x8cd5;
      }},
      {restore:nativeInverse(owner,[["bindFramebuffer",GL_READ_FRAMEBUFFER,prevRead]]),
        apply:()=>checkedGlCall(owner,()=>gl.bindFramebuffer(GL_READ_FRAMEBUFFER,existing && prevRead === existing.fbo && !surfaceExecutionUsesFramebuffer(b.surface,b,prevRead,true) ? target.fbo : prevRead))},
      {restore:nativeInverse(owner,[["bindFramebuffer",GL_DRAW_FRAMEBUFFER,prevDraw]]),
        apply:()=>checkedGlCall(owner,()=>gl.bindFramebuffer(GL_DRAW_FRAMEBUFFER,existing && prevDraw === existing.fbo && !surfaceExecutionUsesFramebuffer(b.surface,b,prevDraw,false) ? target.fbo : prevDraw))},
    ],{shared:true,finalizer:utility});
    if (!accepted) return false;
    b.surface.gl = gl; commit(); published = true;
    if (existing) retireNativeRetirement(existing.retirement);
    return true;
  } catch { return false; }
  finally { if (!published) retireNativeRetirement(retirement); }
}

/** Blit the present target onto the real default framebuffer. This is the
 *  buffer flip: the first composite after it shows a whole frame. */
export function blitPresentTarget(b: GlBinding, surface: GlSurfaceResources = b.drawSurface ?? b.surface): void {
  const gl = b.gl;
  const target = surface.presentTarget;
  if (!gl || !target) return;
  if (!repairNativeState(gl)) throw new Error("Native surface cleanup remains pending");

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
