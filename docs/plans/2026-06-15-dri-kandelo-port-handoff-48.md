# DRI port onto kandelo:main — session 48 handoff (SDL2 Phase A — libdrm sysroot wired, libinput-lite drafted)

Continuation of [handoff-47](./2026-06-15-dri-kandelo-port-handoff-47.md). Session 48's job was the remaining Phase A items the user had picked: A7 (wire upstream libdrm into the sysroot, replacing the stub), A3 (verify it via `dri-libdrm-kms.test.ts`), then A4–A6 (alsa-lib + libinput-lite). Ended with **A7 + A3 committed** (`c8414fbeb`), **A6 (libinput-lite) drafted but not yet committed**, and A4–A5 (alsa-lib) NOT started beyond a partial recipe scaffold.

## TL;DR — read this twice

1. **Branch tip is now `c8414fbeb` — `Replace in-tree libdrm stub with upstream 2.4.120 sysroot install`** on `explore-dri-sdl2-shims`. One new commit on top of session 47's `a763e24c3`. PR #1 (`sysroot(sdl2-shims): libdrm + alsa-lib + libinput-lite`) still NOT open — gates at A8 (after alsa-lib lands).

2. **A7 — DONE.** `scripts/build-musl.sh` step 10 now invokes `cargo run -p xtask -- build-deps resolve libdrm` + symlinks `lib/libdrm.a` and `include/{drm,libdrm}/` from the resolver cache into the sysroot. `libc/glue/libdrm_stub.c` (391 LoC) and `libc/musl-overlay/include/{xf86drm.h, xf86drmMode.h, drm/*.h}` (~4500 LoC of vendored UAPI) are deleted. Two non-obvious cross-compile fixes that landed:
   - `-I$SYSROOT/include/libdrm` AND `-I$SYSROOT/include/drm` added to `scripts/build-programs.sh` CFLAGS AND to `scripts/build-musl.sh` step 11 (libgbm). The upstream `xf86drm.h` does `#include <drm.h>` (bare, NOT `<drm/drm.h>`), which only resolves with `-I.../include/drm` on the search path. Without both, consumers of upstream xf86drm.h fail to compile with "drm.h file not found".
   - `programs/dri-modeset.c` was patched to `poll(fd, POLLIN, -1)` before `drmHandleEvent()`. Upstream's `drmHandleEvent` does a bare `read()` and expects Linux's blocking-mode `read(/dev/dri/cardN)` to park the caller. Our kernel's centralized-mode `read(card0)` returns 0 immediately on an empty event ring → the queued flip stays pending → next `drmModePageFlip` returns EBUSY. The previous in-tree stub solved this by doing `poll()` inside `drmHandleEvent`; the new world matches real-world consumer idiom (SDL2 KMSDRM, weston, mutter all `poll()` first). Only one consumer affected; checked via `grep -ln "drmHandleEvent" programs/*.c`.

3. **A3 — DONE.** All 10 DRI vitest suites pass against the upstream-backed sysroot:
   - `dri-libdrm-kms.test.ts` (the explicit A3 gate)
   - plus dri-dumb-roundtrip, dri-kms-pageflip, dri-registry, dri-modeset, dri-kms-stats-sab, dri-multiplex, dri-kms-registry, dri-smoke. dri-cube-pyramid skipped (independent of this PR).
   - 29 tests passed / 1 skipped / 0 failed.

4. **A6 (libinput-lite) — IMPLEMENTED, builds, smoke test NOT YET RUN.** Files staged but not yet committed:
   - `packages/registry/libinput-lite/{package.toml, build.toml, build-libinput-lite.sh}`
   - `packages/registry/libinput-lite/include/libinput.h` (52 lines — minimal surface for SDL2)
   - `packages/registry/libinput-lite/src/libinput_stub.c` (40 lines — all entry points return NULL/0)
   - `programs/libinput_stub_smoke.c` (smoke test program)
   - `host/test/libinput-stub.test.ts` (vitest harness)
   - `scripts/build-musl.sh` step 12 (new) — symlinks libinput.a + libinput.h into the sysroot via the resolver, matching libdrm's pattern.
   - `scripts/build-programs.sh` per-program case — links `libinput.a` when building `libinput_stub_smoke.c`.

   The xtask resolver successfully builds the archive (`lib/libinput.a` 746 bytes); `scripts/build-musl.sh` rebuild succeeds end-to-end. The remaining steps are: rebuild programs (interrupted at this point) and run the vitest. Should be a 30-second confirmation when resumed.

