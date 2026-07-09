import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { tryResolveBinary } from "../../host/src/binary-resolver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const DEFAULT_CORS_PROXY_URL = "https://wordpress-playground-cors-proxy.net/?";
const preferredLocalPort = 5401;

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Service-Worker-Allowed": "/",
};

function configuredCorsProxyUrl(): string | undefined {
  return process.env.VITE_CORS_PROXY_URL?.trim() || undefined;
}

function buildCorsProxyUrl(): string {
  return configuredCorsProxyUrl() || DEFAULT_CORS_PROXY_URL;
}

function serviceWorkerPathForBase(base: string): string {
  const normalized = base.startsWith("/") ? base : `/${base}`;
  return `${normalized.endsWith("/") ? normalized : `${normalized}/`}service-worker.js`;
}

function devCorsProxyPathForBase(base: string): string {
  const normalized = base.startsWith("/") ? base : `/${base}`;
  return `${normalized.endsWith("/") ? normalized : `${normalized}/`}__kandelo_cors_proxy`;
}

function devCorsProxyFetchUrlForBase(base: string): string {
  return `${devCorsProxyPathForBase(base)}?url=`;
}

function injectCorsProxyUrlPlaceholder(content: string, corsProxyUrl: string): string {
  return content.replace('"__CORS_PROXY_URL__"', JSON.stringify(corsProxyUrl));
}

const blobIframeInterceptorPath = path.resolve(
  __dirname,
  "public",
  "blob-iframe-interceptor.js",
);

/**
 * Inline the reusable blob-iframe interceptor (public/blob-iframe-interceptor.js)
 * into the service worker in place of the `"__BLOB_IFRAME_INTERCEPTOR__"`
 * placeholder. The service worker injects this source into every bridged HTML
 * document so app-created `blob:` iframes become service-worker-controlled
 * `about:srcdoc` documents. Kept as a separate file so it stays independently
 * readable and testable.
 */
function injectBlobIframeInterceptorPlaceholder(content: string): string {
  if (!content.includes('"__BLOB_IFRAME_INTERCEPTOR__"')) {
    return content;
  }
  const interceptor = fs.readFileSync(blobIframeInterceptorPath, "utf-8");
  return content.replace('"__BLOB_IFRAME_INTERCEPTOR__"', JSON.stringify(interceptor));
}

/**
 * Vite plugin: resolve `@kernel-wasm` and `@rootfs-vfs` lazily.
 *
 * Lookup order for `@kernel-wasm` (first hit wins):
 *   1. `<repoRoot>/local-binaries/kernel.wasm` — populated by `bash build.sh`.
 *   2. `<repoRoot>/binaries/kernel.wasm` — populated by `./run.sh fetch`.
 *
 * `@rootfs-vfs` resolves to `<repoRoot>/host/wasm/rootfs.vfs` (built by
 * mkrootfs during `bash build.sh`).
 *
 * Resolution is deferred until import time so pages that don't consume
 * these aliases can run without a kernel build present. Pages that do
 * import them get a clear error pointing at the build script.
 */
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
        const resolved = tryResolveBinary("kernel.wasm");
        if (resolved) return resolved + query;
        const local = path.resolve(repoRoot, "local-binaries/kernel.wasm");
        const fetched = path.resolve(repoRoot, "binaries/kernel.wasm");
        this.error(
          "kernel.wasm not found, or every candidate is stale. Run `bash build.sh` from the repo root.\n" +
          `  Looked at: ${local}\n  Looked at: ${fetched}`
        );
      }
      if (pathPart === ROOTFS) {
        const candidates = [
          path.resolve(repoRoot, "host/wasm/rootfs.vfs"),
          path.resolve(repoRoot, "local-binaries/rootfs.vfs"),
          path.resolve(repoRoot, "binaries/rootfs.vfs"),
          path.resolve(repoRoot, "local-binaries/programs/wasm32/rootfs.vfs"),
          path.resolve(repoRoot, "binaries/programs/wasm32/rootfs.vfs"),
        ];
        for (const file of candidates) {
          if (fs.existsSync(file)) return file + query;
        }
        this.error(
          "rootfs.vfs not found. Run `bash build.sh` from the repo root, or fetch/build the rootfs package.\n" +
          candidates.map((file) => `  Looked at: ${file}`).join("\n")
        );
      }
      return null;
    },
  };
}

