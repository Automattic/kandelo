/**
 * nginx browser demo — runs nginx inside the POSIX kernel,
 * with a service worker intercepting fetch requests to serve pages.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { SystemInit } from "../../lib/init/system-init";
import { populateNginxConfig } from "../../lib/init/nginx-config";
import {
  populateShellBinaries,
  type BinaryDef,
  COREUTILS_NAMES,
} from "../../lib/init/shell-binaries";
import { writeVfsFile, writeInitDescriptor } from "../../lib/init/vfs-utils";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
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

/** Static HTML served by nginx. */
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
  setStatus("Loading kernel, nginx, and dash...", "loading");

  try {
    // Fetch kernel and dash eagerly; get nginx size for lazy registration
    appendLog("Fetching kernel and dash wasm...\n", "info");
    const [kernelBytes, dashBytes, nginxSize] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
      fetchSize(nginxWasmUrl),
    ]);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `dash: ${(dashBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `nginx: ${(nginxSize / (1024 * 1024)).toFixed(1)}MB (lazy)\n`,
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

    // nginx binary as lazy file
    if (nginxSize > 0) {
      kernel.registerLazyFiles([
        { path: "/usr/sbin/nginx", url: nginxWasmUrl, size: nginxSize, mode: 0o755 },
      ]);
    }
    // Create /usr/sbin if populateShellBinaries didn't
    try { fs.mkdir("/usr/sbin", 0o755); } catch { /* exists */ }

    // nginx config and directories
    populateNginxConfig(fs);

    // Static content
    writeVfsFile(fs, "/var/www/html/index.html", INDEX_HTML);

    // Write init service descriptors
    writeInitDescriptor(fs, "10-nginx", {
      type: "daemon",
      command: "/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
      ready: "delay:2000",
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
          setStatus("nginx is running! Loading page in iframe...", "running");
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
  next.src = APP_PREFIX;
  frame.replaceWith(next);
  frame = next;
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
