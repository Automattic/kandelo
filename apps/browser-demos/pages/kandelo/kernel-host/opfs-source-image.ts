import { Decompress } from "fzstd";
import { sha256 } from "@noble/hashes/sha2.js";
import type { OpfsImageIntegrity } from "../../../../../host/src/vfs/opfs-image-reader";
import { identityEncodedContentLength } from "../../../../../web-libs/kandelo-session/src/sized-download";

const CHUNK_BYTES = 1024 * 1024;
export const MAX_STAGED_VFS_IMAGE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ZSTD_WINDOW_BYTES = 16 * 1024 * 1024;
const MAX_ZSTD_BLOCK_BYTES = 128 * 1024;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const SOURCE_FILE_PATTERN = /^source-[0-9a-f-]{36}\.vfs$/;

function sourceLockName(name: string): string {
  return `kandelo-persistent-source-${name}`;
}

async function reclaimAbandonedSources(directory: FileSystemDirectoryHandle): Promise<void> {
  if (!navigator.locks) throw new Error("persistent VFS source staging requires Web Locks");
  const names: string[] = [];
  for await (const name of directory.keys()) {
    if (SOURCE_FILE_PATTERN.test(name)) names.push(name);
  }
  for (const name of names) {
    await navigator.locks.request(sourceLockName(name), { ifAvailable: true }, async (lock) => {
      if (lock !== null) await directory.removeEntry(name).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      });
    });
  }
}

async function holdSourceLock(name: string): Promise<() => Promise<void>> {
  if (!navigator.locks) throw new Error("persistent VFS source staging requires Web Locks");
  let signalRelease!: () => void;
  const released = new Promise<void>((resolve) => { signalRelease = resolve; });
  let signalAcquired!: () => void;
  let signalFailed!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    signalAcquired = resolve;
    signalFailed = reject;
  });
  const holding = navigator.locks.request(sourceLockName(name), async () => {
    signalAcquired();
    await released;
  });
  void holding.catch(signalFailed);
  await acquired;
  return async () => {
    signalRelease();
    await holding;
  };
}

class StreamBytes {
  private current: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private offset = 0;
  private readonly pending: Uint8Array[];
  private received: number;

  constructor(
    prefix: Uint8Array[],
    private readonly readSource: () => Promise<ReadableStreamReadResult<Uint8Array>>,
    private readonly onProgress: (loadedBytes: number, totalBytes: number | undefined) => void,
    private readonly totalBytes: number | undefined,
  ) {
    this.pending = [...prefix];
    this.received = prefix.reduce((total, chunk) => total + chunk.byteLength, 0);
  }

  async take(count: number, label: string, allowEnd = false): Promise<Uint8Array | null> {
    const bytes = new Uint8Array(count);
    let copied = 0;
    while (copied < count) {
      if (this.offset === this.current.byteLength) {
        const pending = this.pending.shift();
        if (pending !== undefined) {
          this.current = pending;
        } else {
          const next = await this.readSource();
          if (next.done) {
            if (allowEnd && copied === 0) return null;
            throw new Error(`zstd VFS image has a truncated ${label}`);
          }
          this.current = next.value;
          this.received += next.value.byteLength;
          this.onProgress(this.received, this.totalBytes);
        }
        this.offset = 0;
        if (this.current.byteLength === 0) continue;
      }
      const available = Math.min(count - copied, this.current.byteLength - this.offset);
      bytes.set(this.current.subarray(this.offset, this.offset + available), copied);
      this.offset += available;
      copied += available;
    }
    return bytes;
  }

  async skip(count: number): Promise<void> {
    while (count > 0) {
      const step = Math.min(count, CHUNK_BYTES);
      await this.take(step, "skippable frame");
      count -= step;
    }
  }
}

