import type { KmsCursorUpdate } from "./cursor-plane.js";

/** Bounded device-only transport. No guest memory enters this relay. One
 * primary bundle and one unchanged cursor image's motion may be in flight.
 * Retirement waits for native capture settlement and an ordered display fence. */
export class KmsBitmapRelay {
  private retiring = false;
  private ready = false;
  private closed = false;
  private active: number | 'capturing' = 0;
  private captureHasCursor = false;
  private pendingMove = 0;
  private published = 0;
  private version = 0;
  private sentVersion = 0;
  private sentCursor: KmsCursorUpdate | undefined;
  private captureInFlight: Promise<void> | undefined;
  private retirement: Promise<void> | undefined;
  private resolveRetirement: (() => void) | undefined;
  private rejectRetirement: ((error: Error) => void) | undefined;
  private initializationTimer: ReturnType<typeof setTimeout> | undefined;
  private retirementTimer: ReturnType<typeof setTimeout> | undefined;
  private retireSent = false;
  private failure: Error | undefined;

  constructor(private readonly port: MessagePort, private readonly fail: (error: Error) => void,
    readonly hasCursor: boolean,
    private readonly captureImage: (source: OffscreenCanvas) => ImageBitmap | Promise<ImageBitmap>
      = source => createImageBitmap(source),
    private readonly retirementTimeoutMs = 3000) {
    port.onmessage = event => {
      if (this.closed) return;
      const value = event.data;
      const active = this.active === 'capturing' ? 0 : this.active;
      const nextAck = active && this.pendingMove ? Math.min(active, this.pendingMove) : active || this.pendingMove;
      if (value?.type === 'ready' && !this.ready) {
        this.ready = true;
        clearTimeout(this.initializationTimer);
      } else if (value?.type === 'ack' && nextAck !== 0 && value.sequence === nextAck) {
        if (nextAck === active) this.active = 0;
        else this.pendingMove = 0;
      } else if (value?.type === 'retired' && this.retiring && this.retireSent
          && value.sequence === this.published && this.active === 0 && this.pendingMove === 0) {
        this.finish();
      } else {
        this.stop(new Error('Invalid KMS bitmap presentation acknowledgement'));
      }
    };
    port.onmessageerror = () => this.stop(new Error('Invalid KMS bitmap presentation message'));
    this.initializationTimer = setTimeout(() => {
      this.stop(new Error('KMS bitmap display did not become ready; device realm containment required'));
    }, this.retirementTimeoutMs);
    port.start();
  }
  changed(): void { if (!this.retiring) this.version++; }

  present(canvas: OffscreenCanvas, cursor?: KmsCursorUpdate): void {
    // [RUNTIME-WORKAROUND: FIREFOX-BITMAP-PORT-STARTUP] Suspected native
    // deserialization failure when images precede receiver initialization.
    // Keep dirty versions until the disposable display owns its contexts.
    if (!this.ready || this.retiring) return;
    const primaryChanged = this.version !== this.sentVersion;
    const last = this.sentCursor;
    let cursorChanged = this.hasCursor && cursor && (!last || cursor.cursor.version !== last.cursor.version
      || cursor.width !== last.width || cursor.height !== last.height
      || cursor.composited !== last.composited);
    // Both transfers share the ordered port. A move can use the image that
    // was already sent, provided no capture owns an unsent cursor transition.
    if (cursorChanged && cursor && last && (this.active !== 'capturing' || !this.captureHasCursor)
        && !last.composited && !cursor.composited && last.width === cursor.width && last.height === cursor.height
        && cursor.width === canvas.width && cursor.height === canvas.height
        && last.cursor.pixels !== null && last.cursor.pixels === cursor.cursor.pixels
        && last.cursor.width === cursor.cursor.width && last.cursor.height === cursor.cursor.height
        && (last.cursor.x !== cursor.cursor.x || last.cursor.y !== cursor.cursor.y)) {
      if (this.pendingMove === 0) {
        const { version, x, y } = cursor.cursor;
        const sequence = this.published + 1;
        try {
          this.port.postMessage({ type: 'frame', sequence, position: { version, x, y } });
          this.published = this.pendingMove = sequence;
          this.sentCursor = cursor;
        } catch (error) {
          this.stop(new Error('KMS cursor position transfer failed', { cause: error }));
          return;
        }
      }
      cursorChanged = false;
    }
    if (this.active || (!primaryChanged && !cursorChanged)) return;
    if (primaryChanged && (!Number.isInteger(canvas.width) || canvas.width < 1 || canvas.width > 3840
        || !Number.isInteger(canvas.height) || canvas.height < 1 || canvas.height > 2160)) {
      this.stop(new Error('KMS bitmap presentation exceeds its device extent'));
      return;
    }
    this.captureHasCursor = Boolean(cursorChanged);
    this.active = 'capturing';
    this.captureInFlight = this.publish(primaryChanged ? canvas : undefined,
      cursorChanged ? cursor : undefined, this.version);
  }

