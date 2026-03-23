/**
 * Node.js platform I/O backend.
 *
 * Implements the PlatformIO interface using synchronous Node.js `fs`
 * operations. Synchronous methods are used because the kernel runs in
 * a Wasm import context which requires blocking, synchronous behavior.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformIO, StatResult } from "../types";
import { translateOpenFlags } from "../vfs/host-fs";

export class NodePlatformIO implements PlatformIO {
  private dirHandles = new Map<number, fs.Dir>();
  private nextDirHandle = 1;
  private fdPositions = new Map<number, number>();
  // Offset from hrtime (monotonic) to epoch, computed once at startup.
  private readonly _epochOffsetNs: bigint;
  // hrtime at creation, used as process start for CPUTIME clocks.
  private readonly _startNs: bigint;
  // /dev/shm replacement directory (macOS has no /dev/shm)
  private readonly _shmDir: string;

  constructor() {
    const hrt = process.hrtime.bigint();
    const wallNs = BigInt(Date.now()) * 1_000_000n;
    this._epochOffsetNs = wallNs - hrt;
    this._startNs = hrt;
    this._shmDir = path.join(os.tmpdir(), "wasm-posix-shm");
  }

  /** Rewrite /dev/shm/ paths to a tmpdir-backed directory (macOS compat). */
  private rewritePath(p: string): string {
    if (p.startsWith("/dev/shm/") || p === "/dev/shm") {
      const rel = p.slice("/dev/shm".length); // "" or "/foo"
      const target = this._shmDir + rel;
      // Ensure the shm directory exists on first use
      fs.mkdirSync(this._shmDir, { recursive: true });
      return target;
    }
    return p;
  }

  open(path: string, flags: number, mode: number): number {
    const fd = fs.openSync(this.rewritePath(path), translateOpenFlags(flags), mode);
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
    const s = fs.statSync(this.rewritePath(path));
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
    const s = fs.lstatSync(this.rewritePath(path));
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
    fs.mkdirSync(this.rewritePath(path), { mode });
  }

  rmdir(path: string): void {
    fs.rmdirSync(this.rewritePath(path));
  }

  unlink(path: string): void {
    fs.unlinkSync(this.rewritePath(path));
  }

  rename(oldPath: string, newPath: string): void {
    fs.renameSync(this.rewritePath(oldPath), this.rewritePath(newPath));
  }

  link(existingPath: string, newPath: string): void {
    fs.linkSync(this.rewritePath(existingPath), this.rewritePath(newPath));
  }

  symlink(target: string, path: string): void {
    fs.symlinkSync(target, this.rewritePath(path));
  }

  readlink(path: string): string {
    return fs.readlinkSync(this.rewritePath(path), "utf8");
  }

  chmod(path: string, mode: number): void {
    fs.chmodSync(this.rewritePath(path), mode);
  }

  chown(path: string, uid: number, gid: number): void {
    fs.chownSync(this.rewritePath(path), uid, gid);
  }

  access(path: string, mode: number): void {
    fs.accessSync(this.rewritePath(path), mode);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const atime = atimeSec + atimeNsec / 1e9;
    const mtime = mtimeSec + mtimeNsec / 1e9;
    fs.utimesSync(this.rewritePath(path), atime, mtime);
  }

  opendir(path: string): number {
    const dir = fs.opendirSync(this.rewritePath(path));
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
    const ns = process.hrtime.bigint();
    if (clockId === 2 || clockId === 3) {
      // CLOCK_PROCESS_CPUTIME_ID / CLOCK_THREAD_CPUTIME_ID
      // Return time since process start (in Wasm, CPU ≈ elapsed)
      const elapsed = ns - this._startNs;
      return { sec: Number(elapsed / 1000000000n), nsec: Number(elapsed % 1000000000n) };
    }
    if (clockId === 1) {
      // CLOCK_MONOTONIC
      return { sec: Number(ns / 1000000000n), nsec: Number(ns % 1000000000n) };
    }
    // CLOCK_REALTIME — use hrtime + epoch offset for nanosecond resolution
    const realNs = ns + this._epochOffsetNs;
    return { sec: Number(realNs / 1000000000n), nsec: Number(realNs % 1000000000n) };
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
