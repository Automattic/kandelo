# SDL2 GLSL playground — split-pane live audio-visual shader editor

**Goal:** Replace the current `sdl2_demo` (5 s spinning quad + 440 Hz tone + ESC) with a Shadertoy-style live editor: split-pane SDL2 window, GLSL fragment shader editor on the left, live shader output on the right, with a second editor mode for **sound shaders** that drive the audio output. The visual shader can sample the running audio via an `iAudio` uniform, so the two shaders are in dialog — edit the sound, see the visual respond.

**Audience:** web developers. The full pitch lives in the "Headline pitch" section at the bottom (PR-description ready).

**Stack — unchanged from the current SDL2 demo:** SDL2 + GLES 2.0 (via ANGLE static link) + KMS (page-flip) + evdev (keyboard) + ALSA (audio out) + VFS (shader save/load). **No new syscalls, no new sysroot work, no ABI impact.** Pure user-space application that uses what plans 2–7 already shipped.

**Scope discipline:** GLES 2.0 only — no GLES3 upgrade, no GLSL transpiler, no Shadertoy paste-compat, no multi-pass / `iChannel` media. Users write our GLSL ES 1.0 flavor against the `mainImage` / `mainSound` API.

## Rename: `programs/sdl2_demo.c` → `programs/sdl2/` (binary `sdl2.wasm`)

Binary output renamed `sdl2_demo.wasm` → `sdl2.wasm`, install path `/usr/local/bin/sdl2_demo` → `/usr/local/bin/sdl2`.

Touched files:
- `programs/sdl2_demo.c` → `programs/sdl2/main.c`
- `scripts/build-programs.sh` — `sdl2_demo.c)` case scans `programs/sdl2/*.c`, links to `sdl2.wasm`
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`:
  - two `import.meta.glob` patterns
  - `stageBinary([...], "sdl2.wasm")` call
  - `failOn("sdl2.wasm")` tag
  - `host.runShellCommand("/usr/local/bin/sdl2")` call
  - staging install path `"/usr/local/bin/sdl2"`
  - `tick(...)` log strings
- Delete the stale `local-binaries/programs/wasm32/sdl2_demo.wasm` after Phase 0 boots green.

## Window layout — single SDL2 window, viewport split

```
+--------------------+--------------------+
|       EDITOR       |       RENDER       |
|     left ~50%      |     right ~50%     |
+--------------------+--------------------+
|       error overlay (compile errors)    |
+-----------------------------------------+
```

Single GLES 2.0 context. `glViewport(0, 0, W/2, H)` for editor draws; `glViewport(W/2, 0, W/2, H)` for the user shader. `iResolution` exposed to the user is the right-pane size, not window size; `iMouse` is right-pane-local, normalized to (0,0)–(1,1). Sound shaders later use an offscreen FBO; the layout itself needs no FBO.

## User-facing shader API

User authors against a Shadertoy-shaped entry point. The host wraps it in a GLSL ES 1.0 (`#version 100`) template before `glShaderSource`.

