# DRI port onto kandelo:main — session 14 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-13.md](./2026-06-09-dri-kandelo-port-handoff-13.md). Read that first.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22` and do **not** push at all this branch-cycle. Wait for user input before each commit.

## TL;DR for next session — read this twice

1. **The wrong-pixels bug is NOT solved.** Session 14 fixed two real bugs in the pointer-input path (placeholder canvas defaults to 300×150 so the CSS-to-FB scaler was off by ~6×; raw `movementX/Y` got chunked to i8 PS/2 packets without splitting, so fast drags wrapped) and modeled the rewrite on the proven-working reference [PR #66 on `mho22/wasm-posix-kernel`](https://github.com/mho22/wasm-posix-kernel/pull/66) — function-for-function. The Playwright spec still passes (4.4s) and DIAG logs confirm mouse packets reach the kernel correctly. **But the user reopened the demo in their real browser and the canvas is STILL not painting Pavel-like fluid splats.** So the input path is now correct AND the visual bug remains. Something deeper is wrong.
2. **Next session's mission (per user, verbatim):** *"analyze the whole code you built for DRI KMS, and also analyze thoroughly Pavel's demo at https://github.com/PavelDoGreat/WebGL-Fluid-Simulation. In its demo it runs a couple of projections when it loads. The user also wrote a working Kandelo DRI/KMS port at https://github.com/mho22/wasm-posix-kernel/pull/66 (a series of 6 to 7 PRs with the whole work in it). Compare Pavel's GitHub repository work with the user's DRI/KMS work with the current branch's DRI/KMS work. And make it work once and for all."*
3. **The diff that landed this session is small and self-contained — see "What I shipped" below.** Everything else from sessions 7–13 is intact.

## What I shipped this session (working tree, uncommitted)

| File | Edit | Status |
|---|---|---|
| `apps/browser-demos/pages/kandelo/panes/Modeset.tsx` | (a) Added `MODESET_FB_W = 1920, MODESET_FB_H = 1080` constants. (b) Pre-set `canvas.width / canvas.height` **before** `attachKmsDisplay` (i.e. before `transferControlToOffscreen()`) so the placeholder HTMLCanvas's `.width/.height` attributes reflect the FB dims — required for the pointer scaler to compute `canvas.width / rect.width` correctly. (c) Rewrote the pointer-event `useEffect` to mirror reference PR #66's `attachAbsoluteMouse` exactly: imports `injectChunkedMouseMotion` + `MouseEventSink` from `@host/framebuffer/browser-controls`; uses `clientX/Y → canvas-coord deltas` (not `movementX/Y`); single Y-flip inside `sendDelta`; chunked PS/2 i8 packets so fast drags don't wrap `(int8_t)pkt[1]`; teleport on `mouseenter` so the wasm cursor estimate snaps to where the OS pointer actually is (mirrors modeset.c's initial `cursor_x/y = CANVAS_W/H / 2`); button bits via `buttonBit` map (0→1, 2→2, 1→4) matching `pkt[0] & 0x07`; `mouseup` listener bound on the **document** so a release outside the canvas still clears button state. | **Keep — proven-pattern, verified packets reach kernel.** |
| `host/src/kernel.ts` | **No diff vs end-of-session-13.** I added DIAG `console.log`s during debugging, then reverted them. Tree is back to handoff-13's state for this file. | n/a |

## Untracked at end of session 14 — delete before commit

- `apps/browser-demos/test/_capture-modeset.spec.ts` — deleted (was the handoff-13 leftover; recreated this session for debugging, then deleted again).
- `/tmp/modeset-capture*.png` — deleted.

## What I verified this session (and how)

I instrumented `host/src/kernel.ts::injectMouseEvent` and the `host_gl_create_context` auto-attach branch with bounded `console.log`s, then hooked `page.on("console")` in a temporary capture spec. **All instrumentation has been reverted from the working tree.** Findings:

