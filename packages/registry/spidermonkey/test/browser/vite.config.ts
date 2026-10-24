import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import type { Plugin } from "vite";
import { tryResolveBinary } from "../../../../../host/src/binary-resolver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");

function resolveKernelArtifactsAlias(): Plugin {
  const KERNEL = "@kernel-wasm";
  const ROOTFS = "@rootfs-vfs";
  return {
    name: "resolve-kernel-artifacts-alias",
    enforce: "pre",
    resolveId(source) {
      const queryIdx = source.indexOf("?");
      const pathPart = queryIdx === -1 ? source : source.slice(0, queryIdx);
      const query = queryIdx === -1 ? "" : source.slice(queryIdx);

      const artifact = pathPart === KERNEL ? "kernel.wasm"
        : pathPart === ROOTFS ? "rootfs.vfs.zst"
        : pathPart === "@kandelo-image-module32-wasm" ? "kandelo_image_module32.wasm"
        : null;
      if (artifact) {
        const file = tryResolveBinary(artifact);
        if (file) return file + query;
        this.error(`${artifact} is not materialized; run the normal setup/build path.`);
      }

      return null;
    },
  };
}

function findJsBinary(): string | null {
  return tryResolveBinary("programs/js.wasm");
}

function serveJsWasm(): Plugin {
  return {
    name: "serve-js-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/js.wasm") {
          const jsBinary = findJsBinary();
          if (!jsBinary) {
            res.statusCode = 404;
            res.end(
              "js.wasm is not materialized; build spidermonkey through the normal package resolver.",
            );
            return;
          }
          const data = fs.readFileSync(jsBinary);
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
  plugins: [resolveKernelArtifactsAlias(), serveJsWasm()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      allow: [repoRoot],
    },
  },
};