/**
 * Vite plugin (worker build only): strip the dead `export { … }` that rolldown
 * synthesizes on worker entry chunks.
 *
 * A worker entry is a terminal module — nothing imports it — so the export is
 * dead. But its presence makes WebKit/Safari evaluate the module worker TWICE:
 * the second (uninitialized) evaluation reinstalls `self.onmessage` bound to a
 * fresh module state whose `initReady` is false, which shadows the first
 * evaluation's handler and silently parks the kernel's lazy-VFS registration
 * messages — deadlocking `kernel.init()` so the shell never boots. Chromium and
 * Firefox evaluate the module once and are unaffected. Dropping the export
 * makes the worker a plain single-evaluation module on every engine.
 *
 * The "proper" lever for this is `preserveEntrySignatures: false`, but as of
 * 2026-07-02 (Vite 8 / rolldown 1.0.3) setting it under `worker.rollupOptions`
 * had zero effect here (byte-identical output): rolldown-vite does not thread
 * that option into the worker build. So we strip the artifact at `renderChunk`
 * instead — a build-time output transform, not a runtime workaround. Revisit
 * once rolldown-vite honors `preserveEntrySignatures` for worker builds (or
 * stops emitting the dead export), and this plugin can be dropped for the
 * option.
 */
function dropWorkerEntryExports(): Plugin {
  return {
    name: "drop-worker-entry-exports",
    enforce: "post",
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      const stripped = code.replace(/\bexport\s*\{[^}]*\}\s*;?\s*$/, "");
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

/**
 * Vite plugin: resolve `@binaries/...` imports against the
 * resolver-managed binaries trees.
 *
 * Lookup order, first hit wins:
 *   1. `<repoRoot>/local-binaries/<rest>` — populated by xtask while
 *      installing into the resolver cache, plus any direct
 *      `install_local_binary` writes from build scripts.
 *   2. `<repoRoot>/binaries/<rest>` — populated by xtask when given
 *      `--binaries-dir`; mirrors release archives via symlinks.
 *
 * The fallback is what makes the alias useful for both release-shipped
 * artifacts and local-only ones (e.g. dev builds, test fixtures): a
 * page just imports `@binaries/programs/wasm32/<x>` and gets whichever
 * copy is present.
 *
 * Doing this with a custom plugin (rather than `resolve.alias`) is
 * deliberate: `@rollup/plugin-alias` has a single `replacement` string,
 * which can't express "try this directory first, then that one." A
 * `resolveId` hook can.
 */
function resolveBinariesAlias(): Plugin {
  const PREFIX = "@binaries/";
  const applyDefaultArch = (rel: string): string => {
    if (!rel.startsWith("programs/")) return rel;
    const tail = rel.slice("programs/".length);
    const first = tail.split("/", 1)[0];
    if (first === "wasm32" || first === "wasm64") return rel;
    return `programs/wasm32/${tail}`;
  };

  return {
    name: "resolve-binaries-alias",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith(PREFIX)) return null;
      const queryIdx = source.indexOf("?");
      const pathPart = queryIdx === -1 ? source : source.slice(0, queryIdx);
      const query = queryIdx === -1 ? "" : source.slice(queryIdx);
      const rest = applyDefaultArch(pathPart.slice(PREFIX.length));
      const resolved = tryResolveBinary(rest);
      if (resolved) return resolved + query;
      const local = path.resolve(repoRoot, "local-binaries", rest);
      const fetched = path.resolve(repoRoot, "binaries", rest);
      this.error(
        `@binaries: ${rest} not found, or every candidate is stale. ` +
        `Looked at:\n  ${local}\n  ${fetched}\n` +
        `Run \`./run.sh fetch\` to install release archives, or build the artifact locally.`
      );
    },
  };
}

/**
 * Vite plugin: rewrite absolute nav links in HTML to include the base path.
 * In dev mode (base="/") this is a no-op. In production with a custom base
 * (e.g. "/kandelo/"), it rewrites href="/" → href="/kandelo/".
 */
function rewriteNavLinks(): Plugin {
  let base = "/";
  return {
    name: "rewrite-nav-links",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml(html) {
      if (base === "/") return html;
      // Rewrite href="/..." links to href="${base}..." but skip links that
      // Vite has already prefixed with the base path (e.g. asset preloads)
      const baseRest = base.slice(1); // "kandelo/"
      const escaped = baseRest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`href="\\/(?!${escaped})(?!\\/)`, "g");
      return html.replace(re, `href="${base}`);
    },
  };
}

