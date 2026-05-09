import { decompress as zstdDecompress } from "fzstd";
import type { StatResult } from "../types";
import type { FileSystemBackend, DirEntry } from "./types";
import {
  SharedFS,
  type StatResult as SfsStatResult,
} from "./sharedfs-vendor";
import type { ZipEntry } from "./zip";

/** Serializable lazy file entry for transfer between instances. */
export interface LazyFileEntry {
  ino: number;
  path: string;
  url: string;
  size: number;
}

/** Per-file metadata for a file inside a lazy archive. */
export interface LazyArchiveFileEntry {
  ino: number;
  size: number;
  isSymlink: boolean;
  deleted: boolean;
}

/**
 * A group of files whose content comes from a single zip archive.
 * Accessing any member materializes the entire archive in one fetch.
 */
export interface LazyArchiveGroup {
  url: string;
  mountPrefix: string;
  materialized: boolean;
  entries: Map<string, LazyArchiveFileEntry>; // keyed by VFS absolute path
}

/** JSON-serializable form of LazyArchiveGroup for cross-worker transfer. */
export interface SerializedLazyArchiveEntry {
  url: string;
  mountPrefix: string;
  materialized: boolean;
  entries: Array<{
    vfsPath: string;
    ino: number;
    size: number;
    isSymlink: boolean;
    deleted: boolean;
  }>;
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

// zstd frame magic (little-endian on the wire: 28 B5 2F FD).
// fromImage() auto-detects this and decompresses transparently so callers
// don't have to know whether the bytes came from a `.vfs` or `.vfs.zst`.
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd];