1. **Auto-attach fires cleanly.** Log line `[DIAG kernel.ts] host_gl_create_context pid=100 ctxId=1 masterCrtc=1` confirms `this.kms.masterCrtcForPid(pid)` returns 1 (the kernel's only CRTC) when modeset.c's `eglCreateContext` call lands. The Modeset pane has already registered the canvas via `kmsAttachCanvas`, so `getKmsCanvas(1)` returns it.
2. **WebGL2 context creation succeeds with correct drawing-buffer dims.** `getContext webgl2 -> ok dbWxH=1920x1080`. The kernel-side resize (`canvas.width = fb.width` before `getContext("webgl2")`) is doing its job, **and** my Modeset.tsx pre-set ensures the OffscreenCanvas inherited 1920×1080 from the start anyway. Both layers agree.
3. **`canvas.width` on the placeholder is now 1920.** A `page.evaluate` query inside the diag spec confirmed `{ attrW: 1920, attrH: 1080, rectW: 1526, rectH: 858 }`. Pre-session-14 this was `attrW: 300, attrH: 150` because `transferControlToOffscreen()` preserves whatever attribute values are set on the HTMLCanvas at transfer time — and the React `<canvas>` had none.
4. **Pointer events fire on the canvas and reach `kernel_inject_mouse_event` with correct values.** A 60-step drag with mouse-down=left produced:
   - 4 chunked packets on `mouseenter` (teleport: `dx=-128, -128, -128, -97`, buttons=0) — sum = -481, which matches the canvas-coord delta from the wasm cursor center (960) to where the mouse entered.
   - 1 packet on `mousedown` (`dx=0 dy=0 buttons=1`).
   - ~50 packets during the drag, each `dx≈16, dy=-45..+45 sin-curve, buttons=1`. All `dx`/`dy` within `[-128, 127]`. Chunking is working.
   - 1 packet on `mouseup` (`dx=0 dy=0 buttons=0`).
5. **The flip counter ticks but the canvas is BLACK.** The Playwright headed screenshot of `/?demo=modeset` after a drag shows the Modeset pane header reading `22043 FLIPS · 651MS` and an entirely black canvas region. **22043 flips over ~7s of test runtime is suspicious — that's ~3150 FPS, but the kernel-worker's vblank pump is on a `setInterval(1000/60)`. Either the pump is queue-coalescing and bursting on resume, or `kernel_kms_commit_count` is incrementing on every `drmModePageFlip` ioctl regardless of whether vblank actually fired. Worth investigating in session 15.**
6. **The Playwright spec `kandelo-modeset.spec.ts` still passes.** 4.4s. The `>5000 bytes screenshot` heuristic remains too loose (a flat-black 1920×1080 PNG serializes to ~8.9 KiB because of row-filter overhead, not because of real content). Session 13's TODO to tighten this stands.

## Open hypotheses — re-ordered after session 14's evidence

The original handoff-13 §"Open hypotheses" listed 6 candidates. With this session's data we can rule some out and sharpen others:

| # | Hypothesis | Status after session 14 |
|---|---|---|
| 1 | CSS-to-FB delta scaling in Modeset.tsx is off | **Fixed.** Pre-set canvas dims + canvas-coord deltas. Verified by reading back `canvas.width === 1920` and observing chunked packet values. |
| 2 | PS/2 Y-flip is doubled | **Fixed in the pointer wiring.** Single flip via `injectChunkedMouseMotion(sink, dx, -dy, buttons)`. Did NOT re-check `drain_mouse()` in modeset.c yet — could still be a second flip happening kernel-side. |
| 3 | modeset.c reads PS/2 at byte boundary; queue serialization mismatch | **Unverified.** Worth a session-15 spike: add temporary kernel-side instrumentation to `crate::mouse::read_into` to log read counts. |
| 4 | Drawing-buffer / viewport size mismatch | **Ruled out.** DIAG confirms `drawingBufferWidth/Height = 1920/1080` matches `glViewport(0, 0, 1920, 1080)`. |
| 5 | EGL/GLES2 → WebGL2 extension gap (RGBA16F + LINEAR + EXT_color_buffer_float) | **Partially verified — extensions are requested at context creation.** Did NOT check `gl.checkFramebufferStatus()` for the ping-pong RTs. Could still be the cause if `EXT_color_buffer_float` is silently denied. **New session-15 candidate.** |
| 6 | `pass_display` writes to wrong FBO | **Ruled out.** modeset.c:637 explicitly `glBindFramebuffer(GL_FRAMEBUFFER, 0)` before the display blit. |
| 7 | **NEW: OffscreenCanvas worker → placeholder presentation gap.** | The worker holds the OffscreenCanvas. WebGL2 commands accumulate during `host_gl_submit`. The OffscreenCanvas auto-commits when the worker JS task returns to its event loop. The modeset.c main loop calls `kms_pageflip_wait()` which `read()`s on `/dev/dri/card0` with EAGAIN+usleep(1000) — the host-side `read` blocks on the channel response, yielding the worker thread. That yield SHOULD let the OffscreenCanvas commit. But Playwright headed+headless both show black, **and the user reports their headed real browser also paints wrong.** Maybe the WebGL2 commands never actually reach the GPU because `host_gl_submit` decodes the cmdbuf into JS-side `gl.*` calls but doesn't `gl.flush()` before yielding. |
| 8 | **NEW: shader output is real but invisible.** | Pavel's `pass_display` samples `dye.read.tex` (RGBA16F) and writes RGBA8 to the default framebuffer. If RGBA16F sampling returns 0 because of an extension/storage issue, the display blit outputs black even with splats injected. Connect this to hypothesis 5. |
| 9 | **NEW: `kernel_kms_commit_count` counts ioctls, not vblanks.** | 22043 commits in ~7s = 3150 FPS. modeset.c is bound by `kms_pageflip_wait()`'s vblank event, so it should be capped at 60 Hz. Either the kernel posts `DRM_EVENT_FLIP_COMPLETE` faster than 60 Hz (vblank pump misconfigured) or the counter overcounts. Either way the demo is running far hotter than vblank and may be racing itself. |

## The mission for session 15 (verbatim from user)

> *"Analyze the whole code you built for DRI KMS, and also analyze thoroughly Pavel's demo at https://github.com/PavelDoGreat/WebGL-Fluid-Simulation. In its demo it runs a couple of projections when it loads. I also made my own version of Kandelo with DRI KMS here: https://github.com/mho22/wasm-posix-kernel/pull/66 (it is a series of 6 to 7 PRs with the whole work in it). Compare Pavel's GitHub repository work, with my DRI KMS work, with your DRI KMS work. And make it work once and for all."*

### Concrete starting point

1. **Fetch Pavel's repo as ground truth.** `https://github.com/PavelDoGreat/WebGL-Fluid-Simulation`. Focus files: `script.js` (the whole sim — passes, framebuffer setup, splat math), `index.html` (canvas setup, mouse wiring). Two things in particular:
   - **The auto-projections that run on load.** Pavel's sim seeds the dye with a handful of random splats at boot so the canvas isn't empty before the user moves the mouse. Our `programs/modeset.c` has **no boot-time seeding** — it relies on user input. If session-15 finds the pipeline is fine, just seeding at boot might be all the user needs to "see Pavel running" as a sanity check.
   - **The exact shader inputs / framebuffer formats.** Pavel uses RGBA16F for velocity + dye + pressure + divergence, RGBA8 for the display. Confirm modeset.c matches each, AND that the WebGL2 context can allocate RGBA16F (EXT_color_buffer_float + OES_texture_float_linear). Run `gl.checkFramebufferStatus(GL_FRAMEBUFFER)` after each FBO allocation and surface failures.
2. **Fetch the reference port: `https://github.com/mho22/wasm-posix-kernel/pull/66`.** Branch `dri-kms-kernel`. This is the user's own working implementation. The mouse wiring in `apps/browser-demos/pages/modeset/main.ts` and the chunked-motion helper in `host/src/framebuffer/browser-controls.ts` are what I copied this session. The other PRs in the stack (PRs 60–65 or so) hold the kernel-side KMS ioctls, the libdrm stub, the libgbm stub, etc. **The kernel + host bits on this branch were forward-ported from that stack, but at least one of them is wrong / incomplete in a way that breaks rendering.** Diff `crates/kernel/src/dri/`, `host/src/dri/`, and `libc/glue/libgles*_stub.c` carefully against the reference PRs.
3. **Bring up the reference branch locally to confirm it actually paints Pavel.** Worktree-clone `mho22/wasm-posix-kernel` at `dri-kms-kernel`, run its `apps/browser-demos/pages/modeset/index.html`, drag the mouse, observe Pavel splats. This proves the reference is the right oracle. If the reference *also* paints black in the user's current setup, the bug is environmental (browser/GPU/driver) rather than in our code.
4. **Three-way diff focused on `pass_display` flow.** With the reference PR open, diff:
   - `programs/modeset.c::pass_display` and the surrounding `pass_*` functions.
   - `host/src/webgl/main-forward.ts` (reference path on main thread) vs `host/src/kernel.ts::host_gl_create_context` (our path on worker).
   - `libc/glue/libglesv2_stub.c` — Pavel's sim needs `glTexImage2D` with internalformat `GL_RGBA16F` plus the right type+format. Check whether the stub is GLES2-strict (GLES2 doesn't define RGBA16F as core; you need the WebGL2 path via `glTexStorage2D` or an EXT path).
