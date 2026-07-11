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
import type { PlatformIO, StatResult, StatfsResult } from "../types";
import { nativeStatfs, translateOpenFlags } from "../vfs/host-fs";
import { NativeMetadataOverlay } from "./native-metadata";

const UTIME_NOW = 0x3fffffff;
const UTIME_OMIT = 0x3ffffffe;

function makeFsError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function checkedSeekPosition(base: number, offset: number): number {
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(offset)) {
    throw makeFsError("EOVERFLOW", "seek offset is not exactly representable");
  }
  const position = base + offset;
  if (!Number.isSafeInteger(position)) {
    throw makeFsError("EOVERFLOW", "seek result is not exactly representable");
  }
  if (position < 0) {
    throw makeFsError("EINVAL", "negative seek offset");
  }
  return position;
}

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
  private readonly metadata = new NativeMetadataOverlay();

  constructor() {
    const hrt = process.hrtime.bigint();
    const wallNs = BigInt(Date.now()) * 1_000_000n;
    this._epochOffsetNs = wallNs - hrt;
    this._startNs = hrt;
    this._shmDir = path.join(os.tmpdir(), "wasm-posix-shm");
  }

  /**
   * Adapt POSIX-shaped kernel paths to whatever Node `fs.*` understands
   * on the host. Two translations live here:
   *
   *   - `/dev/shm/...` → tmpdir-backed dir (macOS has no `/dev/shm`).
   *   - On Windows: `/<letter>/...` → `<letter>:/...`. The kernel is
   *     POSIX; user programs (musl-libc nginx, php-fpm) reject paths
   *     that don't start with `/` as relative. Callers shape Windows
   *     host paths as `/C/Users/...` (matching `@php-wasm/util`'s
   *     `toPosixPath`); we reverse it here before handing the value
   *     to Node `fs.*`.
   */
  private rewritePath(p: string): string {
    if (p.startsWith("/dev/shm/") || p === "/dev/shm") {
      const rel = p.slice("/dev/shm".length); // "" or "/foo"
      const target = this._shmDir + rel;
      // Ensure the shm directory exists on first use
      fs.mkdirSync(this._shmDir, { recursive: true });
      return target;
    }
    if (process.platform === "win32") {
      const winPath = translateWindowsDrivePath(p);
      if (winPath !== null) return winPath;
    }
    return p;
  }

  open(path: string, flags: number, mode: number): number {
    const nativePath = this.rewritePath(path);
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

  seek(
    handle: number,
    offset: number,
    whence: number,
  ): number {
    // SEEK_SET=0, SEEK_CUR=1, SEEK_END=2
    let newPos: number;
    switch (whence) {
      case 0: // SEEK_SET
        newPos = checkedSeekPosition(0, offset);
        break;
      case 1: { // SEEK_CUR
        const cur = this.fdPositions.get(handle) ?? 0;
        newPos = checkedSeekPosition(cur, offset);
        break;
      }
      case 2: {
        // SEEK_END — compute from file size
        const stat = fs.fstatSync(handle);
        newPos = checkedSeekPosition(stat.size, offset);
        break;
      }
      default:
        throw makeFsError("EINVAL", `invalid whence value: ${whence}`);
    }
    this.fdPositions.set(handle, newPos);
    return newPos;
  }

  // Normalize uid/gid to match Process::new's default euid (0). The
  // real macOS/Linux uid of the user running the kernel is not exposed
  // to guest programs — guest sees host-mounted files as self-owned, so
  // tools that compare ownership against their own euid (git's
  // "dubious ownership" check, nginx config ownership, etc.) see a
  // match. Same policy as HostFileSystem.
  fstat(handle: number): StatResult {
    return this.metadata.toStatResult(fs.fstatSync(handle));
  }

  fileIdentity(_path: string, dev: bigint, ino: bigint): string | null {
    // Native inode numbers are filesystem-scoped and therefore preserve
    // aliases reached through separate hard-link paths. An absent inode is
    // not a stable object identity; callers must reject rather than fall back
    // to a pathname that can be renamed or reused.
    if (ino <= 0n || dev < 0n) return null;
    return `node:${dev}:${ino}`;
  }

  stat(path: string): StatResult {
    return this.metadata.toStatResult(fs.statSync(this.rewritePath(path)));
  }

  lstat(path: string): StatResult {
    return this.metadata.toStatResult(fs.lstatSync(this.rewritePath(path)));
  }

  statfs(path: string): StatfsResult {
    return nativeStatfs(this.rewritePath(path));
  }

  mkdir(path: string, mode: number): void {
    const nativePath = this.rewritePath(path);
    fs.mkdirSync(nativePath, { mode });
    this.metadata.chmod(fs.statSync(nativePath), mode);
  }

  rmdir(path: string): void {
    const nativePath = this.rewritePath(path);
    const stat = fs.lstatSync(nativePath);
    fs.rmdirSync(nativePath);
    this.metadata.forget(stat);
  }

  unlink(path: string): void {
    const nativePath = this.rewritePath(path);
    const stat = fs.lstatSync(nativePath);
    fs.unlinkSync(nativePath);
    if (stat.nlink <= 1) this.metadata.forget(stat);
  }

  rename(oldPath: string, newPath: string): void {
    const nativeNewPath = this.rewritePath(newPath);
    let replaced: fs.Stats | undefined;
    try {
      replaced = fs.lstatSync(nativeNewPath);
    } catch {}
    fs.renameSync(this.rewritePath(oldPath), nativeNewPath);
    if (replaced !== undefined && replaced.nlink <= 1) this.metadata.forget(replaced);
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
    this.metadata.chmod(fs.statSync(this.rewritePath(path)), mode);
  }

  chown(path: string, uid: number, gid: number): void {
    this.metadata.chown(fs.statSync(this.rewritePath(path)), uid, gid);
  }

  access(path: string, mode: number): void {
    this.metadata.access(fs.statSync(this.rewritePath(path)), mode);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const nativePath = this.rewritePath(path);
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
    this.metadata.utimens(stat, atimeMs, mtimeMs, fs.statSync(nativePath));
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
    if (clockId === 1 || clockId === 7) {
      // CLOCK_MONOTONIC / CLOCK_BOOTTIME
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

/**
 * Translate a POSIX-shaped path carrying a Windows drive prefix back
 * to native Windows form: `/C/foo` → `C:/foo`, `/C` → `C:/`.
 *
 * Returns `null` if `p` does not begin with `/<letter>` followed by
 * end-of-string or `/`. Exported for unit tests; callers should
 * gate on `process.platform === "win32"` themselves.
 *
 * Mirrors `@php-wasm/util:toPosixPath` on the CLI side.
 */
export function translateWindowsDrivePath(p: string): string | null {
  const m = p.match(/^\/([A-Za-z])(\/.*)?$/);
  if (!m) return null;
  return `${m[1]}:${m[2] ?? "/"}`;
}
