/**
 * Packaged worker-entry URLs for `@kandelo/web`.
 *
 * The package build (see `tsdown.config.ts`) aliases the host runtime's
 * `browser-kernel-assets` module to this file. It resolves the two entries the
 * package actually ships against the published `dist/` via
 * `new URL(..., import.meta.url)`. rolldown leaves those expressions intact
 * (the targets do not exist next to the source at build time); the consuming
 * bundler rewrites them to the correct hashed worker URLs, and serves them
 * as-is in dev.
 *
 * Layout these resolve against, relative to `dist/index.js`:
 *   dist/worker-entry-browser.js          (per-process worker entry)
 *   dist/browser-kernel-worker-entry.js   (dedicated kernel worker entry)
 *
 * The kernel wasm and rootfs image are not here and are not shipped; see
 * `default-artifacts-unbundled.ts` and `fetch-binaries.ts`.
 */
import type { BrowserKernelAssets } from "../../../host/src/browser-kernel-host";

export type { BrowserKernelAssets };

export const BROWSER_KERNEL_ASSETS: BrowserKernelAssets = {
  processWorkerUrl: new URL("./worker-entry-browser.js", import.meta.url).href,
  kernelWorkerUrl: new URL("./browser-kernel-worker-entry.js", import.meta.url).href,
};
