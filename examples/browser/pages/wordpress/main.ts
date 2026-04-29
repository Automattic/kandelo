/**
 * WordPress browser demo — runs nginx + PHP-FPM inside the POSIX kernel,
 * with WordPress + SQLite Database Integration plugin pre-loaded from a
 * VFS image for instant boot.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * Process layout:
 *   pid 1: php-fpm master -> forks pid 2 (worker)
 *   pid 3: nginx master   -> forks pid 4, 5 (workers)
 *
 * The VFS image (wordpress.vfs) is built at build time and contains all
 * WordPress files, system configs, directory structure, dash binary, and
 * symlinks. At runtime we only need to:
 *   1. Restore the image into a MemoryFileSystem
 *   2. Register lazy binaries (nginx, php-fpm, coreutils, grep, sed)
 *   3. Write the dynamic wp-config.php (depends on runtime URL/protocol)
 *
 * Service worker intercepts ${BASE_URL}app/* requests and routes them through
 * the kernel's TCP stack to nginx.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { decompressVfsImage } from "../../../../host/src/vfs/load-image";
import { SystemInit } from "../../lib/init/system-init";
import { COREUTILS_NAMES } from "../../lib/init/shell-binaries";
import { writeVfsFile } from "../../lib/init/vfs-utils";
import kernelWasmUrl from "@kernel-wasm?url";
import nginxWasmUrl from "../../../../binaries/programs/wasm32/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../binaries/programs/wasm32/php/php-fpm.wasm?url";
import coreutilsWasmUrl from "../../../../binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "../../../../binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "../../../../binaries/programs/wasm32/sed.wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/wordpress.vfs?url";
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

// Custom wp-config.php — sets WP_HOME/WP_SITEURL with app prefix so
// WordPress generates URLs the service worker can intercept.
// This depends on runtime APP_PREFIX and PROTO, so it can't be in the image.
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
    // Fetch kernel wasm, VFS image, and lazy binary sizes in parallel
    appendLog("Fetching kernel wasm and VFS image...\n", "info");
    const [kernelBytes, vfsImageBuf, nginxSize, phpFpmSize, coreutilsSize, grepSize, sedSize] =
      await Promise.all([
        fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
        fetch(VFS_IMAGE_URL).then((r) => {
          if (!r.ok) {
            throw new Error(
              `Failed to load VFS image from ${VFS_IMAGE_URL} (${r.status}). ` +
              `Run: bash examples/browser/scripts/build-wp-vfs-image.sh`
            );
          }
          return r.arrayBuffer();
        }),
        fetchSize(nginxWasmUrl),
        fetchSize(phpFpmWasmUrl),
        fetchSize(coreutilsWasmUrl),
        fetchSize(grepWasmUrl),
        fetchSize(sedWasmUrl),
      ]);

    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `VFS image: ${(vfsImageBuf.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    // Restore MemoryFileSystem from the pre-built VFS image
    appendLog("Restoring VFS from image...\n", "info");
    const maxFsSize = 1024 * 1024 * 1024; // 1GB max growth
    const memfs = MemoryFileSystem.fromImage(decompressVfsImage(new Uint8Array(vfsImageBuf)), {
      maxByteLength: maxFsSize,
    });

    // Create kernel with pre-built filesystem
    // Use 4096 pages (256MB) per process instead of default 16384 (1GB)
    // to avoid exhausting browser memory with 5+ concurrent processes
    kernel = new BrowserKernel({
      memfs,
      maxWorkers: 8,
      maxMemoryPages: 4096,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Register lazy binaries — the image already has all symlinks,
    // we just need to create the stub files and register URLs
    const lazyFiles: Array<{ path: string; url: string; size: number; mode?: number }> = [];
    if (nginxSize > 0) {
      lazyFiles.push({ path: "/usr/sbin/nginx", url: nginxWasmUrl, size: nginxSize, mode: 0o755 });
    }
    if (phpFpmSize > 0) {
      lazyFiles.push({ path: "/usr/sbin/php-fpm", url: phpFpmWasmUrl, size: phpFpmSize, mode: 0o755 });
    }
    if (coreutilsSize > 0) {
      lazyFiles.push({ path: "/bin/coreutils", url: coreutilsWasmUrl, size: coreutilsSize, mode: 0o755 });
    }
    if (grepSize > 0) {
      lazyFiles.push({ path: "/usr/bin/grep", url: grepWasmUrl, size: grepSize, mode: 0o755 });
    }
    if (sedSize > 0) {
      lazyFiles.push({ path: "/usr/bin/sed", url: sedWasmUrl, size: sedSize, mode: 0o755 });
    }
    if (lazyFiles.length > 0) {
      kernel.registerLazyFiles(lazyFiles);
    }

    // Write dynamic wp-config.php (depends on runtime APP_PREFIX and PROTO)
    writeVfsFile(kernel.fs, "/var/www/html/wp-config.php", WP_CONFIG_PHP);

    // Remove any pre-existing database so WordPress starts with a fresh install
    try { kernel.fs.unlink("/var/www/html/wp-content/database/wordpress.db"); } catch { /* not present */ }

    // Create SystemInit and boot
    setStatus("Booting system...", "loading");
    init = new SystemInit(kernel, {
      onLog: (msg, level) => appendLog(msg + "\n", level === "info" ? "info" : "stderr"),
      terminalContainer: terminalPanel,
      serviceWorkerUrl: SW_URL,
      appPrefix: APP_PREFIX,
      onBeforeService: async (name) => {
        if (name === "shell") {
          // WordPress files are already in the VFS from the image — just show the frame
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
