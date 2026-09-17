/**
 * Load a VFS image from a URL as a live MOUNT BACKEND, handling `.vfs` (plain)
 * and `.vfs.zst` (zstd-compressed) transparently.
 *
 * Why zstd is done client-side rather than via `Content-Encoding: zstd` on the
 * HTTP server: we cannot rely on every consumer's server to negotiate zstd
 * correctly (Vite dev server, GitHub's raw asset download, Node `fetch`,
 * browser environments that lag the spec). Detection happens in
 * `MemoryFileSystem.fromImage` by checking the zstd magic — callers do not need
 * to pre-decompress.
 *
 * # Why this is still `MemoryFileSystem`
 *
 * That class does two jobs: it BUILDS images, and it serves as a live
 * `FileSystemBackend` a mount can be backed by. Only the first job moved to
 * `KandeloImageFs` (defect B45 — the legacy writer cannot express the `SDEF`
 * section, so a build-time round trip through it emptied the image's deferred
 * half). The backend job stays here, because `KandeloImageFs` describes an image
 * and owes none of `append`, `seek`, `fpathconf` or the rest of the runtime
 * surface a backend must provide.
 *
 * A caller that wants to BUILD an image wants `restoreVerifiedImageForBuild`
 * in `apps/browser-demos/lib/kernel-owned-boot.ts`, not this module. That is
 * also a layering fact rather than a preference: `host/src` is the host
 * runtime and may not import from `images/`, which the host package's own
 * `rootDir` enforces at build time.
 */

import {
  MemoryFileSystem,
  type VfsImageRestoreOptions,
} from "./memory-fs";

/**
 * NO LONGER ON ANY BOOT PATH, and kept for the callers that mount an image.
 *
 * The `/` mount's restore was this module's runtime caller, and it is gone:
 * an image mount gets no host backend, because the kernel serves `/`. What
 * remains are three harnesses that need a live filesystem OVER an image —
 * `scripts`/`packages/registry` demo and test drivers — which is the mount
 * BACKEND role, and `KandeloImageFs` describes an image rather than backing a
 * mount.
 *
 * It is no longer re-exported from `vfs/index.ts` or `browser.ts`: those made
 * it public API for a role nothing public has any more. The three callers
 * import the module directly, which is the honest shape for something this
 * narrow.
 *
 * FOUND BY DELETING IT. A census over `host/src`, `apps`, `web-libs`,
 * `images`, `tools` and `packages/registry` reported no callers, because it
 * omitted `scripts/` — and the browser suite then aborted at startup with
 * `Cannot find module`. A census is only as good as the directories it walks.
 */

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

/** Capacity-preserving peer of {@link restoreVerifiedVfsImage}. */
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
  // WHY: a URL is an imported trust boundary. Do not hand callers a filesystem
  // whose sealed lazy metadata can be inspected or mutated before its
  // cryptographic cohort claims have been authenticated.
  return restoreVerifiedVfsImage(buf, options);
}
