import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hostBuildFingerprintBanner } from "./src/compiled-worker-entry";

const hostRoot = dirname(fileURLToPath(import.meta.url));

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
  external: [/\?url$/, /\?worker&url$/],
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
