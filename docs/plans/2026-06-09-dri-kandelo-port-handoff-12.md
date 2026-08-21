# DRI port onto kandelo:main — session 12 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-11.md](./2026-06-09-dri-kandelo-port-handoff-11.md). Read that first — this doc only covers what changed in session 12.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22` and do **not** push at all this branch-cycle. Wait for user input before each commit.

## TL;DR for next session

1. **Option A scaffolding landed**, **the demo still does not paint pixels.** The auto-attach in `host_gl_create_context` works — debug logs prove `kmsAttachCanvas` arrived first, `masterCrtcForPid(modesetPid)` resolved to `1`, the callback found the canvas (`canvas=found`). But the subsequent `getContext("webgl2")` is **still returning null** because the vblank pump's lazy `getContext("2d")` call wins the race against `host_gl_create_context` *between* `kmsAttachCanvas` (kmsCanvases populated) and `host_gl_bind` (gl binding registered). The shader-compile-FAILED storm is identical to session 11.
2. **PAGE_FLIP counter regression.** In session 11 the spec passed because the flip counter ticked into the hundreds-of-thousands range. After this session's host TS changes, the counter stays at 0 — pane reads "WAITING FOR PAGE_FLIP" forever even after 3 minutes. modeset's stderr only shows the 27 shader-compile failures, no `perror("drmModePageFlip")` message. **Root cause unknown** — suspect either kernel.wasm is staler than the source (mtime 13:54 predates handoff-7/8/9 diffs in this tree, but tree contents are unchanged) or my new tickVblank inner-loop reshaping broke a precondition.
3. **`./host/test/dri-kms-stats-sab.test.ts` + `dri-modeset.test.ts` + `dri-cube-pyramid.test.ts` + `dri-smoke.test.ts`** all **still pass** under vitest. Whatever's broken doesn't surface there.

## What I edited and shipped

| File | Edit | Status |
|---|---|---|
| `host/src/dri/kms-registry.ts` | Added `masterCrtcForPid(pid): number \| null` — returns first bound CRTC if `pid` is master, else null. | **Keep — correct.** |
| `host/src/kernel.ts` | Added two optional `KernelCallbacks` fields: `getKmsCanvas(crtcId)` and `markKmsCanvasGlOwned(crtcId)`. Patched `host_gl_create_context`: when `b.canvas == null`, look up the master CRTC, call `getKmsCanvas`, attach via `gl.attachCanvas`, fire `markKmsCanvasGlOwned`. | **Keep — confirmed firing per logs.** Debug `console.log` lines added (lines 753, 757) — **remove before commit**. |
| `host/src/kernel-worker.ts` | Added `kmsContextMode: Map<number, "2d"\|"webgl2">`. Wired the two callbacks in the `WasmPosixKernel` constructor block. Removed eager `getContext("2d")` from `attachKmsCanvas`. Reshaped `tickVblank`: iterate `kmsCanvases` (was `kmsContexts`), skip when mode is "webgl2", lazily acquire 2D on first frame, with a `gl.list()` "master has a binding?" race-guard before falling back to 2D. | **Keep the structure** but the race-guard is **insufficient** — see Option A.fix below. Debug `console.log` (line ~8307) — **remove before commit**. |
| `apps/browser-demos/test/kandelo-modeset.spec.ts` | Added a `canvas.screenshot()` byte-length assertion (>5000) so the spec fails loudly on shader-compile regressions. | **Keep — well-shaped.** The current spec body fails today because the underlying GL bug isn't fixed; not because the spec is wrong. |
| `host/dist/*` | Rebuilt by `bash build.sh` at 18:52. | Build product — gitignored. |

## What works, what doesn't

### Works (proven by debug logs in session 12)

```
[KMS] attachKmsCanvas crtc=1 stats=true
[GL]  host_gl_create_context pid=100 ctxId=1 crtc=1 hasCb=true
[GL]  auto-attach lookup crtc=1 canvas=found
```

The auto-attach pipeline executes cleanly — `kmsAttachCanvas` arrives **before** `host_gl_create_context`, `masterCrtcForPid` returns the right CRTC, the `getKmsCanvas` callback finds the canvas, and `gl.attachCanvas(pid, canvas)` runs. `b.canvas` is set.

### Doesn't (despite the above)

```
spawning modeset...
shader compile FAILED [curl]:
… 27 lines total …
program link FAILED [display]:
```

So `b.canvas.getContext("webgl2", { … })` after the auto-attach is **still returning null**. The only way that can happen with my current changes: **the pump's lazy `getContext("2d")` ran in the gap between `attachKmsCanvas` and `host_gl_create_context`** and the canvas is now 2D-claimed for life.

