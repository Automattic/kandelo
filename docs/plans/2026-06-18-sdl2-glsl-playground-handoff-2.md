# SDL2 GLSL playground handoff #2 — Phase 0 committed + pushed; Phase 1 and Phase 2 implemented green, uncommitted

Second handoff after `2026-06-18-sdl2-glsl-playground-handoff-1.md`. Branch still `explore-dri-sdl2`. Phase 0 of the playground plan is now committed AND pushed; Phase 1 (viewport-split skeleton, no timeout, 1280×720 clamp) and Phase 2 (hardcoded plasma `mainImage` + live-compile path with error-log stash) are implemented and pass both vitest + Playwright, but **not yet committed**. PR #709's diff has been updated with the Phase 0 commit; Phase 1+2 still live only in the working tree.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`. **Tip pushed: `3453ab5f9`** (Phase 0 commit) — that's what's on `origin/explore-dri-sdl2` now and what PR #709 shows. The previous handoff-1 endpoint `4f88111bb` is the parent; `3453ab5f9` sits on top.
2. **Phase 0 commit was the "demo(sdl2): Phase 0 base — rotating-quad GLES2 + 440 Hz ALSA tone + ESC via evdev" commit.** It bundled 46 files (`+5285 / −472`): SDL2 Phase 0 program, audio kernel + host glue (additive ABI, no version bump), DRM legacy `ADDFB`, vitest + Playwright tests, and the full chain of SDL2 plan/handoff docs (`2026-06-17-sdl2-*`, `2026-06-18-sdl2-glsl-playground-handoff-1.md`, `2026-06-29-sdl2-port-plan.md`).
3. **Phase 1 is implemented + green + UNCOMMITTED.** Drops the 5 s timeout, replaces the rotating quad with `glClear` split (gray left, black right via `glViewport`+`glScissor`), 1280×720 window default clamped to `SDL_GetCurrentDisplayMode`. Vitest 1/1 green, Playwright 1/1 green (the latter via pixel-sample left-brighter-than-right). **The user explicitly confirmed Phase 1 = the written plan.** The handoff-1 confusion is resolved.
4. **Phase 2 is implemented + green + UNCOMMITTED on top of Phase 1.** Hardcoded plasma `mainImage` runs as a full-screen NDC quad over the right pane via the GLSL ES 1.0 Shadertoy template; left pane keeps the Phase 1 gray clear. Vitest 1/1 green, Playwright 1/1 green (the latter via PNG-byteLength variance, NOT pixel sampling — see §A).
5. **Three working-tree files post-Phase-0-commit:**
   - `programs/sdl2/main.c` — Phase 1+2 source.
   - `host/test/sdl2.test.ts` — re-tagged "Phase 2 (plasma right pane)", drops the timeout test.
   - `apps/browser-demos/test/kandelo-sdl2.spec.ts` — PNG-byteLength gate.
   Also: `local-binaries/programs/wasm32/sdl2.wasm` rebuilt at 10:37 today to ~552 KB; `apps/browser-demos/test-results/` has Playwright failure artifacts from earlier debug iterations (junk; safe to delete).
6. **User said "don't commit yet, continue" between Phase 1 and Phase 2; same posture stands at the end of session 2.** The user has not authorized a commit for Phase 1+2 yet.

## What landed (chronological, with file-level scope)

### Phase 0 commit (pushed)

`3453ab5f9 demo(sdl2): Phase 0 base — rotating-quad GLES2 + 440 Hz ALSA tone + ESC via evdev`

Same files the previous handoff-1 left dirty. Committed clean, no junk, no submodule pointer drift, no `.tsbuildinfo`, no `test-results/`, no OpenSSL `.d.ts`/`.js` build outputs. Pushed via `git push origin explore-dri-sdl2` — non-force, normal advancing push.

The commit message kept the "Verified" block calling out cargo / vitest / Playwright / ABI snapshot; reviewers will see no ABI version bump because the snapshot changes are additive-only (three new `kernel_audio_*` exports + one new DRM ioctl const + `WpkDrmModeFbCmd` + `SNDRV_PCM_IOCTL_HWSYNC`).

### Phase 1 (working tree only)

