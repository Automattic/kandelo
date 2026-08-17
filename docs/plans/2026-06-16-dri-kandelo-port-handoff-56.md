# DRI port onto kandelo:main — session 56 handoff (GL stubs landed, sdl2_demo + vitest green, kernel PCM refine fix; ABI 16 intact)

Continuation of [handoff-55](./2026-06-16-dri-kandelo-port-handoff-55.md). Session 56 landed the GL-stubs fan-out (libEGL.a + libGLESv2.a archives + gbm_surface_* extensions), patched SDL2 with `-DSDL_VIDEO_STATIC_ANGLE=1` so the dlopen-less LOAD_FUNC path picks up the static libEGL/libGLESv2 symbols, fixed a kernel-side PCM `refine_hw_params` bug that was silently dropping caller-supplied periods constraints (surfaced by SDL2's audio-init sequence), wrote `programs/sdl2_demo.c` + `host/test/sdl2-demo.test.ts`, and committed **four new commits**. The vitest end-to-end demo passes both timeout AND ESC-quit paths against the centralized kernel.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2` (tracking `origin/explore-dri-sdl2`). Tip `e6cc2f5d8`. **Four new commits on top of handoff-55's `f60ccff85` — NOT YET PUSHED:**
   - `a11dc1bb2` — `sysroot(gl-stubs): archive libEGL.a + libGLESv2.a; extend libgbm with gbm_surface_*`
   - `cf610100d` — `kernel(pcm): respect caller-supplied periods + derive buffer_size when both pinned`
   - `1ed6bb394` — `sysroot(sdl2): -DSDL_VIDEO_STATIC_ANGLE=1 + rev3 — wire libEGL/libGLESv2 statically`
   - `e6cc2f5d8` — `examples(sdl2): sdl2_demo + vitest end-to-end (Phase C1 + C2)`
2. **ABI:** still 16. `bash scripts/check-abi-version.sh` exit 0. The pcm_ioctl change is semantic-only — struct layout, syscall numbers, mask bits all unchanged.
3. **Pushed:** **NO.** Local-only. Push with `git push origin explore-dri-sdl2` before continuing.
4. **Working tree state:** clean for session 56's tracked changes. Pre-existing untracked items (docs/plans/*.md, openssl tls/* artifacts, libc-test, sortix submodule, apps/browser-demos/test-results/) unchanged.
5. **Tests landing green at tip:**
   - `cargo test -p kandelo --target aarch64-apple-darwin --lib`: 1069 passed, 0 failed.
   - `host && npx vitest run test/sdl2-demo.test.ts`: **2 passed** (5117 ms timeout + 356 ms ESC).
   - `host && npx vitest run test/sdl2-kmsdrm-smoke.test.ts test/sdl2-alsa-smoke.test.ts test/sdl2-evdev-smoke.test.ts test/alsa-lib-smoke.test.ts`: 4 passed.
   - `host && npx vitest run test/input-evdev.test.ts test/dri-libdrm-kms.test.ts test/alsa-lib-smoke.test.ts`: 3 passed.
   - **Full vitest sweep NOT run** — session 56 was interrupted before the full pass. **HIGH PRIORITY for session 57.**

## What `a11dc1bb2` (GL stubs fan-out) covered

Diff: 3 files, +323/-4.

### `scripts/build-musl.sh` — step 11b (new)

Archives `libc/glue/libegl_stub.c` → `sysroot/lib/libEGL.a` and `libc/glue/libglesv2_stub.c` → `sysroot/lib/libGLESv2.a` after the existing libgbm step. Same pattern: `clang -c` then `llvm-ar rcs`. Header search path adds `-I$REPO_ROOT/libc/glue` so both stubs can `#include "gl_abi.h"`.

The handoff-55 alternative (three new packages: `libegl-stub` + `libgles2-stub` + `libgbm-extended`) was rejected — the source files are first-party in `libc/glue/` alongside `channel_syscall.c`, packaging them as out-of-tree dependencies is ceremony with no benefit. In-tree archive matches the libgbm pattern and is the canonical path.

### `libc/glue/libegl_stub.c` — additional thin stubs

Added six entry points required by SDL_egl.c's LOAD_FUNC macros under `SDL_VIDEO_STATIC_ANGLE`:

- `eglGetProcAddress(name)` — returns NULL (we expose no EGL-side extensions). LOAD_FUNC_EGLEXT in SDL_egl.c routes through this; NULL is the documented "extension not present" answer.
- `eglSwapInterval(dpy, interval)` — accepts any value, returns TRUE (no vsync knob; host bridge runs at canvas-natural cadence).
- `eglWaitGL()` — flush + return TRUE.
- `eglWaitNative(engine)` — return TRUE.
- `eglQueryAPI()` — return EGL_OPENGL_ES_API.
- `eglCreatePbufferSurface(...)` — return EGL_NO_SURFACE (we don't enable SDL_VIDEO_OFFSCREEN).

### `libc/glue/libgbm_stub.c` — gbm_surface_* API + accessory APIs

Extended the existing libgbm shim with the surface-ring API SDL2's `KMSDRM_CreateSurfaces` drives:

- `gbm_surface_create / _create_with_modifiers / _create_with_modifiers2` — allocate a `struct gbm_surface` holding a fixed two-BO ring (`WPK_GBM_SURFACE_BO_COUNT = 2`). Each BO is created via `gbm_bo_create` at surface allocation time so width/height/stride stay constant across lock cycles. Modifiers other than `DRM_FORMAT_MOD_LINEAR` are ignored.
- `gbm_surface_lock_front_buffer` — hands out the next free BO in round-robin order; returns NULL + EBUSY if both BOs are in flight.
- `gbm_surface_release_buffer` — marks the BO as free; silent no-op for foreign BOs (matches mesa).
- `gbm_surface_has_free_buffers` — returns count of !in_use.
- `gbm_surface_destroy` — destroys each BO + frees the surface struct.

Also added:
- `gbm_device_is_format_supported(dev, format, flags)` — returns 1 for the 32-bpp fourccs the kernel's CREATE_DUMB accepts; 0 otherwise.
- `gbm_bo_write(bo, buf, count)` — `gbm_bo_map` + memcpy; reuses the lazy-cached mapping.
- `gbm_bo_set_user_data / gbm_bo_get_user_data` — opaque pointer with destroy callback (called from gbm_bo_destroy).

The gbm_bo struct grew three fields (`user_data`, `user_data_destroy`, `surface`); existing accessors are unchanged.

## What `cf610100d` (kernel PCM refine fix) covered

Diff: 1 file, +55/-3 in `crates/kernel/src/audio/pcm_ioctl.rs`.

### The bug

`refine_hw_params()` computed `PARAM_PERIODS` purely from `PARAM_BUFFER_SIZE / PARAM_PERIOD_SIZE` and **silently overwrote** whatever value the caller had constrained PARAM_PERIODS to. alsa-lib drives the hw_params handshake through repeated HW_REFINEs that tighten one interval at a time. SDL2's audio init sequence (mirroring most ALSA apps):

```
set_period_size_near(1024)    → HW_REFINE { period_size: [1024,1024] }
set_periods_min(2)             → HW_REFINE { period_size: [1024,1024], periods: [2,…] }
set_periods_first(2)           → HW_REFINE { period_size: [1024,1024], periods: [2,2] }
snd_pcm_hw_params()            → HW_PARAMS  { period_size: [1024,1024], buffer_size: [2048,2048], periods: [2,2] }
```

But the kernel was returning `periods: [1,16]` (256/1024 → 16384/1024) regardless of caller input. alsa-lib treated `set_periods_min(2)` as failed, SDL_alsa_audio.c's `ALSA_set_buffer_size` returned -1, and SDL_strerror(-1) reported "Operation not permitted" (EPERM) — a diagnostically misleading message because the wrapper truncated the original errno.

### The fix

Intersect derived `[buffer_min/period_max, buffer_max/period_min]` with caller's `[periods.min, periods.max]`; return EINVAL if the intersection is empty. Additionally, when both `period_size` AND `periods` pin to a single value but `buffer_size` is still a range (and `period * periods` is within the v1 cap [256, 16384] AND inside the current buffer range), pin `buffer_size = period * periods` eagerly. This is what alsa-lib's `snd_pcm_hw_params_choose()` converges to anyway and HW_PARAMS' `read_interval_single` requires single values.

### Test-helper update

`refined_hw_params()` now pins `PARAM_PERIODS = buffer/period` (the only self-consistent value) instead of just the interval's `min`. The previous tests passed only because the kernel silently ignored the broken `periods=1` they fed it. All 26 `audio::pcm_ioctl::tests` pass, and the full 1069-test cargo suite is green.

### Why this isn't an ABI bump

Struct layout (`WpkAlsaPcmHwParams`), syscall numbers (`SNDRV_PCM_IOCTL_HW_REFINE/_HW_PARAMS`), and mask bit layout all unchanged. Pure refine semantics. `bash scripts/check-abi-version.sh` exits 0.

## What `1ed6bb394` (SDL2 STATIC_ANGLE + rev3) covered

Diff: 2 files, +13/-2.

### The bug

With `--disable-loadso`, `SDL_LoadObject` is a stub returning NULL. `SDL_egl.c::SDL_EGL_LoadLibraryInternal` then errors at line 386 with "Could not initialize OpenGL / GLES library" because `opengl_dll_handle = NULL` (lines 343-381 hard-coded to `SDL_LoadObject` paths) — before any window can be created. libSDL2.a's KMSDRM backend's `SDL_KMSDRM_LoadEGLLibrary` calls `SDL_EGL_LoadLibrary(_this, NULL, ..., EGL_PLATFORM_GBM_MESA)`, which calls `SDL_EGL_LoadLibraryOnly` → `SDL_EGL_LoadLibraryInternal` — fails.

### The fix

`-DSDL_VIDEO_STATIC_ANGLE=1` flips `LOAD_FUNC` from the SDL_LoadFunction path to a direct symbol-address assignment:

```c
#if defined(SDL_VIDEO_STATIC_ANGLE) || defined(SDL_VIDEO_DRIVER_VITA)
#define LOAD_FUNC(NAME) \
    _this->egl_data->NAME = (void *)NAME;
#else
#define LOAD_FUNC(NAME) \
    _this->egl_data->NAME = SDL_LoadFunction(_this->egl_data->egl_dll_handle, #NAME); \
    ...
#endif
```

The whole `SDL_LoadObject` chain at lines 336-419 is also guarded by the same `!STATIC_ANGLE` check, so it's skipped. SDL_egl.c then assigns each libEGL.a entry point directly into `_this->egl_data->egl<Foo>` at link time, and `eglGetDisplay` / `eglInitialize` work end-to-end. "ANGLE" in the macro name is misleading — it's an ANGLE-static-build escape hatch but applies cleanly to any static-EGL build.

`build.toml` revision `2 → 3` forces a fresh cache_key_sha so the resolver rebuilds libSDL2.a with the new flag.

## What `e6cc2f5d8` (sdl2_demo + vitest) covered

Diff: 3 files, +360/-1.

### `programs/sdl2_demo.c` (~200 LoC)

KMSDRM video + ALSA audio + evdev input combined. Spinning GLES2 quad (320×240, color shifts on `sin(t * 2)`), continuous 440 Hz sine via SDL_OpenAudioDevice + audio callback, exit on either 5 s timeout OR ESC keydown. Differences from plan §C1:

- **`setenv("SDL_EVDEV_DEVICES", "2:/dev/input/event0,1:/dev/input/event1")`** — without libudev, `src/core/linux/SDL_evdev.c::SDL_EVDEV_Init`'s no-udev branch is literally a `/* TODO: Scan the devices manually, like a caveman */` comment. SDL_EVDEV_DEVICES is the upstream-blessed escape hatch (format: `<class>:<path>[,...]`; class 2=keyboard, 1=mouse). Matches the kandelo kernel's two virtual evdev surfaces (input-evdev-smoke.test.ts §"Phase 1/2"). Without this, ESC events arrive at the kernel's event0 ring but SDL2 never reads them because it has no fd open.
- **Elapsed time captured BEFORE SDL_Quit()** — `SDL_QuitSubSystem(TIMER)` tears down the `start_ts` cache; a post-Quit `SDL_GetTicks()` re-inits from a fresh base and the subtraction wraps to ~UINT32_MAX. The first sdl2_demo iteration had `elapsed=4294967289` (-7 wrap) until this was fixed.
- **`SDL_PumpAudioDevices()` per frame** — required because `SDL_THREADS_DISABLED` routes the audio callback through the polling driver landed in handoff-55's rev2 patch.
- **`setenv("SDL_AUDIODRIVER", "alsa", 1)`** added alongside `SDL_VIDEODRIVER=kmsdrm` for symmetry.

### `host/test/sdl2-demo.test.ts`

Two `it()` blocks:

1. **Timeout path** — uses `runCentralizedProgram`, asserts exitCode=0, stdout contains "OK frames=… elapsed=… exit=timeout", frames>0. Tests showed `frames=68670 elapsed=5117 ms` (i.e. ~13k fps — the GLES2 encoder + cmdbuf flush on Node.js doesn't sleep; SDL_PumpAudioDevices early-returns on EAGAIN, so per-iteration cost is tiny).
2. **ESC path** — uses `NodeKernelHost` directly so it can call `host.injectInputEvent`. Waits for "sdl2_demo: SDL_Init OK", waits 250 ms, then injects `KEY_ESC` press + SYN, then release + SYN. Asserts exit=esc and elapsed<3500ms. Last run: `exit=esc` at ~356 ms.

### `scripts/build-programs.sh` sdl2_demo case

Added `libEGL.a` + `libGLESv2.a` explicitly to the link line because `#include <SDL2/SDL_opengles2.h>` only **transitively** pulls `<GLES2/gl2.h>`. `build_program`'s auto-detect regex matches only direct top-level `EGL/`, `GLES2/`, `GLES3/` includes — so without the explicit append the GL stubs aren't on the link line and SDL2's `KMSDRM_GLES_LoadLibrary` resolves to undefined symbols.

## Verification status at session end

### Green

- `cargo test -p kandelo --target aarch64-apple-darwin --lib`: **1069 passed, 0 failed.**
- `cargo test -p kandelo --target aarch64-apple-darwin --lib audio::pcm_ioctl`: **26 passed, 0 failed.**
- vitest spot-checks (sdl2-demo, sdl2-kmsdrm-smoke, sdl2-alsa-smoke, sdl2-evdev-smoke, alsa-lib-smoke, input-evdev, dri-libdrm-kms): **all passed.**
- `bash scripts/check-abi-version.sh`: exit 0, ABI 16 consistent.

### NOT RUN at session end

- **Full vitest sweep** (`cd host && npx vitest run`). Session 56 was interrupted before this completed.
- **libc-test** (`scripts/run-libc-tests.sh`).
- **posix-tests** (`scripts/run-posix-tests.sh`).
- **Browser verify** (`./run.sh browser` + manual check).
- **Base-branch vitest evidence capture** (`explore-dri-evdev-and-alsa` ABI 15) — handoff-55 §(e) carryover.
- **PROCESS_TABLE lock-contention gate** (plan §C4) — see Open Questions.

## Open questions for session 57

### 1. Lock-contention gate (plan §C4) — implement or defer with reasoned doc note?

Per plan §C4 the PR body should publish per-tick-handler `PROCESS_TABLE.lock()` acquire-vs-body percentages with a 5% threshold. Two issues:

- **No instrumentation exists.** `grep -rn "PROCESS_TABLE.lock\|tick_handler" crates/kernel/src host/src` returns nothing. Implementing the gate end-to-end means adding:
  - Lock-timing in each tick handler (input, audio, vblank) in the kernel.
  - A reporting hook from kernel → host (new IPC message or shared SAB counter).
  - A vitest harness that runs the demo at peak load (1000 Hz fake input, audio per-quantum 375 Hz, vblank 60 Hz) and reads + compares the counters.
- **The kernel runs on a single dedicated worker thread.** There's nothing else contending for PROCESS_TABLE in the centralized architecture — by construction, lock acquire time is "the time to call .lock() on an uncontended Mutex," which is measured in nanoseconds against bodies measured in microseconds. The "<5%" threshold is essentially guaranteed.

**Recommendation for session 57:** Document the gate as **deferred-by-design** in the PR body: "PROCESS_TABLE is held by a single dedicated worker thread; no cross-thread contention possible by the centralized-kernel architecture. OFD-table-split refactor deferred until wpkcompositor lands a workload that actually multiplexes." If a reviewer pushes back, implement a minimal vitest that records observable proxies (syscall throughput ratios) instead.

### 2. Browser verify (plan §C3) — when?

Plan §C3 expects `./run.sh browser` + manual canvas/audio/ESC verification in Chromium + Firefox. The dual-host parity requirement in CLAUDE.md is hard — Node + browser must both work for any host-touching change. Session 56's changes touched:

- `crates/kernel/src/audio/pcm_ioctl.rs` — kernel-side, shared across hosts via `host/src/kernel-worker.ts`. Should work on both transparently.
- `libc/glue/*.c` — link-time only, applies to both.
- `packages/registry/sdl2/build-sdl2.sh` — affects the libSDL2.a artifact, applies to both.

**No host-side TypeScript was touched.** The browser path should work as-is for sdl2_demo (it would need an `examples/browser/pages/sdl2/` entry that's not yet written). Session 57 should either write the browser entry page and verify, OR defer browser-demo authoring with a documented PR-body note.

### 3. Push the four commits before any rebase / branch operations

Session 56 ended with the four commits LOCAL ONLY. `git push origin explore-dri-sdl2` should be the first command in session 57. The branch is still tracking `origin/explore-dri-sdl2` (which is at `f60ccff85`); the push will fast-forward.

### 4. Base-branch evidence capture (handoff-55 §(e))

Run full vitest on `explore-dri-evdev-and-alsa` (the PR base) to capture the ~123 stale-cache failures and attach to PR body. This proves the failures aren't introduced by the SDL2 work. Quick path:

```bash
git stash    # or: save uncommitted; nothing uncommitted at session-56-end
git fetch origin explore-dri-evdev-and-alsa
git switch --detach origin/explore-dri-evdev-and-alsa
bash build.sh
cd host && npx vitest run > /tmp/base-branch-vitest.log 2>&1
cd .. && git switch explore-dri-sdl2
```

## Branch / commit invariants (preserve into session 57)

- **Branch:** `explore-dri-sdl2` (tracking `origin/explore-dri-sdl2`).
- **Tip:** `e6cc2f5d8` — `examples(sdl2): sdl2_demo + vitest end-to-end (Phase C1 + C2)`.
- **Local-only commits:** the four above, on top of `f60ccff85`. **Not yet pushed.**
- **Ten commits since base (`explore-dri-evdev-and-alsa`):**
  1. `4dc64cf79` — sysroot(sdl2-shims): libdrm-KMS + alsa-lib + libinput-lite + kernel CTL ioctl gate + ioctl-encoded host marshalling
  2. `9312b390f` — sysroot(alsa): align WpkAlsaPcmStatus/MmapStatus/MmapControl to wasm32 uframes_t=4
  3. `6eda62af4` — sysroot(sdl2): scaffold SDL2 2.30.0 package + dep manifest (B1)
  4. `8ffe0c0b2` — sysroot(sdl2): cross-compile pass — configure overrides + evdev shim + dynapi patch (B2)
  5. `1d38beac3` — sysroot(sdl2): B3/B4/B5 backend smoke tests + dep-symlink + connector mode-info fixes
  6. `f60ccff85` — sysroot(sdl2): polling-audio patch — SDL_OpenAudioDevice + SDL_PumpAudioDevices for SDL_THREADS_DISABLED (rev2)
  7. `a11dc1bb2` — sysroot(gl-stubs): archive libEGL.a + libGLESv2.a; extend libgbm with gbm_surface_*
  8. `cf610100d` — kernel(pcm): respect caller-supplied periods + derive buffer_size when both pinned
  9. `1ed6bb394` — sysroot(sdl2): -DSDL_VIDEO_STATIC_ANGLE=1 + rev3 — wire libEGL/libGLESv2 statically
  10. `e6cc2f5d8` — examples(sdl2): sdl2_demo + vitest end-to-end (Phase C1 + C2)
- **ABI_VERSION:** 16. No change planned.
- **`abi/snapshot.json`:** unchanged from `4dc64cf79`. No structural changes this session.
- **Cached resolver artifacts** (current, after session 56):
  - `~/.cache/kandelo/libs/sdl2-2.30.0-rev3-wasm32-3f05e53c/` — SDL2 rev3 (with STATIC_ANGLE + polling-audio + dynapi + evdev-shim patches)
  - `~/.cache/kandelo/libs/alsa-lib-1.2.10-rev5-wasm32-*/` — alsa-lib rev5
  - `~/.cache/kandelo/libs/libdrm-2.4.120-rev1-wasm32-*/` — libdrm at ABI 16
  - `~/.cache/kandelo/libs/libinput-lite-0.1.0-rev1-wasm32-*/` — libinput-lite stub

## Findings from this session worth preserving (avoid re-deriving)

### `SDL_VIDEO_STATIC_ANGLE=1` is the right macro for static-EGL builds

Despite the misleading "ANGLE" in the name, this macro just means "EGL symbols are linked in, not loaded via dlopen." It applies cleanly to any static-EGL build (not just ANGLE). The check in SDL_egl.c is `#if defined(SDL_VIDEO_STATIC_ANGLE) || defined(SDL_VIDEO_DRIVER_VITA)`. The "DYNAPI_NEEDS_DLOPEN" hint we already use is orthogonal — that disables the SDL_DYNAMIC_API dispatch layer; SDL_VIDEO_STATIC_ANGLE disables the EGL dlopen layer. Both are required for `--disable-loadso` builds that want EGL.

### `SDL_EVDEV_DEVICES` env var is the no-udev escape hatch

`src/core/linux/SDL_evdev.c::SDL_EVDEV_Init`'s no-libudev branch contains a literal `TODO: Scan the devices manually, like a caveman` and leaves the device list empty unless the env var is set. Format: `<cls>:<path>[,<cls>:<path>...]` with class 1=mouse, 2=keyboard, 4=joystick, 8=sound, 16=touchscreen, 32=accelerometer, 64=touchpad. Without this, all evdev devices are invisible to SDL2 even though the kernel has them at /dev/input/event0..1.

### SDL_Quit invalidates the SDL_GetTicks base

`SDL_QuitSubSystem(TIMER)` resets the `ticks_started` flag in `SDL_systimer.c`. The next `SDL_GetTicks()` call after SDL_Quit re-runs `SDL_TicksInit`, capturing a fresh `start_ts`. Any `SDL_GetTicks() - earlier_start` subtraction after SDL_Quit wraps to ~UINT32_MAX. **Always capture elapsed time BEFORE SDL_Quit.**

### `eglGetProcAddress` returning NULL is fine for static-linked GL programs

The libegl_stub's `eglGetProcAddress` returns NULL for every name. This is correct because:
- Programs that call `gl<Foo>` directly resolve at link time via libGLESv2.a's exported symbols.
- SDL2 internally falls back to `SDL_LoadFunction(opengl_dll_handle, ...)` — which is NULL under STATIC_ANGLE, so the result is NULL — exactly as our `eglGetProcAddress` would have returned.
- `LOAD_FUNC_EGLEXT` macros assign the result directly; NULL is documented as "extension not present" — SDL2 tolerates it.

### `gbm_surface` v1 is a two-BO ring with eager allocation

Mesa's gbm_surface is backed by a variable-size ring of BOs that EGL renders into and KMS scans out from. Our v1 fixes this at 2 (double-buffer). BOs are allocated eagerly at `gbm_surface_create` time so dimensions stay constant across lock cycles. If both BOs are in flight, `gbm_surface_lock_front_buffer` returns NULL + EBUSY — matches mesa's exhausted-ring behavior. The KMSDRM page-flip workflow (lock → drmModeAddFB → drmModePageFlip → release prev) requires `lock_front_buffer` after `eglSwapBuffers`; ensure SDL_GL_SwapWindow doesn't desync.

### Kernel's `refine_hw_params` had a silent caller-constraint drop

Pre-fix, `PARAM_PERIODS` was computed purely from `buffer/period` and the caller's input was discarded. Any caller that tried to constrain periods saw their constraint silently dropped, then snd_pcm_hw_params_choose() returned an inconsistent struct, then HW_PARAMS' read_interval_single failed, then alsa-lib's SDL_strerror mapped the truncated -1 to "Operation not permitted." The "Operation not permitted" message under SDL_OpenAudioDevice on a wasm32-target ALSA path is almost certainly THIS bug, not actual EPERM. Look for the kernel-side hw_params delta first.

### vitest `injectInputEvent` works for SDL2 evdev events end-to-end

`NodeKernelHost.injectInputEvent(device, ev_type, code, value)` writes into the kernel-side `/dev/input/event<device>` ring. SDL2's evdev backend, once it has the device fd open (via SDL_EVDEV_DEVICES — see above), reads the events on `SDL_PumpEvents()` and translates them to SDL_KEYDOWN / SDL_MOUSEMOTION / etc. The full path is exercised by `host/test/sdl2-demo.test.ts`'s ESC variant.

## What MUST happen next session — in this order

1. **Push the four local commits** — `git push origin explore-dri-sdl2`. They are local-only at session-56-end.
2. **Full vitest sweep on tip** — `cd host && npx vitest run` (~5-10 min). Catch any regressions from the pcm_ioctl change that the spot-check sweep missed. Critical: anything touching audio (host/test/audio-*.test.ts, alsa-*.test.ts) and any test that opens a PCM stream.
3. **Re-run remaining gauntlet items per CLAUDE.md Test Verification:**
   - `scripts/run-libc-tests.sh` — 0 unexpected failures (XFAIL/TIME acceptable).
   - `scripts/run-posix-tests.sh` — 0 FAIL.
4. **Resolve §C4 lock-contention gate** — recommendation: document deferred-by-design (see Open Question #1). If reviewer wants numbers, write a minimal vitest that runs sdl2_demo for 5 s with periodic syscall counters logged via stderr; aggregate per-tick-handler. Don't add kernel instrumentation just for one PR.
5. **Browser verify (plan §C3)** — write `examples/browser/pages/sdl2/` entry, run `./run.sh browser`, click Run, verify canvas + audio + ESC. If audio is silent, check `audioCtx.resume()` is firing before mount (per plan amendment §c3).
6. **Capture base-branch evidence** — see Open Question #4.
7. **Open the single draft PR.** Base = `explore-dri-evdev-and-alsa`. Suggested title:

   ```
   [explore-dri-sdl2] sysroot(sdl2): full Phase A–C — backends + GL stubs + sdl2_demo
   ```

   Body must cover (per handoff-55 + this doc):
   - Phase A structural rationale (sysroot shims bundled, not three sub-plans).
   - Phase B (a)/(b)/(c) realignment + kernel PCM refine fix surfaced by SDL2's audio init.
   - Phase C1+C2 sdl2_demo + vitest. Frames=68670, elapsed=5117 ms (timeout); elapsed≈356 ms (ESC).
   - GL stubs gap — demo is link/exec, not render (per handoff-53 §(d)).
   - SDL_VIDEO_STATIC_ANGLE + polling-audio + dynapi patches all documented.
   - Profiling gate decision (deferred-by-design recommended).
   - Dual-host parity claim with browser verification result.
   - Preexisting vitest cache-staleness disclosure with evidence log.

## Standing instruction for session 57 — print THIS sentence

> *"Read `docs/plans/2026-06-16-dri-kandelo-port-handoff-56.md` first, then handoff-55 for prior context. Branch is `explore-dri-sdl2`, tip `e6cc2f5d8`. ABI 16. **Four LOCAL-ONLY commits at session-56-end — push first.** Ten commits total since base. sdl2_demo vitest is GREEN both ways (timeout 5117ms, ESC 356ms); cargo suite is GREEN (1069 passed); ABI snapshot consistent. FIRST steps: (a) `git push origin explore-dri-sdl2`. (b) Full vitest sweep on tip (`cd host && npx vitest run`) — catch any regressions from the kernel `refine_hw_params` periods/buffer fix. (c) Run libc-test + posix-tests gauntlet items. (d) Decide §C4 lock-contention gate — recommendation: deferred-by-design (single-threaded centralized kernel; no cross-thread contention possible). (e) Write `examples/browser/pages/sdl2/` + browser verify per §C3. (f) Capture base-branch vitest evidence on `explore-dri-evdev-and-alsa` (ABI 15). (g) Open single draft PR against `explore-dri-evdev-and-alsa` with the body shape outlined in handoff-56 §"What MUST happen next session" #7. Auto-mode default; bias to action; pause if anything surfaces a new regression that needs root-cause analysis. Remember: edit-then-diff for any SDL2 patches; `npm run build` in host/ after editing src/ files that worker_thread loads from dist/; `bash build.sh` after kernel changes; `bash scripts/check-abi-version.sh` after anything that might touch ABI surface."*
