/**
 * Full LAMP stack browser demo — MariaDB + PHP-FPM + nginx + WordPress.
 *
 * Process layout:
 *   pid 1: mariadbd (main process, spawns 5 background threads)
 *   pid 3: php-fpm master → forks pid 4 (worker)
 *   pid 5: nginx master   → forks pid 6, 7 (workers)
 *
 * MariaDB listens on 127.0.0.1:3306, PHP-FPM on 127.0.0.1:9000,
 * nginx on 127.0.0.1:8080. All inter-process communication flows
 * through the kernel's loopback TCP.
 *
 * Service worker intercepts ${BASE_URL}app/* requests and routes them to nginx.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { loadFiles } from "../../lib/fs-loader";
import { loadWordPressBundle } from "../../lib/wp-bundle";
import { HttpBridgeHost } from "../../lib/http-bridge";
import { patchWasmForThread } from "../../../../host/src/worker-main";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../examples/nginx/php-fpm.wasm?url";
import mariadbWasmUrl from "../../../../examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm?url";
import systemTablesUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql?url";
import systemDataUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql?url";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
// Without trailing slash, for embedding in PHP config strings
const APP_PATH = import.meta.env.BASE_URL + "app";

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

// nginx config — all requests go through the FPM router
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

    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/javascript js;
        application/json json;
        image/png png;
        image/jpeg jpg jpeg;
        image/gif gif;
        image/svg+xml svg;
        image/x-icon ico;
        font/woff woff;
        font/woff2 woff2;
        application/x-font-ttf ttf;
    }
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

// FPM router: serves static files directly, routes PHP through WordPress
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

// WordPress wp-config.php for MySQL/MariaDB
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
    define('WP_HOME', 'http://' . $_SERVER['HTTP_HOST'] . '${APP_PATH}');
    define('WP_SITEURL', 'http://' . $_SERVER['HTTP_HOST'] . '${APP_PATH}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;

let kernel: BrowserKernel | null = null;
let bridge: HttpBridgeHost | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading LAMP stack...", "loading");

  try {
    // Fetch all resources in parallel
    appendLog("Fetching wasm binaries + MariaDB bootstrap SQL...\n", "info");
    const [kernelBytes, mariadbBytes, nginxBytes, phpFpmBytes, systemTablesSql, systemDataSql] =
      await Promise.all([
        fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
        fetch(mariadbWasmUrl).then((r) => r.arrayBuffer()),
        fetch(nginxWasmUrl).then((r) => r.arrayBuffer()),
        fetch(phpFpmWasmUrl).then((r) => r.arrayBuffer()),
        fetch(systemTablesUrl).then((r) => r.text()),
        fetch(systemDataUrl).then((r) => r.text()),
      ]);

    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
        `MariaDB: ${(mariadbBytes.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
        `nginx: ${(nginxBytes.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
        `PHP-FPM: ${(phpFpmBytes.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    // Pre-compile thread module for MariaDB's background threads
    appendLog("Pre-compiling MariaDB thread module...\n", "info");
    setStatus("Pre-compiling MariaDB thread module...", "loading");
    const threadPatchedBytes = patchWasmForThread(mariadbBytes);
    const threadModule = await WebAssembly.compile(threadPatchedBytes);
    appendLog("Thread module ready\n", "info");

    // Set up HTTP bridge
    bridge = new HttpBridgeHost();

    // Initialize service worker bridge
    appendLog("Initializing service worker bridge...\n", "info");
    if (!(await initBridge(bridge))) {
      setStatus("Service worker initialization failed", "error");
      return;
    }
    appendLog("Service worker bridge ready\n", "info");

    // Create kernel with thread support + large FS for WordPress
    kernel = new BrowserKernel({
      maxWorkers: 16,
      fsSize: 128 * 1024 * 1024, // 128MB for WordPress bundle + MariaDB data
      threadModule,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Create directory structure
    const fs = kernel.fs;
    for (const dir of [
      "/data",
      "/data/mysql",
      "/data/tmp",
      "/data/test",
      "/etc/nginx",
      "/var/www/html",
      "/var/www/html/wp-content",
      "/var/log/nginx",
      "/tmp/nginx_client_temp",
      "/tmp/nginx_fastcgi_temp",
      "/tmp/nginx_proxy_temp",
      "/tmp/nginx_uwsgi_temp",
      "/tmp/nginx_scgi_temp",
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

    // Load WordPress bundle (excludes SQLite plugin, uses MySQL wp-config)
    setStatus("Loading WordPress files...", "loading");
    appendLog("Loading WordPress bundle...\n", "info");
    const loaded = await loadWordPressBundle(fs, import.meta.env.BASE_URL + "wp-bundle.json", (current, total) => {
      if (current % 500 === 0 || current === total) {
        appendLog(`  ${current}/${total} files\n`, "info");
      }
    });
    appendLog(`WordPress loaded: ${loaded} files\n`, "info");

    // Overwrite wp-config.php with MySQL version
    const wpConfigData = new TextEncoder().encode(WP_CONFIG_PHP);
    const wpConfigFd = fs.open("/var/www/html/wp-config.php", 0o1102, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
    fs.write(wpConfigFd, wpConfigData, 0, wpConfigData.length);
    fs.close(wpConfigFd);

    // =====================================================================
    // Phase 1: Bootstrap MariaDB
    // =====================================================================
    setStatus("Bootstrapping MariaDB system tables...", "loading");
    appendLog("Bootstrapping MariaDB system tables (this may take a few minutes in browser)...\n", "info");

    // Include CREATE DATABASE in the bootstrap SQL so we only need one bootstrap pass
    const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\nCREATE DATABASE IF NOT EXISTS wordpress;\n`;
    const bootstrapStdin = new TextEncoder().encode(bootstrapSql);

    const bootstrapPid = kernel.nextPid;
    const bootstrapExit = kernel.spawn(mariadbBytes, [
      "mariadbd",
      "--no-defaults",
      "--datadir=/data",
      "--tmpdir=/data/tmp",
      "--default-storage-engine=Aria",
      "--skip-grant-tables",
      "--key-buffer-size=1048576",
      "--table-open-cache=10",
      "--sort-buffer-size=262144",
      "--bootstrap",
      "--log-warnings=0",
    ], {
      stdin: bootstrapStdin,
    });

    // MariaDB bootstrap hangs during shutdown waiting for signal handler thread,
    // so we can't rely on process exit. Poll for stdin consumption instead.
    const stdinConsumed = new Promise<number>((resolve) => {
      const check = async () => {
        if (await kernel!.isStdinConsumed(bootstrapPid)) {
          // Give MariaDB a moment to flush writes after consuming last SQL
          setTimeout(() => resolve(0), 2000);
        } else {
          setTimeout(check, 500);
        }
      };
      setTimeout(check, 1000);
    });

    const bootstrapTimeout = new Promise<number>((r) =>
      setTimeout(() => r(-1), 600000),
    );

    const progressInterval = setInterval(() => {
      appendLog("  Bootstrap still running...\n", "info");
    }, 15000);

    const bootstrapResult = await Promise.race([bootstrapExit, stdinConsumed, bootstrapTimeout]);
    clearInterval(progressInterval);

    if (bootstrapResult === -1) {
      throw new Error("MariaDB bootstrap timed out after 10 minutes. Try reloading the page.");
    }
    appendLog("Bootstrap complete\n", "info");

    // Terminate the bootstrap process — it hangs during shutdown waiting for
    // signal handler thread. Must terminate before server starts so Aria lock
    // files and data directory are released.
    await kernel.terminateProcess(bootstrapPid);
    appendLog("WordPress database ready\n", "info");

    // =====================================================================
    // Phase 2: Start MariaDB server
    // =====================================================================
    setStatus("Starting MariaDB server...", "loading");
    appendLog("Starting MariaDB server on 127.0.0.1:3306...\n", "info");

    kernel.spawn(mariadbBytes, [
      "mariadbd",
      "--no-defaults",
      "--datadir=/data",
      "--tmpdir=/data/tmp",
      "--default-storage-engine=Aria",
      "--skip-grant-tables",
      "--key-buffer-size=1048576",
      "--table-open-cache=10",
      "--sort-buffer-size=262144",
      "--thread-handling=no-threads",
      "--skip-networking=0",
      "--port=3306",
      "--bind-address=0.0.0.0",
      "--socket=",
      "--max-connections=10",
    ]);

    // Poll for MariaDB listener instead of blind wait
    appendLog("Waiting for MariaDB to accept connections...\n", "info");
    for (let attempt = 1; attempt <= 30; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await kernel.pickListenerTarget(3306)) {
        appendLog(`MariaDB ready (after ${attempt}s)\n`, "info");
        break;
      }
      if (attempt === 30) {
        throw new Error("MariaDB did not start listening within 30s");
      }
      if (attempt % 5 === 0) {
        appendLog(`Still waiting for MariaDB... (${attempt}s)\n`, "info");
      }
    }

    // =====================================================================
    // Phase 3: Start PHP-FPM
    // =====================================================================
    setStatus("Starting PHP-FPM...", "loading");
    appendLog("Starting PHP-FPM on 127.0.0.1:9000...\n", "info");

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

    // Wait for PHP-FPM to start and fork worker
    await new Promise((r) => setTimeout(r, 3000));
    appendLog("PHP-FPM ready\n", "info");

    // =====================================================================
    // Phase 4: Start nginx
    // =====================================================================
    setStatus("Starting nginx...", "loading");
    appendLog("Starting nginx on 127.0.0.1:8080...\n", "info");

    // Transfer bridge host port to the kernel worker for connection pump (nginx on 8080)
    kernel.sendBridgePort(bridge.detachHostPort(), 8080);

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

    setStatus("LAMP stack running! Loading WordPress...", "running");
    reloadBtn.disabled = false;
    appendLog("\n=== LAMP stack running ===\n", "info");
    appendLog("  MariaDB: 127.0.0.1:3306\n", "info");
    appendLog("  PHP-FPM: 127.0.0.1:9000\n", "info");
    appendLog("  nginx:   127.0.0.1:8080\n", "info");
    appendLog(`  WordPress: ${APP_PREFIX}\n\n`, "info");

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
  const next = document.createElement("iframe");
  next.id = "frame";
  next.src = APP_PREFIX;
  frame.replaceWith(next);
  frame = next;
}

async function initBridge(bridge: HttpBridgeHost): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    appendLog("Service Workers not supported\n", "stderr");
    return false;
  }

  try {
    // Register the unified service worker (no-op if already registered by COI script)
    await navigator.serviceWorker.register(
      import.meta.env.BASE_URL + "service-worker.js",
    );

    // Wait for the service worker to activate and claim this client
    const reg = await navigator.serviceWorker.ready;

    // Send bridge port and wait for SW to confirm it's initialized
    await new Promise<void>((resolve) => {
      const reply = new MessageChannel();
      reply.port1.onmessage = () => resolve();
      reg.active!.postMessage(
        { type: "init-bridge", appPrefix: APP_PREFIX },
        [bridge.getSwPort(), reply.port2],
      );
    });

    return true;
  } catch (err) {
    appendLog(`Service worker error: ${err}\n`, "stderr");
    return false;
  }
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
