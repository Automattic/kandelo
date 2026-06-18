# SDL2 browser rendering handoff #4 — §C "stutter mid-playback" persists despite SAB-backed appl_ptr; XRUN and poll-latency theories both refuted by real-Chrome data

Successor handoff to `2026-06-17-sdl2-browser-rendering-handoff-3.md`. Two of handoff-3's prime theories for §C are now empirically ruled out, but the audible stutter is unchanged. Working tree adds a kernel + host + worklet implementation of SAB-backed `appl_ptr` mirroring (architecturally clean, still load-bearing — do NOT revert), three new read-only audio probes, and a 50 ms time-series probe in `live-setup.ts` that the next session will keep iterating on.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`, tip still `4f88111bb`. NOT pushed. PR #709 untouched. Five predecessor handoffs (`fix`, `rendering`, `rendering-2`, `-3`, this) describe the rolling state of the working tree.
2. **What's NEW in the working tree this session** (all uncommitted, on top of all prior-session fixes):
   - **3 new kernel exports** (additive ABI — no `ABI_VERSION` bump needed; `check-abi-version.sh` is clean):
     - `kernel_audio_get_hw_ptr(pcm_id) -> i64` — read-only probe of `mmap_status.hw_ptr`.
     - `kernel_audio_get_state(pcm_id) -> i32` — read-only probe of `SNDRV_PCM_STATE_*`.
     - `kernel_audio_init_appl_ptr_sab(pcm_id, base) -> ()` — bind a 4-byte slot in kernel-visible memory that the kernel mirrors `mmap_control.appl_ptr` into on every `WRITEI_FRAMES`.
   - **Kernel side** (`crates/kernel/src/audio/sab.rs`): second per-PCM address-book table (`appl_ptr_addr`) + `register_appl_ptr` / `appl_ptr_addr` / `publish_appl_ptr`. 4 new cargo tests.
   - **Kernel side** (`crates/kernel/src/audio/pcm_ioctl.rs::handle_writei`): one-line `crate::audio::sab::publish_appl_ptr(plan.pcm_id, ctl.appl_ptr)` after `appl_ptr` advance. Skipped when no slot is bound. 2 new cargo tests.
   - **Kernel side** (`crates/kernel/src/audio/tick.rs`): `current_hw_ptr` / `current_state` paired with the existing `current_appl_ptr`.
   - **Host plumbing** (`host/src/kernel.ts`, `host/src/kernel-worker.ts`, both browser + node `*-kernel-protocol.ts` / `*-kernel-worker-entry.ts` / `*-kernel-host.ts`): 4 new async methods (`audioGetHwPtr`, `audioGetState`, `audioAllocApplPtrSab`, `audioInitApplPtrSab`). Dual-host parity per CLAUDE.md §"Two hosts".
   - **Audio driver** (`host/src/audio/audio-driver.ts`): new `AudioApplPtrSab` interface; `AudioDriver.start` gains an optional `applPtrSab` parameter. `instrumented-audio-driver.ts` forwards it; `node-audio-driver.ts` accepts-and-ignores; `browser-audio-driver.ts` passes it to the worklet's `processorOptions` and skips the legacy 10 ms `setInterval` poll + `postMessage(applPtr)` when bound.
   - **Worklet** (`host/src/audio/wpk-audio-worklet.js`): when `applPtrBuffer` is present in `processorOptions`, every `process()` quantum refreshes `applPtr` via `Atomics.load(new Int32Array(buf, off, 1), 0) >>> 0`. Legacy `{ applPtr }` message path retained as fallback for hosts that don't bind a slot.
   - **Probe** (`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`): under the SDL2 demo branch, a `setInterval(50ms)` polls `kernel_audio_get_appl_ptr` / `kernel_audio_get_hw_ptr` / `kernel_audio_get_state` plus the wrapper's `framesConsumed()` and pushes a `{t, state, appl, hw, consumed}` sample to `window.__audioLog`. Cleared on demo exit. Next session keeps iterating on this — extend it with `audioCtx.sampleRate` etc.
