// Browser-environment resolver for the DEFAULT_MOUNT_SPEC.
//
// Both "image" and "scratch" resolve to MemFsBackend instances — the
// browser has no persistent host FS (OPFS is a future enhancement).
// "image" uses the loaded rootfs image with a mount prefix; "scratch"
// gets a fresh empty MemoryFileSystem sized for typical scratch use.

import type { Backend } from "../vfs/backends/backend-interface.ts";
import { MemFsBackend } from "../vfs/backends/memfs-backend";
import { MemoryFileSystem } from "../vfs/memory-fs";
import type { MountSpec } from "../vfs/default-mounts.ts";

export interface BrowserSession {
  rootfsImage: MemoryFileSystem | null;
  /** Default scratch SAB size (bytes). */
  scratchSize?: number;
}

export function createBrowserSession(
  rootfsBytes: ArrayBuffer | null,
  scratchSize = 1 * 1024 * 1024,
): BrowserSession {
  const rootfsImage = rootfsBytes
    ? MemoryFileSystem.fromImage(new Uint8Array(rootfsBytes))
    : null;
  return { rootfsImage, scratchSize };
}

export function resolveForBrowser(
  spec: MountSpec,
  session: BrowserSession,
): Backend {
  switch (spec.source) {
    case "image": {
      if (!session.rootfsImage) {
        throw new Error(
          `mount ${spec.path} requires the rootfs image but no image was loaded`,
        );
      }
      const prefix = spec.path === "/" ? "" : spec.path;
      return new MemFsBackend(session.rootfsImage, prefix);
    }
    case "scratch": {
      const sab = new SharedArrayBuffer(session.scratchSize ?? 1 * 1024 * 1024);
      const mfs = MemoryFileSystem.create(sab);
      return new MemFsBackend(mfs, "");
    }
  }
}
