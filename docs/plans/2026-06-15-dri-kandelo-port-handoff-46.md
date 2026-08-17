# DRI port onto kandelo:main — session 46 handoff (audio PR opened + SDL2 read-in)

Continuation of [handoff-45](./2026-06-15-dri-kandelo-port-handoff-45.md). Session 46's job started as the per-commit prompt sequence handoff-45 §"Revised per-commit grouping" specified (six commits + bundled PR). The user redirected mid-session: drop the per-commit grouping, **exclude `docs/plans/*` and handoff markdowns entirely**, single bundled commit, **draft** PR matching the project's PR style. Session ended with PR #698 open + mergeable against the DRI integration branch, and a pivot to milestone D (SDL2).

## TL;DR — read this twice

1. **PR opened: https://github.com/Automattic/kandelo/pull/698** — title `Add ALSA audio backend and espeak-ng browser demo`. **Draft.** Base = `explore-direct-rendering-infrastructure` (NOT `main`). Head = `explore-dri-evdev-and-alsa`. Currently `mergeable: MERGEABLE`, `mergeStateStatus: UNSTABLE` (CI pending — UNSTABLE here ≠ merge conflict).

2. **Branch was renamed** twice this session. Final name: **`explore-dri-evdev-and-alsa`** (typo `asla` fixed to `alsa`). Original was `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`.

3. **The audio worktree is still at** `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`. Branch tip after this session: `d1b1156e8` (merge commit). Backup tag `backup-session-45-pre-trim` still points at the pre-trim `8981a9687`.

4. **Two commits land on top of `b68ef3406`:**
   - `fcc53939b Add ALSA audio backend and espeak-ng browser demo` — 42 files, +6232/−5. The single bundled audio + espeak commit (no per-commit split, no docs/plans staged).
   - `d1b1156e8 Merge remote-tracking branch 'origin/explore-direct-rendering-infrastructure' …` — pulled in 51 base commits; one conflict in `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (imports only); resolved by keeping base's new `setupServiceWorkerFetchBridge` import + our new audio/input imports, dropping legacy `initServiceWorkerBridge` + `HttpBridgeHost` which the auto-merged body no longer references.

5. **The transient (i) plan + handoffs commit was reverted.** Session 46 committed `dcc92c0cc plan(espeak-ng): port plan + session 41-45 handoffs` (the per-commit grouping's commit (i)), then `git reset --soft HEAD~1 && git restore --staged docs/plans/` to unstage them per the user's new instruction. All handoff-41..45 + espeak-ng-port-plan.md remain untracked in the audio worktree (intentional — they're scratch, not PR material).

6. **PR style observed (matched in #698's body):** sentence-case title with no `feat:`/`fix:` prefix; `## Summary` lowercase bullets (no trailing period); optional `## Purpose`/`## Notes`; `## Testing`/`## Verification` with concrete commands. Examples from recent merged PRs that informed the shape: #685 (Classify Wasm traps as POSIX signals), #686 (Preinstall WordPress browser demos), #634 (Build builtin demo VFS images from shell base), #623 (Promote Kandelo UI to browser app), #625 (Add official SQLite test harness). **No `Co-Authored-By: Claude` trailer in the PR body** — only inside the commit (matches project convention).

## What was NOT done this session

- **The handoff-43 §8 gauntlet has not been run on the post-merge tree.** The merge auto-touched `crates/kernel/src/{fork,process,syscalls,wasm_api}.rs`, several host files (`browser-kernel-host.ts`, `node-kernel-host.ts`, `kernel-worker.ts`, `kernel.ts`), `crates/shared/src/lib.rs`, and `abi/snapshot.json`. Cargo / vitest / ABI check / libc-test / posix-test / browser-demo verification all still need to happen. CI on #698 is the first signal; local gauntlet is the second.
- **Evdev Playwright regression** (handoff-45 §"Open evdev regression") still pre-existing; not addressed; reviewers will likely flag it on #698. Either bisect/fix on a separate branch or document in the PR body before flipping draft → ready.
- **`.gitignore` for `packages/registry/espeak-ng/glue-objs/`** still missing. Peer packages (mariadb, kandelo-sdk) use `<pkg>-glue-objs/` which the existing `packages/registry/*/*-glue-objs*/` pattern matches; espeak-ng uses bare `glue-objs/` so the build artifacts (`.o` files) appear as untracked. Either rename the directory in `build-espeak-ng.sh` or add a targeted ignore line. Not a blocker for PR #698; a follow-up commit on the same branch is fine.

## Decisions that override prior handoffs

