import type { StatResult } from "../types";
import type { FileSystemBackend, DirEntry } from "./types";
import {
  SharedFS,
  type StatResult as SfsStatResult,
} from "./sharedfs-vendor";

/** Serializable lazy file entry for transfer between instances. */
export interface LazyFileEntry {
  ino: number;
  path: string;
  url: string;
  size: number;
}

/** Options for saving a VFS image. */
export interface VfsImageOptions {
  /**
   * If true, fetch and write all lazy file contents before saving.
   * The resulting image is self-contained with no external URL dependencies.
   * If false (default), lazy file metadata is preserved as-is.
   */
  materializeAll?: boolean;
}

// VFS image binary format constants
const VFS_IMAGE_MAGIC = 0x56465349; // "VFSI"
const VFS_IMAGE_VERSION = 1;
const VFS_IMAGE_FLAG_HAS_LAZY = 1 << 0;
const VFS_IMAGE_HEADER_SIZE = 16; // magic(4) + version(4) + flags(4) + sabLen(4)

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;
  /** Lazy files: inode → { path, url, size }. Cleared per-inode after materialization. */
  private lazyFiles = new Map<number, { path: string; url: string; size: number }>();

  private constructor(fs: SharedFS) {
    this.fs = fs;
  }

  /** Return the underlying SharedArrayBuffer (for sharing with workers). */
  get sharedBuffer(): SharedArrayBuffer {
    return this.fs.buffer as SharedArrayBuffer;
  }

  static create(sab: SharedArrayBuffer, maxSizeBytes?: number): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mkfs(sab, maxSizeBytes));
  }

  static fromExisting(sab: SharedArrayBuffer): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mount(sab));
  }

  /**
   * Register a lazy file: creates an empty stub in SharedFS and records
   * metadata so that read() will fetch content on demand via sync XHR.
   * Returns the inode number (useful for forwarding to other instances).
   */
  registerLazyFile(path: string, url: string, size: number, mode = 0o755): number {
    // Ensure parent directories exist
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      try { this.fs.mkdir(current, 0o755); } catch { /* exists */ }
    }
    // Create empty stub file
    const fd = this.fs.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
    this.fs.close(fd);
    // Get inode
    const st = this.fs.stat(path);
    this.lazyFiles.set(st.ino, { path, url, size });
    return st.ino;
  }

  /**
   * Import lazy file entries from another instance (e.g., main thread → worker).
   * Does not create files — assumes the files already exist in the SharedArrayBuffer.
   */
  importLazyEntries(entries: LazyFileEntry[]): void {
    for (const e of entries) {
      this.lazyFiles.set(e.ino, { path: e.path, url: e.url, size: e.size });
    }
  }

  /** Export all pending lazy entries for transfer to another instance. */
  exportLazyEntries(): LazyFileEntry[] {
    const entries: LazyFileEntry[] = [];
    for (const [ino, { path, url, size }] of this.lazyFiles) {
      entries.push({ ino, path, url, size });
    }
    return entries;
  }

  /**
   * Async-materialize a lazy file if the given path resolves to one.
   * Call this before any synchronous read (e.g., in handleExec) to avoid
   * sync XHR which deadlocks with the COOP/COEP service worker.
   * Returns true if the file was materialized, false if it was already concrete.
   */
  async ensureMaterialized(path: string): Promise<boolean> {
    if (this.lazyFiles.size === 0) return false;
    try {
      const st = this.fs.stat(path); // follows symlinks
      const entry = this.lazyFiles.get(st.ino);
      if (!entry) return false;
      const resp = await fetch(entry.url);
      if (!resp.ok) {
        throw new Error(`Failed to fetch lazy file ${entry.path}: HTTP ${resp.status}`);
      }
      const data = new Uint8Array(await resp.arrayBuffer());
      const fd = this.fs.open(entry.path, 0o1101, 0o755); // O_WRONLY | O_CREAT | O_TRUNC
      this.fs.write(fd, data);
      this.fs.close(fd);
      this.lazyFiles.delete(st.ino);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save the current filesystem state as a portable binary image.
   *
   * With `materializeAll: true`, all lazy files are fetched and written
   * into the filesystem before saving, producing a self-contained image.
   * Otherwise, lazy file metadata (path/URL/size) is preserved in the
   * image and restored on load.
   */
  async saveImage(options?: VfsImageOptions): Promise<Uint8Array> {
    if (options?.materializeAll) {
      const paths = Array.from(this.lazyFiles.values()).map((e) => e.path);
      for (const p of paths) {
        await this.ensureMaterialized(p);
      }
    }

    const sabBytes = new Uint8Array(this.fs.buffer);
    const lazyEntries = this.exportLazyEntries();
    const hasLazy = lazyEntries.length > 0;
    const lazyJson = hasLazy
      ? new TextEncoder().encode(JSON.stringify(lazyEntries))
      : new Uint8Array(0);

    const totalSize =
      VFS_IMAGE_HEADER_SIZE + sabBytes.byteLength + 4 + lazyJson.byteLength;
    const image = new Uint8Array(totalSize);
    const view = new DataView(image.buffer);

    // Header
    view.setUint32(0, VFS_IMAGE_MAGIC, true);
    view.setUint32(4, VFS_IMAGE_VERSION, true);
    view.setUint32(8, hasLazy ? VFS_IMAGE_FLAG_HAS_LAZY : 0, true);
    view.setUint32(12, sabBytes.byteLength, true);

    // SAB data — copy from SharedArrayBuffer (can't use set() directly on SAB-backed views in all environments)
    const sabCopy = new Uint8Array(sabBytes.byteLength);
    sabCopy.set(sabBytes);
    image.set(sabCopy, VFS_IMAGE_HEADER_SIZE);

    // Lazy entries
    const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabBytes.byteLength;
    view.setUint32(lazyOffset, lazyJson.byteLength, true);
    if (lazyJson.byteLength > 0) {
      image.set(lazyJson, lazyOffset + 4);
    }

    return image;
  }

  /**
   * Restore a MemoryFileSystem from a previously saved VFS image.
   * Allocates a new SharedArrayBuffer and populates it from the image.
   *
   * When `maxByteLength` is specified, creates a growable SharedArrayBuffer
   * so the filesystem can expand beyond the image's original size.
   */
  static fromImage(image: Uint8Array, options?: { maxByteLength?: number }): MemoryFileSystem {
    if (image.byteLength < VFS_IMAGE_HEADER_SIZE) {
      throw new Error("VFS image too small");
    }

    const view = new DataView(
      image.buffer,
      image.byteOffset,
      image.byteLength,
    );
    const magic = view.getUint32(0, true);
    if (magic !== VFS_IMAGE_MAGIC) {
      throw new Error(
        `Bad VFS image magic: 0x${magic.toString(16)} (expected 0x${VFS_IMAGE_MAGIC.toString(16)})`,
      );
    }
    const version = view.getUint32(4, true);
    if (version !== VFS_IMAGE_VERSION) {
      throw new Error(
        `Unsupported VFS image version: ${version} (expected ${VFS_IMAGE_VERSION})`,
      );
    }
    const flags = view.getUint32(8, true);
    const sabLen = view.getUint32(12, true);

    if (image.byteLength < VFS_IMAGE_HEADER_SIZE + sabLen + 4) {
      throw new Error("VFS image truncated");
    }

    // Restore SharedArrayBuffer (optionally growable)
    const sabOptions = options?.maxByteLength
      ? { maxByteLength: options.maxByteLength }
      : undefined;
    const sab = new SharedArrayBuffer(sabLen, sabOptions);
    const sabView = new Uint8Array(sab);
    sabView.set(image.subarray(VFS_IMAGE_HEADER_SIZE, VFS_IMAGE_HEADER_SIZE + sabLen));

    const mfs = MemoryFileSystem.fromExisting(sab);

    // Restore lazy entries
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY) {
      const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
      const lazyLen = view.getUint32(lazyOffset, true);
      if (lazyLen > 0) {
        const lazyBytes = image.subarray(lazyOffset + 4, lazyOffset + 4 + lazyLen);
        const entries: LazyFileEntry[] = JSON.parse(
          new TextDecoder().decode(lazyBytes),
        );
        mfs.importLazyEntries(entries);
      }
    }

    return mfs;
  }

  private adaptStat(s: SfsStatResult): StatResult {
    return {
      dev: 0,
      ino: s.ino,
      mode: s.mode,
      nlink: s.linkCount,
      uid: 0,
      gid: 0,
      size: s.size,
      atimeMs: s.atime,
      mtimeMs: s.mtime,
      ctimeMs: s.ctime,
    };
  }

  open(path: string, flags: number, mode: number): number {
    return this.fs.open(path, flags, mode);
  }

  close(handle: number): number {
    this.fs.close(handle);
    return 0;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    if (offset !== null) {
      // pread semantics: read at offset without changing file position
      const savedPos = this.fs.lseek(handle, 0, 1); // SEEK_CUR
      this.fs.lseek(handle, offset, 0); // SEEK_SET
      const n = this.fs.read(handle, buffer.subarray(0, length));
      this.fs.lseek(handle, savedPos, 0); // restore position
      return n;
    }
    return this.fs.read(handle, buffer.subarray(0, length));
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    if (offset !== null) {
      // pwrite semantics: write at offset without changing file position
      const savedPos = this.fs.lseek(handle, 0, 1); // SEEK_CUR
      this.fs.lseek(handle, offset, 0); // SEEK_SET
      const n = this.fs.write(handle, buffer.subarray(0, length));
      this.fs.lseek(handle, savedPos, 0); // restore position
      return n;
    }
    return this.fs.write(handle, buffer.subarray(0, length));
  }

  seek(handle: number, offset: number, whence: number): number {
    return this.fs.lseek(handle, offset, whence);
  }

  fstat(handle: number): StatResult {
    const result = this.adaptStat(this.fs.fstat(handle));
    // Override size for unmaterialized lazy files
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    }
    return result;
  }

  ftruncate(handle: number, length: number): void {
    this.fs.ftruncate(handle, length);
  }

  // SharedFS is memory-backed, fsync is a no-op
  fsync(_handle: number): void {}

  fchmod(handle: number, mode: number): void {
    this.fs.fchmod(handle, mode);
  }
  fchown(_handle: number, _uid: number, _gid: number): void {}

  stat(path: string): StatResult {
    const result = this.adaptStat(this.fs.stat(path));
    // Override size for unmaterialized lazy files
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    }
    return result;
  }

  lstat(path: string): StatResult {
    const result = this.adaptStat(this.fs.lstat(path));
    // Override size for unmaterialized lazy files
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    }
    return result;
  }

  mkdir(path: string, mode: number): void {
    this.fs.mkdir(path, mode);
  }

  rmdir(path: string): void {
    this.fs.rmdir(path);
  }

  unlink(path: string): void {
    this.fs.unlink(path);
  }

  rename(oldPath: string, newPath: string): void {
    this.fs.rename(oldPath, newPath);
  }

  link(existingPath: string, newPath: string): void {
    this.fs.link(existingPath, newPath);
  }

  symlink(target: string, path: string): void {
    this.fs.symlink(target, path);
  }

  readlink(path: string): string {
    return this.fs.readlink(path);
  }

  chmod(path: string, mode: number): void {
    this.fs.chmod(path, mode);
  }
  chown(_path: string, _uid: number, _gid: number): void {}

  // access: check if path exists by stat'ing it (stat throws on error)
  access(path: string, _mode: number): void {
    this.fs.stat(path);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    this.fs.utimens(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  opendir(path: string): number {
    return this.fs.opendir(path);
  }

  readdir(handle: number): DirEntry | null {
    const entry = this.fs.readdirEntry(handle);
    if (!entry) return null;
    // Determine d_type from mode
    const mode = entry.stat.mode;
    let dtype = 0; // DT_UNKNOWN
    if ((mode & 0xf000) === 0x8000) dtype = 8; // DT_REG
    else if ((mode & 0xf000) === 0x4000) dtype = 4; // DT_DIR
    else if ((mode & 0xf000) === 0xa000) dtype = 10; // DT_LNK
    return { name: entry.name, type: dtype, ino: entry.stat.ino };
  }

  closedir(handle: number): void {
    this.fs.closedir(handle);
  }
}
