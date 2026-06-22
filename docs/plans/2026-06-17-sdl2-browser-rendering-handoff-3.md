# SDL2 browser rendering handoff #3 — animation 60 fps, audio plays for full 5 s, but audio jitter/lag appears mid-playback and persists to the end

Successor handoff to `2026-06-17-sdl2-browser-rendering-handoff-2.md`. Both real-browser-only symptoms from #2 are **resolved**: animation no longer throttles to ~1 fps when the mouse is still, and audio no longer cuts at ~1 s — it plays for the full 5 s. **One NEW real-browser-only symptom** has appeared mid-playback and persists: audio "shakes / lags" at some point during the run and continues stuttering until the demo exits.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`, tip still `4f88111bb`. NOT pushed. PR #709 untouched. Four predecessor handoffs (`fix`, `rendering`, `rendering-2`, this) describe the rolling state of the working tree.
2. **What's NEW in the working tree this session (all uncommitted, on top of all prior-session fixes):**
   - `host/src/kernel-worker.ts`: `tickVblank()` now calls `this.scheduleWakeBlockedRetries()` right after `kernel_vblank()`. The kernel's vblank tick has just drained pending page-flips into each open card0 fd's `event_ring`; broad-waking the pending poll retries makes the DRM `poll()` event-driven at 60 Hz instead of timer-bound at the generic 50 ms safety-net cadence. Without this hook the C-side `eglSwapBuffers → poll(drm_fd, -1) → drmHandleEvent` frame loop was capped at ~20 fps (1 / 50 ms) and demos lagged visibly in real Chrome until something else (mouse input, etc.) triggered a wake. Same broad-wake mechanism `injectMouseEvent` already uses; coalesced and no-op when no retries are pending.
   - `crates/kernel/src/audio/pcm_ioctl.rs::handle_writei`: after advancing `appl_ptr`, auto-transition `PREPARED → RUNNING` when `(appl_ptr - hw_ptr) >= sw_params.start_threshold`. This mirrors Linux's WRITEI auto-start. alsa-lib's `pcm_hw` plugin sets `own_state_check=1` AND its non-mmap writei path never inspects `start_threshold` itself — both Linux and the application rely on the kernel to do it here. SDL2 sets `start_threshold=1` and never issues `SNDRV_PCM_IOCTL_START` explicitly; without this fix the device stayed PREPARED forever, the period tick (which gates on `STATE_RUNNING`) skipped the OFD, `hw_ptr` never advanced, `writei` stalled EAGAIN after the ring filled (~341 ms of audio at 48 kHz × stereo × s16, ring = 64 KiB), and audio cut after one ring's playback.
   - `crates/kernel/src/audio/pcm_ioctl.rs::tests`: two new cargo tests — `writei_in_prepared_state_auto_starts_at_threshold` and `writei_below_threshold_stays_prepared`.
3. **Human spot-check (NEW, end of session):** human re-opened `http://127.0.0.1:5403/?demo=sdl2` and observed in real Chrome:
   - **§A (animation):** "Yes it rotates smoothly" — confirmed fixed.
   - **§B (audio length):** plays the full 5 s instead of cutting at ~1 s — confirmed fixed for total duration.
   - **NEW §C (audio jitter):** "it shakes or lags at one moment and it doesn't stop shaking or lagging until the end" — audio is *audible* throughout but stutters / glitches from some point onward and never recovers.
4. **Test suite results (this session, full CLAUDE.md battery, all post-fix):**
   - Cargo: **1074 / 1074** pass (up from 1072 in handoff-2; +2 from the new auto-start tests).
   - Vitest under dev shell: 886 pass, 1 pre-existing failure (`spidermonkey-node-compat.test.ts > installs cowsay` — same one documented in handoff-2 as unrelated to this work).
   - libc-test: exit 0, **0 unexpected FAILs** (XFAILs + 1 FLAKE-PASS `regression/pthread_cond-smasher` + 1 TIME `regression/raise-race` — all CLAUDE.md-acceptable).
   - Open POSIX Test Suite: exit 0, **0 FAILs** (3 XFAIL, 2 SKIP).
   - ABI snapshot: in sync, ABI_VERSION consistent. Output reports `snapshot changed and ABI_VERSION was bumped` + `ABI_VERSION and snapshot are consistent` — the bump is from the prior session (already in the working tree), this session added no ABI surface.
   - SDL2 vitest (Node-side): 2/2 pass.
   - Playwright `kandelo-sdl2.spec.ts` + `kandelo-modeset.spec.ts`: both green.