5. **A4–A5 (alsa-lib) — PARTIAL, NOT YET BUILDING.** Recipe files written but the build script + patches + conf_stubs.c are NOT yet written. Files present:
   - `packages/registry/alsa-lib/package.toml` (full recipe, points at upstream tarball)
   - `packages/registry/alsa-lib/build.toml` (resolver state)
   - `packages/registry/alsa-lib/patches/` (empty dir, ready for `0001-default-to-hw00.patch`)

   alsa-lib 1.2.10 tarball verified: sha256 `c86a45a846331b1b0aa6e6be100be2a7aef92efd405cf6bac7eef8174baa920e`, available at `https://www.alsa-project.org/files/pub/lib/alsa-lib-1.2.10.tar.bz2`. Already pinned in package.toml.

## Key decisions made this session (don't relitigate)

- **libgbm_stub.c coupling concern was unfounded.** Upstream libdrm headers are a strict superset of overlay; libgbm_stub.c compiled cleanly against them with only an unrelated endian.h shift-precedence warning (pre-existing, in libc/musl-overlay/include/endian.h). The risk flagged in handoff-47 §"Open architectural items #1" → empirically zero diff in compile output.

- **drmHandleEvent semantic divergence is real but bounded.** Upstream's `drmHandleEvent` does `read()` only; our kernel returns 0 on empty event ring. Real-world consumers `poll()` first; we updated dri-modeset.c to match. SDL2's KMSDRM backend does poll+drmHandleEvent, so this is fine for Phase B. **Do NOT bring back the libdrm_stub's internal poll()** — that just makes the rest of the world non-portable.

- **In-tree stub packages use sentinel `[source]` URL + all-zero sha256.** Pattern confirmed in `packages/registry/posix-utils-lite/`. The resolver doesn't actually fetch when the build script uses `$SCRIPT_DIR/src/` directly. libinput-lite follows this pattern.

- **Symlinks (not cp) from cache → sysroot.** Matches `build-programs.sh`'s libcxx pattern. Cache key changes after revision bumps just need a `build-musl.sh` rerun; no stale-file cleanup needed.

- **build-musl.sh now requires cargo (and the nix dev shell).** Step 10 + step 12 both invoke `cargo run -p xtask -- build-deps resolve <name>`. This was already implicit (CI runs musl builds through `dev-shell.sh`), but documented now in case future contributors run `bash scripts/build-musl.sh` cold from a non-Nix shell.

## What's pending — session 49 work-list

| # | Task | Status | Blocker? |
|---|---|---|---|
| 1 | A6 finish — commit libinput-lite stub, run `host/test/libinput-stub.test.ts`. | **Code written, build verified, vitest not yet run.** Run `bash scripts/dev-shell.sh bash scripts/build-programs.sh`, then `cd host && npx vitest run test/libinput-stub.test.ts`. | No — fast finish (~5 min). |
| 2 | A4 — alsa-lib build script + first compile. | Recipe scaffold present; no build script yet. | Yes — A8. |
| 3 | A5 — `patches/0001-default-to-hw00.patch` + `src/conf_stubs.c`. | Not started. | Yes — A8. |
| 4 | A8 — squash to single commit + open PR #1 base=`explore-dri-evdev-and-alsa`. | Awaits A4+A5. | Yes — PR #1. |
| 5 | Audio PR #698 CI watch + post-merge gauntlet — handoff-46 carryover, still pending. | | No (parallel). |
| 6 | Plan body amendment: replace `examples/libs/` with `packages/registry/`. | Low priority. | No. |

## A4–A5 implementation notes (collected this session — work was suspended before write-up)

### Source layout

After `tar xjf alsa-lib-1.2.10.tar.bz2`:
- Sources for the subset live under `src/{pcm/{pcm,pcm_hw,pcm_misc,pcm_params,pcm_mmap}.c, control/{control,control_hw}.c, error.c, dlmisc.c}`.
- `include/alsa` is a symlink to `.`. After install, headers must land at `$INSTALL_DIR/include/alsa/*.h` (real dir, not symlink) so consumers' `#include <alsa/asoundlib.h>` works.
- `include/config.h.in` (257 lines) is the autoconf template; configure produces `include/config.h`.

