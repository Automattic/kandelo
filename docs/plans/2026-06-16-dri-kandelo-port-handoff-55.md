# DRI port onto kandelo:main — session 55 handoff (B3/B4/B5 green + polling-audio patch landed; GL stubs + Phase C ahead)

Continuation of [handoff-54](./2026-06-16-dri-kandelo-port-handoff-54.md). Session 55 fixed the stale-sysroot-symlink bug, diagnosed + fixed B3's KMSDRM display-enumeration failure (kernel-side mode-info default), committed B3/B4/B5 with all three smokes green, then wrote + landed the polling-audio patch (open-arch #1) — SDL2's `SDL_OpenAudioDevice` now succeeds on the SDL_THREADS_DISABLED path with a new `SDL_PumpAudioDevices()` polling driver. **Two new commits pushed; six total on the branch since base.**

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2` (tracking `origin/explore-dri-sdl2`). Tip `f60ccff85`. Two new commits on top of handoff-54's `8ffe0c0b2`:
   - `1d38beac3` — `sysroot(sdl2): B3/B4/B5 backend smoke tests + dep-symlink + connector mode-info fixes`
   - `f60ccff85` — `sysroot(sdl2): polling-audio patch — SDL_OpenAudioDevice + SDL_PumpAudioDevices for SDL_THREADS_DISABLED (rev2)`
2. **ABI:** still 16. No structural changes this session.
3. **Pushed:** yes, `origin/explore-dri-sdl2` is at `f60ccff85`.
4. **Working tree state:** clean (no uncommitted tracked changes from session 55's work; the handoff-54 untracked-docs/preexisting submodule diffs remain unchanged).
5. **All 5 SDL2 smoke + DRI regression tests green** at tip.

## What `1d38beac3` (B3/B4/B5 + 3 fixes) covered

Diff: 11 files, +367/-4. Three real fixes uncovered while running the smokes:

### Fix 1 — stale-sysroot-symlink (resolves handoff-54 §B4)

`scripts/build-programs.sh`'s SDL2 resolver block now re-symlinks every transitive dep archive (libasound.a, libdrm.a, libinput.a) whenever it resolves SDL2, not just libSDL2.a. The previous fast-path guarded on `libSDL2.a` only, so an alsa-lib (or libdrm / libinput) revision bump produced a fresh sdl2 cache while sysroot symlinks for the deps stayed pointing at pre-bump caches — programs then linked against stale dep archives. The resolver is idempotent + cached; always re-resolving is cheap.

### Fix 2 — alsa-lib `snd_device_name_hint` stubs (resolves handoff-54 §B4)

`packages/registry/alsa-lib/src/conf_stubs.c` + `build.toml` (rev4 → rev5). SDL2's `SDL_alsa_audio.c` calls `snd_device_name_hint` during init to enumerate PCM devices; without it the import resolves to `Unimplemented import: env.snd_device_name_hint` at first use. Our PCM-direct subset doesn't compile alsa-lib's `namehint.c`, so the new stubs return an empty hint array (sufficient for SDL2's probe).

### Fix 3 — kernel-side virtual-connector mode-info (resolves handoff-54 §B3)

`host/src/dri/kms-registry.ts` + `host/src/kernel.ts`. The `host_kms_mode_info` host import now returns a populated 1024x768@60 VESA-standard modeinfo struct flagged `PREFERRED | DRIVER`. The previous impl returned 68 zero bytes, which caused SDL2's `KMSDRM_AddDisplay` to fail its `mode.hdisplay == 0 || mode.vdisplay == 0` check with "Couldn't get a valid connector videomode." Our virtual KMS surface has no real fixed mode, but consumers that probe the connector's preferred mode (any KMSDRM client, not just SDL2) need a non-zero default.

### Smoke programs + vitest tests (B3/B4/B5)

- `programs/sdl2_kmsdrm_smoke.c` + `host/test/sdl2-kmsdrm-smoke.test.ts` — SDL_Init(VIDEO), driver=KMSDRM, displays>=1.
- `programs/sdl2_alsa_smoke.c` + `host/test/sdl2-alsa-smoke.test.ts` — SDL_Init(AUDIO), driver="alsa".
- `programs/sdl2_evdev_smoke.c` + `host/test/sdl2-evdev-smoke.test.ts` — SDL_Init(EVENTS) + SDL_PumpEvents() round-trip.

`scripts/build-programs.sh` per-program link cases wire the right archive set per smoke.

## What `f60ccff85` (polling-audio rev2) covered

Diff: 2 files, +199/-1. New file: `packages/registry/sdl2/patches/0002-polling-audio-eagain.patch` (~115 LoC of SDL2-side changes across `src/audio/SDL_audio.c`, `src/audio/alsa/SDL_alsa_audio.c`, `include/SDL_audio.h`).

### Patch shape (all gated on `#if SDL_THREADS_DISABLED`)

