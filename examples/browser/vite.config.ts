import { defineConfig } from "vite";
import path from "path";

const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  // Serve from repo root so wasm files and host sources are accessible
  root: repoRoot,
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
