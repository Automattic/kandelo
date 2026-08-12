import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const configRoot = path.dirname(fileURLToPath(import.meta.url));
const exactSourceInput = process.env.KANDELO_ABI_STAGING_EXACT_SOURCE_ROOT;
if (exactSourceInput === undefined || !path.isAbsolute(exactSourceInput)) {
  throw new Error("exact browser host build requires one absolute source root");
}
const exactSourceRoot = realpathSync.native(exactSourceInput);
const sourceMetadata = lstatSync(exactSourceRoot);
if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
  throw new Error("exact browser host source root must be a real directory");
}
const exactHostEntry = path.join(
  exactSourceRoot,
  "host/src/browser-kernel-host.ts",
);
const protectedNoDefaults = path.join(
  configRoot,
  "abi-staging-browser-no-default-artifacts.ts",
);
const hostMetadata = lstatSync(exactHostEntry);
if (!hostMetadata.isFile() || hostMetadata.isSymbolicLink()) {
  throw new Error("exact browser host source entry must be a regular file");
}

export default defineConfig({
  base: "/abi-staging/",
  resolve: {
    alias: [
      {
        find: "@exact-browser-kernel-host",
        replacement: exactHostEntry,
      },
      {
        find: /^\.\/browser-kernel-default-artifacts$/u,
        replacement: protectedNoDefaults,
      },
    ],
  },
  build: {
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: path.join(configRoot, "abi-staging-browser-host.ts"),
      formats: ["es"],
      fileName: () => "browser-host.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  worker: { format: "es" },
});
