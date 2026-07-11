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

function makeHostFsError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function checkedSeekPosition(base: number, offset: number): number {
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(offset)) {
    throw makeHostFsError("EOVERFLOW", "seek offset is not exactly representable");
  }
  const position = base + offset;
  if (!Number.isSafeInteger(position)) {
    throw makeHostFsError("EOVERFLOW", "seek result is not exactly representable");
  }
  if (position < 0) {
    throw makeHostFsError("EINVAL", "negative seek offset");
  }
  return position;
}

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
  if (linuxFlags & L_O_DIRECTORY && fs.constants.O_DIRECTORY)
    native |= fs.constants.O_DIRECTORY;
  if (linuxFlags & L_O_NOFOLLOW && fs.constants.O_NOFOLLOW)
    native |= fs.constants.O_NOFOLLOW;
  if (linuxFlags & L_O_NOCTTY && fs.constants.O_NOCTTY)
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
  private guestMountPoint: string;
  private fdPositions = new Map<number, number>();
  private dirHandles = new Map<number, fs.Dir>();
  private nextDirHandle = 1;
  private metadata: NativeMetadataOverlay;

  constructor(
    rootPath: string,
    guestMountPoint = "/",
    options: { uid?: number; gid?: number } = {},
  ) {
    const resolvedRoot = nodePath.resolve(rootPath);
    this.rootPath = fs.existsSync(resolvedRoot)
      ? fs.realpathSync(resolvedRoot)
      : resolvedRoot;
    this.guestMountPoint = this.normalizeGuestMountPoint(guestMountPoint);
    this.metadata = new NativeMetadataOverlay(
      options.uid ?? 0,
      options.gid ?? 0,
    );
  }

  /**
   * Resolve a mount-relative guest path to an absolute host path, ensuring it
   * stays within `rootPath`.
   *
   * This intentionally resolves components one at a time instead of using
   * `path.resolve()`. POSIX pathname resolution must look up an intermediate
   * component before a following `..` can step back out of it:
   * `existing/missing/../file` fails with ENOENT because `missing` is looked
   * up as a directory first. Lexical normalization would incorrectly collapse
   * that to `existing/file`.
   *
   * Resolved prefixes are deliberately not cached. A host-backed tree can be
   * changed externally or through another mount of the same directory; using
   * a stale prefix after a directory-to-symlink replacement would bypass the
   * component checks below.
   *
   * Native symlink targets are stored as guest strings. When following a
   * symlink whose target is absolute and still inside this mount, translate it
   * back to a mount-relative path before continuing. This preserves readlink(2)
   * output while allowing stat/open/chmod to follow absolute in-guest links.
   */
  private safePath(relative: string, followFinal = true): string {
    const hadTrailingSlash = relative.length > 1 && /\/+$/.test(relative);
    let current = this.rootPath;
    let pending = this.pathParts(relative);
    let symlinkDepth = 0;

    while (pending.length > 0) {
      const part = pending.shift()!;
      if (part === ".") continue;
      if (part === "..") {
        if (current === this.rootPath) {
          throw new Error("EACCES: path traversal blocked");
        }
        current = nodePath.dirname(current);
        continue;
      }

      const candidate = nodePath.join(current, part);
      const isFinal = pending.length === 0;
      const shouldFollow = !isFinal || followFinal;

      let lst: fs.Stats | null = null;
      try {
        lst = fs.lstatSync(candidate);
      } catch (err: any) {
        if (isFinal && err?.code === "ENOENT") {
          current = candidate;
          break;
        }
        throw err;
      }

      if (shouldFollow && lst.isSymbolicLink()) {
        if (++symlinkDepth > 40)
          throw new Error("ELOOP: too many symbolic links");
        const target = fs.readlinkSync(candidate, "utf8");
        if (target.startsWith("/")) {
          const mountRelative = this.guestAbsoluteToMountRelative(target);
          if (mountRelative === null) {
            throw new Error("EACCES: absolute symlink target escapes mount");
          }
          current = this.rootPath;
          pending = [...this.pathParts(mountRelative), ...pending];
        } else {
          pending = [...this.pathParts(target), ...pending];
        }
        continue;
      }

      if (!isFinal && !lst.isDirectory()) {
        throw new Error("ENOTDIR: not a directory");
      }

      if (!isFinal) {
        current = fs.realpathSync(candidate);
        this.assertWithinRoot(current);
      } else {
        current = candidate;
      }
    }

    if (
      hadTrailingSlash &&
      current !== this.rootPath &&
      !current.endsWith(nodePath.sep)
    ) {
      // Keep a final separator for native fs calls. POSIX requires a
      // trailing slash to resolve the preceding component as a directory; the
      // native call then returns ENOTDIR for regular files while still
      // permitting operations such as mkdir("new-dir/").
      current += nodePath.sep;
    }
    this.assertWithinRoot(current);
    return current;
  }

  private normalizeGuestMountPoint(mountPoint: string): string {
    if (!mountPoint.startsWith("/")) mountPoint = `/${mountPoint}`;
    return mountPoint !== "/" && mountPoint.endsWith("/")
      ? mountPoint.slice(0, -1)
      : mountPoint;
  }

  private pathParts(path: string): string[] {
    return path
      .replace(/^\/+/, "")
      .split("/")
      .filter((part) => part.length > 0 && part !== ".");
  }

  private guestAbsoluteToMountRelative(path: string): string | null {
    if (this.guestMountPoint === "/") return path;
    if (path === this.guestMountPoint) return "/";
    if (path.startsWith(`${this.guestMountPoint}/`)) {
      return path.slice(this.guestMountPoint.length) || "/";
    }
    return null;
  }

  private assertWithinRoot(path: string): void {
    const rel = nodePath.relative(this.rootPath, path);
    if (rel === "") return;
    if (
      rel === ".." ||
      rel.startsWith(`..${nodePath.sep}`) ||
      nodePath.isAbsolute(rel)
    ) {
      throw new Error("EACCES: path traversal blocked");
    }
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
    const noFollowFinal =
      (flags & 0o400000) !== 0 ||
      ((flags & 0o100) !== 0 && (flags & 0o200) !== 0);
    const nativePath = this.safePath(path, !noFollowFinal);
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
    if (bytesWritten > 0)
      this.metadata.noteNativeContentChange(fs.fstatSync(handle));
    if (offset === null) {
      this.fdPositions.set(handle, pos + bytesWritten);
    }
    return bytesWritten;
  }

  seek(handle: number, offset: number, whence: number): number {
    let newPos: number;
    switch (whence) {
      case 0: // SEEK_SET
        newPos = checkedSeekPosition(0, offset);
        break;
      case 1: // SEEK_CUR
        newPos = checkedSeekPosition(this.fdPositions.get(handle) ?? 0, offset);
        break;
      case 2: // SEEK_END
        newPos = checkedSeekPosition(fs.fstatSync(handle).size, offset);
        break;
      default:
        throw makeHostFsError("EINVAL", `invalid whence value: ${whence}`);
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
    return this.toStatResult(fs.lstatSync(this.safePath(path, false)));
  }

  statfs(path: string): StatfsResult {
    return nativeStatfs(this.safePath(path));
  }

  mkdir(path: string, mode: number): void {
    const nativePath = this.safePath(path, false);
    fs.mkdirSync(nativePath, { mode });
    this.metadata.chmod(fs.statSync(nativePath), mode);
  }

  rmdir(path: string): void {
    const nativePath = this.safePath(path, false);
    const stat = fs.lstatSync(nativePath);
    fs.rmdirSync(nativePath);
    this.metadata.forget(stat);
  }

  unlink(path: string): void {
    const nativePath = this.safePath(path, false);
    const stat = fs.lstatSync(nativePath);
    fs.unlinkSync(nativePath);
    if (stat.nlink <= 1) this.metadata.forget(stat);
  }

  rename(oldPath: string, newPath: string): void {
    const nativeNewPath = this.safePath(newPath, false);
    let replaced: fs.Stats | undefined;
    try {
      replaced = fs.lstatSync(nativeNewPath);
    } catch {}
    fs.renameSync(this.safePath(oldPath, false), nativeNewPath);
    if (replaced !== undefined && replaced.nlink <= 1)
      this.metadata.forget(replaced);
  }

  link(existingPath: string, newPath: string): void {
    // Resolve intermediate components ourselves, but leave the final source
    // component to native link(2). POSIX permits link() either to follow a
    // final symlink or to link the symlink inode; native hosts differ here.
    fs.linkSync(
      this.safePath(existingPath, false),
      this.safePath(newPath, false),
    );
  }

  symlink(target: string, path: string): void {
    fs.symlinkSync(target, this.safePath(path, false));
  }

  readlink(path: string): string {
    return fs.readlinkSync(this.safePath(path, false), "utf8");
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

  utimensat(
    path: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    const nativePath = this.safePath(path);
    if (atimeNsec === UTIME_OMIT && mtimeNsec === UTIME_OMIT) return;

    const stat = fs.statSync(nativePath);
    const current = this.metadata.toStatResult(stat);
    const nowMs = Date.now();
    const atimeMs =
      atimeNsec === UTIME_OMIT
        ? current.atimeMs
        : atimeNsec === UTIME_NOW
          ? nowMs
          : atimeSec * 1000 + Math.floor(atimeNsec / 1_000_000);
    const mtimeMs =
      mtimeNsec === UTIME_OMIT
        ? current.mtimeMs
        : mtimeNsec === UTIME_NOW
          ? nowMs
          : mtimeSec * 1000 + Math.floor(mtimeNsec / 1_000_000);
    fs.utimesSync(nativePath, atimeMs / 1000, mtimeMs / 1000);
    this.metadata.utimens(stat, atimeMs, mtimeMs, fs.statSync(nativePath));
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
    if (entry.isFile())
      dtype = 8; // DT_REG
    else if (entry.isDirectory())
      dtype = 4; // DT_DIR
    else if (entry.isSymbolicLink())
      dtype = 10; // DT_LNK
    else if (entry.isFIFO())
      dtype = 1; // DT_FIFO
    else if (entry.isSocket())
      dtype = 12; // DT_SOCK
    else if (entry.isCharacterDevice())
      dtype = 2; // DT_CHR
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
