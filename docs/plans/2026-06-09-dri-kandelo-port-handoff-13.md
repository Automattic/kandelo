# DRI port onto kandelo:main — session 13 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-12.md](./2026-06-09-dri-kandelo-port-handoff-12.md). Read that first — this doc only covers what changed in session 13.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22` and do **not** push at all this branch-cycle. Wait for user input before each commit.

## TL;DR for next session

1. **Option A landed (mode arg, no auto-fallback).** `attachKmsCanvas` now takes `opts?: { mode?: "auto" | "2d" | "webgl2" }` (default `"auto"`). The vblank pump 2D-blits **only** when `mode === "2d"`; the auto-fallback + `glMasterIncoming` race-guard are gone. Slots 2/3 (scanout w/h) and 5/6 (PAGE_FLIP commit/last-µs) moved out of the per-canvas loop so they tick mode-independently. The React modeset pane (`LiveKernelHost.attachKmsDisplay`) defaults to `mode: "webgl2"`. 31/31 DRI/KMS vitest pass.
2. **PAGE_FLIP regression was misdiagnosed in handoff-12.** Slots 5/6 were always ticking kernel-side — the pane just couldn't see them because `hasFrame = stats.width > 0 && stats.height > 0` (Modeset.tsx:112) was wired to slots 2/3, and those were *only* written inside the now-skipped 2D-blit branch. Fixed by moving slot 2/3 writes into the unconditional block of `tickVblank` (alongside 5/6). The flip counter now displays correctly in the pane.
3. **Headless Chromium can't host WebGL2-on-transferred-OffscreenCanvas.** The default `chromium-headless-shell` driver silently returns `null` from `getContext("webgl2")` on an OffscreenCanvas that was created via `HTMLCanvasElement.transferControlToOffscreen()`. The new-headless driver does support it; flipping `playwright.config.ts` to `channel: "chromium"` is what makes the modeset spec see real pixels. **All other headless Chromium tests in this repo now run on new-headless too** — keep an eye out for cross-test regressions; this is a behavior change for the whole `chromium` Playwright project.
4. **OffscreenCanvas dims must match the FB before `getContext("webgl2")`.** `transferControlToOffscreen()` inherits the source `<canvas>`'s natural 300×150 default. `modeset.c` uses `CANVAS_W=1920`, `CANVAS_H=1080`. Without a pre-resize the WebGL drawing buffer is 300×150 and `glViewport(0, 0, 1920, 1080)` clips to a tiny bottom-left corner. Fixed by reading `this.kms.currentFb(crtc)` inside the auto-attach branch of `host_gl_create_context` and resizing the canvas **before** `getContext("webgl2")`.
5. **Modeset Playwright spec now PASSES** (`apps/browser-demos/test/kandelo-modeset.spec.ts` — flip counter + canvas-screenshot-byte-length > 5 KiB) in headless. With `mode: "webgl2"` + canvas pre-resize + new-headless driver, modeset.c boots, shaders compile, render loop runs, drmModePageFlip ticks the counter.
6. **Mouse-input forwarding wired (NEW scope).** `KmsDisplayHandle.sendMouseEvent(dx, dy, buttons)` calls `kernel.injectMouseEvent(...)` → `/dev/input/mice`. The Modeset pane wires pointer events on the visible `<canvas>` (CSS-to-FB delta scaling via `getBoundingClientRect()`; PS/2 Y-flip; button bits 0/1/2 for L/R/M). Without this the user has no way to drive Pavel's splats.
7. **User-reported issue at end of session — still open.** The user opened the demo in their real browser, dragged the mouse on the canvas, and reported: "shows some projection but it absolutely doesn't look like https://paveldogreat.github.io/WebGL-Fluid-Simulation/". So something IS painting (not the black-canvas regression), but the output is visually wrong vs. Pavel's reference. Root cause **unknown** — see §"Open hypotheses for the wrong-pixels bug" below.

## What I edited and shipped (working tree, uncommitted)

