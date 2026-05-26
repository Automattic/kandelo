/**
 * DOOM browser demo — runs an unmodified fbDOOM build inside the
 * wasm-posix-kernel.
 *
 * Pipeline:
 *   1. BrowserKernel boots; lazy-register doom1.wad.
 *   2. Spawn fbdoom.wasm with `-iwad /usr/local/games/doom/doom1.wad`.
 *   3. fbdoom mmaps /dev/fb0; the kernel forwards the binding to the main
 *      thread; attachCanvas runs a RAF loop over the bound region.
 *   4. Keyboard events on the canvas become Linux input keycodes encoded
 *      as MEDIUMRAW bytes; fbDOOM's i_input_tty decodes them.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { attachCanvas } from "../../../../host/src/framebuffer/canvas-renderer";
import {
  attachLinuxMediumRawKeyboard,
  attachPointerLockMouse,
  createPcmAudioScheduler,
} from "../../../../host/src/framebuffer/browser-controls";
// `@binaries/` resolves to local-binaries/ first, then binaries/ — so
// a fresh `bash build-fbdoom.sh` shadows the cached release without
// needing to mirror the symlinks under binaries/.
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";
import kernelWasmUrl from "@kernel-wasm?url";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const canvas = document.getElementById("fb") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;

const WAD_VFS_PATH = "/usr/local/games/doom/doom1.wad";

// DOOM shareware IWAD — id Software, freely redistributable.
// Mirror: SlitaZ Linux package sources (hosted at iBiblio). This pin
// serves the bare WAD; Internet Archive copies wrap it in installer
// formats that need DOS to unpack.
const SHAREWARE_WAD_URL =
  "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
const SHAREWARE_WAD_SHA256 =
  "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";
const WAD_CACHE_NAME = "fbdoom-wad";
const traceSyscalls = new URLSearchParams(location.search).has("traceSyscalls");

function ensureDirectory(kernel: BrowserKernel, path: string): void {
  try {
    kernel.fs.mkdir(path, 0o755);
  } catch {
    // Exists, or fbDOOM will report the real filesystem problem on startup.
  }
}

function ensureSymlink(kernel: BrowserKernel, target: string, path: string): void {
  try {
    kernel.fs.symlink(target, path);
  } catch {
    // Exists, or fbDOOM will report the real filesystem problem on startup.
  }
}

function ensureDoomSaveDirectories(kernel: BrowserKernel): void {
  // fbDOOM should save under HOME. Current release builds still contain an old
  // /mnt config-dir hack, so keep /mnt as an alias rather than a separate save
  // root until the rebuilt binary with the source patch is everywhere.
  ensureDirectory(kernel, "/home");
  ensureSymlink(kernel, "/home", "/mnt");
  ensureDirectory(kernel, "/home/.fdoom.tar");
  ensureDirectory(kernel, "/home/.fdoom.tar/savegame");
}

/**
 * Fetch the shareware IWAD, verifying its SHA-256 and caching it via
 * the Cache API. The cache key is the canonical mirror URL so the same
 * entry is reused across dev (which routes through vite's /cors-proxy)
 * and prod (where the service worker rewrites cross-origin requests).
 *
 * Returns the WAD bytes; throws with a status-friendly message on
 * fetch / verification failure.
 */
