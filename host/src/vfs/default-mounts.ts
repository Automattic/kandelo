// Default mount spec — a declarative list of the VFS mount points every
// wasm-posix kernel session provides, independent of which environment
// (Node, browser, etc.) is hosting the kernel. Environments differ only
// in how they *resolve* each spec entry into a Backend.
//
// Tests and embedders can clone DEFAULT_MOUNT_SPEC and mutate entries
// (e.g., point /tmp at a specific host dir, or swap scratch → image for
// hermetic runs) before passing to buildMountTable().

import type { Backend } from "./backends/backend-interface.ts";
import { MountTable } from "./mount-table.ts";

/**
 * Semantic "where does this mount's content live" — the resolver turns
 * this into an actual Backend. Keeping it abstract means the spec stays
 * environment-neutral.
 *
 *   "image"   — image-backed. Served by a MemFsBackend over the rootfs
 *               VFS image, with a prefix matching the mount point.
 *   "scratch" — ephemeral scratch space. Node resolves to HostDirBackend
 *               on a session dir; browser resolves to an empty MemFsBackend.
 */
export type MountSource = "image" | "scratch";

export interface MountSpec {
  /** VFS mount point (absolute, no trailing slash except for "/"). */
  path: string;
  source: MountSource;
  /** Hint for future permission enforcement; no behavior change in this PR. */
  readonly?: boolean;
  /** Hint that content may be wiped on kernel destroy. */
  ephemeral?: boolean;
}

export const DEFAULT_MOUNT_SPEC: ReadonlyArray<MountSpec> = [
  // Image-backed root. Everything in the rootfs image (declared in
  // MANIFEST, source under rootfs/) is served through this mount at its
  // natural path — /bin/sh, /etc/passwd, /sbin, /usr/bin, etc. The
  // scratch mounts below override more-specific prefixes by longest-
  // prefix match: e.g., /tmp/foo lands on the scratch HostDirBackend
  // even though the image declares an empty /tmp dir.
  { path: "/",          source: "image",   readonly: true  },

  // Scratch mounts. Each provides a place for programs to write without
  // touching either the image or the unrelated host filesystem.
  { path: "/tmp",       source: "scratch", ephemeral: true },
  { path: "/var/tmp",   source: "scratch" },
  { path: "/home/user", source: "scratch" },
  { path: "/var/log",   source: "scratch" },
  { path: "/var/run",   source: "scratch", ephemeral: true },
  { path: "/root",      source: "scratch" },
  { path: "/srv",       source: "scratch" },
  // /dev/shm: musl's shm_open / sem_open create files here. The kernel's
  // devfs handles the bare /dev/shm dir for stat/getdents, but per-name
  // entries below it route through this mount. Ephemeral by POSIX
  // semantics — shared memory segments don't survive process exit.
  { path: "/dev/shm",   source: "scratch", ephemeral: true },
];

/**
 * Assemble a MountTable from a spec + a resolver that knows how to turn
 * each spec entry into a Backend. The resolver holds environment-specific
 * state (rootfs image bytes, session scratch dir path, etc.).
 */
export function buildMountTable(
  spec: ReadonlyArray<MountSpec>,
  resolve: (spec: MountSpec) => Backend,
): MountTable {
  const table = new MountTable();
  for (const s of spec) {
    table.register(s.path, resolve(s));
  }
  return table;
}
