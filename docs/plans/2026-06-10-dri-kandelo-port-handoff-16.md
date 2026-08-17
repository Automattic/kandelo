# DRI port onto kandelo:main — session 16 handoff

Continuation of [2026-06-10-dri-kandelo-port-handoff-15.md](./2026-06-10-dri-kandelo-port-handoff-15.md). Read that first; this doc only covers what changed in session 16.

## TL;DR — read this twice

1. **Session 15's "mouse queue empty at read time" bug was FALSE.** New diagnostic exports `kernel_mouse_queue_len()` + `kernel_mouse_owner()` proved the inject and read paths share `crate::mouse::GLOBAL` exactly as the architecture says. The queue accumulates after each inject and drains between injects (consistent `qLenBefore=0, qLenAfter=3, owner=100`). modeset.c was reading EAGAIN in v15 because of an unrelated condition that has since cleared itself — likely the `MICE_OWNER` race got resolved when modeset's open path completed *after* the early `[DIAG S15 drain]` probes fired. The mouse delivery path is healthy.
2. **modeset.c is fully rewritten as a 1:1 port of Pavel's `script.js`.** Bloom (prefilter + 7-level pyramid + final), sunrays (mask + 16-step radial sweep + separable blur), shading (sobel-style display normal), gamma, `multipleSplats(20)` boot seed — all of it. The visual at boot is "showing the projection correctly" per the user — meaning the boot splats look like a real Pavel-style fluid sim for ~2 frames. Then it degrades.
3. **NEW bug visible to the user: mouse-driven splats don't sustain the fluid.** Boot frames render correctly (multipleSplats produces 20 bright vortices), then the sim collapses. Mouse interactions produce splats but the fluid doesn't develop swirls or persist. Hypothesis below — most likely the same kernel-side ~3000 Hz hot-loop documented as Q4 in v15, which over-dissipates dye and velocity by ~50× per real frame.

## Mission (carried from v15)

> *"Analyze the whole code you built for DRI KMS, and also analyze thoroughly Pavel's demo at https://github.com/PavelDoGreat/WebGL-Fluid-Simulation. Make it work once and for all."*

## What I did this session

### 1. Diagnostic exports proved the mouse queue is shared

Added two additive-compatible wasm exports to `crates/kernel/src/wasm_api.rs:10430-10446`:

```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mouse_queue_len() -> u32 {
    crate::mouse::queue_len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_mouse_owner() -> i32 {
    crate::mouse::MICE_OWNER.load(core::sync::atomic::Ordering::SeqCst)
}
```

Wired into `host/src/kernel.ts::injectMouseEvent` (line 270) so every 20th inject logs `{n, dx, dy, buttons, qLenBefore, qLenAfter, owner}`. Result during a probe drag (pid 100 = modeset):

```
[DIAG S16 inject] {"n":1,"dx":-128,"dy":63,"buttons":0,"qLenBefore":0,"qLenAfter":3,"owner":100}
[DIAG S16 inject] {"n":21,"dx":8,"dy":4,"buttons":0,"qLenBefore":0,"qLenAfter":3,"owner":100}
[DIAG S16 inject] {"n":81,"dx":-21,"dy":13,"buttons":1,"qLenBefore":0,"qLenAfter":3,"owner":100}
... (qLenBefore=0 consistently, qLenAfter=3 after each inject, owner=100 stable)
```

Three signals:
- `owner=100` — a process owns the device. Pid 100 ≈ modeset.
- `qLenBefore=0` — the previous inject's packet was drained before this inject. So `read()` IS pulling bytes (otherwise queue would grow to 4096 bytes max).
- `qLenAfter=3` — one packet enqueued per inject.

So the v15 hypothesis ("queue is in the wrong memory view") is wrong. The kernel-wasm-instance memory is shared between inject and read as designed. Drop that line of investigation.

