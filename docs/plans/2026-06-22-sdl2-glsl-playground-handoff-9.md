# SDL2 GLSL playground handoff #9 — Phase 8 finished (editor polish), Modeset overlay centering fix, sound boot-render confirmed (all uncommitted)

Ninth handoff in the chain (after `…-handoff-1.md` … `…-handoff-8.md`). Branch still `explore-dri-sdl2`. **Committed tip is STILL `b9bc545d4`** (PR #709 = Phases 1–4 + browser fixes). Everything from Phases 5, 6, 7, AND 8 lives only in the working tree — **nothing is committed yet** (standing policy: commit only when the user authorizes). Handoff-8 is authoritative for Phases 5/6/7; this one is authoritative for the **Phase 8 work** layered on top, plus two follow-ups (Modeset centering, sound boot-render).

## TL;DR — read this first

1. **Branch `explore-dri-sdl2`, committed tip still `b9bc545d4`.** Phases 5 + 6 + 7 + 8 are all **uncommitted working-tree changes**.
2. **Phase 8 (editor polish) is now COMPLETE** — all six plan items implemented. Handoff-8 had only delivered syntax highlighting; this session added the other five.
3. **Sound boot-render is correct and user-confirmed.** Mid-session I briefly removed the boot sound render (user had asked "can I edit the sound shader without the music auto-playing?"), which made the **chip synth** play instead of Tunnelwisp — the user called that "your first sound artifact." They then said they DO want sound on boot, so I **reverted** to the original boot-render. Console now shows `audible=1` + `boot sound render frames=13631488`; the user confirmed **"the current sound is perfect."** Do NOT remove the boot render again.
4. **Modeset overlay text was mis-centered** ("Run modeset from the shell" scattered). Fixed in `apps/browser-demos/pages/kandelo/panes/Modeset.tsx` by wrapping each overlay message in a single child `<div>` (the parent is `display:flex`, so multiple text nodes / `<code>` became separate flex items). Browser HMR picks up `.tsx`; no rebuild.
5. **Scoped gate green** (`cd host && npx vitest run sdl2` → 4/4) after every change. **NOT re-run this session:** full vitest, cargo, ABI. No `ABI_VERSION` bump needed (all changes are user-space `programs/sdl2/*.c|*.h` + one browser `.tsx` + plan doc — zero kernel/syscall/marshalled-struct surface).
6. **Browser-confirmed by the user:** image renders (Tunnelwisp), sound plays on boot (Tunnelwisp). **NOT browser-confirmed:** the entire Phase 8 editor feature set added this session (selection/clipboard/undo/error-marker/preset overlay/splash/highlighting), and the carried-over handoff-8 items (the 284 s sound loop + boot delay, wheel scroll, Ctrl+1/2).

## What got implemented this session (all uncommitted, on top of handoff-8)

### Phase 8 — editor polish (the five items beyond highlighting)

All pure `programs/sdl2/` user-space C. The font is monospace so all per-column geometry is `text_x + col*advance`.

**1. Selection + clipboard** (`editor.c` + `editor.h` + `main.c`)
- Anchor-based selection: `#define NO_SEL ((size_t)-1)`, `g_sel_anchor`. Span is `[min(anchor,cursor), max)`. New API: `editor_selection_begin/clear/select_all/has_selection/selection_dup/delete_selection`, `editor_pointer_extend_select`.
- `main.c`: Shift + arrows/Home/End/PgUp/PgDn extend (plain key clears), mouse-drag (`dragging` local, `SDL_MOUSEBUTTONUP` handler added), **Ctrl+A** select-all.
- **Ctrl+C / Ctrl+X / Ctrl+V** = `clip_copy/clip_cut/clip_paste` using `SDL_SetClipboardText`/`SDL_GetClipboardText`/`SDL_HasClipboardText`, **with an in-app fallback** `static char *g_clip` (KMSDRM SDL clipboard may be a no-op — fallback keeps in-editor copy/paste working). `g_clip` freed at shutdown.
- Insert/delete auto-replace the active selection **inside** `editor.c` (so every caller is covered): `editor_insert_char/text` and `editor_delete_back/forward` call `editor_delete_selection()` when a selection is active.
- Render: translucent Dracula-selection (`#44475a`) wash per visible line, drawn before the text.

**2. Undo/redo** (`editor.c`)
- `Snapshot {char*text; size_t cursor}` ring, `UNDO_MAX 32`, `g_undo[]`/`g_redo[]`. Coalesced by `EditKind {EK_NONE,EK_INSERT,EK_DELETE}`: `undo_record(kind)` pushes a pre-edit snapshot only when `g_undo_break` is set or the kind changed; `undo_break()` (called from cursor moves via `editor_move_left/right` + `move_to_offset`) ends a group. `editor_undo/redo` swap snapshots; `editor_replace_all` (preset load) is one forced step.
- **Ctrl+Z / Ctrl+Y** in `main.c`, each arms the recompile debounce so the preview re-syncs.
- Refactor: `editor_init` now delegates buffer construction to a shared static `build_buffer(text, cursor)` (also used by undo restore + preset load); only `editor_init` logs `editor loaded N chars`.

**3. Error-line marker** (`renderer.c`/`.h`, `sound_shader.c`/`.h`, `editor.c`/`.h`, `main.c`)
- `renderer_last_error_line()` / `sound_shader_last_error_line()` parse the GLSL log's first `0:<line>` (ANGLE/Mesa `ERROR: 0:<line>:` shape) and subtract the template-prefix line count → user-source 1-indexed line, or -1.
  - **Prefix line counts (computed at runtime by counting `\n`, so robust to edits): image `USER_FRAG_PREFIX` = 9 lines; sound `SOUND_FRAG_PREFIX` = 5 lines.**
- `editor_set_error_line(line0)` (0-indexed, -1 = clear). `editor_render` washes that line red and prints its gutter as `!%3d` in red. Every recompile path in `main.c` (`recompile_from_editor`, `recompile_sound_from_editor`, `reload_user_shader_from_file`) now sets/clears it.

**4. Preset dropdown** (`main.c`, needs `#include <dirent.h>`)
- `preset_refresh(mode)` `readdir`s `/usr/share/shaders/{image,sound}`, filters `*.frag`, insertion-sorts, caches per-mode (`MAX_PRESETS 32`, `PRESET_NAME_MAX 64`).
- **Ctrl+L** = `preset_cycle` (load `(current+1)%count`). **Ctrl+Shift+L** = `preset_overlay_open` → modal overlay; while `g_preset_overlay` is set the keydown handler swallows ↑/↓/Enter/Esc (Esc closes, NOT quit) before anything else. `preset_overlay_render(editor_w, gl_h)` draws the centered list under the editor-pane scissor.
- `preset_load` → `editor_replace_all` (undoable) + recompile (image or sound). Loading a **sound** preset triggers the heavy ~284 s render (same cost as F2).

**5. Splash + title** (`main.c` render section)
- Persistent "SDL2 GLSL Playground" in the render-pane bottom-left corner. Boot splash for `SPLASH_MS = 2600` ms: a render-pane backdrop that fades over the tail + centered title + `F1 image | F2 sound | Ctrl+L presets | ESC quit`. Drawn under a render-pane scissor (`glScissor(editor_w,0,render_w,gl_h)`) so it isn't clipped by the editor pass. NOTE `renderer_draw_text*` has **no alpha param**, so only the `renderer_fill_rect` backdrop fades; the text hard-cuts at `SPLASH_MS`.

### Modeset overlay centering fix (`apps/browser-demos/pages/kandelo/panes/Modeset.tsx`)
- The two "waiting…" overlays are `display:flex` containers; multiple inline children (text + `<br>` + `<code>`) each became a separate flex item, scattering the layout. Wrapped each overlay's content in one `<div>` so the flex centers a single inline-flow block. Browser-demo UI only — no Node counterpart, no rebuild.

### Sound boot-render (`main.c`) — reverted + diagnostics kept
- Net change vs handoff-8: **the boot render is unchanged** (renders Tunnelwisp + plays on boot). Added boot diagnostics: `sdl2: boot sound render frames=%d` on success, `sdl2: boot sound recompile FAILED — synth fallback: <log>` on a real compile failure (was previously a silent fall-through to the synth).

### Docs
- `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` §Phase 8 marked **DONE** with a per-item ✅ checklist.

## Critical technical findings (don't re-derive)

- **The "wrong sound" was the synth fallback, not a real bug.** `audio_set_sound_pcm` falls back to the chip synth whenever `sound_shader_render` returns `audible=0` (or `g_pcm`/recompile fails). Removing the boot render exposed that synth as the boot audio. With the boot render present, real GL yields `audible=1` and Tunnelwisp plays. If sound ever regresses to synth, read the console: `WARN: sound pcm malloc(...) failed` (54 MiB rejected) vs `render … audible=0` (13-tile GPU watchdog/TDR) vs `boot sound recompile FAILED` (browser GLSL rejected the shader) — three different fixes (handoff-8 §"Critical technical findings").
- **Block-comment `*/` gotcha bit once:** a C comment containing `editor_insert_*/editor_delete_*` closed the comment early. Don't put `*/` inside comment prose.
- **Flex + multiple text nodes scatters layout.** Any React overlay that centers text with `display:flex` must wrap the text in a single child element.
- **GLSL error line is in WRAPPED-shader coordinates.** Always subtract the template prefix's `\n` count to map back to the editor. Image prefix = 9, sound prefix = 5 (recomputed from the strings at runtime).
- **Preset list is `readdir`-driven**, not hardcoded — `live-setup.ts` already stages image `{plasma,audio_bars,tunnelwisp}` and sound `{sine,fm_bell,noise_sweep,chord,tunnelwisp}`, so Ctrl+L has content. If you add a preset `.frag`, stage it in `live-setup.ts` and it shows up automatically.
- **`programs/sdl2/*.c` is globbed** by `scripts/build-programs.sh` (`sdl2_sources=("$REPO_ROOT"/programs/sdl2/*.c`), so adding a new `.c` there compiles automatically — no build-script edit needed. (I kept everything in existing files anyway.)
- **No `-Wall`/`-Werror`** in the sdl2 CFLAGS, so unused statics won't fail the build — but I removed the now-dead `TEXT_R/G/B` editor constants (highlighter's `HL_DEFAULT` replaces them).

