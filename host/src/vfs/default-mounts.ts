/**
 * Declarative mount layout shared by Node and Browser hosts.
 *
 * The same `MountSpec[]` produces a `MountConfig[]` via per-environment
 * resolvers — Node materialises scratch backends as host directories
 * under a session dir; the browser uses ephemeral memfs SABs.
 *
 * `readonly` is currently advisory: `VirtualPlatformIO` does not
 * enforce it on writes today (PR 5/5 will wire enforcement). The
 * resolver still propagates the flag so backends and routers can opt
 * in once the policy lands.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MountConfig } from "./types";
import { MemoryFileSystem } from "./memory-fs";
import { HostFileSystem } from "./host-fs";

export interface MountSpec {
  /** Absolute VFS mount point (e.g., "/etc"). No trailing slash except "/". */
  path: string;
  /**
   * `image`   — back the mount with `MemoryFileSystem.fromImage(rootfsImage)`.
   * `scratch` — empty writable backend (host dir on Node, memfs in browser).
   */
  source: "image" | "scratch";
  /** Advisory until PR 5/5 enforces it on writes through `VirtualPlatformIO`. */
  readonly?: boolean;
  /** Documentation hint that the mount is wiped on kernel destroy. */
  ephemeral?: boolean;
}

/**
 * Canonical mount layout. Mirrors the top-level system directories
 * declared in `MANIFEST` (Task 3.3): `/` is the read-only rootfs image;
 * `/tmp`, `/var/*`, `/home/user`, `/root`, `/srv` are scratch.
 */
export const DEFAULT_MOUNT_SPEC: MountSpec[] = [
  { path: "/",          source: "image",   readonly: true  },
  { path: "/tmp",       source: "scratch", ephemeral: true },
  { path: "/var/tmp",   source: "scratch" },
  { path: "/var/log",   source: "scratch" },
  { path: "/var/run",   source: "scratch", ephemeral: true },
  { path: "/home/user", source: "scratch" },
  { path: "/root",      source: "scratch" },
  { path: "/srv",       source: "scratch" },
];

/** Default growth ceiling for the rootfs image-backed memfs (1 GiB). */
const IMAGE_MEMFS_MAX_BYTES = 1 * 1024 * 1024 * 1024;

/** Default size for a browser scratch memfs SAB (1 MiB). */
const BROWSER_SCRATCH_SAB_BYTES = 1 * 1024 * 1024;

function validateSpec(spec: MountSpec[]): void {
  const seen = new Set<string>();
  for (const m of spec) {
    if (typeof m.path !== "string" || m.path.length === 0) {
      throw new Error(`MountSpec: empty path`);
    }
    if (!m.path.startsWith("/")) {
      throw new Error(`MountSpec: path must be absolute: ${m.path}`);
    }
    if (m.path !== "/" && m.path.endsWith("/")) {
      throw new Error(`MountSpec: trailing slash on non-root path: ${m.path}`);
    }
    const segments = m.path.split("/");
    for (const seg of segments) {
      if (seg === "." || seg === "..") {
        throw new Error(`MountSpec: path contains "${seg}" segment: ${m.path}`);
      }
    }
    if (seen.has(m.path)) {
      throw new Error(`MountSpec: duplicate mount path: ${m.path}`);
    }
    seen.add(m.path);
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
      out.push({
        mountPoint: m.path,
        backend: MemoryFileSystem.fromImage(rootfsImage, {
          maxByteLength: IMAGE_MEMFS_MAX_BYTES,
        }),
        readonly: m.readonly,
      });
    } else {
      const hostDir = join(sessionDir, m.path);
      mkdirSync(hostDir, { recursive: true });
      out.push({
        mountPoint: m.path,
        backend: new HostFileSystem(hostDir),
        readonly: m.readonly,
      });
    }
  }
  return out;
}

/**
 * Materialise `spec` for the browser host. Image mounts get a fresh
 * `MemoryFileSystem.fromImage(rootfsImage)`; scratch mounts get an
 * empty `MemoryFileSystem` over a small SAB (the browser has no host
 * directory to bind to).
 *
 * Pure function: input → output, no global state.
 */
export function resolveForBrowser(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
): MountConfig[] {
  validateSpec(spec);
  const out: MountConfig[] = [];
  for (const m of spec) {
    if (m.source === "image") {
      out.push({
        mountPoint: m.path,
        backend: MemoryFileSystem.fromImage(rootfsImage, {
          maxByteLength: IMAGE_MEMFS_MAX_BYTES,
        }),
        readonly: m.readonly,
      });
    } else {
      const sab = new SharedArrayBuffer(BROWSER_SCRATCH_SAB_BYTES);
      out.push({
        mountPoint: m.path,
        backend: MemoryFileSystem.create(sab),
        readonly: m.readonly,
      });
    }
  }
  return out;
}