- **`src/audio/SDL_audio.c`** — adds `wpk_polled_audio_devices[8]` static array + `wpk_register_polled_audio_device()` / `wpk_unregister_polled_audio_device()`. New `SDL_RunAudioOnce_Polled(device)` mirrors `SDL_RunAudio`'s direct-write loop body for one iteration (no `WaitDevice` call — returns to caller). New public `SDL_PumpAudioDevices(void)` iterates the registered devices.
- **`src/audio/SDL_audio.c::open_audio_device`** — gate the `SDL_CreateThread` block with `#if SDL_THREADS_DISABLED` / `#else`. On the disabled-threads branch: call `impl.ThreadInit(device)` + register for polling, return device->id. Thread-driven path is byte-identical when SDL_THREADS_DISABLED is undefined.
- **`src/audio/SDL_audio.c::close_audio_device`** — polled-mode teardown: ThreadDeinit + unregister.
- **`src/audio/alsa/SDL_alsa_audio.c::ALSA_PlayDevice`** — treat -EAGAIN from `snd_pcm_writei` as "ring full, try again next pump" (return) instead of `SDL_Delay(1); continue;`. The spin-and-retry deadlocks the single-threaded polled loop.
- **`include/SDL_audio.h`** — public declaration `extern DECLSPEC void SDLCALL SDL_PumpAudioDevices(void);` (gated outside the SDL_THREADS_DISABLED ifdef so headers parse uniformly; the function is only defined when SDL_THREADS_DISABLED is set, which on our wasm32 build it is).

### Verification

- `llvm-nm libSDL2.a | grep SDL_PumpAudioDevices` → `T SDL_PumpAudioDevices` (exported).
- `llvm-nm | grep wpk_polled` → `d wpk_polled_audio_devices` (static data).
- B3/B4/B5 smokes still pass — the new code paths are dormant until `SDL_OpenAudioDevice` is called.

### `build.toml.revision` 1 → 2

Forces resolver to invalidate cache + rebuild sdl2 against the new patch set. Current artifact: `~/.cache/kandelo/libs/sdl2-2.30.0-rev2-wasm32-7aa4bdd8/lib/libSDL2.a` (3,901,816 bytes).

## What MUST happen next session — in this order

The original handoff-54 + plan-7's Task C1-C5 still hold. Remaining items:

1. **GL stubs landing** — the existing source files `libc/glue/libegl_stub.c` (258 LoC), `libc/glue/libglesv2_stub.c` (548 LoC), and `libc/glue/libgbm_stub.c` (275 LoC) are already written. Only `libgbm_stub.c` is currently archived into `sysroot/lib/libgbm.a` by `scripts/build-musl.sh`. The plan calls for three new packages `libegl-stub` + `libgles2-stub` + `libgbm-extended`, but the **pragmatic alternative** is to extend `scripts/build-musl.sh` to also archive libegl_stub.c + libglesv2_stub.c into `sysroot/lib/libEGL.a` + `libGLESv2.a` (matching the libgbm pattern). Either path works; the in-tree-stub pattern is simpler and matches libgbm. The **`gbm_surface_*` API** (`create`, `create_with_modifiers`, `lock_front_buffer`, `release_buffer`, `destroy`, `has_free_buffers`, `set_user_data`) needs to be added to `libgbm_stub.c` (declared in `sysroot/include/gbm.h:503-527`, not yet implemented). SDL2's `SDL_kmsdrmvideo.c::KMSDRM_CreateSurfaces` calls `gbm_surface_create_with_modifiers` + `gbm_surface_lock_front_buffer`/`release_buffer`.

2. **Phase C1 — `sdl2_demo.c`** (~250 LoC). Per plan §C1 (lines 1617+): 320×240 spinning GLES2 quad via KMSDRM, continuous 440Hz tone via ALSA, ESC exits via evdev. Main loop calls `SDL_PumpEvents()` + the new `SDL_PumpAudioDevices()` each frame. Plan body has the code skeleton.

