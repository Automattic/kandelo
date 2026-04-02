import type { StatResult } from "../types";
import type { FileSystemBackend, DirEntry } from "./types";
import {
  SharedFS,
  type StatResult as SfsStatResult,
} from "./sharedfs-vendor";

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;

  private constructor(fs: SharedFS) {
    this.fs = fs;
  }

  static create(sab: SharedArrayBuffer): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mkfs(sab));
  }

  static fromExisting(sab: SharedArrayBuffer): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mount(sab));
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
    return this.adaptStat(this.fs.fstat(handle));
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
    return this.adaptStat(this.fs.stat(path));
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
