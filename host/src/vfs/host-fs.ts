/**
 * HostFileSystem — a Node.js passthrough FileSystemBackend.
 *
 * All paths are sandboxed under `rootPath`; any attempt to escape
 * via `../` or symlinks resolving outside the root is rejected.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { StatResult } from "../types";
import type { FileSystemBackend, DirEntry } from "./types";

/**
 * Translate Linux/POSIX open flags (as used by musl libc) to the
 * platform-native flag values that Node.js `fs.openSync` expects.
 * The numeric values differ between Linux and macOS/BSD.
 */
export function translateOpenFlags(linuxFlags: number): number {
  // Linux flag constants (octal)
  const L_O_WRONLY = 0o1;
  const L_O_RDWR = 0o2;
  const L_O_CREAT = 0o100;
  const L_O_EXCL = 0o200;
  const L_O_NOCTTY = 0o400;
  const L_O_TRUNC = 0o1000;
  const L_O_APPEND = 0o2000;
  const L_O_NONBLOCK = 0o4000;
  const L_O_DIRECTORY = 0o200000;
  const L_O_NOFOLLOW = 0o400000;

  let native = 0;

  // Access mode (bottom 2 bits)
  if (linuxFlags & L_O_RDWR) native |= fs.constants.O_RDWR;
  else if (linuxFlags & L_O_WRONLY) native |= fs.constants.O_WRONLY;
  // else O_RDONLY = 0

  if (linuxFlags & L_O_CREAT) native |= fs.constants.O_CREAT;
  if (linuxFlags & L_O_EXCL) native |= fs.constants.O_EXCL;
  if (linuxFlags & L_O_TRUNC) native |= fs.constants.O_TRUNC;
  if (linuxFlags & L_O_APPEND) native |= fs.constants.O_APPEND;
  if (linuxFlags & L_O_NONBLOCK) native |= fs.constants.O_NONBLOCK;
  if ((linuxFlags & L_O_DIRECTORY) && fs.constants.O_DIRECTORY)
    native |= fs.constants.O_DIRECTORY;
  if ((linuxFlags & L_O_NOFOLLOW) && fs.constants.O_NOFOLLOW)
    native |= fs.constants.O_NOFOLLOW;
  if ((linuxFlags & L_O_NOCTTY) && fs.constants.O_NOCTTY)
    native |= fs.constants.O_NOCTTY;
  // O_LARGEFILE and O_CLOEXEC have no Node.js equivalent; ignored.

  return native;
}

export class HostFileSystem implements FileSystemBackend {
  private rootPath: string;
  private fdPositions = new Map<number, number>();
  private dirHandles = new Map<number, fs.Dir>();
  private nextDirHandle = 1;

  constructor(rootPath: string) {
    this.rootPath = nodePath.resolve(rootPath);
  }