| File | Edit | Status |
|---|---|---|
| `host/src/kernel.ts` | (a) Removed session-12 debug `console.log` from the `host_gl_create_context` auto-attach block. (b) Inside the auto-attach branch, before `getContext("webgl2")`, look up `this.kms.currentFb(crtc)` and set `canvas.width/height` to `fb.width/fb.height` if they differ. | **Keep — required for visible output.** |
| `host/src/kernel-worker.ts` | (a) Removed session-12 debug `console.log` from `attachKmsCanvas`. (b) Added `opts?: { mode?: "auto"\|"2d"\|"webgl2" }` parameter. Mode `"2d"` eagerly grabs `getContext("2d")` at attach time (legacy CPU-blit). Mode `"webgl2"` flips `kmsContextMode` up front so the pump never touches the canvas. Mode `"auto"` (default) defers — pump skips, GL bridge claims via `markKmsCanvasGlOwned`. (c) `tickVblank` simplified: for-loop only runs blit when mode is `"2d"`; `glMasterIncoming` heuristic deleted; slots 2/3 (scanout w/h) and 5/6 (commit count, last µs) moved into the unconditional `kmsStatsViews` loop so they tick regardless of mode. | **Keep — completes Option A.** |
| `host/src/browser-kernel-host.ts`, `host/src/node-kernel-host.ts` | Forward `opts` through `kmsAttachCanvas` to the worker entry. | **Keep.** |
| `host/src/browser-kernel-protocol.ts`, `host/src/node-kernel-protocol.ts` | Add `opts?` to the `KmsAttachCanvasMessage` shape. | **Keep.** |
| `host/src/browser-kernel-worker-entry.ts`, `host/src/node-kernel-worker-entry.ts` | Pass `msg.opts` into `kernelWorker.attachKmsCanvas(...)`. | **Keep.** |
| `host/test/dri-kms-stats-sab.test.ts` | The "tickVblank writes [count, ts_ms, width, height, tick_us]" test now passes `{ mode: "2d" }` explicitly so the blit branch fires and slot 0 increments. (Other tests stay unchanged — they assert slot 5/6 or no-throw and pass in `"auto"`.) | **Keep.** |
| `web-libs/kandelo-session/src/kernel-host.ts` | (a) `KernelHost.kmsAttachCanvas` interface: added `opts?: { mode?: "auto"\|"2d"\|"webgl2" }` param. (b) `LiveKernelHost.attachKmsDisplay`: added `opts: { mode?: ... } = { mode: "webgl2" }` default; threads through to `kernel.kmsAttachCanvas`. (c) `KmsDisplayHandle.sendMouseEvent(dx, dy, buttons)` field added — calls `kernel.injectMouseEvent`. Existing StrictMode `kmsHandles` memoization unchanged. | **Keep.** |
| `apps/browser-demos/pages/kandelo/panes/Modeset.tsx` | New `useEffect` that wires `pointermove`/`pointerdown`/`pointerup`/`contextmenu` to `handleRef.current.sendMouseEvent(dx, dy, buttons)`. Scales CSS deltas to canvas-pixel deltas via `getBoundingClientRect()` ratio; flips Y for PS/2 convention; tracks button bits (0=L,1=R,2=M). Sets pointer capture on press so drag works outside the canvas bounds. | **Keep — but verify the scaling math is right (see open hypotheses).** |
| `apps/browser-demos/playwright.config.ts` | `chromium` project now uses `channel: "chromium"` (new-headless driver). | **Keep — the modeset spec depends on this.** Watch for cross-test regressions in `coi.spec.ts`, `kandelo-merge-gate.spec.ts`, `kandelo-node.spec.ts`, `kandelo-url.spec.ts`, `kandelo-wordpress.spec.ts`, `mysql-config.spec.ts`, `network.spec.ts`. |

## Untracked (delete before commit)

- `apps/browser-demos/test/_capture-modeset.spec.ts` — diag spec from this session that writes `/tmp/modeset-capture*.png`. **DELETE before any commit.**

## What works, what doesn't

### Works (confirmed via Playwright headless + Node)

- `cargo test -p kandelo --target aarch64-apple-darwin --lib` — 934 passed, 0 failed (Gate 1 ✓).
- `bash scripts/check-abi-version.sh` — snapshot in sync, ABI consistent (Gate 5 ✓).
- 31/31 vitest DRI/KMS/framebuffer-related tests pass (dri-kms-stats-sab, dri-kms-pageflip, dri-kms-registry, dri-modeset, dri-smoke, dri-cube-pyramid, framebuffer-*).
- `KANDELO_TEST_BASE_URL='http://localhost:5401' npx playwright test test/kandelo-modeset.spec.ts` passes in 4 seconds: flip counter ticks, canvas screenshot > 5000 bytes, no shader-compile-FAILED storm.
- DIAG logs (removed before this handoff) showed `host_gl_create_context` auto-attaches the canvas, `getContext("webgl2")` returns ok with `channel: "chromium"`, no shader-compile FAILED lines in dmesg.

### Doesn't (the open user-visible bug)

