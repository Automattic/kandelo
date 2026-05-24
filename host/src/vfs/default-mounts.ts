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
  /** Directory mode for scratch mount roots. Mirrors MANIFEST for defaults. */
  mode?: number;
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
  { path: "/tmp",       source: "scratch", mode: 0o1777, ephemeral: true },
  { path: "/var/tmp",   source: "scratch", mode: 0o1777 },
  { path: "/var/log",   source: "scratch", mode: 0o755 },
  { path: "/var/run",   source: "scratch", mode: 0o755, ephemeral: true },
  { path: "/home/user", source: "scratch", mode: 0o755 },
  { path: "/root",      source: "scratch", mode: 0o700 },
  { path: "/srv",       source: "scratch", mode: 0o755 },
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

function readTextFile(fs: MemoryFileSystem, path: string): string | null {
  let fd: number | null = null;
  try {
    const st = fs.stat(path);
    fd = fs.open(path, 0, 0);
    const bytes = new Uint8Array(st.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = fs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return new TextDecoder().decode(bytes.subarray(0, offset));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.close(fd); } catch {}
    }
  }
}

function writeTextFile(fs: MemoryFileSystem, path: string, text: string): void {
  const bytes = new TextEncoder().encode(text);
  const fd = fs.open(path, 0o1101, 0o644); // O_WRONLY | O_CREAT | O_TRUNC
  try {
    if (bytes.byteLength > 0) fs.write(fd, bytes, null, bytes.byteLength);
  } finally {
    fs.close(fd);
  }
}

export function normalizeLegacyRootfs(fs: MemoryFileSystem): void {
  // Compatibility for already-published dinit demo images that contain a
  // nobody user but not the matching nobody group. php-fpm validates
  // `group = nobody` during pool startup and exits EX_CONFIG (78) without it.
  const group = readTextFile(fs, "/etc/group");
  if (group !== null && !/^nobody:/m.test(group)) {
    writeTextFile(fs, "/etc/group", `${group.replace(/\n?$/, "\n")}nobody:x:65534:\n`);
  }
}

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
      const bytes = options.scratchSabBytes?.[m.path] ?? BROWSER_SCRATCH_SAB_BYTES;
      const sab = new SharedArrayBuffer(bytes);
      const backend = MemoryFileSystem.create(sab);
      if (m.mode !== undefined) backend.chmod("/", m.mode);
      out.push({
        mountPoint: m.path,
        backend,
        readonly: m.readonly,
      });
    }
  }
  return out;
}
