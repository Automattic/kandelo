# SDL2 GLSL playground handoff #6 — Phases 1–4 + four browser fixes COMMITTED & PUSHED; gate run; ABI script bug fixed

Sixth handoff in the chain (after `…-handoff-1.md` … `…-handoff-5.md`). Branch still `explore-dri-sdl2`. **This session committed and pushed everything that was uncommitted at handoff-5**, after running the full CLAUDE.md gate. Handoffs 1–5 are historical; this one is authoritative.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`. **New tip pushed: `b9bc545d4`** (was `3453ab5f9` Phase 0). PR #709 now shows Phase 0 + this commit.
2. **Single commit `b9bc545d4`** — `demo(sdl2): GLSL shader playground — editor + live render, 1920×1080/font/pointer fixes`. 20 files, +7136/−201. Bundles **Phases 1–4 + the four handoff-5 browser-verified fixes + one infra fix** to `check-abi-version.sh`. The user chose a **single commit** (the handoff-5 "4 Phase commits + a 5th" split was *not* reconstructable — the working tree was one cumulative snapshot; `main.c`/`renderer.c`/`editor.c` were already at final state, so manufacturing phase commits would have been fabricated history). The user also chose **not** to commit any planning docs.
3. **Full CLAUDE.md gate was run this session** (see §Gate). 5 of 6 suites fully green. Vitest had **4 failures, all environmental & unrelated** (3× mariadbd InnoDB-boot timeouts in `exec-brk-base.test.ts`, 1× cowsay npm-install in spidermonkey) — every SDL2/DRI/input test passes.
4. **No `ABI_VERSION` bump in this commit** — the SDL2 work is user-space C + host TS + `kms-registry.ts`. (The branch already sits at `ABI_VERSION = 16` vs origin/main's 15, from the *earlier committed* DRI/ALSA/evdev work — that bump is not this session's.)
5. **Phase 5 still not started.** That is the obvious next task. Audio + FFT + `iAudio` uniform. The user's Fractal-Land image+sound request is Phase 7; Phases 5+6 gate it.

## What got committed (the 20 files in `b9bc545d4`)

Identical to the handoff-5 "Files changed this session" table, plus one infra fix. Staged explicitly (NOT `git add -A`, which would have swept ~60 unrelated DRI planning docs + build cruft):

| Path | Role |
|---|---|
| `programs/sdl2/main.c` (M) | ~370-LOC orchestration; SDL_KEYDOWN→editor via US-QWERTY evdev map; 250ms debounced recompile; `display=WxH` diag |
| `programs/sdl2/editor.{c,h}` (A) | gap-buffer editor; `EDITOR_TOP_PAD=8` in layout/render/hit-test |
| `programs/sdl2/renderer.{c,h}` (A) | GL facade + Inconsolata atlas (28px, 256×240, 1× oversample, stride 34); `renderer drawable=` diag; `STB_TRUETYPE_IMPLEMENTATION` lives here |
| `programs/sdl2/presets/image/plasma.frag` (A) | only preset so far (audio_bars.frag is Phase 5, not yet created) |
| `programs/sdl2/third_party/` (A) | `stb_truetype.h` v1.26, `Inconsolata-Regular.ttf` (SIL OFL), `NOTICE.md`. `inconsolata_ttf.h` is **git-ignored** (build-generated) |
| `host/src/dri/kms-registry.ts` (M) | connector mode → 1920×1080@60 CTA-861 |
| `web-libs/kandelo-session/src/kernel-host.ts` (M) | `sendPointerAbs` peg-and-move + `injectInputEvent` on `KernelLike` |
| `apps/browser-demos/pages/kandelo/panes/Modeset.tsx` (M) | `imageRendering:auto`; `sendAbs` evdev routing on enter/move/down/up |
| `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (M) | `BrowserInputSource(window,{pointer:false})` + ABS dims 1920×1080 |
| `host/src/input/browser-input-source.ts` (M) | `{pointer?:boolean}` keyboard-only option (browser-only, additive) |
| `libc/glue/libglesv2_stub.c` (M) | `glPixelStorei`, `glDeleteBuffers`, real `glTexImage2D` pixel upload |
| `scripts/build-programs.sh` (M) | sdl2 block regenerates `inconsolata_ttf.h` from TTF |
| `host/test/sdl2.test.ts` (M), `apps/browser-demos/test/kandelo-sdl2.spec.ts` (M) | Phase 4 gates |
| `.gitignore` (M) | ignores `programs/sdl2/third_party/inconsolata_ttf.h` |
| `scripts/check-abi-version.sh` (M) | **the infra fix — see below** |

