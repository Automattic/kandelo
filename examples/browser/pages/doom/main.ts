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
import { BrowserKernel } from "../../lib/browser-kernel";
import { attachCanvas } from "../../../../host/src/framebuffer/canvas-renderer";
import fbdoomWasmUrl from "../../../../examples/libs/fbdoom/fbdoom.wasm?url";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const canvas = document.getElementById("fb") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;

const WAD_VFS_PATH = "/usr/local/games/doom/doom1.wad";
const WAD_URL = "/assets/doom/doom1.wad";

/**
 * Browser KeyboardEvent.code → AT-set-1 scancode (the encoding fbDOOM's
 * MEDIUMRAW reader expects). The high bit (0x80) flags release; we
 * send the same scancode for keydown and keyup with that bit set on
 * keyup.
 *
 * Coverage is the keys fbDOOM cares about: arrows, Enter, Esc, Space,
 * Ctrl (fire), Shift (run), Alt (strafe modifier), letters and digits.
 */
const SCANCODE: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
  Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C, ControlLeft: 0x1D,
  KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2A, Backslash: 0x2B,
  KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35,
  ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3A, F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F,
  F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  // Arrow keys: extended (E0-prefixed) on AT, but fbDOOM's at_to_doom
  // table maps the non-prefixed equivalents. Use the keypad codes,
  // which fbDOOM treats as arrows.
  ArrowUp: 0x48, ArrowLeft: 0x4B, ArrowRight: 0x4D, ArrowDown: 0x50,
  // Right-Ctrl is also remapped to fire in fbDOOM via its key-table tweaks.
  ControlRight: 0x1D, AltRight: 0x38,
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

  // Lazy-register the WAD: fetched on first read, no upfront cost.
  // doom1.wad is gitignored; users provide it per
  // examples/browser/public/assets/doom/README.md.
  // Probe the size with a HEAD request so the VFS knows the file size
  // up front (registerLazyFile requires a size).
  let wadSize = 0;
  try {
    const head = await fetch(WAD_URL, { method: "HEAD" });
    if (!head.ok) throw new Error(`HTTP ${head.status}`);
    wadSize = Number(head.headers.get("content-length") ?? 0);
    if (!wadSize) throw new Error("Content-Length missing");
  } catch (err) {
    statusEl.textContent =
      `Couldn't find ${WAD_URL} — see examples/browser/public/assets/doom/README.md.`;
    console.error("WAD HEAD probe failed:", err);
    startBtn.disabled = false;
    return;
  }
  kernel.registerLazyFiles([
    { path: WAD_VFS_PATH, url: WAD_URL, size: wadSize, mode: 0o444 },
  ]);
  // The lazy-fetch path materializes on-exec, but the WAD is a *data*
  // file fbDOOM will open() at runtime. Pull it into the VFS now so
  // the synchronous read path inside the kernel never has to fetch.
  statusEl.textContent = `Loading WAD (${(wadSize / (1024 * 1024)).toFixed(1)}MB)…`;
  await kernel.ensureMaterialized(WAD_VFS_PATH);

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

  // Keyboard input → AT-set-1 scancode bytes on stdin (MEDIUMRAW format).
  canvas.focus();
  const sendScancode = (code: number, released: boolean) => {
    const byte = released ? code | 0x80 : code & 0x7F;
    kernel.appendStdinData(pid, new Uint8Array([byte]));
  };
  const handleKey = (e: KeyboardEvent, released: boolean) => {
    const code = SCANCODE[e.code];
    if (code !== undefined) {
      sendScancode(code, released);
      e.preventDefault();
    }
  };
  canvas.addEventListener("keydown", (e) => handleKey(e, false));
  canvas.addEventListener("keyup", (e) => handleKey(e, true));
  canvas.addEventListener("click", () => canvas.focus());

  statusEl.textContent =
    "Running. Click the canvas to capture keyboard. Arrows + Enter / Esc / Ctrl / Space.";

  exitPromise
    .then((status) => {
      statusEl.textContent = `fbdoom exited with status ${status}.`;
    })
    .catch((err) => {
      statusEl.textContent = `fbdoom error: ${err.message ?? err}`;
    });
});
