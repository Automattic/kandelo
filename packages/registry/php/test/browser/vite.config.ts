import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import type { Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");
const phpBinary = path.resolve(__dirname, "../../php-src/sapi/cli/php");

function servePhpWasm(): Plugin {
  return {
    name: "serve-php-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/php.wasm") {
          const data = fs.readFileSync(phpBinary);
          res.setHeader("Content-Type", "application/wasm");
          res.end(data);
          return;
        }
        next();
      });
    },
  };
}

export default {
  root: __dirname,
  plugins: [servePhpWasm()],
  server: {
    headers: {
      // Required for SharedArrayBuffer
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      allow: [repoRoot],
    },
  },
};
