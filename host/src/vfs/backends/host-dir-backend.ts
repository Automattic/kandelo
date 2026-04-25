// HostDirBackend — backs a VFS mount with a real host directory. Every
// backend op rewrites the sub-path against the backend's hostRoot before
// touching Node fs. The backend never exposes host paths to callers, and
// rejects sub-paths that attempt to escape the mount via ".." traversal
// (defense in depth — the kernel's path resolver normalizes paths before
// calling in, so this should never fire in practice, but the cost is a
// single check per op).
//
// uid/gid: always reported as 1000/1000 on stat/lstat/fstat regardless of
// the real macOS owner. This matches Process::new's default euid
// (crates/kernel/src/process.rs) so programs running inside the kernel
// see host-backed files as self-owned. The real host uid is never
// exposed to user code.

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { Backend } from "./backend-interface.ts";
import type { StatResult } from "../../types";
import { translateOpenFlags } from "../host-fs";

/** uid/gid returned by all HostDirBackend stat calls. Matches `Process::new`'s euid. */
export const HOST_DIR_DEFAULT_UID = 1000;
export const HOST_DIR_DEFAULT_GID = 1000;

export class HostDirBackend implements Backend {
  private readonly hostRoot: string;
  private readonly dirHandles = new Map<number, fs.Dir>();
  private readonly fdPositions = new Map<number, number>();
  private nextDirHandle = 1;

  constructor(hostRoot: string, options?: { createIfMissing?: boolean }) {
    this.hostRoot = hostRoot.replace(/\/+$/, "");
    if (this.hostRoot === "") {
      throw new Error("HostDirBackend: hostRoot cannot be empty");
    }
    if (options?.createIfMissing) {
      fs.mkdirSync(this.hostRoot, { recursive: true });
    }
  }

  private toHost(subPath: string): string {
    // Defense in depth: the kernel normalizes paths, but a malicious or
    // buggy caller could still hand us ".." segments. Reject them.
    if (subPath.includes("/../") || subPath.endsWith("/..") || subPath === "..") {
      const err: NodeJS.ErrnoException = new Error(
        `EACCES: path traversal rejected: ${subPath}`,
      );
      err.code = "EACCES";
      throw err;
    }
    // subPath is absolute ("/foo/bar") starting with a slash, or "/" for the root.
    return subPath === "/" ? this.hostRoot : this.hostRoot + subPath;
  }

  // ── Handle-based ──

  open(subPath: string, flags: number, mode: number): number {
    const handle = fs.openSync(this.toHost(subPath), translateOpenFlags(flags), mode);
    this.fdPositions.set(handle, 0);
    return handle;
  }

