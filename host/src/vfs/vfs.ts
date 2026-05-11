import type { NetworkIO, PlatformIO, StatResult } from "../types";
import type { FileSystemBackend, MountConfig, TimeProvider } from "./types";

interface MountEntry {
  prefix: string;
  backend: FileSystemBackend;
  readonly: boolean;
}

interface HandleInfo {
  backend: FileSystemBackend;
  localHandle: number;
  /** Only meaningful for file handles. Dir handles always set this to false. */
  readonly: boolean;
}

// Linux musl open-flag bits (kernel passes these through `host_open`).
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const O_WRITE_MASK = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC;

function normalizeMountPoint(mp: string): string {
  // Remove trailing slash unless it's the root
  if (mp !== "/" && mp.endsWith("/")) {
    return mp.slice(0, -1);
  }
  return mp;
}

export class VirtualPlatformIO implements PlatformIO {
  private mounts: MountEntry[];
  private time: TimeProvider;
  private fileHandles = new Map<number, HandleInfo>();
  private dirHandles = new Map<number, HandleInfo>();
  private nextFileHandle = 100;
  private nextDirHandle = 1;
  network?: NetworkIO;

  constructor(mounts: MountConfig[], time: TimeProvider) {
    this.mounts = mounts
      .map((m) => ({
        prefix: normalizeMountPoint(m.mountPoint),
        backend: m.backend,
        readonly: m.readonly === true,
      }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    this.time = time;
    if (this.mounts.length === 0) {
      throw new Error("VirtualPlatformIO requires at least one mount");
    }
  }

  private resolve(path: string): {
    backend: FileSystemBackend;
    relativePath: string;
    readonly: boolean;
  } {
    for (const m of this.mounts) {
      if (m.prefix === "/") {
        return { backend: m.backend, relativePath: path, readonly: m.readonly };
      }
      if (path === m.prefix || path.startsWith(m.prefix + "/")) {
        let rel = path.slice(m.prefix.length);
        if (!rel.startsWith("/")) rel = "/" + rel;
        return { backend: m.backend, relativePath: rel, readonly: m.readonly };
      }
    }
    throw new Error(`ENOENT: no mount for path: ${path}`);
  }

  private static erofs(op: string, path: string): never {
    throw new Error(`EROFS: read-only mount (${op} ${path})`);
  }

  private getFileHandle(handle: number): HandleInfo {
    const info = this.fileHandles.get(handle);
    if (!info) throw new Error(`EBADF: invalid file handle ${handle}`);
    return info;
  }

  private getDirHandle(handle: number): HandleInfo {
    const info = this.dirHandles.get(handle);
    if (!info) throw new Error(`EBADF: invalid dir handle ${handle}`);
    return info;
  }

  // --- File handle operations ---

  open(path: string, flags: number, mode: number): number {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly && (flags & O_WRITE_MASK) !== 0) {
      VirtualPlatformIO.erofs("open(write)", path);
    }
    const localHandle = backend.open(relativePath, flags, mode);
    const globalHandle = this.nextFileHandle++;
    this.fileHandles.set(globalHandle, { backend, localHandle, readonly });
    return globalHandle;
  }

  close(handle: number): number {
    const info = this.getFileHandle(handle);
    const result = info.backend.close(info.localHandle);
    this.fileHandles.delete(handle);
    return result;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    const info = this.getFileHandle(handle);
    return info.backend.read(info.localHandle, buffer, offset, length);
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    const info = this.getFileHandle(handle);
    if (info.readonly) {
      throw new Error(`EROFS: read-only mount (write fd=${handle})`);
    }
    return info.backend.write(info.localHandle, buffer, offset, length);
  }

  seek(handle: number, offset: number, whence: number): number {
    const info = this.getFileHandle(handle);
    return info.backend.seek(info.localHandle, offset, whence);
  }

  fstat(handle: number): StatResult {
    const info = this.getFileHandle(handle);
    return info.backend.fstat(info.localHandle);
  }

  ftruncate(handle: number, length: number): void {
    const info = this.getFileHandle(handle);
    if (info.readonly) {
      throw new Error(`EROFS: read-only mount (ftruncate fd=${handle})`);
    }
    info.backend.ftruncate(info.localHandle, length);
  }

  fsync(handle: number): void {
    const info = this.getFileHandle(handle);
    info.backend.fsync(info.localHandle);
  }

  fchmod(handle: number, mode: number): void {
    const info = this.getFileHandle(handle);
    if (info.readonly) {
      throw new Error(`EROFS: read-only mount (fchmod fd=${handle})`);
    }
    info.backend.fchmod(info.localHandle, mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    const info = this.getFileHandle(handle);
    if (info.readonly) {
      throw new Error(`EROFS: read-only mount (fchown fd=${handle})`);
    }
    info.backend.fchown(info.localHandle, uid, gid);
  }

  // --- Path-based operations ---

  stat(path: string): StatResult {
    const { backend, relativePath } = this.resolve(path);
    return backend.stat(relativePath);
  }

  lstat(path: string): StatResult {
    const { backend, relativePath } = this.resolve(path);
    return backend.lstat(relativePath);
  }

  mkdir(path: string, mode: number): void {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly) VirtualPlatformIO.erofs("mkdir", path);
    backend.mkdir(relativePath, mode);
  }

  rmdir(path: string): void {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly) VirtualPlatformIO.erofs("rmdir", path);
    backend.rmdir(relativePath);
  }

