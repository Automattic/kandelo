/**
 * Node.js platform I/O backend.
 *
 * Implements the PlatformIO interface using synchronous Node.js `fs`
 * operations. Synchronous methods are used because the kernel runs in
 * a Wasm import context which requires blocking, synchronous behavior.
 */

import * as fs from "node:fs";
import type { PlatformIO, StatResult } from "../types";

/**
 * Translate Linux/POSIX open flags (as used by musl libc) to the
 * platform-native flag values that Node.js `fs.openSync` expects.
 * The numeric values differ between Linux and macOS/BSD.
 */
function translateOpenFlags(linuxFlags: number): number {
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

export class NodePlatformIO implements PlatformIO {
  private dirHandles = new Map<number, fs.Dir>();
  private nextDirHandle = 1;
  private fdPositions = new Map<number, number>();

  open(path: string, flags: number, mode: number): number {
    const fd = fs.openSync(path, translateOpenFlags(flags), mode);
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

  seek(
    handle: number,
    offset: number,
    whence: number,
  ): number {
    // SEEK_SET=0, SEEK_CUR=1, SEEK_END=2
    let newPos: number;
    switch (whence) {
      case 0: // SEEK_SET
        newPos = offset;
        break;
      case 1: { // SEEK_CUR
        const cur = this.fdPositions.get(handle) ?? 0;
        newPos = cur + offset;
        break;
      }
      case 2: {
        // SEEK_END — compute from file size
        const stat = fs.fstatSync(handle);
        newPos = stat.size + offset;
        break;
      }
      default:
        throw new Error(`Invalid whence value: ${whence}`);
    }
    this.fdPositions.set(handle, newPos);
    return newPos;
  }

  fstat(handle: number): StatResult {
    const stat = fs.fstatSync(handle);
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      atimeMs: stat.atimeMs,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  }

  stat(path: string): StatResult {
    const s = fs.statSync(path);
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

  lstat(path: string): StatResult {
    const s = fs.lstatSync(path);
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

  mkdir(path: string, mode: number): void {
    fs.mkdirSync(path, { mode });
  }

  rmdir(path: string): void {
    fs.rmdirSync(path);
  }

  unlink(path: string): void {
    fs.unlinkSync(path);
  }

  rename(oldPath: string, newPath: string): void {
    fs.renameSync(oldPath, newPath);
  }

  link(existingPath: string, newPath: string): void {
    fs.linkSync(existingPath, newPath);
  }

  symlink(target: string, path: string): void {
    fs.symlinkSync(target, path);
  }

  readlink(path: string): string {
    return fs.readlinkSync(path, "utf8");
  }

  chmod(path: string, mode: number): void {
    fs.chmodSync(path, mode);
  }

  chown(path: string, uid: number, gid: number): void {
    fs.chownSync(path, uid, gid);
  }

  access(path: string, mode: number): void {
    fs.accessSync(path, mode);
  }

  opendir(path: string): number {
    const dir = fs.opendirSync(path);
    const handle = this.nextDirHandle++;
    this.dirHandles.set(handle, dir);
    return handle;
  }

  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("Invalid dir handle");
    const entry = dir.readSync();
    if (!entry) return null;
    // Map Dirent to d_type
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
    fs.fchownSync(handle, uid, gid);
  }

  clockGettime(
    clockId: number,
  ): { sec: number; nsec: number } {
    if (clockId === 1) {
      // CLOCK_MONOTONIC: use process.hrtime.bigint()
      const ns = process.hrtime.bigint();
      const sec = Number(ns / 1000000000n);
      const nsec = Number(ns % 1000000000n);
      return { sec, nsec };
    }
    // CLOCK_REALTIME
    const now = Date.now();
    const sec = Math.floor(now / 1000);
    const nsec = (now % 1000) * 1_000_000;
    return { sec, nsec };
  }

  nanosleep(sec: number, nsec: number): void {
    const ms = sec * 1000 + Math.floor(nsec / 1_000_000);
    if (ms > 0) {
      const sab = new SharedArrayBuffer(4);
      const arr = new Int32Array(sab);
      Atomics.wait(arr, 0, 0, ms);
    }
  }
}