## Build / run / verify

```bash
# Rebuild after any programs/sdl2/*.c|*.h edit (sdl2 = 5 sources: main, editor, renderer, audio, sound_shader):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh
# .frag-only and .tsx-only edits need NO rebuild — just hard-reload.
# Scoped gate (fast, 4/4):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run sdl2'
# Full gate before commit (run INSIDE dev-shell): full vitest, cargo, ABI:
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run'
cargo test -p kandelo --target aarch64-apple-darwin --lib            # expect 1080/0
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/check-abi-version.sh   # expect exit 0, no bump
# Live demo (NOT ./run.sh browser): cd apps/browser-demos && npx vite  →  http://127.0.0.1:5402/?demo=sdl2
```
New keybindings to exercise in the browser: arrows+Shift / drag / **Ctrl+A** (select), **Ctrl+C/X/V**, **Ctrl+Z/Y**, **Ctrl+L** (cycle preset), **Ctrl+Shift+L** (preset overlay; ↑/↓/Enter/Esc), and introduce a GLSL typo to see the `!` red error-line marker. Console: `sdl2: preset load=<name>`.

## NEXT — pick up here

1. **Browser-verify Phase 8** (hard-reload `…:5402/?demo=sdl2`): syntax colors; Shift/drag/Ctrl+A selection + Ctrl+C/X/V (incl. the KMSDRM clipboard fallback); Ctrl+Z/Y; the `!` red error-line marker (type a GLSL error); Ctrl+L cycle + Ctrl+Shift+L overlay; the boot splash + corner title. Plus the still-unconfirmed handoff-8 items (284 s loop + boot delay, wheel scroll, Ctrl+1/2).
2. **Phase 9 — verification + docs + SHIP** (the only remaining plan phase): run the full gate (vitest + cargo + ABI), update `docs/browser-support.md` Kandelo entry + the gallery preset description in `apps/browser-demos/pages/kandelo/presets.ts`, then open/refresh the PR. Beyond Phase 9 the plan's work is "done"; everything else is the explicit out-of-scope list (multi-pass/Buffer A–D, `iChannel0..3` textures, GLES3/Shadertoy paste-compat, mic input, Common tab) — each a separate follow-up plan.
3. **When the user authorizes a commit:** stage SDL2 paths explicitly (NEVER `git add -A` — the tree has ~60 unrelated DRI planning docs + dirty submodules). The Phase 5/6/7/8 set to stage:
   - `programs/sdl2/{main,editor,renderer,audio,sound_shader}.c`, `programs/sdl2/{editor,renderer,audio,sound_shader}.h`
   - `programs/sdl2/presets/image/{audio_bars,tunnelwisp}.frag`, `programs/sdl2/presets/sound/{sine,fm_bell,noise_sweep,chord,tunnelwisp}.frag` (`plasma.frag` already tracked)
   - `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, `apps/browser-demos/pages/kandelo/panes/Modeset.tsx`
   - `host/src/input/browser-input-source.ts`, `host/test/sdl2.test.ts`
   - `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`
   - Run the full gate first. No `ABI_VERSION` bump.

## Things NOT to do (carried forward, still true)

- **Do NOT remove the boot sound render** — the user wants Tunnelwisp on boot ("the current sound is perfect").
- **Do NOT author visual/musical content yourself** — port proven CC0/MIT work or reimplement recognized techniques; base color schemes on known themes (highlighting uses Dracula). Do NOT recreate the deleted `fractal_land.frag` pair.
- **Do NOT commit without user authorization**, and never `git add -A`.
- **Do NOT touch** `host/src/kernel.ts`, `host/src/webgl/`, kernel syscalls/`wasm_api.rs`, or the kernel SAB/audio files — none of this needed them.
- **Do NOT call `glIsEnabled`/`glDeleteFramebuffers`**, push a single texture upload past ~65499 bytes, or a single `glReadPixels` past 64 KB.
- **Do NOT add KISSFFT / asyncify.**
- Run vitest **inside `scripts/dev-shell.sh`** (else `fork-dlopen-replay-e2e` spuriously fails on missing CLANG).

## Standing instruction for next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-22-sdl2-glsl-playground-handoff-9.md` first — it is authoritative for the uncommitted SDL2 playground work (handoffs 1–8 are historical; committed tip is still `b9bc545d4` on branch `explore-dri-sdl2`, PR #709). Phases 5, 6, 7, AND 8 are all IMPLEMENTED in the working tree and NOT committed. Phase 8 (editor polish) is now COMPLETE — this session added selection + clipboard (Shift/drag/Ctrl+A, Ctrl+C/X/V with an in-app fallback, auto-replace), undo/redo (Ctrl+Z/Y, 32-snapshot coalesced ring), the error-line marker (parse GLSL `0:<line>`, subtract template prefix 9 image / 5 sound, wash the line red + `!` gutter), the preset dropdown (Ctrl+L cycle, Ctrl+Shift+L modal overlay, readdir of `/usr/share/shaders/{image,sound}`), and the boot splash + render-pane title — on top of handoff-8's Dracula syntax highlighting. Also fixed the Modeset overlay centering (`Modeset.tsx`: wrap each flex message in one `<div>`), and CONFIRMED the boot sound: I had briefly removed the boot render (which made the chip synth play instead of Tunnelwisp — the "first sound artifact") then reverted it, and the user confirmed Tunnelwisp on boot is perfect (`audible=1`) — do NOT remove the boot render again. Scoped gate `cd host && npx vitest run sdl2` is 4/4; full vitest + cargo + ABI were NOT re-run — run them before any commit (cargo 1080/0, ABI exit 0, no `ABI_VERSION` bump; all changes are `programs/sdl2/*.c|*.h` + `Modeset.tsx` + a plan doc). NOT browser-verified yet: the whole Phase 8 feature set + the carried-over 284 s loop/wheel-scroll/Ctrl+1-2. Next: (1) browser-verify Phase 8 at `cd apps/browser-demos && npx vite` → `http://127.0.0.1:5402/?demo=sdl2` (NOT `./run.sh browser`), then (2) Phase 9 = full gate + docs (`browser-support.md`, `presets.ts`) + ship the PR. Do NOT touch `host/src/kernel.ts`/`host/src/webgl/`/kernel syscalls; do NOT author visual/musical content or recreate `fractal_land`; do NOT add KISSFFT/asyncify; when authorized to commit, stage SDL2 paths explicitly, never `git add -A`."*
