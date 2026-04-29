/**
 * Redis browser demo — runs Redis 7.2 inside the POSIX kernel with
 * 3 background threads, and lets users send commands via RESP protocol.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * Process layout:
 *   pid 1: redis-server (main process, spawns 3 background threads:
 *           BIO_CLOSE_FILE, BIO_AOF_FSYNC, BIO_LAZY_FREE)
 *   pid 2: dash -i (interactive shell with PTY)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { SystemInit } from "../../lib/init/system-init";
import {
  populateShellBinaries,
  type BinaryDef,
  COREUTILS_NAMES,
} from "../../lib/init/shell-binaries";
import {
  writeVfsBinary,
  writeInitDescriptor,
  ensureDirs,
} from "../../lib/init/vfs-utils";
import { RedisBrowserClient } from "../../lib/redis-client";
import kernelWasmUrl from "@kernel-wasm?url";
import redisWasmUrl from "../../../../binaries/programs/wasm32/redis/redis-server.wasm?url";
import dashWasmUrl from "../../../../binaries/programs/wasm32/dash.wasm?url";
import coreutilsWasmUrl from "../../../../binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "../../../../binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "../../../../binaries/programs/wasm32/sed.wasm?url";
import "@xterm/xterm/css/xterm.css";
import "../../lib/terminal-panel.css";

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const executeBtn = document.getElementById("execute") as HTMLButtonElement;
const cmdInput = document.getElementById("cmd") as HTMLInputElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const resultDiv = document.getElementById("result") as HTMLPreElement;
const examplesSelect = document.getElementById("examples") as HTMLSelectElement;
const terminalPanel = document.getElementById("terminal-panel") as HTMLDivElement;

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

// Example commands
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

let redisClient: RedisBrowserClient | null = null;
let kernel: BrowserKernel | null = null;
let init: SystemInit | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Starting Redis...", "loading");

  try {
    // Fetch kernel, redis (eager — written to VFS), and dash
    appendLog("Fetching resources...\n", "info");
    const [kernelBytes, redisBytes, dashBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(redisWasmUrl).then((r) => r.arrayBuffer()),
      fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
    ]);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `Redis: ${(redisBytes.byteLength / 1024 / 1024).toFixed(1)}MB, ` +
      `dash: ${(dashBytes.byteLength / 1024).toFixed(0)}KB\n`,
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

    // Create kernel — thread module is auto-compiled on first clone()
    kernel = new BrowserKernel({
      maxWorkers: 8,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Populate VFS
    appendLog("Populating filesystem...\n", "info");
    const fs = kernel.fs;

    // Shell binaries (dash eager, utilities lazy)
    populateShellBinaries(kernel, dashBytes, lazyBinaries);

    // Redis binary — write eagerly since we already fetched it
    try { fs.mkdir("/usr/sbin", 0o755); } catch { /* exists */ }
    writeVfsBinary(fs, "/usr/sbin/redis-server", new Uint8Array(redisBytes));

    // Data directories
    ensureDirs(fs, ["/data", "/data/tmp"]);

    // Write init service descriptors
    writeInitDescriptor(fs, "10-redis", {
      type: "daemon",
      command: "/usr/sbin/redis-server --port 6379 --bind 0.0.0.0 --save \"\" --appendonly no --io-threads 1",
      ready: "port:6379",
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
      onServiceReady: async (name) => {
        if (name === "redis") {
          // Connect Redis RESP client
          appendLog("Connecting Redis client...\n", "info");
          try {
            redisClient = await RedisBrowserClient.connect(kernel!, 6379);
            const pingResult = await redisClient.command("PING");
            appendLog(`Connected! PING -> ${RedisBrowserClient.formatResult(pingResult)}\n`, "info");

            setStatus("Redis is running!", "running");
            executeBtn.disabled = false;
            cmdInput.focus();
          } catch (e: any) {
            appendLog(`Failed to connect Redis client: ${e.message}\n`, "stderr");
            setStatus("Redis started but client connection failed", "error");
          }
        }
      },
    });

    await init.boot();
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

  // Parse command — split on spaces, respecting quoted strings
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of raw) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) {
        args.push(current);
        current = "";
      }
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
