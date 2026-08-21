# DRI port onto kandelo:main — session 49 handoff (SDL2 Phase A — alsa-lib subset cross-compiles + kernel CTL ioctl gate landed; smoke test STILL fails at runtime)

Continuation of [handoff-48](./2026-06-15-dri-kandelo-port-handoff-48.md). Session 49's job was A6 finish (libinput-lite vitest + commit), then A4+A5 (alsa-lib subset library), then A8 (squash + gauntlet + PR). Ended with **A6 committed (`51fb09c8e`)**, **A4+A5 mostly done (build script, conf_stubs, four patches, smoke-test program, vitest)**, **kernel CTL ioctl gate added per user direction** (`audio/ctl_ioctl.rs` + dispatch wired into `sys_ioctl`), but **the alsa_lib smoke test still fails at runtime with `snd_pcm_open(default): Not a tty`** for a reason that has NOT been root-caused yet. A8 (squash + PR) NOT started.

## TL;DR — read this twice

1. **Branch tip is `51fb09c8e` — `Add libinput-lite no-op stub for SDL2 configure probe`** on `explore-dri-sdl2-shims`. One new committed commit on top of session 48's `c8414fbeb`. PR #1 still NOT open.

2. **A6 — DONE + committed (`51fb09c8e`).** `programs/libinput_stub_smoke.wasm` built, `host/test/libinput-stub.test.ts` passes (1/1 ✓). `bash scripts/build-programs.sh` from session 49 worked end-to-end. Symlinks in sysroot: `libinput.a` + `<libinput.h>` via `cargo xtask build-deps resolve libinput-lite`.

