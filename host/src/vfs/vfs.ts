import type {
  AppendOutcome,
  HostFileOffset,
  NetworkIO,
  PathconfValue,
  PlatformIO,
  StatResult,
  StatfsResult,
} from "../types";
import {
  ST_NOSUID,
  type FileSystemBackend,
  type MountConfig,
  type TimeProvider,
} from "./types";
import { AT_FLAGS, FILE_MODES, OPEN_FLAGS } from "../generated/abi";

interface MountEntry {
  prefix: string;
  backend: FileSystemBackend;
  backendId: number;
  nosuid: boolean;
}

interface HandleInfo {
  backend: FileSystemBackend;
  backendId: number;
  localHandle: number;
  statfs?: StatfsResult;
}

/**
 * An open directory, as the handle-only kernel contract uses it.
 *
 * A directory handle is an *anchor*: the backend that owns it plus that
 * directory's mount-relative path. Every `*at` operation the kernel issues
 * names one component relative to such an anchor, so this host never routes a
 * mount prefix, resolves a symlink, or interprets a `..` — the kernel did all
 * of that before the call.
 *
 * `iterator` is the backend's own directory cursor, opened on first `readdir`.
 * A mount root is an anchor from boot and usually never iterated, so opening a
 * cursor for it eagerly would cost one per mount for nothing.
 */
interface DirHandleInfo {
  backend: FileSystemBackend;
  backendId: number;
  /** Mount-relative canonical path of this directory. */
  path: string;
  nosuid: boolean;
  statfs: StatfsResult;
  iterator: number | null;
}

/**
 * Append one path component to a mount-relative directory path.
 *
 * `name` is always exactly one component — the kernel guarantees it — and `"."`
 * names the directory itself, which is how the kernel addresses a mount root.
 */
function joinComponent(dirPath: string, name: string): string {
  if (name === "." || name === "") return dirPath;
  return dirPath === "/" ? "/" + name : dirPath + "/" + name;
}

const MAX_U64 = (1n << 64n) - 1n;

function exactUnsignedIdentity(value: number | bigint, field: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= MAX_U64) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  const error = new Error(
    `EOVERFLOW: ${field} is not exactly representable as an unsigned 64-bit value`,
  ) as Error & { code: string };
  error.code = "EOVERFLOW";
  throw error;
}

