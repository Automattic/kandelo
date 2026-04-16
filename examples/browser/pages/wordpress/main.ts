/**
 * WordPress browser demo — runs nginx + PHP-FPM inside the POSIX kernel,
 * with WordPress + SQLite Database Integration plugin pre-loaded into
 * the in-memory filesystem.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * Process layout:
 *   pid 1: php-fpm master -> forks pid 2 (worker)
 *   pid 3: nginx master   -> forks pid 4, 5 (workers)
 *
 * WordPress bundle is loaded AFTER daemons start (via onBeforeService for
 * the shell service) but BEFORE the interactive shell. The VFS uses
 * SharedArrayBuffer, so files loaded after fork are visible to all workers.
 *
 * Service worker intercepts ${BASE_URL}app/* requests and routes them through
 * the kernel's TCP stack to nginx.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { SystemInit } from "../../lib/init/system-init";
import { populateNginxConfig } from "../../lib/init/nginx-config";
import { populatePhpFpmConfig } from "../../lib/init/php-fpm-config";
import {
  populateShellBinaries,
  type BinaryDef,
  COREUTILS_NAMES,
} from "../../lib/init/shell-binaries";
import { writeVfsFile, writeInitDescriptor, ensureDirRecursive } from "../../lib/init/vfs-utils";
import { loadWordPressBundle } from "../../lib/wp-bundle";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../examples/nginx/php-fpm.wasm?url";
import dashWasmUrl from "../../../../examples/libs/dash/bin/dash.wasm?url";
import coreutilsWasmUrl from "../../../../examples/libs/coreutils/bin/coreutils.wasm?url";
import grepWasmUrl from "../../../../examples/libs/grep/bin/grep.wasm?url";
import sedWasmUrl from "../../../../examples/libs/sed/bin/sed.wasm?url";
import "@xterm/xterm/css/xterm.css";
import "../../lib/terminal-panel.css";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
// Without trailing slash, for embedding in PHP config strings
const APP_PATH = import.meta.env.BASE_URL + "app";
// Capture the real page protocol so wp-config.php generates correct URLs
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const terminalPanel = document.getElementById("terminal-panel") as HTMLDivElement;
let frame = document.getElementById("frame") as HTMLIFrameElement;

const decoder = new TextDecoder();

function appendLog(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

function setStatus(text: string, type: "loading" | "running" | "error") {
  statusDiv.style.display = "block";
  statusDiv.textContent = text;
  statusDiv.className = `status ${type}`;
}

/** Nginx location config for WordPress.
 *
 * Static asset directories are served directly by nginx (no PHP-FPM
 * overhead). Everything else goes through the FPM router which handles
 * directory index resolution, PHP execution, and the front controller
 * fallback for pretty URLs.
 *
 * This avoids the bottleneck of routing CSS/JS/image requests through
 * the single PHP-FPM worker. Without PCRE we can't match by extension,
 * but prefix locations for known static-only directories work fine.
 */
const FASTCGI_LOCATION = `        # Static asset directories — served directly by nginx
        location /wp-includes/css/ { }
        location /wp-includes/js/ { }
        location /wp-includes/fonts/ { }
        location /wp-includes/images/ { }
        location /wp-admin/css/ { }
        location /wp-admin/js/ { }
        location /wp-admin/images/ { }
        location /wp-content/ {
            try_files $uri @fpm;
        }

        # Everything else through PHP-FPM (PHP pages, front controller)
        location @fpm {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME /var/www/fpm-router.php;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param HTTP_HOST $http_host;
            fastcgi_param REDIRECT_STATUS 200;
        }

        location / {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME /var/www/fpm-router.php;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param HTTP_HOST $http_host;
            fastcgi_param REDIRECT_STATUS 200;
        }`;

