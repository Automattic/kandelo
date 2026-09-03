/**
 * Packaged replacement for the host runtime's
 * `browser-kernel-default-artifacts` module.
 *
 * In the repository that module resolves `@kernel-wasm` / `@rootfs-vfs` — Vite
 * aliases that point at the demo build's artifacts. `@kandelo/web` ships no
 * Wasm, so there is no default kernel or rootfs to hand out. The package build
 * (see `tsdown.config.ts`) aliases the module here.
 *
 * Reaching this code means a caller booted without supplying bytes. That is a
 * real misconfiguration, so it fails with an actionable message instead of
 * fetching an empty URL. Obtain the bytes from a binaries release with
 * {@link fetchKandeloBinaries} and pass them to `boot()` / `initFromImage()`.
 */
function unavailable(what: string): never {
  throw new Error(
    `@kandelo/web ships no ${what}. Fetch ABI-matched binaries with ` +
      `fetchKandeloBinaries() and pass them explicitly, e.g. ` +
      `kernel.boot({ kernelWasm, vfsImage }).`,
  );
}

export const browserKernelDefaultArtifactUrls = {
  get kernelWasm(): string {
    return unavailable("kernel wasm");
  },
  get rootfsVfs(): string {
    return unavailable("rootfs.vfs image");
  },
};
