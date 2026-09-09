/**
 * Worker-entry URLs for {@link BrowserKernel}.
 *
 * `BrowserKernel` spawns two `{ type: "module" }` workers, and Vite's
 * `?worker&url` import analysis is the only thing that resolves their entry
 * points. Isolating both specifiers here keeps `browser-kernel-host.ts` plain
 * TypeScript that any bundler can process.
 *
 * The kernel wasm and rootfs image are NOT here. They are default *product*
 * artifacts, loaded lazily by `browser-kernel-default-artifacts.ts` only when a
 * caller boots without explicit bytes.
 *
 * Consumption modes:
 *
 *  - **Source (apps/browser-demos):** imported as-is; Vite resolves both worker
 *    entries from the repository tree.
 *
 *  - **Packaged (`@kandelo/web`):** the package build aliases this module to
 *    `web-libs/kandelo-web/src/assets-bundled.ts`, which resolves the same two
 *    entries against the shipped `dist/` via `new URL(..., import.meta.url)`.
 *    BrowserKernel never imports the `?worker&url` specifiers directly, so the
 *    consuming bundler never sees them.
 *
 * Either way {@link BrowserKernel} reads only {@link BROWSER_KERNEL_ASSETS},
 * and both URLs are overridable per instance via `BrowserKernelOptions.assets`.
 */
import processWorkerUrl from "./worker-entry-browser.ts?worker&url";
import kernelWorkerUrl from "./browser-kernel-worker-entry.ts?worker&url";
import type { BrowserKernelAssets } from "./browser-kernel-host";

export const BROWSER_KERNEL_ASSETS: BrowserKernelAssets = {
  processWorkerUrl,
  kernelWorkerUrl,
};