5. **Use the 9 hypotheses table above as a checklist.** Walk hypothesis 7 (worker present gap) and 8 (RGBA16F invisible) first since they're newest and least examined. Hypothesis 9 (commit count overruns) is a separate perf/correctness concern that doesn't gate visible pixels but should be filed for session 16.

### What NOT to retry

- Don't tweak Modeset.tsx pointer wiring. DIAG logs confirm packets reach `kernel_inject_mouse_event` with correct values, chunked, buttons synced. The input path is correct.
- Don't change the canvas pre-resize logic in `kernel.ts::host_gl_create_context` — it's defensive and verified to produce a 1920×1080 drawing buffer.
- Don't bump `ABI_VERSION` reflexively. The session-13 plan covers that under commit #6.

## Working-tree state at end of session 14

```
Modified (uncommitted) — handoff-13 list, unchanged except for Modeset.tsx
  abi/snapshot.json
  apps/browser-demos/pages/kandelo/panes/Modeset.tsx     # SESSION 14: pointer wiring rewrite + canvas dims pre-set
  apps/browser-demos/playwright.config.ts
  crates/kernel/src/syscalls.rs
  crates/kernel/src/wasm_api.rs
  crates/shared/src/lib.rs
  host/src/browser-kernel-host.ts
  host/src/browser-kernel-protocol.ts
  host/src/browser-kernel-worker-entry.ts
  host/src/dri/kms-registry.ts
  host/src/generated/abi.ts
  host/src/kernel-worker.ts
  host/src/kernel.ts                                     # NO CHANGE from end of session 13
  host/src/node-kernel-host.ts
  host/src/node-kernel-protocol.ts
  host/src/node-kernel-worker-entry.ts
  host/test/dri-kms-stats-sab.test.ts
  host/test/dri-modeset.test.ts
  host/test/dri-smoke.test.ts
  libc/glue/abi_constants.h
  scripts/build-programs.sh
  web-libs/kandelo-session/src/kernel-host.ts

Untracked:
  apps/browser-demos/test/kandelo-modeset.spec.ts        # session-13 spec — KEEP, part of commit #4
  docs/plans/2026-06-09-dri-kandelo-port-handoff-13.md   # KEEP
  docs/plans/2026-06-10-dri-kandelo-port-handoff-14.md   # THIS FILE

Deleted (uncommitted) — clean from session 13's cleanup list
  apps/browser-demos/test/_debug-modeset.spec.ts
  apps/browser-demos/test/_capture-modeset.spec.ts       # recreated + deleted this session
```

