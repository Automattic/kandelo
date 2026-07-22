/**
 * Low-level VFS write utilities for populating the in-memory filesystem.
 *
 * These helpers wrap MemoryFileSystem operations with convenient defaults
 * and are used by demo build scripts that construct VFS images.
 */
import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
export {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../host/src/vfs/image-helpers";
import { ensureDir } from "../../../../host/src/vfs/image-helpers";

/**
 * Create multiple directories, ignoring EEXIST errors.
 */
export function ensureDirs(fs: MemoryFileSystem, paths: string[]): void {
  for (const path of paths) {
    ensureDir(fs, path);
  }
}