/**
 * Vite plugin: inject a git revision tag into the sidebar of every HTML page.
 * The revision is read at build/serve time and rendered as a link to the
 * GitHub commit.
 */
function injectGitRevision(): Plugin {
  let shortRev = "";
  let commitUrl = "";
  return {
    name: "inject-git-revision",
    configResolved() {
      try {
        shortRev = execSync("git rev-parse --short HEAD", {
          cwd: repoRoot,
          encoding: "utf-8",
        }).trim();
        const remoteUrl = execSync("git remote get-url origin", {
          cwd: repoRoot,
          encoding: "utf-8",
        }).trim();
        // Convert git@github.com:user/repo.git or https://github.com/user/repo.git
        const match = remoteUrl.match(
          /github\.com[:/](.+?)(?:\.git)?$/
        );
        const repoPath = match ? match[1] : "brandonpayton/kandelo";
        const fullRev = execSync("git rev-parse HEAD", {
          cwd: repoRoot,
          encoding: "utf-8",
        }).trim();
        commitUrl = `https://github.com/${repoPath}/commit/${fullRev}`;
      } catch {
        shortRev = "unknown";
        commitUrl = "";
      }
    },
    transformIndexHtml(html) {
      if (!shortRev) return html;
      const tag = commitUrl
        ? `<a class="sidebar-revision" href="${commitUrl}" target="_blank" rel="noopener">rev: ${shortRev}</a>`
        : `<span class="sidebar-revision">rev: ${shortRev}</span>`;
      return html.replace("</nav>", `  ${tag}\n  </nav>`);
    },
  };
}

/**
 * Vite plugin: inject the COI (Cross-Origin Isolation) service worker bootstrap
 * script into HTML pages during production builds. The service worker adds
 * COOP/COEP headers to all responses, enabling SharedArrayBuffer on hosts
 * like GitHub Pages that don't support custom HTTP headers.
 *
 * Skipped in dev mode because Vite's dev server sets the headers directly.
 */
function injectCoiServiceWorker(): Plugin {
  let base = "/";
  let isDev = false;
  return {
    name: "inject-coi-service-worker",
    configResolved(config) {
      base = config.base;
      isDev = config.command === "serve";
    },
    transformIndexHtml(html) {
      if (isDev) return html;
      const tag = `<script src="${base}service-worker.js"></script>`;
      return html.replace("<head>", `<head>\n  ${tag}`);
    },
  };
}

/**
 * Vite plugin: inject the service worker CORS proxy URL. Local dev/preview
 * uses the Vite same-origin proxy by default so the service worker can read
 * the response from whichever port Vite selected. Production builds use the
 * configured external proxy unless VITE_CORS_PROXY_URL overrides it.
 */
function injectCorsProxyUrl(): Plugin {
  let servedCorsProxyUrl = "";
  let outputCorsProxyUrl = "";
  let base = "/";
  const sourceSwPath = path.resolve(__dirname, "public", "service-worker.js");

  function serviceWorkerSource(): string {
    return injectBlobIframeInterceptorPlaceholder(
      injectCorsProxyUrlPlaceholder(
        fs.readFileSync(sourceSwPath, "utf-8"),
        servedCorsProxyUrl,
      ),
    );
  }

  function attachMiddleware(
    middlewares: ViteDevServer["middlewares"] | PreviewServer["middlewares"],
  ): void {
    const serviceWorkerPath = serviceWorkerPathForBase(base);
    middlewares.use((req, res, next) => {
      if (!req.url) {
        next();
        return;
      }
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname !== serviceWorkerPath) {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(serviceWorkerSource());
    });
  }

  return {
    name: "inject-cors-proxy-url",
    configResolved(config) {
      base = config.base;
      servedCorsProxyUrl = configuredCorsProxyUrl() || devCorsProxyFetchUrlForBase(base);
      outputCorsProxyUrl = buildCorsProxyUrl();
    },
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
    writeBundle() {
      // service-worker.js is in public/ and gets copied as-is to dist/
      const swPath = path.resolve(__dirname, "dist", "service-worker.js");
      if (fs.existsSync(swPath)) {
        let content = fs.readFileSync(swPath, "utf-8");
        content = injectCorsProxyUrlPlaceholder(content, outputCorsProxyUrl);
        content = injectBlobIframeInterceptorPlaceholder(content);
        fs.writeFileSync(swPath, content);
      }
    },
  };
}

