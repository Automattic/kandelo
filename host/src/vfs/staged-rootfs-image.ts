import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { OpfsImageIntegrity } from "./opfs-image-reader";

const CHUNK_BYTES = 1024 * 1024;

export interface StagedRootfsImageStorage {
  writeAllAt(offset: number, bytes: Uint8Array): void;
  readExactAt(offset: number, bytes: Uint8Array): void;
  setSize(length: number): void;
  flush(): void;
  getSize(): number;
}

export function isStagedRootfsImageIntegrity(value: unknown): value is OpfsImageIntegrity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OpfsImageIntegrity>;
  return Number.isSafeInteger(candidate.length)
    && candidate.length! > 0
    && candidate.chunkBytes === CHUNK_BYTES
    && Array.isArray(candidate.chunkSha256)
    && candidate.chunkSha256.length === Math.ceil(candidate.length! / CHUNK_BYTES)
    && candidate.chunkSha256.every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest));
}

export function writeAndVerifyRootfsImage(
  stream: (visit: (offset: number, bytes: Uint8Array) => void) => number,
  storage: StagedRootfsImageStorage,
): OpfsImageIntegrity {
  if (storage.getSize() !== 0) {
    throw new Error("rootfs export requires an empty staging file");
  }
  const chunkSha256: string[] = [];
  let chunkHash = sha256.create();
  let chunkUsed = 0;
  let written = 0;
  const length = stream((offset, bytes) => {
    if (offset !== written || bytes.byteLength === 0 || !Number.isSafeInteger(offset + bytes.byteLength)) {
      throw new Error("rootfs export has an invalid chunk boundary");
    }
    if (bytes.some((byte) => byte !== 0)) {
      storage.writeAllAt(offset, bytes);
    }
    let consumed = 0;
    while (consumed < bytes.byteLength) {
      const count = Math.min(CHUNK_BYTES - chunkUsed, bytes.byteLength - consumed);
      chunkHash.update(bytes.subarray(consumed, consumed + count));
      consumed += count;
      chunkUsed += count;
      if (chunkUsed === CHUNK_BYTES) {
        chunkSha256.push(bytesToHex(chunkHash.digest()));
        chunkHash = sha256.create();
        chunkUsed = 0;
      }
    }
    written += bytes.byteLength;
  });
  if (length !== written || length <= 0) {
    throw new Error("rootfs export has an invalid length");
  }
  if (chunkUsed !== 0) {
    chunkSha256.push(bytesToHex(chunkHash.digest()));
  }
  storage.setSize(length);
  storage.flush();
  if (storage.getSize() !== length) {
    throw new Error("rootfs export staging file has an invalid length");
  }
  const buffer = new Uint8Array(CHUNK_BYTES);
  for (let index = 0; index < chunkSha256.length; index++) {
    const offset = index * CHUNK_BYTES;
    const count = Math.min(CHUNK_BYTES, length - offset);
    const chunk = buffer.subarray(0, count);
    storage.readExactAt(offset, chunk);
    if (bytesToHex(sha256(chunk)) !== chunkSha256[index]) {
      throw new Error("rootfs export staging file failed read-back verification");
    }
  }
  return { length, chunkBytes: CHUNK_BYTES, chunkSha256 };
}