### `snd_config_*` link surface

The subset's TUs reference these symbols (verified via grep). conf_stubs.c must provide all of them; ENOSYS-returning bodies are fine because the patched `snd_pcm_open_noupdate` never reaches them at runtime:

```
snd_async_add_handler
snd_async_del_handler
snd_async_handler_get_pcm
snd_config_check_hop
snd_config_copy
snd_config_delete
snd_config_for_each
snd_config_get_ascii
snd_config_get_bool
snd_config_get_card
snd_config_get_ctl_iface
snd_config_get_ctl_iface_ascii
snd_config_get_id
snd_config_get_integer
snd_config_get_ireal
snd_config_get_string
snd_config_get_type
snd_config_imake_pointer
snd_config_is_array
snd_config_iterator_end
snd_config_iterator_entry
snd_config_iterator_first
snd_config_save
snd_config_search
snd_config_search_definition
snd_config_set_hop
snd_config_unref
snd_config_update_ref
snd_output_close
snd_output_printf
snd_output_putc
snd_output_puts
snd_output_stdio_attach
snd_user_file
```

Plus the types `snd_config_t` (opaque), `snd_config_iterator_t`, `snd_output_t` (opaque). These come from `include/conf.h` / `include/output.h` which we install — no stub needed for the types themselves.

### Patch design — `patches/0001-default-to-hw00.patch`

Plan 7's sed-based approach (`sed -i 's|return snd_config_search_definition.*|...|'`) IS WRONG for two reasons:
1. The replacement still calls `snd_config_search_definition` (just rewrites the name). Link fails because the subset doesn't include conf.c.
2. The sed pattern is brittle across alsa-lib versions (handoff-47 §"Pre-impl review fix #4" already flagged this).

The correct patch replaces the body of `snd_pcm_open_noupdate` (src/pcm/pcm.c, lines 2665–2687 in 1.2.10) to bypass the config search entirely and call `snd_pcm_hw_open` directly. Skeleton (verified against the upstream source already extracted to `/tmp/alsa-extract/alsa-lib-1.2.10/`):

```c
static int snd_pcm_open_noupdate(snd_pcm_t **pcmp, snd_config_t *root,
                                 const char *name, snd_pcm_stream_t stream,
                                 int mode, int hop)
{
    int card = 0, device = 0;
    (void) root;
    (void) hop;
    /* wasm32-posix-kernel subset build: bypass the config parser
     * entirely. SDL2 / smoke tests call snd_pcm_open("default") or
     * snd_pcm_open("hw:N,M"); the kernel ships /dev/snd/pcmC0D0p
     * (plan 6 A2) as the only PCM endpoint. Map device strings to
     * the direct hw_open path without touching snd_config_*. */
    if (name == NULL ||
        strcmp(name, "default") == 0 ||
        strcmp(name, "hw") == 0 ||
        strcmp(name, "plughw") == 0) {
        card = 0;
        device = 0;
    } else if (strncmp(name, "hw:", 3) == 0 ||
               strncmp(name, "plughw:", 7) == 0) {
        const char *p = strchr(name, ':') + 1;
        card = (int) strtol(p, (char **) &p, 10);
        if (*p == ',')
            device = (int) strtol(p + 1, NULL, 10);
    } else {
        SNDERR("PCM '%s' not supported in subset build "
               "(use 'default' or 'hw:N,M')", name);
        return -ENOENT;
    }
    return snd_pcm_hw_open(pcmp, name, card, device, -1,
                           stream, mode, 0, 0);
}
```

This is more invasive than a "minor rewrite", but it's the only way to avoid linking conf.c. Generate the patch with `diff -u original modified > patches/0001-default-to-hw00.patch` and apply via `patch -p1 -d $SRC_DIR < patches/0001-default-to-hw00.patch` in the build script.

`snd_pcm_open` itself still calls `snd_config_update_ref(&top)` and `snd_config_unref(top)`. These need stubs (or another patch hunk). Cleanest: add stubs to conf_stubs.c — `snd_config_update_ref` returns 0 and writes a non-NULL sentinel pointer; `snd_config_unref` is a no-op. Then the existing `snd_pcm_open` code flows through without modification.