3. **Phase C2 — vitest spec** for sdl2_demo (timeout + ESC paths). Per plan §C2 (lines 1749+).

4. **Phase C3 — browser verify** — manual via `./run.sh browser`. The browser host's `audioCtx.resume()` must fire before mounting per the inline fix #6 amendment.

5. **Phase C4 — PROCESS_TABLE lock-contention profiling gate.** New vitest spec measuring per-tick-handler `PROCESS_TABLE.lock()` acquire vs body time. Threshold: <5% per tick handler under peak sdl2_demo load. Per plan §C4 (lines 1793+).

6. **Capture vitest evidence on `explore-dri-evdev-and-alsa`** (handoff-53 §(c)). Run full vitest on the base branch (ABI 15) to capture the same ~123 stale-cache failures. Attach to PR body to disclose the issue isn't caused by these changes.

7. **5-suite gauntlet at final tip.** Per CLAUDE.md Test Verification: cargo, vitest, libc-test, posix-tests, ABI snapshot check.

8. **Open single draft PR.** Base = `explore-dri-evdev-and-alsa`. Body covers structural rationale, (b) realignment, GL-stubs gap, vitest cache-staleness disclosure, polling-audio patch resolution of open-arch #1.

## Branch / commit invariants (preserve into session 56)

- **Branch:** `explore-dri-sdl2` (tracking `origin/explore-dri-sdl2`).
- **Tip:** `f60ccff85` — `sysroot(sdl2): polling-audio patch — SDL_OpenAudioDevice + SDL_PumpAudioDevices for SDL_THREADS_DISABLED (rev2)`.
- **Six commits since base** (`explore-dri-evdev-and-alsa`):
  1. `4dc64cf79` — `sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling`
  2. `9312b390f` — `sysroot(alsa): align WpkAlsaPcmStatus/MmapStatus/MmapControl to wasm32 uframes_t=4`
  3. `6eda62af4` — `sysroot(sdl2): scaffold SDL2 2.30.0 package + dep manifest (B1)`
  4. `8ffe0c0b2` — `sysroot(sdl2): cross-compile pass — configure overrides + evdev shim + dynapi patch (B2)`
  5. `1d38beac3` — `sysroot(sdl2): B3/B4/B5 backend smoke tests + dep-symlink + connector mode-info fixes`
  6. `f60ccff85` — `sysroot(sdl2): polling-audio patch — SDL_OpenAudioDevice + SDL_PumpAudioDevices for SDL_THREADS_DISABLED (rev2)`
- **ABI_VERSION:** 16. No change planned.
- **`abi/snapshot.json`:** unchanged from `4dc64cf79`. No structural changes this session.
- **Cached resolver artifacts** (current, after session 55):
  - `~/.cache/kandelo/libs/sdl2-2.30.0-rev2-wasm32-7aa4bdd8/` — SDL2 rev2 (with polling-audio + dynapi + evdev-shim patches)
  - `~/.cache/kandelo/libs/alsa-lib-1.2.10-rev5-wasm32-8e238bf2/` — alsa-lib rev5 (with snd_device_name_hint stubs)
  - `~/.cache/kandelo/libs/libdrm-2.4.120-rev1-wasm32-696d55f0/` — libdrm at ABI 16
  - `~/.cache/kandelo/libs/libinput-lite-0.1.0-rev1-wasm32-1caca328/` — libinput-lite stub
- **Working-tree state:** clean for session 55's changes. Pre-existing untracked items unchanged (docs/plans/*, openssl tls/* artifacts, tests/libc/libc-test, sortix submodule, apps/browser-demos/test-results/).

## Findings from this session worth preserving (avoid re-deriving)

### Test runtime path: `host/dist/` is what worker_threads load, NOT `host/src/`

`host/src/worker-adapter.ts::NodeWorkerAdapter.resolveCompiledEntry()` checks for `host/dist/node-kernel-worker-entry.js` and uses that compiled JS instead of the TS source when present. Vitest tests import from `../src/` but the worker_thread that actually runs the kernel imports from `dist/`. **After editing any host TypeScript file that the kernel-worker uses (kernel.ts, kernel-worker.ts, dri/kms-registry.ts, etc.), run `npm run build` from `host/` before re-running vitest**, or the changes won't take effect. Symptom: smoke test still fails with the old error message after fixing the source. Confirmed for the B3 mode-info fix.

### `host_kms_mode_info` is a host-side concept (not kernel-side)

