/**
 * Declarative mount layout shared by Node and Browser hosts.
 *
 * The same `MountSpec[]` produces a `Promise<MountConfig[]>` via
 * per-environment resolvers. The kernel serves the `/` image and the scratch
 * prefixes the in-kernel tmpfs owns on both hosts, so the resolvers return only
 * the host-backed mounts that remain: on Node, a scratch mount at any other
 * path becomes a host directory under the session dir; the browser has none.
 *
 * `readonly` is currently advisory: `VirtualPlatformIO` does not enforce it
 * on writes. The resolver still propagates the flag for backends and routers
 * that choose to enforce it.
 */

import type { MountConfig } from "./types";

/**
 * Scratch prefixes the in-kernel tmpfs claims. MUST stay in exact
 * sync with the `SCRATCH_MOUNTS` table in `crates/runtime-core/src/tmpfs.rs`; a
 * mount whose path is one of these is served entirely by the kernel, so the
 * host must not also materialise a backend for it (that would be a second
 * authority the kernel never consults). A scratch mount at any other path (e.g.
 * `/run`) stays host-backed.
 */
export const KERNEL_TMPFS_OWNED_PREFIXES: readonly string[] = [
  "/tmp",
  "/var/tmp",
  "/var/log",
  "/var/run",
  "/home/maker",
  "/root",
  "/srv",
];

/** True when the in-kernel tmpfs owns `mountPath` exactly (a scratch prefix). */
function kernelTmpfsOwnsMountPath(mountPath: string): boolean {
  return KERNEL_TMPFS_OWNED_PREFIXES.includes(mountPath);
}

export interface MountSpec {
  /** Absolute VFS mount point (e.g., "/etc"). No trailing slash except "/". */
  path: string;
  /**
   * `image`   — the supplied VFS image, which the kernel loads as `/` (the
   *             only path an image mount may name).
   * `scratch` — empty writable filesystem: the in-kernel tmpfs for its
   *             prefixes, a host directory on Node elsewhere.
   */
  source: "image" | "scratch";
  /** Advisory mount intent; the ordinary image-backed root remains writable. */
  readonly?: boolean;
  /** Ignore set-ID mode bits. Omission preserves normal set-ID semantics. */
  nosuid?: boolean;
  /** Directory mode for scratch mount roots. Mirrors MANIFEST for defaults. */
  mode?: number;
  /** Virtual owner for scratch mount roots. Defaults to root. */
  uid?: number;
  /** Virtual group for scratch mount roots. Defaults to root. */
  gid?: number;
  /** Documentation hint that the mount is wiped on kernel destroy. */
  ephemeral?: boolean;
}

/**
 * Canonical mount layout. Mirrors the top-level system directories declared
 * in `MANIFEST`: `/` is the writable rootfs image; `/tmp`, `/var/*`,
 * `/home/maker`, `/root`, and `/srv` are scratch mounts.
 */
export const DEFAULT_MOUNT_SPEC: MountSpec[] = [
  { path: "/", source: "image", readonly: false },
  {
    path: "/tmp",
    source: "scratch",
    mode: 0o1777,
    ephemeral: true,
    nosuid: true,
  },
  { path: "/var/tmp", source: "scratch", mode: 0o1777, nosuid: true },
  { path: "/var/log", source: "scratch", mode: 0o755, nosuid: true },
  {
    path: "/var/run",
    source: "scratch",
    mode: 0o755,
    ephemeral: true,
    nosuid: true,
  },
  {
    path: "/home/maker",
    source: "scratch",
    mode: 0o755,
    uid: 1000,
    gid: 1000,
    nosuid: true,
  },
  {
    path: "/root",
    source: "scratch",
    mode: 0o700,
    uid: 0,
    gid: 0,
    nosuid: true,
  },
  { path: "/srv", source: "scratch", mode: 0o755, nosuid: true },
];

/**
 * Drop the scratch mounts the in-kernel tmpfs owns, so the host materialises no
 * backend for a prefix the kernel serves. The in-kernel tmpfs is the
 * unconditional authority for its scratch prefixes (its root modes, owners and
 * `nosuid` come from `SCRATCH_MOUNTS` in `crates/runtime-core/src/tmpfs.rs`,
 * not from the spec), so this filtering is always applied.
 * Image mounts, and host-owned scratch mounts outside tmpfs's prefixes (e.g.
 * `/run`), are preserved.
 */
export function filterMountSpecForKernelTmpfs(
  spec: readonly MountSpec[],
): MountSpec[] {
  return spec.filter(
    (m) => !(m.source === "scratch" && kernelTmpfsOwnsMountPath(m.path)),
  );
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
  assertOnlyRootImageMount(spec);
}

/**
 * The kernel builds exactly one filesystem from an image, and it is `/`.
 *
 * An image mount anywhere else would get no backend on either host (neither
 * host restores images into a filesystem of its own any more), so accepting
 * one would silently boot a machine without the tree the spec asked for.
 * Refusing it at validation time is the truthful answer.
 */
function assertOnlyRootImageMount(spec: readonly MountSpec[]): void {
  for (const m of spec) {
    if (m.source === "image" && m.path !== "/") {
      throw new Error(
        `MountSpec: image mount at ${m.path} is not supported; the kernel `
          + `builds only "/" from the VFS image`,
      );
    }
  }
}

/**
 * Materialise `spec` for the browser host, which means: check it, and mount
 * nothing.
 *
 * The browser has no host filesystem to mount. The image mount is served by
 * the kernel, and a scratch mount at one of the prefixes the in-kernel tmpfs
 * owns is removed by `filterMountSpecForKernelTmpfs`. What is left is a
 * scratch mount at some other path, and that is refused rather than backed:
 * Node can back one with a session directory (session seed trees need it),
 * but the browser protocol has no such facility, and nothing on this host
 * could provide the mount. Hearing so at resolve time beats a mount that
 * silently is not the one the kernel sees.
 *
 * An image mount gets no host backend on either host. The kernel parses the
 * image itself and owns `/`; it also verifies any imported cohort seals in the
 * image when it loads it (`rootfs::load_image`), so the check runs on the bytes
 * the kernel actually uses rather than on a second copy restored in the host.
 */
export function resolveForBrowser(
  spec: MountSpec[],
  rootfsImage: Uint8Array,
): Promise<MountConfig[]> {
  validateSpec(spec);
  return resolveValidatedForBrowser(spec, rootfsImage);
}

async function resolveValidatedForBrowser(
  spec: MountSpec[],
  _rootfsImage: Uint8Array,
): Promise<MountConfig[]> {
  const effective = filterMountSpecForKernelTmpfs(spec);
  for (const m of effective) {
    if (m.source === "image") continue;
    throw new Error(
      `browser scratch mount ${m.path} has no backend: the in-kernel tmpfs `
        + `serves ${KERNEL_TMPFS_OWNED_PREFIXES.join(", ")}, and the browser `
        + `host has no filesystem of its own to mount anywhere else`,
    );
  }
  return [];
}