3. **Empirical findings from this session (real Chrome at 127.0.0.1:5403/?demo=sdl2)** — two separate runs after § A + §B + auto-start fixes from handoff-3:
   - **Pre-SAB-fix (probe only, legacy 10 ms `getApplPtr` poll still active):**
     - `states observed = [0, 3]` only. **State NEVER transitions to XRUN (4)** at any point in the 5 s run. Handoff-3's prime suspect — theory #1, XRUN latch breaking the feedback loop — is **REFUTED**.
     - `hw == consumed` at every sample. The period-tick feedback loop is correct: kernel-side `hw_ptr` advances exactly in lockstep with worklet consumption.
     - `mean cons rate = 42 435 frames/s`, `mean appl rate = 45 132 frames/s`. AudioContext is requested at 48 000. The cons-rate shortfall is ~12 % of expected; that's the audible stutter.
     - `gap = appl − hw` oscillates between 15 360 and 16 384 (one period less than ring or full ring). Ring stays saturated throughout; the producer is NOT starving in any obvious way.
   - **Post-SAB-fix (kernel mirrors `appl_ptr` on every writei; worklet reads via `Atomics.load`):**
     - `states = [0, 3]` — same.
     - `mean cons rate = 43 337 frames/s`, `mean appl rate = 45 722 frames/s`. Essentially **unchanged** vs pre-fix.
     - Only one low-cons sample across the whole run (`{t: 3703, dt: 52, applRate: 59077, consRate: 39385}`). Distribution looks the same as before.
     - **User confirms stutter still audible mid-playback.** Theory #3 — poll-latency-induced silence — is **REFUTED**: removing the entire `setInterval` → `getApplPtr` → `postMessage` chain (~10–15 ms cumulative latency) did not change the silence-emission rate.
4. **Test suite status (this session, all post-this-session-fixes):**
   - Cargo audio subset (`pcm_ioctl`, `audio::sab`, `audio::tick`): 77/77 pass — including 2 new `writei_publishes_appl_ptr_to_sab_mirror_when_registered`, `writei_without_appl_ptr_sab_does_not_panic`, and 4 new SAB-table tests.
   - Vitest (`test/audio-driver.test.ts`, `test/instrumented-audio-driver.test.ts`, `test/sdl2.test.ts`): 13/13 pass.
   - ABI snapshot: in sync. Diff is additive-only (three new exports, all read-only or init-time). No `ABI_VERSION` bump needed; `check-abi-version.sh` reports both "snapshot up-to-date" and "ABI_VERSION and snapshot are consistent" — the latter notes the bump that already happened in a prior session.
   - **NOT re-run this session**: full cargo (1074), full vitest, libc-test, POSIX, ABI snapshot end-to-end, kandelo-sdl2 + kandelo-modeset Playwright. Next session must run the full battery once §C lands.
5. **Order for the next session:**
   1. Read this handoff first, then the predecessors in reverse-chronological order (`-3`, `-rendering-handoff-2`, `-rendering-handoff`, `-fix-handoff`).
   2. Resume chasing §C — see "Symptoms next session must resolve" below. Both prime handoff-3 theories are now refuted; the section below ranks the **remaining** theories and prescribes the cheapest disambiguating experiments.
   3. Re-run the CLAUDE.md test battery once the §C fix lands.
   4. Commit + PR only with explicit per-session approval.
6. **Do NOT:**
   - Revert the SAB-backed `appl_ptr` plumbing. It is architecturally correct (removes a real ~10 ms hot-path latency from the producer/consumer feedback loop) even though it did not fix §C. Future maintenance gains alone justify keeping it; the hot-path simplification is a positive of its own. The cargo tests pin the behavior.
   - Revert any of the six landed fixes from handoff-3 and earlier.
   - Push, `gh pr *`, regenerate the ABI 16 artifacts, or bump `revision` fields.
   - Add `setInterval` polls back to `BrowserAudioDriver` for production code. The legacy poll path is kept as a runtime fallback ONLY for hosts that haven't bound an `applPtrSab` slot (e.g., older kernels in the wild). Don't expand its use.
7. **Dev-shell entry** (still required): `source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && bash scripts/dev-shell.sh bash -c '…'`. Vite dev server was running on **5403** at session end — restart with `bash scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx vite --host 127.0.0.1 --port 5403 --strictPort'` if it's gone.

## What we measured — full data tables

### Pre-SAB-fix (legacy 10 ms `getApplPtr` poll active)

Probe ran for 5 s, 114 samples (50 ms interval). User reported audible stutter starting ~2 s in.