### Build script outline — `packages/registry/alsa-lib/build-alsa-lib.sh`

Following the libdrm shape, NOT the plan's `examples/libs/` sketch:

1. Validate `wasm32posix-cc` available (matches libdrm/libpng).
2. Download `alsa-lib-1.2.10.tar.bz2` if `$SRC_DIR` missing; verify sha256.
3. Apply `$SCRIPT_DIR/patches/0001-default-to-hw00.patch`.
4. Run upstream's `configure` to generate `include/config.h`. Use libpng's flags as a starting point. Plan 7 calls these autoconf overrides:
   ```
   ac_cv_func_uselocale=no
   ac_cv_func_eventfd=no
   ac_cv_func_clock_gettime=yes
   ac_cv_func_dlopen=no
   ```
   plus `--host=wasm32-unknown-none CC=wasm32posix-cc --prefix=$INSTALL_DIR --enable-static --disable-shared --disable-aload --disable-mixer --disable-rawmidi --disable-hwdep --disable-seq --disable-ucm --disable-topology --disable-alisp --disable-old-symbols --without-versioned --without-debug`.
5. **DO NOT run `make`.** Upstream's libtool dance doesn't cross-compile cleanly. Manually compile each .c file with wasm32posix-cc, then `llvm-ar rcs $INSTALL_DIR/lib/libasound.a *.o`.
6. **DO NOT run `make -C src/pcm libasound_module_pcm_hw.la 2>/dev/null || true`** (the plan's sketch). Per pre-impl review fix #5: that line is vestigial and hides errors.
7. Install headers: `mkdir -p $INSTALL_DIR/include/alsa && cp $SRC_DIR/include/*.h $INSTALL_DIR/include/alsa/`. The source's `include/alsa -> .` symlink means we copy from `$SRC_DIR/include/*.h` (without recursing into the symlink) into a real `include/alsa/` dir.
8. Also copy `$BUILD_DIR/include/config.h` to `$INSTALL_DIR/include/alsa/config.h` if any consumer needs it (probably not — internal to alsa-lib build).
9. Compile `$SCRIPT_DIR/src/conf_stubs.c` as the last .o file, archived with the others.

### Files to add for A4

- `packages/registry/alsa-lib/build-alsa-lib.sh` — per above.
- `packages/registry/alsa-lib/src/conf_stubs.c` — ENOSYS-returning stubs for the 30+ snd_config_*/snd_async_*/snd_output_* symbols listed above. Plus `snd_config_update_ref` returning 0 + sentinel, `snd_config_unref` no-op.
- `packages/registry/alsa-lib/patches/0001-default-to-hw00.patch` — unified diff replacing snd_pcm_open_noupdate body.

### Files to add for A5

A5's deliverable is the patch + the stub TU. Per pre-impl review fix #5, both bundle into A4's commit; A5 is logically merged with A4 in PR #1.

### Smoke test

Per plan 7 A4 spec, `programs/alsa_lib_smoke.c`:

```c
#include <alsa/asoundlib.h>
#include <stdio.h>

int main(void) {
    snd_pcm_t *pcm;
    int err = snd_pcm_open(&pcm, "default", SND_PCM_STREAM_PLAYBACK, 0);
    if (err < 0) { printf("snd_pcm_open failed: %s\n", snd_strerror(err)); return 1; }
    snd_pcm_hw_params_t *hw;
    snd_pcm_hw_params_malloc(&hw);
    snd_pcm_hw_params_any(pcm, hw);
    snd_pcm_hw_params_set_access(pcm, hw, SND_PCM_ACCESS_RW_INTERLEAVED);
    snd_pcm_hw_params_set_format(pcm, hw, SND_PCM_FORMAT_S16_LE);
    snd_pcm_hw_params_set_channels(pcm, hw, 2);
    unsigned rate = 48000;
    snd_pcm_hw_params_set_rate_near(pcm, hw, &rate, NULL);
    err = snd_pcm_hw_params(pcm, hw);
    printf("HW_PARAMS: %s, rate=%u\n", snd_strerror(err), rate);
    snd_pcm_hw_params_free(hw);
    snd_pcm_close(pcm);
    return err < 0 ? 1 : 0;
}
```

Vitest: assert exit 0; assert stdout matches `rate=48000`. The kernel implements `SNDRV_PCM_IOCTL_*` already (PR #698; `crates/kernel/src/audio/pcm_ioctl.rs`), so the round-trip works once the userspace wrapper compiles + links.

## Files that ARE committed in session 48

`c8414fbeb` (only commit):
- D `libc/glue/libdrm_stub.c` (391 lines)
- D `libc/musl-overlay/include/drm/{drm.h, drm_mode.h, drm_fourcc.h, SOURCE.txt}` (~4400 lines)
- D `libc/musl-overlay/include/xf86drm.h` (69 lines)
- D `libc/musl-overlay/include/xf86drmMode.h` (157 lines)
- M `programs/dri-modeset.c` (+15 — poll() loop before drmHandleEvent)
- M `scripts/build-musl.sh` (+40/-14 — step 10 rewrite, step 11 -I additions)
- M `scripts/build-programs.sh` (+8 — -I additions for libdrm/drm)

Total: 10 files changed, 51 insertions, 5063 deletions.

## Files that are UNCOMMITTED at session 48 close — DO NOT lose

Working tree contains (verify with `git status --short`):

- `M scripts/build-musl.sh` (step 12 added — libinput-lite resolve+symlink)
- `M scripts/build-programs.sh` (`libinput_stub_smoke.c` case)
- `?? packages/registry/alsa-lib/` (package.toml + build.toml + patches/ scaffolded; build-alsa-lib.sh NOT written)
- `?? packages/registry/libinput-lite/` (package.toml + build.toml + build-libinput-lite.sh + include/libinput.h + src/libinput_stub.c — complete)
- `?? programs/libinput_stub_smoke.c`
- `?? host/test/libinput-stub.test.ts`

These represent ~150 LoC of code that took meaningful time to write and verify. If session 49 starts cold without these, the libinput-lite work needs to be redone. **Re-read this handoff to find them before any rm or git clean.**

## Reference — locations after session 48

| Thing | Where |
|---|---|
| SDL2 work branch | `explore-dri-sdl2-shims` tip `c8414fbeb`, off audio PR #698 tip `d1b1156e8` |
| SDL2 plan worktree | `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/` |
| SDL2 plan doc | `docs/plans/2026-06-29-sdl2-port-plan.md` (read end-to-end in session 47) |
| Resolver cache for libdrm | `/Users/mho/.cache/kandelo/libs/libdrm-2.4.120-rev1-wasm32-<sha>/` (sha rotates; query via `cargo xtask build-deps path libdrm`) |
| Resolver cache for libinput-lite | `/Users/mho/.cache/kandelo/libs/libinput-lite-0.1.0-rev1-wasm32-<sha>/` |
| Resolver cache (template) for alsa-lib | will be `/Users/mho/.cache/kandelo/libs/alsa-lib-1.2.10-rev1-wasm32-<sha>/` once the build script lands |
| Extracted alsa-lib 1.2.10 source (for reference only) | `/tmp/alsa-extract/alsa-lib-1.2.10/` |
| Existing libdrm tests (continue passing) | `host/test/dri-*.test.ts` (9 passing, 1 skipped) |
| Existing audio kernel surface | `crates/kernel/src/audio/pcm_ioctl.rs` + `crates/kernel/src/ofd.rs` |
| Dev shell entry | `export PATH="/nix/var/nix/profiles/default/bin:$PATH"; bash scripts/dev-shell.sh ...` |

## Trade-offs already locked in by session 48 (don't relitigate)

- **Replace stub (option 1), not parallel coexistence (option 2)** — committed in `c8414fbeb`. Both old libdrm.a paths are gone.
- **Symlinks from cache → sysroot** — not copies. Cache key rotation just needs `build-musl.sh` rerun.
- **dri-modeset.c gets `poll()` before `drmHandleEvent`**, not the kernel's read() blocking. The kernel-side fix is potentially correct, but out of scope for Phase A (libdrm port). Tracked as "kernel limitation accepted, consumer adapted" — same trade-off SDL2 KMSDRM has on every Linux distro that doesn't block reads on `/dev/dri/cardN` (rare, but the idiom handles it).
- **libinput-lite uses sentinel source URL pattern from posix-utils-lite**. Plan 7's earlier `examples/libs/` shape with explicit "in-tree" type is dead; we conform to existing registry conventions.
- **build-musl.sh depends on cargo + nix dev shell** for step 10 + step 12. Documented and explicit; CI already provides this.

## Open todos for session 49

1. **Finish A6**: Run the unfinished `bash scripts/dev-shell.sh bash scripts/build-programs.sh` (interrupted at session end), then `cd host && npx vitest run test/libinput-stub.test.ts`. Confirm exit 0 + "OK" stdout. Commit the libinput-lite work as a checkpoint (will be squashed at A8).
2. **A4 + A5 (alsa-lib)**: Write the build script, conf_stubs.c, and 0001-default-to-hw00.patch per the implementation notes above. Drive `cargo xtask build-deps resolve alsa-lib` to a working `libasound.a`. Wire into `build-musl.sh` step 13. Write `programs/alsa_lib_smoke.c` + `host/test/alsa-lib-smoke.test.ts`. Commit.
3. **A8 squash + PR open**: Interactive rebase to squash all session-47/48/49 commits into ONE bundled commit titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite`. Base = `explore-dri-evdev-and-alsa`. NOT `main`. DO NOT include `docs/plans/*` in the PR diff.
4. **Run the full gauntlet** before opening PR — cargo tests, vitest, libc-test, posix-test, ABI snapshot, browser demo verification (if anything UI-relevant touched). Per CLAUDE.md "Test Verification" — all 6 suites.

## Standing instruction for session 49 — print THIS sentence

> *"Read `docs/plans/2026-06-15-dri-kandelo-port-handoff-48.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Branch `explore-dri-sdl2-shims` tip is `c8414fbeb` — Phase A's A7 (upstream libdrm wired into sysroot via symlinks, in-tree stub deleted) and A3 (all 10 DRI vitests pass against upstream) are committed; A6 (libinput-lite) is fully implemented + builds but the vitest hasn't been run + nothing is committed yet; A4 + A5 (alsa-lib) recipe is scaffolded but the build script + conf_stubs.c + patches/0001-default-to-hw00.patch are NOT written. Session 48 left an uncommitted working tree (`packages/registry/libinput-lite/`, `packages/registry/alsa-lib/`, `programs/libinput_stub_smoke.c`, `host/test/libinput-stub.test.ts`, `scripts/build-musl.sh` step-12 edit, `scripts/build-programs.sh` libinput case) — DO NOT `git clean` or rm anything in `packages/registry/{alsa-lib,libinput-lite}/` until you've cross-checked the handoff-48 §'Files that are UNCOMMITTED at session 48 close' list. Continue with (1) finish A6 — rebuild programs, run vitest, commit; then (2) A4 + A5 — write `build-alsa-lib.sh` + `conf_stubs.c` + the real unified-diff patch using the implementation notes in handoff-48 §'A4–A5 implementation notes' (in particular: the patch must REPLACE the body of `snd_pcm_open_noupdate` in `src/pcm/pcm.c` lines 2665–2687, NOT just rewrite the name string — the sed sketch in plan 7 is wrong because the rewritten code still calls snd_config_search_definition which the subset doesn't link); then (3) A8 — interactive-rebase to squash all session 47/48/49 commits into one bundled commit titled `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite`, run the full 6-suite gauntlet, and open draft PR #1 with base `explore-dri-evdev-and-alsa`. DO NOT target `main`. DO NOT resurrect per-task commits (the PR is one squashed commit). DO NOT stage `docs/plans/*` or handoff markdowns into the PR. DO NOT use `examples/libs/<name>/` — repo uses `packages/registry/<name>/`. The three non-obvious cross-compile fixes in `build-libdrm.sh` (`-D__linux__=1`, `-DMAJOR_IN_SYSMACROS=1`, the `linux/types.h` + `asm/ioctl.h` shims) and the two new fixes from session 48 (the `-I$SYSROOT/include/libdrm -I$SYSROOT/include/drm` pair on all consumers of upstream xf86drm.h, and the `poll(fd, POLLIN, -1)` before `drmHandleEvent` in `programs/dri-modeset.c`) are load-bearing — preserve them on any rewrite. `export PATH=\"/nix/var/nix/profiles/default/bin:$PATH\"` before `scripts/dev-shell.sh`. Auto-mode default; bias to action; pause on architectural calls."*
