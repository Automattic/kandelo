/**
 * Low-level VFS write utilities for populating the in-memory filesystem.
 *
 * These helpers wrap image-filesystem operations with convenient defaults and
 * are used by demo build scripts that construct VFS images.
 *
 * Typed against the STRUCTURAL interface, not against a class. `ensureDir`
 * below already takes `VfsImageFilesystem`, so naming a concrete filesystem
 * here was narrower than the thing it calls — and it named the one being
 * deleted.
 */
import type { VfsImageFilesystem } from "../../../../host/src/vfs/vfs-image-filesystem";
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
export function ensureDirs(fs: VfsImageFilesystem, paths: string[]): void {
  for (const path of paths) {
    ensureDir(fs, path);
  }
}