- **Per-commit grouping is dead for this PR.** Handoff-45 §"Revised per-commit grouping" listed six commits (plan+handoffs / kernel audio / host audio / espeak-ng / shell-vfs image / preset+spec). The user replaced that with one bundled commit + one draft PR. Future sessions should NOT resurrect the six-commit grouping for this PR.
- **`docs/plans/*` and handoff markdowns are excluded from this PR by user instruction.** This includes session 41-45 handoffs and the espeak-ng-port-plan. Do not stage them. They live as untracked files in the audio worktree.
- **PR is targeted at `explore-direct-rendering-infrastructure`**, not `main`. The user explicitly corrected this mid-session. Any future PRs in the DRI chain should follow the same stack convention (plan 6's tip → plan 7, etc.).

## What's queued for session 47 — pivot to SDL2 (milestone D)

The user signalled intent to start the SDL2 port. Plan exists at `docs/plans/2026-06-29-sdl2-port-plan.md` (in *this* worktree, NOT the audio worktree). Plan is 2076 lines; the first ~1130 lines were read this session. Key callouts:

- **Plan requires the `superpowers:subagent-driven-development` skill** (declared on line 3 of the plan). Invoke it task-by-task.
- **Three stacked PRs**:
  1. `sysroot(sdl2-shims): libdrm-KMS + alsa-lib subset + libinput-lite stub` — Phase A (Tasks A1-A7). Self-contained sysroot work; doesn't depend on the audio PR merging.
  2. `sysroot(sdl2): vendor SDL2 2.30.x + cross-compile + backend wiring` — Phase B (B1-B5).
  3. `examples(sdl2): sdl2_demo + browser spec + Phase C profiling gate` — Phase C (C1-C3).
- **ABI impact = zero.** Sysroot grows (libdrm.a, libasound.a, libinput.a, libSDL2.a + headers) — no kernel/host/ABI churn.
- **Stack base** = plan 6's `…-alsa-demo` tip = our PR #698 branch tip (`explore-dri-evdev-and-alsa` at `d1b1156e8`).

### Resolved architecture (DO NOT re-litigate)

Two big open-architecture items from the plan's pre-implementation review were closed by plan 9's devil's-advocate pass:

1. **SDL2 audio thread model → option (b): polling-based SDL2 audio patch + plan 6 EAGAIN arm.** ~150 LoC SDL2 patch to `src/audio/SDL_audio.c::SDL_RunAudio` driven from `SDL_PumpAudio`, conditional on `SDL_THREADS_DISABLED`. NOT option (a) (libpthread shim) and NOT option (c) (defer audio). Plan 6's EAGAIN arm should already be in our audio PR's kernel; if it isn't, that's a gap to verify before Phase B.
2. **GL stack ownership → plan-2/3 follow-up PRs.** SDL2 PR #2 (Phase B) is **blocked** on `sysroot/lib/{libEGL.a, libGLESv2.a}` + extended `libgbm` (`gbm_surface_create_with_modifiers`, `gbm_surface_lock_front_buffer`, `gbm_surface_release_buffer`) landing first via separate plan-2 follow-up PRs. Phase A (PR #1) does NOT need GL and is unblocked.

### Cross-plan amendment (KMS-master coexistence)

SDL2 KMSDRM demo and plan 9's wpkcompositor BOTH call `drmSetMaster` on `/dev/dri/card0`; plan 4 enforces one-master-per-card. **They are mutually exclusive in v1.** Boot ordering: if `/etc/wpk/compositor` exists, init forks compositor at PID 2 before the user shell → SDL2 demos hit EBUSY. The post-v1 fix is plan 11's `SDL_wpkvideo` backend. Plan 7's demo is direct-KMS only — no compositor coexistence in scope.

### Open correctness items the plan flags (verify during impl, do not skip)

- `EVIOCGKEY` / `EVIOCGREP` on the evdev side — SDL2's `SDL_EVDEV_AddDevice` calls both. Plan 5's default ioctl arm must return **ENOTTY** (not EINVAL) so SDL2 tolerates them. Verify before Phase B's smoke test.
- `drm_event_vblank` record size — must match libdrm's parser (likely 32 bytes; plan 4 sketched 24). Adjust kernel-side producer if needed; B3 adds a `_Static_assert(sizeof(struct drm_event_vblank) == 32)`.
- Browser autoplay policy — `SDL_PauseAudioDevice(dev, 0)` runs before `audioCtx.resume()`. C3 verification needs a host-side `wpk_audio_unlock()` shim called pre-mount.
- alsa-lib `snd_pcm_open("default")` short-circuit must move to the very top of `snd_pcm_open_noupdate`, before any `snd_config_*` reference. The sed-based patch in A5's draft is brittle; replace with a real patch file under `examples/libs/alsa-lib/patches/`.
- Add `examples/libs/alsa-lib/src/conf_stubs.c` returning ENOTSUP from every `snd_config_*` entry point, so the alsa-lib subset doesn't pull in iconv/locale via the conf parser.

### Suggested starting point for session 47

**Phase A, Task A1 (libdrm-KMS package scaffold).** Self-contained, no dependencies on PR #698 merging, no GL stack needed. Three files: `examples/libs/libdrm/package.toml`, `build.toml`, `build.sh` (TODO-stub form). Invoke `superpowers:subagent-driven-development` on the plan and walk task-by-task.

## Reference — locations after session 46

| Thing | Where |
|---|---|
| Audio PR #698 working branch | `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`, branch `explore-dri-evdev-and-alsa`, tip `d1b1156e8` |
| SDL2 plan worktree | `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`, branch `explore-direct-rendering-infrastructure` |
| SDL2 plan doc | `docs/plans/2026-06-29-sdl2-port-plan.md` (in SDL2 worktree; 2076 lines) |
| Audio handoffs 41-45 | untracked in audio worktree; **NOT staged into PR #698 by user instruction** |
| Backup tag | `backup-session-45-pre-trim` → `8981a9687` (pre-trim audio HEAD) |
| Stale kernel.wasm to ignore | `host/wasm/kandelo-kernel.wasm` (Jun 12) — use `local-binaries/kernel.wasm` |
| Dev shell entry | `export PATH="/nix/var/nix/profiles/default/bin:$PATH"; bash scripts/dev-shell.sh ...` |

## Open todos for session 47

| # | Task | Blocker? |
|---|---|---|
| 1 | Watch PR #698 CI (`gh pr checks 698 --watch`). Triage any failures. | Yes — blocks SDL2 PRs that stack on this. |
| 2 | Run handoff-43 §8 gauntlet on `d1b1156e8` (audio worktree): cargo, full vitest, check-abi-version.sh, libc-test, posix-test, `./run.sh browser /?demo=espeak`. | Soft — CI catches most; gauntlet is local belt-and-suspenders. |
| 3 | Address evdev Playwright regression — bisect or document in #698 body. | Soft — reviewers will ask. |
| 4 | Add `.gitignore` line (or rename `glue-objs/` → `espeak-ng-glue-objs/`) for espeak-ng build artifacts. Follow-up commit on `explore-dri-evdev-and-alsa`. | No. |
| 5 | Flip PR #698 from draft → ready for review once 1+2 are green. | — |
| 6 | **Start SDL2 milestone D**: read remaining ~945 lines of `2026-06-29-sdl2-port-plan.md` (Phase B + C + the rest), invoke `superpowers:subagent-driven-development`, begin Phase A Task A1. Do NOT block on PR #698 merging — Phase A is self-contained. Phase B is blocked on GL stack follow-up PRs in plans 2/3. | — |
| 7 | Confirm plan 6's EAGAIN return arm on `SNDRV_PCM_IOCTL_WRITEI_FRAMES` is present in our audio kernel (resolved-arch #1 depends on it). If absent, it's an audio-PR fix, not an SDL2 fix. | Yes for SDL2 audio path. |

## Standing instruction for session 47 — print THIS sentence

> *"Read `docs/plans/2026-06-15-dri-kandelo-port-handoff-46.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). PR #698 ('Add ALSA audio backend and espeak-ng browser demo', draft, base `explore-direct-rendering-infrastructure`) is open and mergeable; CI may still be pending. The audio branch `explore-dri-evdev-and-alsa` tip is `d1b1156e8` in the audio worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`. The audio gauntlet has NOT been run post-merge — do that if PR #698 CI surfaces nothing or if a local repro is needed. Then pivot to milestone D: read the rest of `docs/plans/2026-06-29-sdl2-port-plan.md` (you've read ~lines 1-1130; ~945 lines remain), invoke the `superpowers:subagent-driven-development` skill, and start Phase A Task A1 (libdrm-KMS package scaffold). DO NOT resurrect the per-commit grouping killed this session, DO NOT stage `docs/plans/*` or handoff markdowns into PRs (user instruction), DO NOT target `main` as the PR base — stack on `explore-dri-evdev-and-alsa` (or whatever its merge-target on `explore-direct-rendering-infrastructure` becomes). Phase A is unblocked; Phase B is blocked on plan-2/3 GL-stack follow-up PRs (libEGL.a / libGLESv2.a / `gbm_surface_*`) landing first. The two big open-architecture items are CLOSED: SDL2 audio = polling-based patch (option b), no pthreads; GL stack = plan-2/3 deliverable. Match PR style observed from #685/#686/#634/#623/#625 — sentence-case title, no scope prefix, `## Summary`/`## Notes`/`## Testing` body shape. `export PATH=\"/nix/var/nix/profiles/default/bin:$PATH\"` before `scripts/dev-shell.sh`. Auto-mode default; bias to action; pause on architectural calls."*