3. **A4+A5 (alsa-lib) — code complete + builds + headers install + binary links** but the runtime smoke test fails. Working-tree state is uncommitted. Files written:
   - `packages/registry/alsa-lib/build-alsa-lib.sh` — bypasses upstream autoconf/libtool; hand-curated config.h + manual cross-compile of 10 TUs (`src/{pcm/{pcm,pcm_hw,pcm_misc,pcm_params,pcm_mmap},control/{control,control_hw},error,dlmisc}.c` + bundled `src/conf_stubs.c`); archives into `libasound.a` (343250 bytes).
   - `packages/registry/alsa-lib/src/conf_stubs.c` — ENOSYS shims for the snd_config_/snd_async_/snd_output_ symbols the elided TUs would have satisfied. Plus snd_config_update_ref returns sentinel + snd_config_unref no-op.
   - `packages/registry/alsa-lib/src/config.h` — hand-curated autoconf replacement. Critical defines: `BUILD_PCM=1`, `HAVE_CLOCK_GETTIME=1`, `HAVE_ENDIAN_H=1`, `__STRING(x) #x` (musl doesn't ship this glibc macro). Critical NON-defines: `HAVE_LIBDL`, `THREAD_SAFE_API`, `BUILD_MIXER`/`HWDEP`/`RAWMIDI`/`SEQ`/`TOPOLOGY`/`UCM`, all `BUILD_PCM_PLUGIN_*`, `HAVE_ATTRIBUTE_SYMVER` (wasm-ld doesn't implement `.symver`), `VERSIONED_SYMBOLS`.
   - **Four** patches (NOT just one — handoff-48's "one patch" estimate was wrong because upstream alsa-lib has multiple wasm-incompatible idioms beyond `snd_pcm_open_noupdate`):
     1. `0001-default-to-hw00.patch` — replaces `snd_pcm_open_noupdate` body in `src/pcm/pcm.c` lines 2665–2687 to short-circuit to `snd_pcm_hw_open(pcmp, name, card, device, -1, stream, mode, 0, 0)` for `"default"`/`"hw[:N,M]"`/`"plughw[:N,M]"`. **`diff -u`-generated**; sed-based approach from plan 7 is dead (handoff-48 already flagged this).
     2. `0002-wasm-attribute-alias.patch` — replaces `include/alsa-symbols.h`'s ELF `.weak`/`.set` inline-asm symbol-aliasing macros (which wasm-ld doesn't implement) with `__attribute__((weak, alias))`. Discovered when alsa-lib's `use_default_symbol_version(__snd_pcm_forward, snd_pcm_forward, ALSA_0.9.0rc8)` calls emitted asm directives wasm-ld rejected.
     3. `0003-wasm-endian-h.patch` — patches `include/sound/type_compat.h` AND `include/sound/uapi/asound.h` to use `<endian.h>` instead of `<sys/endian.h>` on wasm. Both files unconditionally include `<sys/endian.h>` in their non-`__linux__` branch; musl ships only `<endian.h>`.
     4. `0004-wasm-no-gnu-ld.patch` — gates `local.h`'s unconditional `#define HAVE_GNU_LD / HAVE_ELF / HAVE_ASM_PREVIOUS_DIRECTIVE` behind `!defined(__wasm__)`. Otherwise the `link_warning` macro emits `.gnu.warning.SYMBOL` section directives + `.previous` that wasm-ld rejects with "unknown directive".
   - `packages/registry/alsa-lib/{package.toml, build.toml}` — recipe scaffold from session 48; **revision bumped 1→2** at session 49 close (because the install-headers step changed to also include `sound/uapi/`; cache invalidation needed).
   - `scripts/build-musl.sh` step 13 — resolves alsa-lib via `cargo xtask build-deps resolve alsa-lib`, symlinks `libasound.a`, `include/alsa/`, `include/sound/` into the sysroot. **Critical:** `rm -rf "$SYSROOT/include/sound"` before the `ln -sf` of `sound/`, because `libc/musl-overlay/include/sound/asound.h` already installed via `scripts/install-overlay-headers.sh` (step pre-installs a hand-trimmed UAPI subset matching `crates/shared/src/lib.rs::audio` marshaling). Without the `rm`, `ln -sf` puts `sysroot/include/sound/sound -> cache` (nested wrong) instead of replacing the directory. Alsa-lib's vendored UAPI is now the sysroot's truth-of-record for `<sound/asound.h>`.
   - `scripts/build-programs.sh` — `alsa_lib_smoke.c` case links `$SYSROOT/lib/libasound.a`.
   - `programs/alsa_lib_smoke.c` — opens `default`, sets hw_params (S16_LE, stereo, 48 kHz, RW_INTERLEAVED), prints `OK rate=48000` on success.
   - `host/test/alsa-lib-smoke.test.ts` — vitest that runs the smoke and asserts `exitCode==0`, stdout matches `^OK rate=48000`, stderr does not contain `FAIL:`.

