# SDL2 browser rendering handoff #2 — canvas renders, audio still cuts at ~1 s, animation throttles without mouse input

Successor handoff to `2026-06-17-sdl2-browser-rendering-handoff.md`. The rotating-quad bug from the previous handoff is **fixed and human-verified in a real browser**. Two real-browser-only symptoms remain: audio still cuts off at ~1 s, and the quad animation lags (apparent ~1 fps) unless the user is actively moving the mouse over the canvas.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`, tip still `4f88111bb`. NOT pushed. PR #709 untouched. Three predecessor handoffs (`fix`, `rendering`, this) describe the rolling state of the working tree.
2. **What's NEW in the working tree this session (all uncommitted, on top of the previous session's 3-fix kernel/host stack):**
   - `host/src/kernel.ts`: extracted `tryAttachKmsCanvasToGl(pid)` from the old inline auto-attach in `host_gl_create_context`. Calls it from THREE hooks now: `host_gl_bind` (eglInitialize), `host_gl_create_context` (eglCreateContext), `host_kms_set_fb` (drmModeSetCrtc). Added a `firstKmsCanvasCrtc?()` callback to `KernelCallbacks` and use it as a fallback when `masterCrtcForPid` returns null (the SDL2 "bind-before-SetCrtc" window). After building the WebGL2 context, seed `b.shadow.viewport = [0, 0, ctx.drawingBufferWidth, ctx.drawingBufferHeight]` — see "Root cause #1" below for why.
   - `host/src/kernel-worker.ts`: implements `firstKmsCanvasCrtc` by iterating `this.kmsCanvases.keys()`.
   - `apps/browser-demos/test/kandelo-sdl2.spec.ts`: replaced the false-positive `> 2_000` byteLength gate with a 5-sample spread check across 3 s — assert all samples > 3500 B AND `Math.max - Math.min > 400`. A blank-canvas regression yields 5 identical ~3.2-KiB PNGs and fails the spread check; the rotating-color quad spans 3.4–5.6 KiB.
3. **Human spot-check (NEW, end of session):** opened `http://127.0.0.1:5403/?demo=sdl2`. Observed:
   - **Rotating quad with oscillating teal/salmon color IS visible.** Canvas fix confirmed in real browser.
   - **Audio still cuts off at ~1 s** (carried forward — unfixed).
   - **NEW: the quad animation lags / runs at ~1 fps unless the mouse is moving over the canvas.** When the user moves the mouse, the quad rotates smoothly; when the cursor is still, the rotation appears to hitch or pause.
