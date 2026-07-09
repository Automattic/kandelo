# SDL2 GLSL playground handoff #1 — Phase 1 attempt went wrong; user wants Phase 1 redefined before any more code lands

First handoff after `2026-06-17-sdl2-browser-rendering-handoff-7.md`. Branch still `explore-dri-sdl2`, tip still `4f88111bb`. PR #709 untouched. **Nothing committed this session.** Working tree was modified and then fully reverted; final state is byte-identical (modulo wasm rebuild timestamp) to where handoff-7 left it.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`, tip `4f88111bb`. Working tree state is back to handoff-7 (same four hunks: `live-setup.ts` modified comment, `host/test/sdl2.test.ts` staged-added, `programs/sdl2/main.c` staged-added, `apps/browser-demos/test/kandelo-sdl2.spec.ts` untracked-new).
2. **Phase 1 of `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` was implemented exactly per the written spec and the user rejected the result.** The plan says: "Drop the 5 s timeout. Keep ESC. Replace the spinning quad with two `glClear` colors: gray on the left half, black on the right half, driven by `glViewport` + `glScissor`. Resize window default to 1280×720; query SDL for the kandelo canvas size at runtime and clamp." I implemented all three bullets. Vitest 1/1 green. Playwright 1/1 green in 5.7 s. The user's reaction: ***"THE PHASE ONE IS HAVING THE RECTANGLE SPIN WITH THE 5 SECONDS SOUNDS! STOP WITH THAT AND ASK ME FOR THE NEXT STEPS INSTEAD OF JUST DIG DEEPER IN THE PLAN!"***
3. **The plan-as-written and the user's actual intent for Phase 1 disagree.** I do not know what Phase 1 should actually be. **Ask. Do not guess. Do not re-read the written plan and execute it again.**
4. **Two distinct things hit the user at once when they previewed my Phase 1 build in `./run.sh browser`:**
   - **Visual:** "two rectangles, one is gray and one is black" — exactly what the plan said to render. The user reacted as if it were a regression, even though Phase 1's stated visual *is* two flat rectangles. Read this as: the plan's Phase 1 visual is not what the user actually wants for Phase 1, OR the user expected Phase 1 to be additive over the rotating quad (split layout + still-spinning quad on the right), not a wholesale replacement of the quad.
   - **Audio:** "Now the sound doesn't stop." This is a concrete UX bug in the no-timeout main loop. ESC is the only exit path, and in the live browser session ESC does not reliably reach SDL2's evdev. The Playwright spec passes because it explicitly calls `page.keyboard.press("Escape")`. In interactive use the user has no easy quit, and the 440 Hz tone runs forever. **Removing the 5 s timeout without first solving ESC routing in the live session is a regression that the test gates can't catch.**
5. **Everything I did was reverted before stopping.** `git checkout -- programs/sdl2/main.c host/test/sdl2.test.ts` restored the staged-added files from the index. The one-comment edit in `live-setup.ts` was reversed with an inverse `Edit`. The untracked spec `kandelo-sdl2.spec.ts` was re-Written from the original content captured earlier in the session. `scripts/build-programs.sh` was re-run so `local-binaries/programs/wasm32/sdl2.wasm` matches the restored Phase 0 source (~547 KB, 00:01 today).

## What I implemented and then reverted

For the record, in case future-me wants to understand what the user found wrong:

- `programs/sdl2/main.c` — removed the rotating-quad shader pipeline (VERT_SRC/FRAG_SRC + glCreateProgram + glDrawArrays). Added `SDL_GetCurrentDisplayMode`-based clamping of a 1280×720 default. Loop became `while (running)` with no time cap. Two-pass clear: `glEnable(GL_SCISSOR_TEST)`; per-frame `glViewport(0, 0, half, h) + glScissor(...) + glClearColor(0.18, 0.18, 0.20, 1.0) + glClear` for the left pane; then the right half with `glClearColor(0, 0, 0, 1)`. Kept the 440 Hz audio callback unchanged. Kept `SDL_PumpAudioDevices` per-frame. Exit message hardcoded to `exit=esc` (no other exit path remains).
- `host/test/sdl2.test.ts` — dropped the "5 s timeout exit" `it.skipIf`; kept only the ESC-injection case. Updated `setInputCanvasDims` to 1280×720.
- `apps/browser-demos/test/kandelo-sdl2.spec.ts` — dropped the spread gate (`Math.max(...sizes) - Math.min(...sizes) > 400`) because Phase 1's static flat-clear renders identical PNGs across frames. Replaced the per-frame byteLength loop with one screenshot + a pixel-sample assertion: `canvas.evaluate` opens an OffscreenCanvas, draws the live canvas, then `getImageData` at `(w/4, h/2)` and `(3w/4, h/2)` to assert the left half is at least 30 lum brighter than the right. Then `page.keyboard.press("Escape")` triggers the quit; assertions remain `/sdl2 exited/` syslog and `exit=esc` terminal text.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` — single-comment update describing Phase 1's "runs until ESC, no self-timeout" behavior. Pure doc change.

All of these together pass tests in headless. They fail the user's actual product-acceptance bar.

## Why the tests passed but the live session broke

The Playwright spec sends Escape through `page.keyboard.press("Escape")`. That dispatches a `KeyboardEvent` on the active frame, which the `BrowserInputSource` (bound to `window`) sees in its `keydown` handler, which `e.preventDefault()`s and emits an evdev `EV_KEY KEY_ESC` to the kernel — SDL2 picks it up, the loop exits, `runShellCommand` returns, the `finally` in `live-setup.ts` calls `audioDriver.stop(0)`, and the test moves on.

