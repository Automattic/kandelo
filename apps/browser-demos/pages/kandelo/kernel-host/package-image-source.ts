import PackageSourceWorker from "./package-image-source-worker.ts?worker";
import { referenceOpfsFile } from "../../../../../host/src/vfs/opfs-file-reference";
import { PACKAGE_SOURCE_CHUNK_BYTES } from "../../../../../images/vfs/lib/package-image-source";
import type { PackageUpgradeSource } from "./package-upgrade-client";
import type { PackageImageSourceRequest, PackageImageSourceResponse } from "./package-image-source-protocol";

type Pending = { id: number; resolve(value: PackageImageSourceResponse): void; reject(error: unknown): void };

export class UnprovenPackageSourceCleanupError extends Error {
  readonly retainTarget = true;
  constructor(cause: unknown) {
    super("Package source cleanup is unconfirmed; retain the staged source", { cause });
  }
}

export class BrowserPackageImageSource implements PackageUpgradeSource {
  private pending: Pending | undefined;
  private nextId = 1;
  private retired = false;
  private cleanupFailure: UnprovenPackageSourceCleanupError | undefined;
  private closePromise: Promise<void> | undefined;
  private size = 0;

  private constructor(private readonly worker: Worker) {
    worker.onmessage = ({ data }: MessageEvent<PackageImageSourceResponse>) => {
      const pending = this.pending;
      if (!pending || data.id !== pending.id) { this.fail(new Error("Package source returned an unexpected reply")); return; }
      this.pending = undefined;
      if (data.type === "error") {
        this.retired = true;
        worker.terminate();
        const error = new Error(data.message);
        if (!data.closed) this.cleanupFailure = new UnprovenPackageSourceCleanupError(error);
        pending.reject(this.cleanupFailure ?? error);
      } else { pending.resolve(data); }
    };
    worker.onerror = event => { event.preventDefault(); this.fail(new Error(`Package source worker failed: ${event.message}`)); };
    worker.onmessageerror = () => this.fail(new Error("Package source worker response could not be decoded"));
  }

  static async open(moduleBytes: Uint8Array, file: FileSystemFileHandle,
    identity: { length: number; sha256: string; directory: string }): Promise<BrowserPackageImageSource> {
    if (!(moduleBytes instanceof Uint8Array) || !(moduleBytes.buffer instanceof ArrayBuffer)
      || moduleBytes.length < 1 || moduleBytes.length > 16 * 1024 * 1024) {
      throw new Error("Package source module exceeds its independent byte bound");
    }
    const binding = { length: identity.length, sha256: identity.sha256, directory: identity.directory };
    if (!Number.isSafeInteger(binding.length) || binding.length < 1 || !/^[0-9a-f]{64}$/.test(binding.sha256)
      || typeof binding.directory !== "string" || binding.directory.length > 4096
      || new TextEncoder().encode(binding.directory).length > 4096) {
      throw new Error("Package source requires a bounded trusted image identity");
    }
    const moduleSnapshot = moduleBytes.slice();
    const reference = await referenceOpfsFile(file);
    const source = new BrowserPackageImageSource(new PackageSourceWorker());
    try {
      const reply = await source.call({ type: "open", id: 0, moduleBytes: moduleSnapshot, file: reference, ...binding });
      if (reply.type !== "ready" || !Number.isInteger(reply.inventoryBytes) || reply.inventoryBytes < 1
        || reply.inventoryBytes > 8 * 1024 * 1024) throw new Error("Package source returned an invalid inventory length");
      source.size = reply.inventoryBytes;
      return source;
    } catch (error) {
      try { await source.close(); }
      catch (cleanup) { throw new UnprovenPackageSourceCleanupError(new AggregateError([error, cleanup], "Package source opening and cleanup failed")); }
      throw error;
    }
  }

  get inventoryBytes(): number { return this.size; }

  readInventory(offset: number, length: number): Promise<Uint8Array> { return this.read(null, offset, length); }
  readFile(path: string, offset: number, length: number): Promise<Uint8Array> { return this.read(path, offset, length); }

  private async read(path: string | null, offset: number, length: number): Promise<Uint8Array> {
    if (this.closePromise) throw new Error("Package source is closing");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1
      || length > PACKAGE_SOURCE_CHUNK_BYTES || !Number.isSafeInteger(offset + length)) {
      throw new Error("Package source reads require a valid range of at most 64 KiB");
    }
    if (path !== null && (typeof path !== "string" || !path.startsWith("/") || path.length > 4096
      || path.includes("\0") || new TextEncoder().encode(path).length > 4096)) {
      throw new Error("Package source path is invalid");
    }
    const reply = await this.call({ type: "read", id: 0, path, offset, length });
    if (reply.type !== "bytes" || !(reply.bytes instanceof Uint8Array) || !(reply.bytes.buffer instanceof ArrayBuffer)
      || reply.bytes.length > length || reply.bytes.buffer.byteLength > PACKAGE_SOURCE_CHUNK_BYTES) {
      this.fail(new Error("Package source returned an invalid bounded chunk"));
      throw this.cleanupFailure;
    }
    return reply.bytes;
  }

  private call(request: PackageImageSourceRequest): Promise<PackageImageSourceResponse> {
    if (this.retired) return Promise.reject(this.cleanupFailure ?? new Error("Package source is closed"));
    if (this.pending) return Promise.reject(new Error("Package source request is already in flight"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      try { this.worker.postMessage({ ...request, id }, request.type === "open" ? [request.moduleBytes.buffer as ArrayBuffer] : []); }
      catch (error) { this.fail(error); }
    });
  }

  private fail(error: unknown): void {
    this.cleanupFailure ??= new UnprovenPackageSourceCleanupError(error);
    this.retired = true;
    this.worker.terminate();
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.cleanupFailure);
  }

  close(): Promise<void> {
    return this.closePromise ??= this.finish();
  }

  private async finish(): Promise<void> {
    if (this.retired) {
      if (this.cleanupFailure) throw this.cleanupFailure;
      return;
    }
    const timer = setTimeout(() => this.fail(new Error("Package source close acknowledgement timed out")), 5000);
    try {
      if (this.pending) {
        const pending = this.pending;
        await new Promise<void>(resolve => {
          this.pending = { ...pending,
            resolve: value => { pending.resolve(value); resolve(); },
            reject: error => { pending.reject(error); resolve(); } };
        });
        if (this.retired) {
          if (this.cleanupFailure) throw this.cleanupFailure;
          return;
        }
      }
      const reply = await this.call({ type: "close", id: 0 });
      if (reply.type !== "closed") { this.fail(new Error("Package source did not acknowledge closure")); throw this.cleanupFailure; }
      this.retired = true;
      this.worker.terminate();
    } finally { clearTimeout(timer); }
  }
}
