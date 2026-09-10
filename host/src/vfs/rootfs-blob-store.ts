/**
 * The host's remaining job for the kernel-owned `/`: be a byte store the kernel
 * addresses by an identifier the kernel chose.
 *
 * The kernel parses the `/` VFS image itself (`rootfs::load_image`) and needs no
 * tree from the host. It does still ask the host for a base file's *bytes*,
 * through `ByteReq::Base { blob_id }`, and `blob_id` is the file's inode number
 * on both sides — the image's SFFS inode, which `MemoryFileSystem.fromImage`
 * preserves.
 *
 * So one host-side map survives the cutover: inode -> backend path. It exists
 * because the byte store is addressed by *path* and, for a lazily materialized
 * file, materialization is keyed by path too — `open` is what kicks the fetch
 * off and throws `EAGAIN` until it lands. That is a genuine residual, not a
 * leftover: the honest way to remove it is for the kernel to serve an
 * image-backed file's bytes from the image through the SFFS reader it already
 * mounts, which also retires the `host_blob_read` import. Until then the host
 * walks the restored filesystem once at boot to build the map, and nothing else.
 *
 * The walk is deliberately small and metadata-only. It resolves no names for the
 * kernel, encodes no tree, and its result is never compared against the kernel's
 * — the kernel's tree comes from the image.
 */

import type { FileSystemBackend } from "./types";

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const O_RDONLY = 0;

const EAGAIN = -11;
const EIO = -5;

/**
 * Convert a kernel-facing absolute path (e.g. "/usr/bin") to the string the
 * backend's own methods expect (mount-relative). The `/` mount's convention is
 * injected so this module stays backend-agnostic and unit-testable.
 */
export type ToBackendPath = (absolutePath: string) => string;

/**
 * Walk the `/` image backend and return `inode number -> backend path` for every
 * regular file, for {@link createRootfsBlobProvider} to resolve `blob_id` with.
 *
 * Every regular file is mapped, including ones the image records as lazy. An
 * archive-backed lazy file is served through the archive provider and its blob
 * id is never requested, so its entry is simply unused; a URL-backed lazy file
 * IS a base file to the kernel (only its size comes from the image's `KLZY`
 * section) and genuinely needs its path here. Mapping both is one rule instead
 * of two, and the failure mode of the alternative — a missing entry — is an
 * `ENOENT` on a file that exists.
 *
 * Hard links share one inode and therefore one leaf, which is correct: the
 * bytes are the same bytes.
 */
export function collectRootfsBlobPaths(
  backend: FileSystemBackend,
  toBackendPath: ToBackendPath,
): Map<number, string> {
  const blobPaths = new Map<number, string>();

  const rootStat = backend.lstat(toBackendPath("/"));
  if ((rootStat.mode & S_IFMT) !== S_IFDIR) {
    throw new Error("rootfs blob store: `/` is not a directory in the image backend");
  }

  // Iterative, not recursive: image depth is untrusted input in a browser (a
  // shared boot descriptor can name an image), matching the kernel-side walk.
  const pending: string[] = ["/"];
  while (pending.length > 0) {
    const absDir = pending.pop()!;
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
    for (const name of names) {
      const abs = absDir === "/" ? `/${name}` : `${absDir}/${name}`;
      const st = backend.lstat(toBackendPath(abs));
      const type = st.mode & S_IFMT;
      if (type === S_IFDIR) {
        pending.push(abs);
      } else if (type === S_IFREG) {
        blobPaths.set(Number(st.ino), toBackendPath(abs));
      }
      // Symlinks carry no bytes of their own, and anything else has no place in
      // a `/` image. Both are the kernel's to describe; this map is only about
      // where a regular file's bytes are.
    }
  }

  return blobPaths;
}

/**
 * Map a backend exception to a negative errno for the blob provider. A lazy
 * (not-yet-materialized) base file makes the backend's `open`/`read` throw an
 * error tagged `code === "EAGAIN"` (see `MemoryFileSystem.guardSynchronousLazyAccess`,
 * which also kicks off the async fetch). We propagate that as EAGAIN so the
 * kernel parks the read and retries — the same park/retry the host-served path
 * uses — instead of surfacing a spurious EIO. Every other failure is EIO.
 */
function blobErrno(error: unknown): number {
  return (error as { code?: unknown })?.code === "EAGAIN" ? EAGAIN : EIO;
}

/**
 * Build the byte provider installed via `WasmPosixKernel.setRootfsBlobProvider`.
 * It resolves a `blob_id` (inode number) to the backend path and reads the bytes
 * with a positioned read. Returns bytes read (0 at EOF), or a negative errno —
 * `-EAGAIN` when the leaf is lazy and still materializing (the kernel parks and
 * retries), `-EIO` on a real failure.
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
      // A lazy leaf throws EAGAIN here (open kicks off materialization).
      handle = backend.open(path, O_RDONLY, 0);
    } catch (error) {
      return blobErrno(error);
    }
    if (handle < 0) {
      return handle;
    }
    try {
      return backend.read(handle, dest, Number(offset), dest.length);
    } catch (error) {
      return blobErrno(error);
    } finally {
      try {
        backend.close(handle);
      } catch {
        // A close failure does not change the bytes already read.
      }
    }
  };
}
