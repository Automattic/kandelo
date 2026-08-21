# SDL2 GLSL playground handoff #10 — devil's-advocate dead-code scrub, real `move_vertical` bug fixed, native editor unit test added (all uncommitted)

Tenth handoff in the chain (after `…-handoff-1.md` … `…-handoff-9.md`). Branch still `explore-dri-sdl2`. **Committed tip is STILL `b9bc545d4`** (PR #709 = Phases 1–4 + browser fixes). Phases 5–8 + this session's cleanup all live only in the working tree — **nothing is committed yet** (standing policy: commit only when the user authorizes). Handoff-9 is authoritative for the Phase 5/6/7/8 feature work; **this one is authoritative for the post-Phase-8 cleanup pass** layered on top.

## TL;DR — read this first

1. **Branch `explore-dri-sdl2`, committed tip still `b9bc545d4`.** Phases 5+6+7+8 + this cleanup are all **uncommitted working-tree changes**.
2. **The user asked for a "devil's advocate" review of everything I authored for the SDL2 phase**: prove every new character is needed, remove stale/artifact code, reduce comments to *why* not *what*, and give each functionality a dedicated test. Phase 8 features were browser-verified by the user ("Everything works") before this pass.
3. **Scope of the scrub = `programs/sdl2/` (the playground app code I wrote) + its tests.** The sysroot cross-compile patches (upstream SDL2 patches, configure overrides, evdev/dynapi shims) are deliberate load-bearing build-enablement of a third-party dep, NOT exploratory artifacts — explicitly left out of a dead-code scrub. User was told this and can ask for that audit separately.
4. **A real latent BUG was found and fixed** (not just dead code): the editor's vertical desired-column memory never worked. See below.
5. **Gate:** cargo **1080/0**, ABI **exit 0** (no `ABI_VERSION` bump — all changes are user-space), scoped `vitest run sdl2` **5/5** (incl. the new native editor unit test). Full `vitest run` = 883 pass / **4 fail**, and **those 4 are pre-existing + environmental, NOT mine** (see "Full-vitest failures" below).
6. **All changes are still user-space `programs/sdl2/*.c|*.h` + `host/test/sdl2*.ts` + the new `programs/sdl2/test/` + this doc.** Zero kernel / ABI / syscall / `host/src/` surface touched (the lone `host/src/input/browser-input-source.ts` "M" in `git status` was already dirty pre-session — NOT mine).

## What this session changed (all uncommitted, on top of handoff-9)

### Dead code removed (verified by call-site sweep + `-Wall -Wextra -fsyntax-only`)

- **4 functions defined+declared but never called anywhere** — removed from both `.c` and `.h`:
  - `editor_text_length()` (editor.c/.h)
  - `renderer_text_ascent()` (renderer.c/.h)
  - `renderer_error_visible()` (renderer.c/.h) — the *getter*; `renderer_set_error_visible()` (setter) IS used and stays. `renderer_draw_error_strip` reads the `g_error_visible` static directly.
  - `renderer_last_error()` (renderer.c/.h) — the image-shader error-*string* getter, never read. NOTE its sibling `sound_shader_last_error()` IS used (main.c boot-fail log), and `renderer_last_error_line()` IS used — only the bare string getter was dead. `g_last_error` static stays (written by compile_shader, read by `renderer_last_error_line`).
- **`g_blend_enabled` (renderer.c)** — vestigial: `static int g_blend_enabled = 0;`, read in `renderer_fill_rect`'s `if (!g_blend_enabled) glEnable/glDisable`, but **never assigned 1 anywhere**. Always-0 → the guards were dead-equivalent to unconditional enable/disable (which is what `renderer_draw_text` already does). Removed the var + its misleading "renderer owns the blend bit" comment; made the two `glEnable/glDisable(GL_BLEND)` unconditional.

### Real bug fixed — editor vertical desired-column memory (editor.c `move_vertical`)

`move_vertical()` set `g_desired_col = col` **before** calling `move_to_offset()`. But `move_to_offset` → `editor_move_left`/`editor_move_right`, and **each horizontal primitive resets `g_desired_col = -1`**. So the remembered column was clobbered on every vertical move — the "preserves horizontal memory across short lines like every other editor" behavior the comment promised never functioned (Down through a short line lost your column). **Fix: moved the `g_desired_col = col;` assignment to AFTER the `if/else` move block** (early-return boundary paths correctly skip it, leaving the prior value). The new unit test's `test_movement` "desired column restored" case is what caught it.

### Comments: removed *what*/stale, kept *why* (per the user's mandate)

- renderer.c `build_font_atlas`: comment described `stbtt_BakeFontBitmap` + "512×512" — code actually uses `stbtt_PackFontRange` into 256×240. Corrected.
- main.c: "re-render its 2-second chunk" → it's 13 tiles ≈ 284 s; "per-buffer cursor persistence is Phase 8 polish" (Phase 8 done, never implemented) → reworded.
- editor.c: removed a `/*` *inside* a block comment (`*a/*b`) that tripped `-Wcomment` (the exact footgun handoff-9 warned about); removed stale "Indentation-aware tabbing is Phase 8" forward-ref.
- editor.h: rewrote the top doc to describe current capabilities (no "Phase 4 lands…"/"lands in Phase 8" archaeology); dropped `(Phase 8)` section tags; the "unit-testable on its own" claim now points at the real test file.
- main.c splash: deduped a doubled `"SDL2 GLSL Playground"` literal (`t1` → reuse `title`; renamed the hint var).
- sdl2.test.ts: trimmed the stale "Phase 4 shape" 30-line docstring; renamed the `describe()` from "(Phase 4)".
- **Deliberately kept** the legitimate *why* comments (GPU-watchdog tiling, calloc-vs-malloc-for-headless, polling-audio threading model, the caveman `SDL_EVDEV_DEVICES` note, FFT normalization rationale, etc.) — those are exactly what the user wanted preserved.

### Tests added — each new functionality now has a dedicated test

- **NEW native unit test** `programs/sdl2/test/editor_test.c` (+ gate wiring `host/test/sdl2-editor-unit.test.ts`). editor.c is pure logic (only depends on renderer.h, which the test stubs), so it compiles for the **host** (`cc`/`clang`, native, NOT wasm) and runs under vitest via `child_process`. Cases: insert/delete, movement + desired-column memory, selection bounds/dup, select-all, delete-selection, auto-replace-on-type (insert/backspace/paste over a selection), undo/redo coalescing + redo-clear, replace_all-as-one-step, render smoke. The vitest spec probes `cc`→`clang`→`gcc`, compiles with `-Wall -Wextra -Werror -O1`, asserts stdout `editor_test: ALL PASS`.
  - **IMPORTANT build interaction:** `scripts/build-programs.sh` globs `programs/sdl2/*.c` (non-recursive) into the single `sdl2.wasm`. The new test lives in `programs/sdl2/test/`, so it is correctly **excluded** from that glob (confirmed: build logs "5 file(s)"). Do not move it up a level or it'll fight `sdl2.wasm`'s `main()`.
- **Extended** `host/test/sdl2.test.ts`: added `KEY_L = 38`, injects **Ctrl+L** (preset cycle), asserts `/sdl2: preset (load=|list empty)/` — the one Phase 7/8 main.c feature with a real breadcrumb that was untested. (Node rootfs stages no presets → it takes the graceful "list empty" branch.)

## Critical technical findings (don't re-derive)

- **`-Wunused-function` does NOT flag dead non-static (extern) functions** — only static. The 4 dead public functions were found by a call-site grep sweep (`grep -oE '\bfn\('` count == 1 ⇒ definition-only ⇒ dead), not the compiler. Re-run that sweep if you add/remove public API.
- **The vendored `third_party/stb_truetype.h` floods `-Wall` with ~27 `unused-function` warnings** — that's expected for a header-only lib exposing its whole API; filter `grep -v third_party`. My code is warning-clean.
- **A clean `-Wall -Wextra -fsyntax-only` over `programs/sdl2/*.c` is cheap** and uses the local sysroot with plain `/usr/bin/clang` (no dev-shell): `clang --target=wasm32-unknown-unknown --sysroot=$PWD/sysroot -nostdlib -O2 -matomics -mbulk-memory -fno-trapping-math -I$PWD/sysroot/include/{libdrm,drm} -Wall -Wextra -Wno-unused-parameter -fsyntax-only programs/sdl2/<f>.c`.
- **Full-vitest failures (4) are pre-existing + environmental, NOT regressions:** `test/exec-brk-base.test.ts` (3 fails — mariadbd InnoDB bootstrap, 75 s timeout; fails identically in isolation) and `packages/registry/spidermonkey/test/spidermonkey-node-compat.test.ts` (1 fail — missing VFS module `/usr/local/lib/kandelo/npm-runner.js`). Neither file is in my diff; both load only the kernel + package binaries (mariadbd/dash/spidermonkey) that I never rebuilt or modified — I rebuilt only `sdl2.wasm`. No code path from my user-space SDL2 edits reaches them. (Verify on a clean checkout if in doubt; do NOT chase these as part of the SDL2 work.)

## Build / run / verify (unchanged from handoff-9 except the new test)

```bash
# Rebuild after any programs/sdl2/*.c|*.h edit (still 5 sources in the glob):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh
# Scoped gate (fast, now 5/5 — includes the native editor unit test):
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run sdl2'
# Native editor unit test alone (no wasm/kernel needed):
cc -std=c11 -Wall -Wextra -Werror -O1 programs/sdl2/editor.c programs/sdl2/test/editor_test.c -o /tmp/et && /tmp/et
# Full gate: cargo 1080/0 ; ABI exit 0 (no bump) ; full vitest (4 unrelated mariadbd/spidermonkey fails, see above)
cargo test -p kandelo --target aarch64-apple-darwin --lib
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/check-abi-version.sh
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run'
# Live demo (NOT ./run.sh browser): cd apps/browser-demos && npx vite  →  http://127.0.0.1:5402/?demo=sdl2
```

## NEXT — pick up here

1. **(Optional) browser re-verify** the editor still behaves after the `move_vertical` fix + dead-code removal: arrow Up/Down through short lines should now keep the column (the bug this session fixed). Hard-reload `…:5402/?demo=sdl2`.
2. **Phase 9 — verification + docs + SHIP** (the remaining plan phase): docs are still TODO — update `docs/browser-support.md` Kandelo entry + the gallery preset description in `apps/browser-demos/pages/kandelo/presets.ts`, then open/refresh PR #709.
3. **When the user authorizes a commit:** stage SDL2 paths **explicitly** (NEVER `git add -A` — the tree has ~60 unrelated DRI planning docs + dirty submodules). The full set to stage (handoff-9's list **plus this session's additions**):
   - `programs/sdl2/{main,editor,renderer,audio,sound_shader}.c`, `programs/sdl2/{editor,renderer,audio,sound_shader}.h`
   - **`programs/sdl2/test/editor_test.c`** (new) and **`host/test/sdl2-editor-unit.test.ts`** (new)
   - `programs/sdl2/presets/image/{audio_bars,tunnelwisp}.frag`, `programs/sdl2/presets/sound/{sine,fm_bell,noise_sweep,chord,tunnelwisp}.frag` (`plasma.frag` already tracked)
   - `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, `apps/browser-demos/pages/kandelo/panes/Modeset.tsx`
   - `host/src/input/browser-input-source.ts`, `host/test/sdl2.test.ts`
   - `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` (+ optionally this handoff)
   - Run the full gate first. **No `ABI_VERSION` bump.**

## Things NOT to do (carried forward, still true)

- **Do NOT remove the boot sound render** — user wants Tunnelwisp on boot ("the current sound is perfect").
- **Do NOT chase the 4 full-vitest failures** (mariadbd/spidermonkey) as part of SDL2 — they're pre-existing environmental, orthogonal to this work.
- **Do NOT move `programs/sdl2/test/editor_test.c` up into `programs/sdl2/`** — it would get globbed into `sdl2.wasm` and collide with `main()`.
- **Do NOT author visual/musical content yourself**; do NOT recreate the deleted `fractal_land.frag` pair.
- **Do NOT commit without user authorization**, and never `git add -A`.
- **Do NOT touch** `host/src/kernel.ts`, `host/src/webgl/`, kernel syscalls/`wasm_api.rs`, or the kernel SAB/audio files — none of this needed them.
- **Do NOT add KISSFFT / asyncify.** Run full vitest **inside `scripts/dev-shell.sh`** (else `fork-dlopen-replay-e2e` spuriously fails on missing CLANG).

## Standing instruction for next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-22-sdl2-glsl-playground-handoff-10.md` first — it is authoritative for the post-Phase-8 devil's-advocate cleanup of the uncommitted SDL2 playground work (handoffs 1–9 are historical; committed tip is still `b9bc545d4` on branch `explore-dri-sdl2`, PR #709, nothing committed). This session scrubbed `programs/sdl2/` for dead code: removed 4 never-called functions (`editor_text_length`, `renderer_text_ascent`, `renderer_error_visible`, `renderer_last_error`) and the vestigial `g_blend_enabled` (never assigned 1); fixed a REAL latent bug where `move_vertical` clobbered `g_desired_col` via `move_to_offset` so vertical column-memory never worked (moved the assignment after the move); fixed stale/misleading comments (BakeFontBitmap→PackFontRange/256×240, "2-second chunk"→13-tile ~284 s, removed Phase-8 archaeology + a `/*`-in-comment); and ADDED a dedicated native editor unit test `programs/sdl2/test/editor_test.c` run via `host/test/sdl2-editor-unit.test.ts` (compiles editor.c for the host with renderer stubs — covers selection/undo-redo/auto-replace/movement) plus Ctrl+L preset coverage in `sdl2.test.ts`. Gate is green: cargo 1080/0, ABI exit 0 (no `ABI_VERSION` bump — all changes user-space), scoped `vitest run sdl2` 5/5; the only full-vitest failures are 4 PRE-EXISTING ENVIRONMENTAL ones in `exec-brk-base.test.ts` (mariadbd InnoDB timeout) and spidermonkey (missing `npm-runner.js`) — NOT mine, do not chase. `programs/sdl2/test/editor_test.c` must stay in the `test/` subdir so `scripts/build-programs.sh`'s `programs/sdl2/*.c` glob doesn't pull it into `sdl2.wasm`. Next: (1) optional browser re-verify the up/down column-memory fix at `cd apps/browser-demos && npx vite` → `http://127.0.0.1:5402/?demo=sdl2`, then (2) Phase 9 = docs (`browser-support.md`, `presets.ts`) + ship PR #709. When authorized to commit, stage SDL2 paths explicitly (incl. the two new test files), never `git add -A`; do NOT remove the boot sound render; do NOT touch kernel/host/src/webgl; do NOT add KISSFFT/asyncify."*
