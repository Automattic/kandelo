# SDL2 GLSL playground handoff #7 — Phases 5 + 6 IMPLEMENTED (audio/FFT/iAudio + sound shaders), NOT committed

Seventh handoff in the chain (after `…-handoff-1.md` … `…-handoff-6.md`). Branch still `explore-dri-sdl2`. Handoff-6 is the last *committed* state (tip `b9bc545d4`, PR #709 = Phases 1–4 + browser fixes). **This session implemented Phases 5 and 6 on top of that, in the working tree only — nothing is committed yet** (per standing policy: commit only when the user authorizes). Handoffs 1–6 are historical; this one is authoritative for the uncommitted Phase 5/6 work.

## TL;DR — read this first

1. **Branch `explore-dri-sdl2`, committed tip still `b9bc545d4`.** Phases 5 + 6 are **uncommitted working-tree changes**.
2. **Phase 5 (audio + FFT + `iAudio`)** and **Phase 6 (sound shaders, closed loop)** are both done and pass the gate. The user explicitly approved proceeding through each.
3. **Next task: Phase 7 — the Fractal-Land image+sound boot default.** This is the headline demo the user actually wants (see plan `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` §Phase 7). Phases 5+6 were the gate; they're now clear.
4. **Gate run this session (all green except the known baseline):** cargo 1080/0, `vitest run sdl2` 4/4, full vitest 882 passed + the **same 4 pre-existing environmental failures** from handoff-6 (3× mariadbd InnoDB timeouts in `exec-brk-base.test.ts`, 1× cowsay npm in spidermonkey), libc/POSIX **not run** (zero kernel/libc/glue changes), ABI exit 0 (no new surface; `ABI_VERSION` already 16 on the branch).
5. **No `ABI_VERSION` bump needed** — all Phase 5/6 work is user-space C (`programs/sdl2/`) + host TS (browser `live-setup.ts`) + preset `.frag` files. No kernel, no syscalls, no marshalled structs, no glue changes.

## What got implemented this session (uncommitted)

### Phase 5 — audio + FFT + `iAudio`
- **`programs/sdl2/audio.{c,h}` (NEW)** — 4-voice chip synth (square lead / 25%-duty square bass / saw pad / LFSR noise hat), 16-row looping pattern ~130 BPM. Renders S16 into the SDL stream inside `audio_cb` (single-threaded polling audio — **no writer thread**; samples are pulled by `SDL_PumpAudioDevices()` in the main loop). Maintains a 1024-sample mono analysis ring; a **self-authored radix-2 FFT** (NOT KISSFFT — deviation from plan, deliberate: avoids a third_party vendor + license tail + build wiring, fits "all code we wrote") log-bins the spectrum to 128 bytes. Mute toggle.
- **`renderer.{c,h}`** — `renderer_set_audio_spectrum()` uploads a 128×1 `GL_LUMINANCE` texture; `iAudio` sampler bound in `renderer_draw_user_shader` (the template already *declared* the slot since Phase 4). Audio texture added to shutdown cleanup.
- **`main.c`** — `audio_cb` → `audio_synth_render`; `audio_synth_init(have.freq, have.channels)` after device open; **Ctrl+M** mute; per-frame `audio_compute_spectrum` → `renderer_set_audio_spectrum` (runs even headless so the upload path is exercised in Node).
- **`programs/sdl2/presets/image/audio_bars.frag` (NEW)** — 128-bar FFT visualizer with peak caps, blue→magenta sweep.

### Phase 6 — sound shaders (closed loop)
- **`programs/sdl2/sound_shader.{c,h}` (NEW)** — compiles Shadertoy-style `vec2 mainSound(in float time)` against a GLSL ES 1.0 template (1 pixel = 1 stereo frame; vec2 encoded as RGBA8 = `L_lo,L_hi,R_lo,R_hi`, 16-bit split). Renders a **512×256 RGBA8 FBO** (= `SOUND_SHADER_FRAMES` = 131072 frames ≈ 2.73 s @ 48 k) in one dispatch, then `glReadPixels` reads it back in **32 KB row-bands** and decodes RGBA8 → S16. `calloc`'d staging so a headless no-op readback yields silence (→ synth fallback) rather than garbage.
- **`audio.{c,h}`** — `audio_set_sound_pcm(pcm, frames)`: when set+nonzero, loops the rendered sound buffer as the playback source (and feeds the analysis ring, so `iAudio` reacts to it); NULL/0 → fall back to the chip synth.
- **`main.c`** — **F1/F2** switch the editor between image and sound buffers (leak-free swap via `editor_dup_text()` + `editor_shutdown()` + `editor_init()`; parked strings `g_image_text`/`g_sound_text` owned by main). Mode-aware debounce + Ctrl+S (sound → `/home/shaders/sound/current.frag`). Entering sound mode (F2) compiles+renders+activates the sound shader. Mode badge drawn in the editor pane. **Synth stays the boot default until the first F2.**
- **`programs/sdl2/presets/sound/{sine,fm_bell,noise_sweep,chord}.frag` (NEW)** — 4 preset sound shaders. `chord.frag` uses an if-chain (NOT array indexing — GLSL ES 1.00 frag shaders don't allow dynamic local-array indexing).
- **`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`** — stages `audio_bars.frag` + the 4 sound presets into the VFS (`/usr/share/shaders/{image,sound}/`).
- **`host/test/sdl2.test.ts`** — extended for Ctrl+M mute, the per-frame spectrum upload, and the F2 sound-shader render/readback path.

## Critical technical findings (don't re-derive these)

- **`MAX_QUERY_OUT_LEN = 64 KB`** (`crates/shared/src/lib.rs:1881`) caps every `glReadPixels` call. The plan's "1024×1024 read in one dispatch" (4 MB) is impossible — **read in ≤64 KB row-bands** (I use 32 KB = 16 rows at W=512). Render is still one dispatch; only readback is chunked.
- **GLES stub capabilities** (`libc/glue/libglesv2_stub.c`): FBO ops (`glGenFramebuffers`/`glBindFramebuffer`/`glFramebufferTexture2D`/`glCheckFramebufferStatus`), `glReadPixels` (`QOP_READ_PIXELS`, supports `GL_RGBA`+`GL_UNSIGNED_BYTE`), `glTexImage2D(…, NULL)` (allocates without upload — dodges the OP_TEX_IMAGE_2D ~65499-byte payload cap) ALL EXIST. **`glIsEnabled` and `glDeleteFramebuffers` DO NOT** — don't call them. main.c keeps `GL_SCISSOR_TEST` enabled for the whole loop, so sound_shader.c unconditionally `glDisable`/`glEnable`s it around the off-screen render. The FBO name leaks at shutdown (no delete op; freed at context teardown).
- **Headless Node GL**: `host_gl_query` returns −1, so every QOP fails silently. `glReadPixels` is a no-op → zero readback → `sound_shader_render` reports `audible=0` → audio falls back to the synth. Real audio only materializes in the browser with a live WebGL context. This is the inherent platform asymmetry, not a one-sided code path — the *binary* behaves identically on both hosts; only the GL backend capability differs.
- **Single-threaded polling audio**: there is NO writer thread (`SDL_THREADS_DISABLED` + `packages/registry/sdl2/patches/0002-polling-audio-eagain.patch`). The audio callback fires synchronously from `SDL_PumpAudioDevices()` in the main loop, so synth render, sound-buffer playback, and `audio_set_sound_pcm` all run on one thread — no locking, no races.

## Build / run / verify (unchanged mechanics from handoff-6)

```bash
# Rebuild wasm after any programs/sdl2/*.c edit (now 5 sources: main, editor, renderer, audio, sound_shader):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh
# Scoped gate (fast, 4/4):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run sdl2'
# Full vitest (run INSIDE dev-shell or fork-dlopen-replay spuriously fails on missing CLANG):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run'
# Live demo (NOT ./run.sh browser — its prepare step source-builds OpenSSL; binaries-abi-v16 release 404s):
cd apps/browser-demos && npx vite     # http://127.0.0.1:5401/?demo=sdl2
```
Phase 5/6 stdout diagnostics to look for: `sdl2: audio synth rate=…`, `sdl2: audio spectrum uploaded bins=128`, `sdl2: sound-shader init fbo=512x256 frames=131072`, `sdl2: edit-mode=sound`, `sdl2: sound-shader render frames=131072 audible=<0|1>` (1 only on real GL). **Browser closed-loop demo NOT yet manually verified this session** — recommend booting the demo, pressing F2 (hear the 220 Hz sine), loading `audio_bars.frag` on the image side, and confirming the bars react. Black canvas + "headless GL?" WARN = Chrome GPU off → check `chrome://gpu`, NOT the code.

## NEXT: Phase 7 — Fractal-Land image+sound boot default (5–7 days in the plan)

The headline demo. Author from scratch (CC-0 homage to IQ's Fractal Land — **do NOT copy his CC-BY-NC-SA code**; techniques are unprotectable, his code is not). Plan §Phase 7 has the full spec. Concretely:
1. **`programs/sdl2/presets/image/fractal_land.frag`** — Kaleidoscopic IFS terrain raymarcher, ~150 lines GLES 1.0, ~50–80 march steps, distance-estimated, soft fog, sun + horizon gradient. **Fold params + fog density modulated by `iAudio`** so terrain pulses with the music.
2. **`programs/sdl2/presets/sound/fractal_land.frag`** — multi-voice chiptune `mainSound` (2 square + noise + simple ADSR + short looped pattern). Our music, not IQ's.
3. **Coupling tuning** — pick which `iAudio.x` bins drive which terrain params so percussion/bass visibly track. This is the "edit the sound, see the picture respond" payoff.
4. **Boot default** — change the startup source chain so it loads `fractal_land.frag` (image + sound) instead of plasma/sine. In `main.c` the image chain is `USER_CURRENT_PATH → PRESET_PLASMA_PATH → BUILTIN_PLASMA_SRC` and the sound chain is `USER_SOUND_PATH → PRESET_SINE_PATH → BUILTIN_SOUND_SRC`; repoint the preset legs (and stage `fractal_land.frag` for both in `live-setup.ts`). To make the sound shader play on boot (not just on first F2), call `recompile_sound_from_editor` / `audio_set_sound_pcm` during init — currently the synth is the boot default and sound only activates on F2; Phase 7's boot default likely wants the fractal_land sound playing immediately.
5. **GLES2 viability** — ANGLE's GLES2 is permissive but if instruction count bites, drop march steps or shrink the right-pane render resolution; document the floor.
   - **Watch out:** GLSL ES 1.00 frag shaders disallow dynamic local-array indexing and require constant loop bounds (`for (int i=0;i<N;i++)` with literal N). The raymarch loop must have a constant max step count with an early-out `break`, not a variable bound.

## Things NOT to do (carried forward, still true)

- **Do NOT commit without user authorization.** When authorized: stage SDL2 paths explicitly (NOT `git add -A` — the tree has ~60 unrelated DRI planning docs + build cruft + dirty submodules `libc/musl`, `tests/sortix/os-test`). Phase 5/6 touches: `programs/sdl2/{audio,sound_shader}.{c,h}`, `programs/sdl2/{main,renderer}.c`, `programs/sdl2/renderer.h`, `programs/sdl2/presets/image/audio_bars.frag`, `programs/sdl2/presets/sound/*.frag`, `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, `host/test/sdl2.test.ts`.
- **Do NOT touch** `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files unless Phase 7 genuinely requires it (it shouldn't — FBO/readPixels/audio infra is all already in place from Phases 5/6).
- **Do NOT call `glIsEnabled` or `glDeleteFramebuffers`** (not in the stub). **Do NOT** revert the relative peg-and-move pointer to EV_ABS, change event1 caps, revert `imageRendering:"auto"`, or push any single texture upload past ~65499 bytes.
- **Do NOT add KISSFFT / asyncify.** The self-authored FFT is intentional.
- Run vitest **inside `scripts/dev-shell.sh`** or `fork-dlopen-replay-e2e.test.ts` spuriously fails on missing CLANG.

## Standing instruction for next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-18-sdl2-glsl-playground-handoff-7.md` first — it is authoritative for the uncommitted Phase 5/6 work (handoffs 1–6 are historical; committed tip is still `b9bc545d4` on branch `explore-dri-sdl2`, PR #709). Phases 5 (audio + FFT + `iAudio`: chip synth, self-authored radix-2 FFT, 128-bin `GL_LUMINANCE` texture, `presets/image/audio_bars.frag`, Ctrl+M mute) and 6 (sound shaders: `sound_shader.{c,h}` rendering `mainSound` to a 512×256 RGBA8 FBO, `glReadPixels` readback in ≤64KB row-bands per `MAX_QUERY_OUT_LEN`, RGBA8→S16 decode, F1/F2 dual-buffer editor, `audio_set_sound_pcm` source switch, 4 `presets/sound/*.frag`) are IMPLEMENTED in the working tree and pass the gate (cargo 1080/0, `vitest run sdl2` 4/4, full vitest 882 passed + the 4 known-environmental failures only, ABI exit 0, no `ABI_VERSION` bump needed) but are NOT committed — commit only when I authorize, staging SDL2 paths explicitly, never `git add -A`. Rebuild with `PATH=\"/nix/var/nix/profiles/default/bin:$PATH\" scripts/dev-shell.sh bash scripts/build-programs.sh` (sdl2 is now 5 sources); run vitest inside dev-shell; demo via `cd apps/browser-demos && npx vite` at `http://127.0.0.1:5401/?demo=sdl2` (NOT `./run.sh browser`; black canvas = Chrome GPU off, check `chrome://gpu`). GLES stub has FBO+`glReadPixels`+`glTexImage2D(NULL)` but NO `glIsEnabled`/`glDeleteFramebuffers`; headless Node GL returns −1 so sound readback is silent there (→ synth fallback) and real audio only appears in the browser. NEXT: Phase 7 — author from scratch (CC-0 homage, do NOT copy IQ's CC-BY-NC-SA code) `presets/image/fractal_land.frag` (Kaleidoscopic IFS raymarcher, constant loop bound + early-out break for GLSL ES 1.00, fold/fog modulated by `iAudio`) and `presets/sound/fractal_land.frag` (multi-voice chiptune `mainSound`), tune the `iAudio` coupling, then make them the boot default (repoint the image+sound preset legs in `main.c` and stage them in `live-setup.ts`; activate the sound on boot, not just on first F2). See plan `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` §Phase 7. Do NOT touch `host/src/kernel.ts`/`host/src/webgl/`/kernel syscalls; do NOT add KISSFFT/asyncify."*