function devCorsProxyMiddleware(): Plugin {
  let base = "/";

  function attachMiddleware(
    middlewares: ViteDevServer["middlewares"] | PreviewServer["middlewares"],
  ): void {
    const proxyPath = devCorsProxyPathForBase(base);
    middlewares.use(async (req, res, next) => {
      if (!req.url) {
        next();
        return;
      }
      const requestUrl = new URL(req.url, "http://localhost");
      if (requestUrl.pathname !== proxyPath) {
        next();
        return;
      }
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      const target = requestUrl.searchParams.get("url");
      if (!target) {
        res.statusCode = 400;
        res.end("Missing url");
        return;
      }

      let targetUrl: URL;
      try {
        targetUrl = new URL(target);
      } catch {
        res.statusCode = 400;
        res.end("Invalid url");
        return;
      }
      if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        res.statusCode = 400;
        res.end("Unsupported url");
        return;
      }

      try {
        const upstream = await fetch(targetUrl.href, { redirect: "follow" });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        res.statusCode = upstream.status;
        res.statusMessage = upstream.statusText;
        for (const name of [
          "accept-ranges",
          "cache-control",
          "content-type",
          "etag",
          "expires",
          "last-modified",
        ]) {
          const value = upstream.headers.get(name);
          if (value) res.setHeader(name, value);
        }
        res.setHeader("Content-Length", String(bytes.byteLength));
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.end(bytes);
      } catch (err) {
        res.statusCode = 502;
        res.end(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return {
    name: "dev-cors-proxy-middleware",
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}

const defaultDemoInputs = {
  main: path.resolve(__dirname, "index.html"),
  kandelo: path.resolve(__dirname, "pages/kandelo/index.html"),
  network: path.resolve(__dirname, "pages/network/index.html"),
};

const demoInputs = {
  ...defaultDemoInputs,
  "homebrew-smoke": path.resolve(__dirname, "pages/homebrew-smoke/index.html"),
  "sqlite-test": path.resolve(__dirname, "pages/sqlite-test/index.html"),
  // The perl, python, ruby, erlang, texlive, and redis package entries
  // are not bundled into this static build while their slow builds
  // live in kandelo-software. The root gallery fetches that
  // repo's gallery.json and index.toml at runtime to expose
  // available third-party VFS builds without adding page inputs.
};

function selectedDemoInputs(): typeof demoInputs | Record<string, string> {
  const requested = process.env.KANDELO_BROWSER_DEMO_INPUTS
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!requested || requested.length === 0) return defaultDemoInputs;

  const selected: Record<string, string> = {};
  for (const name of requested) {
    if (!(name in demoInputs)) {
      throw new Error(`Unknown KANDELO_BROWSER_DEMO_INPUTS entry: ${name}`);
    }
    selected[name] = demoInputs[name as keyof typeof demoInputs];
  }
  return selected;
}

const disableBrowserTestHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR === "1";

export default defineConfig({
  base: process.env.VITE_BASE || "/",
  resolve: {
    alias: {
      "@host": path.resolve(repoRoot, "host/src"),
    },
  },
  plugins: [
    react(),
    resolveKernelArtifactsAlias(),
    resolveBinariesAlias(),
    rewriteNavLinks(),
    injectGitRevision(),
    injectCoiServiceWorker(),
    injectCorsProxyUrl(),
    devCorsProxyMiddleware(),
  ],
  server: {
    host: "127.0.0.1",
    port: preferredLocalPort,
    headers: crossOriginIsolationHeaders,
    hmr: disableBrowserTestHmr ? false : undefined,
    watch: disableBrowserTestHmr ? {
      ignored: [
        "**/test-runs/**",
        "**/host/dist/**",
      ],
    } : undefined,
    fs: {
      allow: [repoRoot],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: preferredLocalPort,
    headers: crossOriginIsolationHeaders,
  },
  build: {
    // Use terser instead of esbuild for minification. esbuild's minifier
    // drops variable declarations from TypeScript const-enum IIFEs in
    // @xterm/xterm's pre-built ESM bundle, producing assignments to
    // undeclared variables that throw ReferenceError in strict mode
    // (Firefox).
    minify: "terser",
    rollupOptions: {
      input: selectedDemoInputs(),
    },
  },
  worker: {
    format: "es",
    plugins: () => [
      resolveKernelArtifactsAlias(),
      resolveBinariesAlias(),
      dropWorkerEntryExports(),
    ],
  },
  assetsInclude: ["**/*.wasm", "**/*.sql", "**/*.vfs", "**/*.vfs.zst", "**/*.zip"],
});