- **In the user's real browser, the canvas paints SOMETHING but it doesn't look like Pavel's reference at https://paveldogreat.github.io/WebGL-Fluid-Simulation/.** Mouse-drag produces visible output but not the expected fluid-sim splats with curling velocity / dye trails.
- Gate 2 (`cd host && npx vitest run`) has 103 failures, all of the form `WebAssembly.compile(): invalid value type 'exn', enable with --experimental-wasm-exnref`. **This is a Node 24 environment issue, NOT Option A.** The failing tests load wasm binaries from `local-binaries/programs/wasm32/` that were compiled with exception handling; Node 24.13.0 gates exnref behind `--experimental-wasm-exnref`, and Node refuses that flag inside `NODE_OPTIONS` (`node: --experimental-wasm-exnref is not allowed in NODE_OPTIONS`). Vitest spawns Node sub-processes that inherit `NODE_OPTIONS` but reject the flag. **Next session must resolve this before claiming Gate 2 green** — options:
  - (a) Use a Node version where exnref is on by default (newer 24.x or 25.x?).
  - (b) Wrap the vitest entry so individual test files pass `--experimental-wasm-exnref` as a positional `node` argv instead of via `NODE_OPTIONS`.
  - (c) Switch the test runner to a wrapper script that exports a `NODE_OPTIONS`-free shell and invokes `node --experimental-wasm-exnref` directly.
  - This is NOT introduced by Option A; the same failures exist on `main` if you run vitest there. Confirm by stashing my changes and re-running.

## Open hypotheses for the wrong-pixels bug

The visible content is wrong. Likely candidates, ordered by my confidence:

1. **CSS-to-FB delta scaling in Modeset.tsx is off.** I use `getBoundingClientRect()` to derive scaleX/scaleY between the displayed canvas and the FB. If the pane uses `imageRendering: pixelated` with letterboxing, the actual rendered region is smaller than the bounding box and the scale ratio is wrong. modeset.c integrates raw PS/2 deltas to update `cursor_x/cursor_y`, then clamps to `[0, CANVAS_W)`. Wrong delta magnitude → cursor never reaches the intended FB pixel. Pavel's `splat_dye(u, v, …)` happens at `(u, v) = (cursor_x / CANVAS_W, 1 - cursor_y / CANVAS_H)`. A scale of e.g. 8× would saturate the cursor at one corner instantly, producing a corner splat rather than a track.
2. **PS/2 Y-flip might be wrong-direction or doubled.** Browser `movementY` is positive-down; PS/2 is positive-up. I negate it in `cssToPs2`. But `drain_mouse()` in modeset.c (programs/modeset.c:676) might already negate again, double-flipping. Read `drain_mouse` carefully and reconcile.
3. **modeset.c reads PS/2 packets at byte boundary** — the kernel's `/dev/input/mice` queue may serialize events differently from the 3-byte PS/2 packets `drain_mouse()` expects. Look at `crates/kernel/src/syscalls.rs` `kernel_inject_mouse_event` and confirm the packet format matches `drain_mouse`'s reader.
4. **The drawing-buffer / viewport sizes might still mismatch.** I resize the canvas to `fb.width/height` (1920×1080) in `host_gl_create_context`. But `getContext("webgl2")` then creates a drawing buffer of that size in the WebGL2 sense — and modeset.c calls `glViewport(0, 0, CANVAS_W, CANVAS_H)` (= 1920×1080). Should match. **Verify** by adding a one-shot console.log in `host_gl_create_context` after getContext: `gl.drawingBufferWidth/Height`.
5. **EGL/GLES2 → WebGL2 translation gap in `host/src/webgl/`.** Pavel's port uses ping-pong RGBA16F framebuffers with `OES_texture_float_linear` + `EXT_color_buffer_float` + `EXT_float_blend`. I do enable these extensions in `host_gl_create_context` (the existing code unchanged from handoff-7). Confirm via DevTools that the textures actually allocate as RGBA16F and `gl.checkFramebufferStatus` returns `GL_FRAMEBUFFER_COMPLETE`. If extensions are missing in headed mode, fb status returns `GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT` and the display pass samples an invalid texture.
6. **`preserveDrawingBuffer: true` is set on the WebGL2 context (host/src/kernel.ts:780).** Each frame the modeset binary does `eglSwapBuffers` (host-side no-op) then `drmModePageFlip`. With preserveDrawingBuffer the canvas retains whatever the last frame drew. If pass_display writes to the default framebuffer correctly the canvas should reflect it. If pass_display writes to its OWN named FBO, only that FBO is updated and the default framebuffer stays empty. Check pass_display in `programs/modeset.c:631-638`: `glBindFramebuffer(GL_FRAMEBUFFER, 0)` would be the tell.

