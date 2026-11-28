import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { OpfsImageIntegrity } from "./opfs-image-reader";
import { isOpfsImageIntegrity } from "./image-integrity";
import type { DeferredByteStorage } from "./deferred-byte-spool";

const CHUNK_BYTES = 1024 * 1024;

export interface StagedRootfsImageProgress {
  phase: "writing" | "flushing" | "verifying";
  completed: number;
  total?: number;
}

export interface StagedRootfsImageStorage {
  writeAllAt(offset: number, bytes: Uint8Array): void;
  readExactAt(offset: number, bytes: Uint8Array): void;
  setSize(length: number): void;
  flush(): void;
  getSize(): number;
}

export interface TemporaryImageStorage extends DeferredByteStorage {
  getSize(): number;
  setSize(length: number): void;
  flush(): void;
}

/** For the byte-returning export API, stage on disk and allocate the result once. */
export async function materializeTemporaryImage(
  file: TemporaryImageStorage,
  write: (storage: StagedRootfsImageStorage) => OpfsImageIntegrity,
): Promise<Uint8Array<ArrayBuffer>> {
  const transfer = (operation: "readAt" | "writeAt", offset: number, bytes: Uint8Array) => {
    for (let done = 0; done < bytes.byteLength;) {
      const chunk = bytes.subarray(done, done + CHUNK_BYTES);
      const count = file[operation](offset + done, chunk);
      if (!Number.isInteger(count) || count <= 0 || count > chunk.byteLength) {
        throw new Error(`Temporary rootfs image ${operation} returned an invalid count`);
      }
      done += count;
    }
  };
  try {
    const result = write({
      readExactAt: (offset, bytes) => transfer("readAt", offset, bytes),
      writeAllAt: (offset, bytes) => transfer("writeAt", offset, bytes),
      getSize: () => file.getSize(), setSize: length => file.setSize(length), flush: () => file.flush(),
    });
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = new Uint8Array(result.length); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw Object.assign(new Error("Insufficient memory to return the rootfs snapshot", { cause: error }), { code: "ENOMEM" });
    }
    transfer("readAt", 0, bytes);
    if (bytesToHex(sha256(bytes)) !== result.imageSha256) throw new Error("Temporary rootfs snapshot digest changed");
    return bytes;
  } finally {
    await file.close();
  }
}

export function isStagedRootfsImageIntegrity(value: unknown): value is OpfsImageIntegrity {
  return isOpfsImageIntegrity(value) && value.chunkBytes === CHUNK_BYTES;
}

export function writeAndVerifyRootfsImage(
  stream: (visit: (offset: number, bytes: Uint8Array) => void) => number,
  storage: StagedRootfsImageStorage,
  onProgress?: (progress: StagedRootfsImageProgress) => void,
): OpfsImageIntegrity {
  if (storage.getSize() !== 0) {
    throw new Error("rootfs export requires an empty staging file");
  }
  const imageHash = sha256.create();
  let written = 0;
  let nextReport = CHUNK_BYTES;
  let writingReports = 0;
  onProgress?.({ phase: "writing", completed: 0 });
  const length = stream((offset, bytes) => {
    if (offset !== written || bytes.byteLength === 0 || !Number.isSafeInteger(offset + bytes.byteLength)) {
      throw new Error("rootfs export has an invalid chunk boundary");
    }
    imageHash.update(bytes);
    if (bytes.some((byte) => byte !== 0)) {
      storage.writeAllAt(offset, bytes);
    }
    written += bytes.byteLength;
    if (written >= nextReport && writingReports < 120) {
      onProgress?.({ phase: "writing", completed: written });
      writingReports++;
      nextReport = written + Math.max(CHUNK_BYTES, Math.floor(written / 4));
    }
  });
  if (length !== written || length <= 0) {
    throw new Error("rootfs export has an invalid length");
  }
  const imageSha256 = bytesToHex(imageHash.digest());
  onProgress?.({ phase: "writing", completed: written, total: length });
  onProgress?.({ phase: "flushing", completed: 0 });
  storage.setSize(length);
  storage.flush();
  return hashStagedRootfsImage(storage, length, onProgress, imageSha256);
}

/** Compute the transport identity of a flushed, exclusively held candidate. */
export function hashStagedRootfsImage(
  storage: StagedRootfsImageStorage,
  length: number,
  onProgress?: (progress: StagedRootfsImageProgress) => void,
  expectedDigest?: string,
): OpfsImageIntegrity {
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("invalid staged rootfs length");
  if (storage.getSize() !== length) {
    throw new Error("rootfs export staging file has an invalid length");
  }
  const buffer = new Uint8Array(CHUNK_BYTES);
  const readbackHash = sha256.create();
  const verificationReportStep = Math.max(CHUNK_BYTES, Math.ceil(length / 100));
  let verifiedReported = 0;
  onProgress?.({ phase: "verifying", completed: 0, total: length });
  for (let offset = 0; offset < length; offset += CHUNK_BYTES) {
    const count = Math.min(CHUNK_BYTES, length - offset);
    const chunk = buffer.subarray(0, count);
    storage.readExactAt(offset, chunk);
    readbackHash.update(chunk);
    const verified = offset + count;
    if (verified < length && verified - verifiedReported >= verificationReportStep) {
      onProgress?.({ phase: "verifying", completed: verified, total: length });
      verifiedReported = verified;
    }
  }
  const imageSha256 = bytesToHex(readbackHash.digest());
  if (expectedDigest !== undefined && imageSha256 !== expectedDigest) {
    throw new Error("rootfs export staging file failed read-back verification");
  }
  onProgress?.({ phase: "verifying", completed: length, total: length });
  return { length, chunkBytes: CHUNK_BYTES, imageSha256 };
}
