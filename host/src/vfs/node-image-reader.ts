import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { OpfsImageIntegrity } from "./opfs-image-reader";
import { isStagedRootfsImageIntegrity } from "./staged-rootfs-image";

const PAGE_BYTES = 64 * 1024;
const MAX_CACHED_PAGES = 64;

export class NodeImageReader {
  private readonly pages = new Map<number, Uint8Array>();
  private closed = false;

  private constructor(
    private readonly fd: number,
    readonly length: number,
    private readonly raw = false,
  ) {}

  static open(path: string, integrity?: OpfsImageIntegrity, raw = false): NodeImageReader {
    if (raw && integrity !== undefined) throw new Error("raw image transport cannot perform host integrity checks");
    if (!isAbsolute(path)) throw new Error("rootfs image file path must be absolute");
    if (constants.O_NOFOLLOW === undefined) {
      throw new Error("rootfs image file requires no-follow opens");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(fd, { bigint: true });
      const length = Number(metadata.size);
      if (!metadata.isFile() || !Number.isSafeInteger(length) || length <= 0) {
        throw new Error("rootfs image file must be a nonempty regular file with a safe length");
      }
      const reader = new NodeImageReader(fd, length, raw);
      if (integrity !== undefined) reader.verify(integrity);
      return reader;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  readAt(offset: number, destination: Uint8Array): number {
    if (!Number.isSafeInteger(offset) || offset < 0) return -22;
    if (offset >= this.length) return 0;
    if (this.closed) return -5;
    try {
      if (this.raw) {
        const limit = Math.min(destination.byteLength, PAGE_BYTES, this.length - offset);
        return readSync(this.fd, destination, 0, limit, offset);
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
    } catch {
      return -5;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pages.clear();
    closeSync(this.fd);
  }

  private readPage(index: number): Uint8Array {
    const cached = this.pages.get(index);
    if (cached !== undefined) {
      this.pages.delete(index);
      this.pages.set(index, cached);
      return cached;
    }
    const offset = index * PAGE_BYTES;
    const page = new Uint8Array(Math.min(PAGE_BYTES, this.length - offset));
    let done = 0;
    while (done < page.byteLength) {
      const count = readSync(this.fd, page, done, page.byteLength - done, offset + done);
      if (!Number.isInteger(count) || count <= 0 || count > page.byteLength - done) {
        throw new Error("incomplete rootfs image file read");
      }
      done += count;
    }
    this.pages.set(index, page);
    if (this.pages.size > MAX_CACHED_PAGES) {
      this.pages.delete(this.pages.keys().next().value!);
    }
    return page;
  }

  private verify(integrity: OpfsImageIntegrity): void {
    if (!isStagedRootfsImageIntegrity(integrity) || integrity.length !== this.length) {
      throw new Error("rootfs image file integrity metadata is invalid");
    }
    const buffer = new Uint8Array(integrity.chunkBytes);
    if (integrity.imageSha256 !== undefined) {
      const hash = createHash("sha256");
      for (let offset = 0; offset < this.length; offset += integrity.chunkBytes) {
        const chunk = buffer.subarray(0, Math.min(buffer.length, this.length - offset));
        if (this.readAt(offset, chunk) !== chunk.byteLength) {
          throw new Error("rootfs image file could not be verified");
        }
        hash.update(chunk);
      }
      if (hash.digest("hex") !== integrity.imageSha256) {
        throw new Error("rootfs image file is damaged; refusing to boot");
      }
      return;
    }
    for (let index = 0; index < integrity.chunkSha256.length; index++) {
      const offset = index * integrity.chunkBytes;
      const chunk = buffer.subarray(0, Math.min(buffer.length, this.length - offset));
      if (this.readAt(offset, chunk) !== chunk.byteLength) {
        throw new Error("rootfs image file could not be verified");
      }
      if (createHash("sha256").update(chunk).digest("hex") !== integrity.chunkSha256[index]) {
        throw new Error("rootfs image file is damaged; refusing to boot");
      }
    }
  }
}
