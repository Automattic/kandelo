// MountRouter — implements PlatformIO by dispatching FS ops through a
// MountTable and delegating non-FS ops (time, network, waitpid) to a
// separately-provided HostServices reference.
//
// Handle namespace: each backend is assigned an index at construction
// time; handles returned by a backend are tagged with
// `(backendIndex << HANDLE_SHIFT) | localHandle`. The router extracts
// the tag on every handle-based op to route back to the right backend
// without a per-op Map lookup.

import type { PlatformIO, StatResult, NetworkIO } from "../types";
import type { Backend } from "./backends/backend-interface.ts";
import type { MountTable } from "./mount-table.ts";

/**
 * Handle encoding:
 *   bit 30       — MOUNT_HANDLE_MARKER, always set. Ensures routed handles
 *                  are never 0 (which the kernel reserves for stdin) and
 *                  always positive as int32 (avoids signed-shift hazards).
 *   bits 26..29  — backend index (0-15)
 *   bits 0..25   — backend-local handle (up to 2^26 = ~67M)
 *
 * The MARKER bit at 30 (not 31) keeps the whole value in the positive-int32
 * range (max 0x7fffffff). Going unsigned would work too, but keeping handles
 * positive matches how the kernel stores them as i64 without any signed/
 * unsigned reinterpretation concerns.
 *
 * A backend that returns local handle 0 is common (first fd). Without the
 * marker, tagHandle(0, 0) would collide with stdin's sentinel 0.
 */
const MOUNT_HANDLE_MARKER = 0x40000000;
const HANDLE_TAG_BITS = 4;
const HANDLE_SHIFT = 26; // bits reserved for local handle
const HANDLE_LOCAL_MASK = (1 << HANDLE_SHIFT) - 1; // 0x03ffffff
const HANDLE_TAG_MASK = ((1 << HANDLE_TAG_BITS) - 1) << HANDLE_SHIFT;
const MAX_BACKEND_INDEX = (1 << HANDLE_TAG_BITS) - 1;

/** Check whether `h` looks like a router-tagged handle. */
export function isMountRouterHandle(h: number): boolean {
  return (h & MOUNT_HANDLE_MARKER) !== 0;
}

export type HostServices = Pick<
  PlatformIO,
  | "clockGettime"
  | "nanosleep"
  | "waitpid"
  | "network"
>;

export class MountRouter implements PlatformIO {
  private readonly backends: Backend[];
  /**
   * Set of paths that exist only as virtual intermediate directories
   * because a mount lives at or below them. E.g., mounts at `/etc` and
   * `/var/tmp` populate {"/", "/var"}. These paths don't belong to any
   * backend; MountRouter synthesizes a read-only-directory response for
   * stat/access/readdir on them.
   */
  private readonly virtualDirs: Set<string>;

