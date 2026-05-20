import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

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
        const local = path.resolve(repoRoot, "local-binaries/kernel.wasm");
        if (fs.existsSync(local)) return local + query;
        const fetched = path.resolve(repoRoot, "binaries/kernel.wasm");
        if (fs.existsSync(fetched)) return fetched + query;
        this.error(
          "kernel.wasm not found. Run `bash build.sh` from the repo root.\n" +
          `  Looked at: ${local}\n  Looked at: ${fetched}`
        );
      }
      if (pathPart === ROOTFS) {
        const file = path.resolve(repoRoot, "host/wasm/rootfs.vfs");
        if (fs.existsSync(file)) return file + query;
        this.error(
          "rootfs.vfs not found. Run `bash build.sh` from the repo root.\n" +
          `  Looked at: ${file}`
        );
      }
      return null;
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
  return {
    name: "resolve-binaries-alias",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith(PREFIX)) return null;
      const queryIdx = source.indexOf("?");
      const pathPart = queryIdx === -1 ? source : source.slice(0, queryIdx);
      const query = queryIdx === -1 ? "" : source.slice(queryIdx);
      const rest = pathPart.slice(PREFIX.length);
      const local = path.resolve(repoRoot, "local-binaries", rest);
      if (fs.existsSync(local)) return local + query;
      const fetched = path.resolve(repoRoot, "binaries", rest);
      if (fs.existsSync(fetched)) return fetched + query;
      this.error(
        `@binaries: ${rest} not found. ` +
        `Looked at:\n  ${local}\n  ${fetched}\n` +
        `Run \`./run.sh fetch\` to install release archives, or build the artifact locally.`
      );
    },
  };
}

/**
 * Vite plugin: rewrite absolute nav links in HTML to include the base path.
 * In dev mode (base="/") this is a no-op. In production with a custom base
 * (e.g. "/wasm-posix-kernel/"), it rewrites href="/" → href="/wasm-posix-kernel/".
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
      const baseRest = base.slice(1); // "wasm-posix-kernel/"
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
        const repoPath = match ? match[1] : "brandonpayton/wasm-posix-kernel";
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

function attachCorsProxyMiddleware(
  middlewares: ViteDevServer["middlewares"] | PreviewServer["middlewares"],
) {
  middlewares.use("/cors-proxy", async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing ?url= parameter");
      return;
    }
    try {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });

      // Use Node.js http/https modules for more reliable proxying.
      const { default: https } = await import("https");
      const { default: http } = await import("http");

      // Forward all client headers except hop-by-hop ones, otherwise
      // upstream POSTs lose `content-type`, auth headers, etc. plus the
      // request body.
      const skipReqHeader = new Set([
        "host", "connection", "keep-alive", "transfer-encoding",
        "upgrade", "proxy-connection", "te", "trailer", "expect",
        "origin", "referer",
      ]);
      const forwardHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (skipReqHeader.has(name.toLowerCase())) continue;
        forwardHeaders[name] = value as string | string[];
      }
      if (!forwardHeaders["user-agent"]) {
        forwardHeaders["user-agent"] = "wasm-posix-kernel-proxy";
      }
      // The wasm-side fetch can't decompress gzip/br — force identity so
      // the client sees raw JSON/SSE instead of UTF-8 replacement chars.
      forwardHeaders["accept-encoding"] = "identity";

      const proxyTo = (currentUrl: string, redirectsLeft: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const parsedUrl = new URL(currentUrl);
          const client = parsedUrl.protocol === "https:" ? https : http;
          const proxyReq = client.request(currentUrl, {
            method: req.method || "GET",
            rejectUnauthorized: false, // Dev/local preview proxy — skip cert verification.
            headers: forwardHeaders,
          }, (proxyRes) => {
            const statusCode = proxyRes.statusCode || 502;
            const location = Array.isArray(proxyRes.headers.location)
              ? proxyRes.headers.location[0]
              : proxyRes.headers.location;
            if (
              location &&
              redirectsLeft > 0 &&
              [301, 302, 303, 307, 308].includes(statusCode)
            ) {
              proxyRes.resume();
              proxyRes.on("end", () => {
                resolve(proxyTo(new URL(location, currentUrl).href, redirectsLeft - 1));
              });
              return;
            }

            const skipResHeader = new Set([
              "connection", "keep-alive", "transfer-encoding",
              "content-encoding", "content-length",
            ]);
            const headers: Record<string, string | string[]> = {
              "access-control-allow-origin": "*",
              "cross-origin-resource-policy": "cross-origin",
            };
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              if (v === undefined) continue;
              if (skipResHeader.has(k.toLowerCase())) continue;
              headers[k] = v as string | string[];
            }
            res.writeHead(statusCode, headers);
            proxyRes.pipe(res);
            proxyRes.on("end", resolve);
          });
          proxyReq.on("error", reject);
          if (body.length > 0) {
            proxyReq.write(body);
          }
          proxyReq.end();
        });

      await proxyTo(targetUrl, 5);
    } catch (err: any) {
      console.error("[cors-proxy] Error:", err);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${err?.message || err}`);
    }
  });
}

/**
 * Vite plugin: same-origin CORS proxy for local dev and preview.
 * Cross-Origin-Embedder-Policy: require-corp blocks all cross-origin fetches
 * from web workers unless the remote server sends CORP headers (most don't).
 * This middleware proxies external requests through the local server so they
 * appear same-origin.  URL: /cors-proxy?url=<encoded-url>
 */