// VFS image binary format constants
const VFS_IMAGE_MAGIC = 0x56465349; // "VFSI"
const VFS_IMAGE_VERSION = 1;
const VFS_IMAGE_FLAG_HAS_LAZY = 1 << 0;
const VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES = 1 << 1;
const VFS_IMAGE_HEADER_SIZE = 16; // magic(4) + version(4) + flags(4) + sabLen(4)

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;
  /** Lazy files: inode → { path, url, size }. Cleared per-inode after materialization. */
  private lazyFiles = new Map<number, { path: string; url: string; size: number }>();
  /** Lazy archive groups (bundle of files backed by one zip URL). */
  private lazyArchiveGroups: LazyArchiveGroup[] = [];
  /** Fast lookup: inode → group it belongs to. Cleared per-group after materialization. */
  private lazyArchiveInodes = new Map<number, LazyArchiveGroup>();

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
   * Register a lazy archive group: creates stubs in SharedFS for every file
   * entry and records metadata so that accessing any one of them triggers a
   * single archive fetch that materializes all files in the group.
   *
   * Parse the zip's central directory (via host/src/vfs/zip.ts) and pass the
   * resulting ZipEntry[] in `zipEntries`. `mountPrefix` maps the zip's
   * internal paths into the VFS (e.g. prefix "/usr/" turns "bin/vim" into
   * "/usr/bin/vim").
   */
  registerLazyArchiveFromEntries(
    url: string,
    zipEntries: ZipEntry[],
    mountPrefix: string,
    symlinkTargets?: Map<string, string>,
  ): LazyArchiveGroup {
    const group: LazyArchiveGroup = {
      url,
      mountPrefix,
      materialized: false,
      entries: new Map(),
    };

    const normalized = mountPrefix.replace(/\/+$/, "");
    for (const ze of zipEntries) {
      if (ze.isDirectory) continue;

      const vfsPath = normalized + "/" + ze.fileName;
      const parts = vfsPath.split("/").filter(Boolean);
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current += "/" + parts[i];
        try { this.fs.mkdir(current, 0o755); } catch { /* exists */ }
      }

      if (ze.isSymlink && symlinkTargets?.has(ze.fileName)) {
        const target = symlinkTargets.get(ze.fileName)!;
        this.fs.symlink(target, vfsPath);
      } else {
        const fd = this.fs.open(vfsPath, 0o1101, ze.mode); // O_WRONLY | O_CREAT | O_TRUNC
        this.fs.close(fd);
      }

      const st = this.fs.lstat(vfsPath);
      const entry: LazyArchiveFileEntry = {
        ino: st.ino,
        size: ze.uncompressedSize,
        isSymlink: ze.isSymlink,
        deleted: false,
      };
      group.entries.set(vfsPath, entry);
      this.lazyArchiveInodes.set(st.ino, group);
    }

    this.lazyArchiveGroups.push(group);
    return group;
  }

  /** Import lazy archive groups from another instance. Assumes stubs already exist. */
  importLazyArchiveEntries(serialized: SerializedLazyArchiveEntry[]): void {
    for (const s of serialized) {
      const entries = new Map<string, LazyArchiveFileEntry>();
      for (const e of s.entries) {
        entries.set(e.vfsPath, {
          ino: e.ino,
          size: e.size,
          isSymlink: e.isSymlink,
          deleted: e.deleted,
        });
      }
      const group: LazyArchiveGroup = {
        url: s.url,
        mountPrefix: s.mountPrefix,
        materialized: s.materialized,
        entries,
      };
      this.lazyArchiveGroups.push(group);
      if (!group.materialized) {
        for (const [, entry] of entries) {
          if (!entry.deleted) {
            this.lazyArchiveInodes.set(entry.ino, group);
          }
        }
      }
    }
  }

  /**
   * Rewrite the URL of every registered lazy archive group. Useful when the
   * VFS image was built with relative URLs (e.g. "vim.zip") and the runtime
   * needs to resolve them against a deployment base URL.
   */
  rewriteLazyArchiveUrls(transform: (url: string) => string): void {
    for (const group of this.lazyArchiveGroups) {
      group.url = transform(group.url);
    }
  }

  /** Export all lazy archive groups for transfer to another instance. */
  exportLazyArchiveEntries(): SerializedLazyArchiveEntry[] {
    return this.lazyArchiveGroups.map((group) => ({
      url: group.url,
      mountPrefix: group.mountPrefix,
      materialized: group.materialized,
      entries: Array.from(group.entries, ([vfsPath, entry]) => ({
        vfsPath,
        ino: entry.ino,
        size: entry.size,
        isSymlink: entry.isSymlink,
        deleted: entry.deleted,
      })),
    }));
  }

  /**
   * Async-materialize a lazy file or archive-backed file if the given path
   * resolves to one. Call this before any synchronous read (e.g. in
   * handleExec) to avoid sync XHR which deadlocks with COOP/COEP.
   * Returns true if something was materialized, false if already concrete.
   */
  async ensureMaterialized(path: string): Promise<boolean> {
    if (this.lazyFiles.size === 0 && this.lazyArchiveInodes.size === 0) return false;
    try {
      const st = this.fs.stat(path); // follows symlinks
      const entry = this.lazyFiles.get(st.ino);
      if (entry) {
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
      }
      const group = this.lazyArchiveInodes.get(st.ino);
      if (group) {
        await this.ensureArchiveMaterialized(group);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Materialize a full lazy archive group: fetch the zip once, parse its
   * central directory, and write every non-deleted entry into its stub.
   * Subsequent calls are no-ops.
   */
  async ensureArchiveMaterialized(group: LazyArchiveGroup): Promise<void> {
    if (group.materialized) return;

    const resp = await fetch(group.url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch archive ${group.url}: HTTP ${resp.status}`);
    }
    const zipData = new Uint8Array(await resp.arrayBuffer());

    const { parseZipCentralDirectory, extractZipEntry } = await import("./zip");
    const zipEntries = parseZipCentralDirectory(zipData);
    const zipLookup = new Map<string, ZipEntry>();
    for (const ze of zipEntries) zipLookup.set(ze.fileName, ze);

    const normalizedPrefix = group.mountPrefix.replace(/\/+$/, "");
    for (const [vfsPath, archiveEntry] of group.entries) {
      if (archiveEntry.deleted) continue;
      if (archiveEntry.isSymlink) continue; // symlinks already created at registration
      const zipFileName = vfsPath.slice(normalizedPrefix.length + 1);
      const ze = zipLookup.get(zipFileName);
      if (!ze) continue;
      const content = extractZipEntry(zipData, ze);
      const fd = this.fs.open(vfsPath, 0o1101, 0o755); // O_WRONLY | O_CREAT | O_TRUNC
      if (content.length > 0) this.fs.write(fd, content);
      this.fs.close(fd);
    }

    group.materialized = true;
    for (const [, archiveEntry] of group.entries) {
      this.lazyArchiveInodes.delete(archiveEntry.ino);
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

    const archiveEntries = this.exportLazyArchiveEntries();
    const hasArchives = archiveEntries.length > 0;
    const archiveJson = hasArchives
      ? new TextEncoder().encode(JSON.stringify(archiveEntries))
      : new Uint8Array(0);

    // Layout: header | sab | u32 lazyLen | lazyJson | u32 archiveLen | archiveJson
    // archive section is only appended when HAS_LAZY_ARCHIVES flag is set.
    const archiveSectionSize = hasArchives ? 4 + archiveJson.byteLength : 0;
    const totalSize =
      VFS_IMAGE_HEADER_SIZE + sabBytes.byteLength + 4 + lazyJson.byteLength + archiveSectionSize;
    const image = new Uint8Array(totalSize);
    const view = new DataView(image.buffer);

    // Header
    view.setUint32(0, VFS_IMAGE_MAGIC, true);
    view.setUint32(4, VFS_IMAGE_VERSION, true);
    view.setUint32(
      8,
      (hasLazy ? VFS_IMAGE_FLAG_HAS_LAZY : 0) |
        (hasArchives ? VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES : 0),
      true,
    );
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

    // Archive entries
    if (hasArchives) {
      const archiveOffset = lazyOffset + 4 + lazyJson.byteLength;
      view.setUint32(archiveOffset, archiveJson.byteLength, true);
      image.set(archiveJson, archiveOffset + 4);
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
    if (
      image.byteLength >= ZSTD_MAGIC_BYTES.length &&
      image[0] === ZSTD_MAGIC_BYTES[0] &&
      image[1] === ZSTD_MAGIC_BYTES[1] &&
      image[2] === ZSTD_MAGIC_BYTES[2] &&
      image[3] === ZSTD_MAGIC_BYTES[3]
    ) {
      image = decompressZstd(image);
    }

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

    // Restore SharedArrayBuffer (optionally growable). The 2-arg form is
    // typed via the ES2024.SharedMemory lib (see host/tsconfig.json).
    const sabOptions = options?.maxByteLength
      ? { maxByteLength: options.maxByteLength }
      : undefined;
    const sab = new SharedArrayBuffer(sabLen, sabOptions);
    const sabView = new Uint8Array(sab);
    sabView.set(image.subarray(VFS_IMAGE_HEADER_SIZE, VFS_IMAGE_HEADER_SIZE + sabLen));

    const mfs = MemoryFileSystem.fromExisting(sab);

    // Restore lazy entries
    const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
    const lazyLen = view.getUint32(lazyOffset, true);
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY) {
      if (lazyLen > 0) {
        const lazyBytes = image.subarray(lazyOffset + 4, lazyOffset + 4 + lazyLen);
        const entries: LazyFileEntry[] = JSON.parse(
          new TextDecoder().decode(lazyBytes),
        );
        mfs.importLazyEntries(entries);
      }
    }

    // Restore lazy archive groups
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
      const archiveOffset = lazyOffset + 4 + lazyLen;
      if (image.byteLength < archiveOffset + 4) {
        throw new Error("VFS image truncated (lazy archive section)");
      }
      const archiveLen = view.getUint32(archiveOffset, true);
      if (archiveLen > 0) {
        const archiveBytes = image.subarray(
          archiveOffset + 4,
          archiveOffset + 4 + archiveLen,
        );
        const entries: SerializedLazyArchiveEntry[] = JSON.parse(
          new TextDecoder().decode(archiveBytes),
        );
        mfs.importLazyArchiveEntries(entries);
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
      uid: s.uid,
      gid: s.gid,
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
    // Override size for unmaterialized lazy files / archive entries
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    } else {
      const group = this.lazyArchiveInodes.get(result.ino);
      if (group) {
        for (const archiveEntry of group.entries.values()) {
          if (archiveEntry.ino === result.ino) {
            result.size = archiveEntry.size;
            break;
          }
        }
      }
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
  fchown(handle: number, uid: number, gid: number): void {
    this.fs.fchown(handle, uid, gid);
  }

  stat(path: string): StatResult {
    const result = this.adaptStat(this.fs.stat(path));
    // Override size for unmaterialized lazy files / archive entries
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    } else {
      const group = this.lazyArchiveInodes.get(result.ino);
      if (group) {
        for (const archiveEntry of group.entries.values()) {
          if (archiveEntry.ino === result.ino) {
            result.size = archiveEntry.size;
            break;
          }
        }
      }
    }
    return result;
  }

  lstat(path: string): StatResult {
    const result = this.adaptStat(this.fs.lstat(path));
    // Override size for unmaterialized lazy files / archive entries
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    } else {
      const group = this.lazyArchiveInodes.get(result.ino);
      if (group) {
        for (const archiveEntry of group.entries.values()) {
          if (archiveEntry.ino === result.ino) {
            result.size = archiveEntry.size;
            break;
          }
        }
      }
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
    // If the path belongs to an unmaterialized archive group, mark the entry
    // as deleted so materialization skips it.
    if (this.lazyArchiveInodes.size > 0) {
      try {
        const st = this.fs.lstat(path);
        const group = this.lazyArchiveInodes.get(st.ino);
        if (group) {
          const entry = group.entries.get(path);
          if (entry) entry.deleted = true;
          this.lazyArchiveInodes.delete(st.ino);
        }
      } catch { /* not present — unlink will raise the real error */ }
    }
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
  chown(path: string, uid: number, gid: number): void {
    this.fs.chown(path, uid, gid);
  }
  lchown(path: string, uid: number, gid: number): void {
    this.fs.lchown(path, uid, gid);
  }

  createFileWithOwner(
    path: string,
    mode: number,
    uid: number,
    gid: number,
    content: Uint8Array,
  ): void {
    const fd = this.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
    if (content.length > 0) this.write(fd, content, null, content.length);
    this.close(fd);
    this.chown(path, uid, gid);
    this.chmod(path, mode);
  }

  mkdirWithOwner(path: string, mode: number, uid: number, gid: number): void {
    this.mkdir(path, mode);
    this.chown(path, uid, gid);
    this.chmod(path, mode);
  }

  symlinkWithOwner(target: string, path: string, uid: number, gid: number): void {
    this.symlink(target, path);
    this.lchown(path, uid, gid);
  }

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

// fzstd is a regular sync static import (see top of file). Earlier we
// tried lazy-loading it via top-level `await import("fzstd")`, but a
// top-level await turns this module — and every consumer, including
// the kernel worker entry — into an async module. `BrowserKernel.boot
// Worker()` posts its `init` message immediately after `new Worker(url)`,
// before the worker's async load completes; the message was being
// dropped before the worker's onmessage handler became reachable. A
// static import is bundled by Vite for browser pages and resolved by
// Node for tests + build scripts (host/package.json + examples/browser/
// package.json both declare fzstd, so it's always installed).
function decompressZstd(image: Uint8Array): Uint8Array {
  return zstdDecompress(image);
}
