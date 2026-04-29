/**
 * Load a VFS image from bytes or a URL, handling `.vfs` (plain) and
 * `.vfs.zst` (zstd-compressed) transparently.
 *
 * Why zstd is done here rather than via `Content-Encoding: zstd` on
 * the HTTP server: we cannot rely on every consumer's server to
 * negotiate zstd correctly (Vite dev server, GitHub's raw asset
 * download, Node `fetch`, browser environments that lag the spec).
 * fzstd is ~18KB minified and deterministic.
 */

import { decompress as zstdDecompress } from "fzstd";

import { MemoryFileSystem, type VfsImageOptions } from "./memory-fs";

/**
 * Decompress a `.vfs.zst` blob if needed and return raw VFS image bytes.
 * `.vfs` bytes pass through unchanged.
 *
 * Detection is by zstd magic (0x28B52FFD, little-endian) rather than
 * filename — the caller may be working from an ambiguous source.
 */
export function decompressVfsImage(buf: Uint8Array): Uint8Array {
  if (buf.byteLength >= 4) {
    // zstd magic is 0xFD2FB528 (LE); first 4 bytes 28 B5 2F FD.
    // The shift-and-OR sequence below produces a signed int32 because
    // the high byte's <<24 sign-extends; force `0xfd2fb528 | 0` the
    // same way so the comparison is signed↔signed.
    const magic = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
    if (magic === (0xfd2fb528 | 0)) {
      return zstdDecompress(buf);
    }
  }
  return buf;
}

/**
 * Load a VFS image from a URL, decompressing zstd if needed, and
 * instantiate a MemoryFileSystem.
 */
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
  const image = decompressVfsImage(buf);
  return MemoryFileSystem.fromImage(image, options);
}
