import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hostBuildFingerprintBanner } from "./src/compiled-worker-entry";
import { browserVirtualModuleCapabilities } from "../apps/browser-demos/browser-module-contract.mjs";

const hostRoot = dirname(fileURLToPath(import.meta.url));

/**
 * The browser-only virtual modules this build must not try to resolve.
 *
 * `worker-entry-browser.ts` and `browser.ts` are entries here, and they import
 * specifiers like `@wasm-artifact-module32-wasm?url` whose bytes a Vite build
 * supplies outside the JavaScript graph. esbuild has no such resolver, so it
 * failed the entire `host/dist` build with `Could not resolve
 * "@wasm-artifact-module32-wasm?url"` -- which is why no `host/dist` has
 * existed since the TypeScript WebAssembly reader was deleted, and why every
 * Node process worker has been falling back to a temp-directory bundle of the
 * worker entry instead.
 *
 * Leaving them external is the honest description: these imports are satisfied
 * by the browser bundler, and the Node outputs that carry them are the browser
 * entries, which Node never loads.
 *
 * The list comes from `browser-module-contract.mjs`, the file Vite and the
 * browser input scanner already share, so a new virtual module cannot be added
 * in one place and forgotten here.
 */
const browserVirtualModules = Object.keys(browserVirtualModuleCapabilities)
  .flatMap((specifier) => [specifier, `${specifier}?url`]);

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/browser.ts",
    "src/worker-entry.ts",
    "src/worker-entry-browser.ts",
    "src/node-kernel-worker-entry.ts",
    "src/worker-main.ts",
    "src/vfs/index.ts",
    "src/vfs/opfs-worker.ts",
    "src/networking/index.ts",
    "src/framebuffer/index.ts",
  ],
  // Vite-alias imports (`@kernel-wasm?url`, `@fork-module32-wasm?url`,
  // `@wasm-artifact-module32-wasm?url`, worker entries) name artifacts the
  // *consumer's* bundler resolves. esbuild cannot resolve them here and should
  // not try: the host package ships the import, the browser app supplies the
  // file. Leaving them unresolved is the contract, not a workaround -- without
  // this, adding one reachable `?url` import breaks `npm run build` entirely,
  // which is how the browser build came to be unbuildable.
  //
  // WHY ONE KEY: these two lists arrived from two different changes and were
  // merged by keeping both, as two `external:` properties on one object
  // literal. JavaScript keeps the LAST duplicate key, so the patterns silently
  // did nothing -- `?worker&url` imports, which no enumerated specifier covers,
  // were not externalized at all. Duplicate object keys are not a merge
  // resolution; they are a silent deletion of whichever one is written first.
  //
  // The named list and the patterns are both load-bearing and cover different
  // things: `browserVirtualModules` comes from the file Vite shares, so a new
  // virtual module cannot be added in one place and forgotten here, while the
  // patterns catch the suffix-shaped imports -- `?worker&url` above all -- that
  // are not virtual modules and so never appear in that list.
  external: [...browserVirtualModules, /\?url$/, /\?worker&url$/],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: false,
  banner: {
    js: hostBuildFingerprintBanner(hostRoot),
  },
  onSuccess: async () => {
    const outputDir = resolve(hostRoot, "dist/audio");
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(
      resolve(hostRoot, "src/audio/pcm-audio-worklet.js"),
      resolve(outputDir, "pcm-audio-worklet.js"),
    );
  },
});
