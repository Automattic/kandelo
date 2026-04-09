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

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;
  /** Lazy files: inode → { path, url, size }. Cleared per-inode after materialization. */
  private lazyFiles = new Map<number, { path: string; url: string; size: number }>();

  private constructor(fs: SharedFS) {
    this.fs = fs;
  }

  static create(sab: SharedArrayBuffer): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mkfs(sab));
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
   * Materialize a lazy file: sync XHR fetch the content and write to SharedFS.
   * Must be called from a web worker (sync XHR is blocked on the main thread).
   */
  private materialize(ino: number, entry: { path: string; url: string; size: number }): void {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", entry.url, false); // synchronous
    xhr.responseType = "arraybuffer";
    xhr.send();
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`Failed to fetch lazy file ${entry.path}: HTTP ${xhr.status}`);
    }
    const data = new Uint8Array(xhr.response as ArrayBuffer);
    const fd = this.fs.open(entry.path, 0o1101, 0o755); // O_WRONLY | O_CREAT | O_TRUNC
    this.fs.write(fd, data);
    this.fs.close(fd);
    this.lazyFiles.delete(ino);
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
    // Materialize lazy files on first content read
    if (this.lazyFiles.size > 0) {
      const st = this.fs.fstat(handle);
      const entry = this.lazyFiles.get(st.ino);
      if (entry) {
        this.materialize(st.ino, entry);
      }
    }

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

  // SharedFS doesn't distinguish symlinks in lstat vs stat
  lstat(path: string): StatResult {
    return this.stat(path);
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