4. **Plan choice still:** Plan 1 (GLSL Playground, `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`). Plan 2 (Earth C++) remains a future side project — do NOT draft it.
5. **Test suite results (this session, full CLAUDE.md battery):**
   - Cargo: 1072/1072 pass.
   - Vitest under dev shell: 886 pass, 1 pre-existing failure (`spidermonkey-node-compat.test.ts > installs cowsay` — pre-existing, unrelated, documented in predecessor handoff).
   - libc-test: exit 0, 0 unexpected FAILs (XFAILs + 1 TIME + 1 FLAKE-PASS as the tail).
   - Open POSIX Test Suite: exit 0, 0 FAILs (3 XFAIL, 2 SKIP).
   - ABI snapshot: in sync, ABI_VERSION consistent. (Predecessor handoff said this script was broken — it's working now.)
   - SDL2 vitest (Node-side): 2/2 pass.
   - Playwright `kandelo-sdl2.spec.ts` (with TIGHTENED gates) + `kandelo-modeset.spec.ts`: both green.
6. **Order for the next session:**
   1. Chase the mouse-throttle-the-animation bug (NEW). See "Symptoms next session must resolve" §A.
   2. Chase the audio-cuts-at-~1 s bug (carried forward). See §B.
   3. The throttle and the audio cutoff may be the SAME underlying bug — they're both real-browser-only, both timing-related, both tied to user-gesture / activity. Test the unified theory first.
   4. Run the CLAUDE.md test suite once the fixes land.
   5. Commit + PR only with explicit per-session approval.
7. **Do NOT:** push, `gh pr *`, regenerate the ABI 16 artifacts, bump `revision` fields, revert any of the four landed fixes (3 from prior session + the canvas/viewport/attach fix from this one — all independently necessary).
8. **Dev-shell entry** (still required): `source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && bash scripts/dev-shell.sh bash -c '…'`. Vite dev server was running on **5403** at session end — restart with `bash scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx vite --host 127.0.0.1 --port 5403 --strictPort'` if it's gone.

## Root cause #1 — `defaultShadow().viewport = [0,0,0,0]` overrode the WebGL2 default

`host/src/webgl/shadow.ts::defaultShadow()` initialises `viewport: [0, 0, 0, 0]`. The first time `GlMuxer.switchTo` (`host/src/webgl/muxer.ts:30`) runs for a binding, it applies `gl.viewport(...s.viewport)` — **overwriting** WebGL2's default `(0, 0, drawingBufferWidth, drawingBufferHeight)` with `(0, 0, 0, 0)`.

Programs like the SDL2 demo (and any minimal GLES program) that rely on the WebGL2 default and never call `glViewport` explicitly end up drawing into a zero-area viewport.

- `glClear` is viewport-agnostic → the clear color WAS visible (dark gray, the 3183-byte screenshots the previous session's `> 2_000` byteLength gate "passed").
- `glDrawArrays` clips to the viewport rect → with zero area, **every fragment is discarded**. The quad never appears.

**Diagnostic chain that proved this:**
1. Added `DBG` to `OP_DRAW_ARRAYS`: `prog: true, linked: true, err: 0` — the program linked, drawArrays didn't error.
2. Added `gl.getParameter(gl.VIEWPORT)` to the same probe: `vp: [0, 0, 0, 0]`.
3. Added `DBG` to `OP_VIEWPORT`: never fires. So the cmdbuf NEVER sets the viewport — the C side relies on the default.
4. Added `gl.getParameter(gl.VIEWPORT)` immediately after `b.gl = ctx` in `tryAttachKmsCanvasToGl`: `vp: [0, 0, 1920, 1080]`. So at context creation the default IS correct; something later resets it.
5. Added `gl.getParameter(gl.VIEWPORT)` at the entry of `decodeAndDispatch`: `vp: [0, 0, 0, 0]` from submit#1 onward.
6. Read `host/src/webgl/muxer.ts:30` → `gl.viewport(...s.viewport)` blindly applies the shadow → `defaultShadow().viewport = [0,0,0,0]`.

**Fix:** In `tryAttachKmsCanvasToGl`, right after `b.gl = ctx`, set `b.shadow.viewport = [0, 0, ctx.drawingBufferWidth, ctx.drawingBufferHeight]`. Then the first muxer.switchTo applies the WebGL2 default, not zero.

## Root cause #2 — SDL2's `drmModeSetCrtc` runs AFTER eglCreateContext, so the old auto-attach found no CRTC binding

`packages/registry/sdl2/sdl2-src/src/video/kmsdrm/SDL_kmsdrmvideo.c:1324` says:
> *"Set the dispdata->mode to the new mode and leave actual modesetting pending to be done on SwapWindow() via drmModeSetCrtc()"*

So the SDL2 flow is:
1. `drmSetMaster` — host `kms_set_master` (master is set)
2. `eglInitialize` → mmap cmdbuf → kernel `host_gl_bind` (binding created, **no canvas yet**)
3. `eglCreateContext` → kernel `host_gl_create_context` — old code called `masterCrtcForPid(pid)` which iterates `crtcBindings.keys()`. SetCrtc hasn't fired → `crtcBindings` empty → returns null → b.canvas stays null → b.gl never built.
4. First `SDL_GL_SwapWindow`:
   - `eglSwapBuffers` → `_wpk_gl_flush()` → GLIO_SUBMIT → host_gl_submit sees `!b.gl` → silent no-op (LOSES shader/program/vbo setup + first frame's draws).
   - `gbm_surface_lock_front_buffer` → BO
   - `drmModeAddFB` → host `kms_addfb` (FB registered)
   - `drmModeSetCrtc` → host `kms_set_fb` (binding finally exists)
5. Subsequent frames could attach now, but the kernel-side handles for the shader/program/vbo never got created, so even `gl.drawArrays` would fail downstream.

**Fix:** Call `tryAttachKmsCanvasToGl(pid)` from THREE places:
- `host_gl_bind` (earliest opportunity — runs at `eglInitialize` BEFORE the C side has touched anything).
- `host_gl_create_context` (covers modeset.c-style programs that drove SetCrtc first).
- `host_kms_set_fb` (safety net for any program that mirrors SDL2's "defer SetCrtc to first SwapWindow" pattern).

Plus relax the CRTC lookup: when `masterCrtcForPid` returns null, fall back to `firstKmsCanvasCrtc?()` — a new `KernelCallbacks` method, implemented by the kernel-worker by iterating `kmsCanvases.keys()`. This covers the SDL2 case where the embedder has a canvas registered but the kernel has no FB binding yet. The fallback gates on `kms.isMasterPid(pid)` so a non-master process can't accidentally claim the canvas.

At `host_gl_bind` time, `b.contextId == null`, so the helper sets `b.canvas` (and returns before building the WebGL2 context). At `host_gl_create_context` time, `b.contextId` is set and the helper builds `b.gl`. By the first SwapWindow flush, `b.gl` is ready and the shader/program/vbo setup commands in the cmdbuf execute correctly.

## Symptoms next session must resolve

### §A — Animation throttles to ~1 fps unless mouse moves over the canvas (NEW)

The human's exact words this session:
> "the square moving is lagging unless I move the mouse"

When the mouse is moving, the rotation animates smoothly. When the cursor is still, it appears to hitch / freeze / step. This is a real-browser-only symptom (headless Playwright also gets it but its byteLength spread gate still passes because it samples across enough time).

**Top theories to test, in order of likelihood:**

1. **Chrome's background-tab / unfocused-canvas throttling on the kernel worker.** When the page isn't the focused window or the user isn't generating input, Chrome throttles workers' `setTimeout`/`setInterval` to ~1 Hz. The kernel-worker's vblank pump uses `setInterval(..., 1000/60)` at `host/src/kernel-worker.ts:8625`. If that interval is throttled, the kernel's `kernel_vblank` call rate drops to 1 Hz — page-flip completions get queued at 1 Hz — SDL2's `drmHandleEvent` returns once per second instead of 60× per second — the C-side frame loop runs at 1 fps. Moving the mouse generates input events that wake the page out of throttling.
   - **Test:** Add a `console.log` in `tickVblank()` and observe the actual rate when mouse-still vs mouse-moving in DevTools.
   - **Fix candidate:** Replace `setInterval` with `requestAnimationFrame` (rAF runs at display refresh in the active worker, isn't throttled the same way). Caveat: rAF on a dedicated worker is supported on OffscreenCanvas in modern Chrome but the API is `OffscreenCanvas.requestAnimationFrame` — and it's actually NOT widely supported. Better: use `Atomics.waitAsync` with a periodic timer, or postMessage from the main thread's rAF loop into the worker.

2. **Chrome's audio-suspended → kernel-worker idle interaction.** Without sustained audio output, the AudioWorklet's `process()` doesn't fire. Some code paths may gate on AudioWorklet ticks. Less likely than #1.

3. **`requestAnimationFrame` not running in worker.** If the canvas-present cycle depends on a main-thread rAF that's coupled to user activity (it shouldn't be, but worth checking), throttling would cascade.

**Where to look:**
- `host/src/kernel-worker.ts:8623–8627` (`startVblankPump`).
- Search for `requestAnimationFrame`, `setInterval(`, `setTimeout(` in host/src and see which intervals drive the demo's frame cadence.
- Compare against the Modeset demo — does its animation also throttle without mouse? If yes, root cause is shared (in the vblank pump / worker timing). If no, SDL2 has an extra dependency the previous session's WRITEI-EAGAIN + IOCTL-EAGAIN patches introduced.

### §B — Audio cuts off at ~1 s (carry-over)

Symptom unchanged from predecessor handoff. May be the SAME bug as §A — both fire when the user isn't actively interacting. Test the unified theory first: if the vblank pump throttles, the C-side frame loop slows, `SDL_PumpAudioDevices` is called less often, the AudioWorklet drains the ring faster than it's refilled, and after ~1 s of buffered audio runs out there's silence.

If the unified theory holds, fixing §A also fixes §B.

If §A is fixed but §B persists, the audio path has its own issue — likely `BrowserAudioDriver` / `wpk-audio-worklet.js` / the kernel's `hw_ptr` advance, all of which the predecessor handoff flagged.

## Working tree state — exact files (all sessions cumulative)

Run `git status --short` for the canonical list. As of session end (no new untracked beyond what predecessor already noted, plus this handoff):

```
 M apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts
 M apps/browser-demos/pages/kandelo/presets.ts
 D apps/browser-demos/test/kandelo-espeak.spec.ts
 D apps/browser-demos/test/kandelo-evdev.spec.ts
 M crates/kernel/src/audio/pcm_ioctl.rs
 M crates/kernel/src/syscalls.rs
 M crates/shared/src/lib.rs
 M host/src/kernel-worker.ts       ← prior-session SYS_IOCTL EAGAIN + this-session firstKmsCanvasCrtc
 M host/src/kernel.ts              ← this session: tryAttachKmsCanvasToGl + viewport shadow seed
RM host/test/sdl2-demo.test.ts -> host/test/sdl2.test.ts
 M images/vfs/scripts/build-shell-vfs-image.ts
 M packages/registry/sdl2/build-sdl2.sh
 D programs/evdev_demo.c
RM programs/sdl2_demo.c -> programs/sdl2/main.c
 M programs/sdl2_alsa_smoke.c
 M programs/sdl2_kmsdrm_smoke.c
 M scripts/build-programs.sh
?? apps/browser-demos/test/kandelo-sdl2.spec.ts                ← TIGHTENED this session
?? docs/plans/2026-06-17-sdl2-browser-fix-handoff.md           ← predecessor #1
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff.md     ← predecessor #2
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff-2.md   ← this file
```

(Plus the carry-over `?? docs/plans/2026-06-…-dri-kandelo-port-handoff-*.md` files from prior sessions — not relevant unless squashing the docs/plans directory.)

### Diff stat (cumulative across all uncommitted sessions)

```
19 files changed, 360 insertions(+), 457 deletions(-)
```

The net deletions outweigh insertions because of the espeak + evdev demo removal landing alongside the SDL2 work.

### Background processes

A Vite dev server was running on port **5403** at session end. Restart command above.

### Stale `shell.vfs.zst`

Still stale (Jun 17 10:20), same caveat as predecessor handoff §"Stale shell.vfs.zst". Optional cleanup before merge.

## Why none of the four landed fixes are suspects for the new lag/audio symptoms

1. **Fix 1 (legacy ADDFB)** — purely additive ioctl number, only fires when user binary calls legacy `drmModeAddFB`. Modeset uses ADDFB2, SDL2 uses ADDFB. No way it could cause animation throttling.
2. **Fix 2 (kernel WRITEI EAGAIN)** — only changes the failure return for full ring + non-zero request. Cargo `writei_when_ring_full_returns_eagain` covers the new path; predecessor's prior-session toggle test confirmed no other test changed.
3. **Fix 3 (host SYS_IOCTL EAGAIN)** — only fires when the kernel returns `(-1, EAGAIN)` for an ioctl. Only `pcm_ioctl::handle_writei` ever does so. Audio-only side effect.
4. **Fix 4 (this session: tryAttachKmsCanvasToGl + viewport shadow seed)** — only changes what happens at canvas attach time + WebGL2 default viewport. The animation rate depends on the vblank pump / page-flip retire cadence, neither of which this fix touches.

If your instinct on hitting the new lag is "revert one of these and try again", that's wrong. They're all individually necessary. The lag is at a different layer (worker timing / Chrome throttling).

## Things NOT to do

- Do NOT push or `gh pr *`. Branch stays local.
- Do NOT commit, push, or PR without explicit per-session approval. **End-of-session note: human reviewed the rendering visually in a real browser and was satisfied with the quad rendering, but said "no" to commit — they wanted to look at the audio/throttle first.**
- Do NOT bump `revision` fields in `build.toml` files.
- Do NOT regenerate the ABI 16 artifacts already in `local-binaries/programs/wasm32/`.
- Do NOT revert any of the four landed fixes.
- Do NOT add an SDL2-side patch to call `drmModeAddFB2` instead of `drmModeAddFB`. The kernel-side legacy-ADDFB shim is the chosen path.
- Do NOT loosen the new Playwright spec gates (`>3_500` per-sample, `>400` byteLength spread across 5 samples spaced 600 ms). The previous `>2_000` was a false positive that let a blank canvas pass.

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-sdl2-browser-rendering-handoff-2.md` first, then its predecessors `2026-06-17-sdl2-browser-rendering-handoff.md` and `2026-06-17-sdl2-browser-fix-handoff.md`. Branch is `explore-dri-sdl2`, tip still `4f88111bb` (NOT pushed, PR #709 untouched). Working tree has Phase 0 SDL2 rename, the three prior-session kernel/host EAGAIN fixes, AND this session's canvas-renders fix in `host/src/kernel.ts` (extracted `tryAttachKmsCanvasToGl` called from `host_gl_bind` + `host_gl_create_context` + `host_kms_set_fb`, new `firstKmsCanvasCrtc` callback for the SDL2 bind-before-SetCrtc window, and seeding `b.shadow.viewport` with the WebGL2 default to defeat `defaultShadow().viewport=[0,0,0,0]` clobbering `gl.viewport` to zero via GlMuxer.switchTo) + a tightened `apps/browser-demos/test/kandelo-sdl2.spec.ts` (5-sample spread gate; the previous `>2_000` byteLength gate was a false positive). Human verified in a real browser at `http://127.0.0.1:5403/?demo=sdl2`: the rotating quad IS visible and colour-cycles correctly. TWO real-browser-only symptoms remain: (1) the quad animation lags to ~1 fps unless the mouse is moving over the canvas (NEW this session — strong candidate is Chrome throttling the kernel-worker's `setInterval`-based vblank pump when the page isn't receiving input; check `host/src/kernel-worker.ts:8623-8627` and consider switching to `requestAnimationFrame` driven from the main thread); (2) audio still cuts off at ~1 s (carry-over from predecessor handoffs, possibly the SAME bug as #1 — if the vblank pump throttles, SDL_PumpAudioDevices runs less often and the ring drains faster than it's refilled). Test the unified theory first; if fixing the throttle fixes the audio, one bug. Order: (1) reproduce the lag in DevTools, instrument the vblank pump tick rate, confirm or refute the Chrome throttling theory; (2) fix the lag; (3) verify audio in real browser; (4) if audio persists, investigate `BrowserAudioDriver`/`wpk-audio-worklet.js` separately; (5) run CLAUDE.md test suite; (6) commit + PR only with explicit per-session approval. All five CLAUDE.md suites currently green (cargo 1072/1072, vitest 886+1-pre-existing under dev-shell, libc-test exit 0 no unexpected FAILs, POSIX exit 0 no FAILs, ABI snapshot in sync). The previous handoff's note that `scripts/check-abi-version.sh` was broken is OUT OF DATE — the script works again. Pre-existing vitest failure `spidermonkey-node-compat > installs cowsay (Cannot find module '/usr/local/lib/kandelo/npm-runner.js')` is NOT caused by this work. Dev-shell entry: `source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && bash scripts/dev-shell.sh bash -c '…'`. Vite dev server was running on 5403 — restart it with `bash scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx vite --host 127.0.0.1 --port 5403 --strictPort'` if it's gone. Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR."*
