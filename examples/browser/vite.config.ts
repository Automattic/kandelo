import { fileURLToPath } from "url";
import path from "path";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        // Additional pages will be added here as they're created:
        // nginx: path.resolve(__dirname, "pages/nginx/index.html"),
        // php: path.resolve(__dirname, "pages/php/index.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
});
