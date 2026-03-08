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
  open(path: string, flags: number, mode: number): Promise<number>;
  close(handle: number): Promise<number>;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<number>;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<number>;
  seek(handle: number, offset: number, whence: number): Promise<number>;
  fstat(handle: number): Promise<StatResult>;

  // Path-based operations
  stat(path: string): Promise<StatResult>;
  lstat(path: string): Promise<StatResult>;
  mkdir(path: string, mode: number): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  access(path: string, mode: number): Promise<void>;

  // Directory iteration
  opendir(path: string): Promise<number>;
  readdir(
    handle: number,
  ): Promise<{ name: string; type: number; ino: number } | null>;
  closedir(handle: number): Promise<void>;

  // File operations
  ftruncate(handle: number, length: number): Promise<void>;
  fsync(handle: number): Promise<void>;
  fchmod(handle: number, mode: number): Promise<void>;
  fchown(handle: number, uid: number, gid: number): Promise<void>;

  // Time
  clockGettime(clockId: number): Promise<{ sec: number; nsec: number }>;
  nanosleep(sec: number, nsec: number): Promise<void>;
}