```
states observed:        [0 (OPEN), 3 (RUNNING)]   ← never XRUN
mean cons rate:         42 435 frames/s            (= 88 % of 48 000)
mean appl rate:         45 132 frames/s            (= 94 % of 48 000)
gap = appl − hw:        15 360 .. 16 384           (one period less than ring OR full ring)
low-cons samples below 40 000 (outside startup ramp):  3 samples at t=2003, t=3052, t=4253; consRate=39 385 each, applRate=39 385 each (perfect lockstep)
representative window around t=2000 (the moment stutter began audibly):
  t=1801 applRate=40960 consRate=61440 gap=15360
  t=1852 applRate=40157 consRate=40157 gap=15360
  t=1902 applRate=61440 consRate=40960 gap=16384
  t=1951 applRate=41796 consRate=62694 gap=15360
  t=2003 applRate=39385 consRate=39385 gap=15360
  t=2051 applRate=64000 consRate=42667 gap=16384
  t=2101 applRate=61440 consRate=61440 gap=16384
```

`appl` and `cons` rates oscillate between ~40 k and ~62 k — that's the 50 ms sampling window catching 2× or 3× of the `periodFrames=1024` `kernelTick` boundary (40 960 ↔ 61 440 are the discrete points; 2 ticks / 50 ms = 40 960, 3 ticks / 50 ms = 61 440). The **mean** is what matters: 42 435 / 48 000 = 0.884 → **11.6 % silence emission**.

### Post-SAB-fix (worklet reads `appl_ptr` via `Atomics.load`)

Same demo, same 5 s window, 113 samples.

```
states observed:    [0, 3]                ← same as before, never XRUN
mean cons rate:     43 337 frames/s        (was 42 435 — within noise)
mean appl rate:     45 722 frames/s        (was 45 132 — within noise)
low-cons (consRate < 40 000):  ONE sample at t=3703 (applRate=59 077, consRate=39 385). Practically identical distribution.
```

**Conclusion:** removing the entire 10–15 ms polling latency window did NOT change the silence-emission rate. Therefore §C is NOT caused by stale `applPtr` from polling — the worklet was already seeing fresh-enough producer progress under the old path. Something else is causing the worklet to emit silence ~10 % of the time.

## What we now know (confirmed) about §C

1. **The kernel state machine is healthy throughout the run.** State only ever shows `OPEN` (0, before HW_PARAMS lands — the probe's first ~250 ms catches this) or `RUNNING` (3, the rest). It never transitions to `XRUN` (4). The auto-start fix from handoff-3 is doing its job; the XRUN gate in `tick.rs::tick` doesn't latch.
2. **The period-tick feedback loop is correct.** `hw == consumed` at every probe sample. The kernel's `hw_ptr` advances exactly when and how much the worklet reports via `framesConsumed`. The XRUN gate (`new_hw_ptr > appl`) never trips because the worklet's bookkeeping prevents `kernel.hw_ptr` from exceeding `kernel.appl_ptr` by construction (worklet caps `framesConsumed` at `applPtr − hw_local`).
3. **The producer/consumer rates are matched in steady state.** Mean `applRate ≈ consRate` to within 5 %. The 5 % spread is the startup transient (ring filling phase, ~first 1 s) plus 50 ms sampling alignment with the 1024-frame `kernelTick` granularity. In pure steady state both rates are pinned to whatever the consumer actually emits.
4. **The producer is NOT starving.** `gap = appl − hw` stays close to `ringFrames = 16384`. The ring is saturated — there's always 15 000+ frames buffered in the SAB ring waiting for the worklet.
5. **Polling latency was not the cause.** Even with zero-latency SAB reads (a worklet quantum is 2.67 ms; an `Atomics.load` is sub-microsecond), the silence-emission rate is unchanged. So the worklet's `applPtr` value at the moment it emits silence WAS already fresh under the old path.

## So why does the worklet still emit silence?

The worklet emits silence in a given quantum **iff `applPtr − hw_local < 128`** at the start of that quantum. Given everything above:
- `applPtr` is the **live** kernel `appl_ptr` (now via SAB).
- `hw_local` is the worklet's monotonic local count of frames it has consumed.

For `applPtr − hw_local < 128` to ever be true with a saturated ring (`gap ≈ 16 384`), one of the following must be happening:

### Theory A — *The AudioContext sample rate is actually 44 100, not 48 000.*

Most likely candidate. On macOS, `new AudioContext({ sampleRate: 48000 })` is supposed to honor the requested rate via internal resampling, but **the worklet's `process()` is called at the AudioContext's actual graph rate, which on some platforms quietly defaults to the system rate**. macOS's default output sample rate is usually 44 100 (Apple silicon) or 48 000 (some configurations).

If actual context rate is 44 100:
- Worklet emits 44 100 frames/s at the context layer.
- `framesConsumed` sums to 44 100/s, NOT 48 000/s.
- Observed `consRate = 43 337` would be 44 100 − 763 = ~1.7 % below context rate, which is just the startup transient noise.
- There WOULD NOT actually be silence emission at the worklet layer.

In that case, the audible "stutter" the user hears is something OUTSIDE the worklet — possibly Chrome's audio output stage's response when the worklet feeds it `44 100 × resampling_ratio` frames worth of data at variable rates.

**Test (cheap):** in `BrowserAudioDriver.start`, after `audioCtx = new AudioContext({ sampleRate })`, log `audioCtx.sampleRate`. Compare to the requested `sampleRate`. If they differ, theory A is the cause. If they match (both 48 000), theory A is refuted.

### Theory B — *The render loop occasionally drops a frame, causing a producer gap longer than the ring's buffered head.*

If the SDL2 demo's render loop occasionally takes >340 ms for a single frame (e.g., due to a major GC pause, a Chrome compositor stall, or a vblank-tick miss in the kernel-worker's `setInterval(1000/60)`), the ring would drain entirely and the worklet would emit silence for the gap duration.