5. **Order for the next session:**
   1. Chase §C (audio jitter mid-playback that persists). See "Symptoms next session must resolve" below — top theories prepared but NOT empirically tested.
   2. Re-run the CLAUDE.md test suite once the §C fix lands (it was all-green this session post-fixes).
   3. Commit + PR only with explicit per-session approval.
6. **Do NOT:** push, `gh pr *`, regenerate the ABI 16 artifacts, bump `revision` fields, revert any of the prior-session fixes OR this session's two fixes (vblank-wake + writei auto-start — both independently necessary; handoff-2 already had four landed fixes that all stay).
7. **Dev-shell entry** (still required): `source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && bash scripts/dev-shell.sh bash -c '…'`. Vite dev server was running on **5403** at session end — restart with `bash scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx vite --host 127.0.0.1 --port 5403 --strictPort'` if it's gone.

## Root cause #1 — DRM `poll()` waited on the 50 ms generic safety-net retry, not on vblank events

`host/src/kernel-worker.ts`'s poll retry registers a `setTimeout(retryFn, 50ms)` for blocking polls without targeted wake sources (`pipeIndices.length || acceptIndices.length`). DRM `poll()` on `/dev/dri/card0` has neither pipe nor accept fds — it gates POLLIN on the per-fd `event_ring` actually holding a `DRM_EVENT_FLIP_COMPLETE` record. The vblank pump (`setInterval(tickVblank, 1000/60)`) drains pending flips into that ring at 60 Hz, but there was no event-driven hook telling the kernel-worker to wake the blocked poll — the poll retry was bound to the 50 ms safety net regardless.

**Headless evidence:** with a temporary instrumentation that exported `tickRate` / `pollRetries` / `pendingPolls` via `console.log` from `tickVblank()`, a playwright probe over the 5 s demo run measured:
- Baseline (no fix): `tickRate=62.5/s pollRetries=19/s pendingPolls=1` → frames=97 in 5 s → **19.2 fps**. 19 retries/s × 50 ms = 950 ms/s — the safety net was firing every 50 ms exactly.
- With fix: `tickRate=62.5/s pollRetries=0/s pendingPolls=1` → frames=315 in 5 s → **62.9 fps**. The 50 ms safety net never fires because the broad wake from vblank-tick beats it every time.

`scheduleWakeBlockedRetries()` is coalesced (returns early if no retries pending; uses `setImmediate` so timer / rendering events can interleave) and the kernel's own `injectMouseEvent` already calls it — same pattern, just extended to vblank-tick.

Real-Chrome confirmation from the human: "Yes it rotates smoothly."

## Root cause #2 — `handle_writei` never auto-started the PCM, so the period tick was a no-op and the ring drained once and stayed full

ALSA's playback state machine starts in OPEN, transitions to SETUP on `HW_PARAMS`, to PREPARED on `PREPARE`, and to RUNNING on `START`. Our `kernel_audio_period_tick` (`crates/kernel/src/audio/tick.rs`) only advances `mmap_status.hw_ptr` on OFDs with `state == SNDRV_PCM_STATE_RUNNING` — anything else is a deliberate no-op (matches Linux: a non-RUNNING device must not have its hw_ptr advanced).

