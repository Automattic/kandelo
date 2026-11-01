import { PackageImageSource } from "../../../../../images/vfs/lib/package-image-source";
import { OpfsOverlayStorageFile } from "../../../../../host/src/vfs/overlay-storage";
import { openOpfsFileReference } from "../../../../../host/src/vfs/opfs-file-reference";
import { StorageCloseLedger } from "../../../../../host/src/storage-close-ledger";
import type { PackageImageSourceRequest, PackageImageSourceResponse } from "./package-image-source-protocol";

const storage = new StorageCloseLedger();
let source: PackageImageSource | undefined;
let busy = false;
let started = false;
let finished = false;

function post(message: PackageImageSourceResponse): void {
  (self as unknown as Worker).postMessage(message,
    message.type === "bytes" ? [message.bytes.buffer as ArrayBuffer] : []);
}

async function close(): Promise<void> {
  source = undefined;
  await storage.beginRetirement();
  storage.closeAll();
}

async function handle(request: PackageImageSourceRequest): Promise<void> {
  try {
    if (!Number.isSafeInteger(request.id) || request.id < 1) throw new Error("Package source request identity is invalid");
    if (request.type === "close") {
      await close();
      finished = true;
      post({ type: "closed", id: request.id });
    } else if (request.type === "open") {
      if (started) throw new Error("Package source worker already opened an image");
      started = true;
      if (!(request.moduleBytes instanceof Uint8Array) || !(request.moduleBytes.buffer instanceof ArrayBuffer)
        || request.moduleBytes.length < 1 || request.moduleBytes.buffer.byteLength > 16 * 1024 * 1024) {
        throw new Error("Package source module exceeds its independent byte bound");
      }
      const file = await storage.run(async () => OpfsOverlayStorageFile.openHandle(await openOpfsFileReference(request.file), storage));
      if (file.len() !== request.length) throw new Error("Package source length differs from its trusted identity");
      source = new PackageImageSource(request.moduleBytes, { length: request.length, sha256: request.sha256,
        directory: request.directory, readAt: (offset, destination) => {
          file.readExactAt(offset, destination);
          return destination.length;
        } });
      post({ type: "ready", id: request.id, inventoryBytes: source.inventoryBytes });
    } else if (request.type === "read") {
      if (!source) throw new Error("Package source worker has no open image");
      const bytes = request.path === null ? source.readInventory(request.offset, request.length)
        : source.readFile(request.path, request.offset, request.length);
      post({ type: "bytes", id: request.id, bytes });
    } else { throw new Error("Unknown package source request"); }
  } catch (error) {
    let closed = false;
    let failure: unknown = error;
    try { await close(); closed = true; }
    catch (cleanup) { failure = new AggregateError([error, cleanup], "Package source cleanup is unconfirmed"); }
    finished = true;
    post({ type: "error", id: request.id, message: String(failure), closed });
  } finally { busy = false; }
}

self.onmessage = ({ data }: MessageEvent<PackageImageSourceRequest>) => {
  if (finished) return;
  if (busy) {
    post({ type: "error", id: data.id, message: "Package source request is already in flight", closed: false });
    return;
  }
  busy = true;
  void handle(data);
};
