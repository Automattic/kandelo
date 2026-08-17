# SDL2 GLSL playground handoff #5 — resolution + font + mouse + editor-padding all fixed and browser-verified; STILL UNCOMMITTED

Fifth handoff in the chain (after `…-handoff-1.md` … `…-handoff-4.md`). Branch still `explore-dri-sdl2`. **Tip is still `3453ab5f9` (Phase 0).** Phases 1–4 plus this session's bug-fix work are all in the working tree, both vitest and the live browser demo pass, and **nothing new has been committed.** The user has not authorized a commit.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`. **Tip pushed: `3453ab5f9`** (Phase 0, on PR #709). Nothing else committed.
2. **This session fixed the four issues the user reported on the rendered Phase 4 demo** — all distinct root causes, all browser-verified by the user ("PERFECT"):
   - **Demo filled only part of the canvas** → KMS connector resolution.
   - **Font looked "MS-DOS"/pixellated** → `imageRendering` + bake size (and a Chrome GPU red herring).
   - **Mouse did nothing in the editor** → SDL evdev relative-vs-absolute classification.
   - **First editor line clipped against the top border** → missing top padding.
3. **vitest 4/4 green** (`cd host && npx vitest run sdl2`). **Playwright `kandelo-sdl2` spec green.** **User visually confirmed** resolution, font, click-to-place-cursor, and padding in Chrome.
4. **`local-binaries/programs/wasm32/sdl2.wasm` rebuilt** with the 28px atlas + `EDITOR_TOP_PAD` (built via `PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh`).
5. **Vite serves the demo at `http://127.0.0.1:5401/?demo=sdl2`** via `cd apps/browser-demos && npx vite`. The host TS (`@host/*`, `web-libs/kandelo-session/*`) is served **from source** — no host build step needed; just reload.

## The four fixes (root causes + resolutions)

### 1. Resolution mismatch — demo filled only part of the 1920×1080 canvas
- **Root cause:** the KMS virtual connector advertised a small mode (1024×768). `main.c` reads `SDL_GetCurrentDisplayMode` verbatim, so SDL created an undersized framebuffer that the 1920×1080 Modeset canvas scaled up.
- **Fix:** `host/src/dri/kms-registry.ts` → `buildVirtualConnectorMode` now advertises **1920×1080@60 (CTA-861 timing)**, matching the Modeset pane's 1920×1080 canvas. SDL's KMSDRM backend picks the preferred mode → 1920×1080 framebuffer that fills the canvas 1:1. `host_kms_addfb` (kernel.ts:1101) takes the FB size *from SDL*, so this single change is sufficient — **no kernel.ts edit** (it's on the don't-touch list).
- **Diagnostics added:** `main.c` prints `sdl2: display=WxH`; `renderer.c` `renderer_init` prints `sdl2: renderer drawable=WxH`. Both should read `1920x1080`.

### 2. "MS-DOS" / pixellated font
- **Two contributing causes:**
  - `Modeset.tsx` had `imageRendering: "pixelated"` — NEAREST-scaling the 1920 framebuffer down to the pane's CSS width makes antialiased text harsh/aliased. Changed to **`"auto"`**.
  - The atlas was baked at only **20px**. Bumped to **28px** in `renderer.c`: `TEXT_PIXEL_HEIGHT 20→28`, `TEXT_LINE_STRIDE 24→34`, atlas `256×192 → 256×240` (61440 B, under the `OP_TEX_IMAGE_2D` 65499-byte cap — verified in `libglesv2_stub.c`: cap is `0xFFFF - 36`), oversample `2×1 → 1×1` (2× horizontal at 28px would push the atlas to ~92 KB, over the cap). Filtering was already correct (`GL_LINEAR`, shader samples `.r`, blend on) — confirmed not the cause.
- **RED HERRING (cost ~3 turns):** after these fixes the user still saw black + `WARN: … (empty info log; headless GL?)` on every shader. **This was NOT the code.** Two things compounded:
  - The `caches.delete(...)` cache-bust command I gave broke the COI service worker (it serves fresh wasm from vite anyway — the bust was never needed and was harmful).
  - The real blocker: **Chrome had GPU acceleration disabled** (`chrome://gpu` "Graphics Feature Status" showed `WebGL: Disabled`, all software, while the "Hardware GPU" section showed everything accelerated). A software-only Chrome returns `null` from `getContext("webgl2")` on a worker-side OffscreenCanvas → "headless GL". Fixed by re-enabling **chrome://settings/system → "Use graphics acceleration when available"** + full Chrome restart (incognito/clear-site-data share the GPU process; only a full restart resets it). Playwright always works because it forces the GPU-capable `chromium` channel.