Ring depth = 16 384 frames = 341 ms at 48 kHz. For the ring to fully drain mid-run, the producer would have to fall silent for >341 ms. That's a very long pause and would be felt as a hard cutoff, not chronic stutter. **Probably not the cause** of mid-playback stutter, but worth ruling out via worklet-side instrumentation.

**Test:** in the worklet, log `applPtr − hw_local` (or post a low-rate summary to main thread) at the moment of every silence emission. If the gap is consistently small (< 1024 frames) at silence time, theory C below is more likely; if it sometimes flashes to 0 with large drops, theory B is real.

### Theory C — *Wall-clock drift between the AudioContext's quantum cadence and the kernel-worker's vblank-tick cadence.*

The producer fires at the kernel-worker's `setInterval(1000/60)` cadence — a Node/JS timer that's known to drift under main-thread load. The consumer fires at the AudioContext's quantum cadence — driven by the audio hardware clock, which is independent and stable. Over time these drift.

If the AudioContext's quantum cadence is slightly *faster* than the kernel-worker's vblank tick (e.g., 60.5 Hz vs 60.0 Hz), the worklet's `hw_local` slowly catches up to the producer's `appl_ptr`. The ring isn't refilled at exactly the consumer's rate; over enough seconds, the gap closes, and the worklet starts emitting brief silences whenever the consumer momentarily overtakes the producer.

This would manifest as: stutter that **starts** mid-playback (after enough drift accumulates) and gets worse over time — which matches the user's report ("stutter after maybe 2 seconds"). Both handoff-3 and this session's measurements are consistent with this — the silence-emission rate is steady throughout the second half of the run.

**Test:** lower `periodFrames` from 1024 to 256 in `attachAudioDriver`. That makes the producer-side tick granularity 4× finer; the consumer-side `framesSinceTick` will fire `kernelTick` more often, the kernel-side `hw_ptr` advances in smaller bumps, and any drift becomes harder to compound. Re-measure cons rate. If it climbs toward 48 000, theory C is confirmed.

**Fix candidate (if confirmed):** decouple the producer from the kernel-worker's vblank tick. Drive `SDL_PumpAudioDevices` from a **time-clamped** loop inside the SDL2 demo (`if (SDL_GetTicks() − last_pump >= period_ms) pump();`) rather than once per render frame. Alternatively, run the audio production in a separate setInterval at the audio rate inside the kernel-worker (something like `setInterval(periodMs)` that calls `SDL_PumpAudioDevices` from the main thread — but that requires a wholly different SDL2 audio path).

### Theory D — *Worklet's `process()` is occasionally not called for one quantum due to AudioWorklet scheduling pressure.*

Real-Chrome AudioWorklet runs on a dedicated audio thread but can occasionally miss a quantum if the JS engine is heavily loaded elsewhere. A missed quantum looks IDENTICAL to a silence emission from the kernel/host's perspective — `framesConsumed=0` is posted from the missed quantum.

This would be a pure browser-side issue, NOT something we can fix in the kernel or host. **Probably not the dominant cause** because the silence rate is too consistent (10 % across both runs) to be scheduler jitter.

