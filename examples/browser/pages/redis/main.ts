/**
 * Redis browser demo — boots a service-demo VFS image with dinit as
 * PID 1, which brings up redis-server on :6379. The main thread is a
 * thin client: fetches the image, boots, connects a RESP client when
 * the listen-on-6379 event fires, and exposes a command UI.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { RedisBrowserClient } from "../../lib/redis-client";
import kernelWasmUrl from "@kernel-wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/redis-vfs.vfs?url";

const REDIS_PORT = 6379;

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const executeBtn = document.getElementById("execute") as HTMLButtonElement;
const cmdInput = document.getElementById("cmd") as HTMLInputElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const resultDiv = document.getElementById("result") as HTMLPreElement;
const examplesSelect = document.getElementById("examples") as HTMLSelectElement;

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

function appendResult(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  resultDiv.appendChild(span);
  resultDiv.scrollTop = resultDiv.scrollHeight;
}

const EXAMPLES: Record<string, string> = {
  ping: "PING",
  set: "SET hello world",
  get: "GET hello",
  incr: "INCR counter",
  lpush: "LPUSH mylist a b c",
  lrange: "LRANGE mylist 0 -1",
  info: "INFO server",
  dbsize: "DBSIZE",
};

examplesSelect.addEventListener("change", () => {
  const val = examplesSelect.value;
  if (val && EXAMPLES[val]) {
    cmdInput.value = EXAMPLES[val];
  }
  examplesSelect.selectedIndex = 0;
});

let redisClient: RedisBrowserClient | null = null;
let kernel: BrowserKernel | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading kernel and Redis VFS image...", "loading");

  try {
    appendLog("Fetching kernel + Redis VFS image...\n", "info");
    const [kernelBytes, vfsImageBuf] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(VFS_IMAGE_URL).then((r) => r.arrayBuffer()),
    ]);
    const vfsImage = new Uint8Array(vfsImageBuf);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `VFS: ${(vfsImage.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    setStatus("Booting kernel with /sbin/dinit...", "loading");
    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 8, // Redis spawns 3 background threads
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
      onListenTcp: async (_pid, _fd, port) => {
        appendLog(`redis listening on :${port}\n`, "info");
        if (port !== REDIS_PORT) return;
        appendLog("Connecting Redis RESP client...\n", "info");
        try {
          redisClient = await RedisBrowserClient.connect(kernel!, REDIS_PORT);
          const pingResult = await redisClient.command("PING");
          appendLog(`Connected! PING -> ${RedisBrowserClient.formatResult(pingResult)}\n`, "info");
          setStatus("Redis is running!", "running");
          executeBtn.disabled = false;
          cmdInput.focus();
        } catch (e: any) {
          appendLog(`Failed to connect Redis client: ${e.message}\n`, "stderr");
          setStatus("Redis started but client connection failed", "error");
        }
      },
    });

    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage,
      argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"],
      env: ["HOME=/root", "TERM=xterm-256color", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"],
    });

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

async function executeCommand() {
  if (!redisClient) return;

  const raw = cmdInput.value.trim();
  if (!raw) return;

  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of raw) {
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  if (args.length === 0) return;

  appendResult(`redis> ${raw}\n`, "cmd");
  executeBtn.disabled = true;

  try {
    const result = await redisClient.command(...args);
    appendResult(RedisBrowserClient.formatResult(result) + "\n", "resp");
  } catch (e: any) {
    appendResult(`(error) ${e.message}\n`, "stderr");
  }

  executeBtn.disabled = false;
  cmdInput.focus();
}

startBtn.addEventListener("click", start);
executeBtn.addEventListener("click", executeCommand);
cmdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !executeBtn.disabled) {
    executeCommand();
  }
});
