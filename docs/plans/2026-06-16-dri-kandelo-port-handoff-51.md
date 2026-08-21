# DRI port onto kandelo:main — session 51 handoff (alsa-lib smoke + SwParams + Xferi fixes + ABI bump + squash commit landed; 6-suite gauntlet still in progress)

Continuation of [handoff-50](./2026-06-15-dri-kandelo-port-handoff-50.md). Session 51 picked up at the smoke-test-fails-at-SW_PARAMS state, fixed Bug 6 (`WpkAlsaPcmSwParams` 136 -> 104), audited the rest of the audio struct surface, fixed `WpkAlsaXferi` (24 -> 12), documented the still-broken `WpkAlsaPcmStatus`/`MmapStatus`/`MmapControl` mismatches, bumped `ABI_VERSION` 15 -> 16, then **squashed all of sessions 47/48/49/50 into ONE commit** titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling`. Branch tip is now `4dc64cf79` on `explore-dri-sdl2-shims`. A8's draft PR step is NOT yet done — `cd host && npx vitest run` (the full vitest pass) was started but interrupted before completion; it MUST be re-run from scratch before the PR opens.

## TL;DR — read this twice

1. **Branch tip is now `4dc64cf79`** on `explore-dri-sdl2-shims`. The four prior commits (`a763e24c3` libdrm package, `c8414fbeb` libdrm sysroot install, `51fb09c8e` libinput-lite, plus the in-session checkpoint) were collapsed by `git reset --soft explore-dri-evdev-and-alsa && git commit ...`. No prior commits remain.

2. **What's known passing after session 51:**
   - `cargo test -p kandelo --target aarch64-apple-darwin --lib` → 1069 tests pass.
   - `cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib` → 27 tests pass.
   - `cd host && npx vitest run test/alsa-lib-smoke.test.ts` → passes in 66ms.
   - `bash scripts/dev-shell.sh bash scripts/check-abi-version.sh` → exit 0; `ABI_VERSION = 16` matches `abi/snapshot.json`.
   - `bash scripts/dev-shell.sh bash build.sh` → builds clean (kernel.wasm at 694902 bytes, rootfs.vfs at 16783771 bytes).

3. **What's known FAILING / NEEDS REVERIFY after session 51:**
   - **Full vitest pass** (`cd host && npx vitest run`) was started in the background, **then terminated by the user before completion**. The first batch of failures observed (before terminate) was all `Binary not found: kernel.wasm` errors because the local-binaries kernel was built against ABI 15 BEFORE the ABI bump to 16. The bump-bake into the wasm landed AFTER, and `build.sh` was re-run, so the artifact under `local-binaries/kernel.wasm` (timestamp `Jun 15 22:17`) should now match. **Session 52 must re-run vitest from scratch.** This is the only outstanding gauntlet step before the PR can open — the kernel `cargo test`s + the smoke test both pass.
   - `scripts/run-libc-tests.sh` — not run yet.
   - `scripts/run-posix-tests.sh` — not run yet.

4. **A8 draft PR NOT opened.** Per the handoff-50 instructions: base = `explore-dri-evdev-and-alsa`, NOT `main`. The branch tip is `4dc64cf79`. The PR title should mirror the squash-commit title.

## Files modified during session 51

Session 51 collapsed 4 commits to ONE; the diff between `explore-dri-evdev-and-alsa` and current HEAD is what session 52 should treat as the PR scope.

### Additions in the squash (`4dc64cf79`)

- `crates/kernel/src/audio/ctl_ioctl.rs` — CTL ioctl gate (PVERSION + PCM_PREFER_SUBDEVICE).
- `host/test/alsa-lib-smoke.test.ts` — vitest harness for `programs/alsa_lib_smoke`.
- `host/test/libinput-stub.test.ts` — vitest harness for `programs/libinput_stub_smoke`.
- `packages/registry/alsa-lib/{package.toml, build.toml, build-alsa-lib.sh, patches/, src/conf_stubs.c, src/config.h}` — recipe + glue + 4 patches.
- `packages/registry/libdrm/{package.toml, build.toml, build-libdrm.sh}` — recipe.
- `packages/registry/libinput-lite/{package.toml, build.toml, build-libinput-lite.sh, include/libinput.h, src/libinput_stub.c}` — no-op stub recipe.
- `programs/alsa_lib_smoke.c` — smoke C program.
- `programs/libinput_stub_smoke.c` — smoke C program.

### Deletions in the squash

- `libc/glue/libdrm_stub.c` (391 LoC).
- `libc/musl-overlay/include/drm/{SOURCE.txt, drm.h, drm_fourcc.h, drm_mode.h}`, `libc/musl-overlay/include/{xf86drm.h, xf86drmMode.h}` (~4500 LoC). Replaced by alsa-lib + libdrm vendored UAPI under `$SYSROOT/include/{sound, drm, libdrm}`.

### Modifications in the squash

- `abi/snapshot.json` — regenerated; `abi_version: 16` plus the SYS_IOCTL marshalling switched from `fixed(256)` to `ioctl_encoded(arg_index=1, floor=256)`.
- `crates/kernel/src/audio/mod.rs` — `pub mod ctl_ioctl;` added.
- `crates/kernel/src/audio/pcm_ioctl.rs` — `refine_interval` returns ranges (not single values); `refine_hw_params` derives FRAME_BITS/PERIODS ranges from primary intervals; `SW_PARAMS` handler now reads `u32` fields and upcasts to `u64` for the `SwParamsCache`; `WRITEI` handler reads `req.buf` directly (no `as u32`) and writes `req.result as i32`; tests `refined_hw_params()` helper now narrows the intervals to `max = min` mimicking what alsa-lib does so HW_PARAMS unit tests still hit single-value `read_interval_single`; `pcm_hw_refine_wildcard_narrows_to_v1_defaults` test renamed to `pcm_hw_refine_wildcard_clamps_to_v1_range` and asserts ranges instead of single values; debug instrumentation REMOVED (no `WPK-DEBUG`, no `dbg_step!`, ENOTTY catch-all is back to `Err(Errno::ENOTTY)`).
- `crates/kernel/src/syscalls.rs` — CTL gate dispatch.
- `crates/kernel/src/wasm_api.rs` — HW_PARAMS hint comment updated.
- `crates/shared/src/host_abi.rs` — new `SyscallArgSize::IoctlEncoded { arg_index, floor }` + `ioctl_encoded!()` macro; Ioctl entry uses `ioctl_encoded(1, 256)`.
- `crates/shared/src/lib.rs` — `ABI_VERSION 15 -> 16` (with explanation comment); `WpkAlsaPcmHwParams.fifo_size: u64 -> u32` (struct = 604 B); `WpkAlsaPcmSwParams`: drop `_pad0`, all 7 uframes_t fields `u64 -> u32` (104 B); `WpkAlsaXferi`: `i64,u64,u64 -> i32,u32,u32` (12 B); `SNDRV_PCM_IOCTL_{HW_REFINE, HW_PARAMS} = 0xc25c_4110/0xc25c_4111`, `SW_PARAMS = 0xc068_4113`, `WRITEI_FRAMES = 0x400c_4150`; size assertion test updated to 104/12. `WpkAlsaPcmStatus`/`WpkAlsaPcmMmapStatus`/`WpkAlsaPcmMmapControl` have **doc-comment WASM32 LAYOUT NOTEs** explaining the still-broken offsets (see "What's broken now" below).
- `host/src/generated/abi.ts` — regenerated.
- `host/src/kernel-worker.ts` — `ioctl_encoded` arms in input + output marshalling loops.
- `libc/glue/abi_constants.h` — regenerated.
- `libc/glue/syscall_glue.c` — `SYS_IOCTL` blen computed from request bits. (Documentation of intent — `channel_syscall.c` is what's actually linked.)
- `scripts/build-musl.sh` — step 13 installs alsa-lib (replaces in-tree `<sound/asound.h>` overlay with vendored upstream).
- `scripts/build-programs.sh` — alsa_lib_smoke + libinput_stub_smoke link rules.
- `tools/xtask/src/dump_abi.rs` — new IoctlEncoded variant emitters for both TS and JSON.
- `programs/dri-modeset.c` — poll(fd, POLLIN, -1) before drmHandleEvent (carried from `c8414fbeb`).

### Resolver cache artifacts (disposable)

- `/Users/mho/.cache/kandelo/libs/alsa-lib-1.2.10-rev4-wasm32-589c73ff/libasound.a` — current; 351760 bytes.
- `/Users/mho/.cache/kandelo/libs/libdrm-2.4.120-rev*-wasm32-*` — current.
- `/Users/mho/.cache/kandelo/libs/libinput-lite-1.0.0-rev*-wasm32-*` — current.

## How session 51 unblocked smoke

The smoke test was failing at SW_PARAMS in handoff-50 because `WpkAlsaPcmSwParams = 136 B` (u64 uframes), but alsa-lib wasm32 emits 104 B (musl `unsigned long = 4`, `__SND_STRUCT_TIME64` defined). The fix was a 1-character-per-field type swap:

```rust
// Before (136 B, x86_64 layout)
pub struct WpkAlsaPcmSwParams {
    pub tstamp_mode: u32, pub period_step: u32, pub sleep_min: u32, pub _pad0: u32,
    pub avail_min: u64, pub xfer_align: u64, pub start_threshold: u64,
    pub stop_threshold: u64, pub silence_threshold: u64, pub silence_size: u64,
    pub boundary: u64, pub proto: u32, pub tstamp_type: u32,
    pub reserved: [u8; 56],
}
// After (104 B, wasm32 layout)
pub struct WpkAlsaPcmSwParams {
    pub tstamp_mode: u32, pub period_step: u32, pub sleep_min: u32,
    pub avail_min: u32, pub xfer_align: u32, pub start_threshold: u32,
    pub stop_threshold: u32, pub silence_threshold: u32, pub silence_size: u32,
    pub boundary: u32, pub proto: u32, pub tstamp_type: u32,
    pub reserved: [u8; 56],
}
```

The `_IOWR('A', 0x13, sizeof)` const recomputes automatically against the new size. The kernel's `SNDRV_PCM_IOCTL_SW_PARAMS` is now `0xc068_4113` matching what alsa-lib emits.

The handler at `crates/kernel/src/audio/pcm_ioctl.rs::511` upcasts the u32 fields to u64 when storing into `SwParamsCache` (which we kept as u64 internally — these are frame counts and the cache is consumed by kernel code expecting u64).

After that fix the smoke test reports `OK rate=48000` clean.

## What's broken now — Bug 7..N (DEFERRED to a follow-up session before SDL2 audio writei lands)

`WpkAlsaPcmStatus`, `WpkAlsaPcmMmapStatus`, `WpkAlsaPcmMmapControl` are still using x86_64 layout. They each carry a `WASM32 LAYOUT NOTE` doc comment in `crates/shared/src/lib.rs::audio` explaining the mismatch — search those notes if you don't want to redo the audit.

| Struct | Current size | Wasm32 size | Notes |
|---|---|---|---|
| `WpkAlsaPcmStatus` | 128 B | 128 B (coincidence) | Sizes match — `_IOC_SIZE` is fine — but every `snd_pcm_uframes_t` (`appl_ptr`/`hw_ptr`/`delay`/`avail`/`avail_max`/`overrange`) is `u64` here vs `u32` in alsa-lib. Field OFFSETS misalign so STATUS ioctl returns wrong values. Smoke does not exercise it. |
| `WpkAlsaPcmMmapStatus` | 64 B | 56 B | Layout is `__snd_pcm_mmap_status64`. Mmap'd to userspace — kernel writes, user reads via direct memory access. CURRENTLY BROKEN; user's `hw_ptr` poll path will read the wrong bytes. |
| `WpkAlsaPcmMmapControl` | 64 B | 12 B | Layout is `__snd_pcm_mmap_control64`. Both `appl_ptr` and `avail_min` are `u32` + 4 B `__pad_after_uframe` tail. Mmap'd to userspace. CURRENTLY BROKEN. |

For each: alsa-lib's UAPI struct is at `~/.cache/kandelo/libs/alsa-lib-1.2.10-rev4-wasm32-589c73ff/include/sound/uapi/asound.h` (search `struct snd_pcm_status`, `struct __snd_pcm_mmap_status64`, `struct __snd_pcm_mmap_control64`). `__SND_STRUCT_TIME64` IS defined on wasm32 musl (`__BITS_PER_LONG=32 && __USE_TIME_BITS64=1` — confirmed via `sysroot/include/bits/alltypes.h:56`).

Fix order: do `WpkAlsaPcmMmapControl` first (most invasive but cleanest — only 12 B); then `WpkAlsaPcmMmapStatus` (56 B with two `__snd_timespec64` fields = `i64 tv_sec + i32 tv_nsec + i32 pad`); then `WpkAlsaPcmStatus` (128 B with split `__time_pad`/`timespec` field-by-field). All three are accompanied by consumers in `crates/kernel/src/audio/pcm_ioctl.rs::STATUS`, `crates/kernel/src/fork.rs::write_audio_state/read_audio_state` (serialises by individual `write_i64` calls — easiest to keep the wire format as `i64` and cast at the in-memory struct boundary), `crates/kernel/src/audio/{mmap,tick}.rs`, and `crates/kernel/src/syscalls.rs::~14392`.

**Strategy when those land**: another `ABI_VERSION` bump is appropriate (mmap field layout changes are non-additive).

## What MUST happen first in session 52

1. **Re-run `cd host && npx vitest run`** end-to-end. Session 51 started it but the user terminated before completion. Now that `local-binaries/kernel.wasm` was rebuilt against `ABI_VERSION = 16` (timestamp `Jun 15 22:17`), the binary-policy resolver should accept it. Expected: all non-skipped suites pass. Anything that previously skipped because a package binary was missing will still skip.

2. **Run `scripts/run-libc-tests.sh`** and **`scripts/run-posix-tests.sh`** — gauntlet items 3 and 4. CLAUDE.md says 0 unexpected libc-test FAIL (XFAIL/TIME are OK) and 0 POSIX FAIL (UNRES/SKIP are OK).

3. **Open the draft PR** via `gh pr create --draft --base explore-dri-evdev-and-alsa`. Title: `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling`. Body should reference the squash commit's body (essentially the commit message verbatim, minus the trailer). **Do NOT** target `main` and **do NOT** stage `docs/plans/*` into the PR diff.

## Decisions to preserve from sessions 47/48/49/50/51

- `refine_interval` returns ranges (does NOT narrow).
- `SyscallArgSize::IoctlEncoded { arg_index, floor }` reads `(args[arg_index] >> 16) & 0x3fff` and floors at 256 for legacy size=0 ioctls.
- `WpkAlsaPcmHwParams.fifo_size: u32` (struct = 604 B); `SNDRV_PCM_IOCTL_{HW_REFINE,HW_PARAMS} = 0xc25c_4110/0xc25c_4111`.
- `WpkAlsaPcmSwParams`: 104 B, no `_pad0`, all uframes_t are `u32`; `SNDRV_PCM_IOCTL_SW_PARAMS = 0xc068_4113`.
- `WpkAlsaXferi`: 12 B (`i32, u32, u32`); `SNDRV_PCM_IOCTL_WRITEI_FRAMES = 0x400c_4150`.
- `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE = 0x4004_5532` (NOT `0x4004_5533` — session 49 had the typo).
- `page_align`/`page_size`/`page_ptr` stubs in alsa-lib's `src/conf_stubs.c`.
- `src/pcm/interval.c` + `src/pcm/mask.c` in alsa-lib `SUBSET_TUS`.
- alsa-lib `build.toml` `revision = 4` (each bump invalidates the resolver cache).
- `ABI_VERSION = 16` (bumped from 15).

## Standing instruction for session 52 — print THIS sentence

> *"Read `docs/plans/2026-06-16-dri-kandelo-port-handoff-51.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Branch `explore-dri-sdl2-shims` tip is now `4dc64cf79` — sessions 47/48/49/50 squashed in commit ONE titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling`; ABI_VERSION bumped 15 -> 16; smoke test passes; cargo kernel + shared tests pass (1069 + 27). The 6-suite gauntlet is INCOMPLETE: `cd host && npx vitest run` was started in session 51 but terminated before completion (initial failures were stale-ABI binary mismatches; `local-binaries/kernel.wasm` was rebuilt after that and now matches ABI 16). `scripts/run-libc-tests.sh` and `scripts/run-posix-tests.sh` have NOT been run. Once those three pass, open the draft PR with `gh pr create --draft --base explore-dri-evdev-and-alsa` — DO NOT target main; DO NOT stage `docs/plans/*` into the PR diff. Outstanding known-broken (not in this PR's scope): `WpkAlsaPcmStatus`/`WpkAlsaPcmMmapStatus`/`WpkAlsaPcmMmapControl` still use x86_64 layout instead of wasm32 (doc comments in `crates/shared/src/lib.rs::audio` describe the mismatch and the fix recipe); SDL2 audio writei/poll wire-up needs them fixed first. Auto-mode default; bias to action; pause if vitest or libc/posix tests surface a new regression that needs root-cause analysis."*
