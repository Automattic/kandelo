// MountTable — maps VFS path prefixes to backends. Longest-prefix wins;
// unmounted paths return null (caller raises ENOENT).
//
// Paths handed in and out are absolute, already normalized (no `..`, no
// doubled slashes). The kernel's path resolver normalizes before calling
// into host, so mount resolution assumes normalized input.

import type { Backend } from "./backends/backend-interface.ts";

export interface MountEntry {
  /** Normalized absolute mount point (e.g. "/etc", no trailing slash except for "/"). */
  mount: string;
  backend: Backend;
}

export interface Resolution {
  entry: MountEntry;
  /** Index into the registered-order mount list; used by MountRouter to tag handles. */
  backendIndex: number;
  /** Path as seen by the backend — the caller's path with the mount prefix stripped. */
  subPath: string;
}

export class MountTable {
  private mounts: MountEntry[] = [];

  /**
   * Register a mount. Mount paths are normalized: trailing slashes are
   * stripped (except for "/"). Registration order determines backend
   * index, which MountRouter uses for handle tagging — stable across
   * later registrations is not guaranteed if a caller registers new
   * mounts mid-run, so treat the set as constructed-once.
   */
  register(mount: string, backend: Backend): void {
    const normalized = normalizeMount(mount);
    for (const existing of this.mounts) {
      if (existing.mount === normalized) {
        throw new Error(`mount already registered at ${normalized}`);
      }
    }
    this.mounts.push({ mount: normalized, backend });
  }

  /**
   * Resolve a path to (entry, backendIndex, subPath). Returns null if
   * no mount covers the path — caller converts to ENOENT.
   *
   * Longest-prefix semantics: if /usr/local/bin and /usr/local are both
   * mounted, a path under /usr/local/bin picks that one.
   */
  resolve(path: string): Resolution | null {
    let bestIdx = -1;
    let bestLen = -1;
    for (let i = 0; i < this.mounts.length; i++) {
      const m = this.mounts[i].mount;
      if (coversPath(m, path) && m.length > bestLen) {
        bestIdx = i;
        bestLen = m.length;
      }
    }
    if (bestIdx < 0) return null;
    const entry = this.mounts[bestIdx];
    const subPath = stripMountPrefix(entry.mount, path);
    return { entry, backendIndex: bestIdx, subPath };
  }

  /** Snapshot the registered mounts in registration order. */
  snapshot(): ReadonlyArray<MountEntry> {
    return this.mounts.slice();
  }
}

function normalizeMount(mount: string): string {
  if (!mount.startsWith("/")) {
    throw new Error(`mount point must be absolute: ${mount}`);
  }
  if (mount === "/") return "/";
  // Strip trailing slashes, collapse internal //
  let normalized = mount.replace(/\/+$/, "");
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized === "") normalized = "/";
  return normalized;
}

/**
 * Does `mount` cover `path`? Exact match or prefix-with-separator.
 * Prefix-only (e.g. "/etc" vs "/etcetera") does NOT cover.
 */
function coversPath(mount: string, path: string): boolean {
  if (mount === "/") return true;
  if (path === mount) return true;
  return path.startsWith(mount + "/");
}

/**
 * Strip the mount prefix to produce the sub-path the backend sees.
 * Root-mount preserves the path as-is. Exact match returns "/".
 */
function stripMountPrefix(mount: string, path: string): string {
  if (mount === "/") return path;
  if (path === mount) return "/";
  return path.slice(mount.length); // already starts with "/"
}
