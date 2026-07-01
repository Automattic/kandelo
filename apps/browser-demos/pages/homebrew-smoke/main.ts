import { BrowserKernel } from "@host/browser-kernel-host";
import { ABI_VERSION } from "@host/generated/abi";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import kernelWasmUrl from "@kernel-wasm?url";

interface HomebrewSmokeRequest {
  vfsUrl: string;
  argv: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: string[];
}

interface HomebrewSmokeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
}

declare global {
  interface Window {
    __homebrewSmokeReady: boolean;
    __runHomebrewSmoke: (request: HomebrewSmokeRequest) => Promise<HomebrewSmokeResult>;
  }
}

const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const decoder = new TextDecoder();

let kernelBytes: ArrayBuffer | null = null;

function appendLog(text: string): void {
  logEl.textContent += text;
}

async function fetchBytes(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });
}

async function runHomebrewSmoke(request: HomebrewSmokeRequest): Promise<HomebrewSmokeResult> {
  if (!kernelBytes) throw new Error("kernel wasm is not loaded");
  if (!request.vfsUrl) throw new Error("vfsUrl is required");
  if (!Array.isArray(request.argv) || request.argv.length === 0) {
    throw new Error("argv must contain at least argv[0]");
  }

  const start = performance.now();
  let stdout = "";
  let stderr = "";
  const vfsBytes = new Uint8Array(await fetchBytes(request.vfsUrl, "Homebrew VFS"));
  MemoryFileSystem.assertImageKernelAbi(vfsBytes, ABI_VERSION, "Homebrew smoke VFS");

  const kernel = new BrowserKernel({
    kernelOwnedFs: true,
    onStdout: (data) => {
      const text = decoder.decode(data);
      stdout += text;
      appendLog(text);
    },
    onStderr: (data) => {
      const text = decoder.decode(data);
      stderr += text;
      appendLog(text);
    },
  });

  try {
    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage: vfsBytes,
      argv: request.argv,
      cwd: request.cwd ?? "/",
      env: request.env ?? [
        "HOME=/tmp",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin",
      ],
      uid: 0,
      gid: 0,
      stdin: new Uint8Array(0),
    });
    const exitCode = await Promise.race([
      exit,
      timeoutAfter(request.timeoutMs ?? 180_000),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      combined: `${stdout}${stderr}`,
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    await kernel.destroy().catch(() => {});
  }
}

async function init(): Promise<void> {
  kernelBytes = await fetchBytes(kernelWasmUrl, "kernel.wasm");
  window.__runHomebrewSmoke = runHomebrewSmoke;
  window.__homebrewSmokeReady = true;
  statusEl.textContent = "Ready";
}

window.__homebrewSmokeReady = false;
init().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  statusEl.textContent = `Error: ${message}`;
  appendLog(`${message}\n`);
  console.error("Homebrew smoke init failed:", err);
});