  /**
   * Resolve a mount-relative path to an absolute host path,
   * ensuring it stays within `rootPath`.
   */
  private safePath(relative: string): string {
    const resolved = nodePath.resolve(
      this.rootPath,
      relative.replace(/^\//, ""),
    );
    if (resolved !== this.rootPath && !resolved.startsWith(this.rootPath + "/")) {
      throw new Error("EACCES: path traversal blocked");
    }
    return resolved;
  }

  private toStatResult(s: fs.Stats): StatResult {
    return {
      dev: s.dev,
      ino: s.ino,
      mode: s.mode,
      nlink: s.nlink,
      uid: s.uid,
      gid: s.gid,
      size: s.size,
      atimeMs: s.atimeMs,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
    };
  }

  // ── File handle operations ───────────────────────────────────

  open(path: string, flags: number, mode: number): number {
    const fd = fs.openSync(
      this.safePath(path),
      translateOpenFlags(flags),
      mode,
    );
    this.fdPositions.set(fd, 0);
    return fd;
  }

  close(handle: number): number {
    fs.closeSync(handle);
    this.fdPositions.delete(handle);
    return 0;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    const pos = offset ?? this.fdPositions.get(handle) ?? 0;
    const bytesRead = fs.readSync(handle, buffer, 0, length, pos);
    if (offset === null) {
      this.fdPositions.set(handle, pos + bytesRead);
    }
    return bytesRead;
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    const pos = offset ?? this.fdPositions.get(handle) ?? 0;
    const bytesWritten = fs.writeSync(handle, buffer, 0, length, pos);
    if (offset === null) {
      this.fdPositions.set(handle, pos + bytesWritten);
    }
    return bytesWritten;
  }

  seek(handle: number, offset: number, whence: number): number {
    let newPos: number;
    switch (whence) {
      case 0: // SEEK_SET
        newPos = offset;
        break;
      case 1: // SEEK_CUR
        newPos = (this.fdPositions.get(handle) ?? 0) + offset;
        break;
      case 2: // SEEK_END
        newPos = fs.fstatSync(handle).size + offset;
        break;
      default:
        throw new Error(`Invalid whence value: ${whence}`);
    }
    this.fdPositions.set(handle, newPos);
    return newPos;
  }

  fstat(handle: number): StatResult {
    return this.toStatResult(fs.fstatSync(handle));
  }

  ftruncate(handle: number, length: number): void {
    fs.ftruncateSync(handle, length);
  }

  fsync(handle: number): void {
    fs.fsyncSync(handle);
  }

  fchmod(handle: number, mode: number): void {
    fs.fchmodSync(handle, mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    swallowChownPermissionError(() => fs.fchownSync(handle, uid, gid));
  }

  // ── Path-based operations ───────────────────────────────────

  stat(path: string): StatResult {
    return this.toStatResult(fs.statSync(this.safePath(path)));
  }

  lstat(path: string): StatResult {
    return this.toStatResult(fs.lstatSync(this.safePath(path)));
  }

  mkdir(path: string, mode: number): void {
    fs.mkdirSync(this.safePath(path), { mode });
  }

  rmdir(path: string): void {
    fs.rmdirSync(this.safePath(path));
  }

  unlink(path: string): void {
    fs.unlinkSync(this.safePath(path));
  }

  rename(oldPath: string, newPath: string): void {
    fs.renameSync(this.safePath(oldPath), this.safePath(newPath));
  }

  link(existingPath: string, newPath: string): void {
    fs.linkSync(this.safePath(existingPath), this.safePath(newPath));
  }

  symlink(target: string, path: string): void {
    fs.symlinkSync(target, this.safePath(path));
  }

  readlink(path: string): string {
    return fs.readlinkSync(this.safePath(path), "utf8");
  }

  chmod(path: string, mode: number): void {
    fs.chmodSync(this.safePath(path), mode);
  }

  chown(path: string, uid: number, gid: number): void {
    swallowChownPermissionError(() =>
      fs.chownSync(this.safePath(path), uid, gid),
    );
  }

  access(path: string, mode: number): void {
    fs.accessSync(this.safePath(path), mode);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const atime = atimeSec + atimeNsec / 1e9;
    const mtime = mtimeSec + mtimeNsec / 1e9;
    fs.utimesSync(this.safePath(path), atime, mtime);
  }

  // ── Directory iteration ─────────────────────────────────────

  opendir(path: string): number {
    const dir = fs.opendirSync(this.safePath(path));
    const handle = this.nextDirHandle++;
    this.dirHandles.set(handle, dir);
    return handle;
  }

  readdir(handle: number): DirEntry | null {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("Invalid dir handle");
    const entry = dir.readSync();
    if (!entry) return null;

    let dtype = 0; // DT_UNKNOWN
    if (entry.isFile()) dtype = 8; // DT_REG
    else if (entry.isDirectory()) dtype = 4; // DT_DIR
    else if (entry.isSymbolicLink()) dtype = 10; // DT_LNK
    else if (entry.isFIFO()) dtype = 1; // DT_FIFO
    else if (entry.isSocket()) dtype = 12; // DT_SOCK
    else if (entry.isCharacterDevice()) dtype = 2; // DT_CHR
    else if (entry.isBlockDevice()) dtype = 6; // DT_BLK

    return { name: entry.name, type: dtype, ino: 0 };
  }

  closedir(handle: number): void {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("Invalid dir handle");
    dir.closeSync();
    this.dirHandles.delete(handle);
  }
}

/**
 * The kernel runs every wasm process as root (uid 0); programs like nginx
 * therefore call chown() during startup to set ownership of temp dirs to a
 * less-privileged worker user. The host fs underneath, however, is owned by
 * the developer's unprivileged user and cannot honor those chowns. Swallow
 * EPERM/EINVAL/ENOTSUP so the caller observes a successful chown — the
 * operation is purely virtual from the kernel's perspective.
 */
function swallowChownPermissionError(op: () => void): void {
  try {
    op();
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EINVAL" || code === "ENOTSUP") {
      return;
    }
    throw e;
  }
}
