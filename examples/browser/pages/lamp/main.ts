/**
 * WordPress (LAMP) browser demo — nginx + MariaDB + PHP-FPM + WordPress,
 * pre-loaded from a VFS image for instant boot.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * Process layout:
 *   pid 1: mariadbd --bootstrap (oneshot, terminated after stdin consumed)
 *   pid 2: mariadbd server (daemon, spawns 5 background threads)
 *   pid N: php-fpm master -> forks worker
 *   pid N: nginx master   -> forks workers
 *   pid N: dash -i (interactive shell with PTY)
 *
 * The VFS image (lamp.vfs) is built at build time and contains all
 * WordPress files, MariaDB binary + bootstrap SQL, system configs,
 * directory structure, dash binary, and symlinks. At runtime we only
 * need to:
 *   1. Restore the image into a MemoryFileSystem
 *   2. Register lazy binaries (nginx, php-fpm, coreutils, grep, sed)
 *   3. Write the dynamic wp-config.php (depends on runtime URL/protocol)
 *
 * MariaDB listens on 127.0.0.1:3306, PHP-FPM on 127.0.0.1:9000,
 * nginx on 127.0.0.1:8080. All inter-process communication flows
 * through the kernel's loopback TCP.
 *
 * Service worker intercepts ${BASE_URL}app/* requests and routes them to nginx.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { SystemInit } from "../../lib/init/system-init";
import { writeVfsFile } from "../../lib/init/vfs-utils";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../examples/nginx/php-fpm.wasm?url";
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
const VFS_IMAGE_URL = import.meta.env.BASE_URL + "lamp.vfs";

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

// WordPress wp-config.php for MySQL/MariaDB — depends on runtime APP_PREFIX
// and PROTO, so it can't be baked into the VFS image.
const WP_CONFIG_PHP = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

define('AUTH_KEY',         'wasm-posix-kernel-lamp');
define('SECURE_AUTH_KEY',  'wasm-posix-kernel-lamp');
define('LOGGED_IN_KEY',    'wasm-posix-kernel-lamp');
define('NONCE_KEY',        'wasm-posix-kernel-lamp');
define('AUTH_SALT',        'wasm-posix-kernel-lamp');
define('SECURE_AUTH_SALT', 'wasm-posix-kernel-lamp');
define('LOGGED_IN_SALT',   'wasm-posix-kernel-lamp');
define('NONCE_SALT',       'wasm-posix-kernel-lamp');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', true);

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
  setStatus("Loading WordPress (LAMP)...", "loading");

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
              `Run: bash examples/browser/scripts/build-lamp-vfs-image.sh`
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
    const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf), {
      maxByteLength: maxFsSize,
    });

    // Create kernel with pre-built filesystem
    kernel = new BrowserKernel({
      memfs,
      maxWorkers: 16,
      maxMemoryPages: 4096,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => {
        const text = decoder.decode(data);
        appendLog(text, "stderr");
        console.log(`[STDERR] ${text.trim()}`);
      },
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

    // Create SystemInit and boot
    setStatus("Booting system...", "loading");
    init = new SystemInit(kernel, {
      onLog: (msg, level) => appendLog(msg + "\n", level === "info" ? "info" : "stderr"),
      terminalContainer: terminalPanel,
      serviceWorkerUrl: SW_URL,
      appPrefix: APP_PREFIX,
      onBeforeService: async (name) => {
        if (name === "shell") {
          // WordPress files and MariaDB are already in the VFS from the image
          setStatus("LEMP stack running!", "running");
          reloadBtn.disabled = false;
          loadFrame();
        }
      },
      onServiceReady: (name) => {
        if (name === "mariadb-bootstrap") {
          appendLog("Bootstrap complete\n", "info");
        }
      },
    });

    await init.boot();
  } catch (e: any) {
    const msg = e?.message || String(e);
    appendLog(`\nError: ${msg}\n`, "stderr");
    setStatus(`Error: ${msg}`, "error");
    console.error(e);
    startBtn.disabled = false;
  }
}

function loadFrame() {
  const next = document.createElement("iframe");
  next.id = "frame";
  next.src = APP_PREFIX;
  frame.replaceWith(next);
  frame = next;
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