**What likely caused v15's EAGAIN-forever symptom:** The `[DIAG S15 drain]` print sampled the first 3 reads after `open(mice)` returned, before any inject. We logged `n=-1 errno=EAGAIN` then concluded the queue was always empty. We didn't sample later in the run. Mouse events were probably arriving fine the whole time — the probe just happened to land in a quiet window.

### 2. modeset.c — full Pavel port

Replaced `programs/modeset.c` with a verbatim translation of Pavel's `script.js` to GLES2 + EGL. ~900 lines. New artifacts:

| Component | Lines | Source |
|---|---|---|
| **9 shader sources** | `display_fs` rebuilt with `#define SHADING/BLOOM/SUNRAYS` injected at link time; `blur_vs`/`blur_fs`/`bloom_prefilter_fs`/`bloom_blur_fs`/`bloom_final_fs`/`sunrays_mask_fs`/`sunrays_fs` all new | github.com/PavelDoGreat/WebGL-Fluid-Simulation/blob/master/script.js, verbatim |
| **`compile_link_with_defines`** helper | new; prepends `#define X\n` lines to fragment source so `Material.setKeywords()` equivalent works | n/a |
| **`apply_bloom`** | full Pavel impl: prefilter (soft-knee at threshold 0.6) → 7-level Gaussian downsample chain → additive upsample with `glBlendFunc(GL_ONE, GL_ONE)` → final 4-tap blur × `BLOOM_INTENSITY` | `applyBloom` |
| **`apply_sunrays`** | mask→.a, 16-step radial sweep | `applySunrays` |
| **`blur_sunrays(1)`** | separable horizontal+vertical blur | `blur` |
| **`pass_display`** | sobel SHADING * SUNRAYS + `linearToGamma(bloom * sunrays)` additive | `displayShader` |
| **`multiple_splats(20)`** | boot seed; color × 10, ±500 velocity per splat | `multipleSplats` |
| **Resolutions** | hardcoded for 1920×1080 via Pavel's `getResolution(N)`: sim 228×128, dye 1820×1024, bloom 456×256, sunrays 349×196 | `getResolution` |

Verified Pavel's reference via WebFetch — important corrections from session 15:
- **Both advect calls use `velocity.texelSize`, NOT dye.texelSize.** My session 15 message claimed dye.texelSize for dye advection; that's wrong. Only `dyeTexelSize` differs, and that's used only inside `#ifdef MANUAL_FILTERING` — dead code since we have `OES_texture_float_linear`.
- **Click splat is 10× brightness (Pavel `clickSplat`), not 3×.** modeset.c click_edge handling removed entirely — Pavel doesn't have one, splats only fire on motion-while-held.
- **`splatPointer` passes deltaY unflipped** because Pavel's `texcoordY = 1 - posY/H` is already Y-up. Our modeset.c flips `-vy` at the splat boundary because our `cursor_y` is still browser-down. Equivalent.

Build:
```
PATH=/nix/var/nix/profiles/default/bin:$PATH WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk scripts/dev-shell.sh bash -c \
  'WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk scripts/build-programs.sh'
```

Output `local-binaries/programs/wasm32/modeset.wasm` 65 KB (was 57 KB). Build clean, no warnings.

### 3. Visual result — partial

User feedback after rebuild + reload of `./run.sh browser`:

> *"Well, still not correctly understanding the mouse. But the 2 frames before are showing the projection correctly. So there is still a problem between the mouse and the modeset demo. Something like not interpreting the intensity of the mouse movement?"*

Interpretation: the **boot multipleSplats(20) produces a real Pavel-style frame for ~2 vblanks** — meaning the bloom + sunrays + shading + display pipeline is functionally correct end to end. Then the sim collapses to dim ink under mouse input.

## The next bug to chase in session 17

**Working hypothesis (DO NOT take as established): the kernel-side ~3000 Hz hot-loop documented as Q4 in v15 is over-dissipating the fluid by ~50× per real frame.**

