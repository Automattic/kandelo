import type { MountConfig } from "./vfs/types";
import {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
  type MountSpec,
} from "./vfs/default-mounts";
import type { OpfsMountInit } from "./browser-kernel-protocol";

export interface BrowserKernelInitMountOptions {
  /**
   * Browser-storage-backed mounts requested by the boot. Each entry extends
   * the canonical spec with an `opfs` mount whose proxy channel the main
   * thread already initialized for the named workspace.
   */
  opfsMounts?: readonly OpfsMountInit[];
}

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
  options: BrowserKernelInitMountOptions = {},
): Promise<MountConfig[]> {
  // WHY: keep one callable boundary shared by production worker init and the
  // three-engine trust test. Reimplementing only the seal check in a fixture
  // could pass while the real worker accidentally bypassed it.
  const opfsMounts = options.opfsMounts ?? [];
  const spec: MountSpec[] = [
    ...rootfsMountSpec,
    ...opfsMounts.map((m) => ({
      path: m.path,
      source: "opfs" as const,
      opfsName: m.name,
      // A workspace is guest-writable storage, so like every scratch mount
      // it must not grant set-ID credentials on exec.
      nosuid: true,
    })),
  ];
  const opfsChannels = Object.fromEntries(
    opfsMounts.map((m) => [m.path, m.channelSab]),
  );
  return resolveForBrowser(spec, vfsImage, { opfsChannels });
}