### Why the gl.list() race-guard isn't enough

My tickVblank race-guard checks `this.kernel.gl.list()` for any binding belonging to the DRM master pid before falling back to 2D. That covers the gap between `host_gl_bind` and `host_gl_create_context`. But it does **not** cover the *earlier* gap between `drmModeSetCrtc` (currentFb starts returning valid) and `host_gl_bind` (gl binding is registered).

The timeline of a fresh `?demo=modeset` load:

```
t≈0     React pane mounts → attachKmsDisplay → postMessage to kernel worker
t≈ε     CentralizedKernelWorker.attachKmsCanvas → kmsCanvases.set(1, canvas) + statsSab + startVblankPump()
t≈few ms vblank pump tick 1 → currentFb is undefined → skip → mode unset
... lots of pump ticks while modeset is loading ...

t≈200ms modeset boots, libc init, main()
t≈205ms setup_kms():
        - drmSetMaster                  → KmsRegistry.masterPid = modesetPid
        - drmModeAddFB2 ×2              → KmsRegistry.fbs populated
        - drmModeSetCrtc                → KmsRegistry.crtcBindings[1] = fb_id  ⇒ currentFb valid!
        ↑↑↑ here is the start of the dangerous window ↑↑↑
t≈205+δ eglGetDisplay (returns immediately)
        eglInitialize → mmap renderD128 cmdbuf  → host_gl_bind  ⇒ gl.list() now has modesetPid
        ↑↑↑ end of dangerous window ↑↑↑
t≈210ms eglChooseConfig, eglBindAPI, eglCreateContext → host_gl_create_context (auto-attaches)
```

If a vblank pump tick fires during the δ-window (between `drmModeSetCrtc` and `host_gl_bind`), my race-guard sees:
- `currentFb` returns valid ✓
- `gl.list()` is empty (modesetPid has no binding yet) ✗

So the guard's `glMasterIncoming` is `false` and the pump grabs `getContext("2d")`. The canvas is now 2D-owned. Subsequent `host_gl_create_context.b.canvas.getContext("webgl2")` returns `null`.

**δ is several syscalls (low ms). Pump cadence is 16.67ms.** Probability of a tick landing in the window per page load: ~6–12%. Empirically it's hitting near-100% of my Playwright runs, which means either (a) the syscall sequence is longer than I'm estimating, or (b) Playwright's chromium scheduling reliably interleaves the pump tick into the window.

### Why the PAGE_FLIP counter is stuck at 0 — unresolved

This was working in session 11 with the **same** kernel.wasm (the wasm at `host/wasm/kandelo-kernel.wasm` is mtime 13:54, predates session 11's prepare-browser-3 finish). Session 11's spec passed at `121342 FLIPS · 56µs`. Now in session 12 the counter stays at 0 with no `perror` message from modeset.c.

Hypotheses, ordered by likelihood:

1. **Stale kernel.wasm** — the 13:54 build might not actually be at handoff-7 Diff 3+4 (synchronous PAGE_FLIP→event_ring drain) or session-9 Diff D (GLIO ioctl protocol). Force a rebuild: `rm host/wasm/kandelo-kernel.wasm && bash build.sh`. If the new wasm is different bytes, that was the bug.
2. **My tickVblank reshape broke a precondition** — the slot 5/6 update is identical (outside the inner loop), but I changed the for-loop iterator from `kmsContexts` to `kmsCanvases`. The slot 5/6 update reads `this.kmsStatsViews` so it's independent of the for-loop. I can't currently see what would break.
3. **Modeset is exiting silently** before reaching `drmModePageFlip` — possible, but then `spawnLazy`'s `tick("modeset exited")` would fire (it doesn't). Check by adding a `console.log` in spawnLazy's catch + after `await kernel.spawn(...)`.

The next session should diagnose this **before** chasing the race fix — the race only matters if modeset reaches the render loop.

## How to reproduce session 12's state

```bash
# 1. Rebuild (already done at 18:52)
PATH=/nix/var/nix/profiles/default/bin:$PATH scripts/dev-shell.sh bash -c \
  'export WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk; bash build.sh'

# 2. Start (or reuse) the vite server
cd apps/browser-demos && npx vite --port 5401 --strictPort &

# 3. Run the debug spec (it dumps console + dmesg)
cd apps/browser-demos
KANDELO_TEST_BASE_URL='http://localhost:5401' \
  npx playwright test test/_debug-modeset.spec.ts --reporter=line
```

The `_debug-modeset.spec.ts` file I added is under `apps/browser-demos/test/` — **delete it before commit**.

