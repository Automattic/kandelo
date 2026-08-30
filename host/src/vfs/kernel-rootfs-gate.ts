/**
 * Single source of truth for whether the in-kernel rootfs overlay (Phase 5
 * Increment 2) owns the root filesystem `/`.
 *
 * When enabled, two things move together so there is exactly one authority for
 * `/` paths:
 *   1. The kernel is handed the `/` tree as a boot manifest and told to serve it
 *      (`kernel_rootfs_load_manifest` + `kernel_set_rootfs_enabled`, see
 *      `kernel-worker.ts`), with a byte provider installed for base-file content.
 *   2. The host demotes its `/` image `MemoryFileSystem` from mount authority to
 *      a byte-leaf provider (kept alive for `blob_read`, no longer resolving
 *      metadata), so it never double-authorities the kernel tree.
 *
 * Both hosts read `kernel.wasm`, so the kernel-side behaviour is identical by
 * construction; this gate governs the host-side manifest build, provider wiring,
 * and boot-time enable, which are per-host.
 *
 * Default is OFF: the overlay is fully built and unit-tested but not yet the
 * authority for `/` (the syscall wiring and cutover land in later increments).
 * Opt IN with `WASM_POSIX_ROOTFS=1` (Node) or
 * `globalThis.__WASM_POSIX_ROOTFS__ = true` (browser).
 */
export function kernelRootfsEnabled(): boolean {
  if (
    typeof process !== "undefined" &&
    process.env?.WASM_POSIX_ROOTFS !== undefined
  ) {
    return process.env.WASM_POSIX_ROOTFS === "1";
  }
  if (typeof globalThis !== "undefined") {
    const flag = (globalThis as { __WASM_POSIX_ROOTFS__?: boolean })
      .__WASM_POSIX_ROOTFS__;
    if (flag !== undefined) return flag === true;
  }
  // Default OFF until the syscall wiring + cutover increments land.
  return false;
}
