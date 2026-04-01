/**
 * WordPress browser demo — runs nginx + PHP-FPM inside the POSIX kernel,
 * with WordPress + SQLite Database Integration plugin pre-loaded into
 * the in-memory filesystem.
 *
 * Process layout:
 *   pid 1: php-fpm master → forks pid 2 (worker)
 *   pid 3: nginx master   → forks pid 4, 5 (workers)
 *
 * Service worker intercepts /app/* requests and routes them through
 * the kernel's TCP stack to nginx.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { loadFiles } from "../../lib/fs-loader";
import { loadWordPressBundle } from "../../lib/wp-bundle";
import { HttpBridgeHost } from "../../lib/http-bridge";
import { handleHttpRequest } from "../../lib/connection-pump";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../examples/nginx/php-fpm.wasm?url";

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
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

// nginx config for WordPress — all requests go through the FPM router
// (nginx built without PCRE, so regex locations are unavailable)
const NGINX_CONF = `daemon off;
master_process on;
worker_processes 2;
error_log stderr info;
pid /tmp/nginx.pid;

events {
    worker_connections 64;
    use poll;
}

http {
    access_log /dev/stderr;
    client_body_temp_path /tmp/nginx_client_temp;
    fastcgi_temp_path /tmp/nginx_fastcgi_temp;
    proxy_temp_path /tmp/nginx_proxy_temp;

    default_type application/octet-stream;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/html;

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
        }
    }
}
`;

// PHP FPM router — serves static files directly, routes PHP through WordPress
const FPM_ROUTER_PHP = `<?php
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$docRoot = $_SERVER['DOCUMENT_ROOT'];
$file = $docRoot . $uri;

$staticTypes = [
    'css'   => 'text/css',
    'js'    => 'text/javascript',
    'json'  => 'application/json',
    'png'   => 'image/png',
    'jpg'   => 'image/jpeg',
    'jpeg'  => 'image/jpeg',
    'gif'   => 'image/gif',
    'svg'   => 'image/svg+xml',
    'ico'   => 'image/x-icon',
    'woff'  => 'font/woff',
    'woff2' => 'font/woff2',
    'ttf'   => 'font/ttf',
    'eot'   => 'application/vnd.ms-fontobject',
    'map'   => 'application/json',
    'xml'   => 'application/xml',
    'txt'   => 'text/plain',
];

if ($uri !== '/' && is_file($file)) {
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if (isset($staticTypes[$ext])) {
        header('Content-Type: ' . $staticTypes[$ext]);
        header('Content-Length: ' . filesize($file));
        readfile($file);
        exit;
    }
    if ($ext === 'php') {
        chdir(dirname($file));
        include $file;
        exit;
    }
}

chdir($docRoot);
include $docRoot . '/index.php';
`;

const PHP_FPM_CONF = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
listen = 127.0.0.1:9000
pm = static
pm.max_children = 1
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
request_terminate_timeout = 120
`;

// Custom wp-config.php — sets WP_HOME/WP_SITEURL with /app prefix so
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
define('WP_DEBUG_DISPLAY', true);

// Site URL includes /app prefix — the service worker intercepts /app/*
// and strips it before sending to nginx
if (isset($_SERVER['HTTP_HOST'])) {
    define('WP_HOME', 'http://' . $_SERVER['HTTP_HOST'] . '/app');
    define('WP_SITEURL', 'http://' . $_SERVER['HTTP_HOST'] . '/app');
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

let kernel: BrowserKernel | null = null;
let bridge: HttpBridgeHost | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading WordPress...", "loading");

  try {
    // Fetch all resources in parallel
    appendLog("Fetching wasm binaries + WordPress bundle...\n", "info");
    const [kernelBytes, nginxBytes, phpFpmBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(nginxWasmUrl).then((r) => r.arrayBuffer()),
      fetch(phpFpmWasmUrl).then((r) => r.arrayBuffer()),
    ]);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
        `nginx: ${(nginxBytes.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
        `PHP-FPM: ${(phpFpmBytes.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    // Set up HTTP bridge
    bridge = new HttpBridgeHost();

    // Register service worker
    appendLog("Registering service worker...\n", "info");
    const swRegistration = await registerServiceWorker(bridge);
    if (!swRegistration) {
      setStatus("Service worker registration failed", "error");
      return;
    }
    appendLog("Service worker active\n", "info");

    // Create kernel with larger FS for WordPress
    // Use 4096 pages (256MB) per process instead of default 16384 (1GB)
    // to avoid exhausting browser memory with 5+ concurrent processes
    kernel = new BrowserKernel({
      maxWorkers: 8,
      fsSize: 256 * 1024 * 1024, // 256MB for full WordPress bundle
      maxMemoryPages: 4096, // 256MB per process
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Create directory structure
    const fs = kernel.fs;
    for (const dir of [
      "/etc/nginx",
      "/var/www/html",
      "/var/www/html/wp-content",
      "/var/www/html/wp-content/database",
      "/var/www/html/wp-content/mu-plugins",
      "/var/log/nginx",
      "/tmp/nginx_client_temp",
      "/tmp/nginx_fastcgi_temp",
      "/tmp/nginx_proxy_temp",
      "/tmp/nginx-wasm/logs",
      "/etc/php-fpm.d",
    ]) {
      const parts = dir.split("/").filter(Boolean);
      let cur = "";
      for (const p of parts) {
        cur += "/" + p;
        try { fs.mkdir(cur, 0o755); } catch { /* exists */ }
      }
    }

    // Write config files
    await loadFiles(fs, [
      { path: "/etc/nginx/nginx.conf", data: NGINX_CONF },
      { path: "/etc/php-fpm.conf", data: PHP_FPM_CONF },
      { path: "/var/www/fpm-router.php", data: FPM_ROUTER_PHP },
    ]);

    // Load WordPress bundle
    setStatus("Loading WordPress files...", "loading");
    appendLog("Loading WordPress bundle...\n", "info");
    const loaded = await loadWordPressBundle(fs, "/wp-bundle.json", (current, total) => {
      if (current % 500 === 0 || current === total) {
        appendLog(`  ${current}/${total} files\n`, "info");
      }
    });
    appendLog(`WordPress loaded: ${loaded} files\n`, "info");

    // Overwrite wp-config.php so WordPress generates URLs with the /app/
    // prefix that the service worker intercepts
    await loadFiles(fs, [
      { path: "/var/www/html/wp-config.php", data: WP_CONFIG_PHP },
      { path: "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php", data: MU_PLUGIN_PHP },
    ]);

    // Set up the bridge to handle incoming requests
    bridge.onRequest((requestId, request) => {
      console.log(`[wp-bridge] request #${requestId}: ${request.method} ${request.url}`);
      appendLog(`[bridge] ${request.method} ${request.url}\n`, "info");
      handleHttpRequest(kernel!, bridge!, requestId, request, 8080);
    });

    // --- Start php-fpm (pid 1) ---
    setStatus("Starting PHP-FPM...", "loading");
    appendLog("Starting PHP-FPM...\n", "info");

    const fpmExitPromise = kernel.spawn(phpFpmBytes, [
      "php-fpm",
      "-y", "/etc/php-fpm.conf",
      "-c", "/dev/null",
      "--nodaemonize",
    ], {
      env: [
        "HOME=/tmp",
        "TMPDIR=/tmp",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ],
    });

    // Wait for php-fpm to start and fork worker
    await new Promise((r) => setTimeout(r, 3000));
    appendLog("PHP-FPM ready\n", "info");

    // --- Start nginx ---
    setStatus("Starting nginx...", "loading");
    appendLog("Starting nginx...\n", "info");

    const nginxExitPromise = kernel.spawn(nginxBytes, [
      "nginx",
      "-p", "/etc/nginx",
      "-c", "nginx.conf",
    ], {
      env: [
        "HOME=/tmp",
        "TMPDIR=/tmp",
        "PATH=/usr/bin:/bin",
      ],
    });

    // Wait for nginx to start and fork workers
    await new Promise((r) => setTimeout(r, 2000));

    setStatus("WordPress running! Loading page...", "running");
    reloadBtn.disabled = false;

    // Load WordPress via the service worker bridge
    loadFrame();

    fpmExitPromise.then((code) => {
      appendLog(`\nphp-fpm exited with code ${code}\n`, "info");
    });
    nginxExitPromise.then((code) => {
      appendLog(`\nnginx exited with code ${code}\n`, "info");
    });
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
  next.src = "/app/";
  frame.replaceWith(next);
  frame = next;
}

async function registerServiceWorker(
  bridge: HttpBridgeHost,
): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    appendLog("Service Workers not supported\n", "stderr");
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register(
      new URL("../../lib/service-worker.ts", import.meta.url),
      { type: "module", scope: "/" },
    );

    const sw = reg.active || reg.installing || reg.waiting;
    if (!sw) {
      appendLog("No service worker found after registration\n", "stderr");
      return null;
    }

    if (sw.state !== "activated") {
      await new Promise<void>((resolve) => {
        sw.addEventListener("statechange", () => {
          if (sw.state === "activated") resolve();
        });
        if (sw.state === "activated") resolve();
      });
    }

    // Wait for the SW to claim this client so fetch events are intercepted
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve());
      });
    }

    // Send bridge port and wait for SW to confirm it's initialized
    const activeSw = reg.active!;
    await new Promise<void>((resolve) => {
      const reply = new MessageChannel();
      reply.port1.onmessage = () => resolve();
      activeSw.postMessage(
        { type: "init-bridge", appPrefix: "/app/" },
        [bridge.getSwPort(), reply.port2],
      );
    });

    return reg;
  } catch (err) {
    appendLog(`Service worker error: ${err}\n`, "stderr");
    return null;
  }
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