**Image shader:**

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(uv, 0.5 + 0.5*sin(iTime), 1.0);
}
```

Wrapper injected by the host:

```glsl
#version 100
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec2 iMouse;
uniform int iFrame;
uniform sampler2D iAudio;
// (user source injected here)
void main() {
    vec4 c;
    mainImage(c, gl_FragCoord.xy);
    gl_FragColor = c;
}
```

**Sound shader:**

```glsl
vec2 mainSound(in float time) {
    return vec2(sin(6.2831 * 440.0 * time));
}
```

Wrapper renders to a 1024×1024 offscreen FBO; pixel (x,y) encodes sample index `N = y*1024 + x`, time `t = iBufferOffset + N / iSampleRate`. RGBA8888 packs the stereo S16 sample (R/G = left, B/A = right). Host decodes via `glReadPixels` into a ring buffer that ALSA drains. `iBufferOffset` exists so we can re-render the next chunk without restarting time at 0.

## Subsystem responsibilities

| Subsystem | What it does |
|---|---|
| SDL2 | Window, GL ctx, audio device, event loop, timing, clipboard |
| GLES 2.0 | Editor UI quads (font atlas), full-screen user shader, sound FBO + `glReadPixels`, error overlay |
| KMS | `SDL_GL_SwapWindow` per frame → page-flip |
| evdev | Printable keys + arrows + Ctrl/Shift mods + Esc + F-keys + Tab |
| ALSA | Pulls samples from a ring buffer fed either by the in-tree synth or the sound shader's readback |
| VFS | `/home/shaders/{image,sound}/*.frag` for saves; `/usr/share/shaders/{image,sound}/*.frag` for presets |

## File layout — `programs/sdl2/`

```
programs/sdl2/
├── main.c              # SDL2 init, GL ctx, audio device, main loop, event dispatch  ~300 LOC
├── editor.{c,h}        # gap buffer, cursor, selection, undo ring, kbd routing       ~1500 LOC
├── highlight.{c,h}     # GLSL ES 1.0 lexer → token color attributes                  ~300 LOC
├── renderer.{c,h}      # font atlas, full-screen quad, live compile,
│                       #   error overlay, viewport split bookkeeping                 ~700 LOC
├── audio.{c,h}         # ring buffer, ALSA writer thread, FFT (KISSFFT),
│                       #   iAudio 1D texture upload, source switch (synth/shader)    ~600 LOC
├── sound_shader.{c,h}  # mainSound wrapper, FBO setup, glReadPixels decoder,
│                       #   chunked re-render on edit                                 ~400 LOC
├── vfs.{c,h}           # load presets, save user shaders                             ~150 LOC
├── presets/
│   ├── image/          # plasma.frag (Phase 3), audio_bars.frag (Phase 5),
│   │                   # fractal_land.frag (Phase 7)
│   └── sound/          # sine.frag, fm_bell.frag, noise_sweep.frag,
│                       # chord.frag (Phase 6), fractal_land.frag (Phase 7)
└── third_party/
    ├── stb_truetype.h  # MIT, single header
    └── kiss_fft.{c,h}  # BSD, ~500 LOC vendored
```

Total handwritten C: ~4 k LOC.

## Uniforms summary

**Image shader:**

| Uniform | Type | Update rate | Notes |
|---|---|---|---|
| `iResolution` | `vec2` | window resize | Right-pane dims, not window |
| `iTime` | `float` | per-frame | Seconds since current shader was loaded |
| `iTimeDelta` | `float` | per-frame | Frame interval seconds |
| `iMouse` | `vec2` | mouse-move | Right-pane local, normalized 0–1 |
| `iFrame` | `int` | per-frame | Counter since shader load |
| `iAudio` | `sampler2D` | per-frame | 128×1 FFT bins (luminance) |

**Sound shader:**

| Uniform | Type | Update rate | Notes |
|---|---|---|---|
| `iSampleRate` | `float` | startup | Default 44100 |
| `iBufferOffset` | `float` | per-render-chunk | Time offset for the current chunk |

## Phasing — each phase is one green-CI commit

Every phase is independently demoable in `./run.sh browser` and leaves the working tree shippable.

### Phase 0 — Rename + build wiring (1 day)

Apply the rename per the "Touched files" list above. Verify boot in `./run.sh browser` under the new name; commit when green.

### Phase 1 — Viewport split skeleton (1 day)

- Drop the 5 s timeout. Keep ESC.
- Replace the spinning quad with two `glClear` colors: gray on the left half, black on the right half, driven by `glViewport` + `glScissor`.
- Resize window default to 1280×720; query SDL for the kandelo canvas size at runtime and clamp.

### Phase 2 — Live shader compile, hardcoded source (2 days)

- Bundle one hardcoded `mainImage` (a plasma) inside `main.c` for now.
- `renderer.c`: wrap-and-compile the user source via the image-shader template (above). On `GL_COMPILE_STATUS == 0`, parse `glGetShaderInfoLog` for line/col and stash for the error overlay.
- Run the compiled program on a full-screen quad over the right-pane viewport. Drive `iTime` from `SDL_GetTicks`. iMouse and iFrame land.
- Plasma animates. ESC still quits.

### Phase 3 — VFS load + force-recompile (1 day)

- Author `presets/image/plasma.frag` (the shader Phase 2 had hardcoded).
- On startup, read `/home/shaders/image/current.frag`. If absent, fall back to `/usr/share/shaders/image/plasma.frag`.
- F5: re-read `current.frag` and recompile. Translucent red strip at the bottom of the right pane shows error log on failure; last good shader keeps running.
- No editor yet — user edits the file by other means (terminal, host VFS).

### Phase 4 — Editor: text input + render (5 days)

- `editor.c`: gap buffer, cursor, line table. Keystrokes: printable chars, arrows, home/end, page up/down, backspace, delete, enter, tab (4-space soft tab).
- `renderer.c`: stb_truetype with a vendored Inconsolata TTF (SIL OFL), atlas baked once at startup, glyph quads drawn over the left pane.
- Render text from the gap buffer. Cursor blinks. Line numbers in left gutter.
- Auto-recompile 250 ms after the last keystroke (debounced).
- Ctrl+S writes `/home/shaders/image/current.frag`.
- No selection / undo / syntax color yet. The screen is now a working editor.

### Phase 5 — Audio + FFT + `iAudio` uniform (3 days)

- `audio.c`: 4-channel chip-synth (square / square / saw / noise), 16-row pattern, looping. Outputs S16 stereo @ 44100 Hz into a ring buffer drained by ALSA on a writer thread.
- Per frame in the main loop: read latest 1024 mono samples, KISSFFT to 512 bins, log-bin to 128, upload as a `GL_LUMINANCE` 1D texture bound to `iAudio`.
- Ship `presets/image/audio_bars.frag` that visualizes `iAudio` as 128 vertical bars. Loading it must show visible reaction to the synth music.
- Mute key (Ctrl+M).

### Phase 6 — Sound shaders (closed loop) (5 days)

- Tab-style editor mode switch: F1 = image shader, F2 = sound shader. Two gap buffers; one is active. Status line in the gutter shows which mode.
- `sound_shader.c`: compile `mainSound` against the sound-shader template, attach to a 1024×1024 RGBA8 FBO, render two seconds of audio in one dispatch (`iBufferOffset = chunk_start_sec`).
- `glReadPixels` the FBO into a CPU staging buffer; decode RGBA → S16 stereo samples; swap into the audio ring buffer.
- ALSA writer thread switches its source from the chip synth to the sound-shader-fed buffer when a sound shader is loaded; falls back to synth when the sound buffer is empty.
- Edit → 250 ms debounce → recompile → re-render chunk → swap. Brief glitch at swap is acceptable.
- Ship 4 preset sound shaders: pure sine, FM bell, noise sweep, chord arpeggio.
- **Closed loop demo:** edit the sound shader → hear it → the `audio_bars.frag` image shader visualizes its FFT. Edit either; both respond.

### Phase 7 — Signature preset: Fractal Land homage (5–7 days)

The headline demo. A from-scratch raymarched fractal landscape + matching chiptune sound shader, both authored by us, that load as the boot default. Inspired by Kali's (Pablo Roman Andrioli) Fractal Land (`https://www.shadertoy.com/view/XsBXWt`, 2013) without the Nyan cat sprite — pure procedural terrain + procedural music, in closed-loop dialog via `iAudio`.

**License posture:** Kali's Shadertoy work is CC-BY-NC-SA (Shadertoy's default). We **cannot** copy that code into our VFS image. We author a homage from scratch using only the unprotectable, widely-documented techniques (procedural fractal landscapes, distance-marched heightfields, analytic-normal trick, fog) — see references such as `https://iquilezles.org/articles/`. The techniques are unprotectable; the specific code is not. Our homage ships under CC-0 in-tree like the other presets.

- **`presets/image/fractal_land.frag`** (2–3 days): Kaleidoscopic IFS terrain raymarcher, ~150 lines GLES 1.0. ~50–80 march steps, distance-estimated; soft fog; sun light + horizon gradient. **The fractal's fold parameters and fog density are modulated by `iAudio`** so the terrain pulses with the music's bass and the sky shimmers with the highs.
- **`presets/sound/fractal_land.frag`** (2–3 days): chiptune music as `mainSound`. Multi-voice synthesizer: 2 square voices (lead + bass), 1 noise voice (percussion), a simple ADSR envelope, a short looped pattern. Doesn't have to match IQ's track — it's *our* music. Several-bar loop is fine; full track is the stretch.
- **Coupling tuning (1 day):** verify the FFT bin choices in the image shader visibly track the percussion hits and bass line. Pick which `iAudio.x` ranges drive which terrain parameters. This is the "edit the sound, see the picture respond" moment that sells the demo.
- **GLES2 viability check (built into the authoring):** ANGLE's GLES2 backend is permissive enough for this, but if instruction count bites we drop march steps or shrink the right-pane render resolution. Document the floor.
- **Boot default:** Phase 3's VFS-load step starts loading `/usr/share/shaders/image/fractal_land.frag` and `/usr/share/shaders/sound/fractal_land.frag` instead of the placeholder plasma. First-boot user sees Fractal Land running with music; toggle to the editor and they can dissect either side.

### Phase 8 — Editor polish (4 days) — DONE

All items implemented (uncommitted on `explore-dri-sdl2`):

- ✅ Selection (Shift + arrows, mouse drag, Ctrl+A). Copy / cut / paste via `SDL_GetClipboardText` / `SDL_SetClipboardText`, with an in-app clipboard fallback for the KMSDRM case where the SDL clipboard bridge is a no-op. Insert/delete auto-replace the active selection. (`editor.c` selection state + `main.c` `clip_*`.)
- ✅ Undo / redo ring (Ctrl+Z / Ctrl+Y), 32 snapshots, coalesced by edit-kind; a cursor move / selection change ends a group. Preset load is one undoable step. (`editor.c` snapshot stacks.)
- ✅ GLSL ES 1.0 syntax highlighting — Dracula palette, 6 colors (comment / keyword / type / builtin / number / operator), cross-line block-comment state. (`editor.c` `draw_highlighted_line`.)
- ✅ Error line marker: the failing line is washed red and its gutter number prefixed with `!`. Line number parsed from the GLSL log (`ERROR: 0:<line>`) and offset back to editor coordinates by the template prefix line count. (`renderer_last_error_line` / `sound_shader_last_error_line` → `editor_set_error_line`.)
- ✅ Preset dropdown: Ctrl+L cycles the next preset for the active mode; Ctrl+Shift+L opens a modal chooser overlay (Up/Down + Enter + Esc). Lists `*.frag` under `/usr/share/shaders/{image,sound}` via `readdir`. (`main.c` preset browser.)
- ✅ Boot splash over the render pane (fades out) + persistent "SDL2 GLSL Playground" title in the render-pane corner. (`main.c` render section.)

Headless gate `cd host && npx vitest run sdl2` stays 4/4.

### Phase 9 — Verification + docs (1 day)

- Run all four test suites per CLAUDE.md: cargo, vitest, libc-test, posix-test.
- `bash scripts/check-abi-version.sh` — must be no-op (we changed no ABI surface). Note: this script is broken per handoff-57 §3; verify by inspection that no ABI surface changed and move on.
- Manually verify in `./run.sh browser`: boot Kandelo gallery → click SDL2 preset → split-pane appears with the Fractal Land homage running (terrain + chiptune + audio-reactive coupling visible) → edit the image shader → see live update → F2 → edit the sound shader → hear it → toggle to the audio bars preset → see the FFT respond to the sound shader's output. ESC exits cleanly.
- Update `docs/browser-support.md` Kandelo demo entry to describe the playground.
- Update the gallery preset description in `apps/browser-demos/pages/kandelo/presets.ts` to reflect the new behavior (label can stay "SDL2 Demo" or move to "SDL2 Playground"; description should mention live editor + audio-visual playground + the Fractal Land boot default).

## Out of scope (explicit deferrals)

- **GLES 3.0 upgrade** — keep the GLES2 stack. Shadertoy paste-compat is a separate plan.
- **`iChannel0`..`iChannel3` textures** — no cubemap / video / built-in noise textures. `iAudio` covers the one audio-reactivity case.
- **Multi-pass / Buffer A–D** — single Image pass, single Sound pass. Multi-pass FBO orchestration is a follow-up plan.
- **Common tab** — no shared definitions across passes.
- **Microphone input** — sound shader provides the audio; no capture path.
- **Multi-file projects, autocomplete, code folding, minimap** — editor stays focused.
- **Asyncify** — explicitly not used (per CLAUDE.md fork-instrumentation policy).

## Open decisions

1. **Synth vs libxmp-lite for Phase 5's default music.** Lean synth: fresh-authored, no license tail, fits the "everything here is code we wrote" framing. Cost is comparable once libxmp-lite is trimmed.
2. **Sound-shader chunk size.** 2 seconds at 44100 Hz = ~300×300 RGBA = ~360 KB readback, expected sub-50 ms. If glitch is audible at swap, drop to 1 second.
3. **Window default size + canvas-advertised size.** 1280×720 default but the kandelo canvas may advertise smaller. Phase 1 needs to query and clamp; if the canvas is too small to host a usable editor pane, the split ratio becomes the open question.

## Effort

- **MVP (Phases 0–5):** ~12 working days — playground works, image shaders editable live, synthesized music plays, FFT visualization works.
- **Sound shaders (Phase 6):** ~5 days — closed-loop `mainSound` + `glReadPixels` + ALSA swap.
- **Signature Fractal Land homage (Phase 7):** ~5–7 days — authored image + sound shader pair, audio-visual coupling, set as boot default.
- **Editor polish (Phase 8):** ~4 days.
- **Verification + docs (Phase 9):** ~1 day.

**Total: ~27–29 working days for the polished audio-visual playground with the Fractal Land homage as the boot default.** Each phase is independently shippable; the first phase that's demo-worthy is Phase 2 (live shader compile), and every phase after is strictly more. Phases 6 and 7 can swap order if the Fractal Land authoring takes longer than expected — sound-shader infrastructure is the gate, but the homage doesn't have to be the first preset.

## Headline pitch (for the PR description)

> A Shadertoy-style live audio-visual editor running on Kandelo's SDL2 stack. Single SDL2 window: GLSL fragment shader editor on the left, live render on the right. A second editor mode (F2) compiles **sound shaders** — `mainSound(time)` GLSL functions whose output is rendered to an FBO, read back via `glReadPixels`, and played through ALSA. The visual shader samples the running audio's FFT via `iAudio`, so the two shaders are in dialog: edit the sound, the picture responds. **The boot default is an audio-visual pair authored as a homage to Inigo Quilez's Fractal Land — a Kaleidoscopic IFS raymarched terrain whose fold parameters and fog density pulse with a chiptune sound shader running in lock-step.** Three preset image shaders and five preset sound shaders ship in the VFS, all CC-0. ~4 k LOC C, zero ABI changes, no new syscalls, no new sysroot work. Exercises every subsystem plans 2–7 shipped (SDL2, GLES 2.0, KMS, evdev, ALSA, VFS) under a single live audio-visual application.
