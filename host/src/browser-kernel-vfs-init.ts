import type { MountConfig } from "./vfs/types";
import {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
  type MountSpec,
} from "./vfs/default-mounts";

/**
 * Restore the browser worker's root image and construct its canonical mounts.
 *
 * This is intentionally a small, artifact-free module so browser tests can
 * exercise the exact pre-ready VFS trust boundary without importing the
 * worker's kernel and demo-binary graph.
 */
export function restoreBrowserKernelInitMounts(
  vfsImage: Uint8Array,
  rootfsMountSpec: readonly MountSpec[] = DEFAULT_MOUNT_SPEC,
): Promise<MountConfig[]> {
  // WHY: keep one callable boundary shared by production worker init and the
  // three-engine trust test. Reimplementing only the seal check in a fixture
  // could pass while the real worker accidentally bypassed it.
  return resolveForBrowser([...rootfsMountSpec], vfsImage);
}