  constructor(
    private readonly mounts: MountTable,
    private readonly services: HostServices,
  ) {
    const snapshot = mounts.snapshot();
    if (snapshot.length > MAX_BACKEND_INDEX + 1) {
      throw new Error(
        `too many mounts (${snapshot.length}); max ${MAX_BACKEND_INDEX + 1}`,
      );
    }
    this.backends = snapshot.map((m) => m.backend);

    // Walk every mount's prefix to seed the virtual-dir set. Mount "/etc"
    // seeds "/". Mount "/usr/local/bin" seeds "/", "/usr", "/usr/local".
    // "/" is always a virtual dir so access("/") succeeds as POSIX requires.
    this.virtualDirs = new Set();
    this.virtualDirs.add("/");
    for (const m of snapshot) {
      const parts = m.mount.split("/").filter(Boolean);
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc += "/" + parts[i];
        this.virtualDirs.add(acc);
      }
    }
  }

  /** Synthesized dir stat for virtual intermediate dirs. */
  private virtualDirStat(): StatResult {
    return {
      dev: 0,
      ino: 0,
      mode: 0o040755, // S_IFDIR | 0755
      nlink: 2,
      uid: 0,
      gid: 0,
      size: 0,
      atimeMs: 0,
      mtimeMs: 0,
      ctimeMs: 0,
    };
  }

  /** Is `path` a synthetic virtual intermediate dir (no backend owns it)? */
  private isVirtualDir(path: string): boolean {
    return this.virtualDirs.has(path);
  }

  // Virtual-dir open handles are stored in a sidecar map. The tag uses
  // backend index 15 as a reserved "virtual" slot — no real backend can
  // occupy index 15 because MAX_BACKEND_INDEX is 15 and the constructor
  // throws on overflow (so at most 15 real backends can register, 0-14).
  private virtualDirHandles = new Map<number, { path: string; children: string[]; cursor: number }>();
  private nextVirtualDirHandle = 1;
  private readonly VIRTUAL_TAG = MAX_BACKEND_INDEX; // 15

  private openVirtualDir(path: string): number {
    const h = this.nextVirtualDirHandle++;
    if ((h & ~HANDLE_LOCAL_MASK) !== 0) {
      throw new Error(`too many virtual dir handles`);
    }
    this.virtualDirHandles.set(h, {
      path,
      children: this.virtualDirChildren(path),
      cursor: 0,
    });
    return MOUNT_HANDLE_MARKER | (this.VIRTUAL_TAG << HANDLE_SHIFT) | h;
  }

  /** Immediate children of a virtual dir — top-level mount name segments. */
  private virtualDirChildren(path: string): string[] {
    const prefix = path === "/" ? "/" : path + "/";
    const children = new Set<string>();
    for (const m of this.mounts.snapshot()) {
      if (!m.mount.startsWith(prefix)) continue;
      const rest = m.mount.slice(prefix.length);
      const firstSegment = rest.split("/")[0];
      if (firstSegment) children.add(firstSegment);
    }
    return [...children].sort();
  }

  // ── Path-based FS ops ──────────────────────────────────────────────

  private route(path: string): { backend: Backend; backendIndex: number; subPath: string } {
    const r = this.mounts.resolve(path);
    if (!r) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: no mount covers ${path}`);
      err.code = "ENOENT";
      throw err;
    }
    return { backend: r.entry.backend, backendIndex: r.backendIndex, subPath: r.subPath };
  }

  open(path: string, flags: number, mode: number): number {
    if (this.isVirtualDir(path)) {
      // Virtual dirs support opendir via the Directory fd flag, but plain
      // open() is only meaningful read-only. We encode a virtual-dir fd
      // using a reserved tag (15) so routing still works downstream.
      return this.openVirtualDir(path);
    }
    const { backend, backendIndex, subPath } = this.route(path);
    return tagHandle(backendIndex, backend.open(subPath, flags, mode));
  }

  stat(path: string): StatResult {
    if (this.isVirtualDir(path)) return this.virtualDirStat();
    const { backend, subPath } = this.route(path);
    return backend.stat(subPath);
  }

  lstat(path: string): StatResult {
    if (this.isVirtualDir(path)) return this.virtualDirStat();
    const { backend, subPath } = this.route(path);
    return backend.lstat(subPath);
  }

  mkdir(path: string, mode: number): void {
    const { backend, subPath } = this.route(path);
    backend.mkdir(subPath, mode);
  }

  rmdir(path: string): void {
    const { backend, subPath } = this.route(path);
    backend.rmdir(subPath);
  }

  unlink(path: string): void {
    const { backend, subPath } = this.route(path);
    backend.unlink(subPath);
  }

  rename(oldPath: string, newPath: string): void {
    const a = this.route(oldPath);
    const b = this.route(newPath);
    if (a.backend !== b.backend) {
      const err: NodeJS.ErrnoException = new Error("EXDEV: cross-device rename");
      err.code = "EXDEV";
      throw err;
    }
    a.backend.rename(a.subPath, b.subPath);
  }

  link(existingPath: string, newPath: string): void {
    const a = this.route(existingPath);
    const b = this.route(newPath);
    if (a.backend !== b.backend) {
      const err: NodeJS.ErrnoException = new Error("EXDEV: cross-device link");
      err.code = "EXDEV";
      throw err;
    }
    a.backend.link(a.subPath, b.subPath);
  }

  symlink(target: string, path: string): void {
    // Symlink target is opaque to the router; the backend hosting the
    // link just stores the bytes. Readers later resolve the target
    // through the router (or not — absolute symlink targets are
    // interpreted against the VFS root).
    const { backend, subPath } = this.route(path);
    backend.symlink(target, subPath);
  }

  readlink(path: string): string {
    const { backend, subPath } = this.route(path);
    return backend.readlink(subPath);
  }

  chmod(path: string, mode: number): void {
    const { backend, subPath } = this.route(path);
    backend.chmod(subPath, mode);
  }

  chown(path: string, uid: number, gid: number): void {
    const { backend, subPath } = this.route(path);
    backend.chown(subPath, uid, gid);
  }

  access(path: string, mode: number): void {
    if (this.isVirtualDir(path)) {
      // Virtual dirs are read-only: allow R_OK, F_OK, X_OK; deny W_OK.
      if (mode & 0o2) { // W_OK
        const err: NodeJS.ErrnoException = new Error("EROFS: virtual dir");
        err.code = "EROFS";
        throw err;
      }
      return;
    }
    const { backend, subPath } = this.route(path);
    backend.access(subPath, mode);
  }

  utimensat(
    path: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    const { backend, subPath } = this.route(path);
    backend.utimensat(subPath, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  opendir(path: string): number {
    if (this.isVirtualDir(path)) return this.openVirtualDir(path);
    const { backend, backendIndex, subPath } = this.route(path);
    return tagHandle(backendIndex, backend.opendir(subPath));
  }

  // ── Handle-based FS ops ────────────────────────────────────────────

  private isVirtualDirHandle(handle: number): boolean {
    if ((handle & MOUNT_HANDLE_MARKER) === 0) return false;
    const idx = (handle & HANDLE_TAG_MASK) >>> HANDLE_SHIFT;
    return idx === this.VIRTUAL_TAG;
  }

  private fromHandle(handle: number): { backend: Backend; local: number } {
    if ((handle & MOUNT_HANDLE_MARKER) === 0) {
      const err: NodeJS.ErrnoException = new Error(`EBADF: handle ${handle} is not mount-router-owned`);
      err.code = "EBADF";
      throw err;
    }
    const idx = (handle & HANDLE_TAG_MASK) >>> HANDLE_SHIFT;
    const backend = this.backends[idx];
    if (!backend) {
      const err: NodeJS.ErrnoException = new Error(`EBADF: unknown backend index ${idx}`);
      err.code = "EBADF";
      throw err;
    }
    return { backend, local: handle & HANDLE_LOCAL_MASK };
  }

  close(handle: number): number {
    if (this.isVirtualDirHandle(handle)) {
      this.virtualDirHandles.delete(handle & HANDLE_LOCAL_MASK);
      return 0;
    }
    const { backend, local } = this.fromHandle(handle);
    return backend.close(local);
  }

  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    const { backend, local } = this.fromHandle(handle);
    return backend.read(local, buffer, offset, length);
  }

  write(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    const { backend, local } = this.fromHandle(handle);
    return backend.write(local, buffer, offset, length);
  }

  seek(handle: number, offset: number, whence: number): number {
    const { backend, local } = this.fromHandle(handle);
    return backend.seek(local, offset, whence);
  }

  fstat(handle: number): StatResult {
    if (this.isVirtualDirHandle(handle)) return this.virtualDirStat();
    const { backend, local } = this.fromHandle(handle);
    return backend.fstat(local);
  }

  ftruncate(handle: number, length: number): void {
    const { backend, local } = this.fromHandle(handle);
    backend.ftruncate(local, length);
  }

  fsync(handle: number): void {
    const { backend, local } = this.fromHandle(handle);
    backend.fsync(local);
  }

  fchmod(handle: number, mode: number): void {
    const { backend, local } = this.fromHandle(handle);
    backend.fchmod(local, mode);
  }

  fchown(handle: number, uid: number, gid: number): void {
    const { backend, local } = this.fromHandle(handle);
    backend.fchown(local, uid, gid);
  }

  readdir(handle: number): { name: string; type: number; ino: number } | null {
    if (this.isVirtualDirHandle(handle)) {
      const local = handle & HANDLE_LOCAL_MASK;
      const entry = this.virtualDirHandles.get(local);
      if (!entry) return null;
      if (entry.cursor >= entry.children.length) return null;
      const name = entry.children[entry.cursor++];
      return { name, type: 4, ino: 0 }; // DT_DIR=4
    }
    const { backend, local } = this.fromHandle(handle);
    return backend.readdir(local);
  }

  closedir(handle: number): void {
    if (this.isVirtualDirHandle(handle)) {
      this.virtualDirHandles.delete(handle & HANDLE_LOCAL_MASK);
      return;
    }
    const { backend, local } = this.fromHandle(handle);
    backend.closedir(local);
  }

  // ── Non-FS ops: delegate to HostServices ───────────────────────────

  clockGettime(clockId: number): { sec: number; nsec: number } {
    return this.services.clockGettime(clockId);
  }
  nanosleep(sec: number, nsec: number): void {
    this.services.nanosleep(sec, nsec);
  }

  get waitpid(): PlatformIO["waitpid"] {
    return this.services.waitpid?.bind(this.services);
  }
  get network(): NetworkIO | undefined {
    return this.services.network;
  }
}

function tagHandle(backendIndex: number, local: number): number {
  if ((local & ~HANDLE_LOCAL_MASK) !== 0) {
    throw new Error(
      `backend handle ${local} exceeds ${HANDLE_LOCAL_MASK} bit capacity`,
    );
  }
  if (backendIndex < 0 || backendIndex > MAX_BACKEND_INDEX) {
    throw new Error(
      `backend index ${backendIndex} out of range (max ${MAX_BACKEND_INDEX})`,
    );
  }
  // MARKER bit at 30 is always set — keeps every tagged handle non-zero
  // (stdin is 0) and positive as int32 (avoids signed-shift hazards in
  // any callsite that reinterprets the handle). Backends can safely
  // return local handle 0 without collision.
  return MOUNT_HANDLE_MARKER | (backendIndex << HANDLE_SHIFT) | local;
}
