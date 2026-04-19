import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { defineConfig, type Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

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

/**
 * Vite plugin: same-origin CORS proxy for development.
 * Cross-Origin-Embedder-Policy: require-corp blocks all cross-origin fetches
 * from web workers unless the remote server sends CORP headers (most don't).
 * This middleware proxies external requests through the dev server so they
 * appear same-origin.  URL: /cors-proxy?url=<encoded-url>
 */
function corsProxyPlugin(): Plugin {
  return {
    name: "cors-proxy",
    configureServer(server) {
      server.middlewares.use("/cors-proxy", async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing ?url= parameter");
          return;
        }
        try {
          // Use Node.js http/https modules for more reliable proxying
          const { default: https } = await import("https");
          const { default: http } = await import("http");
          const parsedUrl = new URL(targetUrl);
          const client = parsedUrl.protocol === "https:" ? https : http;

          const proxyReq = client.request(targetUrl, {
            method: req.method || "GET",
            rejectUnauthorized: false, // Dev proxy — skip cert verification
            headers: {
              "User-Agent": req.headers["user-agent"] || "wasm-posix-kernel-proxy",
              "Accept": req.headers["accept"] || "*/*",
            },
          }, (proxyRes) => {
            const headers: Record<string, string> = {
              "Access-Control-Allow-Origin": "*",
              "Cross-Origin-Resource-Policy": "cross-origin",
            };
            if (proxyRes.headers["content-type"]) {
              headers["Content-Type"] = proxyRes.headers["content-type"];
            }
            res.writeHead(proxyRes.statusCode || 502, headers);
            proxyRes.pipe(res);
          });
          proxyReq.on("error", (err) => {
            console.error("[cors-proxy] Request error:", err.message);
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end(`Proxy error: ${err.message}`);
          });
          proxyReq.end();
        } catch (err: any) {
          console.error("[cors-proxy] Error:", err);
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`Proxy error: ${err?.message || err}`);
        }
      });
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
  plugins: [
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
        redis: path.resolve(__dirname, "pages/redis/index.html"),
        wordpress: path.resolve(__dirname, "pages/wordpress/index.html"),
        lamp: path.resolve(__dirname, "pages/lamp/index.html"),
        shell: path.resolve(__dirname, "pages/shell/index.html"),
        python: path.resolve(__dirname, "pages/python/index.html"),
        perl: path.resolve(__dirname, "pages/perl/index.html"),
        ruby: path.resolve(__dirname, "pages/ruby/index.html"),
        "test-runner": path.resolve(__dirname, "pages/test-runner/index.html"),
        "git-test": path.resolve(__dirname, "pages/git-test/index.html"),
        "mariadb-test": path.resolve(__dirname, "pages/mariadb-test/index.html"),
        erlang: path.resolve(__dirname, "pages/erlang/index.html"),
        benchmark: path.resolve(__dirname, "pages/benchmark/index.html"),
        texlive: path.resolve(__dirname, "pages/texlive/index.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
  assetsInclude: ["**/*.wasm", "**/*.sql"],
});
