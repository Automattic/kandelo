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

/** Bits used to encode the backend index in each handle. 4 bits → 16 backends. */
const HANDLE_TAG_BITS = 4;
const HANDLE_SHIFT = 28; // 32 - HANDLE_TAG_BITS
const HANDLE_LOCAL_MASK = (1 << HANDLE_SHIFT) - 1; // 0x0fffffff
const MAX_BACKEND_INDEX = (1 << HANDLE_TAG_BITS) - 1;

export type HostServices = Pick<
  PlatformIO,
  | "clockGettime"
  | "nanosleep"
  | "waitpid"
  | "network"
>;

export class MountRouter implements PlatformIO {
  private readonly backends: Backend[];

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
    const { backend, backendIndex, subPath } = this.route(path);
    return tagHandle(backendIndex, backend.open(subPath, flags, mode));
  }

  stat(path: string): StatResult {
    const { backend, subPath } = this.route(path);
    return backend.stat(subPath);
  }

  lstat(path: string): StatResult {
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
    const { backend, backendIndex, subPath } = this.route(path);
    return tagHandle(backendIndex, backend.opendir(subPath));
  }

  // ── Handle-based FS ops ────────────────────────────────────────────

  private fromHandle(handle: number): { backend: Backend; local: number } {
    const idx = (handle >>> HANDLE_SHIFT) & MAX_BACKEND_INDEX;
    const backend = this.backends[idx];
    if (!backend) {
      const err: NodeJS.ErrnoException = new Error(`EBADF: unknown backend index ${idx}`);
      err.code = "EBADF";
      throw err;
    }
    return { backend, local: handle & HANDLE_LOCAL_MASK };
  }

  close(handle: number): number {
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
    const { backend, local } = this.fromHandle(handle);
    return backend.readdir(local);
  }

  closedir(handle: number): void {
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
  // Unsigned arithmetic — backendIndex=8 would produce 0x80000000, a
  // negative int32 in JS, which the kernel would interpret as an error
  // when returned from host_open. `>>> 0` converts to uint32.
  return ((backendIndex << HANDLE_SHIFT) | local) >>> 0;
}