## Reference points (additions in session 14)

- Pointer wiring in the Modeset pane: `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:18` (import of `injectChunkedMouseMotion` + `MouseEventSink`), `:25-29` (`MODESET_FB_W/H` constants), `:80-91` (canvas-dims pre-set inside the attach effect), `:113-204` (the rewritten pointer-handler `useEffect`).
- Helper used: `host/src/framebuffer/browser-controls.ts:525-543` (`injectChunkedMouseMotion` — clamps each step into `[MIN_MOUSE_DELTA, MAX_MOUSE_DELTA] = [-128, 127]`).
- Reference PR's parallel: [`mho22/wasm-posix-kernel/blob/dri-kms-kernel/apps/browser-demos/pages/modeset/main.ts`](https://github.com/mho22/wasm-posix-kernel/blob/dri-kms-kernel/apps/browser-demos/pages/modeset/main.ts) — `attachAbsoluteMouse` function. This is the proven-working oracle for the input layer; session 14 ported it pattern-for-pattern.

## Important constraints, do not violate (carry-forward from v1–v13)

- One PR against `Automattic/kandelo:main`. All five test gates green first.
- Dual-host parity for any `host/src/` touch — kernel-worker.ts is shared, kernel.ts is shared. No host code was changed this session.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session.**
- Wait for user input before each commit.

