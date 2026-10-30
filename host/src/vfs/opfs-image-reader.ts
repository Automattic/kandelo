import type { StorageCloseLedger } from "../storage-close-ledger";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isOpfsImageIntegrity, type OpfsImageIntegrity } from "./image-integrity";
export type { OpfsImageIntegrity } from "./image-integrity";

interface PositionedOpfsHandle {
  getSize(): number;
  read(destination: Uint8Array, options: { at: number }): number;
  close(): void;
}

type ReadOnlyOpfsFile = FileSystemFileHandle & {
  createSyncAccessHandle(options: { mode: "read-only" }): Promise<PositionedOpfsHandle>;
};

const PAGE_BYTES = 64 * 1024;
const MAX_CACHED_PAGES = 64;

export class OpfsImageReader {
  private readonly pages = new Map<number, Uint8Array>();
  private reportedReadFailure = false;
  private sparePage: ArrayBuffer | null = null;
  private rawScratch: Uint8Array | null;

  private constructor(
    private readonly handle: PositionedOpfsHandle,
    readonly length: number,
    private readonly closeHandle: () => void,
    raw = false,
  ) {
    this.rawScratch = raw ? new Uint8Array(PAGE_BYTES) : null;
  }

  static async open(
    file: FileSystemFileHandle,
    integrity?: OpfsImageIntegrity,
    closeLedger?: StorageCloseLedger,
    raw = false,
  ): Promise<OpfsImageReader> {
    if (raw && integrity !== undefined) throw new Error("raw image transport cannot perform host integrity checks");
    const handle = await (file as ReadOnlyOpfsFile).createSyncAccessHandle({ mode: "read-only" });
    const close = closeLedger?.retain(() => { handle.close(); }) ?? (() => handle.close());
    try {
      const length = handle.getSize();
      if (!Number.isSafeInteger(length) || length <= 0) {
        throw new Error("OPFS rootfs image has an invalid length");
      }
      const reader = new OpfsImageReader(handle, length, close, raw);
      if (integrity !== undefined) await reader.verify(integrity);
      return reader;
    } catch (error) {
      try {
        close();
      } catch (cleanupFailure) {
        throw new AggregateError([error, cleanupFailure], "OPFS image validation and cleanup failed");
      }
      throw error;
    }
  }

  private async verify(integrity: OpfsImageIntegrity): Promise<void> {
    if (!isOpfsImageIntegrity(integrity) || integrity.length !== this.length) {
      throw new Error("OPFS rootfs image integrity metadata is invalid");
    }
    const { chunkBytes } = integrity;
    const scratch = new Uint8Array(Math.min(chunkBytes, this.length));
    if (integrity.imageSha256 !== undefined) {
      const hash = sha256.create();
      for (let offset = 0; offset < this.length; offset += chunkBytes) {
        const bytes = scratch.subarray(0, Math.min(chunkBytes, this.length - offset));
        if (this.readAt(offset, bytes) !== bytes.byteLength) {
          throw new Error("OPFS rootfs image could not be verified");
        }
        hash.update(bytes);
      }
      if (bytesToHex(hash.digest()) !== integrity.imageSha256) {
        throw new Error("OPFS rootfs image is damaged; refusing to boot");
      }
      return;
    }
    const { chunkSha256 } = integrity;
    for (let index = 0; index < chunkSha256.length; index++) {
      const offset = index * chunkBytes;
      const bytes = scratch.subarray(0, Math.min(chunkBytes, this.length - offset));
      if (this.readAt(offset, bytes) !== bytes.byteLength) {
        throw new Error("OPFS rootfs image could not be verified");
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actual = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      if (actual !== chunkSha256[index]) {
        throw new Error("OPFS rootfs image is damaged; refusing to boot");
      }
    }
  }

  readAt(offset: number, destination: Uint8Array): number {
    if (!Number.isSafeInteger(offset) || offset < 0) return -22;
    if (offset >= this.length) return 0;
    try {
      if (this.rawScratch !== null) {
        const bytes = this.rawScratch.subarray(0, Math.min(destination.byteLength, this.length - offset));
        if (bytes.byteLength === 0) return 0;
        const count = this.handle.read(bytes, { at: offset });
        if (!Number.isInteger(count) || count <= 0 || count > bytes.byteLength) {
          throw new Error("incomplete OPFS image read");
        }
        destination.set(bytes.subarray(0, count));
        return count;
      }
      const limit = Math.min(destination.byteLength, this.length - offset);
      let done = 0;
      while (done < limit) {
        const position = offset + done;
        const pageIndex = Math.floor(position / PAGE_BYTES);
        const withinPage = position % PAGE_BYTES;
        const page = this.readPage(pageIndex);
        const count = Math.min(limit - done, page.byteLength - withinPage);
        destination.set(page.subarray(withinPage, withinPage + count), done);
        done += count;
      }
      return done;
    } catch (error) {
      if (!this.reportedReadFailure) {
        this.reportedReadFailure = true;
        try {
          console.warn(`[OpfsImageReader] read failed at byte ${offset} for ${destination.byteLength} bytes: ${String(error).slice(0, 2000)}`);
        } catch {}
      }
      return -5;
    }
  }

  private readPage(index: number): Uint8Array {
    const cached = this.pages.get(index);
    if (cached !== undefined) {
      this.pages.delete(index);
      this.pages.set(index, cached);
      return cached;
    }
    const offset = index * PAGE_BYTES;
    let backing = this.sparePage;
    this.sparePage = null;
    if (backing === null && this.pages.size >= MAX_CACHED_PAGES) {
      const oldest = this.pages.keys().next().value!;
      backing = this.pages.get(oldest)!.buffer as ArrayBuffer;
      this.pages.delete(oldest);
    }
    backing ??= new ArrayBuffer(PAGE_BYTES);
    const page = new Uint8Array(backing, 0, Math.min(PAGE_BYTES, this.length - offset));
    try {
      let done = 0;
      while (done < page.byteLength) {
        const count = this.handle.read(page.subarray(done), { at: offset + done });
        if (!Number.isInteger(count) || count <= 0 || count > page.byteLength - done) {
          throw new Error("incomplete OPFS image read");
        }
        done += count;
      }
    } catch (error) {
      this.sparePage = backing;
      throw error;
    }
    this.pages.set(index, page);
    return page;
  }

  close(): void {
    this.pages.clear();
    this.sparePage = null;
    this.rawScratch = null;
    this.closeHandle();
  }
}