### Theory ranking for next session

Run experiments in this order (cheapest first):

1. **Theory A (sample rate mismatch).** Log `audioCtx.sampleRate` from `BrowserAudioDriver.start` and from a probe sample. ONE line of code; takes 30 seconds to test. If theory A is correct, the "10 % silence" interpretation was wrong from the start and §C is something else entirely (Chrome's audio output stage resampling artifacts, or there's actually no stutter at the worklet level and the user is hearing something else).
2. **Theory B (ring drain on producer gap).** Add `if (available < 128 && hw - prevHw_at_silence_start === 0) postMessage({type:'silence', applPtr, hw})` from the worklet. Look for the gap distribution at silence time.
3. **Theory C (drift).** Halve `periodFrames` to 256 — quickest test, no new instrumentation. If cons rate climbs, theory C wins; commit a `periodFrames` reduction + investigate the proper fix (decouple producer from vblank tick).
4. **Theory D (worklet scheduler jitter).** Last resort. If A/B/C are all refuted, we're stuck with browser-side scheduling and our remediation is to make sure the worklet always has enough headroom that the occasional missed quantum doesn't matter. That means LARGER ring, not smaller periodFrames — try doubling ring from 64 KB to 128 KB.

## Architecturally-correct gains this session (KEEP these)

Even though §C is unresolved, this session's changes deliver real improvements:

1. **Zero-latency producer-pointer feedback.** The worklet now reads kernel-state directly via SAB instead of an async `postMessage` chain. Even if it doesn't fix the symptom, it removes a structural latency source whose removal will simplify future debugging.
2. **Three new read-only audio probes.** `kernel_audio_get_hw_ptr`, `kernel_audio_get_state`, and the existing `kernel_audio_get_appl_ptr` together give us a complete kernel-side view of the producer/consumer system from host instrumentation. Without these, theory #1 (XRUN) couldn't be empirically ruled out.
3. **Cleaner audio driver lifecycle.** `BrowserAudioDriver` no longer needs a 10 ms `setInterval` hot-path poll under the SAB path. The driver runs `applPtrPollHandle: null` for SAB-bound hosts.

These are all positive of their own merit. Do NOT revert them when chasing the actual §C fix.

## Working tree state — full files touched

This session adds the following on top of handoff-3's working tree. Run `git status --short` for the canonical list. As of session end:

```
 M abi/snapshot.json                                          ← regen (additive only)
 M apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts ← 50 ms time-series probe
 M crates/kernel/src/audio/pcm_ioctl.rs                       ← +publish_appl_ptr call + 2 tests
 M crates/kernel/src/audio/sab.rs                             ← +appl_ptr_addr table + 4 tests
 M crates/kernel/src/audio/tick.rs                            ← +current_hw_ptr + current_state
 M crates/kernel/src/wasm_api.rs                              ← 3 new exports
 M host/src/audio/audio-driver.ts                             ← +AudioApplPtrSab + applPtrSab param
 M host/src/audio/browser-audio-driver.ts                     ← +SAB pass-through + poll gating
 M host/src/audio/instrumented-audio-driver.ts                ← forward applPtrSab
 M host/src/audio/node-audio-driver.ts                        ← accept-ignore applPtrSab
 M host/src/audio/wpk-audio-worklet.js                        ← Atomics.load applPtrView
 M host/src/browser-kernel-host.ts                            ← +audioAllocApplPtrSab + 3 probe methods
 M host/src/browser-kernel-protocol.ts                        ← +3 message types in union
 M host/src/browser-kernel-worker-entry.ts                    ← +3 case handlers
 M host/src/generated/abi.ts                                  ← regen
 M host/src/kernel.ts                                         ← +audioInitApplPtrSab + 2 probe methods
 M host/src/kernel-worker.ts                                  ← +audioInitApplPtrSab + 2 probe methods
 M host/src/node-kernel-host.ts                               ← parity: 2 new probe methods
 M host/src/node-kernel-protocol.ts                           ← parity: +2 message types
 M host/src/node-kernel-worker-entry.ts                       ← parity: +2 case handlers
 M libc/glue/abi_constants.h                                  ← regen
 M local-binaries/kernel.wasm                                 ← rebuilt with 3 new exports
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff-4.md  ← this file
```

(Plus all of handoff-3's pre-existing `M` and `??` files — see that handoff's "Working tree state" section.)

