# SDL2 GLSL playground handoff #3 — Phase 3 implemented green, Phase 1+2+3 still uncommitted

Third handoff in the chain (after `2026-06-18-sdl2-glsl-playground-handoff-1.md` and `…-handoff-2.md`). Branch still `explore-dri-sdl2`. **Tip is still `3453ab5f9` (Phase 0)** — Phase 1, Phase 2, and now Phase 3 are all implemented in the working tree and pass both test suites, but none are committed yet. The user has continued to authorise "no commit yet, continue".

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`. **Tip pushed: `3453ab5f9`** — same as handoff-2 endpoint. Nothing new has been committed or pushed. PR #709 still shows only the Phase 0 diff.
2. **Phase 3 is implemented + green + UNCOMMITTED on top of Phase 1+2.** Shader source now resolves through a three-step chain (`/home/shaders/image/current.frag` → `/usr/share/shaders/image/plasma.frag` → built-in `PLASMA_SRC` fallback), F5 force-recompiles the user file in place, and a translucent red strip at the bottom of the right pane lights up whenever the last reload had a real compile failure. Last good program keeps running across a failed reload. Vitest 1/1 green; Playwright 1/1 green.
3. **Five working-tree files post-Phase-0-commit (one new):**
   - **NEW** `programs/sdl2/presets/image/plasma.frag` — the canonical preset `mainImage` body. Kept in sync with the built-in `PLASMA_SRC` in `main.c`; both must stay identical.
   - `programs/sdl2/main.c` — Phase 1+2+3 source.
   - `host/test/sdl2.test.ts` — re-tagged Phase 3; F5 injection before ESC; asserts `sdl2: shader-source=builtin-plasma` + `WARN: F5: …not readable` lines.
   - `apps/browser-demos/test/kandelo-sdl2.spec.ts` — re-tagged Phase 3; same PNG-byteLength variance gate (do NOT switch to pixel sampling — see handoff-2 §A).
   - `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` — adds `?raw` import of `programs/sdl2/presets/image/plasma.frag` and stages it at `/usr/share/shaders/image/plasma.frag` in the VFS before launching the binary; also `mkdir -p /home/shaders/image` so the user can drop a `current.frag` via the terminal.
   - Also: `local-binaries/programs/wasm32/sdl2.wasm` rebuilt at 11:05 today to ~554 KB; `apps/browser-demos/test-results/` still has Playwright failure artifacts from handoff-2's debug iterations (junk; safe to delete).
4. **User said "no commit, Phase 3" between Phase 2 and Phase 3, same posture stands at end of session 3.** Suggested split when authorised is now THREE commits, each on top of `3453ab5f9`:
   - `demo(sdl2): Phase 1 — viewport-split skeleton, no self-timeout, 1280×720 clamp`
   - `demo(sdl2): Phase 2 — plasma mainImage + GLSL ES 1.0 wrapper + shader stash`
   - `demo(sdl2): Phase 3 — VFS shader-source chain + F5 reload + red error strip + last-good retention`

## What landed this session (Phase 3, all working-tree only)

### `programs/sdl2/presets/image/plasma.frag` (NEW)

The `mainImage` body the plan calls for ("Author `presets/image/plasma.frag`"). 7 lines of GLSL, no `#version` header (the wrapper provides that). Comments at the top note that it's kept in sync with `PLASMA_SRC` in `main.c`. The duplication is intentional: the binary still needs a working shader when the test harness (vitest under `NodeKernelHost`) doesn't stage any VFS shader files. See §A.

### `programs/sdl2/main.c` (Phase 3 changes on top of Phase 2)

- **New constants:** `USER_CURRENT_PATH = "/home/shaders/image/current.frag"` and `PRESET_PLASMA_PATH = "/usr/share/shaders/image/plasma.frag"`.
- **New helpers:**
  - `read_text_file(path)` — `fopen`/`fseek`/`fread` slurp into a malloc'd null-terminated buffer. Returns NULL on any failure (treated by caller as "absent"). Caps at 1 MiB so a runaway pipe at `/home/shaders/image/current.frag` can't OOM the binary.
  - `load_initial_shader_source()` — walks the chain, prints `sdl2: shader-source=<path|builtin-plasma>` to stdout so tests can confirm which leg fired, returns a malloc'd buffer.
  - `rebind_uniforms()` — re-runs `glGetUniformLocation` for all six user uniforms. Called after every successful program swap.
  - `reload_user_shader()` — F5 path. Reads `USER_CURRENT_PATH` (only that — NOT the preset; see §C). On read failure or `real_failure`: stashes log, sets `g_error_visible = 1`, returns without touching `g_user_prog`. On success: deletes the old program, swaps, calls `rebind_uniforms`, clears `g_error_visible`. Always emits a `WARN:` line on either outcome so the vitest / log gates have something to match on.
