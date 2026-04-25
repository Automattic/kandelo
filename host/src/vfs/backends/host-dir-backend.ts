// HostDirBackend — backs a VFS mount with a real host directory for
// content storage, but owns its own view of permissions and ownership
// via a shadow metadata store. The host FS is just bytes; the VFS owns
// mode/uid/gid.
//
// Why a shadow store? The host's real uid/gid is the macOS user running
// node, not whoever the kernel thinks it's running as. Exposing that
// breaks programs that compare stat.uid against geteuid() (git's
// "dubious ownership", etc.). Propagating chown to the host would
// require privilege we don't have and would leak host identity in the
// other direction. The shadow store gives us a third option: the VFS
// tracks its own metadata, and chown/chmod change what the kernel sees
// without touching the host.
//
// Fields deferred to the host:
//   - file content (read/write)
//   - size, nlink, atimeMs, mtimeMs, ctimeMs, dev, ino (genuine FS state)
//   - type bits of mode (regular/dir/symlink — derived from the inode)
//
// Fields owned by the shadow store:
//   - permission bits of mode (0o7777)
//   - uid, gid
//
// Metadata lifetime follows the underlying file: unlink/rmdir clears the
// entry, rename moves it. Defaults (for files the VFS sees for the first
// time, e.g. staged via hostPathFor) are uid=1000, gid=1000, permission
// bits from the host's mode. This keeps the "in-kernel user owns its own
// files" illusion for un-chowned files while letting explicit chown take
// effect.

import * as fs from "node:fs";
import { dirname } from "node:path";
import type { Backend } from "./backend-interface.ts";
import type { StatResult } from "../../types";
import { translateOpenFlags } from "../host-fs";

/** Default uid for newly-observed host-backed files. Matches `Process::new`'s euid. */
export const HOST_DIR_DEFAULT_UID = 1000;
export const HOST_DIR_DEFAULT_GID = 1000;

interface ShadowMeta {
  uid: number;
  gid: number;
  /** Permission bits only (mode & 0o7777); type bits come from the host inode. */
  permBits: number;
}

