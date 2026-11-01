import type { GlBinding, GlContextExecutionLease, GlContextRegistry } from "./registry.js";
import type { GlMuxer } from "./muxer.js";
import type { GlDrawableBinding } from "./current.js";
import { defaultFramebuffer, logicalDefaultFramebuffer, isDefaultFramebuffer } from "./framebuffer.js";
import { retainSurfaceStorage, type GlSurfaceStorageLease } from "./surface-resources.js";

/** Per-work selectors contain native handles and copied scalars only. The
 * logical surface may resize or disappear while this allocation is retained. */
export type GlExecutionDrawable = Readonly<{
  drawable: Readonly<GlDrawableBinding> | null;
  drawFramebuffer: WebGLFramebuffer | null;
  readFramebuffer: WebGLFramebuffer | null;
  drawSurfaceId: number | null;
  readSurfaceId: number | null;
  drawWidth: number;
  drawHeight: number;
  readWidth: number;
  readHeight: number;
}>;

export class GlSubmitExecution {
  private contextLease: GlContextExecutionLease | null = null;
  private drawLease: GlSurfaceStorageLease | null = null;
  private readLease: GlSurfaceStorageLease | null = null;
  private selectors: GlExecutionDrawable | null = null;
  private rawCanvas: GlBinding["canvas"] = null;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private closed = false;
  private readonly contextId: number | null;
  private readonly pid: number;
  private readonly sessionId: number;
  private muxer: WeakRef<GlMuxer>;
  admitted = false;
  get context(): WebGL2RenderingContext | null { return this.contextLease?.context ?? null; }

  private constructor(readonly binding: GlBinding, muxer: GlMuxer) {
    this.muxer = new WeakRef(muxer);
    this.contextId = binding.contextId;
    this.pid = binding.pid;
    this.sessionId = binding.sessionId;
  }

  static capture(registry: GlContextRegistry, binding: GlBinding, muxer: GlMuxer): GlSubmitExecution | null {
    // Allocate the cleanup owner before taking the first reference. A failed
    // candidate is returned for queue-owned rollback, never acknowledged.
    const work = new GlSubmitExecution(binding, muxer);
    work.contextLease = registry.retainContextExecution(binding.pid, binding.sessionId, muxer);
    if (!work.contextLease) return null;
    try {
      const current = binding.currentDrawable;
      const drawable = current ? Object.freeze({ drawSurfaceId: current.drawSurfaceId,
        readSurfaceId: current.readSurfaceId, width: current.width, height: current.height }) : null;
      const drawFramebuffer = logicalDefaultFramebuffer(binding);
      const readFramebuffer = logicalDefaultFramebuffer(binding, true);
      const draw = binding.drawSurface ?? binding.surface;
      const read = binding.readSurface ?? binding.surface;
      if (drawable?.drawSurfaceId !== 0 && drawFramebuffer) {
        if (draw.gl !== binding.gl) return work;
        work.drawLease = retainSurfaceStorage(draw);
        if (!work.drawLease || work.drawLease.framebuffer !== drawFramebuffer) return work;
      }
      if (drawable?.readSurfaceId !== 0 && readFramebuffer) {
        if (read.gl !== binding.gl) return work;
        work.readLease = retainSurfaceStorage(read);
        if (!work.readLease || work.readLease.framebuffer !== readFramebuffer) return work;
      }
      work.selectors = Object.freeze({ drawable, drawFramebuffer, readFramebuffer,
        drawSurfaceId: drawable?.drawSurfaceId ?? draw.surfaceId,
        readSurfaceId: drawable?.readSurfaceId ?? read.surfaceId,
        drawWidth: work.drawLease?.width ?? drawable?.width ?? draw.surfaceSize?.width ?? binding.canvas?.width ?? 0,
        drawHeight: work.drawLease?.height ?? drawable?.height ?? draw.surfaceSize?.height ?? binding.canvas?.height ?? 0,
        readWidth: work.readLease?.width ?? drawable?.width ?? read.surfaceSize?.width ?? binding.canvas?.width ?? 0,
        readHeight: work.readLease?.height ?? drawable?.height ?? read.surfaceSize?.height ?? binding.canvas?.height ?? 0 });
      if ((!drawFramebuffer || !readFramebuffer) && binding.canvas) {
        // WebGL exposes no lease for an old default drawing buffer. Do not
        // silently execute against replacement canvas storage after resize.
        // General deferred waits still need owned offscreen storage here.
        work.rawCanvas = binding.canvas;
        work.canvasWidth = binding.canvas.width;
        work.canvasHeight = binding.canvas.height;
      }
      work.admitted = true;
    } catch { /* The returned candidate owns every acquired rollback reference. */ }
    return work;
  }

  run<T>(work: () => T): T {
    const b = this.binding, selectors = this.selectors, muxer = this.muxer.deref();
    if (!this.admitted || this.closed || !selectors || !this.contextLease || !muxer
        || this.contextLease.context !== b.gl || b.pid !== this.pid || b.sessionId !== this.sessionId
        || b.contextId !== this.contextId || (this.rawCanvas &&
          (this.rawCanvas.width !== this.canvasWidth || this.rawCanvas.height !== this.canvasHeight))) {
      throw new Error("GL submission execution owner is unavailable");
    }
    const previous = b.executionDrawable;
    const drawDefault = isDefaultFramebuffer(b, b.shadow.fbo);
    const readDefault = isDefaultFramebuffer(b, b.shadow.readFbo);
    const selectorsChanged = (drawDefault && b.shadow.fbo !== selectors.drawFramebuffer)
      || (readDefault && b.shadow.readFbo !== selectors.readFramebuffer);
    b.executionDrawable = selectors;
    if (drawDefault) b.shadow.fbo = selectors.drawFramebuffer;
    if (readDefault) b.shadow.readFbo = selectors.readFramebuffer;
    try {
      if (selectorsChanged) muxer.invalidateExecutionSelection();
      return work();
    }
    finally {
      // GL commands can select a user FBO. Preserve that state while mapping
      // the temporary default back onto the live logical drawable afterward.
      const drawBefore = b.shadow.fbo, readBefore = b.shadow.readFbo;
      if (b.executionDrawable === selectors) {
        b.executionDrawable = previous;
        if (b.shadow.fbo === selectors.drawFramebuffer) b.shadow.fbo = defaultFramebuffer(b);
        if (b.shadow.readFbo === selectors.readFramebuffer) b.shadow.readFbo = defaultFramebuffer(b, true);
      }
      if (drawBefore !== b.shadow.fbo || readBefore !== b.shadow.readFbo) muxer.invalidateExecutionSelection();
    }
  }

  release(): boolean {
    this.closed = true;
    try {
      // Cancellation may run while a different logical owner is selected.
      // Preserve its GL flags before any retained storage can be collected.
      this.muxer.deref()?.captureCurrentErrors();
      if (this.drawLease && !this.drawLease.release(null)) return false;
      this.drawLease = null;
      if (this.readLease && !this.readLease.release(null)) return false;
      this.readLease = null;
      if (this.contextLease && !this.contextLease.release()) return false;
      this.contextLease = null;
      return true;
    } catch { return false; }
  }
}
