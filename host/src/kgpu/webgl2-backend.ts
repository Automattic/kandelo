/**
 * The kgpu backend over WebGL 2, for a GPU worker.
 *
 * Ownership: one GPU worker owns one WebGL 2 context (from an
 * `OffscreenCanvas(1, 1)` in browsers, or an embedder's factory on Node) and
 * this backend owns every GL object in it. Each kgpu context gets its own
 * framebuffer object with an RGBA8 renderbuffer of the surface size; the 1x1
 * canvas is never drawn to.
 *
 * WHY per-context state is kept here: all kgpu contexts share one GL
 * context, whose clear color and viewport are global, so each kgpu
 * context's values are recorded and applied whenever that context's work
 * runs. Nothing a guest can observe is decided here; the executor validated
 * every call before making it.
 *
 * A `webglcontextlost` event makes `isLost()` true for good and calls
 * `onLost` once. The GPU worker treats that as the death of its renderer:
 * it reports itself failed, so the kernel worker terminates it and resets
 * the device (every context lost, no renderer until a restart) instead of
 * leaving a device that claims a renderer it no longer has.
 */
import { EEXIST, EIO, ENOENT, ENOMEM, type KgpuBackend } from "./backend.ts";

// WebGL 2 enumerants (the WebGL 2 specification's values), named here so the
// backend does not depend on the context object exposing them.
const GL = {
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  RGBA8: 0x8058,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  SCISSOR_TEST: 0x0c11,
  PACK_ALIGNMENT: 0x0d05,
  NO_ERROR: 0,
} as const;

/** The subset of `WebGL2RenderingContext` the backend uses. */
export interface KgpuGl {
  createFramebuffer(): unknown;
  createRenderbuffer(): unknown;
  deleteFramebuffer(framebuffer: unknown): void;
  deleteRenderbuffer(renderbuffer: unknown): void;
  bindFramebuffer(target: number, framebuffer: unknown): void;
  bindRenderbuffer(target: number, renderbuffer: unknown): void;
  renderbufferStorage(target: number, format: number, width: number, height: number): void;
  framebufferRenderbuffer(target: number, attachment: number, renderbufferTarget: number, renderbuffer: unknown): void;
  checkFramebufferStatus(target: number): number;
  viewport(x: number, y: number, w: number, h: number): void;
  disable(capability: number): void;
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void;
  pixelStorei(name: number, value: number): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, out: Uint8Array): void;
  getError(): number;
  isContextLost(): boolean;
}

interface Surface {
  framebuffer: unknown;
  renderbuffer: unknown;
  viewport: [number, number, number, number];
  clearColor: [number, number, number, number];
}

/** What a WebGL 2 factory returns: the context, and the canvas whose
 * `webglcontextlost` event reports its loss (if it has one). */
export interface KgpuWebgl2Context {
  gl: KgpuGl;
  canvas: EventTarget | null;
}

/** The browser's renderer: a WebGL 2 context on a 1x1 OffscreenCanvas, or
 * null when this realm cannot create one. */
export function createOffscreenWebgl2(): KgpuWebgl2Context | null {
  if (typeof OffscreenCanvas !== "function") return null;
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2", {
    alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
  }) as unknown as KgpuGl | null;
  return gl ? { gl, canvas } : null;
}

export function createWebgl2Backend({ gl, canvas }: KgpuWebgl2Context, onLost?: () => void): KgpuBackend {
  const surfaces = new Map<number, Surface>();
  let lost = false;
  canvas?.addEventListener("webglcontextlost", (event) => {
    // Without preventDefault the browser never offers a restore; slice 1
    // does not restore either, but the loss must stay observable.
    event.preventDefault();
    if (lost) return;
    lost = true;
    // The event can fire inside a GL call the executor made, so the owner
    // only records it here and acts once that call has returned.
    onLost?.();
  });
  const isLost = () => lost || gl.isContextLost();
  const bind = (context: number): Surface | null => {
    const surface = surfaces.get(context);
    if (!surface) return null;
    gl.bindFramebuffer(GL.FRAMEBUFFER, surface.framebuffer);
    return surface;
  };
  return {
    createSurface(context, width, height) {
      if (surfaces.has(context)) return -EEXIST;
      if (isLost()) return -EIO;
      const framebuffer = gl.createFramebuffer();
      const renderbuffer = gl.createRenderbuffer();
      if (!framebuffer || !renderbuffer) return -ENOMEM;
      gl.bindRenderbuffer(GL.RENDERBUFFER, renderbuffer);
      gl.renderbufferStorage(GL.RENDERBUFFER, GL.RGBA8, width, height);
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, renderbuffer);
      const complete = gl.checkFramebufferStatus(GL.FRAMEBUFFER) === GL.FRAMEBUFFER_COMPLETE;
      if (!complete || gl.getError() !== GL.NO_ERROR) {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteRenderbuffer(renderbuffer);
        return -EIO;
      }
      surfaces.set(context, {
        framebuffer, renderbuffer, viewport: [0, 0, width, height], clearColor: [0, 0, 0, 0],
      });
      return 0;
    },
    destroySurface(context) {
      const surface = surfaces.get(context);
      if (!surface) return;
      surfaces.delete(context);
      gl.deleteFramebuffer(surface.framebuffer);
      gl.deleteRenderbuffer(surface.renderbuffer);
    },
    viewport(context, x, y, w, h) {
      const surface = surfaces.get(context);
      if (surface) surface.viewport = [x, y, w, h];
    },
    clearColor(context, r, g, b, a) {
      const surface = surfaces.get(context);
      if (surface) surface.clearColor = [r, g, b, a];
    },
    clear(context, mask) {
      const surface = bind(context);
      if (!surface) return;
      // Clears ignore the viewport but obey the scissor and color mask,
      // which this backend never changes from their defaults; set them
      // anyway so a future draw path cannot leak state into a clear.
      gl.disable(GL.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.viewport(...surface.viewport);
      gl.clearColor(...surface.clearColor);
      gl.clear(mask);
    },
    readPixels(context, x, y, w, h, out) {
      if (!bind(context)) return -ENOENT;
      gl.pixelStorei(GL.PACK_ALIGNMENT, 4);
      gl.readPixels(x, y, w, h, GL.RGBA, GL.UNSIGNED_BYTE, out);
      return gl.getError() === GL.NO_ERROR && !isLost() ? 0 : -EIO;
    },
    isLost,
  };
}
