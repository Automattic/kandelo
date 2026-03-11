export interface KernelConfig {
  maxWorkers: number;
  dataBufferSize: number;
  useSharedMemory: boolean;
}

export interface StatResult {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface PlatformIO {
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
  seek(handle: number, offset: number, whence: number): number;
  fstat(handle: number): StatResult;

  // Path-based operations
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  mkdir(path: string, mode: number): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rename(oldPath: string, newPath: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  access(path: string, mode: number): void;

  // Directory iteration
  opendir(path: string): number;
  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null;
  closedir(handle: number): void;

  // File operations
  ftruncate(handle: number, length: number): void;
  fsync(handle: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;

  // Time
  clockGettime(clockId: number): { sec: number; nsec: number };
  nanosleep(sec: number, nsec: number): void;
}
