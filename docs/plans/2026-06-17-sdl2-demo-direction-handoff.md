# SDL2 demo direction handoff — two candidate plans, user to pick next session

This is a *direction handoff*, not a session log. The session that produced it spent its time exploring whether the existing `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` (GLSL playground) is the right SDL2 demo to ship, or whether a different direction better fits the audience + the user's intent. Two finalist plans emerged; the user wants to decide between them next session.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`, tip `4f88111bb`. Not pushed. PR #709 untouched.
2. **Working tree:** SDL2-only — `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` and `apps/browser-demos/pages/kandelo/presets.ts` (SDL2 preset at the END of `PRESET_LIBRARY`, after `espeak`). Plus the new plan files in `docs/plans/`. The ABI 16 artifacts produced last session (5 wasm + 4 vfs.zst in `local-binaries/programs/wasm32/`) still on disk; do NOT regenerate.
3. **Two finalist plans on the table.** See §"Plan 1" and §"Plan 2" below. The user will pick one next session.
4. **Both plans depend on a live-edit compile loop** (edit C/C++ → see result). Plan 1 (GLSL) does NOT need it for v1 (GLSL compile is `glShaderSource` in-process). Plan 2 (Earth C++) DOES need it for v1 and is gated on Brandon Payton's local clang.wasm image landing somewhere we can fetch.
5. **Audience:** web developers. Colleague (Brandon) wanted to see the user's old raytracer project. Both factors keep recurring in the user's reasoning.
6. **Do NOT:** push, run `gh pr *`, regenerate the ABI 16 artifacts, bump `revision` fields, re-introduce `WASM_POSIX_DEV_NO_ABI_CHECK`, touch `scripts/check-abi-version.sh` (broken per handoff-57 §3 — out of scope).

## Where we are

- The existing SDL2 demo (`programs/sdl2_demo.c`) is a 5-second spinning quad + 440 Hz tone + ESC. User considers it "absolutely awful" and explicitly wants it replaced.
- The first replacement plan written this session — `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` — is the GLSL Playground (Plan 1 below). It is **complete, pruned, and ready to execute** if the user picks it.
- A second direction emerged after the user pointed at their personal raytracer at `/Users/mho/Work/projects/kandelo/demos/raytracer` and asked whether a C++ rewrite using GLES2 directly (not the CPU raytracer + GLES2 post-process decoration we briefly discussed) might be a better fit. That direction is Plan 2 — **no plan file written yet**, only described conceptually in this handoff.
- The user's exact framing on which finalist gets picked next session: *"In your next session, we will decide what's the shape of the definitive plan."*

## Plan 1 — GLSL Playground (file exists, ready to execute)

**Plan file:** `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` — already written and pruned this session. Do NOT re-author; read and consult.

**Shape in one paragraph:** A Shadertoy-style live editor running on the existing Kandelo SDL2 + GLES 2.0 + KMS + evdev + ALSA + VFS stack. Single SDL2 window, viewport split: GLSL fragment shader editor on the left, live render on the right. A second editor mode (F2) compiles **sound shaders** — `mainSound(time)` GLSL functions whose output is rendered to a 1024×1024 RGBA8 FBO, read back via `glReadPixels`, decoded as S16 stereo, played through ALSA. The image shader samples the running audio's FFT via `iAudio`, so the two shaders are in dialog — edit the sound, the picture responds.