  unlink(path: string): void {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly) VirtualPlatformIO.erofs("unlink", path);
    backend.unlink(relativePath);
  }

  // EROFS fires before EXDEV: if either side is on a read-only mount we
  // reject with EROFS regardless of whether the rename would cross devices.
  rename(oldPath: string, newPath: string): void {
    const r1 = this.resolve(oldPath);
    const r2 = this.resolve(newPath);
    if (r1.readonly) VirtualPlatformIO.erofs("rename(src)", oldPath);
    if (r2.readonly) VirtualPlatformIO.erofs("rename(dst)", newPath);
    if (r1.backend !== r2.backend) {
      throw new Error("EXDEV: cross-device link");
    }
    r1.backend.rename(r1.relativePath, r2.relativePath);
  }

  link(existingPath: string, newPath: string): void {
    const r1 = this.resolve(existingPath);
    const r2 = this.resolve(newPath);
    if (r2.readonly) VirtualPlatformIO.erofs("link(dst)", newPath);
    if (r1.backend !== r2.backend) {
      throw new Error("EXDEV: cross-device link");
    }
    r1.backend.link(r1.relativePath, r2.relativePath);
  }

  symlink(target: string, path: string): void {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly) VirtualPlatformIO.erofs("symlink", path);
    backend.symlink(target, relativePath);
  }

  readlink(path: string): string {
    const { backend, relativePath } = this.resolve(path);
    return backend.readlink(relativePath);
  }

  chmod(path: string, mode: number): void {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly) VirtualPlatformIO.erofs("chmod", path);
    backend.chmod(relativePath, mode);
  }

  chown(path: string, uid: number, gid: number): void {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly) VirtualPlatformIO.erofs("chown", path);
    backend.chown(relativePath, uid, gid);
  }

  access(path: string, mode: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.access(relativePath, mode);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const { backend, relativePath, readonly } = this.resolve(path);
    if (readonly) VirtualPlatformIO.erofs("utimensat", path);
    backend.utimensat(relativePath, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  // --- Directory operations ---

  opendir(path: string): number {
    const { backend, relativePath } = this.resolve(path);
    const localHandle = backend.opendir(relativePath);
    const globalHandle = this.nextDirHandle++;
    this.dirHandles.set(globalHandle, { backend, localHandle, readonly: false });
    return globalHandle;
  }

  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null {
    const info = this.getDirHandle(handle);
    return info.backend.readdir(info.localHandle);
  }

  closedir(handle: number): void {
    const info = this.getDirHandle(handle);
    info.backend.closedir(info.localHandle);
    this.dirHandles.delete(handle);
  }

  // --- Time operations ---

  clockGettime(clockId: number): { sec: number; nsec: number } {
    return this.time.clockGettime(clockId);
  }

  nanosleep(sec: number, nsec: number): void {
    this.time.nanosleep(sec, nsec);
  }
}