async function decodeZstdToSource(
  prefix: Uint8Array[],
  readSource: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  onProgress: (loadedBytes: number, totalBytes: number | undefined) => void,
  totalBytes: number | undefined,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const input = new StreamBytes(prefix, readSource, onProgress, totalBytes);
  const outputs: Uint8Array[] = [];
  const decompressor = new Decompress((bytes) => {
    if (bytes.byteLength > 0) outputs.push(bytes);
  });
  let frames = 0;
  let declaredTotal = 0;
  const take = async (count: number, label: string) => (await input.take(count, label))!;
  const decode = async (bytes: Uint8Array) => {
    decompressor.push(bytes);
    for (const output of outputs) await write(output);
    outputs.length = 0;
  };
  for (;;) {
    const magicBytes = await input.take(4, "frame magic", true);
    if (magicBytes === null) break;
    const magic = new DataView(magicBytes.buffer).getUint32(0, true);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      const sizeBytes = await take(4, "skippable frame size");
      await input.skip(new DataView(sizeBytes.buffer).getUint32(0, true));
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error("zstd VFS image contains an invalid frame magic");
    frames++;
    const descriptorBytes = await take(1, "frame descriptor");
    const descriptor = descriptorBytes[0]!;
    if ((descriptor & 0x08) !== 0) throw new Error("zstd VFS image uses a reserved frame descriptor bit");
    const singleSegment = (descriptor & 0x20) !== 0;
    const windowDescriptorBytes = singleSegment ? new Uint8Array() : await take(1, "window descriptor");
    const dictionaryBytes = await take([0, 1, 2, 4][descriptor & 0x03]!, "dictionary identity");
    const contentSizeFlag = descriptor >>> 6;
    const contentSizeBytes = await take(contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag, "frame header");
    let contentSize: bigint | undefined;
    if (contentSizeBytes.byteLength > 0) {
      contentSize = 0n;
      for (let index = 0; index < contentSizeBytes.byteLength; index++) {
        contentSize |= BigInt(contentSizeBytes[index]!) << BigInt(index * 8);
      }
      if (contentSizeFlag === 1) contentSize += 256n;
    }
    let windowSize = contentSize;
    if (!singleSegment) {
      const descriptorValue = windowDescriptorBytes[0]!;
      const base = 1n << BigInt(10 + (descriptorValue >>> 3));
      windowSize = base + (base >> 3n) * BigInt(descriptorValue & 7);
    }
    if (windowSize !== undefined && windowSize > BigInt(MAX_ZSTD_WINDOW_BYTES)) {
      throw new Error("zstd VFS image exceeds its streaming window bound");
    }
    if (contentSize !== undefined && contentSize > BigInt(MAX_STAGED_VFS_IMAGE_BYTES - declaredTotal)) {
      throw new Error("zstd VFS image exceeds its decompressed byte bound");
    }
    const frameHeader = new Uint8Array(5 + windowDescriptorBytes.byteLength + dictionaryBytes.byteLength + contentSizeBytes.byteLength);
    frameHeader.set(magicBytes);
    frameHeader.set(descriptorBytes, 4);
    frameHeader.set(windowDescriptorBytes, 5);
    frameHeader.set(dictionaryBytes, 5 + windowDescriptorBytes.byteLength);
    frameHeader.set(contentSizeBytes, 5 + windowDescriptorBytes.byteLength + dictionaryBytes.byteLength);
    await decode(frameHeader);
    let frameBound = 0;
    for (;;) {
      const blockHeader = await take(3, "block header");
      const header = blockHeader[0]! | (blockHeader[1]! << 8) | (blockHeader[2]! << 16);
      const last = (header & 1) !== 0;
      const blockType = (header >>> 1) & 3;
      const blockSize = header >>> 3;
      if (blockType === 3 || blockSize > MAX_ZSTD_BLOCK_BYTES) {
        throw new Error("zstd VFS image contains an invalid block header");
      }
      frameBound += blockType === 2 ? MAX_ZSTD_BLOCK_BYTES : blockSize;
      if (contentSize === undefined && frameBound > MAX_STAGED_VFS_IMAGE_BYTES - declaredTotal) {
        throw new Error("zstd VFS image exceeds its decompressed byte bound");
      }
      const payload = await take(blockType === 1 ? 1 : blockSize, "block payload");
      const block = new Uint8Array(3 + payload.byteLength);
      block.set(blockHeader);
      block.set(payload, 3);
      await decode(block);
      if (last) break;
    }
    if ((descriptor & 0x04) !== 0) await decode(await take(4, "content checksum"));
    if (contentSize !== undefined && contentSize > BigInt(frameBound)) {
      throw new Error("zstd VFS image frame content exceeds its block bound");
    }
    declaredTotal += contentSize === undefined ? frameBound : Number(contentSize);
  }
  if (frames === 0) throw new Error("zstd VFS image contains no data frame");
  decompressor.push(new Uint8Array(), true);
  for (const output of outputs) await write(output);
}

export interface StagedSourceImage {
  file: FileSystemFileHandle;
  integrity: OpfsImageIntegrity;
  remove(): Promise<void>;
}

export interface VfsSourceIdentity {
  bytes: number;
  sha256: string;
}

