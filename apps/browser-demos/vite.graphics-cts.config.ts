import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import normal from "./vite.config";

// Keep the ordinary runtime/compiler/worker plugins and isolation headers.
// This consumer loads one plain page; scanning gallery entry points would
// unnecessarily provision unrelated desktop images before executing a case.
export default defineConfig(async environment => {
  const base = typeof normal === "function" ? await normal(environment) : await normal;
  return {
    ...base,
    cacheDir: fileURLToPath(new URL("../../.context/graphics-cts/vite-cache/", import.meta.url)),
    optimizeDeps: {
      ...base.optimizeDeps,
      entries: [fileURLToPath(new URL("./public/trap-signal-test.html", import.meta.url))],
    },
    server: { ...base.server, host: "127.0.0.1", strictPort: true, hmr: false },
  };
});