## The one non-obvious thing this session: `check-abi-version.sh` SIGPIPE bug

**Symptom:** gate step 5 (`bash scripts/check-abi-version.sh`) failed with "ABI snapshot changed in a backward-incompatible way but ABI_VERSION was not bumped" — listing removed `WpkDrm*`/`Gl*` marshalled structs + changed syscall 72. **This was a false alarm.** The ABI was correct the whole time: snapshot in sync with sources, `ABI_VERSION` already bumped 15→16 on the branch.

**Root cause:** the `version_bumped` detection at the (old) lines 89–92 was:
```bash
if git diff "$base_ref" -- crates/shared/src/lib.rs | grep -qE '^\+pub const ABI_VERSION: u32 = ' ; then
```
The lib.rs↔origin/main diff is **36 KB**. `grep -q` matches the `ABI_VERSION` line near the top and exits, closing the pipe; `git diff` is still writing → gets **SIGPIPE → exit 141**; `set -o pipefail` propagates 141 as the pipeline status → the `if` is false → `version_bumped=0` → the script wrongly demands a bump. It's timing/buffer-dependent (only triggers once the diff exceeds the pipe buffer), so it presents as flaky. Plain `git diff` exits 0; the bug is purely the pipe race.

**Fix (committed):** process substitution so `grep` is the only command whose status the `if` evaluates:
```bash
if grep -qE '^\+pub const ABI_VERSION: u32 = ' \
    < <(git diff "$base_ref" -- crates/shared/src/lib.rs) ; then
```
Semantics unchanged; check now exits 0. This also hardens CI (`prepare-merge.yml` runs the same script). Only that one pipe-to-`grep -q` site had the pattern (the snapshot-diff check uses `git diff --quiet`, which is fine).

## Gate results (this session)

| # | Suite | Result |
|---|---|---|
| 1 | `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ 1080 passed, 0 failed |
| 2 | `cd host && npx vitest run` (in dev-shell) | ⚠️ 882 passed, **4 failed**, 15 skipped — see below |
| 3 | `scripts/run-libc-tests.sh` | ✅ 0 unexpected FAIL (XFAIL + 1 FLAKE-PASS only) |
| 4 | `scripts/run-posix-tests.sh` | ✅ 0 FAIL (XFAIL/SKIP only) |
| 5 | `bash scripts/check-abi-version.sh` | ✅ exit 0 (after the fix above) |
| 6 | browser demo | ✅ user-verified at handoff-5 |

**The 4 vitest failures are environmental and pre-existing, NOT regressions:**
- `host/test/exec-brk-base.test.ts` ×3 — mariadbd InnoDB bootstrap **timeouts** (25s each). Boots `NodeKernelHost` + `binary-resolver` + the mariadb binary; imports none of the changed modules. Slow/missing-binary environment issue.
- `packages/registry/spidermonkey/test/spidermonkey-node-compat.test.ts` ×1 — installs **cowsay via npm** (needs network). Imports nothing SDL2/DRI/input.

**IMPORTANT gotcha for re-running the gate:** run vitest **inside the dev-shell** (`PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash -c 'cd host && npx vitest run'`). Outside it, `fork-dlopen-replay-e2e.test.ts` *also* fails because `execSync(${CLANG} …)` can't find the wasm clang toolchain — a 5th spurious failure that disappears in the dev-shell.

## Build / run / verify (unchanged from handoff-5)

```bash
# Rebuild wasm after any programs/sdl2/*.c edit:
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh
# Scoped vitest gate (fast):
cd host && npx vitest run sdl2     # 4/4 green; cd .. afterward
# Live demo (NOT ./run.sh browser — its prepare step source-builds OpenSSL; the binaries-abi-v16 release 404s):
cd apps/browser-demos && npx vite  # http://127.0.0.1:5401/?demo=sdl2
```
Verify in `sdl2` stdout: `display=1920x1080`, `renderer drawable=1920x1080`, no `headless GL?` WARNs (those = Chrome GPU off → check `chrome://gpu`, NOT the code). **Do NOT** `caches.delete(...)` (breaks the COI service worker; vite serves fresh).

