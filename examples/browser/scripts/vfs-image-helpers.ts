/**
 * Build-script helpers for VFS images. Pure memfs operations are re-exported
 * from host/src/vfs/image-helpers.ts so demo runtime code can share them.
 * The Node-only helpers (host-disk walk, save-to-file) live here.
 */
import { readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
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
 * Save a MemoryFileSystem image to disk with size logging.
 */
export async function saveImage(fs: MemoryFileSystem, outFile: string): Promise<Uint8Array> {
  console.log("Saving VFS image...");
  const image = await fs.saveImage();

  const outDir = outFile.substring(0, outFile.lastIndexOf("/"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, image);

  const sizeMB = (image.byteLength / (1024 * 1024)).toFixed(1);
  console.log(`VFS image: ${sizeMB} MB`);
  console.log(`Written to: ${outFile}`);
  return image;
}