**Key locked-in decisions (already in the plan):**
- Source dir `programs/sdl2/`, binary output `sdl2.wasm`, install path `/usr/local/bin/sdl2` (rename from `sdl2_demo`).
- GLES 2.0 only. No GLES3 upgrade, no GLSL transpiler, no Shadertoy paste-compat, no multi-pass / `iChannel` media.
- User authors against `mainImage` / `mainSound` API; the host wraps in a GLSL ES 1.0 (`#version 100`) template.
- Inconsolata (SIL OFL) bitmap-baked via stb_truetype for the editor font.
- Phase 7 is the signature preset: **Fractal Land homage** (Kaleidoscopic IFS terrain + chiptune sound shader, authored fresh under CC-0 using techniques from `iquilezles.org/articles` — IQ's actual code is CC-BY-NC-SA and explicitly out of scope to copy).
- ~3.5 k LOC C, 9 phases, ~27–29 working days for the polished version.

**What v1 doesn't need:** Brandon's clang.wasm image. GLSL compiles in-process via `glShaderSource`. Plan 1 ships without any new compile-loop infrastructure.

**Why the user questioned this plan after writing it:** they realized that "GLSL editor in a browser" is not unique — Shadertoy / WebGL Fluid Sim / every CodePen shader hack already proves browsers understand GLSL. The plan still lands as a strong stack flex (exercises all 6 subsystems including sound shaders) but it's *not* a uniquely Kandelo flex.

## Plan 2 — Earth GLES2 C++ Playground (concept only, no file yet)

**Plan file:** does NOT exist yet. Will need to be authored from scratch if the user picks this.

**Shape in one paragraph:** A live C++ editor running on the same SDL2 + GLES 2.0 + KMS + evdev + ALSA + VFS stack, but the editable artifact is **C++ source for a real-time-rasterized Earth demo** (vertex + fragment shaders driving a textured UV sphere, MVP matrix camera, day/night texture mix with diffuse + specular lighting). User edits C++ files in the left pane → saves → in-Kandelo clang compiles them → `fork+exec` of a child Kandelo process renders into a viewport on the right. Audio is an in-C synth tracker the user can also edit (replacing GLSL sound shaders — see §"What this plan loses" below).

**What this plan REUSES from the user's old raytracer** (`/Users/mho/Work/projects/kandelo/demos/raytracer/programs/earth/`):
- `vec3.h` (71 lines) — vector math, unchanged
- `axes.h` (68 lines) — rotation matrices, unchanged
- `transform.h` (69 lines) — transform abstraction (overkill for one sphere but ports cleanly)
- `tga.c` + `tga.h` (120 + 15 lines) — TGA loader, unchanged; pixels feed `glTexImage2D` instead of `/dev/fb0`
- The lighting model from `camera.c::cameraRender` (diffuse + specular + day/night mix) — lifted into the fragment shader as GLSL math

**What this plan REWRITES vs the old raytracer:**
- `main.c` (227 lines) — replaced. New `main.cpp` uses SDL2 init, GL ES 2.0 context, event loop driving an MVP camera, vertex/fragment shader compile, draw call. The old main opened `/dev/fb0` + mmap'd + stdin VT100 escape parsing — none of that survives.
- `sphere.c::sphereTrace` — replaced by a procedurally-generated UV sphere VBO + a rasterizing fragment shader. The math used to be ray-vs-sphere intersection on CPU; now it's standard texture lookup + Phong on GPU.
- `camera.c::cameraRender` — replaced. The lighting math survives (in GLSL); the per-pixel ray loop is gone.

**Architecture by file (sketch — actual plan would refine):**
```
programs/sdl2/
├── main.cpp              # SDL2 init, GL ctx, audio device, event loop, viewport split
├── editor.{cpp,h}        # gap buffer, cursor, selection, undo, multi-file tabs (F1/F2/F3/F4)
├── highlight.{cpp,h}     # C++ + GLSL lexers → token color attributes
├── renderer.{cpp,h}      # font atlas, editor UI quads, error overlay
├── earth.{cpp,h}         # mesh upload, texture upload, draw call orchestration
├── camera.{cpp,h}        # MVP matrices, orbit input, reuses old vec3/axes
├── synth.{cpp,h}         # 4-channel chip synth, ADSR, ALSA writer thread
├── pattern.cpp           # editable tracker pattern data (one of the editor buffers)
├── compile.{cpp,h}       # fork+exec the in-Kandelo clang on save; child-process canvas handoff
├── vfs.{cpp,h}           # load/save source + textures
├── shaders/              # earth.vert, earth.frag (also editable via F2/F3)
├── third_party/          # stb_truetype.h, kiss_fft.{c,h}
└── reuse/                # vec3.h, axes.h, transform.h, tga.{c,h} — verbatim from old project
```

**Subsystem coverage (matches Plan 1's GLSL playground):**

| Subsystem | What it does |
|---|---|
| SDL2 | Window, GL ctx, audio device, event loop, clipboard |
| GLES 2.0 | Editor UI quads, mesh VBO, vertex + fragment shaders for Earth, texture sampling |
| KMS | `SDL_GL_SwapWindow` per frame → page-flip |
| evdev | All printable keys + arrows + Ctrl/Shift mods + Esc + F-keys + Tab |
| ALSA | Drained by the in-C synth; FFT computed in-process for `iAudio` |
| VFS | C++ source save/load, TGA texture load, pattern.cpp save/load |

**Audio story (replaces GLSL sound shaders):** in-C chip-synth tracker. User edits `pattern.cpp` (one of the editor buffers); synth interprets it; FFT of synth output uploads as `iAudio` 1D texture sampled by the fragment shader to pulse Earth's atmosphere/lighting. Same closed-loop feel as the GLSL sound-shader version, just driven by C++ instead of GLSL. ~3 days, no FBO/`glReadPixels` plumbing needed.

**Effort sketch:** ~25–30 working days total, comparable to Plan 1. Phases 0–4 (rename, viewport split, live compile path, VFS load, editor) are roughly reusable from Plan 1's structure — what changes is Phases 5–7 (audio → in-C synth; visuals → C++ Earth instead of GLSL playground).

**Hard dependency:** Brandon Payton has a *local* image (per the user, not yet PR'd) where clang/LLVM compiles C to wasm inside Kandelo. The infrastructure side is already in this tree:
- `packages/registry/kandelo-sdk/` produces `kandelo-sdk.vfs.zst` (256 MB SDK image: sysroot + glue + clang resource headers)
- The image is staged in `binaries/programs/wasm32/` and `local-binaries/programs/wasm32/`
- The VFS image builder comment says: *"Compiler executables are staged separately so the SDK image can stay focused on data and scripts."*
- BUT: no `clang.wasm` / `wasm-ld.wasm` artifact exists anywhere on this branch.
- AND: `sdk/kandelo/bin/wasm32posix-cc` is a host-side bash wrapper that shells out to clang on the build machine — it's not a wasm binary.
- AND: nothing in `live-setup.ts` references `kandelo-sdk.vfs.zst`. The data-side groundwork ships, but no preset consumes it.

So Plan 2's headline live-edit feature is gated on Brandon's executable-side work landing. The fallback options if it doesn't land in time:
- (a) **Wait** — slowest, but the cleanest demo.
- (b) **Host-side compile sidecar** — POST source to a server endpoint, get back wasm. Works but breaks the "everything in Kandelo" pitch and fails in static deploys.
- (c) **Hot-reloadable parameters only** — editor displays code as read-only, sliders/keybinds tweak runtime params (fov, tilt, sun angle, zoom speed) via VFS-polled control file. Demo ships today; lose the "edit code, recompile" magic.

**What this plan loses vs Plan 1:**
- **GLSL sound shaders as a feature.** The Shadertoy-Sound-tab feature (edit `mainSound`, hear it, picture responds) does NOT survive in the C++ Earth pivot — tonally inconsistent with the "everything editable is C++" framing. The user explicitly accepted this trade ("Unfortunately, we lose the sound shaders so"). Closed-loop audio-visual story survives via the in-C synth tracker (option b above).
- **Plug-and-play visual presets.** Plan 1 ships 3 image presets + 5 sound presets. Plan 2 ships ONE deliverable (the Earth scene). Less variety, more focus.
- **Lower variance in the audience's "what to play with."** Plan 1 invites paste-anything experimentation. Plan 2 invites edit-this-specific-codebase experimentation. Different vibes.

**What this plan gains vs Plan 1:**
- **Uniqueness.** Live-compile-C-in-browser is a Kandelo-only flex. GLSL in browser is not.
- **C/C++ live editing.** The actual headline of the demo becomes "you wrote C++, it compiled inside the wasm kernel, fork+exec'd a child process that's drawing your code."
- **The user's old project's math lives on.** `vec3.h`, `axes.h`, `tga.c`, and the lighting model survive in the new codebase. The colleague who asked to see the raytracer sees *its math* alive on a modern API.
- **Audio is editable too** (option b synth tracker), in the same language as everything else.

## Other plans considered this session and rejected

For context if the next session re-opens scope:

- **TIC-80 fantasy console port** — strongest "web devs already love this tool" pitch. Rejected: ~3–4 weeks of porting work, hits 50k LOC C/C++ + scripting language embedding. Wrong scope for this demo slot.
- **p5.js-clone live JS REPL** — accessible to web devs, JS familiarity. Rejected: not the language Kandelo is fundamentally about (C/C++ POSIX).
- **Bytebeat audio playground** — viral one-liner music generator. Rejected: smaller wow ceiling.
- **Bonzomatic-clone** (live shader Showdown editor) — rejected because it's still GLSL editing, same uniqueness problem as Plan 1.
- **Shadertoy paste-compat playground** — rejected because it requires GLES 3.0 + a GLSL ES 1.0↔3.00 translator that's not in scope.
- **Earth raytracer as-is + GLES2 post-processing decoration** — rejected by the user this session because it doesn't *actually use* GLES 2.0 as a renderer, only as a Photoshop filter. Led directly to Plan 2.
- **Pure GLSL port of Earth as a Plan 1 preset** — rejected because the result isn't the user's C code, just a mechanical transliteration.

## Things NOT to do

- **Do NOT push.** Branch stays local.
- **Do NOT** `gh pr *`. PR #709 untouched.
- **Do NOT** re-introduce a `WASM_POSIX_DEV_NO_ABI_CHECK` bypass (handoff-61 §A).
- **Do NOT** bump `revision` fields in `build.toml` files to force rebuilds (handoff-63 §"How the staleness bug actually works").
- **Do NOT** regenerate the ABI 16 artifacts already in `local-binaries/programs/wasm32/`.
- **Do NOT** spend time on `scripts/check-abi-version.sh` SIGPIPE — still broken per handoff-57 §3, orthogonal.
- **Do NOT** start writing the Plan 2 file until the user has picked between Plan 1 and Plan 2. The two plans are mutually exclusive deliverables; authoring both wastes a session.
- **Do NOT** modify the GLSL playground plan file unless the user picks Plan 1 and asks for changes.

## What the next session must do

1. **Read this handoff first.** Then read `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` (Plan 1, full file). Optionally skim `/Users/mho/Work/projects/kandelo/demos/raytracer/programs/earth/*.c` and `*.h` for Plan 2 context.
2. **Help the user pick between Plan 1 and Plan 2.** The deciding factors per this session's discussion:
   - Does Brandon's in-Kandelo clang.wasm image land soon? (If yes → Plan 2 is unblocked. If no → Plan 1 ships sooner.)
   - Does the user want stack-flex (Plan 1: 6/6 subsystems via the closed-loop audio-visual story) or kernel-flex (Plan 2: "live-compile C++ in the browser via wasm POSIX kernel" — the unique Kandelo angle)?
   - Does the colleague's "I want to see the raytracer" carry enough weight to make Plan 2 worth waiting for? (Plan 2 honors it via the math lifted into the new codebase.)
3. **If user picks Plan 2**, draft `docs/plans/2026-06-17-sdl2-earth-cpp-playground-plan.md` modeled on the GLSL playground plan's structure, but with the Plan 2 architecture from §"Plan 2" above. Phases 0–4 are mostly reusable scaffolding; Phases 5–7 (audio synth, Earth rendering, post-process polish) and Phase 8 (live-compile path) are the substantive new work. Address the Brandon clang.wasm dependency explicitly in Phase 8 with concrete fallback decisions.
4. **If user picks Plan 1**, the existing plan file is ready to execute — no further plan-authoring needed. Start with Phase 0 (rename + build wiring).
5. **Either way: do NOT commit, push, or PR without explicit per-session approval.**

## Reverted fixes from session 63 — still pending as separate PRs

Independent of which plan the user picks, these three fixes from session 62/63 were reverted and remain useful follow-ups once the SDL2 demo lands. Mention in the SDL2 PR description so reviewers know the local-binaries → ABI 16 path is reproducible only after these follow-ups merge:

1. **Per-package build-script `.o` cleanup** for bzip2/less/unzip/zip (`find . -name '*.o' -delete` before `make`) and msmtpd (remove early-exit). Fixes the "stale `.o` files older than the new `libc/glue/abi_constants.h`" bug that masks ABI bumps — see handoff-63 §"How the staleness bug actually works" for the full diagnosis.
2. **nethack host-link pre-clean** for `src/{monst,objects,drawing,decl,alloc,dlb}.o` (handoff-62 §B).
3. **shell-vfs-image espeak-optional skip** (handoff-62 §C) so cloning the branch fresh doesn't hit espeak-source-missing.

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-sdl2-demo-direction-handoff.md` first. Branch is `explore-dri-sdl2`, tip `4f88111bb`, NOT pushed, PR #709 untouched. Two finalist SDL2 demo plans on the table: Plan 1 (GLSL Playground, full plan exists at `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`, ships without a live-compile dependency, has sound shaders) versus Plan 2 (Earth GLES2 C++ Playground, no plan file yet, reuses the user's old raytracer math from `/Users/mho/Work/projects/kandelo/demos/raytracer/programs/earth/`, depends on Brandon Payton's in-Kandelo clang.wasm image which currently exists only as a local image, replaces GLSL sound shaders with an editable in-C synth tracker). Help the user pick between them based on the deciding factors enumerated in the handoff's §"What the next session must do". If Plan 2 wins, draft `docs/plans/2026-06-17-sdl2-earth-cpp-playground-plan.md` modeled on Plan 1's structure. If Plan 1 wins, the existing plan file is ready — start with Phase 0. Do NOT push, do NOT `gh pr *`, do NOT commit without explicit per-session approval. Three reverted fixes from session 63 (build-staleness, nethack host-link, espeak-optional) remain useful follow-up PRs after whichever SDL2 plan lands — call them out in the SDL2 PR description. `scripts/check-abi-version.sh` still broken per handoff-57 §3 — out of scope. Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR."*