## Option A — fix sketch (NOT YET WRITTEN)

The vblank pump must **not** call `getContext("2d")` unless the embedder has explicitly opted into the 2D blit path. For the GL/modeset case the canvas is owned by WebGL2; for legacy/non-GL CPU scanout demos, the embedder declares it.

### Minimal API change

Extend `attachKmsCanvas` (and its `KernelHost.kmsAttachCanvas` interface) with a third parameter:

```ts
interface KmsScanoutMode {
  /** "auto" (default): never grab 2D from the pump; defer to GL only.
   *  "2d": eagerly grab 2D in attachKmsCanvas (legacy behavior).
   *  "webgl2": never grab 2D in the pump; mark mode = "webgl2" up front. */
  mode?: "auto" | "2d" | "webgl2";
}

attachKmsCanvas(crtc_id, canvas, statsSab?, opts?: KmsScanoutMode): void
```

- Default `"auto"` removes the race entirely — pump never blits, slot 5/6 still ticks unconditionally.
- The **React pane** (`apps/browser-demos/pages/kandelo/panes/Modeset.tsx` indirectly via `kernel-host.ts:attachKmsDisplay`) should pass `mode: "webgl2"` — it knows the modeset demo is GL.
- The existing `dri-kms-stats-sab.test.ts` vitest needs `mode: "2d"` opt-in so its first-tick blit assertion still holds. Three tests need that update (the ones that call `attachKmsCanvas` then `tickVblank` and read slot 0).
- The kernel-host.ts `KernelHost.kmsAttachCanvas` type signature in `web-libs/kandelo-session/src/kernel-host.ts:115` accepts a third optional param. Mirror the shape.

### What the pump does in each mode

| Mode | Pump 2D blit | Slots 0–4 (frame_count, ts, w, h, blit µs) | Slots 5–6 (commit_count, last_us) |
|---|---|---|---|
| `auto` (default) | Never | Stay 0 | Tick unconditionally |
| `webgl2` | Never | Stay 0 | Tick unconditionally |
| `2d` | Eager `getContext("2d")` in attachKmsCanvas, blit each frame with valid `currentFb` | Tick on each blit | Tick unconditionally |

Drop the `glMasterIncoming` heuristic — it's only needed because we kept the "auto-fallback to 2D" path. Removing the fallback makes the heuristic dead code.

## Things the next session MUST do — in order

1. **Diagnose the PAGE_FLIP regression first.** Add a `console.log` in `kernel-worker.ts` tickVblank slot 5/6 reads, and another in `spawnLazy` after `await kernel.spawn(...)` to confirm modeset's render loop is running. If commit_count is bumping kernel-side but the host isn't reading it → tickVblank bug. If commit_count stays 0 kernel-side → modeset is stuck before drmModePageFlip. If modeset already exited → fix that first. (Optional: `rm host/wasm/kandelo-kernel.wasm && bash build.sh` to invalidate any stale cached wasm.)

2. **Remove the debug `console.log` lines** in `host/src/kernel.ts` (around the auto-attach block, lines 752–760) and `host/src/kernel-worker.ts` (`attachKmsCanvas` at line 8312). Delete `apps/browser-demos/test/_debug-modeset.spec.ts`.

3. **Implement the Option A fix sketch** above: drop "auto-fallback to 2D" from the pump and switch to an explicit `mode` parameter on `attachKmsCanvas`. Update the React pane to pass `mode: "webgl2"`. Update the three vitest tests in `dri-kms-stats-sab.test.ts` that depend on the legacy 2D-eager behavior to pass `mode: "2d"` explicitly.

4. **Verify the fix in the browser** via `KANDELO_TEST_BASE_URL='http://localhost:5401' npx playwright test test/kandelo-modeset.spec.ts` — the spec already has the pixel-content (screenshot size > 5 KiB) assertion.

5. **Re-confirm gates 1, 2, 5 on an idle system.** Gates 3, 4 if time. Re-run vitest cleanly to check whether session 11's 5 WordPress site-editor failures were env flakes.

6. **Then proceed to the 7-commit plan in handoff-11 §"Things the next session MUST do" item 6.** Commit #7 ("host(dri): wire KMS scanout canvas to WebGL2 GL session …") gains two more files relative to handoff-11's plan:
   - `host/src/dri/kms-registry.ts` (new `masterCrtcForPid` helper)
   - **a slimmer host/src/kernel-worker.ts diff** than the handoff-11 sketch (option A becomes "drop auto-fallback + add mode arg" instead of "lazy 2D + glMasterIncoming heuristic")

   Wait for user input before each commit — standing instruction.

