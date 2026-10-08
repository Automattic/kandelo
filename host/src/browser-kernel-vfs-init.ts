import type { MountConfig } from "./vfs/types";
import {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
  type MountSpec,
} from "./vfs/default-mounts";

/**
 * Resolve the browser worker's mount table for a root image.
 *
 * The kernel parses and verifies the image itself (`rootfs::load_image`); this
 * step only checks the mount spec (the image may be mounted only at `/`, and
 * every scratch mount must be one the in-kernel tmpfs serves). It is a small,
 * artifact-free module so browser tests can exercise the same pre-ready
 * boundary the worker uses without importing the worker's kernel graph.
 */
export function restoreBrowserKernelInitMounts(
  vfsImage: Uint8Array,
  rootfsMountSpec: readonly MountSpec[] = DEFAULT_MOUNT_SPEC,
): Promise<MountConfig[]> {
  // WHY: keep one callable boundary shared by production worker init and its
  // browser test, so a fixture cannot pass while the worker bypasses it.
  return resolveForBrowser([...rootfsMountSpec], vfsImage);
}