export async function stageRawVfsSourceImage(
  response: Response,
  onProgress: (loadedBytes: number, totalBytes: number | undefined) => void,
  stagingDirectory?: FileSystemDirectoryHandle,
  sourceIdentity?: VfsSourceIdentity,
): Promise<StagedSourceImage> {
  if (sourceIdentity !== undefined && (
    !Number.isSafeInteger(sourceIdentity.bytes) || sourceIdentity.bytes < 1 ||
    sourceIdentity.bytes > MAX_STAGED_VFS_IMAGE_BYTES ||
    !/^[0-9a-f]{64}$/.test(sourceIdentity.sha256)
  )) {
    throw new Error("VFS source identity is invalid");
  }
  if (response.body === null) throw new Error("VFS image has no response body");
  const reader = response.body.getReader();
  const totalBytes = identityEncodedContentLength(response);
  const sourceDigest = sourceIdentity === undefined ? null : sha256.create();
  let sourceLength = 0;
  const readSource = async () => {
    const next = await reader.read();
    if (!next.done) {
      sourceLength += next.value.byteLength;
      if (sourceLength > MAX_STAGED_VFS_IMAGE_BYTES) {
        throw new Error("VFS source exceeds its staged byte bound");
      }
      if (sourceIdentity !== undefined && sourceLength > sourceIdentity.bytes) {
        throw new Error("VFS source exceeds its authenticated byte length");
      }
      sourceDigest?.update(next.value);
    }
    return next;
  };
  const prefix: Uint8Array[] = [];
  let prefixLength = 0;
  try {
    if (totalBytes !== undefined && totalBytes > MAX_STAGED_VFS_IMAGE_BYTES) {
      throw new Error("VFS source exceeds its staged byte bound");
    }
    if (sourceIdentity !== undefined && totalBytes !== undefined && totalBytes !== sourceIdentity.bytes) {
      throw new Error("VFS source content-length differs from its authenticated byte length");
    }
    while (prefixLength < 4) {
      const next = await readSource();
      if (next.done) break;
      prefix.push(next.value);
      prefixLength += next.value.byteLength;
      onProgress(prefixLength, totalBytes);
    }
    const header = new Uint8Array(Math.min(4, prefixLength));
    let copied = 0;
    for (const bytes of prefix) {
      const count = Math.min(bytes.byteLength, header.byteLength - copied);
      header.set(bytes.subarray(0, count), copied);
      copied += count;
      if (copied === header.byteLength) break;
    }
    const compressed = ZSTD_MAGIC.every((byte, index) => header[index] === byte);

    const directory = stagingDirectory ?? await (await navigator.storage.getDirectory()).getDirectoryHandle(
      "kandelo-persistent-overlay", { create: true },
    );
    await reclaimAbandonedSources(directory);
    const name = `source-${crypto.randomUUID()}.vfs`;
    const release = await holdSourceLock(name);
    let file: FileSystemFileHandle;
    try {
      file = await directory.getFileHandle(name, { create: true });
    } catch (error) {
      await release();
      throw error;
    }
    const remove = async () => {
      try {
        await directory.removeEntry(name);
      } finally {
        await release();
      }
    };
    let writable: FileSystemWritableFileStream | undefined;
    try {
      writable = await file.createWritable();
      const chunk = new Uint8Array(CHUNK_BYTES);
      const chunkSha256: string[] = [];
      let fill = 0;
      let length = 0;
      const write = async (bytes: Uint8Array) => {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const count = Math.min(CHUNK_BYTES - fill, bytes.byteLength - offset);
          chunk.set(bytes.subarray(offset, offset + count), fill);
          fill += count;
          offset += count;
          length += count;
          if (length > MAX_STAGED_VFS_IMAGE_BYTES) {
            throw new Error("VFS image exceeds its decompressed byte bound");
          }
          if (fill === CHUNK_BYTES) {
            await writable!.write(chunk);
            const digest = await crypto.subtle.digest("SHA-256", chunk);
            chunkSha256.push(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
            fill = 0;
          }
        }
      };
      if (compressed) {
        await decodeZstdToSource(prefix, readSource, onProgress, totalBytes, write);
      } else {
        for (const bytes of prefix) await write(bytes);
        for (;;) {
          const next = await readSource();
          if (next.done) break;
          await write(next.value);
          onProgress(length, totalBytes);
        }
      }
      if (fill > 0) {
        const tail = chunk.slice(0, fill);
        await writable.write(tail);
        const digest = await crypto.subtle.digest("SHA-256", tail);
        chunkSha256.push(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
      }
      if (sourceIdentity !== undefined) {
        if (sourceLength !== sourceIdentity.bytes) {
          throw new Error("VFS source differs from its authenticated byte length");
        }
        const actualSha256 = Array.from(sourceDigest!.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (actualSha256 !== sourceIdentity.sha256) {
          throw new Error("VFS source SHA-256 differs from its authenticated digest");
        }
      }
      await writable.close();
      writable = undefined;
      return { file, integrity: { length, chunkBytes: CHUNK_BYTES, chunkSha256 }, remove };
    } catch (error) {
      await writable?.abort().catch(() => {});
      await remove().catch(() => {});
      throw error;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