- **Modified helpers:**
  - `compile_shader(type, src, tag, int *real_failure_out)` and `link_user_program(user_src, int *real_failure_out)` now take an out-param. They OR `1` into `*real_failure_out` only when `status == 0` AND `loglen > 0` (i.e. there's actual info-log content). The empty-info-log case (status==0, loglen==0) is the headless-GL stub in NodeKernelHost — it still emits a `WARN: …compile: (empty info log; headless GL?)` line but does NOT raise `real_failure`, so the vitest path can still treat its compile as a no-op success. See §B.
- **New state globals:**
  - `g_user_prog` — the current good user program. Replaced atomically on a successful reload; on a failed reload the previous handle stays here so "last good shader keeps running" is just "we never unbound it".
  - `u_iResolution`, `u_iViewportOrigin`, `u_iTime`, `u_iTimeDelta`, `u_iMouse`, `u_iFrame` — promoted from main-local to file-scope so `rebind_uniforms()` can refresh them.
  - `g_error_visible` — drives the red strip.
- **Main loop additions:**
  - `SDL_KEYDOWN && sym == SDLK_F5` → `reload_user_shader()`.
  - After the user-shader draw, if `g_error_visible`, switch to the strip program + VBO, `glEnable(GL_BLEND)` with `GL_SRC_ALPHA / GL_ONE_MINUS_SRC_ALPHA`, `glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)`, `glDisable(GL_BLEND)`.
- **Error-strip program** (small dedicated GLES2 shader pair):
  - Vertex: `attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0, 1); }`
  - Fragment: `#version 100\nprecision mediump float; void main() { gl_FragColor = vec4(1.0, 0.1, 0.1, 0.55); }`
  - VBO: 4 NDC verts forming a strip at `y ∈ [-1.0, -0.92]` — bottom 4% of the right viewport, clipped further by the right-pane scissor.
  - Compiled once at startup, kept alongside `strip_prog`/`strip_vbo` locals in `main()`.
- **Cleanup path:** added `glDeleteProgram(strip_prog)` alongside the existing user-program delete.

### `host/test/sdl2.test.ts`

- Re-tagged `describe("SDL2 playground — VFS shader load + F5 reload (Phase 3)", …)`.
- Comment header rewritten to document the three Phase-3 assertions and to confirm the `NodeKernelHost` rootfs has no shader files staged.
- Added `KEY_F5 = 63` constant (linux/input-event-codes.h).
- Test body now injects an F5 keydown + release **before** the ESC keydown + release, with a 100ms gap so the main loop dispatches the F5 to `reload_user_shader` and emits its `WARN:` line before the ESC quits the loop.
- New assertions on top of the Phase 2 set:
  - `stdout.value` contains `sdl2: shader-source=builtin-plasma` — proves the chain fell through (correct under NodeKernelHost which has none of the VFS shader paths staged).
  - `stderr.value` matches `/WARN: F5: \/home\/shaders\/image\/current\.frag not readable/` — proves the F5 path ran and the read-failure branch was hit.
- Existing assertions still in place: `sdl2: SDL_Init OK`, `sdl2: OK frames=… exit=esc`, no `FAIL:`, `frames > 0`.

### `apps/browser-demos/test/kandelo-sdl2.spec.ts`

- Re-tagged `test("Kandelo sdl2 demo (Phase 3: VFS preset → plasma right pane, ESC-quits)", …)`.
- Otherwise unchanged from Phase 2: same PNG-byteLength variance gate (6 captures over 3 s, `min > 3500`, `spread > 400`), same `body.click + keyboard.press("Escape")` ESC routing.
- **F5 not exercised from Playwright on purpose** — `page.keyboard.press("F5")` might be intercepted by Playwright's own page-refresh handling (untested), and the F5 path is already covered by vitest. If you need a Playwright F5 gate later, dispatch through `page.evaluate` to bypass Playwright's keyboard semantics rather than `keyboard.press`.

### `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`

- New import at the top of the URL-import block:
  ```ts
  import sdl2PlasmaFragSrc from "../../../../../programs/sdl2/presets/image/plasma.frag?raw";
  ```
  Vite's `?raw` loader pulls the .frag file as a string. The relative path is the same depth as the existing `local-binaries`/`binaries` imports.
- Inside the `profile.sdl2Demo` block, after `writeVfsBinary(/usr/local/bin/sdl2, …)` and before `attachInputSource`, three new calls:
  ```ts
  tick("staging shader preset...");
  ensureDirRecursive(kernelForSdl2.fs, "/usr/share/shaders/image");
  ensureDirRecursive(kernelForSdl2.fs, "/home/shaders/image");
  writeVfsFile(
    kernelForSdl2.fs,
    "/usr/share/shaders/image/plasma.frag",
    sdl2PlasmaFragSrc,
  );
  ```
  This makes the browser path exercise the second leg of the chain (preset → success), and pre-creates `/home/shaders/image/` so the user can drop a `current.frag` via terminal without first having to mkdir.

## §A — Why PLASMA_SRC is still hardcoded in main.c (built-in fallback)

The plan reads "Author `presets/image/plasma.frag` (the shader Phase 2 had hardcoded)", which is easy to read as "now delete the hardcoded one". **Don't.**

The vitest test (`host/test/sdl2.test.ts`) runs the binary under `NodeKernelHost` with the default rootfs image (`host/wasm/rootfs.vfs` or the resolver-managed `programs/rootfs.vfs`). Neither contains `/home/shaders/image/current.frag` nor `/usr/share/shaders/image/plasma.frag`. The vitest harness has no path that calls `writeVfsFile` on the rootfs.

If the binary had no built-in fallback, vitest would have to either:
- Stage the preset into the rootfs at boot (invasive — requires building a fresh VFS image or extending `NodeKernelHost` with a VFS-overlay API), OR
- Inject a small `writeVfsFile` after spawn (currently there's no exposed `host.fs.writeFile` on `NodeKernelHost` — the public API is `spawn`/`injectInputEvent`/`destroy`).

Keeping `PLASMA_SRC` as the third leg of the chain costs ~10 lines of C and means the binary is self-contained for any test harness. The `sdl2: shader-source=builtin-plasma` stdout line is the gate that confirms the fallback fired — if a future change accidentally drops the fallback, the vitest assertion will catch it immediately.

The duplication between `programs/sdl2/presets/image/plasma.frag` and `PLASMA_SRC` in `main.c` is annoying but small. A future cleanup could embed the preset at build time via a generated header (`xxd -i` or similar) — but that adds build-script complexity. For now the comment at the top of each file calls out the sync requirement, and the body is small enough that drift is unlikely.

## §B — Why `real_failure_out` distinguishes headless-stub from real compile errors

Phase 2 §C documented that under `NodeKernelHost`, `host_gl_query` returns -1, so every `glGetShaderiv(…, GL_COMPILE_STATUS, …)` reports `status == 0` with an empty info log. Phase 2 worked around this by treating all `status == 0` cases as non-fatal `WARN:` and never bailing.

Phase 3 introduces the red error strip, which must NOT light up in vitest (the binary never actually compiles a real shader because there's no GL context). The cleanest discriminator is the info-log length:

- `status == 0` AND `loglen > 0` → real compile/link error (the GL driver wrote something useful into the info log). Set `*real_failure_out = 1`, emit `WARN:` with the actual log text.
- `status == 0` AND `loglen == 0` → headless-stub failure (no GL context to compile against). Do NOT touch `*real_failure_out`. Emit `WARN: …(empty info log; headless GL?)`.

This means:
- **Node vitest:** Every shader "fails" status-wise but with empty info log. No `real_failure`. `g_error_visible` never goes up unless F5 hit the read-failure branch (which it always does, since `current.frag` isn't staged).
- **Real browser:** Real GL context, shaders compile. No `status == 0` at all. No `real_failure`.
- **Real browser with intentionally malformed `current.frag`:** Real GL context produces a real `INFO_LOG` with line/col info. `real_failure = 1`. Strip lights up. Last good shader keeps running.

If you "simplify" `compile_shader`/`link_user_program` back to a single boolean status return, you'll lose the headless-vs-real distinction and either (a) the strip will light up in vitest, breaking the test, or (b) you'll have to plumb a different distinguisher through. Easier to leave the out-param threading in place.

## §C — Why F5 does NOT fall back through the preset chain

Plan: "F5: re-read `current.frag` and recompile." — that's it, no chain.

`reload_user_shader()` reads ONLY `USER_CURRENT_PATH`. If that file is missing, the function stashes a `F5: <path> not readable` message into `g_last_error`, raises `g_error_visible`, and returns. It does NOT fall back to the preset or the built-in.

Rationale: F5 is "the user just edited the file they own; load that". Falling back would mask the case where the user accidentally `rm`'d `current.frag` — they'd see an unchanged image and think F5 was no-op'd, when in fact the file is gone. The red strip + log message makes the failure visible.

The preset fallback is **only** for first boot (the chain in `load_initial_shader_source()`). After first boot, F5 is the explicit "load what's at this path" lever.

If a future phase adds an editor (Phase 4), the editor will keep its in-memory buffer separate from the file, and the editor's auto-save on Ctrl+S writes `current.frag`. F5 staying file-only means F5 always reflects on-disk state, even if the editor has unsaved buffer changes.

## §D — The Playwright F5 gap

Phase 3 vitest exercises the F5 read-failure path explicitly (`WARN: F5: …not readable`). Playwright does NOT exercise F5 at all.

Reasons to leave it as-is:
- `page.keyboard.press("F5")` in Playwright may or may not be intercepted by Chromium's own page-refresh handler depending on focus state. Untested. The most likely failure mode is a page refresh that reloads the demo from scratch, which would still pass the existing byteLength gate but wouldn't actually exercise the SDL F5 path.
- The Playwright gate's job is to confirm visual output (plasma animating, byteLength varying); F5 success-vs-failure isn't a visual-output question.

If you want a Playwright F5 gate later, do it via `page.evaluate`:
```ts
await page.evaluate(() => {
  // Dispatch directly to window so BrowserInputSource → SDL_evdev picks it up,
  // bypassing Playwright's keyboard semantics.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", code: "F24" /* avoid Chromium's F5 handler */ }));
});
```
…though that's likely to surface its own bugs in `BrowserInputSource`'s key-name mapping. Don't bother unless you have a specific reason.

## §E — Build environment reminder (still load-bearing)

From handoff-2 §D, unchanged: rebuild via
```bash
PATH="/nix/var/nix/profiles/default/bin:$PATH" scripts/dev-shell.sh bash scripts/build-programs.sh
```
This session's rebuild produced `local-binaries/programs/wasm32/sdl2.wasm` at 11:05 today, ~554 KB. The `wasm-ld: warning: function signature mismatch: SDL_EVDEV_Init` warning is pre-existing (from the sysroot's SDL build); ignore.

If you skip the dev-shell prefix, the C++ build step (`wasm32posix-c++: command not found`) bails before the SDL2 multi-source block at `build-programs.sh:298-313`, so `sdl2.wasm` silently stays stale. Vitest and Playwright then run against the previous binary and give misleading green/red.

## Working tree at end of session 3

```
$ git status --short    # (just the playground-relevant entries)
 M apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts
 M apps/browser-demos/test/kandelo-sdl2.spec.ts
 M host/test/sdl2.test.ts
 M programs/sdl2/main.c
?? apps/browser-demos/test-results/                  # carryover junk; safe to rm
?? docs/plans/2026-06-18-sdl2-glsl-playground-handoff-2.md  # handoff-2
?? docs/plans/2026-06-18-sdl2-glsl-playground-handoff-3.md  # this doc
?? programs/sdl2/presets/                            # NEW preset dir + plasma.frag
```

`local-binaries/programs/wasm32/sdl2.wasm` is the freshly-rebuilt 554 KB artifact; the symlink-equivalent under `binaries/programs/wasm32/` is what `live-setup.ts` picks up via the local-binaries-overrides-binaries rule.

## Open items

- **Phase 1+2+3 still uncommitted.** User has not authorised a commit. When they do, propose a three-commit split as listed in the TL;DR. Each commit is independently demoable (`./run.sh browser` still boots Kandelo through every intermediate state).
- **Interactive-browser ESC + F5 routing still unverified.** Same caveat carried from handoff-2: Playwright's keyboard dispatch bypasses React focus state. Manual `./run.sh browser` ESC verification still owed; F5 verification newly owed.
- **`apps/browser-demos/test-results/` carryover.** Same junk from handoff-2. Safe to delete.
- **Phase 4 not started.** Next phase per the plan is the editor: `editor.{c,h}` + `renderer.{c,h}` + stb_truetype atlas + gap buffer + cursor + keystroke routing + auto-recompile-on-edit (250 ms debounce) + Ctrl+S to `/home/shaders/image/current.frag`. Plan estimates 5 days. Phase 4 is the first phase that touches the file layout described in the plan ("File layout — `programs/sdl2/`" table) — `main.c` will need to start delegating, and the multi-source build glob in `scripts/build-programs.sh` already accommodates this (line 298-313 globs `programs/sdl2/*.c`).
- **Possible micro-improvement worth considering at Phase 4 time:** embed `presets/image/plasma.frag` into `main.c` at build time via a generated `plasma.frag.inl` header, so `PLASMA_SRC` and the preset file share a single source of truth. Adds a small build-script step. Not blocking for Phase 4.

## Things NOT to do next session

All "Things NOT to do" from handoff-2 still apply, plus:

- **Do NOT delete `PLASMA_SRC` from `main.c` to "match the plan literally".** Read §A first. Vitest depends on the fallback; the `sdl2: shader-source=builtin-plasma` assertion will catch the regression but you'll have wasted a build/test cycle finding out.
- **Do NOT collapse `compile_shader`/`link_user_program`'s `real_failure_out` into a single boolean return.** Read §B first. The empty-info-log distinguisher is what keeps the red strip from triggering in the vitest path.
- **Do NOT make F5 fall back through the preset chain.** Read §C first. F5 deliberately fails loudly when `current.frag` is missing.
- **Do NOT add `page.keyboard.press("F5")` to the Playwright spec.** Read §D first. If you really want a Playwright F5 gate, use `page.evaluate` + `window.dispatchEvent`, and budget time for `BrowserInputSource` key-name mapping bugs.
- **Do NOT touch `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files** for Phase 4. The editor and renderer live entirely in user space; if you find yourself reaching for kernel code, you've taken a wrong turn.
- **Do NOT bump `ABI_VERSION`.** Phase 3 doesn't touch any ABI surface (VFS reads use existing syscalls; the live-setup VFS writes go through `MemoryFileSystem` host-side, not kernel-side).
- **Do NOT commit Phase 1+2+3 without explicit user authorization.** Same posture as handoff-2's "Things NOT to do".

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-18-sdl2-glsl-playground-handoff-3.md` first — it is authoritative; ignore handoffs 1 and 2's `Things NOT to do` only where handoff-3 supersedes them, otherwise their warnings (PNG-byteLength gate, `iViewportOrigin` deviation, WARN-on-status-zero shader stash, dev-shell PATH prefix, no Asyncify, no kernel-side edits) still stand. Branch `explore-dri-sdl2`, tip `3453ab5f9` on both local and origin — Phase 0 commit is PUSHED to PR #709, nothing else committed. Phase 1 (viewport-split skeleton, ESC-only exit, 1280×720 clamp), Phase 2 (hardcoded plasma `mainImage` + `#version 100` Shadertoy template with `iViewportOrigin` + WARN-on-status-zero shader stash), and Phase 3 (three-step shader-source chain `/home/shaders/image/current.frag` → `/usr/share/shaders/image/plasma.frag` → built-in `PLASMA_SRC` fallback, F5 reload of the user file only, `real_failure` flag distinguishing real compile errors from empty-info-log headless stub, translucent red bottom strip when `g_error_visible`, last-good program retained) are implemented in the working tree across `programs/sdl2/main.c`, NEW `programs/sdl2/presets/image/plasma.frag`, `host/test/sdl2.test.ts`, `apps/browser-demos/test/kandelo-sdl2.spec.ts`, and `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (`?raw` import + VFS staging of the preset); vitest 1/1 green and Playwright 1/1 green. `local-binaries/programs/wasm32/sdl2.wasm` rebuilt at 11:05 today via `PATH=\"/nix/var/nix/profiles/default/bin:$PATH\" scripts/dev-shell.sh bash scripts/build-programs.sh`. Nothing committed beyond `3453ab5f9`; ask the user before committing Phase 1+2+3, and when they authorise, split into THREE commits per the doc's `Open items` (Phase 1 / Phase 2 / Phase 3). Next phase is Phase 4 (editor: `editor.{c,h}` + `renderer.{c,h}` + stb_truetype atlas + gap buffer + keystroke routing + 250 ms debounced auto-recompile + Ctrl+S writes `current.frag`); confirm with the user before starting and be aware Phase 4 is the first phase that splits `main.c` out into multiple files per the plan's file-layout table. Auto-mode default; bias to action only after the user has reaffirmed direction. Do NOT touch `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files. Interactive-browser ESC + F5 routing in `./run.sh browser` is still unverified — the Playwright path bypasses React focus and Phase 3 has no Playwright F5 gate at all, so user-facing ESC and F5 may both still hang on a frozen demo even though all test suites pass."*