## Working-tree state at end of session 12

```
Modified (uncommitted) — same as handoff-11 plus:
  host/src/kernel.ts                                     # SESSION 12 — KernelCallbacks fields + host_gl_create_context auto-attach
                                                          # (has 2 debug console.log lines to remove)
  host/src/kernel-worker.ts                              # SESSION 12 — kmsContextMode, deferred getContext, tickVblank reshape, callbacks
                                                          # (has 1 debug console.log line to remove)
  host/src/dri/kms-registry.ts                           # SESSION 12 — masterCrtcForPid helper
  apps/browser-demos/test/kandelo-modeset.spec.ts        # SESSION 12 — pixel-content (screenshot byte-length) assertion

Unchanged from handoff-11 (still in working tree):
  crates/kernel/src/wasm_api.rs                          # handoff-7 Diff 1
  crates/kernel/src/syscalls.rs                          # handoff-7 Diffs 2/3/4 + handoff-8 Diff A + session-9 Diff D
  crates/shared/src/lib.rs                               # session-9 Diff E (ABI 15)
  host/src/kernel.ts                                     # also has handoff-8 Diff B (unchanged from handoff-11)
  host/src/kernel-worker.ts                              # also has handoff-8 Diff C (unchanged from handoff-11)
  scripts/build-programs.sh                              # handoff-7 Diff 8
  host/test/dri-smoke.test.ts                            # handoff-7 Diff 5
  host/test/dri-modeset.test.ts                          # handoff-7 Diff 6 retarget
  abi/snapshot.json                                      # session-9 Diff E (regenerated)
  host/src/generated/abi.ts                              # session-9 Diff E (regenerated)
  libc/glue/abi_constants.h                              # session-9 Diff E (regenerated)
  web-libs/kandelo-session/src/kernel-host.ts            # session-11 StrictMode memoization
  apps/browser-demos/test/kandelo-modeset.spec.ts        # session-11 case-insensitive regex (also session-12 pixel assertion)

New (untracked) — same as handoff-11 plus:
  programs/dri-modeset.c                                 # handoff-7 Diff 6 fixture
  docs/plans/2026-06-09-dri-kandelo-port-handoff-12.md   # THIS FILE
  apps/browser-demos/test/_debug-modeset.spec.ts         # session-12 debug helper — DELETE before commit
```

The 8 `packages/registry/<pkg>/build.toml` revision bumps from handoff-10 remain **not present** in the working tree.

## Reference points (additions in session 12)

- `masterCrtcForPid` helper: `host/src/dri/kms-registry.ts:33-44`.
- Auto-attach call site: `host/src/kernel.ts:740-762` (the `if (!b.canvas) { … }` block inside `host_gl_create_context`).
- `KernelCallbacks` field additions: `host/src/kernel.ts:133-148` (`getKmsCanvas`, `markKmsCanvasGlOwned`).
- Callback wiring on the kernel-worker side: `host/src/kernel-worker.ts:807-814` (inside the `new WasmPosixKernel(config, io, { … })` constructor argument).
- Mode tracking: `host/src/kernel-worker.ts:783-792` (`kmsContextMode: Map<crtcId, "2d"|"webgl2">`).
- Updated `attachKmsCanvas`: `host/src/kernel-worker.ts:8311-8331` (defer `getContext` acquisition).
- Updated `tickVblank` inner loop: `host/src/kernel-worker.ts:8351-8385` (iterate `kmsCanvases`, mode-gated, gl.list() guard, lazy 2D).
- Playwright pixel-content assertion: `apps/browser-demos/test/kandelo-modeset.spec.ts:33-58`.

## Important constraints, do not violate (carry-forward from v1–v11)

- One PR against `Automattic/kandelo:main`. All five test gates green first.
- Dual-host parity for any `host/src/` touch — kernel-worker.ts is shared, kernel.ts is shared. Confirm both hosts work after the session-12 Option A revision lands.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session.**
- Wait for user input before each commit.

## Open questions carried into session 13

- (Q1) Why is the PAGE_FLIP counter stuck at 0 in session 12 when it ticked freely in session 11 with the same kernel.wasm? The handoff-11 spec passed with that wasm.
- (Q2) Is `host/wasm/kandelo-kernel.wasm` (mtime 13:54) actually built from current `crates/kernel/src/`? If cargo cached against a different source tree the bytes could be silently stale. A `cargo clean` + rebuild would settle it but burns ~15 min.
- (Q3) The handoff-11 §"Open postmortem" doc-update about `local-binaries` short-circuit is still open. Either land it as a separate commit or stay quiet; it's not gating the PR.