4. **Kernel CTL ioctl gate — IMPLEMENTED, unit-tested, dispatch wired, NOT YET COMMITTED.** Per user direction in session 49 (chose "Fix kernel inline" when offered the three scoping options for the smoke-test blocker). Files:
   - `crates/kernel/src/audio/ctl_ioctl.rs` — new module. `handle_alsa_ctl_ioctl(proc, host, ofd_idx, request, buf) -> Option<Result<(), Errno>>`. Returns `Some(Ok(()))` for `SNDRV_CTL_IOCTL_PVERSION = 0x8004_5500` (writes `SNDRV_PROTOCOL_VERSION` LE bytes) and `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE = 0x4004_5533` (no-op success on subdev=-1). `Some(Err(ENOTTY))` for any other request on a controlC0 fd. `None` if `ofd_idx`'s host_handle is not `AlsaControl`. 4 unit tests written + pass.
   - `crates/kernel/src/audio/mod.rs` — `pub mod ctl_ioctl;` + updated doc comment (removed "no ioctl dispatch lives here" claim).
   - `crates/kernel/src/syscalls.rs` (sys_ioctl) — added a CTL gate immediately after the existing AlsaPcm gate at ~line 8964:
     ```rust
     if let Some(result) =
         crate::audio::ctl_ioctl::handle_alsa_ctl_ioctl(proc, host, ofd_idx, request, buf)
     {
         return result;
     }
     ```
   - `crates/kernel/src/audio/pcm_ioctl.rs` line 49 — **changed `SNDRV_PROTOCOL_VERSION` from `0x000d_0000` (v13.0.0) to `0x0002_0004` (v2.0.4)**. Pin made `pub`. The 13.0.0 value was a pre-existing bug — alsa-lib's `SNDRV_PROTOCOL_INCOMPATIBLE` macro (`include/sound/uapi/asound.h:51`) requires major+minor *equality* against `SNDRV_PCM_VERSION_MAX = 2.0.9` / `SNDRV_CTL_VERSION_MAX = 2.0.4`, not the equal-or-lower check the plan author assumed. 2.0.4 satisfies both AND keeps below the `>= 2.0.5` `SNDRV_PCM_IOCTL_TSTAMP` threshold + the `>= 2.0.14` `SNDRV_PCM_IOCTL_USER_PVERSION` threshold (both unimplemented in kernel; either would fail with ENOTTY). Test `pcm_pversion_returns_alsa_v13` renamed to `pcm_pversion_matches_alsa_compat_window`; assertion message updated.

5. **Smoke test STILL FAILS at runtime with `FAIL: snd_pcm_open(default): Not a tty`.** Sequence: kernel rebuilt via `bash build.sh` AFTER all three of (changes to pcm_ioctl PVERSION value, addition of ctl_ioctl module, wiring into sys_ioctl). All 4 ctl_ioctl unit tests pass. But the user-space binary still gets ENOTTY somewhere. Session ran out of context before isolating which ioctl. **Open question for session 50** — see "Highest-priority open task" below.

## Files that ARE committed in session 49

`51fb09c8e` (only commit):
- A `host/test/libinput-stub.test.ts` (25 lines)
- A `packages/registry/libinput-lite/{package.toml, build.toml, build-libinput-lite.sh, include/libinput.h, src/libinput_stub.c}` (193 lines total)
- A `programs/libinput_stub_smoke.c` (47 lines)
- M `scripts/build-musl.sh` (+17 — step 12, libinput-lite resolve+symlink)
- M `scripts/build-programs.sh` (+4 — libinput case)

Total: 9 files changed, 289 insertions.

## Files that are UNCOMMITTED at session 49 close — DO NOT lose

Working tree (verify with `git status --short`):

- `M crates/kernel/src/audio/mod.rs` (added `pub mod ctl_ioctl;` + reworked doc)
- `M crates/kernel/src/audio/pcm_ioctl.rs` (SNDRV_PROTOCOL_VERSION 0x000d_0000 → 0x0002_0004 + `pub` + 22-line doc-comment rewrite explaining the alsa-lib compat window + test rename `pcm_pversion_returns_alsa_v13` → `pcm_pversion_matches_alsa_compat_window`)
- `M crates/kernel/src/syscalls.rs` (added 7-line CTL gate after the AlsaPcm gate in sys_ioctl)
- `M scripts/build-musl.sh` (step 13 — alsa-lib resolve + `rm -rf` then symlink for `include/sound`)
- `M scripts/build-programs.sh` (`alsa_lib_smoke.c` case linking libasound.a)
- `?? crates/kernel/src/audio/ctl_ioctl.rs` (160 lines — handler + 4 unit tests)
- `?? packages/registry/alsa-lib/` (recipe + build script + 4 patches + conf_stubs.c + config.h; revision = 2)
- `?? programs/alsa_lib_smoke.c` (~73 lines)
- `?? host/test/alsa-lib-smoke.test.ts` (24 lines)

Plus uncommitted resolver-cache artifacts under `/Users/mho/.cache/kandelo/libs/alsa-lib-1.2.10-rev2-wasm32-*/` from successive resolve runs. Disposable.

