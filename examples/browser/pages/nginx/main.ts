/**
 * nginx browser demo — boots a service-demo VFS image and lets dinit
 * inside the kernel start nginx. The main thread is a thin client:
 * fetches the image, boots the kernel pointing at /sbin/dinit, sets
 * up the HTTP bridge for the service worker, and reacts to the
 * onListenTcp(8080) event by loading the served page in an iframe.
 *
 * No JS-side process orchestration. /etc/dinit.d/nginx (baked into
 * the image at build time) declares the service; dinit handles the
 * rest.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { initServiceWorkerBridge } from "../../lib/init/service-worker-bridge";
import { HttpBridgeHost } from "../../lib/http-bridge";
import kernelWasmUrl from "@kernel-wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/nginx-vfs.vfs.zst?url";
import "../../lib/terminal-panel.css";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
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

/**
 * Service-worker bridge can lose its kernel-side MessagePort when the
 * SW restarts. The SW asks the page for a fresh bridge by posting a
 * "need-bridge" message; we respond with a new port pair.
 */
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
  setStatus("Loading kernel and nginx VFS image...", "loading");

  try {
    appendLog("Fetching kernel + nginx VFS image...\n", "info");
    const [kernelBytes, vfsImageBuf] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(VFS_IMAGE_URL).then((r) => r.arrayBuffer()),
    ]);
    const vfsImage = new Uint8Array(vfsImageBuf);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `VFS image: ${(vfsImage.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    appendLog("Initializing service worker bridge...\n", "info");
    const swBridge = await initServiceWorkerBridge(SW_URL, APP_PREFIX);
    if (!swBridge) {
      throw new Error("Service workers unavailable — HTTP bridge not initialized");
    }

    setStatus("Booting kernel with /sbin/dinit...", "loading");
    // The first iframe load races with HTTP-bridge setup: nginx binds
    // :8080 inside the kernel as soon as dinit execs it, but the bridge
    // port can only be sent after kernel.boot() resolves. Without a
    // gate, the iframe makes a request before bridgePort.onmessage is
    // wired up and the request is dropped (refresh works because by
    // then the bridge is ready). Track both readiness signals and
    // only load the iframe when both have arrived.
    let nginxListening = false;
    let bridgeSent = false;
    const tryLoadFrame = () => {
      if (nginxListening && bridgeSent && reloadBtn.disabled) {
        setStatus("nginx is running! Loading page...", "running");
        reloadBtn.disabled = false;
        loadFrame();
      }
    };

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
      onListenTcp: (_pid, _fd, port) => {
        appendLog(`nginx listening on :${port}\n`, "info");
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
      env: ["HOME=/root", "TERM=xterm-256color", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"],
    });

    // Hand the kernel the HTTP-bridge host port for routing incoming
    // requests on port 8080 to the service worker.
    kernel.sendBridgePort(swBridge.detachHostPort(), HTTP_PORT);
    bridgeHttpPort = HTTP_PORT;
    appendLog(`HTTP bridge ready on port ${HTTP_PORT}\n`, "info");
    setupBridgeRestoreListener();
    bridgeSent = true;
    tryLoadFrame();

    // Wait for the init process (dinit) to exit. In normal operation
    // this never returns — dinit stays up as PID 1 and supervises
    // nginx. The await is here to surface unexpected exits.
    const code = await exit;
    appendLog(`\ndinit exited with code ${code}\n`, "info");
    setStatus(`dinit exited with code ${code}`, "error");
  } catch (e) {
    appendLog(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
