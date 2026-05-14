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
import { BrowserKernel } from "../../lib/browser-kernel";
import { initServiceWorkerBridge } from "../../lib/init/service-worker-bridge";
import { HttpBridgeHost } from "../../lib/http-bridge";
import { TerminalPanel } from "../../lib/init";
import { PtyTerminal } from "../../lib/pty-terminal";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import kernelWasmUrl from "@kernel-wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/wordpress.vfs.zst?url";
import "../../lib/terminal-panel.css";
import "@xterm/xterm/css/xterm.css";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const HTTP_PORT = 8080;

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
let frame = document.getElementById("frame") as HTMLIFrameElement;

const decoder = new TextDecoder();

let kernel: BrowserKernel | null = null;
let bridgeHttpPort: number | null = null;

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

function setupBridgeRestoreListener() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "need-bridge") return;
    const replyPort = event.ports[0];
    if (!replyPort) return;
    const bridge = new HttpBridgeHost();
    replyPort.postMessage(
      { type: "bridge-restored", appPrefix: APP_PREFIX },
      [bridge.getSwPort()],
    );
    if (kernel && bridgeHttpPort != null) {
      kernel.sendBridgePort(bridge.detachHostPort(), bridgeHttpPort);
    }
    appendLog("Bridge restored after service worker restart\n", "info");
  });
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
          "PS1=bash$ ",
        ],
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
            `Run: bash examples/browser/scripts/build-wp-vfs-image.sh`,
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

    // The VFS image bakes vim.zip + nethack.zip lazy archives with bare
    // filenames as URLs. Prepend the deployed base URL so fetch()
    // resolves correctly regardless of routing.
    const memfs = MemoryFileSystem.fromImage(rawVfsImage, {
      maxByteLength: 512 * 1024 * 1024,
    });
    memfs.rewriteLazyArchiveUrls((url) => import.meta.env.BASE_URL + url);
    const vfsImage = await memfs.saveImage();

    appendLog("Initializing service worker bridge...\n", "info");
    const swBridge = await initServiceWorkerBridge(SW_URL, APP_PREFIX);
    if (!swBridge) {
      throw new Error("Service workers unavailable — HTTP bridge not initialized");
    }

    setStatus("Booting kernel with /sbin/dinit...", "loading");
    // See nginx/main.ts for the bridge-vs-listen race rationale.
    let nginxListening = false;
    let bridgeSent = false;
    const tryLoadFrame = () => {
      if (nginxListening && bridgeSent && reloadBtn.disabled) {
        setStatus("WordPress running! Loading page...", "running");
        reloadBtn.disabled = false;
        loadFrame();
      }
    };

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 8,
      maxMemoryPages: 4096,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
      onListenTcp: (_pid, _fd, port) => {
        appendLog(`service listening on :${port}\n`, "info");
        if (port === HTTP_PORT) {
          nginxListening = true;
          tryLoadFrame();
        }
      },
    });

    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage,
      argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"],
      env: [
        "HOME=/root",
        "TERM=xterm-256color",
        "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
        // Picked up by /etc/wp-config-init.sh at boot.
        `WP_APP_PATH=${APP_PATH}`,
        `WP_PROTO=${PROTO}`,
      ],
    });

    kernel.sendBridgePort(swBridge.detachHostPort(), HTTP_PORT);
    bridgeHttpPort = HTTP_PORT;
    appendLog(`HTTP bridge ready on port ${HTTP_PORT}\n`, "info");
    setupBridgeRestoreListener();
    bridgeSent = true;
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
