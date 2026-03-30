/**
 * nginx browser demo — runs nginx inside the POSIX kernel,
 * with a service worker intercepting fetch requests to serve pages.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { loadFiles } from "../../lib/fs-loader";
import { HttpBridgeHost } from "../../lib/http-bridge";
import { handleHttpRequest } from "../../lib/connection-pump";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";

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

// nginx config for browser — simpler, no FastCGI
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
        index index.html;

        location / {
        }
    }
}
`;

const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
    <title>nginx on wasm-posix-kernel</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
        h1 { color: #333; }
        .info { background: #f0f0f0; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
        code { background: #e0e0e0; padding: 0.2rem 0.4rem; border-radius: 2px; }
    </style>
</head>
<body>
    <h1>Hello from nginx on WebAssembly!</h1>
    <div class="info">
        <p>This page is being served by <strong>nginx</strong> running inside a
        POSIX kernel compiled to WebAssembly.</p>
        <p>The request was intercepted by a Service Worker, routed through
        a MessageChannel bridge to the kernel, where nginx processed it
        and returned this response.</p>
    </div>
    <p>Architecture:</p>
    <ol>
        <li>Browser fetch &rarr; Service Worker intercepts</li>
        <li>Service Worker &rarr; MessageChannel &rarr; Main Thread</li>
        <li>Main Thread injects TCP connection into kernel</li>
        <li>nginx (Wasm) accepts, reads request, serves file</li>
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
  setStatus("Loading kernel and nginx...", "loading");

  try {
    // Fetch kernel and nginx wasm in parallel
    appendLog("Fetching kernel and nginx wasm...\n", "info");
    const [kernelBytes, nginxBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(nginxWasmUrl).then((r) => r.arrayBuffer()),
    ]);
    appendLog(`Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, nginx: ${(nginxBytes.byteLength / 1024).toFixed(0)}KB\n`, "info");

    // Set up HTTP bridge (MessageChannel-based)
    bridge = new HttpBridgeHost();

    // Register service worker
    appendLog("Registering service worker...\n", "info");
    const swRegistration = await registerServiceWorker(bridge);
    if (!swRegistration) {
      setStatus("Service worker registration failed", "error");
      return;
    }
    appendLog("Service worker active\n", "info");

    // Create kernel
    kernel = new BrowserKernel({
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Populate filesystem
    appendLog("Populating filesystem...\n", "info");
    const fs = kernel.fs;

    // Create directories nginx expects
    for (const dir of [
      "/etc/nginx",
      "/var/www/html",
      "/var/log/nginx",
      "/tmp/nginx_client_temp",
      "/tmp/nginx-wasm/logs",
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
      { path: "/var/www/html/index.html", data: INDEX_HTML },
    ]);

    // Set up the bridge to handle incoming requests
    bridge.onRequest((requestId, request) => {
      appendLog(`[bridge] ${request.method} ${request.url}\n`, "info");
      handleHttpRequest(kernel!, bridge!, requestId, request, 8080);
    });

    // Start nginx
    setStatus("Starting nginx (forking workers)...", "loading");
    appendLog("Starting nginx...\n", "info");

    // nginx needs prefix path for finding config
    const exitPromise = kernel.spawn(nginxBytes, [
      "nginx",
      "-p", "/etc/nginx",
      "-c", "nginx.conf",
    ], {
      env: [
        "HOME=/root",
        "TMPDIR=/tmp",
        "PATH=/usr/bin:/bin",
      ],
    });

    // Wait a bit for nginx to start and fork workers
    await new Promise((r) => setTimeout(r, 2000));

    setStatus("nginx is running! Loading page in iframe...", "running");
    reloadBtn.disabled = false;

    // Load the served page in the iframe
    loadFrame();

    // nginx runs indefinitely — don't await exit
    exitPromise.then((code) => {
      appendLog(`\nnginx exited with code ${code}\n`, "info");
      setStatus(`nginx exited (code ${code})`, "error");
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
    // Fetch via JS — the service worker intercepts /app/* fetch requests
    // (iframe navigations don't work well with COEP + credentialless)
    const resp = await fetch("/app/");
    const html = await resp.text();
    // Use srcdoc to display the fetched HTML
    frame.srcdoc = html;
  } catch (err) {
    frame.srcdoc = `<p style="color:red;padding:1rem">Failed to load: ${err}</p>`;
  }
}

async function registerServiceWorker(
  bridge: HttpBridgeHost,
): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    appendLog("Service Workers not supported in this browser\n", "stderr");
    return null;
  }

  try {
    // The service worker file needs to be served from the same origin
    const reg = await navigator.serviceWorker.register(
      new URL("../../lib/service-worker.ts", import.meta.url),
      { type: "module", scope: "/" },
    );

    // Wait for the service worker to be active
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
        // Resolve immediately if already activated
        if (sw.state === "activated") resolve();
      });
    }

    // Send the MessagePort to the service worker (no SAB needed)
    const activeSw = reg.active!;
    activeSw.postMessage(
      {
        type: "init-bridge",
        appPrefix: "/app/",
      },
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