## A4+A5 implementation lessons (NEW since handoff-48)

Handoff-48 said the alsa-lib subset port was "the only invasive thing is replacing snd_pcm_open_noupdate body". Reality required four patches, not one. Capture the new findings so they're not relearned:

### `0001-default-to-hw00.patch` (the body replacement — known)

As anticipated by handoff-48. `strtol` cast cleaned up from sketch (`(char**)&p` is UB; switched to `char *endp` then `p = endp`).

### `0002-wasm-attribute-alias.patch` (NEW finding)

`include/alsa-symbols.h`'s non-PIC + non-VERSIONED_SYMBOLS path emits inline asm:
```c
__asm__ (".weak " ASM_NAME(#name)); \
__asm__ (".set " ASM_NAME(#name) "," ASM_NAME(#real))
```
wasm-ld rejects both directives. The patch collapses the macro to:
```c
extern __typeof(real) name __attribute__((weak, alias(#real)))
```
Triggered by every `use_default_symbol_version(__snd_pcm_forward, snd_pcm_forward, ALSA_0.9.0rc8)` etc. invocation in pcm.c (~50 sites).

### `0003-wasm-endian-h.patch` (NEW finding)

Two files unconditionally `#include <sys/endian.h>` in their non-`__linux__` branch:
- `include/sound/type_compat.h:25`
- `include/sound/uapi/asound.h:31`

musl ships `<endian.h>`, not `<sys/endian.h>`. Patched both with `#if defined(__wasm__) || defined(__wasm32__) || defined(__wasm64__) <endian.h> #else <sys/endian.h> #endif`. Note: `include/bswap.h` ALSO references `<sys/endian.h>` but only in BSD-only `#elif`s, so the wasm path falls into the `<byteswap.h>` else branch naturally — no patch needed there.

### `0004-wasm-no-gnu-ld.patch` (NEW finding)

`include/local.h:281-283` unconditionally defines:
```c
#define HAVE_GNU_LD
#define HAVE_ELF
#define HAVE_ASM_PREVIOUS_DIRECTIVE
```
which gates the `link_warning(symbol, msg)` macro into a code path that emits `.gnu.warning.SYMBOL` section asm + `.previous` directives. wasm-ld rejects both. The patch gates those three `#define`s behind `!defined(__wasm__)`, falling into the empty `link_warning` definition further down. Emitted from `pcm.c` per obsolete-symbol warning — there's a long list (`snd_pcm_sw_params_get_start_mode`, `snd_pcm_sw_params_set_xrun_mode`, `_snd_pcm_mmap_hw_ptr`, `_snd_pcm_boundary`, ...).

### `config.h` — `__STRING(x) #x` must be defined

The PIC branch in `include/global.h:62` does not provide `__STRING`; glibc ships it via `<sys/cdefs.h>`, musl does not. `pcm.c:2622` references `SND_DLSYM_VERSION(SND_PCM_DLSYM_VERSION)` which expands to `__STRING(_dlsym_pcm_001)` — without a `__STRING` macro the compiler tries to parse it as a function call (`error: call to undeclared function '__STRING'`). Added `#ifndef __STRING / #define __STRING(x) #x / #endif` to our `config.h`.

### `conf_stubs.c` sentinel cannot be `struct _snd_config`

`snd_config_t` is `struct _snd_config` opaque (forward-declared in `include/conf.h:69`); compilers refuse `static struct _snd_config _wpk_conf_sentinel;` as a tentative definition of an incomplete type. Workaround: `static char _wpk_conf_sentinel;` cast through `(snd_config_t *)(void *)&_wpk_conf_sentinel`.

### Sysroot install path subtlety

alsa-lib's `include/sound/asound.h` is a 4-line stub that pulls in `<alsa/sound/uapi/asound.h>` (the actual UAPI). The build script must install BOTH `$SRC_DIR/include/sound/*.h` AND `$SRC_DIR/include/sound/uapi/*.h`. handoff-48's outline only mentioned the top-level — this MUST be remembered or any consumer of `<sound/asound.h>` gets a "no such file" for `<alsa/sound/uapi/asound.h>`. **Already wired in the v2 build script; this is why revision bumped 1→2.**

