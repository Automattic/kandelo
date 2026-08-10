import { fileURLToPath } from "node:url";
import path from "node:path";

import { defineConfig } from "vite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "test/fixtures/abi-staging-pages-placement",
);

export default defineConfig({
  base: "/",
  root,
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(root, "index.html"),
    },
  },
});
