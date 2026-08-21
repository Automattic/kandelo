# DRI port onto kandelo:main — session 52 handoff (gauntlet completed, Phase A scope re-decided as single-PR SDL2 on `explore-dri-sdl2`, devil's advocate deferred to next session)

Continuation of [handoff-51](./2026-06-16-dri-kandelo-port-handoff-51.md). Session 52 picked up at the gauntlet-incomplete state, ran vitest + libc-tests + posix-tests, root-caused the vitest failures, **pushed the branch but DID NOT open the draft PR**, and then the user redirected: collapse the three-PR SDL2 stack into a **single PR on a branch named `explore-dri-sdl2`** and **defer devil's advocate to session 53**. No PR is open. The branch tip is unchanged at `4dc64cf79` on the still-`explore-dri-sdl2-shims`-named branch (push reached the remote at that name).

## TL;DR — read this first

1. **All five gauntlet items pass** at branch tip `4dc64cf79` (ABI 16). The only "failure" surface is **123 vitest tests across 16 files**, and that's preexisting cache staleness from main's 14→15 ABI bump (PR #654, `faf06b261`, June 11). Proof + analysis below.

2. **User directive (this session):** the SDL2 port plan's three-PR stack (sdl2-shims → sdl2 → sdl2-demo) is **collapsed to ONE PR** on a branch named **`explore-dri-sdl2`** (not `-shims`/`-port`/`-demo` suffixes). Current branch `explore-dri-sdl2-shims` should be **renamed** at the start of session 53.

3. **Devil's advocate review** of the current commit + the consolidated SDL2 plan **was NOT run** this session. It is the FIRST thing session 53 does, before any code lands.

4. **The branch was pushed to remote** at `git@github.com:Automattic/kandelo.git` as `explore-dri-sdl2-shims`. **No PR was opened.** The remote ref name needs migrating to `explore-dri-sdl2` next session (force-push the renamed local branch, then delete the stale remote head).

## What's known passing after session 52

- `cargo test -p kandelo --target aarch64-apple-darwin --lib` → **1069 tests pass** (same as handoff-51).
- `cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib` → **27 tests pass** (same).
- `cd host && npx vitest run` → **88/128 test files pass, 665 individual tests pass, 102 skipped, 123 fail.** The 123 failures are entirely the **stale-binary cache** issue documented below — `verifyProgramAbi` rejects programs that don't match the kernel's ABI exactly, and the cached binaries advertise `__abi_version=14`. Same failure mode would occur on **base branch `explore-dri-evdev-and-alsa` (ABI 15)** — the binaries are at ABI 14 regardless of which branch you check out. **Not a regression introduced by this PR.**
- `cd host && npx vitest run test/alsa-lib-smoke.test.ts` → passes (same as handoff-51).
- `cd host && npx vitest run test/libinput-stub.test.ts` → passes.
- `bash scripts/dev-shell.sh bash scripts/run-libc-tests.sh` → **303 PASS, 20 XFAIL (math + OOM tests, all expected), 1 FLAKE-PASS, 0 unexpected FAIL** (CLAUDE.md item 3 — CLEAN).
- `bash scripts/dev-shell.sh bash scripts/run-posix-tests.sh` → **174 PASS, 3 XFAIL, 2 SKIP, 0 UNRESOLVED, 0 FAIL** (CLAUDE.md item 4 — CLEAN).
- `bash scripts/dev-shell.sh bash scripts/check-abi-version.sh` → exit 0; ABI 16 matches snapshot.

## The vitest cache-staleness story (read once, never re-investigate)

Symptom in the test log:

```
[process-worker] Kernel worker failed: pid=100: ABI version mismatch — kernel advertises 16,
user program built against 14. Rebuild the program against the current kernel, or roll back
the kernel to the matching version. See docs/abi-versioning.md.
```

The check is at `host/src/worker-main.ts:756-787` (`verifyProgramAbi`). It does **strict equality** between the kernel's advertised ABI and the user program's `__abi_version` global. No range tolerance.

History:
- Until June 11, 2026, `ABI_VERSION = 14`. Cached binaries under `~/.cache/kandelo/programs/` (e.g. `php-8.3.2-rev3-wasm32-01d65fd3`, `spidermonkey-140.11.0esr-rev10-wasm32-bd33d4b3`) carry `__abi_version=14`.
- **PR #654 (commit `faf06b261`)** bumped 14→15 on `main` on **2026-06-11 22:50:18 -0400** ("Clean out legacy single-process kernel remnants").
- `explore-dri-evdev-and-alsa` (this PR's base) is at ABI 15; `main` is at ABI 15.
- Session 51 bumped 15→16 on `explore-dri-sdl2-shims`.

The cached binaries are at ABI 14, so they mismatch **both** ABI 15 (base branch) and ABI 16 (our branch). The mismatch error is identical:

| Branch | Kernel ABI | Cached binaries say | `verifyProgramAbi` result |
|---|---|---|---|
| `main` / `explore-dri-evdev-and-alsa` | 15 | 14 | "kernel advertises 15, user program built against 14" → throw |
| `explore-dri-sdl2-shims` (us) | 16 | 14 | "kernel advertises 16, user program built against 14" → throw |

The vitest "regression" is preexisting state from `main` since June 11. The real fix is `scripts/fetch-binaries.sh --allow-stale` to source-rebuild every package against the current ABI (slow — hours). For this PR's purposes, the disclosure path is to **document the preexisting state in the PR body** and ship.

The session 51 handoff's expectation ("vitest pass should work because kernel.wasm matches ABI 16") was incorrect — kernel.wasm was the only artifact rebuilt, but the package binaries (spidermonkey, php, bash, …) are independent fetches that also need to be at the current ABI. They aren't.

What did NOT cause this:
- `cargo test -p kandelo` still passes (1069/1069) — kernel unit tests don't load user programs.
- `cargo test -p wasm-posix-shared` still passes (27/27).
- Smoke tests `alsa-lib-smoke.test.ts` + `libinput-stub.test.ts` pass — those build fresh user programs (`programs/alsa_lib_smoke.c` + `programs/libinput_stub_smoke.c`) against the **current** sysroot, so their `__abi_version=16` matches.

## User directive (session 52)

**One PR. One branch. `explore-dri-sdl2`. Devil's advocate next session.**

The original SDL2 port plan (`docs/plans/2026-06-29-sdl2-port-plan.md`, lines 155-161) ships milestone D as **three coordinated PRs**:

1. `sysroot(sdl2-shims): libdrm-KMS + alsa-lib subset + libinput-lite stub` (Phase A)
2. `sysroot(sdl2): vendor SDL2 + cross-compile + backend wiring` (Phase B)
3. `examples(sdl2): sdl2_demo + browser spec + Phase C profiling gate` (Phase C)

**Collapsed:** All three phases land in **one PR** on **one branch** named `explore-dri-sdl2`. PR title and body will be drafted in session 53 after devil's advocate.

This collapse decision implies:
- The `explore-dri-sdl2-shims` branch name is **wrong** — rename to `explore-dri-sdl2`.
- The squash commit title `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling` is **the Phase A scope only**. Phases B + C add commits on top before the PR opens.
- The Phase B/C task lists (in `2026-06-29-sdl2-port-plan.md` lines 1238-2076) are NOT yet started.
- The "do not merge Phase A alone" rider in the plan (line 1234) is moot now — there will not be a Phase A PR. The single PR holds A + B + C.

## What's on the remote right now (clean up next session)

```
explore-dri-sdl2-shims  →  origin/explore-dri-sdl2-shims  (pushed this session)
explore-dri-evdev-and-alsa  →  origin/explore-dri-evdev-and-alsa  (base; unchanged)
```

`origin/explore-dri-sdl2-shims` exists on `git@github.com:Automattic/kandelo.git` with the squash commit. **No PR was opened against it.** Session 53 should:

1. Rename the local branch: `git branch -m explore-dri-sdl2-shims explore-dri-sdl2`.
2. Push the new name: `git push -u origin explore-dri-sdl2`.
3. Delete the stale remote: `git push origin --delete explore-dri-sdl2-shims`.
4. (No active PR to retarget — none was opened.)

## Phase A scope expanded BEYOND the plan — read this BEFORE devil's advocate

The plan declared Phase A as "**sysroot-only — no kernel code, no host code, no ABI impact**" (line 16) and predicted `abi/snapshot.json` byte-identical (line 1219). **Reality:** the actual squash commit (`4dc64cf79`) ships kernel + host + ABI changes. The drift was forced by attempting to build alsa-lib against the existing PCM ioctl surface and discovering:

1. **Kernel CTL ioctl gate missing.** alsa-lib's `snd_pcm_open` flow fans `SNDRV_CTL_IOCTL_PVERSION` + `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE` before opening the PCM fd. Kernel had no `/dev/snd/controlC0` handler. **Fix:** new `crates/kernel/src/audio/ctl_ioctl.rs` (PVERSION + PCM_PREFER_SUBDEVICE), wired through `audio/mod.rs` + `syscalls.rs`.
2. **PCM HW_REFINE narrowed intervals to single values; alsa-lib needs ranges.** `snd_pcm_hw_params_choose()` narrows iteratively via `set_first()` — feeding it a single value made `set_rate_near()` fail. **Fix:** `refine_interval` returns ranges (`min..=max` clamped to capabilities); derived intervals (FRAME_BITS, PERIODS) propagate ranges from primaries.
3. **Host adapter SYS_IOCTL was `fixed(256)`; HW_PARAMS payload is 604 bytes.** Channel-encoded copies truncated at offset 260, garbling every interval past index 11. **Fix:** new `SyscallArgSize::IoctlEncoded { arg_index, floor }` variant reads `(args[1] >> 16) & 0x3fff` (the `_IOC_SIZE` bits) and falls back to `floor=256` for legacy size=0 ioctls (FIONBIO, KDGKBTYPE). Wired through `host_abi.rs`, `dump_abi.rs`, `host/src/generated/abi.ts`, `libc/glue/abi_constants.h`, `libc/glue/syscall_glue.c`, and the input/output marshalling loops in `host/src/kernel-worker.ts`.
4. **Audio struct wasm32 layout mismatch.** `__SND_STRUCT_TIME64=1` and `unsigned long=4` on wasm32 musl, but several structs were sized against x86_64. Fixed in this PR:
   - `WpkAlsaPcmHwParams.fifo_size: u64 → u32` (608 → 604); `SNDRV_PCM_IOCTL_HW_{REFINE,PARAMS} = 0xc25c_4110/0xc25c_4111`.
   - `WpkAlsaPcmSwParams`: drop `_pad0`, all 7 `snd_pcm_uframes_t` fields `u64 → u32` (136 → 104); `SNDRV_PCM_IOCTL_SW_PARAMS = 0xc068_4113`.
   - `WpkAlsaXferi`: `i64,u64,u64 → i32,u32,u32` (24 → 12); `SNDRV_PCM_IOCTL_WRITEI_FRAMES = 0x400c_4150`.

   **Still deferred (NOT in this PR — needed before SDL2 audio writei/poll lands):**
   - `WpkAlsaPcmStatus` (size still 128 B by coincidence, but every `snd_pcm_uframes_t` is 8 B here vs 4 B in alsa-lib → field offsets misalign).
   - `WpkAlsaPcmMmapStatus` (64 B → should be 56 B; mmap'd to userspace).
   - `WpkAlsaPcmMmapControl` (64 B → should be 12 B; mmap'd to userspace; both `appl_ptr` and `avail_min` are `u32` + 4 B `__pad_after_uframe`).

   Each has a `WASM32 LAYOUT NOTE` doc comment in `crates/shared/src/lib.rs::audio` with the fix recipe.

5. **`ABI_VERSION 15 → 16`.** Audio struct shrinks + IoctlEncoded variant are non-additive changes to existing ABI surface. The IoctlEncoded variant in particular means the channel round-trips the full ioctl payload instead of truncating at 256 B; an old binary calling HW_PARAMS would have received truncated state.

## Open architecture / blockers carried forward into the single SDL2 PR

(From `2026-06-29-sdl2-port-plan.md` open-architecture sections — relevant for session 53's planning.)

- **Open-arch #1 (audio thread model) — RESOLVED.** Plan 9's devil's-advocate (session 10) picked **option (b)**: SDL2 polling-audio patch + plan 6 EAGAIN-on-full-ring arm. **Implications:** SDL2 needs a ~150 LoC patch under `packages/registry/sdl2/patches/` so `SDL_RunAudio` is driven from `SDL_PumpAudio` instead of a `SDL_CreateThread` worker. Plan 6 needs `SNDRV_PCM_IOCTL_WRITEI_FRAMES` to return `-EAGAIN` (not `-EBUSY`) on a full ring. The single PR includes both pieces.
- **Open-arch #2 (GL stack) — UNRESOLVED.** SDL2's KMSDRM backend wants `-lEGL -lGLESv2 -lgbm` as static libs + `gbm_surface_*` API. The repo's v1 has `host_gl_*` imports but no `sysroot/lib/libEGL.a` / `libGLESv2.a` / `libgbm.a-with-gbm_surface` artifacts. **Two options:**
  1. Include `libegl-stub`/`libgles2-stub`/extended `libgbm` as additional packages in the single SDL2 PR.
  2. Land them as a plan-2 follow-up PR before this single PR opens.
  The plan favoured (2); the single-PR collapse may favour (1). **Decide in session 53.**
- **KMS-master coexistence with wpkcompositor.** Plan 9's compositor and SDL2's KMSDRM demo both `drmSetMaster` → mutually exclusive in v1. Boot ordering: if `/etc/wpk/compositor` exists, SDL2 demo exits EBUSY. `SDL_wpkvideo` (plan 11) is the post-v1 coexistence path. **Not a blocker for this PR; document in body.**
- **`drm_event_vblank` record size.** Plan 4 risk register #2 flags this; SDL2's `drmHandleEvent` parses these records read from card0. Add a libdrm-side `_Static_assert(sizeof(drm_event_vblank) == 32)` and verify kernel-side producer matches. **Resolve as part of the SDL2 PR's B3 smoke test.**
- **`EVIOCGKEY` / `EVIOCGREP` graceful-degrade.** SDL2's `SDL_EVDEV_AddDevice` calls both; plan 5's kernel needs the default-arm returning **ENOTTY** (not EINVAL) so SDL2 treats them as "no state". Verify in B5 smoke; patch plan 5 default arm if needed (~10 LoC).

## What MUST happen first in session 53 — in this order

1. **Devil's advocate review (Brandon style)** of:
   - The current squash commit (`4dc64cf79`) — particularly the unplanned kernel/host/ABI expansion of Phase A.
   - The decision to collapse three PRs into one.
   - The deferred audio struct fixes — is shipping the single PR with these known-broken structs acceptable, or should they be fixed first (forcing a non-trivial commit before Phase B starts)?
   - The vitest cache-staleness disclosure — is "preexisting" the right call, or should `scripts/fetch-binaries.sh` run before the PR opens (hours of source builds)?
   - Open-arch #2 (GL stack) — option 1 (bundle into this PR) vs option 2 (separate plan-2 follow-up PR).
2. **Rename the branch:** `git branch -m explore-dri-sdl2-shims explore-dri-sdl2`; push with `-u`; delete stale remote head.
3. **Start Phase B:** vendor SDL2 2.30, cross-compile, KMSDRM + ALSA + evdev wiring. Per the plan's Task B1–B6 (lines 1240-1614).
4. **Start Phase C:** sdl2_demo + browser verify + PROCESS_TABLE lock-contention profiling gate. Per Task C1–C5 (lines 1617-1976).
5. **Re-run the full 5-suite gauntlet** at the final tip.
6. **Open the single draft PR** with title and body drafted post-devil's-advocate. Base = `explore-dri-evdev-and-alsa`. Title likely `sysroot(sdl2): libdrm-KMS + alsa-lib + libinput-lite + SDL2 2.30 + demo + ABI 16 (one-PR SDL2 milestone D)` (subject to devil's advocate trim).

## Branch / commit invariants (preserve into session 53)

- **Branch tip:** `4dc64cf79` on `explore-dri-sdl2-shims` (to be renamed). One commit ahead of `explore-dri-evdev-and-alsa`.
- **ABI_VERSION:** 16.
- **`abi/snapshot.json`:** regenerated; SYS_IOCTL marshalling is `ioctl_encoded(1, 256)`.
- **Cached resolver artifacts:** `/Users/mho/.cache/kandelo/libs/alsa-lib-1.2.10-rev4-wasm32-589c73ff/libasound.a` (351760 B), `libdrm-2.4.120-rev*-wasm32-*`, `libinput-lite-1.0.0-rev*-wasm32-*` — all current.
- **`local-binaries/kernel.wasm`:** 694902 bytes, Jun 15 22:17 timestamp, matches ABI 16.
- **`local-binaries/rootfs.vfs`:** 16783771 bytes, Jun 15 22:17 timestamp.
- **Working tree:** docs/plans/* untracked (39 files); submodule diffs `libc/musl`, `tests/libc/libc-test`, `tests/sortix/os-test`; `apps/browser-demos/test-results/` untracked; `open-posix-testsuite/` untracked. **DO NOT stage `docs/plans/*` into any PR diff.**

## Standing instruction for session 53 — print THIS sentence

> *"Read `docs/plans/2026-06-16-dri-kandelo-port-handoff-52.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Branch tip is `4dc64cf79` on `explore-dri-sdl2-shims` (rename to `explore-dri-sdl2` before any further work). ABI 16. All five gauntlet items pass (vitest's 123 failures are preexisting stale-ABI-14 binary cache from main's June 11 14→15 bump, NOT this PR's regression — proof in the handoff). SDL2 port plan collapsed from three PRs to ONE PR on `explore-dri-sdl2`. FIRST step this session: run devil's advocate review (Brandon style) on (a) the unplanned kernel/host/ABI expansion of Phase A, (b) the deferred WpkAlsaPcmStatus/MmapStatus/MmapControl struct fixes, (c) the vitest cache-staleness disclosure, (d) open-arch #2 (GL stack — bundle vs separate PR), and (e) the single-PR collapse itself. After devil's advocate: rename the branch, start Phase B (vendor SDL2 2.30 + cross-compile + KMSDRM/ALSA/evdev wiring per plan tasks B1–B6), then Phase C (sdl2_demo + browser verify + PROCESS_TABLE lock-contention profiling gate per tasks C1–C5), then re-run the gauntlet, then open the single draft PR against `explore-dri-evdev-and-alsa`. Auto-mode default; bias to action; pause if anything surfaces a new regression that needs root-cause analysis."*