### `libc/musl-overlay/include/sound/asound.h` — overlay vs alsa-lib UAPI

`scripts/install-overlay-headers.sh` pre-installs the kandelo overlay's hand-trimmed `<sound/asound.h>` subset into `sysroot/include/sound/`. step 13 of build-musl.sh then needs `rm -rf "$SYSROOT/include/sound"` BEFORE the `ln -sf` of `$ALSA_PREFIX/include/sound`, or the symlink creates `sysroot/include/sound/sound` (nested wrong). alsa-lib's vendored UAPI overrides the overlay — both purport to be Linux UAPI, alsa-lib's is the full upstream version. The overlay's hand-trimmed file remains in-tree at `libc/musl-overlay/include/sound/asound.h` but is shadowed; consider deletion as a follow-up cleanup once kernel-marshal-layer programs are confirmed to compile against alsa-lib's full UAPI (kernel struct sizes should match — the overlay claimed to be a strict subset).

## Kernel CTL ioctl gate — what it does + what's wired

**`crates/kernel/src/audio/ctl_ioctl.rs`** exports:
- `pub const SNDRV_CTL_IOCTL_PVERSION: u32 = 0x8004_5500;` (`_IOR('U', 0x00, int)`)
- `pub const SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE: u32 = 0x4004_5533;` (`_IOW('U', 0x33, int)`)
- `pub fn handle_alsa_ctl_ioctl(proc, host, ofd_idx, request, buf) -> Option<Result<(), Errno>>`

Returns `None` if the fd isn't an `AlsaControl` virtual device → caller falls through to legacy ioctl logic. Returns `Some(Ok(()))` for the two known requests (PVERSION writes 0x0002_0004 LE; PCM_PREFER_SUBDEVICE no-op). Returns `Some(Err(ENOTTY))` for any other request on a controlC0 fd. Unit tests cover all four cases (PVERSION return value, PCM_PREFER_SUBDEVICE noop on subdev=-1, None on non-control fd, ENOTTY on CARD_INFO).

**`crates/kernel/src/syscalls.rs`** `sys_ioctl` now dispatches CTL ioctls between the AlsaPcm gate and the legacy Linux-VT keyboard ioctls block. The CTL gate fires for any AlsaControl fd; for other fds, `Option::None` means fall-through.

**`crates/kernel/src/audio/pcm_ioctl.rs`** `SNDRV_PROTOCOL_VERSION` is now `0x0002_0004` and `pub`. Test pin updated. The old value of `0x000d_0000` was a pre-existing bug from PR #698 — every alsa-lib consumer would have hit it. Comment in pcm_ioctl.rs:44-59 documents the new floor with the alsa-lib source-line references.

## Highest-priority open task for session 50 — DEBUG WHY SMOKE TEST STILL FAILS

Symptom: `snd_pcm_open("default", SND_PCM_STREAM_PLAYBACK, 0)` returns -ENOTTY ("Not a tty"). All four ctl_ioctl unit tests pass. Kernel was rebuilt via `bash build.sh` after the changes.

Possible explanations to investigate in order:

1. **Wasm has stale kernel.** Verify `local-binaries/kernel.wasm` mtime is post-changes; grep the wasm for `8004_5500` byte sequence (LE: `00 55 04 80`) to confirm the new constant is in the binary. `xxd local-binaries/kernel.wasm | grep -i '00 55 04 80'` style — if no hits, the kernel didn't actually rebuild and the smoke test runs against an old wasm.

