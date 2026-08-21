# DRI port onto kandelo:main — session 53 handoff (devil's advocate run, ALSA struct deferred-fix closed out, branch renamed, B1 scaffold landed)

Continuation of [handoff-52](./2026-06-16-dri-kandelo-port-handoff-52.md). Session 53 ran the deferred Brandon-style devil's advocate review on the five concerns from handoff-52, executed the (b) ALSA struct realignment + smoke-test extension, re-ran the full 5-suite gauntlet (clean), renamed the branch to `explore-dri-sdl2`, and landed Phase B1 (SDL2 package scaffold). No PR is open. Phase B2–B6 + Phase C still ahead.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2` (renamed from `explore-dri-sdl2-shims`). Tip `6eda62af4`. Two new commits on top of `4dc64cf79`:
   - `9312b390f` — ALSA struct realignment for wasm32 uframes_t=4 ((b) fix).
   - `6eda62af4` — SDL2 package scaffold (B1).
2. **ABI:** still 16 (the (b) fix sits inside the same window Phase A bumped).
3. **All 5 gauntlet items clean** at tip `6eda62af4` (cargo + shared + libc-tests + posix-tests + check-abi-version).
4. **`origin/explore-dri-sdl2-shims` still exists.** Auto-mode classifier blocked the remote delete; run `git push origin --delete explore-dri-sdl2-shims` manually.

## Devil's advocate verdict from session 53

Recorded for posterity; the user accepted the recommendations:
- **(a)** Phase A's plan-vs-reality gap (sysroot-only → kernel + host + ABI) — no blocker. The plan's seam was wrong; collapse + new commits make this visible.
- **(b)** Deferred `WpkAlsaPcmStatus/MmapStatus/MmapControl` — **blocker, fixed this session**. SDL2's `snd_pcm_avail()` round-trips through SYNC_PTR which embeds these structs. Shipping with the doc-commented WASM32 LAYOUT NOTE lies would have surfaced as a runtime hang during Phase C demo verify.
- **(c)** Vitest cache-staleness disclosure — not a blocker but needs evidence-capture before PR opens. Task 8 still pending: capture a vitest run on `explore-dri-evdev-and-alsa` (ABI 15) showing the same 123 failures, attach to PR body. Also verify `staging-build.yml` rebuilds package binaries against current ABI before merge.
- **(d)** GL stack — bundle stubs in this PR (`libegl-stub` + `libgles2-stub` + `libgbm-extended` for `gbm_surface_*`). PR body must state the demo is a link/exec check, not a render check; real GL renderer lands in plan-2 follow-up.
- **(e)** Single-PR collapse — right call. Real rationale (write into PR body): Phase A as planned was sysroot-only but reality required ABI 16, and the consumer for that ABI is SDL2. Splitting would land ABI 16 with no consumer visible on `main`.

## What's done in commit `9312b390f` — (b) realignment

Diff: 8 files, +248/-177.

- `crates/shared/src/lib.rs`:
  - `WpkAlsaPcmStatus` keeps 128 B total (so `SNDRV_PCM_IOCTL_STATUS = 0x8080_4120` unchanged) but every field offset past `_pad1` shifts. Uframes shrink i64/u64 → u32. Timespecs become `i64 sec + i32 nsec + 4 B pad` triplets. Added `driver_tstamp_*` + `audio_tstamp_accuracy` fields (previously omitted from upstream UAPI).
  - `WpkAlsaPcmMmapStatus` shrinks 64 → 56 B, matches `__snd_pcm_mmap_status64`.
  - `WpkAlsaPcmMmapControl` shrinks 64 → 12 B, matches `__snd_pcm_mmap_control64`.
  - Three new size-assertion + field-offset assertion tests; all pass.
- `crates/kernel/src/audio/pcm_ioctl.rs` — `SNDRV_PCM_IOCTL_STATUS` handler rewritten to populate new fields; `delay` computed via i64 then clamped to i32; `handle_writei`'s appl/hw delta uses i64 widening.
- `crates/kernel/src/audio/tick.rs` — `tick` uses `hw_ptr.wrapping_add(frames_consumed)` (both u32); `current_appl_ptr` keeps its `-> i64` signature but works in u32 internally.
- `crates/kernel/src/fork.rs` — read/write of mmap_status / mmap_control updated to new field widths.
- `crates/kernel/src/syscalls.rs` — `install_alsa_pcm_fd` test helper's appl_ptr / hw_ptr params changed i64 → u32.
- `libc/musl-overlay/include/sound/asound.h` — overlay header rewritten to match wasm32 layout (`unsigned long = 4 B`, timespec = 16 B). At sysroot-build time it's shadowed by alsa-lib's UAPI; leaving it as kernel-side reference doc.
- `programs/alsa_lib_smoke.c` — drives `snd_pcm_status()` after `snd_pcm_hw_params()` and asserts `state == SND_PCM_STATE_PREPARED`. This catches the WpkAlsaPcmStatus marshalling ABI end-to-end.
- `host/test/alsa-lib-smoke.test.ts` — asserts `STATUS state=2` in stdout.

