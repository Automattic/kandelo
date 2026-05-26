/**
 * WordPress browser demo — boots a service-demo VFS image with dinit
 * as PID 1. dinit chains:
 *
 *   wp-config-init (scripted) — sed-substitutes @@APP_PATH@@/@@PROTO@@
 *                               from env vars passed by this page.
 *   php-fpm        (process)  — FastCGI on 127.0.0.1:9000
 *   nginx          (process)  — HTTP on :8080, FastCGI proxy to php-fpm
 *
 * The page exposes WP_APP_PATH and WP_PROTO via dinit's env so the
 * scripted wp-config-init service can finalize wp-config.php's
 * runtime-dependent values (WP_HOME / WP_SITEURL).
 *
 * Process layout once boot completes:
 *   pid 100: dinit (PID 1, --container)
 *   pid N:   wp-config-init (sh — short-lived)
 *   pid N+1: php-fpm
 *   pid N+2: nginx
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { setupServiceWorkerFetchBridge } from "../../lib/init/sw-bridge-fetch";
import { TerminalPanel } from "../../lib/init";
import { PtyTerminal } from "../../lib/pty-terminal";
import { resolveShellLazyArchiveUrl } from "../../lib/init/lazy-archives";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  WORDPRESS_URL_MU_PLUGIN,
  wordpressConfigTemplate,
} from "../../lib/init/wordpress-runtime-config";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsFile } from "../../../../host/src/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/wordpress.vfs.zst?url";
import "../../lib/terminal-panel.css";
import "@xterm/xterm/css/xterm.css";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const HTTP_PORT = 8080;
const PHP_FPM_PORT = 9000;
const PHP_FPM_WORKERS = 1;
const PATCHED_PHP_FPM_CONF = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = ${PHP_FPM_WORKERS}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
let frame = document.getElementById("frame") as HTMLIFrameElement;

const decoder = new TextDecoder();

let kernel: BrowserKernel | null = null;

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

function loadFrame() {
  const next = document.createElement("iframe");
  next.id = "frame";
  next.src = APP_PREFIX;
  frame.replaceWith(next);
  frame = next;
}

function setupTerminalPane(kernel: BrowserKernel): void {
  const host = document.getElementById("terminal-panel");
  if (!host) return;
  const panel = new TerminalPanel(host);
  panel.setStatus("Click to open a shell");

  let started = false;
  panel.onExpand(async () => {
    if (started) return;
    started = true;
    const pty = new PtyTerminal(panel.getTerminalContainer(), kernel);
    panel.setStatus("bash running");
    try {
      const code = await pty.spawnFromVfs("/bin/bash", ["bash", "-l", "-i"], {
        env: [
          "HOME=/root",
          "TERM=xterm-256color",
          "LANG=en_US.UTF-8",
          "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
          "USER=root",
          "LOGNAME=root",
          "PS1=bash$ ",
        ],
        cwd: "/root",
        uid: 0,
        gid: 0,
      });
      pty.terminal.writeln(`\r\n[Shell exited with code ${code}]`);
      panel.setStatus(`exited ${code}`);
    } catch (err) {
      pty.terminal.writeln(`\r\nError starting bash: ${err}`);
      panel.setStatus("error");
    }
  });
}

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading WordPress VFS image...", "loading");

  try {
    appendLog("Fetching kernel + VFS image...\n", "info");
    const [kernelBytes, vfsImageBuf] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(VFS_IMAGE_URL).then((r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to load VFS image from ${VFS_IMAGE_URL} (${r.status}). ` +
            `Run: bash images/vfs/scripts/build-wp-vfs-image.sh`,
          );
        }
        return r.arrayBuffer();
      }),
    ]);
    const rawVfsImage = new Uint8Array(vfsImageBuf);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `VFS: ${(rawVfsImage.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    // Patch released VFS images at runtime so hosted builds get current
    // public WordPress URLs and Vite-emitted lazy archive asset URLs.
    const memfs = MemoryFileSystem.fromImage(rawVfsImage, {
      maxByteLength: 512 * 1024 * 1024,
    });
    writeVfsFile(memfs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);
    writeVfsFile(memfs, "/etc/wp-config-init.sh", WORDPRESS_CONFIG_INIT_SCRIPT);
    writeVfsFile(memfs, "/etc/wp-config-template.php", wordpressConfigTemplate("sqlite"));
    ensureDirRecursive(memfs, "/var/www/html/wp-content/mu-plugins");
    writeVfsFile(
      memfs,
      "/var/www/html/wp-content/mu-plugins/kandelo-url.php",
      WORDPRESS_URL_MU_PLUGIN,
    );
    memfs.rewriteLazyArchiveUrls(resolveShellLazyArchiveUrl);
    const vfsImage = await memfs.saveImage();

    setStatus("Booting kernel with /sbin/dinit...", "loading");
    // See nginx/main.ts for the bridge-vs-listen race rationale.
    const seenPorts = new Set<number>();
    const REQUIRED_PORTS = [HTTP_PORT, PHP_FPM_PORT];
    let bridgeReady = false;
    const tryLoadFrame = () => {
      const allReady = REQUIRED_PORTS.every((p) => seenPorts.has(p));
      if (allReady && bridgeReady && reloadBtn.disabled) {
        setStatus("WordPress running! Loading page...", "running");
        reloadBtn.disabled = false;
        loadFrame();
      }
    };

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 12,
      maxMemoryPages: 4096,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
      onListenTcp: (_pid, _fd, port) => {
        appendLog(`service listening on :${port}\n`, "info");
        seenPorts.add(port);
        tryLoadFrame();
      },
    });

    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage,
      argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"],
      env: [
        "HOME=/root",
        "TERM=xterm-256color",
        "USER=root",
        "LOGNAME=root",
        "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
        // Picked up by /etc/wp-config-init.sh at boot.
        `WP_APP_PATH=${APP_PATH}`,
        `WP_PROTO=${PROTO}`,
      ],
      cwd: "/root",
      uid: 0,
      gid: 0,
    });

    appendLog("Initializing service worker bridge -> fetchInKernel...\n", "info");
    await setupServiceWorkerFetchBridge(SW_URL, APP_PREFIX, kernel, HTTP_PORT, {
      timeoutMs: 300_000,
      debugLog: (line) => appendLog(line + "\n", "info"),
    });
    appendLog(`HTTP bridge ready on port ${HTTP_PORT}\n`, "info");
    bridgeReady = true;
    tryLoadFrame();

    setupTerminalPane(kernel);

    const code = await exit;
    appendLog(`\ndinit exited with code ${code}\n`, "info");
    setStatus(`dinit exited with code ${code}`, "error");
  } catch (e: any) {
    const msg = e?.message || String(e);
    setStatus(`Error: ${msg}`, "error");
    appendLog(`Error: ${msg}\n`, "stderr");
    console.error(e);
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