  private async publish(canvas: OffscreenCanvas | undefined, update: KmsCursorUpdate | undefined,
    version: number): Promise<void> {
    let frame: ImageBitmap | undefined;
    try {
      // Snapshot the primary's retained canvas. Consuming it would invalidate
      // renderer caches and partial redraws that still own its previous pixels.
      if (canvas) frame = await this.captureImage(canvas);
    } catch (error) {
      this.active = 0;
      if (!this.retiring) this.stop(new Error('KMS bitmap capture failed', { cause: error }));
      return;
    }
    if (this.retiring) {
      frame?.close();
      this.active = 0;
      return;
    }
    try {
      let cursor: KmsCursorUpdate | undefined;
      if (update) {
        const { version, x, y, width, height, pixels } = update.cursor;
        // Clone only the small cursor image. Its premultiplied form is local
        // to the producer's gamma stage. No guest backing leaves that realm.
        cursor = { width: update.width, height: update.height, composited: update.composited,
          cursor: { version, x, y, width, height, pixels: update.composited ? null : pixels } };
      }
      const sequence = this.published + 1;
      this.port.postMessage({ type: 'frame', sequence, frame, cursor }, frame ? [frame] : []);
      this.published = this.active = sequence;
      if (frame) this.sentVersion = version;
      if (update) this.sentCursor = update;
    } catch (error) {
      frame?.close();
      this.active = 0;
      this.stop(new Error('KMS bitmap transfer failed', { cause: error }));
    }
  }
  private stop(error: Error): void {
    if (!this.failure) {
      this.failure = error;
      // Retain the failure for an awaited close, even when the initiating caller
      // is a synchronous device callback. Its cleanup rejection is observed here.
      void this.close().catch(() => {});
      this.fail(error);
    }
  }
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.initializationTimer);
    clearTimeout(this.retirementTimer);
    this.port.onmessage = null;
    this.port.onmessageerror = null;
    this.port.close();
    this.sentCursor = undefined;
    if (this.failure) this.rejectRetirement?.(this.failure);
    else this.resolveRetirement?.();
    this.resolveRetirement = undefined;
    this.rejectRetirement = undefined;
  }
  close(): Promise<void> {
    if (this.retirement) return this.retirement;
    this.retiring = true;
    clearTimeout(this.initializationTimer);
    this.retirement = new Promise<void>((resolve, reject) => {
      this.resolveRetirement = resolve;
      this.rejectRetirement = reject;
    });
    this.retirementTimer = setTimeout(() => {
      const error = new Error('KMS bitmap retirement was not acknowledged; device realm containment required');
      this.stop(error);
      this.finish();
    }, this.retirementTimeoutMs);
    void Promise.resolve(this.captureInFlight).then(() => {
      if (this.closed) return;
      try {
        this.retireSent = true;
        this.port.postMessage({ type: 'retire', sequence: this.published });
      } catch (error) {
        this.stop(new Error('KMS bitmap retirement transfer failed', { cause: error }));
        this.finish();
      }
    });
    return this.retirement;
  }
}
