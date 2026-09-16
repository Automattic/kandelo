import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
import {
  ensureDirRecursive,
  symlink,
} from "../../../host/src/vfs/image-helpers";

/**
 * Install a symlink whose namespace belongs to a derived VFS image.
 *
 * A minimal base image is not required to carry optional directory skeletons.
 * The derived image therefore creates the complete parent path it owns while
 * retaining the strict shared symlink helper for collisions and real errors.
 */
export function symlinkWithParentDirectories(
  fs: VfsImageFilesystem,
  target: string,
  path: string,
): void {
  const separator = path.lastIndexOf("/");
  const parent = separator <= 0 ? "/" : path.slice(0, separator);
  ensureDirRecursive(fs, parent);
  symlink(fs, target, path);
}
