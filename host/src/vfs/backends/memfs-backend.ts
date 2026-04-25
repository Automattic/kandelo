// MemFsBackend — wraps a MemoryFileSystem with an optional "prefix within
// the MFS". Lets one MemoryFileSystem (e.g., the whole rootfs image) back
// multiple mount points by exposing different subtrees.
//
// Example: the rootfs image contains /etc/passwd, /etc/group, /root/.bashrc.
// Creating two MemFsBackends against that image:
//   new MemFsBackend(mfs, "/etc")   // mounted at VFS /etc
//   new MemFsBackend(mfs, "/root")  // mounted at VFS /root
// The /etc backend sees sub-path /passwd and translates to MFS path
// /etc/passwd; the /root backend sees sub-path /.bashrc and translates
// to /root/.bashrc.
//
// The prefix is "" for a backend rooted at the MFS's own /.

import type { Backend } from "./backend-interface.ts";
import type { StatResult } from "../../types";
import type { MemoryFileSystem } from "../memory-fs";

export class MemFsBackend implements Backend {
  /**
   * @param mfs     The underlying MemoryFileSystem.
   * @param prefix  Path within the MFS that corresponds to this backend's root.
   *                "" or "/" means the backend sees the MFS's full namespace.
   *                "/etc" means sub-path "/passwd" maps to MFS path "/etc/passwd".
   */
  constructor(
    private readonly mfs: MemoryFileSystem,
    prefix: string = "",
  ) {
    this.prefix = normalizePrefix(prefix);
  }

  private readonly prefix: string;

  private toMfs(subPath: string): string {
    // subPath is always absolute starting with "/". prefix is either
    // "" or a path like "/etc" with no trailing slash.
    if (subPath === "/") {
      return this.prefix || "/";
    }
    return this.prefix + subPath;
  }

  // ── Handle-based (MFS handles pass through unchanged) ──

  open(subPath: string, flags: number, mode: number): number {
    return this.mfs.open(this.toMfs(subPath), flags, mode);
  }
  close(handle: number): number { return this.mfs.close(handle); }
  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    return this.mfs.read(handle, buffer, offset, length);
  }
  write(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    return this.mfs.write(handle, buffer, offset, length);
  }
  seek(handle: number, offset: number, whence: number): number {
    return this.mfs.seek(handle, offset, whence);
  }
  fstat(handle: number): StatResult { return this.mfs.fstat(handle); }
  ftruncate(handle: number, length: number): void { this.mfs.ftruncate(handle, length); }
  fsync(handle: number): void { this.mfs.fsync(handle); }
  fchmod(handle: number, mode: number): void { this.mfs.fchmod(handle, mode); }
  fchown(handle: number, uid: number, gid: number): void { this.mfs.fchown(handle, uid, gid); }

  // ── Path-based ──

  stat(subPath: string): StatResult { return this.mfs.stat(this.toMfs(subPath)); }
  lstat(subPath: string): StatResult { return this.mfs.lstat(this.toMfs(subPath)); }
  mkdir(subPath: string, mode: number): void { this.mfs.mkdir(this.toMfs(subPath), mode); }
  rmdir(subPath: string): void { this.mfs.rmdir(this.toMfs(subPath)); }
  unlink(subPath: string): void { this.mfs.unlink(this.toMfs(subPath)); }
  rename(oldSubPath: string, newSubPath: string): void {
    this.mfs.rename(this.toMfs(oldSubPath), this.toMfs(newSubPath));
  }
  link(existingSubPath: string, newSubPath: string): void {
    this.mfs.link(this.toMfs(existingSubPath), this.toMfs(newSubPath));
  }
  symlink(target: string, subPath: string): void {
    // Symlink target is stored verbatim — the kernel resolves it against
    // the VFS root, not this backend's prefix. An image-declared symlink
    // like /etc/localtime → /usr/share/zoneinfo/UTC means exactly that
    // in the VFS, regardless of where /etc is mounted.
    this.mfs.symlink(target, this.toMfs(subPath));
  }
  readlink(subPath: string): string { return this.mfs.readlink(this.toMfs(subPath)); }
  chmod(subPath: string, mode: number): void { this.mfs.chmod(this.toMfs(subPath), mode); }
  chown(subPath: string, uid: number, gid: number): void { this.mfs.chown(this.toMfs(subPath), uid, gid); }
  access(subPath: string, mode: number): void { this.mfs.access(this.toMfs(subPath), mode); }
  utimensat(subPath: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    this.mfs.utimensat(this.toMfs(subPath), atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  // ── Directory iteration ──

  opendir(subPath: string): number { return this.mfs.opendir(this.toMfs(subPath)); }
  readdir(handle: number): { name: string; type: number; ino: number } | null {
    return this.mfs.readdir(handle);
  }
  closedir(handle: number): void { this.mfs.closedir(handle); }
}

function normalizePrefix(prefix: string): string {
  if (prefix === "" || prefix === "/") return "";
  if (!prefix.startsWith("/")) {
    throw new Error(`MemFsBackend prefix must be absolute: ${prefix}`);
  }
  // Strip trailing slash
  return prefix.replace(/\/+$/, "");
}
