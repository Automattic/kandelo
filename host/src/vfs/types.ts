import type { PathconfValue, StatResult, StatfsResult } from "../types";

export interface DirEntry {
  name: string;
  type: number;
  ino: number;
}

export interface FileSystemBackend {
  /** Materialize deferred path backing before synchronous file I/O. */
  preparePath?(path: string): Promise<boolean>;
  // File handle operations
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number;
  write(handle: number, buffer: Uint8Array, offset: number | null, length: number): number;
  seek(handle: number, offset: number, whence: number): number;
  fstat(handle: number): StatResult;
  fpathconf(handle: number, name: number): PathconfValue;
  ftruncate(handle: number, length: number): void;
  fsync(handle: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;

  // Path operations (paths are mount-relative, already resolved)
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  statfs(path: string): StatfsResult;
  pathconf(path: string, name: number): PathconfValue;
  mkdir(path: string, mode: number): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rename(oldPath: string, newPath: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  lchown(path: string, uid: number, gid: number): void;
  access(path: string, mode: number): void;
  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void;

  // Directory iteration
  opendir(path: string): number;
  readdir(handle: number): DirEntry | null;
  closedir(handle: number): void;
}

export interface TimeProvider {
  clockGettime(clockId: number): { sec: number; nsec: number };
  nanosleep(sec: number, nsec: number): void;
}

export interface MountConfig {
  mountPoint: string;
  backend: FileSystemBackend;
  readonly?: boolean;
}