## What's done in commit `6eda62af4` — B1 scaffold

Diff: 3 files, +234.

- `packages/registry/sdl2/package.toml` — `kernel_abi = 16`, `depends_on = ["libdrm", "alsa-lib", "libinput-lite"]`, outputs `lib/libSDL2.a` + `include/SDL2`. `source.sha256` left blank for B2 to populate.
- `packages/registry/sdl2/build.toml` — commit pin + index_url.
- `packages/registry/sdl2/build-sdl2.sh` — fetches the upstream tarball + applies patches (none yet) + configures with the intended backend matrix (KMSDRM video, ALSA audio, evdev input; no pthreads, no dlopen, no libudev) + initial `ac_cv_*=no` override set per CLAUDE.md cross-compile policy. **Not yet attempted to build.**

`packages/registry/sdl2/{patches,src}/` directories are present but empty. Patches land in B5 (open-arch #1's polling-audio rewrite).

## Gauntlet at tip `6eda62af4`

- `cargo test -p kandelo --target aarch64-apple-darwin --lib` → **1069 / 1069 pass**.
- `cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib` → **28 / 28 pass** (includes 3 new offset-assertion tests).
- vitest spot-check: `alsa-lib-smoke` (with new STATUS readback), `libinput-stub`, `dri-modeset`, `dri-libdrm-kms`, `dri-kms-pageflip`, `audio-driver`, `browser-audio-driver-drain` — **all green**.
- `bash scripts/dev-shell.sh bash scripts/run-libc-tests.sh` → exit 0; XFAILs + 1 FLAKE-PASS + 1 TIME match handoff-52 baseline.
- `bash scripts/dev-shell.sh bash scripts/run-posix-tests.sh` → exit 0; **3 XFAIL + 2 SKIP, 0 FAIL, 0 UNRES** — matches baseline.
- `bash scripts/dev-shell.sh bash scripts/check-abi-version.sh` → exit 0; ABI 16 matches snapshot; snapshot consistent with sources.

vitest full-run failures (~123 across ~16 files) remain — preexisting stale-ABI-14 binary cache from main's June 11 14→15 bump, per handoff-52's analysis. Same failure profile, NOT a regression introduced by these commits.

## Remote state — clean up next session

```
origin/explore-dri-sdl2         (new; force-push tracked; tip 6eda62af4)
origin/explore-dri-sdl2-shims   (stale; needs delete)
origin/explore-dri-evdev-and-alsa  (base; unchanged)
```

Session 53 attempted the stale-head delete; auto-mode classifier blocked it. Run manually:
```bash
git push origin --delete explore-dri-sdl2-shims
```

## What MUST happen next session — in this order

1. **Delete stale remote head** (one command, see above).
2. **Phase B2 — first cross-compile pass.** Run `cargo xtask build-deps resolve sdl2`. Expected outcome: configure surfaces additional `ac_cv_*=no` overrides not in the initial list. Iterate the script; populate the sha256 in `package.toml` from the verified tarball; commit `sysroot(sdl2): SDL2 configure — final ac_cv_* override set + sha256 pin`.
3. **Phase B3–B5 — backend smoke tests + open-arch #1 patch.** Per plan tasks B3 (sdl2_kmsdrm_smoke), B4 (sdl2_alsa_smoke), B5 (sdl2_evdev_smoke + polling-audio patch under `packages/registry/sdl2/patches/0001-polling-audio-eagain.patch`, ~150 LoC).
4. **GL stubs** — three new packages under `packages/registry/`: `libegl-stub`, `libgles2-stub`, `libgbm-extended` (extends our existing libgbm with `gbm_surface_*`). PR body must state demo is link/exec, not render.
5. **Phase C1–C5** — `sdl2_demo` program + browser verify + PROCESS_TABLE lock-contention profiling gate. Per plan lines 1617–1976.
6. **Capture vitest evidence for (c)** — base-branch ABI-15 vitest log, attach to PR body. Verify CI behaviour for stale binaries.
7. **Re-run 5-suite gauntlet at final tip.**
8. **Open single draft PR.** Base = `explore-dri-evdev-and-alsa`. Title likely `sysroot(sdl2): libdrm-KMS + alsa-lib + libinput-lite + SDL2 2.30 + demo + ABI 16 (one-PR SDL2 milestone D)` — review post-final-gauntlet. PR body covers the structural rationale for the single-PR collapse, the (b) realignment + alsa-lib-smoke status-readback, the GL-stubs gap, and the preexisting vitest cache-staleness disclosure with the evidence log.

## Branch / commit invariants (preserve into session 54)

- **Branch:** `explore-dri-sdl2` (tracking `origin/explore-dri-sdl2`).
- **Tip:** `6eda62af4` — `sysroot(sdl2): scaffold SDL2 2.30.0 package + dep manifest (B1)`.
- **Three commits since base** (`explore-dri-evdev-and-alsa`): `4dc64cf79`, `9312b390f`, `6eda62af4`.
- **ABI_VERSION:** 16.
- **`abi/snapshot.json`:** unchanged from `4dc64cf79`. The (b) realignment moved field offsets but not struct sizes or export names; snapshot tracks export names only.
- **Cached resolver artifacts:** alsa-lib + libdrm + libinput-lite caches still valid; sdl2 not yet resolved (will source-build first time).
- **Working tree state:** `libc/musl` + `tests/sortix/os-test` submodule diffs, `tests/libc/libc-test` untracked, `apps/browser-demos/test-results/` untracked, `docs/plans/*` untracked (40+ files). **DO NOT stage `docs/plans/*` into any PR diff.**

## Findings from this session worth preserving (avoid re-deriving)

These are the non-obvious technical facts session 53 spent real time discovering. Future-me: do not waste a context window proving these again.

### Wasm32 musl ABI for snd_pcm_uframes_t

- `unsigned long` is **4 B on wasm32** (NOT 8). `snd_pcm_uframes_t = unsigned long` → u32. `snd_pcm_sframes_t = signed long` → i32.
- `__SND_STRUCT_TIME64` is **always defined** on wasm32 because `__BITS_PER_LONG == 32 && __USE_TIME_BITS64` per `packages/registry/alsa-lib/alsa-lib-src/include/sound/uapi/asound.h:311`. So `__snd_timespec64 = timespec`.
- `struct timespec` on wasm32 musl = `{ time_t tv_sec; long tv_nsec; }` = `{ i64; i32; }`. **Critical alignment rule:** LLVM wasm32 sets `__alignof__(long long) = 8`. So `struct timespec` = **16 B** with 4 B trailing pad (not 12 B). This trips everyone the first time. Verify on real symptoms; do NOT assume wasm32 has packed i64 like some 32-bit ABIs do.
- Putting these together: `snd_pcm_status` on wasm32 = 128 B, but the field layout differs from x86_64 because every `snd_pcm_uframes_t` field is 4 B instead of 8 B. The 128 B total happens to match by accident — the saved-size on `delay`/`avail`/`avail_max`/`overrange` (4 × 4 B saved each) gets paid back by the new `driver_tstamp` (16 B) + `audio_tstamp_accuracy` (4 B). Net zero. Don't fall into the trap of "size is unchanged → struct is unchanged" — every offset past `_pad1` shifted.
- `_IOR('A', 0x20, struct snd_pcm_status) = 0x|2<<30|128<<16|'A'<<8|0x20| = 0x8080_4120`. Unchanged before/after this session's work.

### Why the in-tree musl-overlay sound/asound.h is dead code at user-program build time

`scripts/build-musl.sh` step 11 (line 278) does `rm -rf "$SYSROOT/include/sound" && ln -sf "$ALSA_PREFIX/include/sound" "$SYSROOT/include/sound"`. The alsa-lib install dir contains the upstream UAPI headers (which are already wasm32-correct). The musl-overlay file is therefore only seen by humans reading the kernel-side reference. **Do not** waste energy testing whether changes to `libc/musl-overlay/include/sound/asound.h` affect user-program builds — they don't, until step 11 stops shadowing.

### Alsa-lib's snd_pcm_status flow (relevant for B3/B4/B5 tests)

- `snd_pcm_status_t` is opaque to user code; allocated by `snd_pcm_status_malloc()`.
- `snd_pcm_status(pcm, status)` dispatches through the pcm_hw vtable to `ioctl(fd, SNDRV_PCM_IOCTL_STATUS, &status->internal_struct)`. The internal struct IS the marshalled WpkAlsaPcmStatus layout.
- After `snd_pcm_hw_params()`, alsa-lib internally calls `snd_pcm_prepare()`. So a STATUS readback after HW_PARAMS returns `SND_PCM_STATE_PREPARED = 2`, NOT `SND_PCM_STATE_SETUP = 1`. (Session 53 hit this — wasted ~30 seconds before catching it.)

### Auto-mode classifier denials encountered this session

- `git push origin --delete <branch>` is blocked (destructive remote op). User must run manually.
- Most other git operations work fine (push, commit, branch -m, push -u).

### vitest working-directory gotcha

`npx vitest run` from inside `host/` changes cwd to `host/`. Subsequent shell commands in the same session need explicit `cd` back to the repo root, or absolute paths. The Bash tool persists cwd between calls. **Either:** (a) always pass an absolute path to scripts, or (b) prefix shell commands with `cd /Users/mho/emdash/.../9vbaz && …`.

### Build script gotcha: build.sh doesn't rebuild C++ test programs

`bash build.sh` succeeds through the kernel + host TS + C programs build, then trips on `wasm32posix-c++: command not found` when compiling C++ fork-instrumentation tests. **This is pre-existing**, not session 53 breakage. Skip it: rely on `scripts/build-programs.sh` for C-only program builds, which also fails on the same C++ step but later than the artifacts needed.

### Cache paths that matter

- `~/.cache/kandelo/libs/alsa-lib-1.2.10-rev4-wasm32-589c73ff/` — current valid alsa-lib install (sha cache_key locked, still valid since the build script content hasn't changed since rev4).
- `~/.cache/kandelo/libs/libdrm-2.4.120-rev1-wasm32-*` — current valid libdrm install.
- `~/.cache/kandelo/libs/libinput-lite-*` — current valid libinput-lite install.
- `~/.cache/kandelo/programs/` — package binary cache. Stale: ABI-14 binaries (php, spidermonkey, bash, etc.) from before PR #654's June 11 bump. **These are what cause the 123 vitest failures**. To refresh: `scripts/fetch-binaries.sh --allow-stale` (hours of source builds, since archives at ABI 16 don't exist yet).

### Brandon-style devil's advocate framing for the eventual PR body

The reviewer will ask: "Why one PR? Why kernel changes in 'Phase A'? Why the deferred-fix follow-up commit?" Pre-emptive answers in the body:
1. "Phase A as planned was sysroot-only, but reality required ABI 16 (audio struct shrink + IoctlEncoded marshalling). Without the consumer for ABI 16 visible on `main`, the change reads as 'what calls this?'. Splitting would land ABI 16 with no consumer."
2. "Commit 9312b390f follows up Phase A's three deferred audio structs immediately rather than during Phase B. Shipping with the doc-commented WASM32 LAYOUT NOTE lies would have manifested as a runtime hang during SDL2's polling-audio writei path, debugged through the wrong layer."
3. "vitest cache-staleness: 123 failures reproduce on `explore-dri-evdev-and-alsa` (ABI 15) with the same ABI-14 binary cache. Evidence log in [link]. Real fix is CI source-rebuilding binaries at current ABI; verify staging-build.yml does this."

## Standing instruction for session 54 — print THIS sentence

> *"Read `docs/plans/2026-06-16-dri-kandelo-port-handoff-53.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Branch is `explore-dri-sdl2`, tip `6eda62af4`. ABI 16. Five-suite gauntlet clean at tip. FIRST step this session: (a) `git push origin --delete explore-dri-sdl2-shims` to clean the stale remote head from session 52's rename, then (b) Phase B2 — run `cargo xtask build-deps resolve sdl2`, iterate `ac_cv_*=no` overrides in `packages/registry/sdl2/build-sdl2.sh` until the cross-compile produces a usable `libSDL2.a`, then populate `source.sha256` in `package.toml` from the verified tarball. After B2 lands: B3/B4/B5 (backend smoke tests + open-arch #1 polling-audio patch), bundle GL stubs (libegl-stub + libgles2-stub + libgbm-extended), Phase C (sdl2_demo + browser verify + PROCESS_TABLE profiling gate), capture vitest evidence on `explore-dri-evdev-and-alsa` for the preexisting-stale-cache disclosure, re-run the full gauntlet, then open the single draft PR against `explore-dri-evdev-and-alsa`. Auto-mode default; bias to action; pause if anything surfaces a new regression that needs root-cause analysis."*
