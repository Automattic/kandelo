/**
 * nginx + PHP-FPM browser demo — runs nginx and php-fpm inside the POSIX
 * kernel, with a service worker intercepting fetch requests.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * Process layout:
 *   pid 1: php-fpm master → forks pid 2 (worker)
 *   pid 3: nginx master   → forks pid 4, 5 (workers)
 *
 * FastCGI traffic flows over kernel loopback (127.0.0.1:9000).
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
import { writeVfsFile, writeInitDescriptor } from "../../lib/init/vfs-utils";
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

/** FastCGI location block for routing .php requests to php-fpm. */
const FASTCGI_LOCATION = `        # Exact match — no PCRE regex needed
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
            fastcgi_param REDIRECT_STATUS 200;
        }`;

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
  setStatus("Loading kernel, nginx, PHP-FPM, and dash...", "loading");

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

    // Create kernel
    kernel = new BrowserKernel({
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

    // nginx config and directories (with FastCGI location block)
    populateNginxConfig(fs, {
      extraLocations: FASTCGI_LOCATION,
    });

    // php-fpm config and directories
    populatePhpFpmConfig(fs);

    // Static content — the index.php served by nginx + php-fpm
    writeVfsFile(fs, "/var/www/html/index.php", INDEX_PHP);

    // Write init service descriptors
    writeInitDescriptor(fs, "10-php-fpm", {
      type: "daemon",
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",
      ready: "port:9000",
    });

    writeInitDescriptor(fs, "20-nginx", {
      type: "daemon",
      command: "/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
      depends: "php-fpm",
      ready: "port:8080",
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
      onServiceReady: (name) => {
        if (name === "nginx") {
          setStatus("nginx + PHP-FPM running! Loading page...", "running");
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
  const next = document.createElement("iframe");
  next.id = "frame";
  next.src = APP_PREFIX + "index.php";
  frame.replaceWith(next);
  frame = next;
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
