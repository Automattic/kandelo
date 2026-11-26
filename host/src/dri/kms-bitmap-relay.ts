import type { KmsCursorUpdate } from "./cursor-plane.js";

/** Bounded device-only transport. No guest memory enters this relay. A single
 * capture or published bundle remains owned until its exact acknowledgement.
 * Retirement waits for native capture settlement and an ordered display fence. */
export class KmsBitmapRelay {
  private retiring = false;
  private ready = false;
  private closed = false;
  private active = 0;
  private next = 0;
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
      if (value?.type === 'ready' && !this.ready) {
        this.ready = true;
        clearTimeout(this.initializationTimer);
      } else if (value?.type === 'ack' && this.active !== 0 && value.sequence === this.active
          && value.sequence === this.published) {
        this.active = 0;
      } else if (value?.type === 'retired' && this.retiring && this.retireSent
          && value.sequence === this.published && this.active === 0) {
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
    if (!this.ready || this.retiring || this.active) return;
    const primaryChanged = this.version !== this.sentVersion;
    const last = this.sentCursor;
    const cursorChanged = this.hasCursor && cursor && (!last || cursor.cursor.version !== last.cursor.version
      || cursor.width !== last.width || cursor.height !== last.height
      || cursor.composited !== last.composited);
    if (!primaryChanged && !cursorChanged) return;
    if (primaryChanged && (!Number.isInteger(canvas.width) || canvas.width < 1 || canvas.width > 3840
        || !Number.isInteger(canvas.height) || canvas.height < 1 || canvas.height > 2160)) {
      this.stop(new Error('KMS bitmap presentation exceeds its device extent'));
      return;
    }
    this.active = ++this.next;
    this.captureInFlight = this.publish(primaryChanged ? canvas : undefined,
      cursorChanged ? cursor : undefined, this.version, this.active);
  }

  private async publish(canvas: OffscreenCanvas | undefined, update: KmsCursorUpdate | undefined,
    version: number, sequence: number): Promise<void> {
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
      this.port.postMessage({ type: 'frame', sequence, frame, cursor }, frame ? [frame] : []);
      this.published = sequence;
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
