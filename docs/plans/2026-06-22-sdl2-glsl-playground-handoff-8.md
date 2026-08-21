# SDL2 GLSL playground handoff #8 — Phase 7 done via CC0 "Tunnelwisp" port + sound chunking + mouse scroll + Mac keybinds (all uncommitted)

Eighth handoff in the chain (after `…-handoff-1.md` … `…-handoff-7.md`). Branch still `explore-dri-sdl2`. **Committed tip is STILL `b9bc545d4`** (PR #709 = Phases 1–4 + browser fixes). Everything from Phases 5, 6, AND 7 lives only in the working tree — **nothing is committed yet** (standing policy: commit only when the user authorizes). Handoff-7 covered Phases 5/6; this one is authoritative for the Phase 7 work layered on top.

## TL;DR — read this first

1. **Branch `explore-dri-sdl2`, committed tip still `b9bc545d4`.** Phases 5 + 6 + 7 are all **uncommitted working-tree changes**.
2. **Phase 7 pivoted away from a self-authored shader.** The user found my hand-written "fractal_land" image+sound **ugly** and told me not to author visual/musical content myself (I lack the taste). Those `fractal_land.frag` files were **created then deleted** — do not resurrect them.
3. **The boot default is now a verbatim CC0 port: "Trailing the Twinkling Tunnelwisp"** (Shadertoy `WfcGWj`, marked `// CC0` in both the image and sound source the user pasted; music credited to Pestis for "Cassini's Cosmic Conclusion"). Ported to GLSL ES 1.00, set as the image+sound boot default.
4. **User-confirmed in browser:** the image renders correctly, and sound plays. **NOT yet user-confirmed in browser:** the 13-tile ~284 s sound buffer, mouse-wheel scroll, and the Ctrl+1/Ctrl+2 keybinds (all implemented + passing the headless gate, but the user reloaded last on the ~22 s sound build and then moved on to feature requests).
5. **Scoped gate green** (`cd host && npx vitest run sdl2` → 4/4) after every change this session. **NOT re-run since the Phase 7 sound/scroll/keybind work:** full vitest, cargo, ABI. Last full vitest (earlier this session, after initial Phase 7 wiring) = **882 passed + the same 4 known-environmental failures** (3× mariadbd InnoDB timeouts in `exec-brk-base.test.ts`, 1× cowsay npm in spidermonkey). No `ABI_VERSION` bump needed (zero kernel/syscall/marshalled-struct changes — all user-space C + host TS + `.frag`).
6. **Open thread (not started): syntax highlighting** (Phase 8). User asked for it; I proposed a ~150–250-line lexer in `editor.c` (6 colors: comment / keyword / type / builtin / number / operator) drawing one colored span per token via `renderer_draw_text`. **Awaiting the user's palette choice** — I recommended **Dracula**, alternatives **VS Code Dark+** or **Monokai** (base colors on a known theme so taste is inherited, per the lesson in #2).

## What got implemented this session (all uncommitted, on top of handoff-7)

### Phase 7 — the Tunnelwisp boot default (CC0 port)
- **`programs/sdl2/presets/image/tunnelwisp.frag` (NEW)** — verbatim port of `WfcGWj`'s Image buffer. Only dialect-level edits (visuals identical): locals zero-initialized, the golfed comma-operator `for` expanded into an equivalent explicit loop (same math/order), and a `tanh4()` helper (clamped, exp-based) replaces the ES-3.00-only `tanh()`.
- **`programs/sdl2/presets/sound/tunnelwisp.frag` (NEW)** — verbatim port of the Sound buffer. `mainSound(int,float)` → `mainSound(in float t)` (the int sample index is unused and our template calls `mainSound(t)`); zero-init; the `for(c=3.;c<4.1;n+=c*=1.02)` inner loop expanded to a constant-bound loop producing the identical sequence.
- **`main.c`** — `PRESET_IMAGE_PATH`/`PRESET_SOUND_PATH` repointed to `tunnelwisp.frag`. Sound is rendered + `audio_set_sound_pcm`'d **on boot** (not just first F2). Builtin fallbacks stay plasma/sine (Node test still expects `builtin-plasma`/`builtin-sine`).
- **`live-setup.ts`** — stages both `tunnelwisp.frag` into `/usr/share/shaders/{image,sound}/`.

### Sound buffer: chunked multi-tile render (fixes the short-loop / abrupt-cut complaint)
- The track is a ~4.5-min one-shot (every voice gated by `if(a<9.)`, last voice ends `t≈277 s`, and each voice's envelope fades as it gates off — so a buffer reaching ~284 s loops cleanly through the quiet tail).
- **`sound_shader.h`** — FBO is now ONE tile: `SOUND_SHADER_TEX_W/H = 1024`, `SOUND_SHADER_TILES = 13`, `SOUND_SHADER_TILE_FRAMES = 1024*1024`, `SOUND_SHADER_FRAMES = TILE_FRAMES*TILES` (≈13.6M frames ≈ 284 s).
- **`sound_shader.c`** — `g_pcm` is now **malloc'd** (~54 MiB; NULL-checked → synth fallback), not static BSS. `sound_shader_render` loops `SOUND_SHADER_TILES` tiles, advancing the existing `iBufferOffset` uniform by one tile's seconds per tile so the windows are contiguous; each tile is its own light FBO dispatch (dodges the GPU watchdog) read back in **60 KB** row-bands (15 rows at W=1024, under `MAX_QUERY_OUT_LEN`=64 KB). Log line is now `sound-shader render frames=… tiles=… audible=…`; init log adds `tiles=…`.
- `audio.c` plays/loops `g_sound_pcm` with `int` indices — 13.6M frames × 2 fits `int`, no overflow (verified).

### Mouse-wheel scroll in the editor
- **`editor.c`** — new `editor_scroll(int delta_lines)` (moves `g_top_line`, clamped, no cursor move). Critically, `editor_render`'s scroll-into-view now only re-centers when the cursor **moved** (tracked via `g_scroll_anchor` = last cursor offset), so a wheel scroll persists instead of snapping back every frame. Typing/arrows still pull the view back to the cursor.
- **`editor.h`** — `editor_scroll` declared.
- **`main.c`** — handles `SDL_MOUSEWHEEL` (3 lines/notch via `MOUSE_WHEEL_SCROLL_LINES`, honors `SDL_MOUSEWHEEL_FLIPPED`), **only when the pointer is over the editor pane** (tracks `last_mouse_x` from `SDL_MOUSEMOTION`). Logs `sdl2: editor scroll wheel=N`.
- **`host/src/input/browser-input-source.ts`** — added an `opts.wheel` flag so the wheel handler can bind independently of pointer motion (`REL_WHEEL` carries no coordinates, so it doesn't fight the Modeset pane's absolute pointer feed).
- **`live-setup.ts`** — sdl2 input source is now `new BrowserInputSource(window, { pointer: false, wheel: true })`.
- **`host/test/sdl2.test.ts`** — injects `REL_WHEEL` on event1 and asserts `sdl2: editor scroll wheel=…` (dual-host parity).

### Mac-friendly mode keybindings
- **`main.c`** — `Ctrl+1` ≡ F1 (image), `Ctrl+2` ≡ F2 (sound), because a MacBook's F1/F2 are brightness keys (need Fn). Ctrl+digit is free on macOS (Cmd+digit switches tabs, Ctrl+digit doesn't). Mode badge now reads `image  [Ctrl+2: sound]` / `sound  [Ctrl+1: image]` (ASCII-only — the font atlas is 32–126).

### Docs
- **`docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`** §Phase 7 — corrected the misattribution of "Fractal Land" (`XsBXWt`): it's by **Kali (Pablo Roman Andrioli), 2013**, NOT Inigo Quilez. (The license posture is unchanged: Shadertoy default = CC-BY-NC-SA, hence we port CC0 shaders or reimplement techniques.) Note the Phase-7 plan text still says "Fractal Land homage" — the *actual* shipped demo is the CC0 Tunnelwisp port, a different shader; the plan body wasn't rewritten to match.

## Critical technical findings (don't re-derive)

- **Our stack is WebGL1 / GLSL ES 1.00, Shadertoy is WebGL2 / ES 3.00.** A Shadertoy paste won't compile verbatim. The three things that bite: `tanh` (ES3 builtin), the `mainSound(int,float)` signature vs our `mainSound(float)`, and uninitialized locals + golfed comma/`*=` loops. All handled in the ports above; preserve those translations if re-porting.
- **One giant FBO dispatch does NOT scale for a heavy shader.** ~160 s in a single dispatch ≈ 7.7M pixels × ~190 inner iters → GPU-watchdog (TDR) → context loss. The fix is the **tile loop with `iBufferOffset`** (each tile light), NOT a bigger FBO. Rendering the whole 284 s track is 13 dispatches + ~900 `glReadPixels` round-trips → **expect a noticeable one-time boot delay**; if it's too slow or TDRs in the browser, **drop `SOUND_SHADER_TILES`** (e.g. 8 ≈ 175 s) — that's the single knob.
- **`MAX_QUERY_OUT_LEN` = 64 KB** still caps every `glReadPixels`; bands are 60 KB (15 rows at W=1024).
- **GLES stub still lacks `glIsEnabled`/`glDeleteFramebuffers`** — don't call them. The sound render `glDisable`/`glEnable`s `GL_SCISSOR_TEST` around its off-screen passes (main keeps it on for the split pane).
- **Headless Node GL returns −1** → every `glReadPixels` is a no-op → `audible=0` → synth fallback. Real audio only in the browser. (This is why the chunked render's headless cost is just the malloc + decode loops, not real GL.)
- **Wheel plumbing already existed** in `BrowserInputSource.onWheel` (emits `REL_WHEEL`+SYN to event1) and the kernel advertises `REL_WHEEL`; it was only gated off because `{pointer:false}` also skipped the wheel handler. The `wheel` opt decouples them.

## Build / run / verify

```bash
# Rebuild after any programs/sdl2/*.c|*.h edit (sdl2 is 5 sources: main, editor, renderer, audio, sound_shader):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh
# .frag-only edits need NO rebuild (read from VFS at runtime via live-setup ?raw import) — just hard-reload the page.
# Scoped gate (fast, 4/4):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run sdl2'
# Full gate before commit (run INSIDE dev-shell): full vitest, cargo, ABI:
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run'
cargo test -p kandelo --target aarch64-apple-darwin --lib            # expect 1080/0
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/check-abi-version.sh   # expect exit 0
# Live demo (NOT ./run.sh browser): cd apps/browser-demos && npx vite
#   Server was on http://127.0.0.1:5402/?demo=sdl2 this session (5401 had a stale instance).
```
Console diagnostics to confirm in the browser: `sdl2: sound-shader render frames=13631488 tiles=13 audible=1` (**audible=1** = real rendered audio), `sdl2: edit-mode=sound` (on Ctrl+2), `sdl2: editor scroll wheel=N` (on wheel over the editor pane).

## NEXT — pick up here

1. **Get the user to browser-verify the un-confirmed pieces** (hard-reload `…:5402/?demo=sdl2`): (a) the ~284 s sound loop — does it play out and loop cleanly through the quiet tail, and is the **boot delay** from 13 dispatches acceptable? If too slow/black-screens, lower `SOUND_SHADER_TILES`. (b) mouse-wheel scroll over the editor pane (offer to flip the sign if it feels inverted). (c) `Ctrl+2`/`Ctrl+1` mode switching.
2. **Syntax highlighting (Phase 8)** — the user asked; **waiting on the palette choice** (recommended Dracula; or VS Code Dark+ / Monokai). Then implement the lexer in `editor.c` (see TL;DR #6). Pure `editor.c`, no GL/host changes.
3. **When the user authorizes a commit:** stage SDL2 paths explicitly (NEVER `git add -A` — the tree has ~60 unrelated DRI planning docs + dirty submodules). The Phase 5/6/7 set to stage:
   - `programs/sdl2/{main,editor,renderer,audio,sound_shader}.c`, `programs/sdl2/{editor,renderer,audio,sound_shader}.h`
   - `programs/sdl2/presets/image/{audio_bars,tunnelwisp}.frag`, `programs/sdl2/presets/sound/{sine,fm_bell,noise_sweep,chord,tunnelwisp}.frag`
   - `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, `host/src/input/browser-input-source.ts`, `host/test/sdl2.test.ts`, `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`
   - (NOTE `programs/sdl2/presets/image/plasma.frag` is already tracked/committed.)
   - Run the full gate first. No `ABI_VERSION` bump.

## Things NOT to do (carried forward, still true)

- **Do NOT author visual/musical content yourself** — the user has explicitly stated I lack the taste for it. Port proven CC0/MIT work or reimplement recognized techniques, and base color schemes on known themes. Do NOT recreate the deleted `fractal_land.frag` pair.
- **Do NOT commit without user authorization**, and never `git add -A`.
- **Do NOT touch** `host/src/kernel.ts`, `host/src/webgl/`, kernel syscalls/`wasm_api.rs`, or the kernel SAB/audio files — none of this needed them.
- **Do NOT call `glIsEnabled`/`glDeleteFramebuffers`**, push a single texture upload past ~65499 bytes, or a single `glReadPixels` past 64 KB.
- **Do NOT add KISSFFT / asyncify.**
- Run vitest **inside `scripts/dev-shell.sh`** (else `fork-dlopen-replay-e2e` spuriously fails on missing CLANG).

## Standing instruction for next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-22-sdl2-glsl-playground-handoff-8.md` first — it is authoritative for the uncommitted SDL2 playground work (handoffs 1–7 are historical; committed tip is still `b9bc545d4` on branch `explore-dri-sdl2`, PR #709). Phases 5, 6, AND 7 are all IMPLEMENTED in the working tree and NOT committed. Phase 7 dropped my self-authored 'fractal_land' shaders (the user found them ugly — DO NOT author visual/musical content myself or recreate them) in favor of a verbatim CC0 port of Shadertoy `WfcGWj` 'Trailing the Twinkling Tunnelwisp' (image `presets/image/tunnelwisp.frag` + sound `presets/sound/tunnelwisp.frag`, ported to GLSL ES 1.00: `tanh4` helper, `mainSound(in float)` signature, zero-init, expanded loops), set as the boot default and activated on boot. The sound is rendered as 13 tiles of 1024×1024 advancing `iBufferOffset` (`sound_shader.{c,h}`, ~284 s, malloc'd ~54 MiB `g_pcm`, 60 KB readback bands) so the ~4.5-min one-shot loops cleanly through its quiet tail — if boot is too slow or black-screens in the browser, lower `SOUND_SHADER_TILES`. Mouse-wheel scroll works (`editor_scroll` + `g_scroll_anchor` decouple in `editor.c`, `SDL_MOUSEWHEEL` in `main.c` gated to the editor pane, `wheel` opt added to `BrowserInputSource` with `{pointer:false,wheel:true}` in `live-setup.ts`), and `Ctrl+1`/`Ctrl+2` mirror F1/F2 for Mac function-row keyboards. Scoped gate `cd host && npx vitest run sdl2` is 4/4; full vitest + cargo + ABI were NOT re-run since the sound/scroll/keybind changes — run them before any commit (expect 882 + 4 known-environmental, cargo 1080/0, ABI exit 0, no `ABI_VERSION` bump). Browser-confirmed by the user: image renders + sound plays; NOT yet confirmed: the 284 s buffer, wheel scroll, Ctrl+1/2 — get those verified via `cd apps/browser-demos && npx vite` at `http://127.0.0.1:5402/?demo=sdl2` (NOT `./run.sh browser`). Next: (1) browser-verify those three + the boot-delay acceptability, (2) implement Phase 8 syntax highlighting in `editor.c` (lexer → 6 colors via `renderer_draw_text` spans) once the user picks a palette — I recommended Dracula, alternatives VS Code Dark+ / Monokai. Do NOT touch `host/src/kernel.ts`/`host/src/webgl/`/kernel syscalls; do NOT add KISSFFT/asyncify; when authorized to commit, stage SDL2 paths explicitly, never `git add -A`."*
