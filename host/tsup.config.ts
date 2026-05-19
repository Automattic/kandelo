import { defineConfig } from "tsup";

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
});
