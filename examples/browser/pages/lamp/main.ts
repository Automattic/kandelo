/**
 * WordPress (LAMP) browser demo — boots a service-demo VFS image with
 * dinit as PID 1. dinit chains:
 *
 *   mariadb-bootstrap (scripted) — populates /data via mariadbd --bootstrap
 *   mariadb           (process)  — daemon, listens 127.0.0.1:3306
 *   wp-config-init    (scripted) — sed-substitutes @@APP_PATH@@/@@PROTO@@
 *   php-fpm           (process)  — FastCGI on 127.0.0.1:9000
 *   nginx             (process)  — HTTP on :8080
 *
 * The page passes WP_APP_PATH and WP_PROTO via env so wp-config-init
 * can finalize wp-config.php's runtime values (WP_HOME / WP_SITEURL).
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { initServiceWorkerBridge } from "../../lib/init/service-worker-bridge";
import { HttpBridgeHost } from "../../lib/http-bridge";
import kernelWasmUrl from "@kernel-wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/lamp.vfs?url";
import "../../lib/terminal-panel.css";

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

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading WordPress (LAMP)...", "loading");

  try {
    appendLog("Fetching kernel + VFS image...\n", "info");
    const [kernelBytes, vfsImageBuf] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(VFS_IMAGE_URL).then((r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to load VFS image from ${VFS_IMAGE_URL} (${r.status}). ` +
            `Run: bash examples/browser/scripts/build-lamp-vfs-image.sh`,
          );
        }
        return r.arrayBuffer();
      }),
    ]);
    const vfsImage = new Uint8Array(vfsImageBuf);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `VFS: ${(vfsImage.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    appendLog("Initializing service worker bridge...\n", "info");
    const swBridge = await initServiceWorkerBridge(SW_URL, APP_PREFIX);
    if (!swBridge) {
      throw new Error("Service workers unavailable — HTTP bridge not initialized");
    }

    setStatus("Booting kernel with /sbin/dinit...", "loading");
    // Track which ports are listening so we only load the iframe once
    // BOTH nginx (8080) and mariadbd (3306) are accepting connections —
    // dinit considers a `process` service started right after exec(),
    // racing the daemon's actual port-bind by ~10s for mariadbd.
    // Also gate on bridgeSent — see nginx/main.ts for the bridge-vs-listen
    // race rationale (mariadb's slow boot usually masks it here, but be
    // explicit anyway).
    const seenPorts = new Set<number>();
    const REQUIRED_PORTS = [HTTP_PORT, 3306];
    let bridgeSent = false;
    const tryLoadFrame = () => {
      const allReady = REQUIRED_PORTS.every((p) => seenPorts.has(p));
      if (allReady && bridgeSent && reloadBtn.disabled) {
        setStatus("WordPress running! Loading page...", "running");
        reloadBtn.disabled = false;
        loadFrame();
      }
    };

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 16,
      // No maxMemoryPages cap — mariadbd's Aria recovery needs ~130 MiB
      // allocations during InnoDB+Aria startup, which spilled past the
      // 256 MiB cap (4096 pages) the wordpress demo uses. Default is
      // 16384 pages (1 GiB) which is plenty.
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
        "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
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