## Open questions carried into session 15

- (Q1, still open) Why does the modeset canvas paint visibly-wrong / fully-black pixels in a real browser even with correct shaders, correct WebGL2 context, correct viewport, and verified mouse input reaching the kernel?
- (Q2, carried) The 103 vitest `exnref` failures on this branch — still unresolved, still NOT introduced by this session's changes. Confirm by stashing and re-running vitest.
- (Q3, carried) Is `channel: "chromium"` (new-headless) safe for the other Playwright projects?
- (Q4, NEW) Why does `kernel_kms_commit_count` advance at ~3000 Hz when modeset.c is gated by `kms_pageflip_wait()` and the vblank pump runs at 60 Hz?
- (Q5, NEW) Does `gl.checkFramebufferStatus()` on the RGBA16F ping-pong RTs return `GL_FRAMEBUFFER_COMPLETE`? Add a one-shot probe in `host_gl_create_context` or in the cmdbuf decoder after `glFramebufferTexture2D`.

## Standing instruction for the next session

**Print this sentence in the next session's first turn so I have a single fixed entry point:**

> *"Read `docs/plans/2026-06-10-dri-kandelo-port-handoff-14.md` first, then start session 15's mission: three-way compare the DRI/KMS implementation on this branch against (a) Pavel's reference at https://github.com/PavelDoGreat/WebGL-Fluid-Simulation and (b) the user's working port at https://github.com/mho22/wasm-posix-kernel/pull/66 (branch `dri-kms-kernel`, a 6–7-PR stack), and make Pavel's fluid sim paint correctly on `http://localhost:5401/?demo=modeset`. Walk hypotheses 7, 8, 9 from §"Open hypotheses" of handoff-14 in that order. Branch is `explore-direct-rendering-infrastructure` on Automattic/kandelo — do NOT push, do NOT push to mho22. Nix lives at `/nix/var/nix/profiles/default/bin` so every dev-shell call needs `PATH=/nix/var/nix/profiles/default/bin:$PATH scripts/dev-shell.sh bash -c '…'`. SpiderMonkey needs `WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` exported inside the inner `bash -c`. Wait for user input before each commit, per the standing instruction."*
