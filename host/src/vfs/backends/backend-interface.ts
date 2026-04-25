// Backend interface — the subset of PlatformIO that filesystem backends
// must implement. Non-FS operations (clockGettime, network, waitpid, etc.)
// are the HostServices' concern and don't appear here.
//
// Backends receive **sub-mount paths**: the MountRouter strips the mount
// prefix before calling. A file at VFS `/etc/passwd` under a mount at
// `/etc` arrives at the backend as `/passwd`. Backends don't know their
// mount point — the router owns path translation.

import type { StatResult } from "../../types";

export interface Backend {
  // ── Handle-based ops ──
  open(subPath: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number;
  write(handle: number, buffer: Uint8Array, offset: number | null, length: number): number;
  seek(handle: number, offset: number, whence: number): number;
  fstat(handle: number): StatResult;
  ftruncate(handle: number, length: number): void;
  fsync(handle: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;

  // ── Path-based ops (paths are already stripped of the mount prefix) ──
  stat(subPath: string): StatResult;
  lstat(subPath: string): StatResult;
  mkdir(subPath: string, mode: number): void;
  rmdir(subPath: string): void;
  unlink(subPath: string): void;
  rename(oldSubPath: string, newSubPath: string): void;
  link(existingSubPath: string, newSubPath: string): void;
  symlink(target: string, subPath: string): void;
  readlink(subPath: string): string;
  chmod(subPath: string, mode: number): void;
  chown(subPath: string, uid: number, gid: number): void;
  access(subPath: string, mode: number): void;
  utimensat(
    subPath: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void;

  // ── Directory iteration ──
  opendir(subPath: string): number;
  readdir(handle: number): { name: string; type: number; ino: number } | null;
  closedir(handle: number): void;
}