### 3. Mouse did nothing in the editor — THE key finding
- **Root cause:** SDL's evdev backend (`packages/registry/sdl2/sdl2-src/src/core/linux/SDL_evdev.c`) sets `item->relative_mouse = test_bit(REL_X) && test_bit(REL_Y)`. The kernel advertises **both `REL_X` and `REL_Y`** on event1 (`crates/kernel/src/input/mod.rs:69-70`), so SDL classifies event1 as a **relative** mouse and the `ABS_X`/`ABS_Y` handlers run only `else if (!item->relative_mouse)` — **every `EV_ABS` event is silently ignored.** (Also: the Modeset pane previously only sent PS/2 to `/dev/input/mice`, which SDL never reads.)
- **Fix — relative "peg-and-move" emulation of an absolute device** in `web-libs/kandelo-session/src/kernel-host.ts` `attachKmsDisplay` handle method `sendPointerAbs(x, y, buttons)`:
  1. **Peg frame:** `REL_X/Y = -4096` + SYN → SDL clamps the relative cursor to (0,0).
  2. **Move frame:** `REL_X/Y = (fbX, fbY)` + SYN → SDL flushes motion on SYN, cursor lands at the target.
  3. **Button frame:** `BTN_LEFT/RIGHT/MIDDLE` transition + SYN → button fires at the current cursor (SDL sends the button immediately at `mouse->focus`'s position — verified in SDL_evdev.c:341-349). Tracked `prevButtons` so only transitions are emitted.
  Three separate SYN frames are required because SDL applies motion on SYN but fires buttons immediately — the move must flush *before* the button.
- **Supporting changes:**
  - `host/src/input/browser-input-source.ts` — new constructor option `{ pointer?: boolean }`; when `false`, pointer/wheel handlers aren't bound (keyboard still works). Additive, browser-only (no Node parity concern).
  - `live-setup.ts` (sdl2 branch) — `new BrowserInputSource(window, { pointer: false })` so it doesn't double-feed event1; dims set to 1920×1080 (the framebuffer size). Note: in relative-mouse mode SDL clamps to the *window*, not the ABS range, so the dims are advisory now — comment updated to say so.
  - `Modeset.tsx` mouse effect — added `sendAbs(...)` → `handleRef.current?.sendPointerAbs(...)` on enter/move/down/up, using the existing `toCanvasCoords` (framebuffer pixels). Kept the PS/2 `sendMouseEvent` path so the `modeset.c` demo (which reads `/dev/input/mice`) still works; event1 ABS is harmless to it.
  - `web-libs/kandelo-session/src/kernel-host.ts` — added `injectInputEvent?(device, ev_type, code, value)` to the `KernelLike` interface and `sendPointerAbs(x, y, buttons)` to the `KmsDisplayHandle` interface. The concrete `kernel` (browser-kernel-host) already exposes `injectInputEvent`; `host.attachKernel(kernel)` (live-setup.ts:1173) passes the same object used as `kernelForSdl2`, so the call reaches the kernel.

### 4. First editor line clipped against the top border
- **Fix:** `editor.c` new `EDITOR_TOP_PAD = 8`, applied consistently in three places so render and click hit-test stay aligned: `compute_layout` (`visible_lines = (h - EDITOR_TOP_PAD) / line_h`), `editor_render` (`line_y = y + EDITOR_TOP_PAD`), `editor_pointer_set_cursor` (`row = (py - y - EDITOR_TOP_PAD) / line_h`).

## Files changed this session (working tree, uncommitted)

| Path | Change |
|---|---|
| `host/src/dri/kms-registry.ts` | connector mode 1024×768 → 1920×1080 (was already in tree pre-session) |
| `programs/sdl2/renderer.c` | 28px atlas (256×240, 1×1 oversample, stride 34) + `renderer drawable=` diagnostic |
| `programs/sdl2/editor.c` | `EDITOR_TOP_PAD = 8` applied to layout/render/hit-test |
| `web-libs/kandelo-session/src/kernel-host.ts` | `injectInputEvent` on `KernelLike`; `sendPointerAbs` on `KmsDisplayHandle` + impl (peg-and-move) |
| `apps/browser-demos/pages/kandelo/panes/Modeset.tsx` | `imageRendering` pixelated→auto (pre-session); `sendAbs` evdev routing on enter/move/down/up |
| `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` | `BrowserInputSource(window, { pointer:false })` + ABS dims 1920×1080 |
| `host/src/input/browser-input-source.ts` | `{ pointer?: boolean }` constructor option (keyboard-only mode) |
| `programs/sdl2/main.c` | display-mode query (`sdl2: display=WxH`) — from prior session |
| `programs/sdl2/{editor,renderer}.{c,h}`, `third_party/`, `presets/`, `scripts/build-programs.sh`, `libc/glue/libglesv2_stub.c`, tests | Phase 4 baseline (see handoff-4) |

## Build / run / verify

```bash
# Rebuild the wasm after any programs/sdl2/*.c edit:
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh
# vitest gate:
cd host && npx vitest run sdl2     # expect 4/4 green; cd .. afterward
# live demo (NOT ./run.sh browser — its prepare step source-builds OpenSSL; the Automattic/kandelo binaries-abi-v16 release 404s):
cd apps/browser-demos && npx vite  # http://127.0.0.1:5401/?demo=sdl2
# Playwright (reuses the running vite on 5401 via reuseExistingServer):
cd apps/browser-demos && npx playwright test kandelo-sdl2 --reporter=line
```

Verify in `sdl2` stdout: `display=1920x1080`, `renderer drawable=1920x1080`, no `headless GL?` WARNs (those mean GPU/WebGL2 is unavailable — check chrome://gpu, NOT the code).

## Open items

1. **Phases 1+2+3+4 + this session's fixes are all uncommitted.** When authorized, suggested split is the four Phase commits from handoff-4 plus a fifth: `demo(sdl2): 1920×1080 resolution + 28px font + evdev-relative pointer + editor top-pad`.
2. **Full CLAUDE.md gate not re-run** (cargo / libc-test / posix / ABI snapshot). This session touched only user-space C + browser/host TS + `kms-registry.ts`; no syscall/struct/export changes, so **no `ABI_VERSION` bump**. Run the full gate before any commit/PR.
3. **Phase 5 not started** — audio + FFT + `iAudio` uniform (chip synth → ALSA → 128 log-bins → `GL_LUMINANCE` 1D texture → `presets/image/audio_bars.frag`). The user's Fractal-Land-style image+sound request is Phase 7; Phases 5+6 are the gate.
4. **`sendPointerAbs` pegs on every move** (3 evdev frames/event). Harmless (the intermediate (0,0) motion is overwritten in the same poll-drain before render) but if iMouse jitter ever shows, switch to delta-tracking with a peg only on canvas re-entry.

## Things NOT to do next session

- **Do NOT re-run the `caches.delete(...)` cache-bust.** Vite serves fresh wasm + TS directly; the bust breaks the COI service worker. If a stale asset is ever suspected, restart vite (`--force`) instead.
- **Do NOT diagnose a black canvas + "headless GL?" as a code bug first.** Check `chrome://gpu` — if the top "Graphics Feature Status" shows `WebGL: Disabled` while "Hardware GPU" shows it accelerated, it's a disabled GPU process; re-enable hardware acceleration + full Chrome restart.
- **Do NOT switch the pointer back to `EV_ABS`.** SDL classifies event1 as relative (REL_X+REL_Y advertised) and ignores ABS. Keep the peg-and-move relative emulation.
- **Do NOT change the kernel's event1 capabilities** to drop REL (to force SDL into ABS mode) — `modeset.c` / fbDOOM rely on relative + pointer-lock, and it's risky input-device surface.
- **Do NOT revert `imageRendering: "auto"` to `"pixelated"`** on the Modeset canvas, and **do NOT revert to `stbtt_BakeFontBitmap`** or push the atlas past 65499 bytes.
- **Do NOT bump `ABI_VERSION`** — this session's changes are user-space + host TS, additive.
- **Do NOT touch** `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files.
- **Do NOT commit without explicit user authorization.**

## Standing instruction for next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-18-sdl2-glsl-playground-handoff-5.md` first — it is authoritative (handoffs 1–4 are historical). Branch `explore-dri-sdl2`, tip `3453ab5f9` (Phase 0, pushed to PR #709); Phases 1–4 plus this session's four browser-verified fixes (KMS connector 1920×1080 in `host/src/dri/kms-registry.ts`; 28px font atlas 256×240 1×1-oversample + `renderer drawable=` diagnostic in `programs/sdl2/renderer.c`; `EDITOR_TOP_PAD=8` in `programs/sdl2/editor.c`; evdev relative 'peg-and-move' pointer emulation in `web-libs/kandelo-session/src/kernel-host.ts` `sendPointerAbs` + `injectInputEvent` on `KernelLike`, wired from `Modeset.tsx`, with `BrowserInputSource(window,{pointer:false})` + ABS dims 1920×1080 in `live-setup.ts` and a `{pointer?:boolean}` option in `host/src/input/browser-input-source.ts`; `imageRendering:'auto'` on the Modeset canvas) are all in the working tree and UNCOMMITTED. vitest 4/4 green (`cd host && npx vitest run sdl2`), Playwright `kandelo-sdl2` green, user confirmed the live demo. Rebuild the wasm with `PATH=\"/nix/var/nix/profiles/default/bin:$PATH\" scripts/dev-shell.sh bash scripts/build-programs.sh`; run the demo via `cd apps/browser-demos && npx vite` at `http://127.0.0.1:5401/?demo=sdl2` (NOT `./run.sh browser`, and do NOT use `caches.delete` — vite serves fresh; a black canvas with 'headless GL?' WARNs means Chrome GPU acceleration is off, check chrome://gpu). KEY FACT: SDL marks event1 a relative mouse because the kernel advertises REL_X+REL_Y, so EV_ABS is ignored — keep the peg-and-move relative emulation, do NOT revert to EV_ABS, do NOT bump ABI_VERSION, do NOT touch host/src/kernel.ts or host/src/webgl/. NEXT: ask the user whether to (a) commit everything (four Phase commits + a fifth fixes commit) after running the full CLAUDE.md test gate, or (b) start Phase 5 (audio + FFT + `iAudio` uniform: chip synth → ALSA → 128 log-bins → GL_LUMINANCE 1D texture → `presets/image/audio_bars.frag`; the Fractal-Land image+sound demo is Phase 7, gated on 5+6). Do NOT commit without explicit user authorization."*
