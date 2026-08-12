import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const configRoot = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = realpathSync.native(
  path.join(configRoot, "pages/abi-staging-product-evidence"),
);
const harnessMetadata = lstatSync(harnessRoot);
if (!harnessMetadata.isDirectory() || harnessMetadata.isSymbolicLink()) {
  throw new Error("protected browser evidence harness root must be a real directory");
}

export default defineConfig({
  root: harnessRoot,
  base: "/abi-staging-harness/",
  build: {
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  worker: { format: "es" },
});
