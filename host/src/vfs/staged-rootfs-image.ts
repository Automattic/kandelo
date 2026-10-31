import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { OpfsImageIntegrity } from "./opfs-image-reader";
import { isOpfsImageIntegrity } from "./image-integrity";

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
  if (bytesToHex(readbackHash.digest()) !== imageSha256) {
    throw new Error("rootfs export staging file failed read-back verification");
  }
  onProgress?.({ phase: "verifying", completed: length, total: length });
  return { length, chunkBytes: CHUNK_BYTES, imageSha256 };
}
