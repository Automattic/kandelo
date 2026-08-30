/**
 * Rootfs overlay boot manifest (Phase 5 Increment 2).
 *
 * The in-kernel rootfs overlay owns the `/` tree in Rust; the host is demoted to
 * a byte-leaf provider. At boot the host walks the `/` image backend once and
 * emits the whole tree as a single compact binary buffer (the "RTFS" manifest)
 * that the kernel parses via `rootfs::load_manifest` — one host->kernel crossing
 * for the entire tree, not one call per file.
 *
 * Wire format (little-endian) — must match `crates/runtime-core/src/rootfs.rs`:
 *   header: magic u32 = "RTFS" | version u32 = 1 | entry_count u32
 *   entry:  kind u8 (1=dir, 2=file, 3=symlink)
 *           mode u32 | uid u32 | gid u32 | ino u64 | blob_id u64 | size u64
 *           path_len u32 | path[path_len]   (absolute, kernel-facing)
 *           target_len u32 | target[target_len]   (0 unless symlink)
 * Entries are parent-first (pre-order walk) so each insert's parent exists.
 *
 * `blob_id` is the file's inode number (see the decision record in
 * docs/plans/2026-08-28-phase5-vfs-to-rust.md): opaque to the kernel, mapped
 * host-side back to a byte source. Hard links (one inode, many names) therefore
 * share a single leaf automatically.
 */

import type { FileSystemBackend } from "./types";

export const RTFS_MAGIC = 0x5346_5452; // "RTFS" little-endian
export const RTFS_VERSION = 1;

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;
const O_RDONLY = 0;

const KIND_DIR = 1;
const KIND_FILE = 2;
const KIND_SYMLINK = 3;

/** Growable little-endian byte writer (no DataView aliasing across growth). */
class ByteWriter {
  #buf: Uint8Array;
  #len = 0;

  constructor(initialCapacity = 64 * 1024) {
    this.#buf = new Uint8Array(initialCapacity);
  }

  #ensure(extra: number): void {
    const need = this.#len + extra;
    if (need <= this.#buf.length) return;
    let cap = this.#buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  u8(v: number): void {
    this.#ensure(1);
    this.#buf[this.#len++] = v & 0xff;
  }

  u32(v: number): void {
    this.#ensure(4);
    const u = v >>> 0;
    this.#buf[this.#len++] = u & 0xff;
    this.#buf[this.#len++] = (u >>> 8) & 0xff;
    this.#buf[this.#len++] = (u >>> 16) & 0xff;
    this.#buf[this.#len++] = (u >>> 24) & 0xff;
  }

  u64(v: bigint): void {
    this.#ensure(8);
    let x = v & 0xffff_ffff_ffff_ffffn;
    for (let i = 0; i < 8; i++) {
      this.#buf[this.#len++] = Number(x & 0xffn);
      x >>= 8n;
    }
  }

  patchU32(pos: number, v: number): void {
    const u = v >>> 0;
    this.#buf[pos] = u & 0xff;
    this.#buf[pos + 1] = (u >>> 8) & 0xff;
    this.#buf[pos + 2] = (u >>> 16) & 0xff;
    this.#buf[pos + 3] = (u >>> 24) & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.#ensure(b.length);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
  }

  get length(): number {
    return this.#len;
  }

  take(): Uint8Array {
    return this.#buf.subarray(0, this.#len);
  }
}

/** Convert a kernel-facing absolute path (e.g. "/usr/bin") to the string the
 * backend's own methods expect (mount-relative). The `/` mount's convention is
 * injected so this module stays backend-agnostic and unit-testable. */
export type ToBackendPath = (absolutePath: string) => string;

export interface EmittedRootfsManifest {
  /** The RTFS buffer to hand to `kernel_rootfs_load_manifest`. */
  readonly buffer: Uint8Array;
  /** `inode number -> backend path`, for the byte provider. */
  readonly blobPaths: Map<number, string>;
  /** Number of entries emitted (dirs + files + symlinks). */
  readonly entryCount: number;
  /** Paths skipped because they were neither dir/file/symlink (e.g. sockets or
   * device nodes that should not appear in a `/` image). Surfaced, not hidden. */
  readonly skipped: readonly string[];
}

const encoder = new TextEncoder();

/**
 * Walk the `/` image backend pre-order and emit the RTFS manifest plus the
 * inode->path map the byte provider needs.
 */
