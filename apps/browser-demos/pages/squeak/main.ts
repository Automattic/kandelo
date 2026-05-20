import { BrowserKernel } from "@host/browser-kernel-host";
import { attachCanvas } from "../../../../host/src/framebuffer/canvas-renderer";
import { parseZipCentralDirectory, extractZipEntry } from "../../../../host/src/vfs/zip";
import squeakWasmUrl from "@binaries/programs/wasm32/squeak.wasm?url";
import kernelWasmUrl from "@kernel-wasm?url";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const canvas = document.getElementById("fb") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;

const SQUEAK_ZIP_URL =
  "https://files.squeak.org/6.0/Squeak6.0-22148-32bit/Squeak6.0-22148-32bit.zip";
const SQUEAK_ZIP_SHA256 =
  "63b195f00b29749aae3a0dab577af8563d9c5c8c311f6e209679b45afd3b6255";
const SQUEAK_CACHE_NAME = "squeak-6.0-22148-32bit";
const IMAGE_NAME = "Squeak6.0-22148-32bit.image";
const CHANGES_NAME = "Squeak6.0-22148-32bit.changes";
const SOURCES_NAME = "SqueakV60.sources";
const IMAGE_PATH = `/home/${IMAGE_NAME}`;
const MAX_STDERR_LINES = 80;

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function loadSqueakZip(setStatus: (text: string) => void): Promise<Uint8Array> {
  const cache = await caches.open(SQUEAK_CACHE_NAME);
  const cached = await cache.match(SQUEAK_ZIP_URL);
  if (cached) {
    setStatus("Loading cached Squeak image bundle...");
    return new Uint8Array(await cached.arrayBuffer());
  }

  const fetchUrl = import.meta.env.DEV
    ? `/cors-proxy?url=${encodeURIComponent(SQUEAK_ZIP_URL)}`
    : SQUEAK_ZIP_URL;
  setStatus("Downloading Squeak 6.0 image bundle...");
  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching Squeak image bundle`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  setStatus("Verifying Squeak image bundle...");
  const actual = await sha256Hex(bytes);
  if (actual !== SQUEAK_ZIP_SHA256) {
    throw new Error(`Squeak bundle sha256 mismatch: ${actual}`);
  }

  await cache.put(
    SQUEAK_ZIP_URL,
    new Response(bytes, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.byteLength),
      },
    }),
  );
  return bytes;
}

function extractRequired(zipBytes: Uint8Array, name: string): Uint8Array {
  const entry = parseZipCentralDirectory(zipBytes).find((e) => e.fileName === name);
  if (!entry) throw new Error(`${name} missing from Squeak image bundle`);
  return extractZipEntry(zipBytes, entry);
}

function registerSqueakFiles(
  kernel: BrowserKernel,
  image: Uint8Array,
  changes: Uint8Array,
  sources: Uint8Array,
): string[] {
  const imageUrl = URL.createObjectURL(new Blob([exactArrayBuffer(image)], { type: "application/octet-stream" }));
  const changesUrl = URL.createObjectURL(new Blob([exactArrayBuffer(changes)], { type: "text/plain" }));
  const sourcesUrl = URL.createObjectURL(new Blob([exactArrayBuffer(sources)], { type: "text/plain" }));
  kernel.registerLazyFiles([
    { path: IMAGE_PATH, url: imageUrl, size: image.byteLength, mode: 0o644 },
    { path: `/home/${CHANGES_NAME}`, url: changesUrl, size: changes.byteLength, mode: 0o644 },
    { path: `/home/${SOURCES_NAME}`, url: sourcesUrl, size: sources.byteLength, mode: 0o644 },
  ]);
  return [imageUrl, changesUrl, sourcesUrl];
}

function wireKeyboard(kernel: BrowserKernel, getPid: () => number): void {
  const special: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowLeft: 28,
    ArrowRight: 29,
    ArrowUp: 30,
    ArrowDown: 31,
    Delete: 127,
  };

  canvas.addEventListener("keydown", (event) => {
    if (event.metaKey || event.altKey) return;
    const code = special[event.key] ?? (event.key.length === 1 ? event.key.codePointAt(0) : undefined);
    if (code === undefined || code > 255) return;
    event.preventDefault();
    kernel.appendStdinData(getPid(), new Uint8Array([code]));
  });
}

function wireMouse(kernel: BrowserKernel): void {
  let buttons = 0;
  const buttonBit = (button: number) => (button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0);

  canvas.addEventListener("click", () => {
    canvas.focus();
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
    }
  });
  canvas.addEventListener("mousemove", (event) => {
    if (document.pointerLockElement !== canvas) return;
    const dx = event.movementX | 0;
    const dy = -(event.movementY | 0);
    if (dx !== 0 || dy !== 0) kernel.injectMouseEvent(dx, dy, buttons);
  });
  canvas.addEventListener("mousedown", (event) => {
    if (document.pointerLockElement !== canvas) return;
    const bit = buttonBit(event.button);
    if (bit === 0) return;
    event.preventDefault();
    buttons |= bit;
    kernel.injectMouseEvent(0, 0, buttons);
  });
  canvas.addEventListener("mouseup", (event) => {
    const bit = buttonBit(event.button);
    if (bit === 0) return;
    event.preventDefault();
    buttons &= ~bit;
    kernel.injectMouseEvent(0, 0, buttons);
  });
  canvas.addEventListener("blur", () => {
    if (buttons !== 0) {
      buttons = 0;
      kernel.injectMouseEvent(0, 0, 0);
    }
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
}

function startAudio(kernel: BrowserKernel): () => void {
  const audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  let cursor = audioCtx.currentTime;
  let stopped = false;

  const timer = window.setInterval(async () => {
    if (stopped || audioCtx.state !== "running") return;
    const drain = await kernel.drainAudio(32 * 1024).catch(() => null);
    if (!drain || drain.bytes.byteLength === 0) return;

    const channels = drain.channels || 2;
    const sampleRate = drain.sampleRate || 44100;
    const bytesPerFrame = channels * 2;
    const frames = Math.floor(drain.bytes.byteLength / bytesPerFrame);
    if (frames <= 0) return;

    const buffer = audioCtx.createBuffer(channels, frames, sampleRate);
    const view = new DataView(drain.bytes.buffer, drain.bytes.byteOffset, drain.bytes.byteLength);
    for (let ch = 0; ch < channels; ch++) {
      const out = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        out[i] = view.getInt16((i * channels + ch) * 2, true) / 32768;
      }
    }

    const now = audioCtx.currentTime;
    if (cursor < now + 0.04) cursor = now + 0.04;
    if (cursor > now + 0.2) cursor = now + 0.04;
    const node = audioCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(audioCtx.destination);
    node.start(cursor);
    cursor += frames / sampleRate;
  }, 50);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    void audioCtx.close().catch(() => {});
  };
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  const blobUrls: string[] = [];
  let stopAudio: (() => void) | undefined;

  try {
    const [kernelBytes, squeakBytes, zipBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(squeakWasmUrl).then((r) => r.arrayBuffer()),
      loadSqueakZip((text) => { statusEl.textContent = text; }),
    ]);

    statusEl.textContent = "Extracting Squeak image...";
    const image = extractRequired(zipBytes, IMAGE_NAME);
    const changes = extractRequired(zipBytes, CHANGES_NAME);
    const sources = extractRequired(zipBytes, SOURCES_NAME);

    statusEl.textContent = "Booting kernel...";
    let stderrBuffer = "";
    let stderrLines = 0;
    const kernel = new BrowserKernel({
      fsSize: 128 * 1024 * 1024,
      maxFsSize: 256 * 1024 * 1024,
      maxMemoryPages: 65536,
      onStdout: (data) => {
        console.log("[squeak stdout]", new TextDecoder().decode(data));
      },
      onStderr: (data) => {
        if (stderrLines >= MAX_STDERR_LINES) return;
        stderrBuffer += new TextDecoder().decode(data);
        let newline = stderrBuffer.indexOf("\n");
        while (newline >= 0 && stderrLines < MAX_STDERR_LINES) {
          const line = stderrBuffer.slice(0, newline);
          stderrBuffer = stderrBuffer.slice(newline + 1);
          if (line) console.warn("[squeak stderr]", line);
          stderrLines += 1;
          newline = stderrBuffer.indexOf("\n");
        }
      },
    });
    await kernel.init(kernelBytes);

    blobUrls.push(...registerSqueakFiles(kernel, image, changes, sources));
    await kernel.ensureMaterialized(IMAGE_PATH);
    await kernel.ensureMaterialized(`/home/${CHANGES_NAME}`);
    await kernel.ensureMaterialized(`/home/${SOURCES_NAME}`);

    let activePid = kernel.nextPid;
    const args = [
      "squeak",
      "-maxoldspace",
      "512m",
      "-vm-display-fbdev",
      "-vm-sound-OSS",
      "-plugins",
      "/usr/lib/squeak",
      IMAGE_PATH,
    ];
    const spawnOptions = {
      cwd: "/home",
      env: [
        "HOME=/home",
        "TERM=linux",
        "SQUEAK_FBDEV=/dev/fb0",
        "SQUEAK_MSDEV=/dev/input/mice",
        "SQUEAK_MSPROTO=ps2",
      ],
    };

    const runSqueak = (restartOnCleanExit: boolean) => {
      activePid = kernel.nextPid;
      statusEl.textContent = restartOnCleanExit ? "Starting Squeak..." : "Restarting Squeak...";
      const exitPromise = kernel.spawn(squeakBytes, args, spawnOptions);

      attachCanvas(canvas, kernel.framebuffers, activePid, {
        getProcessMemory: (p) => kernel.getProcessMemory(p),
      });
      exitPromise
        .then((code) => {
          if (restartOnCleanExit && code === 0) {
            runSqueak(false);
            return;
          }
          statusEl.textContent = `Squeak exited with status ${code}.`;
          stopAudio?.();
          for (const url of blobUrls) URL.revokeObjectURL(url);
        })
        .catch((err) => {
          statusEl.textContent = `Squeak error: ${err.message ?? err}`;
          stopAudio?.();
          for (const url of blobUrls) URL.revokeObjectURL(url);
        });
    };

    wireKeyboard(kernel, () => activePid);
    wireMouse(kernel);
    stopAudio = startAudio(kernel);
    runSqueak(true);
    canvas.focus();
    statusEl.textContent = "Running. Click the display to capture mouse input.";
  } catch (err) {
    stopAudio?.();
    for (const url of blobUrls) URL.revokeObjectURL(url);
    statusEl.textContent = `Squeak failed: ${(err as Error).message ?? err}`;
    console.error(err);
    startBtn.disabled = false;
  }
});
