# DRI port onto kandelo:main — session 50 handoff (alsa-lib smoke now passes ctl + open + HW_REFINE + HW_PARAMS; still fails at SW_PARAMS because kernel marshalled audio structs use u64 for `snd_pcm_uframes_t` but wasm32 musl uses u32)

Continuation of [handoff-49](./2026-06-15-dri-kandelo-port-handoff-49.md). Session 50 *root-caused and fixed* the snd_pcm_open ENOTTY (it was a wrong PCM_PREFER_SUBDEVICE nr — `0x33` instead of `0x32`), then uncovered **four** more bugs serially that the failing smoke test surfaced:

1. **`page_align`/`page_size` missing** at link time (defined in elided `src/conf.c`) → added to `conf_stubs.c`.
2. **`snd1_interval_refine_set` missing** → added `src/pcm/interval.c` + `src/pcm/mask.c` to alsa-lib `SUBSET_TUS`.
3. **Kernel's `refine_hw_params` narrows intervals to a single value** during HW_REFINE → alsa-lib's `snd_pcm_hw_param_set_rate_near(48000)` couldn't widen `rate[8000,8000]` back. Changed `refine_interval` to leave the range intact; `snd_pcm_hw_params_choose()` (user-space) now does the narrowing iteratively before HW_PARAMS commits.
4. **`WpkAlsaPcmHwParams` is 608 bytes (uses `u64` for `fifo_size`) but alsa-lib on wasm32 sends 604 bytes** (musl's `unsigned long = 4`, so `snd_pcm_uframes_t = 4`). The `_IOC_SIZE` mismatch made the ioctl number `0xc25c4110` vs the kernel's `0xc260_4110`, so it hit ENOTTY. Shrunk the struct to 604, bumped the ioctl constants, fixed the size assertion.
5. **Host adapter only marshals 256 bytes for SYS_IOCTL** (`host_abi.rs`: `desc!(2, InOut, fixed!(256))`) — so even with a correct kernel side, only the first 256 bytes round-tripped the channel and intervals at offset 260+ were never seen by the kernel. Added a new `SyscallArgSize::IoctlEncoded { arg_index, floor }` variant that reads `(args[arg_index] >> 16) & 0x3fff` (the `_IOC_SIZE` bits) and falls back to the floor for legacy size=0 ioctls (FIONBIO/KDGKBTYPE/…). Wired it through host_abi → dump_abi → abi.ts + abi/snapshot.json + libc/glue/abi_constants.h. Also updated the libc dispatcher (`syscall_glue.c::SYS_IOCTL`) — note `syscall_glue.c` is NOT linked into user programs (the build scripts pull in `channel_syscall.c` instead), so the libc change is documentation-of-intent only.

After all five fixes, the smoke test now reaches `SNDRV_PCM_IOCTL_SW_PARAMS` (request `0xc0684113` — encoded size 0x68 = 104) and the kernel reports ENOTTY because the kernel's `SNDRV_PCM_IOCTL_SW_PARAMS` constant is computed against `WpkAlsaPcmSwParams = 136 bytes` (which uses `u64` for the uframes_t fields). **Same root cause as `WpkAlsaPcmHwParams.fifo_size`**: every `snd_pcm_uframes_t` and `snd_pcm_sframes_t` field in the kernel-side structs is `u64` but wasm32 alsa-lib emits 4-byte fields. Almost certainly the same goes for `WpkAlsaPcmStatus`, `WpkAlsaPcmInfo`, `WpkAlsaXferi`, `WpkAlsaPcmMmapStatus`, `WpkAlsaPcmMmapControl` — all need the wasm32 audit.

A8 (squash + gauntlet + draft PR) NOT started. Smoke test STILL FAILS.

## TL;DR — read this twice

1. **Branch tip unchanged: `51fb09c8e`.** No new commits in session 50 — everything is uncommitted because the smoke test isn't passing yet and I don't want to checkpoint a half-working ALSA marshalling layer.

2. **Confirmed in this session:**
   - `snd_pcm_open("default", PLAYBACK, 0)` succeeds (CTL_PVERSION + PCM_PREFER_SUBDEVICE + PCM_INFO + PCM_PVERSION all return ok).
   - `snd_pcm_hw_params_any(pcm, hw)` succeeds (HW_REFINE returns refined RANGES, alsa-lib accepts).
   - `snd_pcm_hw_params_set_access/format/channels(2)/rate_near(48000)` all return err=0 with the expected values; the kernel HW_REFINE trace shows `ch[2,2]` and `rate[48000,48000]` after each `set_*`.
   - `snd_pcm_hw_params_choose()` in user-space narrows intervals to single values; final HW_REFINE input is `period[64,64] buffer[16384,16384] rate[48000,48000] ch[2,2] periods[256,256]`.
   - **Failure point**: `snd_pcm_hw_params(pcm, hw)` → after HW_PARAMS commits, alsa-lib calls SW_PARAMS → kernel returns ENOTTY because the user emits `0xc0684113` (size 104) but the kernel only knows `0xc068...` with size 136 (= `0xc068` no wait, size 136 = 0x88, encoded `_IOWR('A', 0x13, 136)` = `0xc0884113`). The kernel's `SNDRV_PCM_IOCTL_SW_PARAMS` const is `0xc0884113`, request is `0xc0684113`, doesn't match → ENOTTY catch-all fires.

3. **All five session-50 fixes are LIVE in the working tree but uncommitted.** Files listed in the next section. Re-verify with `git status --short` and `git diff` before squashing.

## Files modified during session 50 — DO NOT lose

Working tree at session 50 close:

### Modifications (M)
- `crates/kernel/src/audio/ctl_ioctl.rs` — **`SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE` corrected from `0x4004_5533` to `0x4004_5532`** (`_IOW('U', 0x32, int)`; handoff-49's `0x33` was a typo against the UAPI). Doc comment updated. Unit test still in place.
- `crates/kernel/src/audio/pcm_ioctl.rs` — **TWO** changes:
   1. `refine_interval()` no longer narrows `interval.max = chosen`. Returns `interval.min` but leaves the range as `[clamped_min, clamped_max]`. Doc comment rewritten to describe the new contract (HW_REFINE returns ranges; user-space `snd_pcm_hw_params_choose()` does the narrowing; HW_PARAMS validates `read_interval_single`).
   2. `refine_hw_params()` derived intervals now use the **range** of primary intervals: `FRAME_BITS.min = SAMPLE_BITS * channels.min`, `FRAME_BITS.max = SAMPLE_BITS * channels.max`, `PERIODS.min = buffer.min / period.max`, `PERIODS.max = buffer.max / period.min`. `req.rate_num = req.intervals[PARAM_RATE].min` (was `rate`).
   3. **TEMPORARY DEBUG**: `SNDRV_PCM_IOCTL_HW_REFINE` and `SNDRV_PCM_IOCTL_HW_PARAMS` arms have `host.host_write(2, alloc::format!(...))` blocks dumping the interval/mask state — these were invaluable for debugging but **MUST BE REMOVED** before squashing. There is also a `dbg_step!` macro inside HW_PARAMS that wraps each extract_* call. Search for `WPK-DEBUG` to find them.
   4. AlsaPcm ENOTTY catch-all has a similar `host.host_write` debug — also TEMPORARY.
- `crates/kernel/src/audio/mod.rs` — unchanged from session 49 (`pub mod ctl_ioctl;` already there).
- `crates/kernel/src/syscalls.rs` — unchanged from session 49 (CTL gate dispatch at line ~8968).
- `crates/kernel/src/wasm_api.rs` — comment updated: `(608 B)` → `(604 B)` for HW_PARAMS hint.
- `crates/shared/src/lib.rs` — **THREE** changes:
  1. `WpkAlsaPcmHwParams.fifo_size: u64 → u32` (struct shrinks 608 → 604). Comment block rewritten explaining wasm32 `unsigned long = 4`. `Default::default()` still works (no change needed since `0u32` literal also fits).
  2. `SNDRV_PCM_IOCTL_HW_REFINE: 0xc260_4110 → 0xc25c_4110` and `SNDRV_PCM_IOCTL_HW_PARAMS: 0xc260_4111 → 0xc25c_4111` (size bits 16..29 now 0x025c instead of 0x0260).
  3. `audio_struct_sizes_match_wasm32_repr_c` test: assertion is `608 → 604`. Comment block rewritten.
- `crates/shared/src/host_abi.rs` — **NEW variant + macro + entry update**:
  - Added `SyscallArgSize::IoctlEncoded { arg_index: u8, floor: u32 }`.
  - Added `macro_rules! ioctl_encoded { ... }`.
  - Ioctl entry: `entry!(Syscall::Ioctl as u32, [desc!(2, InOut, ioctl_encoded!(1, 256))])`.
- `tools/xtask/src/dump_abi.rs` — added the new variant to both TS (`ts_syscall_arg_size`) and JSON (`syscall_arg_size_json`) emitters, and to the TS type union (`SyscallArgSizeSpec`).
- `host/src/kernel-worker.ts` — **TWO** places now handle `ioctl_encoded`: the input-marshalling loop around line ~2238 and the output-marshalling loop around line ~2608. Both extract `(req >>> 16) & 0x3fff` from `origArgs[desc.size.argIndex]` and clamp to `desc.size.floor`. The else-branch is now explicit `fixed` (was implicit before — TS strict-mode forced the explicit narrowing).
- `host/src/generated/abi.ts` — regenerated. New `ioctl_encoded` arm in `SyscallArgSizeSpec`; Ioctl entry now `{ type: "ioctl_encoded", argIndex: 1, floor: 256 }`.
- `libc/glue/abi_constants.h` — regenerated (no semantic change but file got touched).
- `libc/glue/syscall_glue.c` — `SYS_IOCTL` case now computes `blen` from request bits 16..29 with 256 floor. **BUT THIS FILE IS NOT BUILT INTO USER PROGRAMS** — `scripts/build-programs.sh` and the libc-test/posix-test scripts all compile `channel_syscall.c`, not `syscall_glue.c`. So this is intent-of-record / documentation; the actual marshalling happens host-side via the `host_abi.rs` table. Don't be surprised that the user-side smoke test works regardless of `syscall_glue.c` changes.
- `scripts/build-musl.sh` — unchanged from session 49.
- `scripts/build-programs.sh` — unchanged from session 49.
- `abi/snapshot.json` — regenerated by `scripts/check-abi-version.sh update`. Reflects all of (1) the new IoctlEncoded variant, (2) the shrunk WpkAlsaPcmHwParams, (3) the new HW_REFINE/HW_PARAMS ioctl numbers. **Almost certainly requires `ABI_VERSION` bump** at A8 — these are existing-ABI changes, not additive.

### New (??)
- `crates/kernel/src/audio/ctl_ioctl.rs` — already noted (session 49).
- `packages/registry/alsa-lib/` — all of session 49's files PLUS:
  - `src/conf_stubs.c` — added `page_size()`, `page_align(size)`, `page_ptr(...)` at the end of the file (after `snd_async_handler_get_signo`). page_size returns 4096; page_align rounds up to page; page_ptr computes mmap-page-aligned (offset, mmap_offset, size) triple. Defined in upstream `src/conf.c` which we don't compile.
  - `build-alsa-lib.sh` — `SUBSET_TUS` now includes `src/pcm/interval.c` and `src/pcm/mask.c` (needed because pcm_params.c references `snd_interval_refine_set` and friends).
  - `build.toml` — `revision = 4` (was 2 at session 49 close, bumped to 3 when adding page_align, then 4 when adding interval.c/mask.c). Each bump invalidates the resolver cache.
- `programs/alsa_lib_smoke.c` — same as session 49 PLUS **TEMPORARY DEBUG**: `fprintf(stderr, "DBG: set_channels(2) err=%d\n", err);` and similar around each `set_*` and the final `snd_pcm_hw_params`. **MUST BE REVERTED** before squashing.
- `host/test/alsa-lib-smoke.test.ts` — unchanged from session 49.

### Resolver cache artifacts (disposable)
- `/Users/mho/.cache/kandelo/libs/alsa-lib-1.2.10-rev3-wasm32-*` (intermediate)
- `/Users/mho/.cache/kandelo/libs/alsa-lib-1.2.10-rev4-wasm32-589c73ff/` (current; libasound.a = 351760 bytes)
- `sysroot/lib/libasound.a` symlinks to the rev-4 cache.

## How each session-50 bug was identified — keep the playbook

These were diagnosed by adding `host.host_write(2, alloc::format!(...).as_bytes())` calls in kernel ENOTTY catch-alls (writing to host stderr handle 2). That's the kernel-side diag channel that works with no `log` crate / no_std. Pattern:

```rust
let _ = host.host_write(
    2,
    alloc::format!(
        "WPK-DEBUG: AlsaPcm ENOTTY request=0x{:08x}\n",
        request
    )
    .as_bytes(),
);
```

(host writes go to the smoke test's stderr because they're not associated with a specific process fd — the user's stderr-write capture in `centralized-test-helper` mixes both.)

Bug-by-bug:
- **Bug 1 (PCM_PREFER_SUBDEVICE)**: Trace showed `AlsaControl ENOTTY request=0x40045532`. Grep against `<sound/uapi/asound.h>` revealed `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE _IOW('U', 0x32, int)`. Session 49 had `0x33`.
- **Bug 2 (page_align)**: Host kernel-worker reported `Unimplemented import: env.page_align`. `grep -rn page_align /tmp/alsa-extract/.../src/` → defined in `src/conf.c` (elided). Added stub to `conf_stubs.c`.
- **Bug 3 (snd1_interval_refine_set)**: Same `Unimplemented import` shape. `grep -rn snd_interval_refine_set` → defined in `src/pcm/interval.c`. Added that TU + `mask.c` to SUBSET_TUS.
- **Bug 4 (HwParams size)**: Trace showed `AlsaPcm ENOTTY request=0xc25c4110`. Decoded — `_IOWR('A', 0x10, 604)`. We had it at 608 because `fifo_size: u64`. Audited struct layout, changed to `u32`, updated constants.
- **Bug 5 (host marshalling truncation)**: After fixing #4, trace showed kernel still seeing zeroed intervals: `HW_REFINE in: period[0,0] buffer[0,0] ... ch[0,0] rmask=0x0`. Followed the channel marshalling path → `host/src/generated/abi.ts:706` had `{ type: "fixed", size: 256 }` for Ioctl. Source in `host_abi.rs`. Added `IoctlEncoded` variant, regenerated.

Each bug was a 10-30 minute round of "rebuild → run smoke → grep ENOTTY trace → fix → rebuild". The kernel-side `host_write(2, ...)` was the unblocker — without it I was blind because alsa-lib's `SYSMSG` doesn't print under `LIBASOUND_DEBUG=1` for ioctls in the open/refine path (`control_hw.c::snd_ctl_hw_pcm_prefer_subdevice` and `pcm_hw.c::snd_pcm_hw_hw_refine` both `return -errno` without `SYSMSG`).

## What's broken now — Bug 6 + likely Bugs 7..N

**Bug 6 (immediate blocker)**: `WpkAlsaPcmSwParams = 136 bytes`, but alsa-lib wasm32 emits 104 bytes. The kernel's `SNDRV_PCM_IOCTL_SW_PARAMS` constant is computed against 136 → user emits `0xc0684113` (104) → kernel's match arm sees a different number → ENOTTY catch-all fires.

Fields to fix in `crates/shared/src/lib.rs::audio::WpkAlsaPcmSwParams`:
```rust
// before
pub _pad0: u32,
pub avail_min: u64,
pub xfer_align: u64,
pub start_threshold: u64,
pub stop_threshold: u64,
pub silence_threshold: u64,
pub silence_size: u64,
pub boundary: u64,
```
After fix (alsa-lib wasm32 layout):
```rust
// no _pad0 needed — all fields are 4-byte aligned without it
pub avail_min: u32,
pub xfer_align: u32,
pub start_threshold: u32,
pub stop_threshold: u32,
pub silence_threshold: u32,
pub silence_size: u32,
pub boundary: u32,
```
Verify total = `4 + 4 + 4 + 7*4 + 4 + 4 + 56 = 104`. Then update `audio_struct_sizes_match_wasm32_repr_c` to `assert_eq!(size_of::<WpkAlsaPcmSwParams>(), 104)`. Then in `crates/shared/src/lib.rs` the `pcm_ioctl_numbers_match_linux_uapi` test will recompute SW_PARAMS automatically (it uses `size_of::<WpkAlsaPcmSwParams>()` in the IOC computation).

The kernel's `pcm_ioctl.rs::SNDRV_PCM_IOCTL_SW_PARAMS` constant is defined in `crates/shared/src/lib.rs`; not in `pcm_ioctl.rs` directly (the latter imports `wasm_posix_shared::audio::*`). After shrinking SwParams, the const arithmetic will produce `0xc0684113` automatically. Verify with the unit test.

Also fix the `SwParamsCache` consumers — `extract_*` in pcm_ioctl.rs that read these fields, expecting `u64`. They'll need to read `u32` and either cache as `u32` or upcast. Probably safe to keep the cache fields as `u64` and just upcast on read since these are frame counts and `u32` always fits in `u64`.

**Bug 7..N (likely)**: every other audio struct uses `u64` for `snd_pcm_uframes_t`/`snd_pcm_sframes_t`:
- `WpkAlsaPcmStatus` (currently 128) — uses `i64` for `appl_ptr/hw_ptr/delay`, `u64` for `avail/avail_max/overrange`. Plus the timespec fields. Need a full wasm32 walk against alsa-lib's `struct snd_pcm_status` (look at the UAPI header).
- `WpkAlsaPcmInfo` (currently 288) — mostly fixed-size arrays + ints; CHECK whether any uframes_t are buried in the union/syncfields.
- `WpkAlsaXferi` (currently 24) — `result: i64, buf: u64, frames: u64` — at minimum `frames` is `snd_pcm_uframes_t`; on wasm32 should be `u32`. `buf` is a pointer (`void *`), wasm32 is `u32`. `result` is `snd_pcm_sframes_t`, wasm32 is `i32`. Probably the whole struct is 12 bytes on wasm32, not 24.
- `WpkAlsaPcmMmapStatus` (currently 64) — `hw_ptr: i64`, timespec fields. On wasm32 this is mmap'd directly into user-space, so layout MUST match alsa-lib's `struct snd_pcm_mmap_status` byte-for-byte.
- `WpkAlsaPcmMmapControl` (currently 64) — `appl_ptr: i64, avail_min: i64`. Both uframes_t → 4 bytes each on wasm32.

Strategy: do `Bug 6` first, see if smoke test passes (it might if PREPARE doesn't use a uframes_t field on the wire). If smoke still fails after fixing SW_PARAMS, fix the next failing struct identified by the ENOTTY trace.

**Important**: the `_IOR/_IOWR` macros compute the request number from `sizeof(struct)`. EVERY size change reshuffles a constant. After each struct shrink, the matching `SNDRV_PCM_IOCTL_*` const in `crates/shared/src/lib.rs::audio::*` recomputes automatically AT COMPILE TIME because it uses `size_of::<>()` in a `const fn`. But verify with `cargo test -p wasm-posix-shared` — the `pcm_ioctl_numbers_match_linux_uapi` test asserts the expected encoded numbers.

## Highest-priority task for session 51

1. **REMOVE THE TEMPORARY DEBUG before doing anything else.** Search `crates/kernel/src/audio/pcm_ioctl.rs` for `WPK-DEBUG` and delete the two `host.host_write` blocks (`HW_REFINE in/out`, the `dbg_step!` macro inside HW_PARAMS, and the `AlsaPcm ENOTTY` catch-all). Also delete the `DBG:` `fprintf` calls in `programs/alsa_lib_smoke.c` so the smoke test is back to its clean form. These debug calls are the EASIEST thing to forget — they will silently break vitest output assertions because they go to stderr.

2. **Fix `WpkAlsaPcmSwParams`** per the field rewrite in "Bug 6" above. Bump `WpkAlsaPcmHwParams` neighbours if needed. Update the size-assertion test from 136 to 104. Run `cargo test -p wasm-posix-shared` to verify `pcm_ioctl_numbers_match_linux_uapi` passes (it'll compute the new constant automatically).

3. **Rebuild + rerun smoke**. If smoke passes, move to step 5. If smoke fails on a different ioctl, decode the request number and audit the corresponding struct (Bug 7..N above).

4. **Audit remaining audio structs against the wasm32 alsa-lib UAPI**. For each: read alsa-lib's `struct ... { ... }` in `packages/registry/alsa-lib/alsa-lib-src/include/sound/uapi/asound.h` (after a fresh `cargo xtask build-deps resolve alsa-lib` extracts it), compute the wasm32 size (all `snd_pcm_uframes_t`/`snd_pcm_sframes_t`/`size_t`/`unsigned long`/`long` → 4 bytes), and reconcile with the kernel struct. Where the kernel struct is wrong, fix it AND update the size assertion in `audio_struct_sizes_match_wasm32_repr_c`.

5. **Once smoke passes:** regen ABI snapshot (`bash scripts/check-abi-version.sh update`), inspect the diff. **Bump `ABI_VERSION` in `crates/shared/src/lib.rs` in the same commit** — all the audio-struct shrinks AND the new `IoctlEncoded` variant change existing ABI surface. Don't try to argue they're additive — even if old binaries don't use HW_PARAMS, the ioctl constant changed and the host adapter now uses a new variant.

6. **Commit the alsa-lib + kernel CTL gate + audio-struct fixes + host_abi/marshalling fixes as one checkpoint commit.** Include the rev-4 (or rev-N if you bump again) alsa-lib build outputs.

7. **A8: interactive-rebase squash.** Targets all session 47/48/49/50 commits on `explore-dri-sdl2-shims` into ONE commit titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling`. Base = `explore-dri-evdev-and-alsa`. NOT `main`.

8. **6-suite gauntlet** per `CLAUDE.md`:
   - `cargo test -p kandelo --target aarch64-apple-darwin --lib` (we added ~4 ctl_ioctl tests; expect 543+)
   - `cd host && npx vitest run` (alsa-lib-smoke + libinput-stub should both pass; the audio struct shrinks may break existing audio unit tests in `pcm_ioctl.rs::tests` — likely the `wildcard_hw_params`/`refined_hw_params` helpers — fix them up. Look for places that build a `WpkAlsaPcmHwParams::default()` and assume specific field offsets.)
   - `scripts/run-libc-tests.sh` (0 unexpected failures)
   - `scripts/run-posix-tests.sh` (0 FAIL)
   - `bash scripts/check-abi-version.sh` (exit 0 — verifies snapshot consistency and ABI_VERSION bump matches the structural change)
   - Browser demo verify only if browser-affecting (alsa-lib subset is Node-only-relevant for the smoke test; libdrm-KMS work shouldn't have moved either; should be no-op).

9. **Open draft PR** with base `explore-dri-evdev-and-alsa`, NOT main. Title should reflect kernel + sysroot + ioctl marshalling. DO NOT include `docs/plans/*` (especially this file) in the PR diff.

## Verifying the smoke test actually exercised the kernel ALSA path

When the smoke test passes, you should see (clean stderr after debug removal): `OK rate=48000\n` on stdout, empty stderr. Behind the scenes, the kernel must have processed (in order):

| ioctl | encoded | gate | status now |
|---|---|---|---|
| `SNDRV_CTL_IOCTL_PVERSION` | `0x8004_5500` | ctl_ioctl.rs | works ✓ |
| `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE` | `0x4004_5532` | ctl_ioctl.rs | works ✓ |
| `SNDRV_PCM_IOCTL_INFO` | `0x8120_4101` | pcm_ioctl.rs | works ✓ |
| `SNDRV_PCM_IOCTL_PVERSION` | `0x8004_4100` | pcm_ioctl.rs | works ✓ |
| `SNDRV_PCM_IOCTL_HW_REFINE` | `0xc25c_4110` | pcm_ioctl.rs | works ✓ |
| `SNDRV_PCM_IOCTL_HW_PARAMS` | `0xc25c_4111` | pcm_ioctl.rs | works ✓ |
| `SNDRV_PCM_IOCTL_SW_PARAMS` | should be `0xc068_4113` (104 B), currently `0xc088_4113` (136 B) | pcm_ioctl.rs | **BROKEN — Bug 6** |
| `SNDRV_PCM_IOCTL_PREPARE` | `0x4140` (no payload) | pcm_ioctl.rs | unverified — should work, no struct |

The smoke test does NOT call WRITEI / READI / STATUS / DRAIN, so `WpkAlsaXferi` / `WpkAlsaPcmStatus` aren't on the smoke test critical path — but they ARE still wrong and would bite the next consumer (SDL2 audio backend's writei loop).

## Decisions made this session — don't relitigate

- **`refine_interval` no longer narrows on HW_REFINE.** Linux's actual semantics: HW_REFINE returns refined RANGES; the user-space `snd_pcm_hw_params_choose()` narrows iteratively via `snd_pcm_hw_param_set_first`. Our previous behaviour (narrow to `interval.min` on every refine) broke `snd_pcm_hw_param_set_rate_near(48000)` because alsa-lib couldn't widen the rate interval back from `[8000,8000]` to widen-and-narrow.
- **`page_align`/`page_size` live in `conf_stubs.c`**, not in the upstream alsa-lib build. We don't compile `src/conf.c` because it pulls in the snd_config configuration tree. The stubs return 4096 as page size — irrelevant to the actual mmap path because alsa-lib falls back to the SYNC_PTR ioctl on mmap failure (and our kernel always falls back to SYNC_PTR for now).
- **`SyscallArgSize::IoctlEncoded` is the right design** for ioctl marshalling. Alternatives considered:
  - Bumping `Fixed { size: 4096 }` — wasteful + a `kernel_handle_channel` writes 4 KB through the SAB on every ioctl.
  - Using `Arg { arg_index: 1 }` and a `transform` field — over-general, doesn't compose with other size types.
  IoctlEncoded matches Linux's `_IOC_SIZE` convention 1:1 and is what the kernel-side wasm_api dispatcher already does (`crates/kernel/src/wasm_api.rs::case 72`).
- **The libc `syscall_glue.c` change is documentary, not load-bearing.** `channel_syscall.c` is what's actually linked. Host-side marshalling is the load-bearing path; libc just writes args to the channel and waits.

## Standing instruction for session 51 — print THIS sentence

> *"Read `docs/plans/2026-06-15-dri-kandelo-port-handoff-50.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Branch `explore-dri-sdl2-shims` tip is still `51fb09c8e` — A6 (libinput-lite) committed; A4+A5 (alsa-lib subset) implemented but NOT YET COMMITTED; the smoke test now succeeds through `snd_pcm_open` + `HW_REFINE` + `HW_PARAMS` and fails at `SW_PARAMS` because the kernel's `WpkAlsaPcmSwParams` is `u64`-uframes (136 B) but alsa-lib on wasm32 emits 104 B (Bug 6). Other audio structs (`WpkAlsaPcmStatus`, `WpkAlsaPcmInfo`, `WpkAlsaXferi`, `WpkAlsaPcmMmapStatus`, `WpkAlsaPcmMmapControl`) almost certainly have the same wasm32-vs-Linux-x86_64 mismatch. Session 50 added a new `SyscallArgSize::IoctlEncoded` host_abi variant (host adapter now extracts `_IOC_SIZE` bits 16..29 instead of hard-coding 256 bytes per ioctl) — that's load-bearing for ALL of the audio ioctls. Before doing anything: **REMOVE the temporary debug calls** — search `crates/kernel/src/audio/pcm_ioctl.rs` for `WPK-DEBUG` (4 blocks) and `programs/alsa_lib_smoke.c` for `DBG:` (3 fprintf calls). Then (1) fix `WpkAlsaPcmSwParams` to u32 uframes (104 B; remove `_pad0`); update the `audio_struct_sizes_match_wasm32_repr_c` test from 136 to 104. (2) Rebuild via `export PATH=\"/nix/var/nix/profiles/default/bin:$PATH\"; bash scripts/dev-shell.sh bash build.sh` then rerun `cd host && npx vitest run test/alsa-lib-smoke.test.ts`. (3) If smoke passes, regen ABI snapshot with `bash scripts/check-abi-version.sh update`, bump `ABI_VERSION` in `crates/shared/src/lib.rs` in the same commit (the audio-struct shrinks + IoctlEncoded variant are non-additive ABI changes), then audit the remaining audio structs against alsa-lib's UAPI for further wasm32 mismatches. (4) Commit the alsa-lib + kernel CTL gate + audio-struct fixes + host_abi/marshalling fixes as ONE checkpoint, then A8 — interactive-rebase squash all session 47/48/49/50 commits into ONE commit titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling`, run the full 6-suite gauntlet, and open draft PR #1 with base `explore-dri-evdev-and-alsa`. DO NOT target `main`. DO NOT resurrect per-task commits. DO NOT stage `docs/plans/*` into the PR. Load-bearing decisions to preserve on any rewrite: (a) `refine_interval` returns ranges (does NOT narrow), (b) `SyscallArgSize::IoctlEncoded { arg_index, floor }` reading `(args[arg_index] >> 16) & 0x3fff`, (c) `WpkAlsaPcmHwParams.fifo_size: u32` (struct = 604 B) + matching `SNDRV_PCM_IOCTL_HW_REFINE/HW_PARAMS = 0xc25c_4110/0xc25c_4111`, (d) `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE = 0x4004_5532` (NOT `0x4004_5533` — session 49's value was the typo), (e) page_align/page_size/page_ptr stubs in conf_stubs.c, (f) interval.c + mask.c in SUBSET_TUS, (g) revision = 4 in alsa-lib/build.toml. Auto-mode default; bias to action; pause on ABI_VERSION bump if uncertain whether to bump."*
