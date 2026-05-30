import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import type { Plugin } from "vite";

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

      if (pathPart === KERNEL) {
        const candidates = [
          path.resolve(repoRoot, "local-binaries/kernel.wasm"),
          path.resolve(repoRoot, "binaries/kernel.wasm"),
        ];
        const file = candidates.find((candidate) => fs.existsSync(candidate));
        if (file) return file + query;
        this.error(
          "kernel.wasm not found. Run `bash build.sh` from the repo root.\n" +
          `  Looked at: ${candidates.join("\n  Looked at: ")}`,
        );
      }

      if (pathPart === ROOTFS) {
        const file = path.resolve(repoRoot, "host/wasm/rootfs.vfs");
        if (fs.existsSync(file)) return file + query;
        this.error(
          "rootfs.vfs not found. Run `bash build.sh` from the repo root.\n" +
          `  Looked at: ${file}`,
        );
      }

      return null;
    },
  };
}

function findJsBinary(): string | null {
  const candidates = [
    path.resolve(repoRoot, "local-binaries/programs/wasm32/js.wasm"),
    path.resolve(repoRoot, "binaries/programs/wasm32/js.wasm"),
    path.resolve(repoRoot, "packages/registry/spidermonkey/bin/js.wasm"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
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
              "js.wasm not found. Run `bash packages/registry/spidermonkey/build-spidermonkey.sh` " +
              "or fetch package binaries.",
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