  close(handle: number): number {
    fs.closeSync(handle);
    this.fdPositions.delete(handle);
    return 0;
  }

  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    const pos = offset ?? this.fdPositions.get(handle) ?? 0;
    const n = fs.readSync(handle, buffer, 0, length, pos);
    if (offset === null) this.fdPositions.set(handle, pos + n);
    return n;
  }

  write(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    const pos = offset ?? this.fdPositions.get(handle) ?? 0;
    const n = fs.writeSync(handle, buffer, 0, length, pos);
    if (offset === null) this.fdPositions.set(handle, pos + n);
    return n;
  }

  seek(handle: number, offset: number, whence: number): number {
    let newPos: number;
    switch (whence) {
      case 0: newPos = offset; break;
      case 1: newPos = (this.fdPositions.get(handle) ?? 0) + offset; break;
      case 2: newPos = fs.fstatSync(handle).size + offset; break;
      default: throw new Error(`invalid whence ${whence}`);
    }
    this.fdPositions.set(handle, newPos);
    return newPos;
  }

  fstat(handle: number): StatResult {
    const s = fs.fstatSync(handle);
    return this.adaptStat(s);
  }

  ftruncate(handle: number, length: number): void { fs.ftruncateSync(handle, length); }
  fsync(handle: number): void { fs.fsyncSync(handle); }
  fchmod(handle: number, mode: number): void { fs.fchmodSync(handle, mode); }
  fchown(_handle: number, _uid: number, _gid: number): void {
    // No-op: host-backed files always report uid=gid=1000; chown on a
    // host file would change the real macOS owner (requires privilege
    // and leaks host identity). Silently succeed so programs that chown
    // their own files don't fail.
  }

  // ── Path-based ──

  stat(subPath: string): StatResult {
    return this.adaptStat(fs.statSync(this.toHost(subPath)));
  }
  lstat(subPath: string): StatResult {
    return this.adaptStat(fs.lstatSync(this.toHost(subPath)));
  }
  mkdir(subPath: string, mode: number): void {
    fs.mkdirSync(this.toHost(subPath), { mode });
  }
  rmdir(subPath: string): void { fs.rmdirSync(this.toHost(subPath)); }
  unlink(subPath: string): void { fs.unlinkSync(this.toHost(subPath)); }
  rename(oldSubPath: string, newSubPath: string): void {
    fs.renameSync(this.toHost(oldSubPath), this.toHost(newSubPath));
  }
  link(existingSubPath: string, newSubPath: string): void {
    fs.linkSync(this.toHost(existingSubPath), this.toHost(newSubPath));
  }
  symlink(target: string, subPath: string): void {
    // Target is stored verbatim; the kernel's path resolver interprets
    // absolute targets against the VFS root. Relative targets resolve
    // against the symlink's parent directory in the VFS.
    fs.symlinkSync(target, this.toHost(subPath));
  }
  readlink(subPath: string): string {
    return fs.readlinkSync(this.toHost(subPath), "utf8");
  }
  chmod(subPath: string, mode: number): void { fs.chmodSync(this.toHost(subPath), mode); }
  chown(_subPath: string, _uid: number, _gid: number): void {
    // Same rationale as fchown: no-op to keep host identity hidden.
  }
  access(subPath: string, mode: number): void {
    fs.accessSync(this.toHost(subPath), mode);
  }
  utimensat(subPath: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const atime = atimeSec + atimeNsec / 1e9;
    const mtime = mtimeSec + mtimeNsec / 1e9;
    fs.utimesSync(this.toHost(subPath), atime, mtime);
  }

  // ── Directory iteration ──

  opendir(subPath: string): number {
    const dir = fs.opendirSync(this.toHost(subPath));
    const h = this.nextDirHandle++;
    this.dirHandles.set(h, dir);
    return h;
  }
  readdir(handle: number): { name: string; type: number; ino: number } | null {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("invalid dir handle");
    const entry = dir.readSync();
    if (!entry) return null;
    let dtype = 0;
    if (entry.isFile()) dtype = 8;
    else if (entry.isDirectory()) dtype = 4;
    else if (entry.isSymbolicLink()) dtype = 10;
    else if (entry.isFIFO()) dtype = 1;
    else if (entry.isSocket()) dtype = 12;
    else if (entry.isCharacterDevice()) dtype = 2;
    else if (entry.isBlockDevice()) dtype = 6;
    return { name: entry.name, type: dtype, ino: 0 };
  }
  closedir(handle: number): void {
    const dir = this.dirHandles.get(handle);
    if (!dir) throw new Error("invalid dir handle");
    dir.closeSync();
    this.dirHandles.delete(handle);
  }

  // ── Internals ──

  private adaptStat(s: fs.Stats): StatResult {
    return {
      dev: s.dev,
      ino: s.ino,
      mode: s.mode,
      nlink: s.nlink,
      uid: HOST_DIR_DEFAULT_UID,
      gid: HOST_DIR_DEFAULT_GID,
      size: s.size,
      atimeMs: s.atimeMs,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
    };
  }

  /** Host-side path for a VFS sub-path, for tests that need to stage files on disk. */
  hostPathFor(subPath: string): string {
    return this.toHost(subPath);
  }
}

// Ensure the parent dir of a sub-path exists on the host. Useful when
// staging files before the kernel starts.
export function mkdirsForHostDir(backend: HostDirBackend, subPath: string): void {
  const hostPath = backend.hostPathFor(subPath);
  fs.mkdirSync(dirname(hostPath), { recursive: true });
}

export { join as _join };
