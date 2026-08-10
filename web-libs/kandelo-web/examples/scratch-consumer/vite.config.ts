import { defineConfig } from "vite";
import { ABI_VERSION } from "../../../../host/src/generated/abi";

// SharedArrayBuffer + Atomics require cross-origin isolation. Kandelo cannot
// run without these headers — they are part of the platform contract, not an
// optimization.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// GitHub release assets are served from release-assets.githubusercontent.com
// with NO `Access-Control-Allow-Origin` / `Cross-Origin-Resource-Policy`
// headers, so a cross-origin `fetch()` from this COEP:require-corp page is
// blocked by CORS. The binaries must therefore be reached **same-origin**.
// We proxy `/kandelo-binaries/*` to the canonical release here; the app points
// `fetchKandelo*` at this same-origin base. A real consumer would mirror the
// release behind its own origin (or inject a custom `fetch` that proxies).
// Derived from the kernel's generated ABI version, the same source the package's
// BINARIES_RELEASE_TAG uses, so an ABI bump cannot leave this proxy stale.
const RELEASE_BASE =
  `https://github.com/Automattic/kandelo/releases/download/binaries-abi-v${ABI_VERSION}`;
const binariesProxy = {
  "/kandelo-binaries": {
    target: RELEASE_BASE,
    changeOrigin: true,
    followRedirects: true,
    rewrite: (p: string) => p.replace(/^\/kandelo-binaries/, ""),
  },
};

export default defineConfig({
  // `fs.allow` is only needed because this example consumes the package via a
  // `file:../..` symlink outside the Vite root: the worker files are fetched
  // as raw `/@fs` URLs (not module-graph imports), which the allow list
  // guards. A consumer installing from npm has them under `node_modules` and
  // needs none of this.
  server: {
    headers: crossOriginIsolation,
    proxy: binariesProxy,
    fs: { allow: [".", "../.."] },
  },
  preview: { headers: crossOriginIsolation, proxy: binariesProxy },
  // @kandelo/web ships its own pre-bundled module workers that it references
  // via `new URL(..., import.meta.url)`. Excluding it from dep-prebundling lets
  // Vite resolve those worker URLs against the package's dist/ instead of
  // esbuild's optimized cache.
  optimizeDeps: { exclude: ["@kandelo/web"] },
});
