import { KandeloImageFs } from "./kandelo-image-fs";

export const PACKAGE_SOURCE_CHUNK_BYTES = 64 * 1024;
const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const INVENTORY_PATH = "/var/lib/kandelo/packages/installed";

export interface PackageImageInput {
  length: number;
  sha256: string;
  directory: string;
  readAt(offset: number, destination: Uint8Array): number;
}

export class PackageImageSource {
  private readonly filesystem: KandeloImageFs;
  private readonly inventory: Uint8Array;

  constructor(moduleBytes: Uint8Array, input: PackageImageInput) {
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("Package source requires its trusted image digest");
    this.filesystem = KandeloImageFs.createFromPositionedImage(moduleBytes, input.length, input.readAt, undefined, input.sha256);
    const stat = this.filesystem.lstat(INVENTORY_PATH);
    if ((stat.mode & 0o170000) !== 0o100000 || stat.deferred || !Number.isSafeInteger(stat.size)
      || stat.size < 1 || stat.size > MAX_INVENTORY_BYTES) {
      throw new Error("Package source requires a bounded resident producer inventory");
    }
    const original = new Uint8Array(stat.size);
    const handle = this.filesystem.open(INVENTORY_PATH);
    try {
      for (let offset = 0; offset < original.length;) {
        const chunk = original.subarray(offset, offset + PACKAGE_SOURCE_CHUNK_BYTES);
        const count = this.filesystem.read(handle, chunk, offset, chunk.length);
        if (count <= 0 || count > chunk.length) throw new Error("Package source inventory is truncated");
        offset += count;
      }
    } finally { this.filesystem.close(handle); }
    this.inventory = this.filesystem.pinPackageInventorySources(original, input.directory);
  }

  get inventoryBytes(): number { return this.inventory.length; }

  readInventory(offset: number, length: number): Uint8Array {
    this.checkRange(offset, length);
    if (offset > this.inventory.length) throw new Error("Package inventory offset is out of range");
    return this.inventory.slice(offset, offset + length);
  }

  readFile(path: string, offset: number, length: number): Uint8Array {
    this.checkRange(offset, length);
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 4096 || path.includes("\0")
      || new TextEncoder().encode(path).length > 4096) {
      throw new Error("Package source path is invalid");
    }
    const stat = this.filesystem.lstat(path);
    if ((stat.mode & 0o170000) !== 0o100000 || stat.deferred) throw new Error("Package staging requires resident regular file bytes");
    if (offset > stat.size) throw new Error("Package source offset is out of range");
    const output = new Uint8Array(Math.min(length, stat.size - offset));
    if (output.length === 0) return output;
    const handle = this.filesystem.open(path);
    try {
      const count = this.filesystem.read(handle, output, offset, output.length);
      if (count <= 0 || count > output.length) throw new Error("Package source file is truncated");
      return count === output.length ? output : output.slice(0, count);
    } finally { this.filesystem.close(handle); }
  }

  private checkRange(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1
      || length > PACKAGE_SOURCE_CHUNK_BYTES || !Number.isSafeInteger(offset + length)) {
      throw new Error("Package source reads require a valid range of at most 64 KiB");
    }
  }
}
