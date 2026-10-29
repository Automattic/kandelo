import type { GlBinding } from "./registry.js";

/**
 * Build a binding's own WebGL2 context on `canvas` and record it as `b.gl`.
 * Returns null, leaving the binding inert, when the canvas has no WebGL2.
 */
export function createBindingWebGl2Context(
  b: GlBinding,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): WebGL2RenderingContext | null {
  const ctx = canvas.getContext("webgl2", {
    antialias: false,
    premultipliedAlpha: false,
    depth: true,
    stencil: true,
    preserveDrawingBuffer: true,
  }) as WebGL2RenderingContext | null;
  if (ctx) {
    // Mirror main-forward.ts: enable the WebGL2 float extensions so
    // RGBA16F framebuffers are renderable and float textures accept
    // LINEAR filtering. Without these, ping-pong sims (Pavel-style
    // fluid, GPU-side image processing) hit
    // GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT silently.
    ctx.getExtension("EXT_color_buffer_float");
    ctx.getExtension("OES_texture_float_linear");
    ctx.getExtension("EXT_float_blend");
    // Seed the shadow viewport with the actual WebGL2 default (the
    // canvas drawing-buffer size). Otherwise `defaultShadow()`'s
    // [0,0,0,0] reaches the context through `GlMuxer.switchTo` the
    // first time sessions share it and clobbers the implicit default
    // viewport, so a program that never calls glViewport (SDL2's
    // KMSDRM/OpenGLES backend) draws into a 0×0 region.
    b.shadow.viewport = [0, 0, canvas.width, canvas.height];
  }
  b.gl = ctx;
  return ctx;
}