async function loadSharewareWad(
  setStatus: (text: string) => void,
): Promise<Uint8Array> {
  const cache = await caches.open(WAD_CACHE_NAME);
  const cached = await cache.match(SHAREWARE_WAD_URL);
  if (cached) {
    setStatus("Loading cached DOOM shareware IWAD…");
    const buf = await cached.arrayBuffer();
    return new Uint8Array(buf);
  }

  // Dev: route through the vite /cors-proxy middleware (the mirror
  // does not send Access-Control-Allow-Origin).
  // Prod: hit the bare URL — the service worker rewrites cross-origin
  // requests transparently. See host/src/browser-kernel-worker-entry.ts.
  const fetchUrl = import.meta.env.DEV
    ? `/cors-proxy?url=${encodeURIComponent(SHAREWARE_WAD_URL)}`
    : SHAREWARE_WAD_URL;

  setStatus("Downloading DOOM shareware IWAD (~4 MB)…");
  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching doom1.wad`);
  }
  const buf = await response.arrayBuffer();
  const bytes = new Uint8Array(buf);

  setStatus("Verifying DOOM shareware IWAD…");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== SHAREWARE_WAD_SHA256) {
    throw new Error(
      `doom1.wad sha256 mismatch — expected ${SHAREWARE_WAD_SHA256}, got ${hex}`,
    );
  }

  // Stash under the canonical URL so the next page load is a hit
  // regardless of dev/prod routing. Build a synthetic Response since
  // the original `response` body has already been consumed by
  // .arrayBuffer() (and proxied responses may lack CORS headers the
  // Cache API otherwise tolerates).
  await cache.put(
    SHAREWARE_WAD_URL,
    new Response(bytes, {
      headers: {
        "Content-Type": "application/x-doom",
        "Content-Length": String(bytes.byteLength),
      },
    }),
  );
  return bytes;
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  statusEl.textContent = "Booting kernel…";

  // Capture stderr/stdout for visibility while bringing the demo up.
  const kernel = new BrowserKernel({
    enableSyscallLog: traceSyscalls,
    onStdout: (data) => {
      console.log("[doom stdout]", new TextDecoder().decode(data));
    },
    onStderr: (data) => {
      console.warn("[doom stderr]", new TextDecoder().decode(data));
    },
  });

  const kernelBytes = await fetch(kernelWasmUrl).then((r) => r.arrayBuffer());
  await kernel.init(kernelBytes);

  // The IWAD is fetched at runtime — not bundled. Verify the SHA-256
  // and cache the result via the Cache API so the second page load
  // skips the network round-trip entirely. The bytes are then handed
  // to the lazy-file path via a blob URL so the existing materialize
  // flow stays unchanged.
  let wadBytes: Uint8Array;
  try {
    wadBytes = await loadSharewareWad((text) => {
      statusEl.textContent = text;
    });
  } catch (err) {
    statusEl.textContent = `Couldn't load doom1.wad: ${
      (err as Error).message ?? err
    }`;
    console.error("WAD fetch failed:", err);
    startBtn.disabled = false;
    return;
  }
  const wadBlobBytes = new ArrayBuffer(wadBytes.byteLength);
  new Uint8Array(wadBlobBytes).set(wadBytes);
  const wadBlobUrl = URL.createObjectURL(
    new Blob([wadBlobBytes], { type: "application/x-doom" }),
  );
  kernel.registerLazyFiles([
    {
      path: WAD_VFS_PATH,
      url: wadBlobUrl,
      size: wadBytes.byteLength,
      mode: 0o444,
    },
  ]);
  // Materialize from the blob URL on the main thread so the kernel
  // worker's synchronous read path inside fbDOOM never has to fetch.
  statusEl.textContent = `Loading WAD (${(
    wadBytes.byteLength / (1024 * 1024)
  ).toFixed(1)}MB)…`;
  await kernel.ensureMaterialized(WAD_VFS_PATH);
  URL.revokeObjectURL(wadBlobUrl);
  ensureDoomSaveDirectories(kernel);

  statusEl.textContent = "Loading fbdoom.wasm…";
  const fbdoomBytes = await fetch(fbdoomWasmUrl).then((r) => r.arrayBuffer());

  statusEl.textContent = "Spawning fbdoom…";
  // Capture the pid the kernel will assign before spawn() bumps nextPid.
  const pid = kernel.nextPid;
  const exitPromise = kernel.spawn(
    fbdoomBytes,
    ["fbdoom", "-iwad", WAD_VFS_PATH],
    { env: ["HOME=/home", "TERM=linux"], cwd: "/home" },
  );

  attachCanvas(canvas, kernel.framebuffers, pid, {
    getProcessMemory: (p) => kernel.getProcessMemory(p),
  });

  // Audio output → AudioContext. fbDOOM mixes SFX + OPL2 music into
  // `/dev/dsp`; the shared scheduler drains that PCM ring and feeds Web
  // Audio. The boot button click is a user gesture, so resume usually
  // succeeds here; clicking the canvas tries again if the browser still
  // has the context suspended.
  const audio = createPcmAudioScheduler(kernel);
  void audio.resume();

  // Mouse input → /dev/input/mice PS/2 packets. Pointer Lock gives
  // unbounded relative motion; the shared helper scales browser CSS-pixel
  // deltas into mouse mickeys and splits large deltas into legal PS/2
  // packets so fast turns are not clipped by the signed-byte device.
  const pointerMouse = attachPointerLockMouse(canvas, kernel, {
    requestPointerLockOnClick: false,
  });
  canvas.addEventListener("click", () => {
    canvas.focus();
    void audio.resume();
    pointerMouse.requestCapture();
  });

  // Releasing focus also releases pointer lock. The keyboard helper flushes
  // held keys on the same blur event.
  canvas.addEventListener("blur", () => {
    pointerMouse.releaseCapture();
  });

  // Keyboard input → Linux MEDIUMRAW bytes on stdin. The helper forwards
  // real keycodes (W/A/S/D stay letters) and de-dups browser autorepeat.
  canvas.focus();
  const keyboard = attachLinuxMediumRawKeyboard(canvas, {
    sendInput: (bytes) => kernel.appendStdinData(pid, bytes),
  }, {
    onReleaseCapture: () => canvas.blur(),
  });

  statusEl.textContent =
    "Running. Click the canvas to capture keyboard + mouse. Esc to release pointer.";

  exitPromise
    .then((status) => {
      statusEl.textContent = `fbdoom exited with status ${status}.`;
    })
    .catch((err) => {
      statusEl.textContent = `fbdoom error: ${err.message ?? err}`;
    })
    .finally(() => {
      keyboard.close();
      pointerMouse.close();
      audio.close();
    });
});