function corsProxyPlugin(): Plugin {
  return {
    name: "cors-proxy",
    configureServer(server) {
      attachCorsProxyMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachCorsProxyMiddleware(server.middlewares);
    },
  };
}

/**
 * Vite plugin: inject CORS proxy URL into service-worker.js during build.
 * Replaces the __CORS_PROXY_URL__ placeholder with the value from
 * VITE_CORS_PROXY_URL env var. In dev mode this is a no-op (the dev server's
 * cors-proxy middleware handles it instead).
 */
function injectCorsProxyUrl(): Plugin {
  let corsProxyUrl = "";
  return {
    name: "inject-cors-proxy-url",
    configResolved() {
      corsProxyUrl = process.env.VITE_CORS_PROXY_URL || "";
    },
    writeBundle(_, bundle) {
      // service-worker.js is in public/ and gets copied as-is to dist/
      const swPath = path.resolve(__dirname, "dist", "service-worker.js");
      if (fs.existsSync(swPath)) {
        let content = fs.readFileSync(swPath, "utf-8");
        content = content.replace("__CORS_PROXY_URL__", corsProxyUrl);
        fs.writeFileSync(swPath, content);
      }
    },
  };
}

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
    corsProxyPlugin(),
    injectCorsProxyUrl(),
  ],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Service-Worker-Allowed": "/",
    },
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    // Use terser instead of esbuild for minification. esbuild's minifier
    // drops variable declarations from TypeScript const-enum IIFEs in
    // @xterm/xterm's pre-built ESM bundle, producing assignments to
    // undeclared variables that throw ReferenceError in strict mode
    // (Firefox).
    minify: "terser",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        nginx: path.resolve(__dirname, "pages/nginx/index.html"),
        php: path.resolve(__dirname, "pages/php/index.html"),
        "nginx-php": path.resolve(__dirname, "pages/nginx-php/index.html"),
        mariadb: path.resolve(__dirname, "pages/mariadb/index.html"),
        wordpress: path.resolve(__dirname, "pages/wordpress/index.html"),
        lamp: path.resolve(__dirname, "pages/lamp/index.html"),
        shell: path.resolve(__dirname, "pages/shell/index.html"),
        node: path.resolve(__dirname, "pages/node/index.html"),
        "test-runner": path.resolve(__dirname, "pages/test-runner/index.html"),
        "git-test": path.resolve(__dirname, "pages/git-test/index.html"),
        "mariadb-test": path.resolve(__dirname, "pages/mariadb-test/index.html"),
        benchmark: path.resolve(__dirname, "pages/benchmark/index.html"),
        doom: path.resolve(__dirname, "pages/doom/index.html"),
        kandelo: path.resolve(__dirname, "pages/kandelo/index.html"),
        // The perl, python, ruby, erlang, texlive, and redis pages
        // are not part of this static build while their slow builds
        // live in kandelo-software. The root gallery fetches that
        // repo's gallery.json and index.toml at runtime to expose
        // available third-party VFS builds without adding page inputs.
      },
    },
  },
  worker: {
    format: "es",
  },
  assetsInclude: ["**/*.wasm", "**/*.sql", "**/*.vfs", "**/*.vfs.zst"],
});