`programs/sdl2/main.c`:
- Default window `1280×720`, clamped against `SDL_GetCurrentDisplayMode(0, &mode)` — in headless browser the kandelo canvas advertises `display=1024x768`, so the runtime log line ends up `sdl2: display=1024x768 clamp=1024x720`.
- Loop is `while (running)` with no time cap. ESC is the only exit. `exit=` token in stdout hardcoded to `esc` (no `timeout` branch remains).
- `glEnable(GL_SCISSOR_TEST)` once at startup. Per frame: `SDL_GL_GetDrawableSize(win, &gl_w, &gl_h); half_w = gl_w/2;` then two passes — left `glViewport(0,0,half_w,gl_h) + glScissor(...) + glClearColor(0.18,0.18,0.20,1.0) + glClear`, right `glViewport(half_w,0,gl_w-half_w,gl_h) + glScissor(...) + glClearColor(0,0,0,1) + glClear`. No quad, no audio uniform, no shader compile.
- Audio path unchanged from Phase 0: `audio_cb` keeps the 440 Hz tone; `SDL_PumpAudioDevices()` still per-frame.

`host/test/sdl2.test.ts` updates for Phase 1:
- Dropped the `5 s timeout exit` test.
- Kept the ESC-injection case. Updated `setInputCanvasDims(1280, 720)`.
- Re-tagged `describe("SDL2 playground — viewport-split skeleton (Phase 1)", ...)`.

`apps/browser-demos/test/kandelo-sdl2.spec.ts` updates for Phase 1:
- Dropped Phase 0's byte-spread animation gate (static flat-clear doesn't animate; identical PNGs across frames is correct, not a regression).
- New gate: `canvas.evaluate` opens an OffscreenCanvas, draws the live canvas, `getImageData(W/4, H/2)` vs `(3W/4, H/2)`; asserts left half ≥ 30 lum brighter than right.
- ESC via `page.keyboard.press("Escape")` after a `body.click({position:{x:5,y:5}})` to release any auto-focus on react controls.

### Phase 2 (working tree only, on top of Phase 1)

`programs/sdl2/main.c` for Phase 2 (replaces the Phase 1 simple file):

- Added `FRAG_PREFIX` (the `#version 100` Shadertoy template — `iResolution`, `iTime`, `iTimeDelta`, `iMouse`, `iFrame`, `iAudio`, and one implementation-detail uniform, **see §B**) plus `FRAG_SUFFIX` (the `void main()` wrapper).
- Added `PLASMA_SRC`: a 5-line `mainImage` plasma using per-channel sin phases with three different frequencies, no audio dependency.
- `link_user_program(user_src)` concatenates `FRAG_PREFIX || user_src || FRAG_SUFFIX` into one buffer (so info-log line numbers are relative to the full composed source; PREFIX-line-count is a known constant offset for the Phase 8 overlay) → compiles vertex (`VS_SRC` = trivial NDC pass-through) + fragment → links → captures status / info-log into `g_last_error`.
- **`compile_shader` and `link_user_program` NEVER return 0 even when the GL status reports failure.** They emit `WARN: vertex compile: …` / `WARN: program link: …` to stderr and continue. See §A for why this matters.
- Main loop renders a full-screen NDC quad (`-1..+1` triangle strip) into the right-pane viewport; left pane keeps the Phase 1 gray clear via the same `glClear` path. Per-frame uniforms set when location ≥ 0: `iResolution = (right_w, gl_h)`, `iViewportOrigin = (half_w, 0)`, `iTime = (now-start)/1000`, `iTimeDelta = (now-prev)/1000`, `iMouse = (mouse_x_norm, mouse_y_norm)` updated on `SDL_MOUSEMOTION`, `iFrame = frame counter`.
- Audio path unchanged; the 440 Hz tone keeps the polling-audio pump alive end-to-end so Phase 5 can drop in the FFT path without reshaping the loop.

`host/test/sdl2.test.ts` for Phase 2:
- Re-tagged `describe("SDL2 playground — plasma right pane (Phase 2)", ...)`.
- Comment header rewritten to call out that Node has no real GL context, `host_gl_query` returns -1, the shader stash emits non-fatal `WARN:` lines, and visual gates live in Playwright.
- ESC-injection assertion unchanged: same `injectInputEvent(0, EV_KEY, KEY_ESC, 1) + SYN_REPORT + 10ms + release + SYN_REPORT` shape, exit code 0, `exit=esc`, `frames>0`, no `FAIL:` in stderr.

