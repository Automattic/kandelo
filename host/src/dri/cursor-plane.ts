/** KMS cursor plane, separate from the application's scanout surface. */
export interface KmsCursor {
  version: number;
  x: number;
  y: number;
  /** Signed virtualization hints; DRM x/y already locate the image origin. */
  hotX: number;
  hotY: number;
  width: number;
  height: number;
  /** Owned, straight-alpha RGBA bytes; never a view into guest memory. */
  pixels: Uint8ClampedArray<ArrayBuffer> | null;
  /** The same image as premultiplied RGBA, as the plane blends it. */
  premultiplied?: Uint8ClampedArray<ArrayBuffer> | null;
}

export class KmsCursorPlane {
  private context: OffscreenCanvasRenderingContext2D;
  private version = -1;
  private composited = false;
  private painted: { x: number; y: number; width: number; height: number } | null = null;
  constructor(private canvas: OffscreenCanvas) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("KMS cursor canvas requires a 2D context");
    this.context = context;
    // A restored 2D context has lost its bitmap even if the cursor did
    // not move. Replay the authoritative plane state on the next vblank.
    canvas.addEventListener("contextrestored", () => {
      this.version = -1;
      this.painted = null;
    });
  }

  /** `composited`: the CRTC has a color stage, so its presenter blends the
   *  cursor into the primary before the LUT (see kms-gamma.ts) and this
   *  overlay must show nothing, or the cursor would appear twice. */
  present(cursor: KmsCursor, width: number, height: number, composited = false): void {
    const resized = this.canvas.width !== width || this.canvas.height !== height;
    if (!resized && cursor.version === this.version && composited === this.composited) return;
    this.composited = composited;
    if (resized) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.painted = null;
    }
    this.version = cursor.version;
    if (this.painted) {
      const { x, y, width, height } = this.painted;
      this.context.clearRect(x, y, width, height);
      this.painted = null;
    }
    if (cursor.pixels && !composited) {
      this.context.putImageData(new ImageData(cursor.pixels, cursor.width, cursor.height),
        cursor.x, cursor.y);
      this.painted = { x: cursor.x, y: cursor.y,
        width: cursor.width, height: cursor.height };
    }
  }
}
