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
const frame = document.getElementById("frame") as HTMLIFrameElement;

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

// nginx config for WordPress — routes PHP through FastCGI
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
    uwsgi_temp_path /tmp/nginx_uwsgi_temp;
    scgi_temp_path /tmp/nginx_scgi_temp;

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
        index index.php index.html;

        # Try static files first, then pass to PHP
        location / {
            try_files $uri $uri/ /index.php?$args;
        }

        # Pass all .php files to PHP-FPM
        location ~ \\.php$ {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_index index.php;
            fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
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
            fastcgi_param REDIRECT_STATUS 200;
            fastcgi_param HTTP_HOST $http_host;
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
    kernel = new BrowserKernel({
      maxWorkers: 8,
      fsSize: 64 * 1024 * 1024, // 64MB for WordPress
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

    // Set up the bridge to handle incoming requests
    bridge.onRequest((requestId, request) => {
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

async function loadFrame() {
  try {
    const resp = await fetch("/app/");
    const html = await resp.text();
    frame.srcdoc = html;
  } catch (err) {
    frame.srcdoc = `<p style="color:red;padding:1rem">Failed to load: ${err}</p>`;
  }
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

    const activeSw = reg.active!;
    activeSw.postMessage(
      { type: "init-bridge", appPrefix: "/app/" },
      [bridge.getSwPort()],
    );

    return reg;
  } catch (err) {
    appendLog(`Service worker error: ${err}\n`, "stderr");
    return null;
  }
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
