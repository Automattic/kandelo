/**
 * Declarative mount layout shared by Node and Browser hosts.
 *
 * The same `MountSpec[]` produces a `Promise<MountConfig[]>` via
 * per-environment resolvers — Node materialises scratch backends as host
 * directories under a session dir; the browser uses ephemeral memfs SABs.
 *
 * `readonly` is currently advisory: `VirtualPlatformIO` does not enforce it
 * on writes. The resolver still propagates the flag for backends and routers
 * that choose to enforce it.
 */

import type { MountConfig } from "./types";

/**
 * Scratch prefixes the in-kernel tmpfs (Phase 5) claims. MUST stay in exact
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
   * `image`   — asynchronously restore and authenticate the supplied image.
   * `scratch` — empty writable backend (host dir on Node, memfs in browser).
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
 * backend for a prefix the kernel serves — the cutover's "host stops owning
 * scratch" half. The in-kernel tmpfs is the unconditional authority for its
 * scratch prefixes (Phase 5 cutover), so this filtering is always applied.
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
}

/**
 * AN IMAGE MOUNT GETS NO HOST BACKEND, and this is where that stopped.
 *
 * `restoreVerifiedImageMounts` restored the `/` image into a
 * `MemoryFileSystem` — up to a gigabyte, once per boot — so two things could
 * happen: the mount could have a backend, and imported cohort seals could be
 * authenticated. Neither survives contact with what the mounts now are.
 *
 * All seventeen products declare exactly `/` from their image and `/tmp`
 * scratch. `/tmp` is one of the prefixes the in-kernel tmpfs owns, so
 * `filterMountSpecForKernelTmpfs` removes it, and the `/` mount is dropped
 * from the guest-facing `VirtualPlatformIO` because the kernel has been the
 * sole `/` authority since the Phase 5 cutover. The filesystem was built and
 * discarded.
 *
 * And the authentication moved to where it cannot be skipped:
 * `rootfs::load_image` verifies cohort seals itself, so the kernel checks the
 * container it is handed rather than trusting a check performed on a second
 * copy of it in the host.
 */
/**
 * Materialise `spec` for the browser host — which now means: check it, and
 * mount nothing.
 *
 * THE BROWSER HAS NO HOST FILESYSTEM TO MOUNT. An image mount is served by the
 * kernel, which has been the sole `/` authority since the Phase 5 cutover. A
 * scratch mount at one of the eight prefixes the in-kernel tmpfs owns is
 * removed by `filterMountSpecForKernelTmpfs` before this sees it. What is left
 * is a scratch mount at some OTHER path, and that is refused rather than
 * backed.
 *
 * **Why refused here and not on Node.** Node backs such a mount with a
 * `HostFileSystem` over a real session directory, and that is load-bearing:
 * session seed trees must land below a surviving scratch mount, which is why
 * `materializeSessionSeedTrees` insists on one and why the kernel's own
 * `rootfs.rs` names `/run/kandelo-run` as the canonical foreign mount. The
 * browser protocol carries no `sessionSeedTrees` field at all, so the facility
 * that justifies Node's branch cannot reach this one — and what backed it here
 * was a `MemoryFileSystem` over a `SharedArrayBuffer`, the last production use
 * of the filesystem lane V exists to delete.
 *
 * Refusing is the truthful answer rather than a gap: a caller asking the
 * browser for a scratch mount the kernel does not serve is asking for
 * something no part of this host can provide, and hearing so at resolve time
 * beats a mount that silently is not the one the kernel sees.
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
