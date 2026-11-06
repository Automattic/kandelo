import type { LazyFetch } from "./lazy-download-event";
import { streamLazyResourceBytes, type DeferredByteProgress } from "./lazy-fetch-bytes";
import { StorageMemoryBudget, StorageMetadataMap, storageEntryBytes, type StorageMemoryReservation } from "./storage-memory-budget";

export const MAX_DEFERRED_IO_BYTES = 64 * 1024;
export const DEFAULT_DEFERRED_IDLE_TIMEOUT_MS = 30_000;

export interface DeferredByteSource {
  readonly length: number;
  readAt(offset: number, destination: Uint8Array): number;
}

export interface DeferredByteStorage {
  readAt(offset: number, destination: Uint8Array): number;
  writeAt(offset: number, source: Uint8Array): number;
  close(): void | Promise<void>;
}

function ioFailure(): Error {
  return Object.assign(new Error("Deferred byte storage I/O failure"), { code: "EIO" });
}

export class DeferredByteSpool {
  private readonly controller = new AbortController();
  private readonly spans: StorageMetadataMap<string, { offset: number; capacity: number }>;
  private end = 0;
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private storageClosed = false;
  private progressAt: number | undefined;

  constructor(
    private readonly storage: DeferredByteStorage,
    private readonly idleTimeoutMs = DEFAULT_DEFERRED_IDLE_TIMEOUT_MS,
    readonly metadataBudget = new StorageMemoryBudget(),
    preparedSpans?: StorageMetadataMap<string, { offset: number; capacity: number }>,
  ) {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2 ** 31 - 1) {
      throw new RangeError("Invalid deferred byte transfer inactivity timeout");
    }
    this.spans = preparedSpans ?? new StorageMetadataMap(metadataBudget);
  }

  static async open(
    createStorage: () => DeferredByteStorage | Promise<DeferredByteStorage>,
    metadataBudget: StorageMemoryBudget,
  ): Promise<DeferredByteSpool> {
    const spans = new StorageMetadataMap<string, { offset: number; capacity: number }>(metadataBudget);
    let storage: DeferredByteStorage | undefined;
    try {
      storage = await createStorage();
      return new DeferredByteSpool(storage, DEFAULT_DEFERRED_IDLE_TIMEOUT_MS, metadataBudget, spans);
    } catch (error) {
      spans.dispose();
      try { await storage?.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Deferred storage acquisition cleanup failed"); }
      throw error;
    }
  }

  lastProgressAt(): number | undefined {
    return this.progressAt;
  }

  fetch(
    fetcher: LazyFetch,
    url: string,
    maxBytes: number,
    onProgress?: DeferredByteProgress,
  ): Promise<DeferredByteSource> {
    if (this.controller.signal.aborted) return Promise.reject(ioFailure());
    let admission: StorageMemoryReservation;
    try {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw ioFailure();
      admission = this.metadataBudget.reserve(storageEntryBytes(url) * 2);
    } catch (error) { return Promise.reject(error); }
    const result = this.pending.then(async () => {
      this.requireOpen();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw ioFailure();
      const key = `${maxBytes}:${url}`;
      const span = this.spans.get(key) ?? { offset: this.end, capacity: 0 };
      this.spans.set(key, span);
      let written = 0;
      const transfer = new AbortController();
      const abort = () => transfer.abort(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout>;
      const renew = () => {
        clearTimeout(timer);
        timer = setTimeout(() => transfer.abort(Object.assign(
          new Error(`Deferred byte transfer made no progress for ${this.idleTimeoutMs}ms`),
          { name: "TimeoutError", code: "ETIMEDOUT" },
        )), this.idleTimeoutMs);
      };
      const requireActive = () => {
        this.requireOpen();
        if (transfer.signal.aborted) throw transfer.signal.reason;
      };
      renew();
      try {
        const length = await streamLazyResourceBytes(fetcher, url, maxBytes, {
          reset: () => { requireActive(); written = 0; },
          write: (bytes) => {
            requireActive();
            let done = 0;
            while (done < bytes.byteLength) {
              requireActive();
              const chunk = bytes.subarray(done, done + MAX_DEFERRED_IO_BYTES);
              this.reserve(span, written + chunk.byteLength, maxBytes, written);
              const count = this.storage.writeAt(span.offset + written, chunk);
              if (!Number.isInteger(count) || count <= 0 || count > chunk.byteLength) throw ioFailure();
              written += count;
              done += count;
            }
            if (bytes.byteLength > 0) {
              this.progressAt = performance.now();
              renew();
            }
          },
        }, onProgress, transfer.signal);
        requireActive();
        if (written !== length) throw ioFailure();
        return this.sourceAt(span.offset, length);
      } finally {
        clearTimeout(timer!);
        this.controller.signal.removeEventListener("abort", abort);
      }
    });
    const admitted = result.finally(() => admission.release());
    this.pending = admitted.then(() => {}, () => {});
    return admitted;
  }

  private sourceAt(base: number, length: number): DeferredByteSource {
    return {
      length,
      readAt: (offset: number, destination: Uint8Array) => {
        if (this.storageClosed) throw ioFailure();
        if (!Number.isSafeInteger(offset) || offset < 0) throw ioFailure();
        const limit = Math.min(destination.byteLength, Math.max(0, length - offset));
        let done = 0;
        while (done < limit) {
          const chunk = destination.subarray(done, Math.min(limit, done + MAX_DEFERRED_IO_BYTES));
          const count = this.storage.readAt(base + offset + done, chunk);
          if (!Number.isInteger(count) || count <= 0 || count > chunk.byteLength) throw ioFailure();
          done += count;
        }
        return done;
      },
    };
  }

  cancelTransfers(): void {
    this.controller.abort();
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      this.cancelTransfers();
      this.storageClosed = true;
      this.spans.dispose();
      this.closing = Promise.resolve().then(() => this.storage.close());
    }
    return this.closing;
  }

  private requireOpen(): void {
    if (this.controller.signal.aborted) throw ioFailure();
  }

  private reserve(span: { offset: number; capacity: number }, needed: number, limit: number, prefix: number): void {
    if (needed <= span.capacity) return;
    if (needed > limit) throw ioFailure();
    if (span.offset + span.capacity === this.end) {
      const end = span.offset + needed;
      if (!Number.isSafeInteger(end)) throw ioFailure();
      span.capacity = needed;
      this.end = end;
      return;
    }
    const capacity = Math.min(limit, Math.max(needed, span.capacity * 2));
    const start = this.end;
    const end = start + capacity;
    if (!Number.isSafeInteger(end)) throw ioFailure();
    const previous = span.offset;
    span.offset = start;
    span.capacity = capacity;
    this.end = end;
    const scratch = new Uint8Array(Math.min(prefix, MAX_DEFERRED_IO_BYTES));
    let copied = 0;
    while (copied < prefix) {
      const chunk = scratch.subarray(0, Math.min(scratch.byteLength, prefix - copied));
      let filled = 0;
      while (filled < chunk.byteLength) {
        const count = this.storage.readAt(previous + copied + filled, chunk.subarray(filled));
        if (!Number.isInteger(count) || count <= 0 || count > chunk.byteLength - filled) throw ioFailure();
        filled += count;
      }
      let done = 0;
      while (done < filled) {
        const count = this.storage.writeAt(start + copied + done, chunk.subarray(done));
        if (!Number.isInteger(count) || count <= 0 || count > filled - done) throw ioFailure();
        done += count;
      }
      copied += filled;
    }
  }
}
