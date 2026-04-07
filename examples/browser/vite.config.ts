import { fileURLToPath } from "url";
import path from "path";
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

export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [rewriteNavLinks(), injectCoiServiceWorker()],
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
        "test-runner": path.resolve(__dirname, "pages/test-runner/index.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
  assetsInclude: ["**/*.wasm", "**/*.sql"],
});
