/**
 * Shared shell-binary metadata for the browser UI and labs.
 *
 * The former `populateShellBinaries()` helper wrote binaries into a running
 * kernel via the legacy main-thread `kernel.fs`; it was removed with that API.
 * Demos now bake binaries into a build-time image (see
 * `lib/kernel-owned-boot.ts`) before the kernel worker takes ownership.
 */
export { COREUTILS_NAMES } from "../../../../images/vfs/lib/init/shell-binaries";