Kandelo's KMS surface is virtual — there is no real fixed mode. The `host_kms_mode_info` host import is the single point where the mode struct is populated; the kernel's `DRM_IOCTL_MODE_GETCONNECTOR` handler writes `connector->modes[0]` from the host's return. The current default is 1024x768@60 in `host/src/dri/kms-registry.ts::buildVirtualConnectorMode()`. Any future "configurable display size" feature should plumb through this function (and the matching `KmsRegistry` plumbing for connector-id → mode mapping if multi-head ever lands).

### Patch authoring: edit-then-diff is faster than hand-crafting unified diff headers

Manually counting `@@ -A,B +C,D @@` line numbers is error-prone — `patch --dry-run` rejected the hand-authored 0002 patch on first attempt. **Faster path:** `cp -r sdl2-src /tmp/sdl2-src-pre-X` → use `Edit` tool to modify the in-tree sdl2-src directly → `diff -Naur --label a/path --label b/path /tmp/original packages/.../sdl2-src/path > /tmp/X.patch` → concatenate per-file patches into the .patch file. Validate with `patch -p1 --dry-run -d /tmp/sdl2-verify`. This is how 0002-polling-audio-eagain.patch was authored.

### `build.toml.revision` bump invalidates cache; resolver picks up source changes

When iterating on a patched source package (e.g., adding patches/0002-*.patch), bump `build.toml.revision` so the resolver invalidates the cached artifact. Without the bump, the resolver thinks the existing cache is valid (cache_key_sha is computed over package.toml + build.toml + patches/ + recipe, NOT over the extracted sdl2-src/). With the bump, the resolver re-extracts the upstream tarball, re-applies all patches in order, rebuilds, and produces a new cache dir.

### SDL2 source extraction: `if [ ! -d "$SRC_DIR" ]` gate

`build-sdl2.sh` only re-extracts the tarball + applies patches if `sdl2-src/` is absent. To force a fresh extract + patch sequence, `rm -rf packages/registry/sdl2/sdl2-src` before running the resolver. This is what session 55 did before testing 0002 patch.

### `SDL_PumpAudioDevices` is declared unconditionally in SDL_audio.h

The function itself is only defined inside `#if SDL_THREADS_DISABLED` in SDL_audio.c. The public header declaration is uncondtional — consumers that link against the wasm32 build will find the symbol; consumers on platforms where SDL_THREADS_DISABLED is undefined will get a link error if they call it. This matches how SDL2 handles other platform-conditional API.

### B5 polling-audio is shippable but unverified end-to-end

The patch compiles + the symbol is exported, but it hasn't been exercised by a program that actually opens an audio device. `sdl2_demo` (Phase C1) will be the first integration test. Risks: (a) the `data != device->work_buffer` check assumes `GetDeviceBuf` is the only source of direct-write buffers — confirm against ALSA's actual ALSA_GetDeviceBuf return; (b) the polling cadence isn't gated on ring availability — the demo's main loop will spam SDL_PumpAudioDevices and rely on ALSA's EAGAIN early-return to skip — verify this isn't burning CPU. Both addressable as follow-ups if profiling shows the issue.

## Standing instruction for session 56 — print THIS sentence

> *"Read `docs/plans/2026-06-16-dri-kandelo-port-handoff-55.md` first, then handoff-54 for tactical state. Branch is `explore-dri-sdl2`, tip `f60ccff85`. ABI 16. Six commits on branch. B3/B4/B5 smokes green; polling-audio patch (rev2) landed. FIRST steps: (a) GL stubs — extend `scripts/build-musl.sh` to archive `libc/glue/libegl_stub.c` + `libc/glue/libglesv2_stub.c` into `sysroot/lib/libEGL.a` + `libGLESv2.a` (matching the libgbm pattern), AND add `gbm_surface_*` implementations to `libc/glue/libgbm_stub.c` (entry points declared in `sysroot/include/gbm.h:503-527`). (b) Write `programs/sdl2_demo.c` + `host/test/sdl2-demo.test.ts` per plan §C1-C2. (c) Browser verify via `./run.sh browser`. (d) PROCESS_TABLE lock-contention profiling gate per plan §C4. (e) Capture vitest evidence on `explore-dri-evdev-and-alsa`. (f) Re-run 5-suite gauntlet. (g) Open single draft PR against `explore-dri-evdev-and-alsa`. Auto-mode default; bias to action; pause if anything surfaces a new regression that needs root-cause analysis."*