The bug: nobody ever called `SNDRV_PCM_IOCTL_START` for the SDL2 device. SDL2's ALSA backend (`packages/registry/sdl2/sdl2-src/src/audio/alsa/SDL_alsa_audio.c`) sets `start_threshold=1` via `snd_pcm_sw_params_set_start_threshold` and then expects auto-start. alsa-lib's `pcm_hw` plugin (`packages/registry/alsa-lib/alsa-lib-src/src/pcm/pcm_hw.c`) marks itself `own_state_check=1` AND its non-mmap writei (`snd_pcm_hw_writei`) just calls `ioctl(fd, SNDRV_PCM_IOCTL_WRITEI_FRAMES, &xferi)` and returns. The auto-start logic in `snd_pcm_mmap_writei_areas` (the one I initially found, in `pcm.c:7691`) is on the **mmap** writei path and never fires for SDL's non-mmap path. So both Linux and SDL2 rely on the **kernel** to auto-transition PREPARED→RUNNING from inside its WRITEI handler. Our `handle_writei` skipped that step.

**Headless evidence:** with `window.__audioApplPtr` / `__audioTotalConsumed` / `__audioCtxState` exposed via a temporary instrumentation in `BrowserAudioDriver.applPtrPollHandle`, a playwright probe (with `--autoplay-policy=no-user-gesture-required` to bypass headless Chromium's autoplay gate) measured:
- **Before fix:** `applPtr=16384 (+16384)` on the very first sample, then `applPtr=16384 (+0) totalConsumed=16384 (+0) ctxState=running` for 7 s straight. The C-side wrote exactly one ring (16 384 frames at 48 kHz × stereo × s16 = 64 KiB), then `writei` returned EAGAIN forever because `delay = appl_ptr - hw_ptr = ring_frames`, so `avail = 0`. The worklet caught up its local `hwPtr` to `applPtr` and emitted silence past that.
- **After fix:** `applPtr` grows from 64 512 → 256 000 (≈ 5.3 s of audio) over the run, climbing by 4–6 k per 100 ms; `totalConsumed` keeps up at ~48 k frames/s (the full audio rate); ctx stays `running`. After the 5 s demo exits, both values pin at 256 000 / 242 944.

Real-Chrome confirmation from the human: "the sound is running during 5 seconds as expected."

`crates/kernel/src/audio/tick.rs::tick`'s XRUN gate (`new_hw_ptr > appl_ptr → state := SNDRV_PCM_STATE_XRUN`) stays in place — it's still the correct behavior when the host consumer truly outruns the userspace producer, and the two new tests confirm the auto-start fires only when `start_threshold` is genuinely reached.

## Symptoms next session must resolve

### §C — Audio jitter / lag appears mid-playback and persists to the end (NEW)

The human's exact words at session end:
> "the sound is running during 5 seconds as expected. But it shakes or lags at one moment and it doesn't stop shaking or lagging until the end after that so there is still an issue somewhere"

So: audio is *audible* throughout the 5 s run, but at some point glitches/stutters and never recovers smoothness. This is a real-browser-only symptom — the headless probe shows steady 4–6 k frames consumed per 100 ms throughout (no obvious starvation gap), but headless Chromium can't faithfully reproduce real-time audio.

**Top theories to test, in order of likelihood:**

1. **Self-induced XRUN once the SDL producer falls behind the worklet for a single quantum**, then the kernel sticks at XRUN forever. With the auto-start fix the device is RUNNING; `tick()` advances `hw_ptr` by every `period_tick` call. If the host accumulator (`framesSinceTick`) ever ticks the kernel by `periodFrames=1024` while the producer has only landed 1023 frames since the previous tick, `new_hw_ptr > appl_ptr` → state := XRUN. **From that point on `tick()` is a no-op** (state != RUNNING), `hw_ptr` is frozen, every subsequent `writei` works (the ring's effective `avail` keeps changing because writei recomputes from the stale `hw_ptr`), and audio still plays because `appl_ptr` keeps growing — but the producer-consumer feedback loop is broken and the timing slowly drifts. SDL's `snd_pcm_writei` returns `xferi.result` ≥ 0 even in XRUN state (our writei never returns `-EPIPE`), so SDL never calls `snd_pcm_recover` and never re-prepares the device. Stuttering, not silence — fits the symptom.
   - **Test:** add a kernel export `kernel_audio_get_state(pcm_id) -> u32`, query it from the host probe alongside applPtr / totalConsumed, and watch for the transition. If state flips to XRUN partway through, this theory holds.
   - **Fix candidates:** (a) make XRUN recoverable — when `writei` sees state==XRUN, treat as PREPARED again (some Linux drivers do this); (b) report `-EPIPE` from writei when state==XRUN so SDL's `ALSA_snd_pcm_recover` path runs; (c) tighten the XRUN gate so it doesn't fire on a one-period boundary slip — e.g. only mark XRUN when the deficit exceeds avail_min.

2. **`framesSinceTick` accumulator drifts because the host calls `kernelTick(pcmId, periodFrames=1024)` only when `framesSinceTick >= 1024`, but `framesSinceTick` is incremented by `data.framesConsumed` per worklet quantum (128 frames or less).** If the worklet ever consumes < 128 in one quantum (because applPtr - hw < 128), the next quantum the accumulator catches up and the kernel's period tick fires with the full 1024. The kernel sees a 1024-frame tick at a moment when the producer has only landed (say) 900 frames since the previous tick — XRUN. Subset of #1, finer-grained.

3. **AudioWorklet runs on a separate (audio) thread; main-thread `applPtr` polling at 10 ms is too coarse for tight feedback.** The 10 ms async hop (main → kernel worker → audio_get_appl_ptr → main → worklet) is a hard floor on how stale the worklet's `applPtr` can be. The worklet emits silence past its local `applPtr`. If the producer is barely keeping up, that 10 ms latency causes intermittent micro-silence as the worklet over-runs and under-runs the producer-pointer cache. The chronic-stuttering character matches this. **Test:** lower the poll interval (4 ms is the browser timer minimum) or push the applPtr directly via a SharedArrayBuffer so the worklet reads it without a postMessage. **Fix:** SAB-backed applPtr pointer would be the principled solution.

4. **GL throughput catching up after §A landed slows the C-side enough that audio production becomes bursty.** Pre-§A the C-side ran at 19 fps; SDL_PumpAudioDevices fired 19×/s producing 19×1024 = 19 456 frames/s, *less* than 48 000 frames/s consumption — net deficit, audio would have starved (which matches the predecessor symptom "audio cuts at ~1 s"). Post-§A it runs at 60 fps producing 60 × 1024 = 61 440 frames/s, a 28% surplus over consumption. Surplus + ring back-pressure (EAGAIN) means the audio pump is no longer a steady-rate pulse; whenever the ring fills, the next pump's writei is a no-op, then a frame later the ring has space again, then writei lands 1024 frames in a burst. The kernel `period_tick` matches realtime; the audio path sees burstiness. Probably not the dominant cause but worth a sanity check.

**Where to look:**
- `crates/kernel/src/audio/tick.rs::tick` — the XRUN gate (lines 87–92).
- `crates/kernel/src/audio/pcm_ioctl.rs::handle_writei` — does it need to clear XRUN before working? Linux's behavior is debatable; we should make a defensible call.
- `host/src/audio/browser-audio-driver.ts::start` — the 10 ms applPtr poll + accumulator-to-period tick.
- `host/src/audio/wpk-audio-worklet.js` — the `applPtr - hw` gate.
- `host/src/browser-kernel-host.ts::attachAudioDriver` — the async `getApplPtr` cache and its 1-in-flight semantics. If a poll lands between two writei calls, the worklet sees a stale applPtr for ~10 ms which is half a worklet-quantum's audio rate.

**Suggested experiment order (cheapest first):**
1. Add `kernel_audio_get_state` export + log it from the probe. If state goes to XRUN mid-run, theory #1/#2 is the cause and a kernel-side fix is the lever.
2. If state stays RUNNING: drop applPtr poll interval from 10 ms to 4 ms and see if the jitter window shrinks. If yes, theory #3.
3. If neither: instrument period-tick / writei timing distributions and look for bursts.

### §A (animation throttle) and §B (audio cuts at ~1 s) — both RESOLVED

Both real-Chrome confirmed. The §A fix (vblank → broad wake) and §B fix (writei auto-start at start_threshold) are independent and both load-bearing. Do NOT revert either.

## Working tree state — exact files (all sessions cumulative, this session adds two M's)

Run `git status --short` for the canonical list. As of session end:

```
 M apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts        ← prior-session: SDL2 audio wiring
 M apps/browser-demos/pages/kandelo/presets.ts
 D apps/browser-demos/test/kandelo-espeak.spec.ts
 D apps/browser-demos/test/kandelo-evdev.spec.ts
 M crates/kernel/src/audio/pcm_ioctl.rs       ← prior: WRITEI EAGAIN; **this session: auto-start PREPARED→RUNNING + 2 tests**
 M crates/kernel/src/syscalls.rs
 M crates/shared/src/lib.rs                   ← prior: ABI_VERSION bump
 M host/src/kernel-worker.ts                  ← prior: SYS_IOCTL EAGAIN + firstKmsCanvasCrtc; **this session: scheduleWakeBlockedRetries in tickVblank**
 M host/src/kernel.ts                         ← prior: tryAttachKmsCanvasToGl + viewport shadow seed
RM host/test/sdl2-demo.test.ts -> host/test/sdl2.test.ts
 M images/vfs/scripts/build-shell-vfs-image.ts
 M packages/registry/sdl2/build-sdl2.sh
 D programs/evdev_demo.c
RM programs/sdl2_demo.c -> programs/sdl2/main.c
 M programs/sdl2_alsa_smoke.c
 M programs/sdl2_kmsdrm_smoke.c
 M scripts/build-programs.sh
?? apps/browser-demos/test/kandelo-sdl2.spec.ts                ← prior: tightened gates
?? docs/plans/2026-06-17-sdl2-browser-fix-handoff.md           ← predecessor #1
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff.md     ← predecessor #2
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff-2.md   ← predecessor #3
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff-3.md   ← this file
```

(Plus the carry-over `?? docs/plans/2026-06-…-dri-kandelo-port-handoff-*.md` files from prior sessions — not relevant unless squashing the docs/plans directory.)

### Background processes

A Vite dev server was running on port **5403** at session end. Restart command in §1.7 of TL;DR.

### Stale `shell.vfs.zst`

Still stale (Jun 17 10:20), same caveat as predecessor handoffs. Optional cleanup before merge.

## Why none of the prior six landed fixes are suspects for the new §C

1. **Fix 1 (legacy ADDFB)** — purely additive ioctl number, no audio impact.
2. **Fix 2 (kernel WRITEI EAGAIN)** — gates EAGAIN return on full-ring + non-zero request. The new symptom is mid-playback stutter, not EAGAIN-flap; if EAGAIN logic regressed, we'd see audio cut entirely, not stutter.
3. **Fix 3 (host SYS_IOCTL EAGAIN)** — only fires when the kernel returns `(-1, EAGAIN)` for an ioctl. No structural effect on the period-tick / writei feedback loop.
4. **Fix 4 (tryAttachKmsCanvasToGl + viewport shadow seed)** — render-path only, no audio impact.
5. **Fix 5 (this session: tickVblank → scheduleWakeBlockedRetries)** — wakes blocked DRM polls, not blocked ALSA polls. ALSA polls in this demo are not blocking anyway (SDL's polled-audio path early-exits on EAGAIN — it never registers a blocking poll). Test: cargo's full suite (1074/1074) covers the ALSA poll path; if this fix broke ALSA poll, those would fail.
6. **Fix 6 (this session: writei auto-start)** — IS structural for audio, but cargo tests confirm correctness in the threshold-met / threshold-not-met cases. If §C is caused by this fix, the lever is the XRUN gate downstream of it, not the auto-start itself.

§C is most likely an *exposed* pre-existing weakness — the audio path used to die after ~1 s and never had a chance to expose this jitter; now that audio runs for the full 5 s, the latent issue is visible.

## Things NOT to do

- Do NOT push or `gh pr *`. Branch stays local.
- Do NOT commit, push, or PR without explicit per-session approval. **End-of-session note: human reviewed §A + §B fixes in a real browser and confirmed they work, but the §C jitter discovery means we're not ready to commit — fix §C first.**
- Do NOT bump `revision` fields in `build.toml` files.
- Do NOT regenerate the ABI 16 artifacts already in `local-binaries/programs/wasm32/`.
- Do NOT revert any of the six landed fixes — they are all independently necessary.
- Do NOT add an SDL2-side patch to call `drmModeAddFB2` instead of `drmModeAddFB`. The kernel-side legacy-ADDFB shim is the chosen path.
- Do NOT loosen the new Playwright spec gates (`>3 500` per-sample, `>400` byteLength spread across 5 samples).
- Do NOT change `tick()` to advance hw_ptr in non-RUNNING states. The non-RUNNING gate is the correct Linux behavior; the fix for §C lives upstream (whether XRUN is reachable) or downstream (how/whether XRUN recovers), not in the gate itself.

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-sdl2-browser-rendering-handoff-3.md` first, then its predecessors `-2.md`, `-rendering-handoff.md`, and `-fix-handoff.md`. Branch is `explore-dri-sdl2`, tip still `4f88111bb` (NOT pushed, PR #709 untouched). Working tree has Phase 0 SDL2 rename + the three prior-session kernel/host EAGAIN fixes + the prior-session canvas-renders fix + **this session's two fixes**: (1) `host/src/kernel-worker.ts::tickVblank()` now calls `this.scheduleWakeBlockedRetries()` so DRM `poll()` wakes at vblank cadence (60 Hz) instead of the 50 ms generic safety-net (headless went 19 fps → 63 fps; human confirmed smooth rotation in real Chrome); (2) `crates/kernel/src/audio/pcm_ioctl.rs::handle_writei` auto-transitions PREPARED→RUNNING when `(appl_ptr - hw_ptr) >= sw_params.start_threshold` (mirrors Linux's WRITEI auto-start; SDL2 sets start_threshold=1 and never issues IOCTL_START explicitly; alsa-lib's pcm_hw has `own_state_check=1` and its non-mmap writei never inspects start_threshold itself; without this fix audio cut at ~1 s after the ring filled — human confirmed audio plays for the full 5 s now). Two new cargo tests in `pcm_ioctl.rs::tests` cover both threshold-met and threshold-not-met cases (1074/1074 cargo pass). §A (animation throttle) and §B (audio cuts at ~1 s) are RESOLVED. **One NEW real-browser-only symptom (§C) remains: audio shakes/lags mid-playback and the stutter persists until the demo exits.** Top theory: a one-period producer-vs-consumer slip triggers XRUN (`new_hw_ptr > appl_ptr` in `tick.rs::tick`), `tick()` stops advancing hw_ptr (state != RUNNING), `writei` keeps succeeding (we don't return -EPIPE on XRUN), so SDL never calls snd_pcm_recover, the producer-consumer feedback breaks and timing drifts. Suggested order: (1) add a kernel export `kernel_audio_get_state(pcm_id) -> u32`, query from a `BrowserAudioDriver` instrumentation that also exposes `__audioApplPtr` / `__audioTotalConsumed` (the probe pattern from this session — see handoff-3 §'Root cause #2 — Headless evidence' for the working setup), and watch for the PREPARED→RUNNING→XRUN transition mid-run; (2) if XRUN fires, decide between making it recoverable in `handle_writei` (drop back to PREPARED on writei into XRUN) vs reporting -EPIPE so SDL's `snd_pcm_recover` path runs vs tightening the XRUN gate to require deficit ≥ `sw_params.avail_min` before latching; (3) if state stays RUNNING, drop the 10 ms applPtr poll interval to 4 ms or move the pointer into a SAB so the worklet reads it without a postMessage round-trip; (4) re-run CLAUDE.md test suite (it was all-green this session post-fixes, but §C work will touch the kernel ALSA path so re-run cargo, vitest, libc-test, POSIX, ABI snapshot); (5) commit + PR only with explicit per-session approval. Pre-existing vitest failure `spidermonkey-node-compat > installs cowsay (Cannot find module '/usr/local/lib/kandelo/npm-runner.js')` is NOT caused by this work. Dev-shell entry: `source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && bash scripts/dev-shell.sh bash -c '…'`. Vite dev server was running on 5403 — restart with `bash scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx vite --host 127.0.0.1 --port 5403 --strictPort'` if it's gone. Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR."*
