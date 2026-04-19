/**
 * Shared helpers for building VFS images.
 *
 * Used by all build-*-vfs-image.ts scripts to write files, create directories,
 * walk host directories, and save images.
 */
import { readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

export function writeVfsFile(fs: MemoryFileSystem, path: string, content: string, mode = 0o644): void {
  const data = new TextEncoder().encode(content);
  const fd = fs.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
  fs.write(fd, data, 0, data.length);
  fs.close(fd);
}

export function writeVfsBinary(fs: MemoryFileSystem, path: string, data: Uint8Array, mode = 0o755): void {
  const fd = fs.open(path, 0o1101, mode);
  fs.write(fd, data, 0, data.length);
  fs.close(fd);
}

export function ensureDir(fs: MemoryFileSystem, path: string): void {
  try { fs.mkdir(path, 0o755); } catch { /* exists */ }
}

export function ensureDirRecursive(fs: MemoryFileSystem, path: string): void {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    ensureDir(fs, current);
  }
}

export function symlink(fs: MemoryFileSystem, target: string, path: string): void {
  try { fs.symlink(target, path); } catch { /* exists */ }
}

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
