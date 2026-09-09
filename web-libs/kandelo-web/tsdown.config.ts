import { defineConfig } from "tsdown";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const HOST_SRC = path.resolve(import.meta.dirname, "../../host/src");
const ASSETS_BUNDLED = path.resolve(import.meta.dirname, "src/assets-bundled.ts");
const DEFAULT_ARTIFACTS = path.resolve(
  import.meta.dirname,
  "src/default-artifacts-unbundled.ts",
);

/**
 * Rolldown plugin: swap the two host-runtime modules that only Vite can resolve.
 *
 *  - `browser-kernel-assets` (`?worker&url` imports) → `assets-bundled.ts`,
 *    which resolves the shipped worker entries via
 *    `new URL(..., import.meta.url)`. This is what lets BrowserKernel run in a
 *    plain Vite consumer with no `?worker&url` aliases.
 *  - `browser-kernel-default-artifacts` (`@kernel-wasm` / `@rootfs-vfs`) →
 *    `default-artifacts-unbundled.ts`. The package ships no Wasm, so those
 *    aliases have nothing to point at; the replacement throws an actionable
 *    error instead.
 *
 * The swap does not reach the `.d.ts` type graph: `rolldown-plugin-dts`
 * disk-resolves `browser-kernel-assets` into it (via the `BROWSER_KERNEL_ASSETS`
 * value imports), and there the raw module's `?worker&url` imports are
 * unloadable — the `load` shim feeds those ids an empty string module. tsc
 * drops the imports from the emitted declarations, and the swap keeps them
 * out of the JS output entirely.
 */
const swapViteCoupledModules = {
  name: "kandelo-swap-vite-coupled-modules",
  resolveId(source: string) {
    if (/browser-kernel-assets$/.test(source)) return ASSETS_BUNDLED;
    if (/browser-kernel-default-artifacts$/.test(source)) {
      return DEFAULT_ARTIFACTS;
    }
    return null;
  },
  load(id: string) {
    if (!id.endsWith("?worker&url")) return null;
    return 'export default "";';
  },
};

// One config per entry: rolldown splits modules shared between entries into
// chunks, but each worker entry must stay a single self-contained file so a
// consumer's bundler can copy it as a plain `new URL(...)` asset. For the same
// reason `codeSplitting: false` folds dynamic imports into the entry file.
const entryConfig = {
  format: "esm" as const,
  platform: "browser" as const,
  target: "es2022",
  sourcemap: true,
  outputOptions: { codeSplitting: false },
  plugins: [swapViteCoupledModules],
};

// The worker files are copied verbatim as `new URL(...)` assets, so a bare
// import ("fzstd") would be unresolvable at runtime: everything gets bundled
// in, and `deps.onlyImport` makes the build fail if any other import
// survives. "net" is the one exception — `kernel-worker.ts` lazily
// `await import("net")`s it on the Node-host TCP path, which a browser worker
// never executes. The index entry keeps `dependencies` external so the
// consumer dedupes one copy.
const workerConfig = {
  ...entryConfig,
  dts: false,
  deps: { alwaysBundle: [/./], onlyImport: ["net"] },
};

export default defineConfig([
  {
    ...entryConfig,
    entry: { index: "src/index.ts" },
    dts: true,
    // BrowserKernel's default PCM worklet URL resolves
    // `./audio/pcm-audio-worklet.js` against the bundle, so the package ships
    // the self-contained worklet at that path — same contract as the host
    // package's tsup onSuccess copy.
    onSuccess() {
      const outputDir = path.resolve(import.meta.dirname, "dist/audio");
      mkdirSync(outputDir, { recursive: true });
      copyFileSync(
        path.join(HOST_SRC, "audio/pcm-audio-worklet.js"),
        path.join(outputDir, "pcm-audio-worklet.js"),
      );
    },
  },
  // Worker entries emitted as their own self-contained files so BrowserKernel
  // can spawn them as module workers via the URLs in assets-bundled.ts.
  {
    ...workerConfig,
    entry: {
      "browser-kernel-worker-entry": path.join(
        HOST_SRC,
        "browser-kernel-worker-entry.ts",
      ),
    },
  },
  {
    ...workerConfig,
    entry: {
      "worker-entry-browser": path.join(HOST_SRC, "worker-entry-browser.ts"),
    },
  },
]);