// Custom wp-config.php — sets WP_HOME/WP_SITEURL with app prefix so
// WordPress generates URLs the service worker can intercept
const WP_CONFIG_PHP = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', '');
define('DB_PASSWORD', '');
define('DB_HOST', '');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

define('DB_DIR', __DIR__ . '/wp-content/database/');
define('DB_FILE', 'wordpress.db');

define('AUTH_KEY',         'wasm-posix-kernel-dev');
define('SECURE_AUTH_KEY',  'wasm-posix-kernel-dev');
define('LOGGED_IN_KEY',    'wasm-posix-kernel-dev');
define('NONCE_KEY',        'wasm-posix-kernel-dev');
define('AUTH_SALT',        'wasm-posix-kernel-dev');
define('SECURE_AUTH_SALT', 'wasm-posix-kernel-dev');
define('LOGGED_IN_SALT',   'wasm-posix-kernel-dev');
define('NONCE_SALT',       'wasm-posix-kernel-dev');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', false);
@ini_set('display_errors', '0');

// Site URL includes app prefix — the service worker intercepts app/*
// and strips it before sending to nginx
if (isset($_SERVER['HTTP_HOST'])) {
    if ('${PROTO}' === 'https') { $_SERVER['HTTPS'] = 'on'; }
    define('WP_HOME', '${PROTO}://' . $_SERVER['HTTP_HOST'] . '${APP_PATH}');
    define('WP_SITEURL', '${PROTO}://' . $_SERVER['HTTP_HOST'] . '${APP_PATH}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;

// mu-plugin to disable operations that hang or are unnecessary in Wasm
const MU_PLUGIN_PHP = `<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;

/** Fetch file size via HEAD request. Returns 0 on failure. */
async function fetchSize(url: string): Promise<number> {
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return 0;
    return parseInt(resp.headers.get("content-length") || "0", 10) || 0;
  } catch {
    return 0;
  }
}

let kernel: BrowserKernel | null = null;
let init: SystemInit | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading WordPress...", "loading");

  try {
    // Fetch kernel and dash eagerly; get nginx/php-fpm sizes for lazy registration
    appendLog("Fetching kernel and dash wasm...\n", "info");
    const [kernelBytes, dashBytes, nginxSize, phpFpmSize] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
      fetchSize(nginxWasmUrl),
      fetchSize(phpFpmWasmUrl),
    ]);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `dash: ${(dashBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `nginx: ${(nginxSize / (1024 * 1024)).toFixed(1)}MB (lazy), ` +
      `PHP-FPM: ${(phpFpmSize / (1024 * 1024)).toFixed(1)}MB (lazy)\n`,
      "info",
    );

    // Fetch sizes for shell utility binaries
    const lazyDefs = [
      { url: coreutilsWasmUrl, path: "/bin/coreutils", symlinks: [...COREUTILS_NAMES, "["].flatMap(n => [`/bin/${n}`, `/usr/bin/${n}`]) },
      { url: grepWasmUrl, path: "/usr/bin/grep", symlinks: ["/bin/grep", "/usr/bin/egrep", "/bin/egrep", "/usr/bin/fgrep", "/bin/fgrep"] },
      { url: sedWasmUrl, path: "/usr/bin/sed", symlinks: ["/bin/sed"] },
    ];
    const sizes = await Promise.all(lazyDefs.map((d) => fetchSize(d.url)));
    const lazyBinaries: BinaryDef[] = [];
    for (let i = 0; i < lazyDefs.length; i++) {
      if (sizes[i] > 0) {
        lazyBinaries.push({ ...lazyDefs[i], size: sizes[i] });
      }
    }

    // Create kernel with larger FS for WordPress
    // Use 4096 pages (256MB) per process instead of default 16384 (1GB)
    // to avoid exhausting browser memory with 5+ concurrent processes
    kernel = new BrowserKernel({
      maxWorkers: 8,
      fsSize: 256 * 1024 * 1024,
      maxMemoryPages: 4096,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Populate VFS
    appendLog("Populating filesystem...\n", "info");
    const fs = kernel.fs;

    // Shell binaries (dash eager, utilities lazy)
    populateShellBinaries(kernel, dashBytes, lazyBinaries);

    // nginx and php-fpm binaries as lazy files
    const lazyFiles: Array<{ path: string; url: string; size: number; mode: number }> = [];
    if (nginxSize > 0) {
      lazyFiles.push({ path: "/usr/sbin/nginx", url: nginxWasmUrl, size: nginxSize, mode: 0o755 });
    }
    if (phpFpmSize > 0) {
      lazyFiles.push({ path: "/usr/sbin/php-fpm", url: phpFpmWasmUrl, size: phpFpmSize, mode: 0o755 });
    }
    if (lazyFiles.length > 0) {
      kernel.registerLazyFiles(lazyFiles);
    }
    // Create /usr/sbin if populateShellBinaries didn't
    try { fs.mkdir("/usr/sbin", 0o755); } catch { /* exists */ }

    // nginx config and directories — WordPress routes all requests through FPM router
    populateNginxConfig(fs, {
      extraLocations: FASTCGI_LOCATION,
    });

    // php-fpm config and directories
    populatePhpFpmConfig(fs);

    // WordPress-specific directories
    ensureDirRecursive(fs, "/var/www/html/wp-content/database");
    ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");

    // Write init service descriptors
    writeInitDescriptor(fs, "10-php-fpm", {
      type: "daemon",
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",
      ready: "delay:5000",
    });

    writeInitDescriptor(fs, "20-nginx", {
      type: "daemon",
      command: "/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
      depends: "php-fpm",
      ready: "delay:3000",
      bridge: "8080",
    });

    writeInitDescriptor(fs, "99-shell", {
      type: "interactive",
      command: "/bin/dash -i",
      env: "TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",
      pty: "true",
      cwd: "/root",
    });

    // Create SystemInit and boot
    setStatus("Booting system...", "loading");
    init = new SystemInit(kernel, {
      onLog: (msg, level) => appendLog(msg + "\n", level === "info" ? "info" : "stderr"),
      terminalContainer: terminalPanel,
      serviceWorkerUrl: SW_URL,
      appPrefix: APP_PREFIX,
      onBeforeService: async (name) => {
        if (name === "shell") {
          // Load WordPress bundle after daemons are running but before the shell
          setStatus("Loading WordPress files...", "loading");
          const loaded = await loadWordPressBundle(
            kernel!.fs,
            import.meta.env.BASE_URL + "wp-bundle.json",
            (current, total) => {
              if (current % 500 === 0 || current === total) {
                appendLog(`  ${current}/${total} files\n`, "info");
              }
            },
          );
          appendLog(`WordPress loaded: ${loaded} files\n`, "info");

          // Remove any pre-existing database so WordPress starts with a fresh install
          try { kernel!.fs.unlink("/var/www/html/wp-content/database/wordpress.db"); } catch { /* not present */ }

          // Overwrite wp-config.php so WordPress generates URLs with the app
          // prefix that the service worker intercepts
          writeVfsFile(kernel!.fs, "/var/www/html/wp-config.php", WP_CONFIG_PHP);
          writeVfsFile(kernel!.fs, "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php", MU_PLUGIN_PHP);

          // Load the frame now that WordPress files are in the VFS
          setStatus("WordPress running!", "running");
          reloadBtn.disabled = false;
          loadFrame();
        }
      },
    });

    await init.boot();
  } catch (e) {
    appendLog(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
    startBtn.disabled = false;
  }
}

function loadFrame() {
  // Replace the iframe entirely — removing srcdoc and setting src on the
  // same element doesn't reliably trigger navigation in Chromium.
  const next = document.createElement("iframe");
  next.id = "frame";
  next.src = APP_PREFIX;
  frame.replaceWith(next);
  frame = next;
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