export function emitRootfsManifest(
  backend: FileSystemBackend,
  toBackendPath: ToBackendPath,
): EmittedRootfsManifest {
  const w = new ByteWriter();
  w.u32(RTFS_MAGIC);
  w.u32(RTFS_VERSION);
  const countPos = w.length;
  w.u32(0); // entry_count placeholder, patched at the end

  const blobPaths = new Map<number, string>();
  const skipped: string[] = [];
  let count = 0;

  const emit = (
    kind: number,
    absPath: string,
    mode: number,
    uid: number,
    gid: number,
    ino: number | bigint,
    blobId: number | bigint,
    size: number,
    target: Uint8Array,
  ): void => {
    const pathBytes = encoder.encode(absPath);
    w.u8(kind);
    w.u32(mode & 0o7777);
    w.u32(uid >>> 0);
    w.u32(gid >>> 0);
    w.u64(BigInt(ino));
    w.u64(BigInt(blobId));
    w.u64(BigInt(size));
    w.u32(pathBytes.length);
    w.bytes(pathBytes);
    w.u32(target.length);
    w.bytes(target);
    count++;
  };

  // Root first.
  const rootStat = backend.lstat(toBackendPath("/"));
  if ((rootStat.mode & S_IFMT) !== S_IFDIR) {
    throw new Error("rootfs manifest: `/` is not a directory in the image backend");
  }
  emit(KIND_DIR, "/", rootStat.mode, rootStat.uid, rootStat.gid, rootStat.ino, 0, 0, EMPTY);

  const walk = (absDir: string): void => {
    const handle = backend.opendir(toBackendPath(absDir));
    const names: string[] = [];
    try {
      for (;;) {
        const entry = backend.readdir(handle);
        if (entry === null) break;
        if (entry.name === "." || entry.name === "..") continue;
        names.push(entry.name);
      }
    } finally {
      backend.closedir(handle);
    }
    // Deterministic order so the manifest (and its content hash) is stable.
    names.sort();
    for (const name of names) {
      const abs = absDir === "/" ? `/${name}` : `${absDir}/${name}`;
      const st = backend.lstat(toBackendPath(abs));
      const type = st.mode & S_IFMT;
      if (type === S_IFDIR) {
        emit(KIND_DIR, abs, st.mode, st.uid, st.gid, st.ino, 0, 0, EMPTY);
        walk(abs);
      } else if (type === S_IFREG) {
        emit(KIND_FILE, abs, st.mode, st.uid, st.gid, st.ino, st.ino, st.size, EMPTY);
        blobPaths.set(Number(st.ino), toBackendPath(abs));
      } else if (type === S_IFLNK) {
        const target = encoder.encode(backend.readlink(toBackendPath(abs)));
        emit(KIND_SYMLINK, abs, st.mode, st.uid, st.gid, st.ino, 0, 0, target);
      } else {
        // Sockets/FIFOs/device nodes have no place in a `/` image; a real one
        // is a build defect, not something to silently absorb.
        skipped.push(abs);
      }
    }
  };

  walk("/");
  w.patchU32(countPos, count);
  return { buffer: w.take(), blobPaths, entryCount: count, skipped };
}

const EMPTY = new Uint8Array(0);

/**
 * Build the byte provider installed via `WasmPosixKernel.setRootfsBlobProvider`.
 * It resolves a `blob_id` (inode number) to the backend path and reads the bytes
 * with a positioned read. Returns bytes read (0 at EOF) or a negative errno.
 *
 * Opens per call for now; an fd cache keyed by blob id is a deliberate later
 * optimization (called out, not silently adopted) once the read hot path is
 * measured.
 */
export function createRootfsBlobProvider(
  backend: FileSystemBackend,
  blobPaths: Map<number, string>,
): (blobId: bigint, offset: bigint, dest: Uint8Array) => number {
  return (blobId, offset, dest) => {
    const path = blobPaths.get(Number(blobId));
    if (path === undefined) {
      return -2; // ENOENT: unknown blob id
    }
    let handle: number;
    try {
      handle = backend.open(path, O_RDONLY, 0);
    } catch {
      return -5; // EIO
    }
    if (handle < 0) {
      return handle;
    }
    try {
      return backend.read(handle, dest, Number(offset), dest.length);
    } catch {
      return -5; // EIO
    } finally {
      try {
        backend.close(handle);
      } catch {
        // A close failure does not change the bytes already read.
      }
    }
  };
}
