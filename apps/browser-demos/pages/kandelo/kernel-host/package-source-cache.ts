import { browserComputerDirectory } from "../../../../../host/src/browser-computer-storage";
import { openOpfsFileReference, snapshotOpfsFileReference, type OpfsFileReference } from "../../../../../host/src/vfs/opfs-file-reference";
import { loadPositionedImageWriterModuleBytes } from "../../../lib/kernel-owned-boot";
import { BrowserPackageImageSource } from "./package-image-source";
import type { OwnedPackageSource } from "./package-maintenance-session";
import type { PagesVfsProductLoader } from "./pages-vfs-product-loader";

interface Receipt {
  version: 1;
  productId: string;
  file: OpfsFileReference;
  length: number;
  sha256: string;
  directory: string;
}

const RECEIPT_BYTES = 16384;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TARGET_DIRECTORY = new RegExp(`^target-${UUID}$`);
const SOURCE_FILE = new RegExp(`^source-${UUID}\\.vfs$`);

async function softwareDirectory(computerId: string): Promise<FileSystemDirectoryHandle> {
  return (await browserComputerDirectory(computerId, false)).getDirectoryHandle("software", { create: true });
}

async function validateReceipt(value: unknown, directory: FileSystemDirectoryHandle): Promise<Receipt> {
  const receipt = value as Receipt | null;
  if (!receipt || Object.keys(receipt).length !== 6 || receipt.version !== 1
    || typeof receipt.productId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(receipt.productId)
    || !Number.isSafeInteger(receipt.length) || receipt.length < 1 || typeof receipt.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(receipt.sha256) || typeof receipt.directory !== "string"
    || receipt.directory.length > 4096 || new TextEncoder().encode(receipt.directory).length > 4096) {
    throw new Error("Unsupported or unreadable saved software source; preserve this computer and inspect recovery");
  }
  const file = snapshotOpfsFileReference(receipt.file);
  const prefix = await (await navigator.storage.getDirectory()).resolve(directory);
  if (!prefix || file.path.length !== prefix.length + 2 || prefix.some((component, index) => file.path[index] !== component)
    || !TARGET_DIRECTORY.test(file.path[prefix.length]) || !SOURCE_FILE.test(file.path[prefix.length + 1])) {
    throw new Error("Saved software source does not belong to this computer");
  }
  return { version: 1, productId: receipt.productId, file, length: receipt.length, sha256: receipt.sha256, directory: receipt.directory };
}

async function readReceipt(directory: FileSystemDirectoryHandle): Promise<Receipt> {
  const file = await (await directory.getFileHandle("source.json")).getFile();
  if (file.size < 1 || file.size > RECEIPT_BYTES) throw new Error("Saved software source metadata exceeds its bound");
  return validateReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())), directory);
}

export async function openSavedPackageSource(computerId: string, signal: AbortSignal): Promise<OwnedPackageSource> {
  signal.throwIfAborted();
  const receipt = await readReceipt(await softwareDirectory(computerId));
  signal.throwIfAborted();
  const source = await BrowserPackageImageSource.open(await loadPositionedImageWriterModuleBytes(),
    await openOpfsFileReference(receipt.file), receipt, signal);
  return { source, close: () => source.close(), committed: () => collectUnusedSources(computerId, signal) };
}

async function collectUnusedSources(computerId: string, signal: AbortSignal): Promise<void> {
  const directory = await softwareDirectory(computerId);
  const receipt = await readReceipt(directory);
  const retained = receipt.file.path.at(-2);
  let visited = 0;
  for await (const [name, entry] of directory.entries()) {
    signal.throwIfAborted();
    if (++visited > 256) throw new Error("Package-source collection reached its per-operation bound");
    if (entry.kind !== "directory" || name === retained || !TARGET_DIRECTORY.test(name)) continue;
    const target = await directory.getDirectoryHandle(name);
    for await (const [filename, file] of target.entries()) {
      signal.throwIfAborted();
      if (++visited > 256) throw new Error("Package-source collection reached its per-operation bound");
      if (file.kind === "file" && SOURCE_FILE.test(filename)) await target.removeEntry(filename);
    }
    signal.throwIfAborted();
    try { await directory.removeEntry(name); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === "InvalidModificationError")) throw error;
    }
  }
}

export async function stageCurrentPackageSource(computerId: string, productId: string,
  loader: PagesVfsProductLoader, signal: AbortSignal): Promise<OwnedPackageSource> {
  signal.throwIfAborted();
  const target = await loader.softwareTarget(productId);
  signal.throwIfAborted();
  const directory = await softwareDirectory(computerId);
  const stagedDirectory = await directory.getDirectoryHandle(`target-${crypto.randomUUID()}`, { create: true });
  const staged = await loader.activatePositioned(productId, stagedDirectory, signal);
  let transferred = false;
  try {
    signal.throwIfAborted();
    if (staged.transportIdentity.bytes !== target.bytes || staged.transportIdentity.sha256 !== target.sha256) {
      throw new Error("Staged software source differs from the verified release identity");
    }
    const receipt = await validateReceipt({ version: 1, productId, file: staged.source.reference,
      length: staged.source.integrity.length, sha256: staged.source.integrity.imageSha256, directory: target.directory }, directory);
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    if (bytes.length > RECEIPT_BYTES) throw new Error("Software source metadata exceeds its bound");
    const writer = await (await directory.getFileHandle("source.json", { create: true })).createWritable();
    try { await writer.write(bytes); await writer.close(); }
    catch (error) {
      try { await writer.abort(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Software source metadata publication failed"); }
      throw error;
    }
    transferred = true;
    await staged.source.release();
    return await openSavedPackageSource(computerId, signal);
  } finally {
    if (!transferred) await staged.source.remove();
  }
}
