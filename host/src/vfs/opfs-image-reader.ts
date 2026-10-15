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
const MAX_INTEGRITY_CHUNK_BYTES = 1024 * 1024;

export interface OpfsImageIntegrity {
  length: number;
  chunkBytes: number;
  chunkSha256: readonly string[];
}

export class OpfsImageReader {
  private readonly pages = new Map<number, Uint8Array>();

  private constructor(
    private readonly handle: PositionedOpfsHandle,
    readonly length: number,
  ) {}

  static async open(
    file: FileSystemFileHandle,
    integrity?: OpfsImageIntegrity,
  ): Promise<OpfsImageReader> {
    const handle = await (file as ReadOnlyOpfsFile).createSyncAccessHandle({ mode: "read-only" });
    try {
      const length = handle.getSize();
      if (!Number.isSafeInteger(length) || length <= 0) {
        throw new Error("OPFS rootfs image has an invalid length");
      }
      const reader = new OpfsImageReader(handle, length);
      if (integrity !== undefined) await reader.verify(integrity);
      return reader;
    } catch (error) {
      handle.close();
      throw error;
    }
  }

  private async verify(integrity: OpfsImageIntegrity): Promise<void> {
    const { chunkBytes, chunkSha256 } = integrity;
    if (
      integrity.length !== this.length ||
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes <= 0 ||
      chunkBytes > MAX_INTEGRITY_CHUNK_BYTES ||
      !Array.isArray(chunkSha256) ||
      chunkSha256.length !== Math.ceil(this.length / chunkBytes)
    ) {
      throw new Error("OPFS rootfs image integrity metadata is invalid");
    }
    for (let index = 0; index < chunkSha256.length; index++) {
      const offset = index * chunkBytes;
      const bytes = new Uint8Array(Math.min(chunkBytes, this.length - offset));
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
      const count = this.handle.read(page.subarray(done), { at: offset + done });
      if (!Number.isInteger(count) || count <= 0 || count > page.byteLength - done) {
        throw new Error("incomplete OPFS image read");
      }
      done += count;
    }
    this.pages.set(index, page);
    if (this.pages.size > MAX_CACHED_PAGES) {
      this.pages.delete(this.pages.keys().next().value!);
    }
    return page;
  }

  close(): void {
    this.pages.clear();
    this.handle.close();
  }
}