Evidence:
- v15 §H9: `kernel_kms_commit_count` advances at ~3000 Hz while the host vblank pump nominally runs at 60 Hz. modeset's `kms_pageflip_wait()` doesn't actually throttle.
- modeset.c hardcodes `DT = 1.0f / 60.0f` in vorticity / advect / pressure. The sim assumes 60 Hz wall-clock pacing.
- At 3000 Hz, between two real monitor frames (16.67 ms) we run ~50 sim steps. Density dissipation is `1.0` per step (decay factor `1/(1+1*1/60) ≈ 0.984` per step). After 50 steps: `0.984^50 ≈ 0.45` per real frame. After 2 monitor frames the dye is at `0.20` of its original brightness, after a third at `0.09`. Velocity is even worse (vorticity adds energy but advection dissipates).
- The 20-splat boot seed dumps 20× max-brightness dye into the texture in a single first frame; even with aggressive dissipation, the user perceives a few coherent frames of fluid before it collapses. Matches the "2 frames before are showing the projection correctly" report.
- Mouse drag splats inject *one small splat per frame* (whichever frame the mouse moved); they can't outrun the per-frame dissipation, so they fade before any swirl or curl develops.

**Confirm before fixing:**

1. Add a counter to modeset.c main loop: print `frames/sec` every 60 frames. If it logs ~3000/s (= 50× over), the hypothesis is confirmed.

   ```c
   static int s_frame_n = 0;
   static struct timespec s_prev = {0,0};
   s_frame_n++;
   if (s_frame_n >= 60) {
       struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
       double dt = (now.tv_sec - s_prev.tv_sec) + (now.tv_nsec - s_prev.tv_nsec) / 1e9;
       fprintf(stderr, "[FPS] %.1f\n", 60.0 / dt);
       s_frame_n = 0;
       s_prev = now;
   }
   ```

2. **Then either:**
   - **(A) Fix the kernel-side vblank gating** so `read(drm_fd)` for `PAGE_FLIP_EVENT` actually blocks at 60 Hz. See `host/src/kernel-worker.ts` "vblank pump" + the kernel-side `PAGE_FLIP_EVENT` handler. This is the right fix architecturally — keeps modeset.c as-is and matches every other vblank-driven program's expectations.
   - **(B) Compute real wall-clock dt per frame in modeset.c** and pass that as the `dt` uniform instead of `1/60`. This makes the sim correct at any frame rate but diverges from Pavel's reference (he uses real dt too — same fix).

   (B) is cheaper and doesn't risk regressing the rest of the kernel; (A) is more correct. Prefer (B) for an immediate visual fix and file (A) as carried-forward Q4 for the perf pass.

3. **If FPS is actually 60** (i.e., the hypothesis is wrong), the issue is somewhere else. Then check:
   - Velocity dissipation is correct (`VEL_DISSIPATION = 0.2`).
   - Vorticity confinement is producing curl — instrument `pass_vorticity` to readPixels the velocity texture mid-pipeline.
   - Pressure projection isn't zeroing velocity — same probe, after `pass_gradient_subtract`.
   - The mouse delta scaling: confirm `vx/vy` are reaching the splat shader at expected magnitudes (one printf per drag splat).

### What NOT to retry

- Don't re-walk the v15 "queue empty at read" hypothesis. The S16 diagnostic ruled it out.
- Don't add a bloom-less brightness boost to the display shader. Pavel's full bloom is in and works (the boot frames prove it).
- Don't touch the shader sources — they're verbatim from Pavel's repo.
- Don't change resolutions away from `getResolution(N)` outputs (228/1820/456/349). Match Pavel.
- Don't bump `ABI_VERSION`. The two new exports (`kernel_mouse_queue_len`/`kernel_mouse_owner`) are additive-compatible.

## Cleanup before commit (do NOT commit these)

| File | Change to revert |
|---|---|
| `host/src/kernel.ts` | Remove the `_s16MouseInj` counter and the `[DIAG S16 inject]` console.log block in `injectMouseEvent` (lines ~270–292). |
| `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` | Restore the v15 stderr/stdout console wiring to its original form (already needed per v15 cleanup table). |