### Background processes

A Vite dev server was running on port **5403** at session end. Restart command in §1.7 of TL;DR.

### Stale `shell.vfs.zst`

Still stale. Same caveat as predecessor handoffs.

## Things NOT to do

- **Do NOT revert the SAB-backed `appl_ptr` plumbing.** Even though it didn't fix §C, the SAB read is architecturally correct, removes a real ~10 ms structural latency, and simplifies the hot path. The cargo + vitest tests pin its behavior.
- Do NOT push or `gh pr *`. Branch stays local.
- Do NOT commit, push, or PR without explicit per-session approval. **End-of-session note: the §C fix is unresolved; we cannot ship this branch until either (a) §C is fixed AND the full CLAUDE.md battery passes, or (b) the user explicitly approves shipping the architectural improvements without the §C fix.**
- Do NOT bump `revision` fields in `build.toml` files.
- Do NOT regenerate the ABI 16 artifacts already in `local-binaries/programs/wasm32/`.
- Do NOT revert any of handoff-3's six landed fixes — they remain independently necessary.
- Do NOT loosen the new Playwright spec gates.
- Do NOT change `tick()` to advance `hw_ptr` in non-RUNNING states. The non-RUNNING gate is the correct Linux behavior; this session's data CONFIRMS the gate never trips, so it's not the issue.
- Do NOT bring the 10 ms polling path back into the hot path. The legacy poll path is kept ONLY as a runtime fallback for hosts that haven't bound an `applPtrSab` slot (older kernels in the wild).

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-sdl2-browser-rendering-handoff-4.md` first, then its predecessors `-3.md`, `-rendering-handoff-2.md`, `-rendering-handoff.md`, and `-fix-handoff.md`. Branch is `explore-dri-sdl2`, tip still `4f88111bb` (NOT pushed, PR #709 untouched). Working tree adds: (1) three new kernel exports (additive ABI, no `ABI_VERSION` bump): `kernel_audio_get_hw_ptr`, `kernel_audio_get_state`, `kernel_audio_init_appl_ptr_sab`; (2) SAB-backed `appl_ptr` mirroring — kernel writes the live producer pointer to a 4-byte slot on every WRITEI; AudioWorklet reads via `Atomics.load(new Int32Array(buf, off, 1), 0)` on every quantum, replacing the 10 ms `setInterval` + `postMessage` chain; legacy poll kept as fallback for unbound hosts; (3) a 50 ms time-series probe in `live-setup.ts` writing `{t, state, appl, hw, consumed}` to `window.__audioLog`. **§C is UNRESOLVED**: real-Chrome data shows state stays in `RUNNING` the whole run (XRUN never fires — handoff-3 theory #1 REFUTED), and the SAB fix didn't change the silence-emission rate (~10 % of output frames are silence; cons rate stays at ~43 k vs requested AudioContext 48 k — handoff-3 theory #3, poll latency, REFUTED). **Top remaining theory: AudioContext sample rate may actually be 44 100 instead of the requested 48 000 on macOS — cheap to disambiguate by logging `audioCtx.sampleRate` in `BrowserAudioDriver.start`.** Other live theories: ring-drain on a producer gap (test by logging `applPtr − hw` at silence time from worklet), wall-clock drift between vblank-tick cadence and AudioContext quantum cadence (test by halving `periodFrames` to 256), worklet scheduler jitter (test by doubling ring to 128 KB). Suggested order: (1) log AudioContext actual sampleRate first — that's a one-line change in `host/src/audio/browser-audio-driver.ts`; if it shows ≠ 48 000, theory A wins and §C may already be effectively a non-issue; (2) if equal to 48 000, add a low-rate worklet→main `postMessage({type:'silence', gap})` from inside the `if (available < 128)` branch and look at the gap distribution; (3) try `periodFrames: 256` in `attachAudioDriver` opts in `live-setup.ts`; (4) re-run CLAUDE.md test suite once §C lands — this session only ran cargo audio (77/77) + audio vitest specs (13/13), NOT the full battery; (5) commit + PR only with explicit per-session approval. **Architecturally-correct changes (SAB read, 3 new exports, probe instrumentation) MUST NOT be reverted regardless of §C investigation outcome — they remove a real structural latency source and are pinned by passing tests.** Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR. Vite dev server was on 5403 — restart with `bash scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx vite --host 127.0.0.1 --port 5403 --strictPort'`."*
