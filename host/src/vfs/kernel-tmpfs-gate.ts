/**
 * Single source of truth for whether the in-kernel tmpfs (Phase 5) owns the
 * scratch mounts (`/tmp`, `/var/*`, `/root`, `/srv`, `/home/maker`).
 *
 * When enabled, two things must move together so there is exactly one authority
 * for scratch paths:
 *   1. The kernel is told to serve scratch prefixes (`kernel_set_tmpfs_enabled`,
 *      see `kernel-worker.ts`).
 *   2. The host stops materialising scratch backends — the resolvers drop the
 *      `source: "scratch"` mounts so no host `MemoryFileSystem`/`HostFileSystem`
 *      shadows or double-authorities the kernel tree.
 *
 * Both hosts read `kernel.wasm`, so the kernel-side behaviour is identical by
 * construction; this gate only governs the host-side mount materialisation and
 * the boot-time enable call, which are per-host.
 *
 * Default is OFF during bring-up: the host keeps owning scratch mounts until the
 * cutover is validated (WordPress Chromium boot + host Vitest + native cargo
 * test). Enable for validation with `WASM_POSIX_TMPFS=1` (Node) or
 * `globalThis.__WASM_POSIX_TMPFS__ = true` (browser); the kill-switch values
 * (`WASM_POSIX_TMPFS=0` / `__WASM_POSIX_TMPFS__ = false`) force it off even after
 * the default flips.
 */
/**
 * Scratch prefixes the in-kernel tmpfs claims. MUST stay in exact sync with the
 * `SCRATCH_MOUNTS` table in `crates/runtime-core/src/tmpfs.rs`; a mount whose
 * path is one of these is served entirely by the kernel when tmpfs is enabled,
 * so the host must not also materialise a backend for it (that would be a second
 * authority the kernel never consults). A scratch mount at any other path (e.g.
 * `/run`) stays host-backed on both sides of the cutover.
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
export function kernelTmpfsOwnsMountPath(mountPath: string): boolean {
  return KERNEL_TMPFS_OWNED_PREFIXES.includes(mountPath);
}

export function kernelTmpfsScratchEnabled(): boolean {
  if (
    typeof process !== "undefined" &&
    process.env?.WASM_POSIX_TMPFS !== undefined
  ) {
    return process.env.WASM_POSIX_TMPFS !== "0";
  }
  if (typeof globalThis !== "undefined") {
    const flag = (globalThis as { __WASM_POSIX_TMPFS__?: boolean })
      .__WASM_POSIX_TMPFS__;
    if (flag !== undefined) return flag === true;
  }
  // Bring-up default: host still owns scratch mounts. Flip to `true` at cutover.
  return false;
}
