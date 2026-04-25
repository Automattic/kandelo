// Node-environment resolver for the DEFAULT_MOUNT_SPEC.
//
// "image" → MemFsBackend over the rootfs VFS image with a prefix matching
//           the mount point. Multiple image mounts share the same
//           MemoryFileSystem; they differ only in their prefix.
// "scratch" → HostDirBackend on <sessionDir>/<mount-path>. The session
//           dir lives under os.tmpdir(), cleaned up on kernel destroy.

import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Backend } from "../vfs/backends/backend-interface.ts";
import { MemFsBackend } from "../vfs/backends/memfs-backend";
import { HostDirBackend } from "../vfs/backends/host-dir-backend";
import { MemoryFileSystem } from "../vfs/memory-fs";
import type { MountSpec } from "../vfs/default-mounts.ts";

export interface NodeSession {
  rootfsImage: MemoryFileSystem | null;
  scratchDir: string;
}

/**
 * Set up the per-session host-side state needed for mount resolution.
 * Creates a fresh scratch dir and loads the rootfs image into a
 * MemoryFileSystem (or returns null if no image was supplied).
 */
export function createNodeSession(rootfsBytes: ArrayBuffer | null): NodeSession {
  const scratchDir = mkdtempSync(join(tmpdir(), "wasm-kernel-session-"));
  const rootfsImage = rootfsBytes
    ? MemoryFileSystem.fromImage(new Uint8Array(rootfsBytes))
    : null;
  return { rootfsImage, scratchDir };
}

/** Drop the session's scratch dir. Safe to call on a destroyed kernel. */
export function destroyNodeSession(session: NodeSession): void {
  rmSync(session.scratchDir, { recursive: true, force: true });
}

export function resolveForNode(
  spec: MountSpec,
  session: NodeSession,
): Backend {
  switch (spec.source) {
    case "image": {
      if (!session.rootfsImage) {
        throw new Error(
          `mount ${spec.path} requires the rootfs image but no image was loaded`,
        );
      }
      // Image paths live at their natural VFS position inside the image.
      // For a root mount (/), prefix = "" (the MFS is accessed with
      // absolute paths verbatim). For a sub-tree mount like /etc,
      // prefix = /etc so sub-path /passwd resolves to /etc/passwd in
      // the MFS.
      const prefix = spec.path === "/" ? "" : spec.path;
      return new MemFsBackend(session.rootfsImage, prefix);
    }
    case "scratch": {
      const hostRoot = join(session.scratchDir, spec.path);
      mkdirSync(hostRoot, { recursive: true });
      return new HostDirBackend(hostRoot);
    }
  }
}