export class HostDirBackend implements Backend {
  private readonly hostRoot: string;
  private readonly dirHandles = new Map<number, fs.Dir>();
  private readonly fdPositions = new Map<number, number>();
  /** fd → sub-path, so fstat/fchmod/fchown can consult the shadow store. */
  private readonly fdSubPaths = new Map<number, string>();
  /** Shadow metadata: sub-path → uid/gid/permBits. */
  private readonly shadow = new Map<string, ShadowMeta>();
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
    // Defense in depth: the kernel normalizes paths, but reject .. here too.
    if (subPath.includes("/../") || subPath.endsWith("/..") || subPath === "..") {
      const err: NodeJS.ErrnoException = new Error(
        `EACCES: path traversal rejected: ${subPath}`,
      );
      err.code = "EACCES";
      throw err;
    }
    return subPath === "/" ? this.hostRoot : this.hostRoot + subPath;
  }

  /** Merge the host's real stat with the shadow store's uid/gid/permBits. */
  private adaptStat(s: fs.Stats, subPath: string): StatResult {
    const meta = this.shadow.get(subPath);
    const typeBits = s.mode & 0o170000;
    const permBits = meta?.permBits ?? (s.mode & 0o7777);
    return {
      dev: s.dev,
      ino: s.ino,
      mode: typeBits | permBits,
      nlink: s.nlink,
      uid: meta?.uid ?? HOST_DIR_DEFAULT_UID,
      gid: meta?.gid ?? HOST_DIR_DEFAULT_GID,
      size: s.size,
      atimeMs: s.atimeMs,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
    };
  }

  private setMeta(subPath: string, patch: Partial<ShadowMeta>): void {
    const existing = this.shadow.get(subPath);
    const uid = patch.uid ?? existing?.uid ?? HOST_DIR_DEFAULT_UID;
    const gid = patch.gid ?? existing?.gid ?? HOST_DIR_DEFAULT_GID;
    const permBits = patch.permBits ?? existing?.permBits;
    this.shadow.set(subPath, {
      uid,
      gid,
      permBits: permBits ?? this.currentHostPerm(subPath),
    });
  }

  private currentHostPerm(subPath: string): number {
    try {
      return fs.statSync(this.toHost(subPath)).mode & 0o7777;
    } catch {
      return 0o644;
    }
  }

  // ── Handle-based ──

  open(subPath: string, flags: number, mode: number): number {
    const handle = fs.openSync(this.toHost(subPath), translateOpenFlags(flags), mode);
    this.fdPositions.set(handle, 0);
    this.fdSubPaths.set(handle, subPath);
    // If this is a fresh O_CREAT, seed default metadata so subsequent
    // stat sees uid=1000/gid=1000 even before any explicit chown.
    const isCreate = (flags & 0x0040) !== 0; // O_CREAT
    if (isCreate && !this.shadow.has(subPath)) {
      this.shadow.set(subPath, {
        uid: HOST_DIR_DEFAULT_UID,
        gid: HOST_DIR_DEFAULT_GID,
        permBits: mode & 0o7777,
      });
    }
    return handle;
  }

  close(handle: number): number {
    fs.closeSync(handle);
    this.fdPositions.delete(handle);
    this.fdSubPaths.delete(handle);
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
    const subPath = this.fdSubPaths.get(handle) ?? "";
    return this.adaptStat(fs.fstatSync(handle), subPath);
  }

  ftruncate(handle: number, length: number): void { fs.ftruncateSync(handle, length); }
  fsync(handle: number): void { fs.fsyncSync(handle); }

  fchmod(handle: number, mode: number): void {
    const subPath = this.fdSubPaths.get(handle);
    if (subPath != null) this.setMeta(subPath, { permBits: mode & 0o7777 });
    // Intentionally not fs.fchmodSync — the VFS owns perm bits, the host
    // is just bytes. Changing the host's mode would expose VFS state to
    // external host tools inspecting the scratch dir, which we don't want.
  }

  fchown(handle: number, uid: number, gid: number): void {
    const subPath = this.fdSubPaths.get(handle);
    if (subPath != null) this.setMeta(subPath, { uid, gid });
  }

  // ── Path-based ──

  stat(subPath: string): StatResult {
    return this.adaptStat(fs.statSync(this.toHost(subPath)), subPath);
  }
  lstat(subPath: string): StatResult {
    return this.adaptStat(fs.lstatSync(this.toHost(subPath)), subPath);
  }
  mkdir(subPath: string, mode: number): void {
    fs.mkdirSync(this.toHost(subPath), { mode });
    this.shadow.set(subPath, {
      uid: HOST_DIR_DEFAULT_UID,
      gid: HOST_DIR_DEFAULT_GID,
      permBits: mode & 0o7777,
    });
  }
  rmdir(subPath: string): void {
    fs.rmdirSync(this.toHost(subPath));
    this.shadow.delete(subPath);
  }
  unlink(subPath: string): void {
    fs.unlinkSync(this.toHost(subPath));
    this.shadow.delete(subPath);
  }
  rename(oldSubPath: string, newSubPath: string): void {
    fs.renameSync(this.toHost(oldSubPath), this.toHost(newSubPath));
    const meta = this.shadow.get(oldSubPath);
    if (meta) {
      this.shadow.delete(oldSubPath);
      this.shadow.set(newSubPath, meta);
    }
  }
  link(existingSubPath: string, newSubPath: string): void {
    fs.linkSync(this.toHost(existingSubPath), this.toHost(newSubPath));
    // Hard link shares metadata with the source; mirror to new sub-path.
    const meta = this.shadow.get(existingSubPath);
    if (meta) this.shadow.set(newSubPath, { ...meta });
  }
  symlink(target: string, subPath: string): void {
    fs.symlinkSync(target, this.toHost(subPath));
    this.shadow.set(subPath, {
      uid: HOST_DIR_DEFAULT_UID,
      gid: HOST_DIR_DEFAULT_GID,
      permBits: 0o777, // POSIX convention for symlinks
    });
  }
  readlink(subPath: string): string {
    return fs.readlinkSync(this.toHost(subPath), "utf8");
  }
  chmod(subPath: string, mode: number): void {
    this.setMeta(subPath, { permBits: mode & 0o7777 });
  }
  chown(subPath: string, uid: number, gid: number): void {
    this.setMeta(subPath, { uid, gid });
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

  // ── Escape hatch for tests ──

  /** Host-side path for a VFS sub-path. Only for test harness staging. */
  hostPathFor(subPath: string): string {
    return this.toHost(subPath);
  }
}

export function mkdirsForHostDir(backend: HostDirBackend, subPath: string): void {
  const hostPath = backend.hostPathFor(subPath);
  fs.mkdirSync(dirname(hostPath), { recursive: true });
}
