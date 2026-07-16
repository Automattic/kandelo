import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: false,
  onSuccess: async () => {
    const outputDir = resolve(here, "dist/audio");
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(
      resolve(here, "src/audio/pcm-audio-worklet.js"),
      resolve(outputDir, "pcm-audio-worklet.js"),
    );
  },
});
