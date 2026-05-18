/**
 * Build-script helpers for VFS images. Pure memfs operations are re-exported
 * from host/src/vfs/image-helpers.ts so demo runtime code can share them.
 * The Node-only helpers (host-disk walk, save-to-file) live here.
 */
import { readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { zstdCompressSync, constants as zlibConstants } from "node:zlib";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

export {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  symlink,
} from "../../../host/src/vfs/image-helpers";

import { writeVfsBinary, ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

export interface WalkOptions {
  exclude?: (relPath: string) => boolean;
}

/**
 * Walk a host directory and write all files into the VFS under mountPrefix.
 * Returns the number of files written.
 */
export function walkAndWrite(
  fs: MemoryFileSystem,
  rootDir: string,
  mountPrefix: string,
  opts?: WalkOptions,
): number {
  let count = 0;
  ensureDirRecursive(fs, mountPrefix);

  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(rootDir, full);
      const mountPath = mountPrefix + "/" + rel;

      try {
        const lstat = lstatSync(full);
        if (lstat.isSymbolicLink()) continue;
        if (lstat.isDirectory()) {
          if (opts?.exclude?.(rel)) continue;
          ensureDirRecursive(fs, mountPath);
          walk(full);
        } else if (lstat.isFile()) {
          if (opts?.exclude?.(rel)) continue;
          const data = readFileSync(full);
          writeVfsBinary(fs, mountPath, new Uint8Array(data), 0o644);
          count++;
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(rootDir);
  return count;
}

/**
 * Save a MemoryFileSystem image to disk as a zstd-compressed `.vfs.zst`
 * file. The empty regions of the SharedFS allocator compress to almost
 * nothing, so this typically shrinks images by 80–95%. The browser-side
 * loader (`MemoryFileSystem.fromImage`) detects the zstd magic and
 * decompresses on load.
 *
 * `outFile` must end in `.vfs.zst` to make the on-disk format obvious.
 */
export async function saveImage(fs: MemoryFileSystem, outFile: string): Promise<Uint8Array> {
  if (!outFile.endsWith(".vfs.zst")) {
    throw new Error(
      `saveImage outFile must end in .vfs.zst (got: ${outFile})`,
    );
  }

  console.log("Saving VFS image...");
  const image = await fs.saveImage();
  // Level 19 — slow build, smaller download. Decompression speed is
  // unaffected by compression level, so this is a one-sided trade.
  const compressed = zstdCompressSync(image, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
  });

  const outDir = outFile.substring(0, outFile.lastIndexOf("/"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, compressed);

  const rawMB = (image.byteLength / (1024 * 1024)).toFixed(1);
  const compMB = (compressed.byteLength / (1024 * 1024)).toFixed(1);
  const ratio = ((compressed.byteLength / image.byteLength) * 100).toFixed(1);
  console.log(`VFS image: ${rawMB} MB raw → ${compMB} MB zstd (${ratio}%)`);
  console.log(`Written to: ${outFile}`);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}
