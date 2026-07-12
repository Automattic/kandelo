/**
 * Low-level VFS write utilities for populating the in-memory filesystem.
 *
 * These helpers wrap MemoryFileSystem operations with convenient defaults
 * and are used by demo build scripts that construct VFS images.
 */
import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
export {
  writeVfsBinary,
  writeVfsFile,
} from "../../../../host/src/vfs/image-helpers";

/**
 * Create a directory, ignoring EEXIST errors.
 */
export function ensureDir(
  fs: MemoryFileSystem,
  path: string,
  mode = 0o755,
): void {
  try {
    fs.mkdir(path, mode);
  } catch {
    /* already exists */
  }
}

/**
 * Create multiple directories, ignoring EEXIST errors.
 */
export function ensureDirs(fs: MemoryFileSystem, paths: string[]): void {
  for (const path of paths) {
    ensureDir(fs, path);
  }
}

/**
 * Recursively ensure all components of a path exist as directories.
 * E.g. ensureDirRecursive(fs, "/a/b/c") creates /a, /a/b, /a/b/c.
 */
export function ensureDirRecursive(
  fs: MemoryFileSystem,
  path: string,
  mode = 0o755,
): void {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    ensureDir(fs, current, mode);
  }
}
