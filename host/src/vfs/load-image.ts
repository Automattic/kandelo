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

import { MemoryFileSystem, type VfsImageOptions } from "./memory-fs";

export async function loadVfsImage(
  url: string,
  options?: VfsImageOptions & { maxByteLength?: number },
): Promise<MemoryFileSystem> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load VFS image from ${url} (${response.status} ${response.statusText})`,
    );
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  return MemoryFileSystem.fromImage(buf, options);
}