2. **`bash build.sh` doesn't actually rebuild the kernel on a clean change.** Check whether `cargo build --release -p kandelo` was a no-op; possibly need to `cargo clean -p kandelo` or `touch crates/kernel/src/lib.rs` between iterations. The build.sh output is verbose — the kernel-build step's first line is "Building Rust Wasm kernel (wasm32)..." — confirm it ran, ideally with `cargo build -v` to see whether incremental or noop.

3. **`alsa_lib_smoke.wasm` linked against a stale libasound.a.** The revision bump 1→2 invalidates the resolver cache key, but only on next `build-deps resolve`. `scripts/build-programs.sh` builds programs against `$SYSROOT/lib/libasound.a` — that's a symlink into the rev-1 cache UNLESS `build-musl.sh` re-ran with the new revision. The session 49 last-known-rebuild of musl finished with rev-2 in the cache and the symlink pointing at rev-2; `alsa_lib_smoke.wasm` should be linked against rev-2. Confirm with `readlink sysroot/lib/libasound.a` and `nm local-binaries/programs/wasm32/alsa_lib_smoke.wasm | grep 'PVERSION\|PREFER'`.

4. **The ENOTTY originates from a different ioctl entirely.** Maybe alsa-lib calls another CTL ioctl on the open path that we missed in the snd_ctl_hw_open audit. Add temporary `log!` calls in `ctl_ioctl::handle_alsa_ctl_ioctl` for the `Some(Err(ENOTTY))` branch to dump the offending request number. (Or add similar logging to the AlsaPcm gate's catch-all.) Common candidates that alsa-lib might call during snd_pcm_hw_open or snd_pcm_hw_open_fd:
   - `SNDRV_PCM_IOCTL_USER_PVERSION = _IOW('A', 0x04, int)` = `0x4004_4104` — should NOT fire because we report v2.0.4 < v2.0.14, but worth verifying
   - `SNDRV_PCM_IOCTL_TSTAMP = _IOW('A', 0x02, int)` = `0x4004_4102` — should NOT fire because v2.0.4 < v2.0.5
   - `SNDRV_CTL_IOCTL_PCM_NEXT_DEVICE` or `SNDRV_CTL_IOCTL_PCM_INFO` — unlikely on open path but possible

5. **alsa-lib's snd_pcm_open_noupdate patched path doesn't actually compile the way I expected.** Possibly the patch is silently a no-op (`patch` returned success but the body wasn't replaced). Unlikely since the cargo xtask build-deps resolve shows `patching file src/pcm/pcm.c`, but worth verifying with `grep -A 5 "wasm32-posix-kernel subset" packages/registry/alsa-lib/alsa-lib-src/src/pcm/pcm.c`.

6. **Fork-instrument step missing.** alsa_lib_smoke.c doesn't call fork() so this shouldn't matter, but the user binary needs to satisfy ABI checks. Confirm exit code path matches handoff-48 patterns.

Recommendation: start with #4 (add ENOTTY logging) — that immediately pinpoints which ioctl the user-side hits that we missed. Then fix that ioctl in either the AlsaPcm gate (pcm_ioctl.rs) or AlsaControl gate (ctl_ioctl.rs).

## Reference — locations after session 49

| Thing | Where |
|---|---|
| SDL2 work branch | `explore-dri-sdl2-shims` tip `51fb09c8e`, off audio PR #698 tip `d1b1156e8` |
| SDL2 plan worktree | `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/` |
| SDL2 plan doc | `docs/plans/2026-06-29-sdl2-port-plan.md` |
| ALSA plan doc | `docs/plans/2026-06-22-dri-alsa-plan.md` |
| Resolver cache for alsa-lib | `/Users/mho/.cache/kandelo/libs/alsa-lib-1.2.10-rev2-wasm32-<sha>/` (rev-2 after session 49) |
| Resolver cache for libdrm | `/Users/mho/.cache/kandelo/libs/libdrm-2.4.120-rev1-wasm32-<sha>/` |
| Resolver cache for libinput-lite | `/Users/mho/.cache/kandelo/libs/libinput-lite-0.1.0-rev1-wasm32-<sha>/` |
| Extracted alsa-lib 1.2.10 source (reference only) | `/tmp/alsa-extract/alsa-lib-1.2.10/` |
| Alsa-lib build dir (from resolver) | `packages/registry/alsa-lib/alsa-lib-src/` + `alsa-lib-build/` (gitignored) |
| Kernel wasm | `local-binaries/kernel.wasm` |
| alsa_lib_smoke binary | `local-binaries/programs/wasm32/alsa_lib_smoke.wasm` |
| libinput_stub_smoke binary | `local-binaries/programs/wasm32/libinput_stub_smoke.wasm` |
| Vitest harness | `host/test/{alsa-lib-smoke,libinput-stub}.test.ts` |
| Dev shell entry | `export PATH="/nix/var/nix/profiles/default/bin:$PATH"; bash scripts/dev-shell.sh ...` |

## Key decisions made this session (don't relitigate)

- **alsa-lib subset port required 4 patches, not 1.** Documented above. Don't try to consolidate them — each addresses an independent wasm/musl incompatibility (open_noupdate body / symbol aliasing / endian.h / link_warning asm directives).
- **`SNDRV_PROTOCOL_VERSION` bumped to `0x0002_0004` in pcm_ioctl.rs.** The old `0x000d_0000` was a real bug pre-existing in PR #698. Pin made `pub` so ctl_ioctl can use the same constant.
- **CTL ioctl gate added to syscalls.rs sys_ioctl.** Architectural call made by user (chose "Fix kernel inline" over patching alsa-lib or xfail-ing). The gate returns Option so fallthrough is explicit.
- **Sysroot's `<sound/asound.h>` is now alsa-lib's vendored upstream UAPI, not the kandelo overlay's hand-trimmed subset.** The overlay header is shadowed; `libc/musl-overlay/include/sound/asound.h` should likely be deleted as a follow-up after confirming wire-compat.
- **alsa-lib install copies both `include/sound/*.h` and `include/sound/uapi/*.h`** (the top-level asound.h is a 4-line stub pointing at the uapi/ version).
- **Revision bumped 1→2** because the install-headers behavior changed (added uapi/). Cache invalidation needed; consumers will re-resolve.

## A8 status — NOT STARTED

Required before opening PR #1:
1. **DEBUG the smoke-test failure** per "Highest-priority open task" above.
2. **Commit the alsa-lib + kernel CTL ioctl work** as a single checkpoint commit (will be squashed at A8).
3. **Interactive-rebase squash** of all session 47/48/49 commits on `explore-dri-sdl2-shims` into ONE commit titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate`. Base = `explore-dri-evdev-and-alsa`. NOT `main`.
4. **Run the full 6-suite gauntlet** per CLAUDE.md "Test Verification":
   - `cargo test -p kandelo --target aarch64-apple-darwin --lib` (539+ tests expected; we added 4 → 543+)
   - `cd host && npx vitest run` (all files pass; PHP tests skip if binary not built)
   - `scripts/run-libc-tests.sh` (0 unexpected failures)
   - `scripts/run-posix-tests.sh` (0 FAIL)
   - `bash scripts/check-abi-version.sh` (exit 0; **check whether the SNDRV_PROTOCOL_VERSION change is structural ABI**; should NOT shift any struct offsets since it's just a constant value reported by an ioctl)
   - Browser demo verification if anything UI-relevant touched (probably not — audio path is Node-only-relevant for the smoke test)
5. **Open draft PR** with base `explore-dri-evdev-and-alsa`, NOT main. Title should reflect kernel + sysroot. DO NOT include `docs/plans/*` in the PR diff.

## Trade-offs already locked in (don't relitigate)

- **Patch alsa-lib via 4 unified-diff patches**, not a sed-based or in-build-script overrides. Patches are idempotent + version-pinnable; sed is brittle across alsa-lib versions. handoff-48 already flagged this.
- **Hand-curated config.h, NOT autoconf-generated.** Configure mis-detects host features when cross-compiling to wasm. Pattern matches libdrm; documented per CLAUDE.md "Cross-Compilation and Configure Scripts" guidance.
- **Manual per-TU compile, no make/libtool.** Same reason libdrm bypasses meson. Each .c file compiled with the same `CFLAGS` list, archived into `libasound.a` with `wasm32posix-ar`.
- **Kernel CTL ioctl gate uses Option<Result<(), Errno>> to allow caller fallthrough**, not a definitive intercept. Same pattern as other audio-pcm dispatch.
- **`SNDRV_PROTOCOL_VERSION = 0x0002_0004` (not 0x0002_0009 max or 0x0002_0015 max).** Picked to be below the 2.0.5 TSTAMP threshold + below 2.0.14 USER_PVERSION threshold; both ioctls are unimplemented in kernel. If/when those ioctls land, version can be bumped to 2.0.15 to match upstream.

## Standing instruction for session 50 — print THIS sentence

> *"Read `docs/plans/2026-06-15-dri-kandelo-port-handoff-49.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Branch `explore-dri-sdl2-shims` tip is `51fb09c8e` — A6 (libinput-lite) committed; A4+A5 (alsa-lib subset) fully implemented + builds + headers install + binary links but the smoke test fails at runtime with `snd_pcm_open(default): Not a tty` for an unidentified reason; kernel CTL ioctl gate (`crates/kernel/src/audio/ctl_ioctl.rs` + dispatch in syscalls.rs + SNDRV_PROTOCOL_VERSION 0x000d_0000 → 0x0002_0004 in pcm_ioctl.rs) added per user direction, 4 unit tests pass, but NOT YET COMMITTED. DO NOT `git clean` or rm anything in `packages/registry/alsa-lib/` or `crates/kernel/src/audio/ctl_ioctl.rs` until you've cross-checked the handoff-49 §'Files that are UNCOMMITTED at session 49 close' list. Continue with (1) DEBUG the smoke-test ENOTTY per handoff-49 §'Highest-priority open task' — start with adding temporary `log!`/`debug` calls inside `handle_alsa_ctl_ioctl`'s `ENOTTY` branch (and possibly the AlsaPcm gate's ENOTTY branch) to dump the offending ioctl request number; verify `local-binaries/kernel.wasm` is post-rebuild via `xxd | grep '00 55 04 80'`; confirm `sysroot/lib/libasound.a` symlinks into the rev-2 cache; then (2) fix whatever ioctl is missing in pcm_ioctl.rs or ctl_ioctl.rs; then (3) commit the alsa-lib + kernel CTL gate work as one checkpoint; then (4) A8 — interactive-rebase to squash all session 47/48/49 commits into ONE commit titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate`, run the full 6-suite gauntlet, and open draft PR #1 with base `explore-dri-evdev-and-alsa`. DO NOT target `main`. DO NOT resurrect per-task commits. DO NOT stage `docs/plans/*` or handoff markdowns into the PR. The four alsa-lib patches (`0001-default-to-hw00`, `0002-wasm-attribute-alias`, `0003-wasm-endian-h`, `0004-wasm-no-gnu-ld`), the `__STRING(x) #x` config.h define, the `static char _wpk_conf_sentinel` workaround (NOT struct, opaque type), the `rm -rf $SYSROOT/include/sound` before symlinking alsa-lib's sound/, the install of `sound/uapi/*.h` AND `sound/*.h`, the SNDRV_PROTOCOL_VERSION 0x0002_0004 floor + rationale, and the kernel CTL gate using `Option<Result<(),Errno>>` for fallthrough are all load-bearing — preserve them on any rewrite. `export PATH=\"/nix/var/nix/profiles/default/bin:$PATH\"` before `scripts/dev-shell.sh`. Auto-mode default; bias to action; pause on architectural calls."*
