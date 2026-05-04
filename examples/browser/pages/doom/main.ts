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
// Both files come from the same fbdoom package archive (see
// examples/libs/fbdoom/deps.toml — multi-output → per-program subdir).
// `@binaries/` resolves to local-binaries/ first, then binaries/ — so
// a fresh `bash build-fbdoom.sh` shadows the cached release without
// needing to mirror the symlinks under binaries/.
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom/fbdoom.wasm?url";
import wadUrl from "@binaries/programs/wasm32/fbdoom/doom1.wad?url";
import kernelWasmUrl from "@kernel-wasm?url";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const canvas = document.getElementById("fb") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;

const WAD_VFS_PATH = "/usr/local/games/doom/doom1.wad";

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

  // The WAD ships in fbdoom's cache archive — Vite's ?url import
  // resolves through the `binaries/programs/wasm32/fbdoom/doom1.wad`
  // symlink to the canonical cache path. Probe the size with a HEAD
  // request so registerLazyFile gets a known size up front.
  let wadSize = 0;
  try {
    const head = await fetch(wadUrl, { method: "HEAD" });
    if (!head.ok) throw new Error(`HTTP ${head.status}`);
    wadSize = Number(head.headers.get("content-length") ?? 0);
    if (!wadSize) throw new Error("Content-Length missing");
  } catch (err) {
    statusEl.textContent =
      "Couldn't load doom1.wad from the fbdoom package — re-run " +
      "`bash examples/libs/fbdoom/build-fbdoom.sh` or `./run.sh build fbdoom`.";
    console.error("WAD HEAD probe failed:", err);
    startBtn.disabled = false;
    return;
  }
  kernel.registerLazyFiles([
    { path: WAD_VFS_PATH, url: wadUrl, size: wadSize, mode: 0o444 },
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
  // Releasing focus (e.g. Cmd-tab while moving) leaves the held set
  // out of sync; flush it on blur so the player doesn't keep walking.
  canvas.addEventListener("blur", () => {
    for (const k of heldKeys) {
      const code = SCANCODE[k];
      if (code !== undefined) sendScancode(code, false);
    }
    heldKeys.clear();
  });
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
