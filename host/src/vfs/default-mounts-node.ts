/**
 * Node-only resolver for {@link MountSpec}: lives in its own module so
 * the universal `default-mounts.ts` doesn't drag `node:fs` /
 * `node:path` / `HostFileSystem` into browser bundles.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MountConfig } from "./types";
import { MemoryFileSystem } from "./memory-fs";
import { HostFileSystem } from "./host-fs";
import {
  IMAGE_MEMFS_MAX_BYTES,
  normalizeLegacyRootfs,
  validateSpec,
  type MountSpec,
} from "./default-mounts";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

export interface ExtraMountScaffold {
  mountPoint: string;
}

function normalizeScaffoldPath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || !path.startsWith("/")) {
    throw new Error(`extra mount point must be absolute: ${path}`);
  }
  const normalized = path === "/" ? "/" : path.replace(/\/+$/, "");
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`extra mount point contains "${segment}" segment: ${path}`);
    }
  }
  return normalized || "/";
}

function ensureImageDir(fs: MemoryFileSystem, path: string): void {
  try {
    fs.mkdir(path, 0o755);
    return;
  } catch {
    const st = fs.stat(path);
    if ((st.mode & S_IFMT) !== S_IFDIR) {
      throw new Error(`extra mount scaffold exists but is not a directory: ${path}`);
    }
  }
}

/**
 * Create in-image directory placeholders for host-provided extra mounts.
 *
 * The mount router can route `/a/b/mount/file` directly to an extra backend,
 * but guest libc path traversal still probes parent components such as
 * `/a` and `/a/b` through the root image. These placeholders make nested
 * extra mounts reachable without requiring every published rootfs artifact
 * to predeclare every possible host mount parent.
 */
export function scaffoldExtraMountPoints(
  rootfs: MemoryFileSystem,
  extraMounts: readonly ExtraMountScaffold[] = [],
): void {
  for (const mount of extraMounts) {
    const mountPoint = normalizeScaffoldPath(mount.mountPoint);
    if (mountPoint === "/") continue;

    const parts = mountPoint.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      ensureImageDir(rootfs, current);
    }
  }
}

/**
 * Materialise `spec` for the Node host. Image mounts get a fresh
 * `MemoryFileSystem.fromImage(rootfsImage)`; scratch mounts get a
 * `HostFileSystem` rooted at `<sessionDir><spec.path>` (the directory
 * is created with `mkdirSync({recursive:true})` so `safePath` is
 * happy on first access).
 *
 * Pure function: input → output, no global state.
 */
export function resolveForNode(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
  sessionDir: string,
): MountConfig[] {
  validateSpec(spec);
  const out: MountConfig[] = [];
  for (const m of spec) {
    if (m.source === "image") {
      const backend = MemoryFileSystem.fromImage(rootfsImage, {
        maxByteLength: IMAGE_MEMFS_MAX_BYTES,
      });
      normalizeLegacyRootfs(backend);
      out.push({
        mountPoint: m.path,
        backend,
        readonly: m.readonly,
      });
    } else {
      const hostDir = join(sessionDir, m.path);
      mkdirSync(hostDir, { recursive: true, mode: m.mode });
      const backend = new HostFileSystem(hostDir);
      if (m.mode !== undefined) backend.chmod("/", m.mode);
      if (m.uid !== undefined || m.gid !== undefined) {
        backend.chown("/", m.uid ?? 0, m.gid ?? 0);
      }
      out.push({
        mountPoint: m.path,
        backend,
        readonly: m.readonly,
      });
    }
  }
  return out;
}