function normalizeMountPoint(mp: string): string {
  // Remove trailing slash unless it's the root
  if (mp !== "/" && mp.endsWith("/")) {
    return mp.slice(0, -1);
  }
  return mp;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

export class VirtualPlatformIO implements PlatformIO {
  private mounts: MountEntry[];
  private time: TimeProvider;
  private fileHandles = new Map<number, HandleInfo>();
  private dirHandles = new Map<number, DirHandleInfo>();
  /**
   * One counter for both tables. The kernel closes a directory with the same
   * `host_close` it uses for a file, so the two id spaces must be disjoint;
   * separate counters (files from 100, directories from 1) collided as soon as
   * a machine opened a hundred directories.
   */
  private nextHandle = 100;
  private readonly qualifiedDeviceIds = new Map<
    FileSystemBackend,
    Map<bigint, bigint>
  >();
  private nextQualifiedDeviceId = 1n;
  network?: NetworkIO;

  constructor(mounts: MountConfig[], time: TimeProvider) {
    // Scope inode numbers to the backend object that owns them. Assigning the
    // id per backend (rather than per mount point) keeps aliases intact when
    // one backend is deliberately exposed at more than one mount point.
    const backendIds = new Map<FileSystemBackend, number>();
    let nextBackendId = 1;
    this.mounts = mounts
      .map((m) => {
        let backendId = backendIds.get(m.backend);
        if (backendId === undefined) {
          backendId = nextBackendId++;
          backendIds.set(m.backend, backendId);
        }
        return {
          prefix: normalizeMountPoint(m.mountPoint),
          backend: m.backend,
          backendId,
          nosuid: m.nosuid === true,
        };
      })
      .sort((a, b) => b.prefix.length - a.prefix.length);
    this.time = time;
    if (this.mounts.length === 0) {
      throw new Error("VirtualPlatformIO requires at least one mount");
    }
  }

  /** Whether the mount owning an absolute guest path ignores set-ID bits. */
  getMountNosuid(path: string): boolean {
    return this.resolve(path).nosuid;
  }

  private resolve(path: string): {
    backend: FileSystemBackend;
    backendId: number;
    nosuid: boolean;
    relativePath: string;
  } {
    for (const m of this.mounts) {
      if (m.prefix === "/") {
        return {
          backend: m.backend,
          backendId: m.backendId,
          nosuid: m.nosuid,
          relativePath: path,
        };
      }
      if (path === m.prefix || path.startsWith(m.prefix + "/")) {
        let rel = path.slice(m.prefix.length);
        if (!rel.startsWith("/")) rel = "/" + rel;
        return {
          backend: m.backend,
          backendId: m.backendId,
          nosuid: m.nosuid,
          relativePath: rel,
        };
      }
    }
    throw new Error(`ENOENT: no mount for path: ${path}`);
  }

  private resolveTwoPaths(
    path1: string,
    path2: string,
  ): { backend: FileSystemBackend; rel1: string; rel2: string } {
    const r1 = this.resolve(path1);
    const r2 = this.resolve(path2);
    if (r1.backend !== r2.backend) {
      throw new Error("EXDEV: cross-device link");
    }
    return { backend: r1.backend, rel1: r1.relativePath, rel2: r2.relativePath };
  }

  private getFileHandle(handle: number): HandleInfo {
    const info = this.fileHandles.get(handle);
    if (!info) throw new Error(`EBADF: invalid file handle ${handle}`);
    return info;
  }

  private getDirHandle(handle: number): DirHandleInfo {
    const info = this.dirHandles.get(handle);
    if (!info) throw new Error(`EBADF: invalid dir handle ${handle}`);
    return info;
  }

  /**
   * Turn a backend-local device number into a machine-visible device number.
   * The backend object, not its mount point, owns the namespace: alias mounts
   * therefore agree, while distinct backend instances can never collide.
   */
  private qualifyStat(backend: FileSystemBackend, stat: StatResult): StatResult {
    const localDevice = exactUnsignedIdentity(stat.dev, "st_dev");
    const inode = exactUnsignedIdentity(stat.ino, "st_ino");
    let devices = this.qualifiedDeviceIds.get(backend);
    if (devices === undefined) {
      devices = new Map();
      this.qualifiedDeviceIds.set(backend, devices);
    }
    let device = devices.get(localDevice);
    if (device === undefined) {
      if (this.nextQualifiedDeviceId > MAX_U64) {
        const error = new Error(
          "EOVERFLOW: exhausted virtual filesystem device identities",
        ) as Error & { code: string };
        error.code = "EOVERFLOW";
        throw error;
      }
      device = this.nextQualifiedDeviceId++;
      devices.set(localDevice, device);
    }
    return { ...stat, dev: device, ino: inode };
  }

  fileIdentity(path: string, dev: bigint, ino: bigint): string | null {
    if (ino <= 0n || dev < 0n) return null;
    const { backendId } = this.resolve(path);
    return `vfs:${backendId}:${dev}:${ino}`;
  }

  fileHandleIdentity(handle: number, dev: bigint, ino: bigint): string | null {
    if (ino <= 0n || dev < 0n) return null;
    const { backendId } = this.getFileHandle(handle);
    return `vfs:${backendId}:${dev}:${ino}`;
  }

  // --- File handle operations ---

  async preparePath(path: string): Promise<boolean> {
    // Best-effort host-backend pre-materialization. A path with no mount has no
    // host lazy content to prepare — most importantly `/` once the in-kernel
    // rootfs overlay owns it and the host `/` mount has been dropped (Phase 5
    // 3b-wiring.5). Return false instead of propagating `resolve`'s "no mount"
    // throw: the overlay materializes its own lazy members through the kernel
    // exec-target EAGAIN retry, and the subsequent open/read stays the sole
    // authority for a genuinely-missing path. `resolve`'s only throw is the
    // no-mount error; rethrow anything else.
    let resolved;
    try {
      resolved = this.resolve(path);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("ENOENT: no mount for path")
      ) {
        return false;
      }
      throw error;
    }
    return resolved.backend.preparePath?.(resolved.relativePath) ?? false;
  }

  open(path: string, flags: number, mode: number): number {
    const { backend, backendId, relativePath, nosuid } = this.resolve(path);
    // O_CREAT may name a missing final component. Its already-resolved backend
    // and existing parent provide the filesystem metadata; the open below
    // remains the sole authority for validating and creating the final path.
    const statfsPath = (flags & OPEN_FLAGS.O_CREAT) !== 0
      ? parentPath(relativePath)
      : relativePath;
    const backendStatfs = backend.statfs(statfsPath);
    const statfs = {
      ...backendStatfs,
      flags: nosuid
        ? backendStatfs.flags | ST_NOSUID
        : backendStatfs.flags & ~ST_NOSUID,
    };
    const localHandle = backend.open(relativePath, flags, mode);
    const globalHandle = this.nextHandle++;
    this.fileHandles.set(globalHandle, {
      backend,
      backendId,
      localHandle,
      statfs,
    });
    return globalHandle;
  }

  close(handle: number): number {
    // A directory closes with the same call as a file: the kernel has one
    // handle concept, not two, so this host must not require it to remember
    // which release a given handle needs.
    const dir = this.dirHandles.get(handle);
    if (dir) {
      if (dir.iterator !== null) {
        dir.backend.closedir(dir.iterator);
      }
      this.dirHandles.delete(handle);
      return 0;
    }
    const info = this.getFileHandle(handle);
    const result = info.backend.close(info.localHandle);
    this.fileHandles.delete(handle);
    return result;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    const info = this.getFileHandle(handle);
    return info.backend.read(info.localHandle, buffer, offset, length);
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number {
    const info = this.getFileHandle(handle);
    return info.backend.write(info.localHandle, buffer, offset, length);
  }

  append(
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: HostFileOffset | null,
  ): AppendOutcome {
    const info = this.getFileHandle(handle);
    return info.backend.append(info.localHandle, buffer, length, limit);
  }

  seek(
    handle: number,
    offset: HostFileOffset,
    whence: number,
  ): HostFileOffset {
    const info = this.getFileHandle(handle);
    return info.backend.seek(info.localHandle, offset, whence);
  }

  // Handle-taking operations that a *directory* handle must also answer.
  //
  // A directory handle is an anchor — a backend plus a path — with no backend
  // local handle behind it until something iterates it. So these resolve the
  // directory case through the backend's path form. Everything else
  // (`read`/`write`/`append`/`seek`/`ftruncate`) is meaningless on a directory
  // and keeps failing `EBADF` through `getFileHandle`, which is the truthful
  // answer for a handle that has no byte stream.

  fstat(handle: number): StatResult {
    const dir = this.dirHandles.get(handle);
    if (dir) {
      return this.qualifyStat(dir.backend, dir.backend.stat(dir.path));
    }
    const info = this.getFileHandle(handle);
    return this.qualifyStat(info.backend, info.backend.fstat(info.localHandle));
  }

  fstatfs(handle: number): StatfsResult {
    const dir = this.dirHandles.get(handle);
    if (dir) {
      return { ...dir.statfs };
    }
    const info = this.getFileHandle(handle);
    if (info.statfs === undefined) {
      throw new Error(`EBADF: file handle ${handle} has no mount route`);
    }
    return { ...info.statfs };
  }

  fpathconf(handle: number, name: number): PathconfValue {
    const dir = this.dirHandles.get(handle);
    if (dir) {
      return dir.backend.pathconf(dir.path, name);
    }
    const info = this.getFileHandle(handle);
    return info.backend.fpathconf(info.localHandle, name);
  }

  ftruncate(handle: number, length: number): void {
    const info = this.getFileHandle(handle);
    info.backend.ftruncate(info.localHandle, length);
  }

  fsync(handle: number): void {
    const dir = this.dirHandles.get(handle);
    if (dir) {
      // A directory has no dirty byte stream of its own to flush, and the
      // backend has no handle for it until something iterates. Reaching a
      // consistent directory is the backend's own guarantee.
      return;
    }
    const info = this.getFileHandle(handle);
    info.backend.fsync(info.localHandle);
  }

  fchmod(handle: number, mode: number): void {
    const dir = this.dirHandles.get(handle);
    if (dir) {
      dir.backend.chmod(dir.path, mode);
      return;
    }
    const info = this.getFileHandle(handle);
    info.backend.fchmod(info.localHandle, mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    const dir = this.dirHandles.get(handle);
    if (dir) {
      dir.backend.chown(dir.path, uid, gid);
      return;
    }
    const info = this.getFileHandle(handle);
    info.backend.fchown(info.localHandle, uid, gid);
  }

  // --- Path-based operations: host-internal, NOT part of the kernel contract
  //
  // The kernel never calls any of these. It resolves the POSIX namespace
  // itself and reaches this host only through the `*at` methods above, so
  // none of them appears on `PlatformIO` any more.
  //
  // They survive as ordinary class methods for two reasons: the `*at` methods
  // are implemented in terms of them (a backend is path-shaped, and joining
  // one component to a directory's path is what an anchor means here), and
  // host-side machinery that is not serving a guest — image export, worker
  // bookkeeping — still addresses files by name. Adding a caller from the
  // kernel side would be a regression.

  stat(path: string): StatResult {
    const { backend, relativePath } = this.resolve(path);
    return this.qualifyStat(backend, backend.stat(relativePath));
  }

  lstat(path: string): StatResult {
    const { backend, relativePath } = this.resolve(path);
    return this.qualifyStat(backend, backend.lstat(relativePath));
  }

  statfs(path: string): StatfsResult {
    const { backend, relativePath, nosuid } = this.resolve(path);
    const statfs = backend.statfs(relativePath);
    const flags = nosuid
      ? statfs.flags | ST_NOSUID
      : statfs.flags & ~ST_NOSUID;
    return { ...statfs, flags };
  }

  pathconf(path: string, name: number): PathconfValue {
    const { backend, relativePath } = this.resolve(path);
    return backend.pathconf(relativePath, name);
  }

  mkdir(path: string, mode: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.mkdir(relativePath, mode);
  }

  rmdir(path: string): void {
    const { backend, relativePath } = this.resolve(path);
    backend.rmdir(relativePath);
  }

  unlink(path: string): void {
    const { backend, relativePath } = this.resolve(path);
    backend.unlink(relativePath);
  }

  rename(oldPath: string, newPath: string): void {
    const { backend, rel1, rel2 } = this.resolveTwoPaths(oldPath, newPath);
    backend.rename(rel1, rel2);
  }

  link(existingPath: string, newPath: string): void {
    const { backend, rel1, rel2 } = this.resolveTwoPaths(existingPath, newPath);
    backend.link(rel1, rel2);
  }

  symlink(target: string, path: string): void {
    const { backend, relativePath } = this.resolve(path);
    backend.symlink(target, relativePath);
  }

  readlink(path: string): string {
    const { backend, relativePath } = this.resolve(path);
    return backend.readlink(relativePath);
  }

  chmod(path: string, mode: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.chmod(relativePath, mode);
  }

  chown(path: string, uid: number, gid: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.chown(relativePath, uid, gid);
  }

  lchown(path: string, uid: number, gid: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.lchown(relativePath, uid, gid);
  }

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
    const { backend, relativePath } = this.resolve(path);
    backend.utimensat(relativePath, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  // --- Directory operations ---

  /**
   * Directory handles naming each mount's root, for the kernel to anchor its
   * per-component walks on.
   *
   * This runs once at boot. It is the only place longest-prefix mount routing
   * is still needed: once the kernel holds a root handle per mount, every
   * subsequent operation arrives already routed, because the handle names the
   * backend.
   *
   * A `/` mount is published like any other. Whether the kernel uses it is the
   * kernel's decision, not this host's: when the in-kernel rootfs overlay owns
   * `/`, no path reaches the host root and the anchor simply goes unused;
   * when the overlay is off, a host that mounts `/` must be able to serve it.
   * Withholding the anchor here would make that second case unreachable.
   */
  foreignMountRoots(): { prefix: string; handle: number }[] {
    const roots: { prefix: string; handle: number }[] = [];
    for (const m of this.mounts) {
      const handle = this.nextHandle++;
      this.dirHandles.set(handle, {
        backend: m.backend,
        backendId: m.backendId,
        path: "/",
        nosuid: m.nosuid,
        statfs: this.mountStatfs(m.backend, "/", m.nosuid),
        iterator: null,
      });
      roots.push({ prefix: m.prefix, handle });
    }
    return roots;
  }

  private mountStatfs(
    backend: FileSystemBackend,
    path: string,
    nosuid: boolean,
  ): StatfsResult {
    const backendStatfs = backend.statfs(path);
    return {
      ...backendStatfs,
      flags: nosuid
        ? backendStatfs.flags | ST_NOSUID
        : backendStatfs.flags & ~ST_NOSUID,
    };
  }

  /**
   * Open one component relative to a directory handle this host issued.
   *
   * `O_DIRECTORY` yields another anchor; anything else yields a file handle.
   * Both come from the same id space and are released by `close`.
   */
  openat(dirHandle: number, name: string, flags: number, mode: number): number {
    const dir = this.getDirHandle(dirHandle);
    const path = joinComponent(dir.path, name);
    const globalHandle = this.nextHandle++;
    if ((flags & OPEN_FLAGS.O_DIRECTORY) !== 0) {
      // Confirm it is a directory before handing back an anchor, so a
      // non-directory component fails here rather than at first use.
      const st = dir.backend.stat(path);
      if ((st.mode & FILE_MODES.S_IFMT) !== FILE_MODES.S_IFDIR) {
        throw new Error(`ENOTDIR: not a directory: ${path}`);
      }
      this.dirHandles.set(globalHandle, {
        backend: dir.backend,
        backendId: dir.backendId,
        path,
        nosuid: dir.nosuid,
        statfs: this.mountStatfs(dir.backend, path, dir.nosuid),
        iterator: null,
      });
      return globalHandle;
    }
    // O_CREAT may name a missing final component; its parent supplies the
    // filesystem metadata, and the open below remains the sole authority for
    // validating and creating the entry.
    const statfsPath = (flags & OPEN_FLAGS.O_CREAT) !== 0 ? dir.path : path;
    const localHandle = dir.backend.open(path, flags, mode);
    this.fileHandles.set(globalHandle, {
      backend: dir.backend,
      backendId: dir.backendId,
      localHandle,
      statfs: this.mountStatfs(dir.backend, statfsPath, dir.nosuid),
    });
    return globalHandle;
  }

  fstatat(dirHandle: number, name: string, flags: number): StatResult {
    const dir = this.getDirHandle(dirHandle);
    const path = joinComponent(dir.path, name);
    const stat =
      (flags & AT_FLAGS.AT_SYMLINK_NOFOLLOW) !== 0
        ? dir.backend.lstat(path)
        : dir.backend.stat(path);
    return this.qualifyStat(dir.backend, stat);
  }

  mkdirat(dirHandle: number, name: string, mode: number): void {
    const dir = this.getDirHandle(dirHandle);
    dir.backend.mkdir(joinComponent(dir.path, name), mode);
  }

  /** `AT_REMOVEDIR` selects `rmdir(2)`; POSIX gives both the same operation. */
  unlinkat(dirHandle: number, name: string, flags: number): void {
    const dir = this.getDirHandle(dirHandle);
    const path = joinComponent(dir.path, name);
    if ((flags & AT_FLAGS.AT_REMOVEDIR) !== 0) {
      dir.backend.rmdir(path);
    } else {
      dir.backend.unlink(path);
    }
  }

  renameat(
    oldDirHandle: number,
    oldName: string,
    newDirHandle: number,
    newName: string,
  ): void {
    const oldDir = this.getDirHandle(oldDirHandle);
    const newDir = this.getDirHandle(newDirHandle);
    if (oldDir.backend !== newDir.backend) {
      throw new Error("EXDEV: cross-device link");
    }
    oldDir.backend.rename(
      joinComponent(oldDir.path, oldName),
      joinComponent(newDir.path, newName),
    );
  }

  linkat(
    oldDirHandle: number,
    oldName: string,
    newDirHandle: number,
    newName: string,
  ): void {
    const oldDir = this.getDirHandle(oldDirHandle);
    const newDir = this.getDirHandle(newDirHandle);
    if (oldDir.backend !== newDir.backend) {
      throw new Error("EXDEV: cross-device link");
    }
    oldDir.backend.link(
      joinComponent(oldDir.path, oldName),
      joinComponent(newDir.path, newName),
    );
  }

  /** `target` is opaque data stored verbatim; only `name` names an entry. */
  symlinkat(target: string, dirHandle: number, name: string): void {
    const dir = this.getDirHandle(dirHandle);
    dir.backend.symlink(target, joinComponent(dir.path, name));
  }

  readlinkat(dirHandle: number, name: string): string {
    const dir = this.getDirHandle(dirHandle);
    return dir.backend.readlink(joinComponent(dir.path, name));
  }

  fchmodat(dirHandle: number, name: string, mode: number): void {
    const dir = this.getDirHandle(dirHandle);
    dir.backend.chmod(joinComponent(dir.path, name), mode);
  }

  /** `AT_SYMLINK_NOFOLLOW` selects `lchown(2)`. */
  fchownat(
    dirHandle: number,
    name: string,
    uid: number,
    gid: number,
    flags: number,
  ): void {
    const dir = this.getDirHandle(dirHandle);
    const path = joinComponent(dir.path, name);
    if ((flags & AT_FLAGS.AT_SYMLINK_NOFOLLOW) !== 0) {
      dir.backend.lchown(path, uid, gid);
    } else {
      dir.backend.chown(path, uid, gid);
    }
  }

  utimensatAt(
    dirHandle: number,
    name: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    const dir = this.getDirHandle(dirHandle);
    dir.backend.utimensat(
      joinComponent(dir.path, name),
      atimeSec,
      atimeNsec,
      mtimeSec,
      mtimeNsec,
    );
  }

  /**
   * Read the next entry of a directory handle.
   *
   * The backend cursor is opened on first use. A thrown error must leave the
   * next entry unconsumed: the kernel may return a short successful
   * `getdents64` after copying earlier records and retry this call on the next
   * syscall, so a partially consumed iterator would silently drop an entry.
   */
  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null {
    const info = this.getDirHandle(handle);
    if (info.iterator === null) {
      info.iterator = info.backend.opendir(info.path);
    }
    return info.backend.readdir(info.iterator);
  }

  // --- Time operations ---

  clockGettime(clockId: number): { sec: number; nsec: number } {
    return this.time.clockGettime(clockId);
  }

  nanosleep(sec: number, nsec: number): void {
    this.time.nanosleep(sec, nsec);
  }
}

export interface PreparedPlatformFile {
  data: Uint8Array;
  stat: StatResult;
}

/**
 * Read a complete regular file through its owning PlatformIO mount.
 * Deferred backing is prepared before the synchronous descriptor operations,
 * so API reads and executable resolution share the same lazy-file semantics.
 */
export async function readPreparedPlatformFile(
  io: PlatformIO,
  path: string,
): Promise<PreparedPlatformFile> {
  await io.preparePath?.(path);
  const stat = io.stat(path);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    const error = new Error(`EOVERFLOW: invalid file size for ${path}`) as
      Error & { code: string };
    error.code = "EOVERFLOW";
    throw error;
  }
  const handle = io.open(path, 0, 0);
  try {
    const data = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const count = io.read(
        handle,
        data.subarray(offset),
        null,
        data.byteLength - offset,
      );
      if (count <= 0) break;
      offset += count;
    }
    return {
      data: offset === data.byteLength ? data : data.slice(0, offset),
      stat,
    };
  } finally {
    io.close(handle);
  }
}
