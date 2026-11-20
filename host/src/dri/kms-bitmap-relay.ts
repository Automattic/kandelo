/** Bounded device-only transport. No guest memory enters this relay. A single
 * capture or published bundle remains owned until its exact acknowledgement.
 * Retirement waits for native capture settlement and an ordered display fence. */
export class KmsBitmapRelay {
  private retiring = false;
  private closed = false;
  private active = 0;
  private next = 0;
  private published = 0;
  private versions = [0, 0];
  private sentVersions = [0, 0];
  private captureInFlight: Promise<void> | undefined;
  private retirement: Promise<void> | undefined;
  private resolveRetirement: (() => void) | undefined;
  private rejectRetirement: ((error: Error) => void) | undefined;
  private retirementTimer: ReturnType<typeof setTimeout> | undefined;
  private retireSent = false;
  private failure: Error | undefined;

  constructor(private readonly port: MessagePort, private readonly fail: (error: Error) => void,
    private readonly captureImage: (source: OffscreenCanvas) => ImageBitmap | Promise<ImageBitmap>
      = source => createImageBitmap(source),
    private readonly retirementTimeoutMs = 3000) {
    port.onmessage = event => {
      if (this.closed) return;
      const value = event.data;
      if (value?.type === 'ack' && this.active !== 0 && value.sequence === this.active
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
    port.start();
  }
  changed(plane: 0 | 1): void { if (!this.retiring) this.versions[plane]++; }
  present(canvas: OffscreenCanvas, cursor?: OffscreenCanvas): void {
    if (this.retiring || this.active) return;
    const planes = (cursor ? [0, 1] : [0]).filter(plane => this.versions[plane] !== this.sentVersions[plane]);
    if (!planes.length) return;
    const versions = planes.map(plane => this.versions[plane]);
    const sources = planes.map(plane => plane === 0 ? canvas : cursor!);
    if (sources.some(source => !Number.isInteger(source.width) || source.width < 1 || source.width > 3840
        || !Number.isInteger(source.height) || source.height < 1 || source.height > 2160)) {
      this.stop(new Error('KMS bitmap presentation exceeds its device extent'));
      return;
    }
    this.active = ++this.next;
    this.captureInFlight = this.capture(sources, planes, versions, this.active);
  }
  private async capture(sources: OffscreenCanvas[], planes: number[], versions: number[], sequence: number): Promise<void> {
    // Snapshot the producer's retained canvas. Consuming it would invalidate
    // renderer caches and partial redraws that still own its previous pixels.
    // allSettled also releases a successful sibling after another capture fails.
    const results = await Promise.allSettled(sources.map(source => {
      try { return this.captureImage(source); } catch (error) { return Promise.reject(error); }
    }));
    const frames: ImageBitmap[] = [];
    let failure: unknown;
    let failed = false;
    for (const result of results) {
      if (result.status === 'fulfilled') frames.push(result.value); else { failed = true; failure = result.reason; }
    }
    if (this.retiring || failed) {
      for (const frame of frames) frame.close();
      this.active = 0;
      if (failed && !this.retiring) this.stop(new Error('KMS bitmap capture failed', { cause: failure }));
      return;
    }
    try {
      this.port.postMessage({ type: 'frame', sequence, planes, frames }, frames);
      this.published = sequence;
      for (let i = 0; i < planes.length; i++) this.sentVersions[planes[i]] = versions[i];
    } catch (error) {
      for (const frame of frames) frame.close();
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
    clearTimeout(this.retirementTimer);
    this.port.onmessage = null;
    this.port.onmessageerror = null;
    this.port.close();
    if (this.failure) this.rejectRetirement?.(this.failure);
    else this.resolveRetirement?.();
    this.resolveRetirement = undefined;
    this.rejectRetirement = undefined;
  }
  close(): Promise<void> {
    if (this.retirement) return this.retirement;
    this.retiring = true;
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
