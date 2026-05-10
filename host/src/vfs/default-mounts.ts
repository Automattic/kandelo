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

import type { MountConfig } from "./types";
import { MemoryFileSystem } from "./memory-fs";

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
export const IMAGE_MEMFS_MAX_BYTES = 1 * 1024 * 1024 * 1024;

/**
 * Default size for a browser scratch memfs SAB (16 MiB).
 *
 * 16 MiB is a generous baseline that accommodates real workloads we
 * already ship: SQLite WAL/journal under `/tmp`, MariaDB InnoDB log
 * spillover under `/var/log` and `/var/run`, nginx access/error logs,
 * and PHP session files under `/var/tmp`. The SAB is not pre-allocated
 * — `MemoryFileSystem` only writes used pages — so the wall-clock cost
 * of bumping from the prior 1 MiB is essentially free, while the prior
 * 1 MiB ceiling was already known to ENOSPC on the WordPress install
 * path (Task 4.3 implementer flagged this for cutover).
 *
 * Per-mount overrides can be supplied via `BrowserResolverOptions`
 * once a demo needs more than the default — none do today.
 */
export const BROWSER_SCRATCH_SAB_BYTES = 16 * 1024 * 1024;

export function validateSpec(spec: MountSpec[]): void {
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
 * Per-mount scratch SAB sizing. Defaults to {@link BROWSER_SCRATCH_SAB_BYTES}
 * for any mount not in the map.
 */
export interface BrowserResolverOptions {
  /** Mount path → initial SAB size in bytes. Overrides the default. */
  scratchSabBytes?: Record<string, number>;
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
  options: BrowserResolverOptions = {},
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
      const bytes = options.scratchSabBytes?.[m.path] ?? BROWSER_SCRATCH_SAB_BYTES;
      const sab = new SharedArrayBuffer(bytes);
      out.push({
        mountPoint: m.path,
        backend: MemoryFileSystem.create(sab),
        readonly: m.readonly,
      });
    }
  }
  return out;
}