The new kernel exports `kernel_mouse_queue_len` / `kernel_mouse_owner` in `crates/kernel/src/wasm_api.rs` are additive — keep or remove; they don't gate the next-session fix.

The new `programs/modeset.c` is intentional and should commit. The build output `local-binaries/programs/wasm32/modeset.wasm` is gitignored.

## Working-tree state at end of session 16

Modified vs end-of-v15:
- `programs/modeset.c` — rewritten (full Pavel port).
- `crates/kernel/src/wasm_api.rs` — added two diagnostic exports.
- `host/src/kernel.ts` — `[DIAG S16 inject]` block (revert before commit).

Untracked addition:
- `docs/plans/2026-06-10-dri-kandelo-port-handoff-16.md` — THIS FILE.

Everything else as in v15.

## Reference points (additions this session)

- `programs/modeset.c:1-900` — full Pavel port.
- `programs/modeset.c:apply_bloom` — bloom pipeline.
- `programs/modeset.c:apply_sunrays` + `blur_sunrays` — sunrays pipeline.
- `programs/modeset.c:multiple_splats` — boot seed at startup.
- `programs/modeset.c:main` loop — pass order matches Pavel's `step()` + `render()`.
- `crates/kernel/src/wasm_api.rs:10434-10446` — `kernel_mouse_queue_len` / `kernel_mouse_owner` exports.
- `host/src/kernel.ts:270-292` — `[DIAG S16 inject]` diagnostic (revert before commit).

## Open questions carried into session 17

- (Q1, NEW) Is modeset.c's main loop actually running at ~3000 Hz (the same rate v15 measured for `kernel_kms_commit_count`)? If yes, the fluid sim is over-dissipating ~50× per real frame and that fully explains "boot looks right, mouse looks broken."
- (Q2, carried from v14) The 103 vitest `exnref` failures on this branch — still unresolved.
- (Q3, carried from v14) Is `channel: "chromium"` (new-headless) safe for the other Playwright projects?
- (Q4, carried from v14/v15) Why does `kernel_kms_commit_count` advance at ~3000 Hz when modeset.c is gated by `kms_pageflip_wait()` and the vblank pump runs at 60 Hz? **Promoted from "perf cleanup" to "likely root cause of the user-visible visual bug" in this session.**

## Standing instruction for the next session

**Print this sentence in the next session's first turn so I have a single fixed entry point:**

> *"Read `docs/plans/2026-06-10-dri-kandelo-port-handoff-16.md` first. Then revert the `[DIAG S16 inject]` block in `host/src/kernel.ts` per its 'Cleanup before commit' table. Then verify hypothesis Q1: add a one-shot fps printf to `programs/modeset.c::main`, rebuild via `PATH=/nix/var/nix/profiles/default/bin:$PATH WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk scripts/dev-shell.sh bash -c 'WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk scripts/build-programs.sh'`, and read the stderr in `./run.sh browser`. If FPS is ~3000 Hz, apply fix B from §"The next bug to chase": replace the hardcoded `DT = 1.0f/60.0f` with a real `clock_gettime(CLOCK_MONOTONIC)` delta capped to a reasonable range (e.g. 1/120 .. 1/15 seconds) and rebuild. If FPS is ~60 Hz, drop fix B and trace the velocity field instead — check whether vorticity is producing curl with a temporary readPixels probe inside `pass_vorticity`. Do NOT re-walk the v15 'queue empty at read' bug — S16 diagnostic ruled it out. Do NOT bloom-less-boost the display shader; the boot frames already prove bloom works. Do NOT bump ABI_VERSION; the new exports are additive. Branch is `explore-direct-rendering-infrastructure` on Automattic/kandelo — do NOT push, do NOT push to mho22. SpiderMonkey needs `WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` exported inside the inner `bash -c`. Wait for user input before each commit, per the standing instruction."*
