import { BrowserKernel } from "@host/browser-kernel-host";
import { ABI_VERSION } from "@host/generated/abi";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import { attachCanvas } from "@host/framebuffer/canvas-renderer";
import kernelWasmUrl from "@kernel-wasm?url";

/**
 * Headless framebuffer/device smoke page for Kandelo Homebrew sidecars.
 *
 * Two device paths:
 *   - "fb":  raw /dev/fb0 programs (fbdoom). Observes FramebufferRegistry
 *            bind + pixel-write activity and renders via attachCanvas (2D).
 *   - "kms": /dev/dri/card0 GLES programs (modeset). Transfers an
 *            OffscreenCanvas to the kernel worker via kmsAttachCanvas and
 *            reads page-flip / commit telemetry from a stats SAB.
 *
 * A program that binds a framebuffer + pushes writes ("fb"), or commits
 * page-flips through the CRTC ("kms"), has reached the browser display path.
 */
interface FbSmokeRequest {
  vfsUrl: string;
  argv: string[];
  mode?: "fb" | "kms";
  crtcId?: number;
  cwd?: string;
  env?: string[];
  observeMs?: number;
  writeThreshold?: number;
}

interface FbSmokeResult {
  mode: "fb" | "kms";
  binds: number;
  unbinds: number;
  writes: number;
  writeBytes: number;
  kmsBlits: number;
  kmsCommits: number;
  boundPid: number | null;
  width: number;
  height: number;
  fmt: string | null;
  canvasNonBlankPixels: number;
  exitedEarly: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

declare global {
  interface Window {
    __homebrewFbSmokeReady: boolean;
    __runHomebrewFbSmoke: (request: FbSmokeRequest) => Promise<FbSmokeResult>;
  }
}

const MODESET_FB_W = 1920;
const MODESET_FB_H = 1080;

const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const canvas = document.getElementById("fb") as HTMLCanvasElement;
const decoder = new TextDecoder();

let kernelBytes: ArrayBuffer | null = null;

function appendLog(text: string): void {
  logEl.textContent += text;
}

async function fetchBytes(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} fetch failed: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

function tail(text: string, max = 2000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function countNonBlankPixels(): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return 0;
  }
  const px = data.data;
  const first = [px[0], px[1], px[2]];
  let nonBlank = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] !== first[0] || px[i + 1] !== first[1] || px[i + 2] !== first[2]) nonBlank += 1;
  }
  return nonBlank;
}

