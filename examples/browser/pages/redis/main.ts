/**
 * Redis browser demo — runs Redis 7.2 inside the POSIX kernel with
 * 3 background threads, and lets users send commands via RESP protocol.
 *
 * Process layout:
 *   pid 1: redis-server (main process, spawns 3 background threads:
 *           BIO_CLOSE_FILE, BIO_AOF_FSYNC, BIO_LAZY_FREE)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { patchWasmForThread } from "../../../../host/src/worker-main";
import { RedisBrowserClient } from "../../lib/redis-client";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import redisWasmUrl from "../../../../examples/libs/redis/bin/redis-server.wasm?url";

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

let redisClient: RedisBrowserClient | null = null;

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("Starting Redis...", "loading");

  try {
    // Fetch resources
    appendLog("Fetching resources...\n", "info");
    const [kernelBytes, redisBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(redisWasmUrl).then((r) => r.arrayBuffer()),
    ]);
    appendLog(
      `  Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, Redis: ${(redisBytes.byteLength / 1024 / 1024).toFixed(1)}MB\n`,
      "info",
    );

    // Pre-compile thread module
    appendLog("Pre-compiling thread module...\n", "info");
    setStatus("Pre-compiling thread module...", "loading");
    const threadPatchedBytes = patchWasmForThread(redisBytes);
    const threadModule = await WebAssembly.compile(threadPatchedBytes);
    appendLog("Thread module ready\n", "info");

    // Create kernel
    const kernel = new BrowserKernel({
      maxWorkers: 8,
      threadModule,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Create data directory
    kernel.fs.mkdir("/data", 0o755);
    kernel.fs.mkdir("/data/tmp", 0o755);

    // Start redis-server
    setStatus("Starting Redis server...", "loading");
    appendLog("Starting Redis server...\n", "info");
    const exitPromise = kernel.spawn(redisBytes, [
      "redis-server",
      "--port", "6379",
      "--bind", "0.0.0.0",
      "--dir", "/data",
      "--save", "",
      "--appendonly", "no",
      "--loglevel", "notice",
      "--daemonize", "no",
      "--databases", "16",
      "--io-threads", "1",
    ]);

    // Wait for Redis to start listening (poll for the listener)
    appendLog("Waiting for Redis to accept connections...\n", "info");
    setStatus("Waiting for Redis to accept connections...", "loading");
    let connected = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        redisClient = await RedisBrowserClient.connect(kernel, 6379);
        connected = true;
        break;
      } catch {
        // Not ready yet
        if (attempt > 0 && attempt % 10 === 0) {
          appendLog(`  Still waiting... (${attempt * 0.2}s)\n`, "info");
        }
      }
    }

    if (!connected) {
      throw new Error("Redis did not start within 20 seconds");
    }

    // Verify with PING
    const pingResult = await redisClient!.command("PING");
    appendLog(`Connected! PING → ${RedisBrowserClient.formatResult(pingResult)}\n`, "info");

    setStatus("Redis is running!", "running");
    executeBtn.disabled = false;
    cmdInput.focus();

    // Handle process exit
    exitPromise.then((code) => {
      appendLog(`\nRedis exited with code ${code}\n`, "stderr");
      setStatus("Redis stopped", "error");
      executeBtn.disabled = true;
      startBtn.disabled = false;
      redisClient = null;
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    setStatus(`Error: ${msg}`, "error");
    appendLog(`Error: ${msg}\n`, "stderr");
    startBtn.disabled = false;
  }
});

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

executeBtn.addEventListener("click", executeCommand);
cmdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !executeBtn.disabled) {
    executeCommand();
  }
});
