/**
 * Load a VFS image from a URL, handling `.vfs` (plain) and `.vfs.zst`
 * (zstd-compressed) transparently.
 *
 * Why zstd is done client-side rather than via `Content-Encoding: zstd`
 * on the HTTP server: we cannot rely on every consumer's server to
 * negotiate zstd correctly (Vite dev server, GitHub's raw asset
 * download, Node `fetch`, browser environments that lag the spec).
 * fzstd is ~18KB minified and deterministic.
 *
 * Detection happens in `MemoryFileSystem.fromImage` by checking the
 * zstd magic — callers do not need to pre-decompress.
 */

import {
  MemoryFileSystem,
  type VfsImageRestoreOptions,
} from "./memory-fs";

/**
 * Restore an image and authenticate every imported atomic lazy-tree seal
 * before returning a filesystem that callers can inspect or mutate.
 */
export async function restoreVerifiedVfsImage(
  image: Uint8Array,
  options?: VfsImageRestoreOptions,
): Promise<MemoryFileSystem> {
  const fs = MemoryFileSystem.fromImage(image, options);
  await fs.verifyImportedLazyAtomicGroupSeals();
  return fs;
}

/**
 * Capacity-preserving peer of {@link restoreVerifiedVfsImage}.
 */
export async function restoreVerifiedVfsImagePreservingCapacity(
  image: Uint8Array,
): Promise<MemoryFileSystem> {
  const fs = MemoryFileSystem.fromImagePreservingCapacity(image);
  await fs.verifyImportedLazyAtomicGroupSeals();
  return fs;
}

export async function loadVfsImage(
  url: string,
  options?: VfsImageRestoreOptions,
): Promise<MemoryFileSystem> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load VFS image from ${url} (${response.status} ${response.statusText})`,
    );
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  // WHY: a URL is an imported trust boundary. Do not hand callers a
  // filesystem whose sealed lazy metadata can be inspected or mutated before
  // its cryptographic cohort claims have been authenticated.
  return restoreVerifiedVfsImage(buf, options);
}