## Open items / next steps

1. **Phase 5 — audio + FFT + `iAudio`** (the gate to the user's Fractal-Land request). Plan: chip synth → ALSA → 128 log-bins → `GL_LUMINANCE` 1D texture → a new `presets/image/audio_bars.frag`. The SDL audio device + polling pump are already alive (Phase 4 silenced `audio_cb` to `memset` 0 specifically to leave the hook in place). Reference plan: `docs/plans/2026-06-22-dri-alsa-plan.md`.
2. **Phase 6** — close the loop so shaders can *drive* sound (sound shaders).
3. **Phase 7** — author Fractal-Land-style image+sound as the boot default. This is what the user actually asked for at handoff-4 item 5.
4. **`sendPointerAbs` pegs on every move** (3 evdev frames/event). Harmless today; if `iMouse` jitter appears, switch to delta-tracking with a peg only on canvas re-entry.
5. The `check-abi-version.sh` fix is general — consider whether the upstream/main branch wants it cherry-picked (it currently rides in this SDL2 commit).

## Things NOT to do (carried from handoff-5, still true)

- **Do NOT switch the pointer back to `EV_ABS`** — SDL classifies event1 as relative (REL_X+REL_Y advertised) and ignores ABS. Keep peg-and-move.
- **Do NOT change the kernel's event1 capabilities** to drop REL — `modeset.c`/fbDOOM rely on relative + pointer-lock.
- **Do NOT revert `imageRendering:"auto"`** or go back to `stbtt_BakeFontBitmap`, and **do NOT push the atlas past 65499 bytes** (OP_TEX_IMAGE_2D cap).
- **Do NOT diagnose black-canvas + "headless GL?" as a code bug** — check `chrome://gpu` first.
- **Do NOT touch** `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files unless Phase 5 genuinely requires it (and then mind the ABI rules + dual-host parity).
- **Do NOT `git add -A`** — the tree has ~60 unrelated DRI planning docs + openssl/mariadb build artifacts + dirty submodules (`libc/musl`, `tests/sortix/os-test`). Stage SDL2 paths explicitly.

## Standing instruction for next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-18-sdl2-glsl-playground-handoff-6.md` first — it is authoritative (handoffs 1–5 are historical). Branch `explore-dri-sdl2`, tip `b9bc545d4` pushed to PR #709: the SDL2 GLSL playground (Phases 1–4 + the four browser-verified fixes — KMS 1920×1080, 28px Inconsolata atlas, evdev relative peg-and-move pointer, EDITOR_TOP_PAD) is now COMMITTED, plus a SIGPIPE/pipefail fix to scripts/check-abi-version.sh. Full CLAUDE.md gate was run: cargo 1080/0, libc-test 0-unexpected-FAIL, POSIX 0-FAIL, ABI exit 0 (ABI_VERSION already 16, no bump needed), browser-verified; vitest has 4 KNOWN-environmental failures only (3× mariadbd InnoDB-boot timeouts in exec-brk-base, 1× cowsay npm-install in spidermonkey) — run vitest INSIDE scripts/dev-shell.sh or fork-dlopen-replay also spuriously fails on missing CLANG. Rebuild wasm with PATH=\"/nix/var/nix/profiles/default/bin:$PATH\" scripts/dev-shell.sh bash scripts/build-programs.sh; run the demo via cd apps/browser-demos && npx vite at http://127.0.0.1:5401/?demo=sdl2 (NOT ./run.sh browser; never caches.delete; black canvas = Chrome GPU off, check chrome://gpu). KEEP the peg-and-move relative pointer (do NOT revert to EV_ABS), do NOT touch host/src/kernel.ts or host/src/webgl/, do NOT git add -A. NEXT: start Phase 5 — audio + FFT + iAudio uniform (chip synth → ALSA → 128 log-bins → GL_LUMINANCE 1D texture → a new presets/image/audio_bars.frag; the SDL audio device + polling pump are already alive, audio_cb just memsets 0). Phases 5+6 gate the Phase 7 Fractal-Land image+sound demo the user actually wants. See docs/plans/2026-06-22-dri-alsa-plan.md. Commit only when the user authorizes."*
