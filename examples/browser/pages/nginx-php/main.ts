/**
 * nginx + PHP-FPM browser demo — runs nginx and php-fpm inside the POSIX
 * kernel, with a service worker intercepting fetch requests.
 *
 * Process layout:
 *   pid 1: php-fpm master → forks pid 2 (worker)
 *   pid 3: nginx master   → forks pid 4, 5 (workers)
 *
 * FastCGI traffic flows over kernel loopback (127.0.0.1:9000).
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { loadFiles } from "../../lib/fs-loader";
import { HttpBridgeHost } from "../../lib/http-bridge";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../examples/nginx/php-fpm.wasm?url";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";

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

// nginx config for browser — with FastCGI to php-fpm
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

    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/json json;
        image/png png;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/html;
        index index.php index.html;

        location / {
        }

        # Exact match — no PCRE regex needed
        location = /index.php {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME $document_root/index.php;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param HTTP_X_FORWARDED_PROTO $http_x_forwarded_proto;
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
`;

const INDEX_PHP = `<?php
$uptime = time();
$mem = memory_get_usage(true);
$extensions = get_loaded_extensions();
sort($extensions);
?>
<!DOCTYPE html>
<html>
<head>
    <title>PHP-FPM on wasm-posix-kernel</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
        h1 { color: #333; }
        .info { background: #f0f0f0; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
        table { border-collapse: collapse; width: 100%; }
        td, th { padding: 0.4rem; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f5f5f5; }
        code { background: #e0e0e0; padding: 0.2rem 0.4rem; border-radius: 2px; }
    </style>
</head>
<body>
    <h1>PHP-FPM on WebAssembly</h1>
    <div class="info">
        <p>This page is served by <strong>nginx</strong> + <strong>PHP-FPM</strong>, both
        running inside a POSIX kernel compiled to WebAssembly.</p>
        <p>FastCGI traffic between nginx and PHP-FPM flows over the kernel's
        internal loopback (127.0.0.1:9000).</p>
    </div>
    <table>
        <tr><th>Property</th><th>Value</th></tr>
        <tr><td>PHP Version</td><td><?= PHP_VERSION ?></td></tr>
        <tr><td>OS</td><td><?= PHP_OS ?></td></tr>
        <tr><td>SAPI</td><td><?= php_sapi_name() ?></td></tr>
        <tr><td>Memory</td><td><?= number_format($mem / 1024) ?> KB</td></tr>
        <tr><td>Server Software</td><td><?= $_SERVER['SERVER_SOFTWARE'] ?? 'N/A' ?></td></tr>
        <tr><td>Server Protocol</td><td><?= $_SERVER['SERVER_PROTOCOL'] ?? 'N/A' ?></td></tr>
    </table>
    <h3 style="margin-top: 1rem">Loaded Extensions (<?= count($extensions) ?>)</h3>
    <p style="font-size: 0.85rem; color: #666">
        <?= implode(', ', $extensions) ?>
    </p>
    <h3 style="margin-top: 1rem">Architecture</h3>
    <ol>
        <li>Browser fetch &rarr; Service Worker intercepts</li>
        <li>Service Worker &rarr; MessageChannel &rarr; Main Thread</li>
        <li>Main Thread injects TCP connection into kernel</li>
        <li>nginx (Wasm) accepts, routes <code>.php</code> to FastCGI</li>
        <li>PHP-FPM (Wasm) processes PHP via kernel loopback</li>
        <li>Response flows back through the same pipe</li>
    </ol>
</body>
</html>
`;

let kernel: BrowserKernel | null = null;
let bridge: HttpBridgeHost | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading kernel, nginx, and PHP-FPM...", "loading");

  try {
    // Fetch all wasm binaries in parallel
    appendLog("Fetching wasm binaries...\n", "info");
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

    // Initialize service worker bridge
    appendLog("Initializing service worker bridge...\n", "info");
    if (!(await initBridge(bridge))) {
      setStatus("Service worker initialization failed", "error");
      return;
    }
    appendLog("Service worker bridge ready\n", "info");

    // Create kernel
    kernel = new BrowserKernel({
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Populate filesystem
    appendLog("Populating filesystem...\n", "info");
    const fs = kernel.fs;

    for (const dir of [
      "/etc/nginx",
      "/var/www/html",
      "/var/log/nginx",
      "/tmp/nginx_client_temp",
      "/tmp/nginx_fastcgi_temp",
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

    await loadFiles(fs, [
      { path: "/etc/nginx/nginx.conf", data: NGINX_CONF },
      { path: "/etc/php-fpm.conf", data: PHP_FPM_CONF },
      { path: "/var/www/html/index.php", data: INDEX_PHP },
    ]);

    // Transfer bridge host port to the kernel worker for connection pump (nginx on 8080)
    kernel.sendBridgePort(bridge.detachHostPort(), 8080);

    // --- Start php-fpm first (pid 1) ---
    setStatus("Starting PHP-FPM...", "loading");
    appendLog("Starting PHP-FPM (pid 1)...\n", "info");

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

    // --- Start nginx (pid 3, since pid 2 = php-fpm worker) ---
    setStatus("Starting nginx...", "loading");
    appendLog("Starting nginx (pid 3)...\n", "info");

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

    setStatus("nginx + PHP-FPM running! Loading page...", "running");
    reloadBtn.disabled = false;

    // Load the PHP page via the service worker bridge
    loadFrame();

    // Neither should exit normally
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
  next.src = APP_PREFIX + "index.php";
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
