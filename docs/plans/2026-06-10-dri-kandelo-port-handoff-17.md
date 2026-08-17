# DRI port onto kandelo:main — session 17 handoff

Continuation of [2026-06-10-dri-kandelo-port-handoff-16.md](./2026-06-10-dri-kandelo-port-handoff-16.md). Read that first if you want the full chain back to v15. This doc covers what changed in session 17 + the devil's-advocate review the next session is expected to run.

## TL;DR — read this twice

1. **Q1 was confirmed and fixed.** modeset's main loop was running at ~1500–2700 Hz instead of 60 Hz, so the sim ran ~30× too fast and over-dissipated dye + velocity. Two changes landed in `programs/modeset.c`:
   - `DT` is now a per-frame `clock_gettime(CLOCK_MONOTONIC)` delta, capped at 1/15 s (no low clamp — at 2 kHz the natural ~0.5 ms dt has to flow through, otherwise we're still over-running by 16×).
   - A program-level 60 Hz throttle (`t_next` absolute time, sleep until reached, resync if >100 ms behind). Without this, the loop spins, integrating sim + bloom + sunrays + display ~33× per real frame and pinning the GPU. **Q4 (kernel-side vblank gating) is still unfixed**; the throttle is a workaround.
2. **Modeset pane UI cleaned up.** Bottom stats grid (scanout / blit / pump frame / commits / last flip / crtc) deleted; the header chip carries them as `1920×1080 · N flips · Nµs`. Canvas styling settled on `width: 100%; height: auto; maxHeight: 100%` — preserves the 1920×1080 intrinsic aspect so both axes share the same scale factor and `getBoundingClientRect`-based mouse mapping stays correct.
3. **Visual tweaks.** `DEN_DISSIPATION` bumped 1.0 → 2.0 (less white saturation buildup on long drags). Boot `multiple_splats(20)` call removed + the now-dead helper deleted. Demo starts on a black canvas; dye appears only on drag.
4. **Two commits landed** on `explore-direct-rendering-infrastructure`:
   - `52a1022d8 modeset(dri): port Pavel WebGL fluid sim + 60 Hz frame pacing`
   - `ab5de0667 kandelo(dri): Modeset pane — full-width canvas, slim header chip`
5. **One investigation interrupted, NOT resolved.** User reported "fluid sim slows / stutters when I don't move my mouse" after the throttle landed. I started tracing it (50 ms `sys_poll` fallback timer vs broad-wake; `setImmediate` polyfill starvation; `OffscreenCanvas` commit timing) and was interrupted before reaching a conclusion. User then asked for the UI cleanup + dissipation bump + boot splat removal, and after those they reported "Beauty!" — so the stutter MAY have resolved itself once the loop wasn't pinning the worker. Confirm in session 18 before chasing.

## Mission for session 18

> *"Now that I am really satisfied by your work … we will run the devil's advocate through the whoooooooole set of commits and changed files, so that you can clean useless things and refactor if needed."*

This is the **devil's-advocate pass**. The whole `explore-direct-rendering-infrastructure` branch is now functional. The next session should:

1. **Read every commit on the branch (`6474e912c` back through `b25ef5942`)** — diff each one against parent. Look for dead code, over-engineering, inconsistencies between Node and Browser hosts (the dual-host-parity rule in CLAUDE.md), wrong abstractions, leftover TODO/DIAG markers, half-finished refactors.
2. **Read every still-dirty modified file** — most of them are session 14/15/16 work that was never committed. They form a coherent body of DRI infra changes (kernel ioctls, host bridge, ABI snapshot, libc glue) that needs either splitting into focused commits matching the branch's small-commit style, or one large `kernel(dri): batch X` if that's cleaner. User judgment will decide.
3. **For each finding**, propose either a deletion or a focused refactor. **Do not** rewrite working code for stylistic taste — only act where the cleanup pays for itself (dead code, obvious duplication, real bugs, contract violations).

## What I did this session

### 1. Verified Q1 with a one-shot FPS probe

Hypothesis from v16: the loop runs at ~3000 Hz, not 60. To confirm:
- Added a `[FPS]` stderr printf to `programs/modeset.c::main`, sampled every 60 frames.
- Temporarily routed `onStderr` in `live-setup.ts` to also `console.log("[STDERR]", …)` so Playwright could capture it via `page.on("console")`.
- Wrote a 60-second Playwright probe spec at `apps/browser-demos/test/kandelo-modeset-fps-probe.spec.ts`.
- Result: **1500–2700 Hz consistently**, not 3000 — close enough. Hypothesis confirmed.

All three diagnostic items were reverted before commit. Verified clean via `grep -rn "DIAG S1[67]\|\\[FPS\\]\|\\[STDERR\\]" programs/ host/src/ apps/browser-demos/`.

### 2. Fix B (real dt) — two iterations

**First attempt:** per-frame `clock_gettime(CLOCK_MONOTONIC)` delta clamped to `[1/120, 1/15]` s, matching the v16 handoff's literal suggestion. Result: dt pinned at 0.0083 s (the floor) because the loop's natural dt is ~0.5 ms, well below 1/120. Sim still over-ran ~16×.

**Second attempt:** dropped the low clamp entirely (Pavel doesn't have one either; he only caps the max). Kept `DT_MAX = 1/15 s` so a stalled frame can't blow up integration. Result: dt now in 0.0001–0.0012 s range — matches actual wall-clock. Over one real second, 2000 frames × ~0.5 ms = ~1 sim-second. **Physics-time tracks wall-clock 1:1.**

### 3. 60 Hz program-level throttle

After fix B, the loop still spun at 2 kHz and CPU/GPU were pinned. Q4 (kernel-side vblank gating) is the architectural fix, but it's deep work. Pragmatic fix: throttle modeset.c itself.

Approach in `main()`:
```c
const long FRAME_NS = 16666667L;   /* 1/60 s */
struct timespec t_next = t_prev;   /* absolute target, advanced 1/60 s per frame */
/* … after kms_pageflip_wait() returns … */
t_next.tv_nsec += FRAME_NS;
/* normalize, then: */
long behind_ns = (t_after.tv_sec - t_next.tv_sec) * 1e9 + (t_after.tv_nsec - t_next.tv_nsec);
if (behind_ns > 100e6) t_next = t_after;    /* resync (tab backgrounded etc.) */
else if (behind_ns < 0)  usleep(-behind_ns / 1000);
```

Verified via the same FPS probe: **rock-solid 60.0 Hz, dt ≈ 0.0166 s.** No frame skipping, no overshoot.

### 4. Modeset pane UI

User asked for three iterations:

a. Remove the bottom stats row, move the data into the header chip. First attempt replaced `lastFrameUs` with scanout dims; user wanted both kept. Final chip: `${stats.width}×${stats.height} · ${stats.commitCount} flips · ${stats.lastFrameUs}µs` (resolution on the left, per the user's "set the resolution on the left" follow-up).

b. Slim `KmsStats` interface and the SAB-poll loop to just the three fields we now render (width, height, commitCount, lastFrameUs). The other slots (frameCount, blitUs) are still populated by the kernel-worker and tests still cover them — we just don't read them in this pane anymore.

c. Canvas sizing. Tried `width: 100%; height: 100%` → broke mouse mapping (CSS box was stretched non-uniformly relative to drawing buffer; mathematically the rect-ratio formula still works, but the user observed splats landing on the left when clicking centre, which I never fully diagnosed before they redirected me). Settled on `width: 100%; height: auto; maxHeight: 100%` — preserves 16:9 intrinsic aspect from the canvas's drawing buffer, both axes scale identically, mouse mapping is correct again.

### 5. Visual tuning

- `DEN_DISSIPATION`: 1.0 → 2.0. Pavel's "Quality High" default is 1.0; his UI slider goes to ~4. 2.0 gives perceptibly less whitening on long drags without making the dye feel ghostly.
- Boot `multiple_splats(20, …)` call removed from `main`. The dead `multiple_splats` helper was deleted too (`frand` is still used by `regenerate_color`, so that stays).

## What I learned about this codebase (for the devil's-advocate pass)

- **DRM page-flip events are queued IMMEDIATELY into `event_ring`** at `crates/kernel/src/syscalls.rs:1462–1479` — comment says "v1 simplification: the host vblank pump exists only to refresh canvases + counters, so the test-bench can run PAGE_FLIP → drmHandleEvent without a real 60 Hz tick driving event delivery." **This is Q4.** The right fix is to queue the event into a pending list, then drain to `event_ring` from `kernel_vblank()` when the host vblank pump ticks. Until that lands, every `drmModePageFlip` → `read(drm_fd)` cycle returns instantly.
- **The kernel-worker vblank pump** (`host/src/kernel-worker.ts:8364–8370`) is a `setInterval(() => tickVblank(), 1000/60)`. It bumps the kernel-side commit counter via `kernel_vblank()` export. Counter is exposed to demos via the stats SAB.
- **The 50 ms host-retry fallback** for blocked `sys_poll`/`sys_ppoll` is at `host/src/kernel-worker.ts:3579`. With targeted wake tokens (pipe / accept), retry is 10 ms; without, 50 ms. Comment at `modeset.c:1226` explicitly references this — that's why the program uses `O_NONBLOCK + usleep(1000)` instead of `poll()`.
- **Modeset stats SAB slot layout** (set in `tickVblank`):
  - 0: host pump frame count (monotonic)
  - 1: last blit timestamp (ms, `performance.now() | 0`)
  - 2/3: current scanout width/height (from kernel-side FB)
  - 4: last blit µs
  - 5: kernel-side `PAGE_FLIP` commit count
  - 6: kernel-side last frame µs
- **`OffscreenCanvas` ownership transfer.** Modeset.tsx sets `canvas.width = 1920; canvas.height = 1080;` BEFORE `attachKmsDisplay()` calls `transferControlToOffscreen()`. After transfer, the main-thread placeholder keeps the attribute values; `canvas.getBoundingClientRect()` returns CSS box; `canvas.width`/`canvas.height` JS props remain 1920/1080. That's how the mouse-coord mapping works.
- **`live-setup.ts` stderr/stdout routing.** Goes through `tick()` → `host.pushDmesg()`. There's no built-in path to `console.log`. The DIAG probes this session temporarily added one.
- **`relistenBatchSize`** (`host/src/kernel-worker.ts:2649`) controls how many syscall dispatches happen via microtask before yielding via `setImmediate`. Default 64 (Node), should be 1 in browser. Comment mentions MariaDB-style starvation of `requestAnimationFrame` if this is wrong.
- **Two diagnostic kernel exports** added in v16 (`kernel_mouse_queue_len`, `kernel_mouse_owner`) are still in `crates/kernel/src/wasm_api.rs:10434–10446`. Additive-compatible. v16 handoff said "keep or remove". I left them. They could come out in the devil's-advocate pass if nothing references them.

## Devil's-advocate checklist — start here in session 18

Concrete things I noticed but didn't act on, in priority order:

1. **`DT_FALLBACK` is defined but only used to initialize `g_dt`** (`programs/modeset.c:107`). Could just write `static float g_dt = 1.0f / 60.0f;` directly. Trivial cleanup.
2. **Long block comments on the dt + throttle code** (`modeset.c:1305–1320, 1385–1388`). They explain Q4 in detail — useful for the next person, but the "Don't write multi-paragraph docstrings" rule in CLAUDE.md says trim. Judge whether the *why* is non-obvious enough to keep.
3. **`kernel_mouse_queue_len` / `kernel_mouse_owner` exports** — dead. Either re-justify or drop. Drop requires regenerating `abi/snapshot.json` (additive change, no `ABI_VERSION` bump needed).
4. **Modeset.tsx slot-layout comment at top of file** lists all 7 stats slots but the pane now reads only 4. Comment is still accurate documentation of the SAB shape, not stale, but cross-check.
5. **`apps/browser-demos/test/kandelo-modeset.spec.ts`** is still untracked — the test from v16 that asserts the PAGE_FLIP counter ticks + a non-blank canvas screenshot. Worth committing as a regression guard for the work we just landed.
6. **The wide uncommitted M tree** (kernel DRI ioctls, host TS bridge, libc glue, ABI snapshot, dual host wiring) — this is the bulk of the devil's-advocate work. Walk each file's diff and decide whether the pieces want to be split into focused commits matching the branch's small-commit style, or batched. The branch has a strong "one layer per commit" convention; respect it.
7. **`programs/modeset.c` is now 1400+ lines.** Whether the shader sources want to live in a separate header (e.g. `programs/modeset_shaders.h`) is a judgment call. Pro: keeps `main` + sim passes readable. Con: shader keywords (`SHADING`/`BLOOM`/`SUNRAYS`) are injected at link time via `compile_link_with_defines`, so the strings have to be raw GLSL text — easier to read inline alongside the code that compiles them. Lean: leave it, but flag if you disagree.
8. **`splat_radius_sq`** is named `_sq` but it's just `SPLAT_RADIUS_BASE * aspect` (no square). Vestigial name from an earlier formulation. Rename to `splat_radius` to remove the lie.

## Outstanding investigations (NOT resolved this session)

- **"Stutters when no mouse moves" symptom from mid-session.** User confirmed *Fluid sim slows / stutters*. I traced as far as: kernel-worker uses 50 ms poll fallback when no syscall traffic wakes pollers; modeset uses `read+usleep` not `poll`, so should be immune; OffscreenCanvas commits should auto-flush at WebGL2 frame end on worker. **Never confirmed whether it actually went away after the throttle + DEN_DISSIPATION + boot-splat-removal landed.** User said "Beauty!" after the dissipation bump but never directly retested the stutter case. Session 18 should confirm in the browser before assuming it's gone.
- **Q4 — kernel-side vblank gating** at `crates/kernel/src/syscalls.rs:1462–1479`. Architectural fix: don't retire `pending_flips` immediately into the per-fd `event_ring`; instead, hold them and drain on the next `kernel_vblank()` call. Until done, every program driving DRM page-flips needs the same program-level throttle modeset.c just got.
- **103 vitest `exnref` failures** on this branch — still carried from v14, still unresolved.

## What NOT to retry

- Don't re-walk Q1 (DT hardcoded). Fixed and verified at 60.0 Hz steady-state.
- Don't re-investigate v15's "queue empty at read" mouse bug. v16 diagnostic ruled it out.
- Don't add a bloom-less brightness boost to the display shader. Bloom + sunrays + shading are all on and visually correct.
- Don't touch shader sources. They're verbatim from Pavel's repo.
- Don't change resolutions away from `getResolution(N)` outputs (228/1820/456/349). Match Pavel.
- Don't bump `ABI_VERSION` for the v16 diagnostic exports — they're additive-compatible.
- Don't `--no-verify` past pre-commit hooks. They protect dual-host parity (CLAUDE.md).

## Working-tree state at end of session 17

**Committed this session:**
- `52a1022d8 modeset(dri): port Pavel WebGL fluid sim + 60 Hz frame pacing`
- `ab5de0667 kandelo(dri): Modeset pane — full-width canvas, slim header chip`

**Still modified (uncommitted, for devil's-advocate review):**
- `abi/snapshot.json` (reflects v16 additive exports)
- `apps/browser-demos/playwright.config.ts`
- `crates/kernel/src/mouse.rs`, `syscalls.rs`, `wasm_api.rs`
- `crates/shared/src/lib.rs`
- `host/src/browser-kernel-host.ts`, `browser-kernel-protocol.ts`, `browser-kernel-worker-entry.ts`
- `host/src/dri/kms-registry.ts`, `generated/abi.ts`
- `host/src/kernel-worker.ts`, `kernel.ts`
- `host/src/node-kernel-host.ts`, `node-kernel-protocol.ts`, `node-kernel-worker-entry.ts`
- `host/test/dri-kms-stats-sab.test.ts`, `dri-modeset.test.ts`, `dri-smoke.test.ts`
- `libc/glue/abi_constants.h`
- `scripts/build-programs.sh`
- `web-libs/kandelo-session/src/kernel-host.ts`

**Untracked (decide per file):**
- `apps/browser-demos/test/kandelo-modeset.spec.ts` — should probably commit, regression guard
- `apps/browser-demos/test-results/` — Playwright run output, don't commit
- `docs/plans/2026-06-10-dri-kandelo-port-handoff-{4..17}.md` — handoff history, not normally committed
- The various `docs/plans/2026-06-*-dri-*-plan.md` files — design docs, judgment call

**Submodule state** (don't touch unless intentional):
- `libc/musl` (modified content, untracked content)
- `tests/libc/libc-test` (untracked content)
- `tests/sortix/os-test` (modified content)

## Reference points (file:line)

- `programs/modeset.c:107` — `DT_FALLBACK` (only used to init `g_dt`; candidate for inlining)
- `programs/modeset.c:108–110` — `DT_MAX`, `g_dt` definitions + Pavel-style cap rationale
- `programs/modeset.c:1305–1320` — per-frame dt + throttle setup comment block
- `programs/modeset.c:1385–1402` — 60 Hz throttle implementation + resync logic
- `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:50–66` — slimmed `KmsStats` interface + `ZERO_STATS`
- `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:213–223` — SAB poll loop (now reads 3 slots: width, height, commitCount, lastFrameUs)
- `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:253–255` — header chip text
- `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:275–284` — canvas style (`width:100%`, `height:auto`, `maxHeight:100%`)
- `crates/kernel/src/syscalls.rs:1462–1479` — **Q4 root cause**: immediate event retire
- `crates/kernel/src/wasm_api.rs:10434–10446` — v16 diagnostic exports (candidate for removal)
- `host/src/kernel-worker.ts:3579` — 50 ms poll fallback timer
- `host/src/kernel-worker.ts:8364–8370` — vblank pump setInterval
- `host/src/kernel.ts:752–784` — auto-attach KMS canvas in `host_gl_create_context`

## Standing instruction for session 18

**Print this sentence in the next session's first turn so I have a single fixed entry point:**

> *"Read `docs/plans/2026-06-10-dri-kandelo-port-handoff-17.md` first. Today is the devil's-advocate pass on the `explore-direct-rendering-infrastructure` branch: walk every commit (from `b25ef5942` forward) and every still-dirty file, flag dead code, over-engineering, dual-host-parity violations (per CLAUDE.md), inconsistencies, leftover diagnostic markers, and wrong abstractions. Start from the §"Devil's-advocate checklist" in the handoff — items 1–8 are concrete entry points I already spotted. For the uncommitted M tree, decide whether to split into focused per-layer commits matching the branch's `<scope>(dri):` convention or batch. Do NOT rewrite working code for stylistic taste — act only where the cleanup pays for itself. Do NOT bump `ABI_VERSION` for the additive v16 diagnostic exports. Do NOT push, do NOT push to mho22. Branch is on Automattic/kandelo. Wait for user input before each commit. SpiderMonkey needs `WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` exported inside the inner `bash -c` for builds. Open question carried forward: "stutters when no mouse moves" was traced but never confirmed gone — verify in `./run.sh browser` before assuming the throttle + dissipation fixes covered it."*