## How to reproduce session 13's state

```bash
# 1. Rebuild (already done at end of session — bash build.sh at ~20:30)
PATH=/nix/var/nix/profiles/default/bin:$PATH scripts/dev-shell.sh bash -c \
  'export WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk; bash build.sh'

# 2. Start (or reuse) the vite server
cd apps/browser-demos && npx vite --port 5401 --strictPort &

# 3. Run the user-facing Playwright spec
KANDELO_TEST_BASE_URL='http://localhost:5401' npx playwright test test/kandelo-modeset.spec.ts --reporter=line
# Expect: 1 passed in ~4 s.

# 4. Run a screenshot-capture spec to inspect the actual pixels
KANDELO_TEST_BASE_URL='http://localhost:5401' npx playwright test test/_capture-modeset.spec.ts --reporter=line
# Writes /tmp/modeset-capture.png and /tmp/modeset-capture-after-mouse.png.

# 5. Open in a real browser
open http://localhost:5401/?demo=modeset
# Drag-click on the canvas. User-observed: paints SOMETHING but wrong vs Pavel reference.
```

## Things the next session MUST do — in order

1. **Diagnose the wrong-pixels bug.** The user's evidence is "paints something but doesn't look like Pavel's reference". Walk the §"Open hypotheses" list above. Start with **hypothesis 1 (CSS-to-FB delta scaling)** and **hypothesis 2 (PS/2 Y-flip double-counted)** — both are isolated to Modeset.tsx's pointer wiring and `drain_mouse()` in modeset.c. The fix is likely a handful of lines.

2. **Confirm the wrong-pixels bug is fixed in a real browser**, not just Playwright. The Playwright canvas-screenshot heuristic (`> 5000 bytes`) is too coarse — a wrong-but-non-uniform render passes it. Augment the spec with a tighter assertion: e.g., run the drag pattern from `_capture-modeset.spec.ts`, then check that pixel-color variance is at least N, OR sample several known-good pixel coordinates. The 5000-byte gate is fine as a regression backstop but not a "Pavel works" gate.

3. **Resolve the 103 vitest exnref failures.** Try Node 25.x or wrap vitest's node argv. The failures are env-pre-existing — stash my changes and re-run vitest to confirm they exist on a clean working tree. **Do NOT mark Gate 2 green without resolving this.**

4. **Delete the diag spec.** `apps/browser-demos/test/_capture-modeset.spec.ts` is untracked. Remove it before commit.

5. **Re-confirm gates 1, 5 are still clean** after any kernel.ts / canvas-resize tweaks. (Gates 3/4 only needed if syscalls.rs changes.)

6. **The 7-commit plan from handoff-12 needs revision.** Commit #7 grew this session:

   | # | Files | Summary |
   |---|---|---|
   | 1 | `wasm_api.rs`, `syscalls.rs` (handoff-7 Diffs 1+2) | mmap errno + raw bo size |
   | 2 | `syscalls.rs` (handoff-7 Diffs 3+4 + handoff-8 Diff A test) | sync PAGE_FLIP → event_ring drain |
   | 3 | `host/src/kernel.ts`, `host/src/kernel-worker.ts` (handoff-8 Diffs B+C) | primeBindFromSab on DRI mmap |
   | 4 | `build-programs.sh`, `dri-smoke.test.ts`, `dri-modeset.test.ts`, `programs/dri-modeset.c`, `apps/browser-demos/test/kandelo-modeset.spec.ts` | test plumbing + retarget |
   | 5 | `syscalls.rs` (session-9 Diff D) | GLIO ioctl protocol for renderD128 |
   | 6 | `crates/shared/src/lib.rs`, `abi/snapshot.json`, `host/src/generated/abi.ts`, `libc/glue/abi_constants.h` | ABI bump 14→15 + regen |
   | **7 (UPDATED)** | `web-libs/kandelo-session/src/kernel-host.ts` (StrictMode memoization + `attachKmsDisplay` mode default + `KmsDisplayHandle.sendMouseEvent`), `host/src/kernel.ts` (auto-attach + canvas pre-resize), `host/src/kernel-worker.ts` (mode arg, slots 2/3 + 5/6 mode-independent), `host/src/{browser,node}-kernel-{host,protocol,worker-entry}.ts` (opts pass-through), `host/test/dri-kms-stats-sab.test.ts` (mode "2d" opt-in), `apps/browser-demos/pages/kandelo/panes/Modeset.tsx` (mouse wiring), `apps/browser-demos/playwright.config.ts` (channel: chromium) | **host(dri): wire KMS scanout canvas to WebGL2 GL session, default `mode: "webgl2"` for the modeset pane, forward pointer input to /dev/input/mice, run Playwright on new-headless chromium so the verification covers transferControlToOffscreen + WebGL2 + Worker** |

   Wait for user input before each commit — standing instruction.

