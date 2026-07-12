import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import type { Plugin } from "vite";
import { resolvePackageRuntimeFile } from "../../../../../scripts/package-runtime-file";
import { tryResolveBinary } from "../../../../../host/src/binary-resolver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");

const phpIcuRuntime = resolvePackageRuntimeFile(repoRoot, "php", "icu.dat");

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
        const file = tryResolveBinary("kernel.wasm");
        if (file) return file + query;
        this.error(
          "kernel.wasm was not accepted from the standard local, fetched, or packaged locations. " +
          "Run `bash build.sh` from the repo root or fetch package binaries.",
        );
      }

      if (pathPart === ROOTFS) {
        const file = tryResolveBinary("rootfs.vfs")
          ?? tryResolveBinary("programs/rootfs.vfs");
        if (file) return file + query;
        this.error(
          "rootfs.vfs was not accepted from the standard local, fetched, or packaged locations. " +
          "Run `bash build.sh` from the repo root or fetch the rootfs package.",
        );
      }

      return null;
    },
  };
}

function findPhpArtifact(name: string): string | null {
  if (phpIcuRuntime) {
    // All PHP artifacts served by this harness come from the single complete
    // package tier selected with icu.dat. Never let per-file resolver priority
    // compose local and fetched builds.
    return phpIcuRuntime.closureHostPaths.get(`php/${name}`) ?? null;
  }
  if (name === "icu.dat") return null;
  const candidates = [
    path.resolve(__dirname, "../../bin", name),
    ...(name === "php.wasm"
      ? [path.resolve(__dirname, "../../php-src/sapi/cli/php")]
      : []),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function servePhpArtifacts(): Plugin {
  return {
    name: "serve-php-artifacts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/php-runtime-files/icu.dat") {
          if (!phpIcuRuntime) {
            res.statusCode = 404;
            res.end("the declared PHP icu.dat runtime file is not materialized");
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            artifact: phpIcuRuntime.artifact,
            guestPath: phpIcuRuntime.guestPath,
            mode: phpIcuRuntime.mode,
          }));
          return;
        }
        const prefix = "/php-artifacts/";
        if (!req.url?.startsWith(prefix)) {
          next();
          return;
        }
        let name: string;
        try {
          name = decodeURIComponent(req.url.slice(prefix.length));
        } catch {
          res.statusCode = 400;
          res.end("invalid percent-encoding in PHP artifact name");
          return;
        }
        if (
          name === "."
          || name === ".."
          || !/^[A-Za-z0-9._-]+$/.test(name)
        ) {
          res.statusCode = 400;
          res.end("invalid PHP artifact name");
          return;
        }
        const artifact = findPhpArtifact(name);
        if (!artifact) {
          res.statusCode = 404;
          res.end(name === "icu.dat"
            ? "the declared PHP icu.dat runtime file is not materialized"
            : `${name} not found. Run \`bash packages/registry/php/build-php.sh\` ` +
              "or fetch package binaries.");
          return;
        }
        const data = fs.readFileSync(artifact);
        res.setHeader(
          "Content-Type",
          name.endsWith(".wasm") || name.endsWith(".so")
            ? "application/wasm"
            : "application/octet-stream",
        );
        res.end(data);
      });
    },
  };
}

export default {
  root: __dirname,
  plugins: [resolveKernelArtifactsAlias(), servePhpArtifacts()],
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