async function runFbSmoke(request: FbSmokeRequest): Promise<FbSmokeResult> {
  if (!kernelBytes) throw new Error("kernel wasm is not loaded");
  if (!request.vfsUrl) throw new Error("vfsUrl is required");
  if (!Array.isArray(request.argv) || request.argv.length === 0) throw new Error("argv must contain at least argv[0]");

  const mode = request.mode ?? "fb";
  const crtcId = request.crtcId ?? 1;
  const observeMs = request.observeMs ?? 15_000;
  const writeThreshold = request.writeThreshold ?? 1;
  const start = performance.now();
  let stdout = "";
  let stderr = "";

  const vfsBytes = new Uint8Array(await fetchBytes(request.vfsUrl, "Homebrew VFS"));
  MemoryFileSystem.assertImageKernelAbi(vfsBytes, ABI_VERSION, "Homebrew fb smoke VFS");

  const kernel = new BrowserKernel({
    kernelOwnedFs: true,
    onStdout: (data) => { const t = decoder.decode(data); stdout += t; appendLog(t); },
    onStderr: (data) => { const t = decoder.decode(data); stderr += t; appendLog(t); },
  });

  // Shared metrics
  let binds = 0, unbinds = 0, writes = 0, writeBytes = 0;
  let boundPid: number | null = null;
  let detachCanvas: (() => void) | null = null;
  let width = 0, height = 0;
  let fmt: string | null = null;

  // KMS (modeset) telemetry via a stats SAB: [blit_count, ts_ms, width, height, tick_us, commit_count, last_frame_us]
  let statsView: Int32Array | null = null;
  const kmsCounts = () => ({
    blits: statsView ? Atomics.load(statsView, 0) : 0,
    commits: statsView ? Atomics.load(statsView, 5) : 0,
    w: statsView ? Atomics.load(statsView, 2) : 0,
    h: statsView ? Atomics.load(statsView, 3) : 0,
  });

  let offChange: (() => void) | null = null;
  let offWrite: (() => void) | null = null;

  // Prepare the KMS scanout canvas up front (transferControlToOffscreen
  // detaches it from the main thread), but attach it to the kernel worker
  // only after boot() — the worker does not exist before boot.
  let kmsOffscreen: OffscreenCanvas | null = null;
  let kmsStatsSab: SharedArrayBuffer | null = null;
  if (mode === "kms") {
    canvas.width = MODESET_FB_W;
    canvas.height = MODESET_FB_H;
    kmsStatsSab = new SharedArrayBuffer(7 * 4);
    statsView = new Int32Array(kmsStatsSab);
    kmsOffscreen = canvas.transferControlToOffscreen();
  } else {
    offChange = kernel.framebuffers.onChange((pid, ev) => {
      if (ev === "bind") {
        binds += 1;
        const binding = kernel.framebuffers.get(pid);
        if (binding) { width = binding.w; height = binding.h; fmt = binding.fmt; }
        if (boundPid === null) {
          boundPid = pid;
          try {
            if (width > 0 && height > 0) { canvas.width = width; canvas.height = height; }
            detachCanvas = attachCanvas(canvas, kernel.framebuffers, pid, {
              getProcessMemory: (p) => kernel.getProcessMemory(p),
            });
          } catch (err) {
            appendLog(`attachCanvas failed: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      } else {
        unbinds += 1;
      }
    });
    offWrite = kernel.framebuffers.onWrite((_pid, _offset, bytes) => { writes += 1; writeBytes += bytes.length; });
  }

  let exitedEarly = false;
  let exitCode: number | null = null;

  try {
    const defaultEnv = [
      "HOME=/tmp", "TMPDIR=/tmp", "TERM=xterm-256color", "LANG=en_US.UTF-8",
      "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin",
    ];
    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage: vfsBytes,
      argv: request.argv,
      cwd: request.cwd ?? "/",
      env: [...defaultEnv, ...(request.env ?? [])],
      uid: 0,
      gid: 0,
      // Framebuffer/KMS programs set up keyboard input via /dev/tty and query
      // terminal settings; without a PTY they exit at keyboard init.
      pty: true,
    });
    exit.then((code) => { exitedEarly = true; exitCode = code; }).catch(() => {});

    // Attach the KMS scanout canvas now that the kernel worker exists. The
    // worker holds the CRTC framebuffer and scans it out to this canvas once
    // modeset binds /dev/dri/card0 and commits page flips.
    if (mode === "kms" && kmsOffscreen && kmsStatsSab) {
      kernel.kmsAttachCanvas(crtcId, kmsOffscreen, kmsStatsSab, { mode: "webgl2" });
    }

    const hasActivity = () =>
      mode === "kms" ? (kmsCounts().commits >= 1 || kmsCounts().blits >= 1) : (writes >= writeThreshold && binds >= 1);

    const deadline = performance.now() + observeMs;
    while (performance.now() < deadline) {
      if (hasActivity()) { await delay(800); break; }
      if (exitedEarly) break;
      await delay(200);
    }
    await delay(400);
  } finally {
    offChange?.();
    offWrite?.();
    detachCanvas?.();
    await kernel.destroy().catch(() => {});
  }

  const kms = kmsCounts();
  if (mode === "kms") { width = kms.w; height = kms.h; }

  return {
    mode,
    binds,
    unbinds,
    writes,
    writeBytes,
    kmsBlits: kms.blits,
    kmsCommits: kms.commits,
    boundPid,
    width,
    height,
    fmt,
    canvasNonBlankPixels: mode === "kms" ? -1 : countNonBlankPixels(),
    exitedEarly,
    exitCode,
    durationMs: Math.round(performance.now() - start),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

async function init(): Promise<void> {
  kernelBytes = await fetchBytes(kernelWasmUrl, "kernel.wasm");
  window.__runHomebrewFbSmoke = runFbSmoke;
  window.__homebrewFbSmokeReady = true;
  statusEl.textContent = "Ready";
}

window.__homebrewFbSmokeReady = false;
init().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  statusEl.textContent = `Error: ${message}`;
  appendLog(`${message}\n`);
  console.error("Homebrew fb smoke init failed:", err);
});