## Working-tree state at end of session 13

```
Modified (uncommitted) — handoff-12 list plus:
  host/src/kernel.ts                                     # debug-log removal + canvas pre-resize in auto-attach
  host/src/kernel-worker.ts                              # mode arg, simplified tickVblank, debug-log removal
  host/src/browser-kernel-host.ts                        # opts pass-through
  host/src/node-kernel-host.ts                           # opts pass-through
  host/src/browser-kernel-protocol.ts                    # opts in message type
  host/src/node-kernel-protocol.ts                       # opts in message type
  host/src/browser-kernel-worker-entry.ts                # forward msg.opts
  host/src/node-kernel-worker-entry.ts                   # forward msg.opts
  host/test/dri-kms-stats-sab.test.ts                    # test 1 → mode: "2d"
  web-libs/kandelo-session/src/kernel-host.ts            # interface opts + LiveKernelHost mode default + sendMouseEvent on handle
  apps/browser-demos/pages/kandelo/panes/Modeset.tsx     # pointer event wiring → handleRef.sendMouseEvent
  apps/browser-demos/playwright.config.ts                # channel: "chromium"
  apps/browser-demos/test/kandelo-modeset.spec.ts        # unchanged from session 12 (still has the 5 KiB pixel assertion)

Deleted (uncommitted):
  apps/browser-demos/test/_debug-modeset.spec.ts         # session-12 diag spec

Untracked (delete before commit):
  apps/browser-demos/test/_capture-modeset.spec.ts       # session-13 diag spec

New (untracked):
  docs/plans/2026-06-09-dri-kandelo-port-handoff-13.md   # THIS FILE
```

## Reference points (additions in session 13)

- KMS attach mode definition + dispatch: `host/src/kernel-worker.ts:783-792` (`kmsContextMode` field docs), `:8311-8347` (`attachKmsCanvas` with `opts.mode` switch).
- Slots 2/3 + 5/6 mode-independent block: `host/src/kernel-worker.ts:8392-8421` (the unconditional `kmsStatsViews` loop after the 2D-blit for-loop).
- 2D-blit branch (only fires when `mode === "2d"`): `host/src/kernel-worker.ts:8358-8391`.
- Canvas pre-resize in auto-attach: `host/src/kernel.ts:763-775` (inside the `if (!b.canvas)` block of `host_gl_create_context`, after `getKmsCanvas` returns).
- `KmsDisplayHandle.sendMouseEvent` wiring: `web-libs/kandelo-session/src/kernel-host.ts:303-315` (interface), `:1480-1485` (`LiveKernelHost.attachKmsDisplay` returns it via `kernel.injectMouseEvent`).
- Pointer-event wiring on the modeset pane: `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:90-137` (the new `useEffect` block).
- Playwright new-headless driver: `apps/browser-demos/playwright.config.ts:23-32` (`channel: "chromium"` on the chromium project).

## Important constraints, do not violate (carry-forward from v1–v12)

- One PR against `Automattic/kandelo:main`. All five test gates green first.
- Dual-host parity for any `host/src/` touch — kernel-worker.ts is shared, kernel.ts is shared. Both hosts updated in this session's opts pass-through.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session.**
- Wait for user input before each commit.

## Open questions carried into session 14

- (Q1) Why does the modeset canvas paint visibly-wrong pixels in a real browser even though shaders compile, render loop runs, and PAGE_FLIP ticks? Walk §"Open hypotheses for the wrong-pixels bug" 1→6.
- (Q2) Is Node 24.13's `--experimental-wasm-exnref` policy a kandelo:main regression (binaries gained exnref recently) or was it always like this and previous sessions never ran a full vitest? `git log --oneline -- local-binaries/` would settle it. If recent, the cleanup-then-rebuild path from session 11 may have introduced it.
- (Q3) Is `channel: "chromium"` (new-headless) really safe for the other Playwright projects (coi.spec.ts, kandelo-merge-gate.spec.ts, etc.)? Confirm by running each one.
- (Q4) The handoff-11 §"Open postmortem" doc-update about `local-binaries` short-circuit is still open. Skip unless time permits.
