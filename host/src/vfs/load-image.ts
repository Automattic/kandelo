/**
 * Load a VFS image from a URL, handling `.vfs` (plain) and `.vfs.zst`
 * (zstd-compressed) transparently.
 *
 * Why zstd is done client-side rather than via `Content-Encoding: zstd` on the
 * HTTP server: we cannot rely on every consumer's server to negotiate zstd
 * correctly (Vite dev server, GitHub's raw asset download, Node `fetch`,
 * browser environments that lag the spec). Detection happens inside the load
 * by checking the zstd magic — callers do not need to pre-decompress.
 *
 * These read with `SffsImageFs`, the same writer that produces the images.
 * Restoring through the legacy TypeScript reader could not see an image's
 * `SDEF` section at all, so a restore-mutate-save round trip silently emptied
 * the deferred half — defect B45.
 */

import { SffsImageFs } from "../../../images/vfs/lib/sffs-image-fs";
import {
  MemoryFileSystem,
  type VfsImageRestoreOptions,
} from "./memory-fs";

/**
 * Restore an image, authenticated.
 *
 * "Verified" is no longer something this function DOES. `loadImage` runs
 * `seal::verify_cohorts` inside the load and unloads the image if it fails, so
 * an unverified loaded image is unrepresentable rather than merely
 * discouraged — a verification a caller can forget is one some caller
 * eventually will. The name is kept because the guarantee is kept, and every
 * call site reads better for saying it.
 */
export async function restoreVerifiedVfsImage(
  image: Uint8Array,
  options?: { maxByteLength?: number },
): Promise<SffsImageFs> {
  const fs = SffsImageFs.create();
  fs.loadImage(image);
  // A declared ceiling, not a reservation: the bridge grows its own memory
  // with the tree. Absent, the export sizes to the tree and the image declares
  // no growth room, which is what a caller passing this wants to avoid.
  if (options?.maxByteLength !== undefined) {
    fs.setImageCapacity(options.maxByteLength);
  }
  return fs;
}

/**
 * Capacity-preserving peer of {@link restoreVerifiedVfsImage}: keeps whatever
 * the image itself declares rather than imposing a new ceiling.
 */
export async function restoreVerifiedVfsImagePreservingCapacity(
  image: Uint8Array,
): Promise<SffsImageFs> {
  return restoreVerifiedVfsImage(image);
}

/**
 * Fetch an image and return it as a live MOUNT BACKEND.
 *
 * Deliberately still `MemoryFileSystem`, and the reason is a real boundary
 * rather than an unfinished edit. That class does two jobs: it BUILDS images,
 * and it serves as a `FileSystemBackend` a mount can be backed by.
 * `SffsImageFs` does only the first — it describes an image, and has no
 * `append`, `seek`, `fpathconf` or the rest of the runtime surface a backend
 * owes. Migrating the building role is B45; migrating the backend role is a
 * different job with a different end state (the kernel owns `/`, so the
 * remaining host backends are the ones it does not claim).
 *
 * Callers that want to BUILD an image want {@link restoreVerifiedVfsImage}.
 */
/** Restore an image as a live MOUNT BACKEND. See {@link loadVfsImageBackend}. */
export async function restoreVerifiedVfsImageBackend(
  image: Uint8Array,
  options?: VfsImageRestoreOptions,
): Promise<MemoryFileSystem> {
  const fs = MemoryFileSystem.fromImage(image, options);
  await fs.verifyImportedLazyAtomicGroupSeals();
  return fs;
}

export async function loadVfsImageBackend(
  url: string,
  options?: VfsImageRestoreOptions,
): Promise<MemoryFileSystem> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load VFS image from ${url} (${response.status} ${response.statusText})`,
    );
  }
  const fs = MemoryFileSystem.fromImage(
    new Uint8Array(await response.arrayBuffer()),
    options,
  );
  await fs.verifyImportedLazyAtomicGroupSeals();
  return fs;
}

export async function loadVfsImage(
  url: string,
  options?: { maxByteLength?: number },
): Promise<SffsImageFs> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load VFS image from ${url} (${response.status} ${response.statusText})`,
    );
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  // WHY: a URL is an imported trust boundary. The load authenticates sealed
  // cohorts before returning, so no caller can inspect or mutate an image
  // whose claims have not been checked.
  return restoreVerifiedVfsImage(buf, options);
}
