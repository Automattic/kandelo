/**
 * DOOM browser demo — runs an unmodified fbDOOM build inside the
 * wasm-posix-kernel.
 *
 * Pipeline:
 *   1. BrowserKernel boots; lazy-register doom1.wad.
 *   2. Spawn fbdoom.wasm with `-iwad /usr/local/games/doom/doom1.wad`.
 *   3. fbdoom mmaps /dev/fb0; the kernel forwards the binding to the main
 *      thread; attachCanvas runs a RAF loop over the bound region.
 *   4. Keyboard events on the canvas become AT-set-1 scancodes (the
 *      Linux MEDIUMRAW protocol); fbDOOM's i_input_tty decodes them.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { attachCanvas } from "../../../../host/src/framebuffer/canvas-renderer";
import {
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

/**
 * Browser `KeyboardEvent.code` → Linux *keycode* (the values in
 * `<linux/input-event-codes.h>`, KEY_*). fbDOOM's `at_to_doom` table
 * is keyed on those codes — for the printable / Esc / Enter / Space
 * range they happen to match AT set-1 scancodes (KEY_ESC=1=0x01,
 * KEY_ENTER=28=0x1c, KEY_SPACE=57=0x39), but arrows differ:
 *   - AT set-1 keypad up:   0x48   →   at_to_doom[0x48] = 0  (no key)
 *   - Linux keycode UP:    103     →   at_to_doom[103]   = KEY_UPARROW
 * So we send Linux keycodes. WASD aliases to the same arrow keycodes
 * since fbDOOM dispatches movement on KEY_*ARROW only.
 *
 * Press / release encoding is standard Linux MEDIUMRAW: bit 7 clear
 * for press, bit 7 set for release. fbDOOM's `*pressed = (data &
 * 0x80) == 0x80` followed by `if (!pressed)` triggering ev_keydown
 * matches that — the variable is named confusingly but the logic
 * is correct.
 */
const SCANCODE: Record<string, number> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39,
  Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57,
  CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  // Right modifiers — Linux keycodes for the right-side variants.
  ControlRight: 97, AltRight: 100,
  // Arrows + WASD movement aliases — Linux input KEY_UP/DOWN/LEFT/RIGHT
  // are 103, 108, 105, 106. fbDOOM's at_to_doom maps these to its
  // KEY_UPARROW/DOWNARROW/LEFTARROW/RIGHTARROW.
  ArrowUp:    103, KeyW: 103,
  ArrowDown:  108, KeyS: 108,
  ArrowLeft:  105, KeyA: 105,
  ArrowRight: 106, KeyD: 106,
};

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  statusEl.textContent = "Booting kernel…";

  // Capture stderr/stdout for visibility while bringing the demo up.
  const kernel = new BrowserKernel({
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

  // Keyboard input → AT-set-1 scancode bytes on stdin. fbDOOM's
  // `kbd_read` reads the high bit as the *press* flag (inverse of
  // standard MEDIUMRAW), so we set it on keydown and clear it on
  // keyup. We also de-dup keydown autorepeat — fbDOOM treats every
  // press as a fresh edge, which would re-arm the move and freeze
  // the player on auto-repeat.
  canvas.focus();
  const heldKeys = new Set<string>();
  const sendScancode = (code: number, pressed: boolean) => {
    // Linux MEDIUMRAW: high bit clear = press, set = release.
    const byte = pressed ? code & 0x7f : code | 0x80;
    kernel.appendStdinData(pid, new Uint8Array([byte]));
  };
  canvas.addEventListener("keydown", (e) => {
    const code = SCANCODE[e.code];
    if (code === undefined) return;
    e.preventDefault();
    if (heldKeys.has(e.code)) return; // ignore autorepeat
    heldKeys.add(e.code);
    sendScancode(code, true);
  });
  canvas.addEventListener("keyup", (e) => {
    const code = SCANCODE[e.code];
    if (code === undefined) return;
    e.preventDefault();
    heldKeys.delete(e.code);
    sendScancode(code, false);
  });

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

  // Releasing focus (e.g. Cmd-tab while moving) leaves the held set
  // out of sync; flush it on blur so the player doesn't keep walking
  // or firing.
  canvas.addEventListener("blur", () => {
    for (const k of heldKeys) {
      const code = SCANCODE[k];
      if (code !== undefined) sendScancode(code, false);
    }
    heldKeys.clear();
    pointerMouse.releaseCapture();
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
      pointerMouse.close();
      audio.close();
    });
});
