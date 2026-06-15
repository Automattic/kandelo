/**
 * HostFileSystem — a Node.js passthrough FileSystemBackend.
 *
 * All paths are sandboxed under `rootPath`; any attempt to escape
 * via `../` or symlinks resolving outside the root is rejected.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { StatResult, StatfsResult } from "../types";
import { NativeMetadataOverlay } from "../platform/native-metadata";
import type { FileSystemBackend, DirEntry } from "./types";
import { DEFAULT_STATFS_BLOCK_SIZE, DEFAULT_STATFS_NAMELEN } from "../statfs";

const UTIME_NOW = 0x3fffffff;
const UTIME_OMIT = 0x3ffffffe;

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

function asSafeInteger(value: number | bigint | undefined): number {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return Number(value > max ? max : value);
  }
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

export function nativeStatfs(path: string): StatfsResult {
  const statfs = fs.statfsSync(path, { bigint: false });
  const bsize = asSafeInteger(statfs.bsize) || DEFAULT_STATFS_BLOCK_SIZE;
  return {
    type: statfs.type >>> 0,
    bsize,
    blocks: asSafeInteger(statfs.blocks),
    bfree: asSafeInteger(statfs.bfree),
    bavail: asSafeInteger(statfs.bavail),
    files: asSafeInteger(statfs.files),
    ffree: asSafeInteger(statfs.ffree),
    fsid: 0,
    namelen: DEFAULT_STATFS_NAMELEN,
    frsize: bsize,
    flags: 0,
  };
}

export class HostFileSystem implements FileSystemBackend {
  private rootPath: string;
  private fdPositions = new Map<number, number>();
  private dirHandles = new Map<number, fs.Dir>();
  private nextDirHandle = 1;
  private metadata = new NativeMetadataOverlay();

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
    if (
      resolved !== this.rootPath &&
      !resolved.startsWith(this.rootPath + nodePath.sep)
    ) {
      throw new Error("EACCES: path traversal blocked");
    }
    return resolved;
  }

  private toStatResult(s: fs.Stats): StatResult {
    // Normalize uid/gid to match Process::new's default euid (0).
    // The real macOS/Linux uid of the user running the kernel is not
    // exposed to guest programs — guest sees the sandbox as
    // self-owned, so tools that compare ownership against their own
    // euid (e.g. git's "dubious ownership" check) see a match.
    // chmod/chown are virtualized through the same overlay so host-backed
    // mounts never mutate native permission or ownership bits.
    return this.metadata.toStatResult(s);
  }

  // ── File handle operations ───────────────────────────────────

  open(path: string, flags: number, mode: number): number {
    const nativePath = this.safePath(path);
    const created = (flags & 0o100) !== 0 && !fs.existsSync(nativePath);
    const fd = fs.openSync(nativePath, translateOpenFlags(flags), mode);
    if (created) this.metadata.chmod(fs.fstatSync(fd), mode);
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
    if (bytesWritten > 0) this.metadata.noteNativeContentChange(fs.fstatSync(handle));
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
    this.metadata.noteNativeContentChange(fs.fstatSync(handle));
  }

  fsync(handle: number): void {
    fs.fsyncSync(handle);
  }

  fchmod(handle: number, mode: number): void {
    this.metadata.chmod(fs.fstatSync(handle), mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    this.metadata.chown(fs.fstatSync(handle), uid, gid);
  }

  // ── Path-based operations ───────────────────────────────────

  stat(path: string): StatResult {
    return this.toStatResult(fs.statSync(this.safePath(path)));
  }

  lstat(path: string): StatResult {
    return this.toStatResult(fs.lstatSync(this.safePath(path)));
  }

  statfs(path: string): StatfsResult {
    return nativeStatfs(this.safePath(path));
  }

  mkdir(path: string, mode: number): void {
    const nativePath = this.safePath(path);
    fs.mkdirSync(nativePath, { mode });
    this.metadata.chmod(fs.statSync(nativePath), mode);
  }

  rmdir(path: string): void {
    const nativePath = this.safePath(path);
    const stat = fs.lstatSync(nativePath);
    fs.rmdirSync(nativePath);
    this.metadata.forget(stat);
  }

  unlink(path: string): void {
    const nativePath = this.safePath(path);
    const stat = fs.lstatSync(nativePath);
    fs.unlinkSync(nativePath);
    if (stat.nlink <= 1) this.metadata.forget(stat);
  }

  rename(oldPath: string, newPath: string): void {
    const nativeNewPath = this.safePath(newPath);
    let replaced: fs.Stats | undefined;
    try {
      replaced = fs.lstatSync(nativeNewPath);
    } catch {}
    fs.renameSync(this.safePath(oldPath), nativeNewPath);
    if (replaced !== undefined && replaced.nlink <= 1) this.metadata.forget(replaced);
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
    this.metadata.chmod(fs.statSync(this.safePath(path)), mode);
  }

  chown(path: string, uid: number, gid: number): void {
    this.metadata.chown(fs.statSync(this.safePath(path)), uid, gid);
  }

  access(path: string, mode: number): void {
    this.metadata.access(fs.statSync(this.safePath(path)), mode);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const nativePath = this.safePath(path);
    if (atimeNsec === UTIME_OMIT && mtimeNsec === UTIME_OMIT) return;

    const stat = fs.statSync(nativePath);
    const current = this.metadata.toStatResult(stat);
    const nowMs = Date.now();
    const atimeMs = atimeNsec === UTIME_OMIT
      ? current.atimeMs
      : atimeNsec === UTIME_NOW
        ? nowMs
        : atimeSec * 1000 + Math.floor(atimeNsec / 1_000_000);
    const mtimeMs = mtimeNsec === UTIME_OMIT
      ? current.mtimeMs
      : mtimeNsec === UTIME_NOW
        ? nowMs
        : mtimeSec * 1000 + Math.floor(mtimeNsec / 1_000_000);
    fs.utimesSync(nativePath, atimeMs / 1000, mtimeMs / 1000);
    this.metadata.utimens(stat, atimeMs, mtimeMs, fs.statSync(nativePath).ctimeMs);
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