In a live interactive session, the user clicking on the demo UI puts focus on a React-controlled element (a pane, a button, the syslog list). When they then press Escape, the event probably still bubbles to `window` (React event delegation lives on the React root, not on `window`), but I did not verify this, and I did not verify whether anything in the React tree calls `stopPropagation` on Escape before `BrowserInputSource` sees it. The symptom — "sound doesn't stop" — is consistent with ESC never reaching SDL_evdev.

If the next session wants to keep the no-timeout direction at any point, **diagnosing why Escape does or doesn't reach BrowserInputSource in the live demo is the first thing**, not the last. The Playwright test as written is not a load-bearing gate for that path because it bypasses whatever React focus state interactive use sits in.

## Things NOT to do next session

- **Do NOT re-read `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` and start executing Phase 1 again.** That is what got the previous session yelled at. The user has explicitly said the written Phase 1 is wrong. The correct first move is to ASK them what Phase 1 should be.
- **Do NOT drop the 5 s timeout until ESC routing in the live browser session is verified.** The Playwright spec is not sufficient — it bypasses the failure mode by sending the key event directly from Playwright's keyboard API.
- **Do NOT touch `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, `crates/kernel/src/wasm_api.rs`, or the kernel audio/SAB files** unless a freshly-confirmed-with-the-user step explicitly demands it. Handoff-7's standing warning on these still holds.
- **Do NOT interpret "two rectangles" as a rendering bug.** That visual is what Phase 1 as written specifies. The complaint is about *what was specified*, not about how I implemented it. Argue with the spec, not the renderer.
- **Do NOT update or "improve" `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md` from your own reading.** The user wrote (or commissioned) that plan. If the plan needs revision, it needs revision from the user's words, not from yours.
- All "Things NOT to do" rolled forward from handoffs 5/6/7 still apply: the `DRM_IOCTL_MODE_ADDFB` hunk stays, the two `host/src/kernel.ts` visual fixes from handoff-7 stay, the Phase 0 rotating-quad / 5 s tone / ESC demo at `programs/sdl2/main.c` stays.

## Working tree at session end

Per `git status --short`, identical to handoff-7's end-of-session state:

```
 M apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts   (unchanged from handoff-7)
A  host/test/sdl2.test.ts                                       (unchanged from handoff-7)
A  programs/sdl2/main.c                                         (unchanged from handoff-7)
?? apps/browser-demos/test/kandelo-sdl2.spec.ts                 (unchanged from handoff-7)
... + all the other handoff-7 hunks across kernel, host, sysroot
```

Plus this new handoff doc:

```
?? docs/plans/2026-06-18-sdl2-glsl-playground-handoff-1.md
```

`local-binaries/programs/wasm32/sdl2.wasm` was rebuilt this session at 00:01 (today's date, 2026-06-18) from the restored Phase 0 source. Functionally equivalent to the 22:39 binary handoff-7 left.

No probe pollution. `grep -rn "GL-PROBE\|GL-BRIDGE\|_probe\|debug_log" host/src/ crates/kernel/src/` returns nothing.

## Open items rolled forward from handoff-7 (still open)

- **§A — mmap-status broader fix.** Not touched.
- **§B — SDL2 patch pristine verification.** Not touched.
- **§C — Spidermonkey cowsay vitest.** Not touched.
- **§E — Working tree state for commit.** Still untouched; same hunks ready to commit when the user signs off on a coherent story for the PR body.

## The thing the next session has to figure out before any code lands

**What does the user actually mean by Phase 1?**

The literal plan text says drop-timeout + flat-clear-split. The user rejected this. Possibilities I can construct after the fact (any of which would be consistent with their reaction, none of which I can confirm without asking):

1. **Phase 1 keeps the rotating quad and the 5 s timeout; only the window resizing to 1280×720 lands.** The "split-pane" parts are postponed to a later phase.
2. **Phase 1 keeps the rotating quad but puts it on the right half of a split layout, with the left half cleared to gray; the 5 s timeout stays.** The visual is "rotating quad in the right pane" + "blank left pane".
3. **Phase 1 is something else entirely** — the user has a mental model of "rectangle that spins with audio for 5 s in a split layout" that doesn't fit any reading of the written plan.
4. **The plan itself needs to be rewritten** before any phase lands — the next session's first deliverable is a redrafted Phase 1 description that the user signs off on.

**Pick none. Ask.**

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-18-sdl2-glsl-playground-handoff-1.md` first. The previous session attempted Phase 1 of the GLSL playground plan EXACTLY as written (`docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`) and the user explicitly rejected the result — Phase 1 per the user keeps the rotating quad + 5 s sound, which contradicts the written plan. DO NOT touch any code yet. DO NOT re-read the written plan and re-execute it. ASK the user what Phase 1 should actually be before writing anything. Branch `explore-dri-sdl2`, tip `4f88111bb` (NOT pushed, PR #709 untouched). Working tree is back at handoff-7's state, all attempted Phase 1 edits reverted. `local-binaries/programs/wasm32/sdl2.wasm` rebuilt at 00:01 today from the restored Phase 0 source. Vite dev server on 5403; canonical kernel at `local-binaries/kernel.wasm`. Auto-mode default; bias to action only AFTER the user has clarified what Phase 1 is. DO NOT touch `host/src/kernel.ts`, `host/src/webgl/`, `crates/kernel/src/syscalls.rs`, or the kernel audio/SAB files. If asked to drop the 5 s timeout, first diagnose why Escape in a live browser session does not reach BrowserInputSource → SDL_evdev — the Playwright test is not a sufficient gate for that path."*