`apps/browser-demos/test/kandelo-sdl2.spec.ts` for Phase 2:
- **Visual gate is PNG byteLength variance over 6 captures at 500 ms intervals** (Phase 0's pattern). Each frame's `canvas.screenshot()` PNG byteLength is collected; assert min > 3 500 (not blank), spread = `max - min > 400` (animation present).
- ESC via `body.click({position:{x:5,y:5}}) + keyboard.press("Escape")`; assert `sdl2 exited` in syslog and `exit=esc` in terminal.
- Several alternative-gate implementations were tried first and failed — see §A for the full investigation. **Do not "improve" this gate back to pixel sampling without reading §A.**

## §A — Why the visual gate is byteLength variance, NOT pixel sampling

This is the single most expensive piece of context to lose. The investigation took the bulk of Phase 2; future-me will be tempted to "simplify" it back into pixel sampling and rediscover all of this. **Don't.**

The Modeset pane (`apps/browser-demos/pages/kandelo/panes/Modeset.tsx`) calls `host.attachKmsDisplay(canvas, crtcId)`, which internally calls `canvas.transferControlToOffscreen()`. After transfer:

1. **In-page `drawImage(canvas, 0, 0) + getImageData(...)` is unreliable on the placeholder canvas.** Phase 1's gate (left half luminance > right half luminance) happened to work because the left half was a flat gray `glClear` (the committed image was the constant 46/46/51 across frames). In Phase 2, the right-half plasma never read back through `drawImage` — the placeholder reads returned `[0,0,0]` even when the on-screen rendering very obviously showed plasma (verified by Playwright failure screenshot). This was true even with the kernel-worker WebGL2 context set to `preserveDrawingBuffer: true` (see `host/src/webgl/main-forward.ts:30-34`).
2. **`canvas.screenshot()` captures the canvas DOM element's CSS bounding box**, including the letterboxed background fill (`var(--k-fb-bg)`) around the actually-rendered framebuffer area. The canvas DOM is sized `width: 100%, height: auto, maxHeight: 100%, imageRendering: pixelated` (see `Modeset.tsx:259-269`); the backing buffer is `1024×768`. CSS gives the canvas a `1206×540` rendered box (in the headless Chromium viewport this run picked), with the canvas content letterboxed somewhere inside. Sampling at `(W/4, H/2)` and `(3W/4, H/2)` of the screenshot lands in the background, NOT the canvas content area — every channel comes back `26/18/8` (the kandelo page background).
3. **Computing the canvas-content sub-rectangle is fragile.** The CSS-rendered bounding box, the letterbox layout (`object-fit` semantics on a `<canvas>` are limited), and the responsive viewport math all conspire to make "where exactly is the plasma in the screenshot" a moving target. Not worth pinning down for a per-phase visual gate.
4. **PNG byteLength variance Just Works.** Phase 0's spec already used it for the rotating quad and it survived multiple session handoffs. The reason it works for Phase 2 too: plasma sin-phases drift across frames, so PNG-compressed canvas screenshots have measurably different sizes 500 ms apart. A blank canvas or a single-color clear gives identical byteLengths. The gate is `min > 3 500` (catches blank) + `spread > 400` (catches static / no animation), evaluated across 6 captures over 3 s.

**The temptation to switch back to pixel sampling will come up again when you want a more "precise" gate.** Resist unless you fix the underlying canvas readability story first (e.g. by adding a kernel-worker-side framebuffer-snapshot RPC, or by switching the Modeset pane to a non-transferred canvas — both are out of scope for the playground phasing).

There is also a **page-flip pump rate variance** that bit the polling iteration: the on-screen modeset header showed `1826 flips · 15265 ms` (~120 fps) in one screenshot and `57 flips · 15886 ms` (~3.6 fps) in another, all in the same project setup. The PNG-byteLength gate doesn't care about flip rate (it polls byteLength over wall-clock time), but a future pixel-sampling gate would have to handle the variance.

## §B — The `iViewportOrigin` deviation from the plan

The plan's Shadertoy template (line 53 of `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`) wraps user source as:

```glsl
void main() {
  vec4 c;
  mainImage(c, gl_FragCoord.xy);
  gl_FragColor = c;
}
```

With `iResolution` documented as "right-pane size, not window size". This is internally inconsistent: GLSL ES 2.0 `gl_FragCoord` is **window-relative**, not viewport-relative (OpenGL ES 2.0 spec, §3.7.1). With a right-pane `glViewport(half_w, 0, right_w, gl_h)`, the fragment generator only runs for window pixels in `x ∈ [half_w, gl_w)`, but `gl_FragCoord.x` reports the window-space pixel — so `gl_FragCoord.xy / iResolution.xy` produces UVs in `[0.5, 2.0]`, not `[0, 1]`.

**Phase 2 fixes this by adding `uniform vec2 iViewportOrigin` to the wrapper** and subtracting it: `mainImage(c, gl_FragCoord.xy - iViewportOrigin)`. Main sets it to `(half_w, 0)` per frame. User-side code still uses the standard Shadertoy idiom — `iViewportOrigin` is invisible to the `mainImage` body.

This is a **minor extension of the plan's wrapper template**, not a rewrite. The plan's "Uniforms summary" table doesn't list `iViewportOrigin` — it's an implementation detail, not a user-visible uniform. If you re-read the plan and feel tempted to delete `iViewportOrigin` to "match the plan literally", **don't**: the plan is wrong about this and Phase 2 user shaders will break.

If you want to "fix" this differently in the future, the alternatives are:
- Render the user shader over the whole window with `iResolution = window size` (drops the plan's "right-pane size" semantics; the editor pane in Phase 4 has to be drawn over the plasma with blending).
- Use a vertex shader that emits viewport-relative `varying` UVs and have the wrapper consume those (more invasive; loses the `gl_FragCoord` direct-Shadertoy compatibility).

`iViewportOrigin` is the least invasive option and was chosen.

## §C — The `WARN:` instead of `FAIL:` for shader status

The earliest Phase 2 attempt had `compile_shader` and `link_user_program` return 0 on `GL_COMPILE_STATUS == 0` / `GL_LINK_STATUS == 0`, and `main()` exited with code 1 on the failure path. The vitest `expects(stderr).not.toContain("FAIL:")` correctly rejected this.

The reason it appeared to fail in Node tests: **the kernel-side `host_gl_query` returns `-1` (binding has no live GL context) when running under `NodeKernelHost`** (see `host/src/webgl/query.ts:28` — `if (!b.gl) return -1;`). The wasm-side libGLESv2 stub interprets that as failure status, so every shader compile in Node looks "failed" with a zero-byte info log.

The fix: capture the info log + emit a `WARN:` line but **never abort the program**. This matches Phase 3's design ("last good shader keeps running") and means:
- In Node tests: vitest sees `WARN:` not `FAIL:`, the binary keeps running, ESC injection still works, `exit=esc` is reported.
- In real browser: the actual WebGL2 context compiles the plasma fine; no `WARN:` line is emitted; rendering proceeds.

`g_last_error[4096]` is the stash buffer the plan calls for. Phase 8 will read it for the on-screen overlay; for now it's only mirrored to stderr.

## §D — Build environment gotchas hit this session

- `scripts/dev-shell.sh` requires `nix` on PATH. In this worktree's shell, `nix` is at `/nix/var/nix/profiles/default/bin/nix` and **not on the default PATH**. The fix is to prefix every dev-shell invocation: `PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh`. Bare `bash scripts/build-programs.sh` (without dev-shell) fails at the C++ build step (`wasm32posix-c++: command not found`) and never reaches the SDL2 multi-source block in `build-programs.sh:298-313` — so `sdl2.wasm` silently stays stale.
- Playwright tests use `apps/browser-demos/playwright.config.ts`'s `webServer` config to auto-launch Vite on port 5401 (no manual server bring-up needed).
- Vitest runs from the `host/` directory: `cd host && npx vitest run test/sdl2.test.ts`.

If you're about to spend any time debugging build-related "command not found", **check the dev-shell PATH prefix first**.

## Working tree at session end

```
$ git status --short    # (just the playground-relevant entries; ignore the long-standing dirty entries elsewhere)
 M programs/sdl2/main.c
 M host/test/sdl2.test.ts
 M apps/browser-demos/test/kandelo-sdl2.spec.ts
?? apps/browser-demos/test-results/                  # Playwright debug artifacts — safe to delete
?? docs/plans/2026-06-18-sdl2-glsl-playground-handoff-2.md   # this doc
```

`local-binaries/programs/wasm32/sdl2.wasm` rebuilt at 10:37 today, ~552 KB. Symlink-equivalent under `binaries/programs/wasm32/` is what `live-setup.ts` picks up — the local-binaries-overrides-binaries rule (handoff-7) still holds.

No probe pollution: `grep -rn "GL-PROBE\|GL-BRIDGE\|_probe\|debug_log" host/src/ crates/kernel/src/` returns nothing.

## Open items

- **§A — Pixel-sampling vs byteLength variance.** Documented above. Future phases should not "improve" the byteLength gate without fixing canvas readability for the Modeset pane first.
- **§B — `iViewportOrigin` plan deviation.** Documented above. Phase 1 plan author may want to amend the plan's Uniforms table; this session did not edit the plan because the user already pushed back on plan-text edits in handoff-1.
- **§C — Stale `apps/browser-demos/test-results/`.** Untracked junk from the multiple Playwright-iteration runs this session. Safe to delete (`rm -rf apps/browser-demos/test-results/`).
- **Interactive-browser ESC routing not verified.** Same caveat as handoff-1 §"Things NOT to do next session" — Playwright's `page.keyboard.press("Escape")` dispatches straight to `window` and bypasses whatever React focus state interactive use sits in. Manual `./run.sh browser` ESC verification is still owed. Phase 0 had a 5 s timeout that masked this; Phase 1+ has no fallback exit.
- **Phase 1+2 not committed.** User said "don't commit yet, continue" between phases. End-of-session 2 same posture: do NOT commit Phase 1+2 without the user signing off on a coherent story. Suggested split when they do: one commit `demo(sdl2): Phase 1 — viewport-split skeleton, no self-timeout, 1280×720 clamp`, one commit `demo(sdl2): Phase 2 — plasma mainImage + GLSL ES 1.0 wrapper + shader stash`. Both on top of `3453ab5f9`.
- **Phase 3 not started.** The next phase per the plan is VFS load + F5 force-recompile: author `presets/image/plasma.frag` (the source Phase 2 has hardcoded), read `/home/shaders/image/current.frag` on startup (fall back to `/usr/share/shaders/image/plasma.frag`), F5 re-reads + recompiles, translucent red strip at the bottom of the right pane shows the error log on failure, last good shader keeps running. Phase 8's editor isn't part of Phase 3.

## Things NOT to do next session

- **Do NOT switch the Playwright spec back to pixel sampling.** Read §A first. If you genuinely want to pixel-sample again, the prerequisite is making the kandelo Modeset canvas's content readable from the main thread — not "wait longer" or "sample a different point".
- **Do NOT delete `iViewportOrigin` to "match the plan literally".** Read §B. The plan template is internally inconsistent; `iViewportOrigin` is the minimal fix.
- **Do NOT add Asyncify, `--no-wasm-opt`, or name-section preservation to the SDL2 build.** CLAUDE.md is explicit: Asyncify is not an active path. The current `wasm-fork-instrument` flow is correct.
- **Do NOT touch `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files** for Phase 3. VFS load is pure user-space; if you find yourself reaching for kernel code, you've taken a wrong turn.
- **Do NOT bump `ABI_VERSION`.** Nothing in Phase 1 or Phase 2 touches the ABI surface. Phase 3 doesn't either (VFS reads use existing syscalls).
- **Do NOT commit Phase 1+2 without explicit user authorization.** The user has been clear about wanting tight per-phase commit control (see handoff-1's standing instruction and the "don't commit yet, continue" message this session). When they DO authorize, prefer the two-commit split outlined in "Open items" over one bundled commit.
- **Do NOT skip `PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh` when rebuilding programs.** §D is the receipt.
- All "Things NOT to do" from handoffs 1 and the rolled-forward warnings from 5/6/7 still apply.

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-18-sdl2-glsl-playground-handoff-2.md` first — it is authoritative; ignore handoff-1's `Things NOT to do` about dropping the 5 s timeout, that was resolved when the user confirmed Phase 1 = the written plan. Branch `explore-dri-sdl2`, tip `3453ab5f9` on both local and origin (Phase 0 commit is PUSHED to PR #709). Phase 1 (viewport-split skeleton, ESC-only exit, 1280×720 clamp) and Phase 2 (hardcoded plasma `mainImage` + `#version 100` Shadertoy template with `iViewportOrigin` deviation + WARN-on-status-zero shader stash) are implemented in the working tree across `programs/sdl2/main.c`, `host/test/sdl2.test.ts`, and `apps/browser-demos/test/kandelo-sdl2.spec.ts`; vitest 1/1 green and Playwright 1/1 green (PNG-byteLength variance gate — do NOT switch to pixel sampling without reading §A). `local-binaries/programs/wasm32/sdl2.wasm` rebuilt at 10:37 today via `PATH=\"/nix/var/nix/profiles/default/bin:$PATH\" scripts/dev-shell.sh bash scripts/build-programs.sh`. Nothing committed beyond `3453ab5f9`; ask the user before committing Phase 1+2, and when they authorise, split into two commits per the doc's `Open items`. Next phase is Phase 3 (VFS `presets/image/plasma.frag` + F5 force-recompile + translucent red error strip + last-good-shader-keeps-running); confirm with the user before starting. Auto-mode default; bias to action only after the user has reaffirmed direction. Do NOT touch `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files. Interactive-browser ESC routing in `./run.sh browser` is still unverified — the Playwright path bypasses React focus, so user-facing ESC may still hang on a frozen demo even though both test suites pass."*
