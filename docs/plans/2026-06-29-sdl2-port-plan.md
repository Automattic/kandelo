# DRI v2 — SDL2 port plan (milestone D)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Port SDL2 to `wasm32-unknown-none` so SDL2 applications run
unmodified on the kernel built by plans 2–6: video via SDL2's
`KMSDRM` backend talking to `/dev/dri/card0` (plan 4) through
libdrm-KMS + libgbm (plan 2) + an EGL context (plans 2 + 3); audio
via SDL2's `ALSA` backend talking to `/dev/snd/pcmC0D0p` (plan 6)
through a vendored alsa-lib subset; input via SDL2's evdev backend
talking to `/dev/input/event*` (plan 5) through a libinput-lite
scan-and-open wrapper. Plan 7 is **milestone D** — the first plan
that exercises every kernel surface plans 2–6 produced under a real
workload, and the gate that proves the design is internally
coherent. **Sysroot-only changes — no kernel code, no host code,
no ABI impact.**

**Architecture:** Three "userland shim" libraries bundled into this
plan (libdrm-KMS subset, alsa-lib subset, libinput-lite) live under
`examples/libs/{libdrm, alsa-lib, libinput-lite}/`, packaged with
the same recipe shape plan 2's gbm uses (`package.toml` +
`build.toml` + `build.sh`). SDL2 itself vendors as
`examples/libs/sdl2/`. The shims build first (Phase A); SDL2 builds
on top of them (Phase B); a demo + browser verify (Phase C) closes
the loop. SDL2 is configured with
`SDL_VIDEO_DRIVER_KMSDRM=1 SDL_VIDEO_DRIVER_X11=0
SDL_VIDEO_DRIVER_WAYLAND=0 SDL_AUDIO_DRIVER_ALSA=1
SDL_INPUT_LINUXEV=1 SDL_USE_LIBUDEV=0` so its build-time backend
selection matches what we ship — no X11, no Wayland, no pulseaudio,
no udev.

**Why bundle the shims into plan 7 instead of separate sub-plans:**
the userland libraries are *glue*, not feature work. libdrm-KMS's
job is to wrap plan 4's ioctls in the `drmModeAtomicCommit` /
`drmModeAddFB2` / `drmModeGetResources` API SDL2 calls; alsa-lib's
job is to wrap plan 6's `SNDRV_PCM_IOCTL_*` in the
`snd_pcm_hw_params_set_format` / `snd_pcm_writei` API; libinput-lite
synthesises a udev-less device enumerator over plan 5's
`/dev/input/event*`. None of these libraries do real work beyond
"format an ioctl call." A separate sub-plan per shim would mean
three PRs that each ship a library nothing calls — un-mergeable until
SDL2 lands. Bundling keeps the dependency tight and gives reviewers
one coherent change-set to validate. (Plan 9's wpkcompositor will
later get its own focused PRs for libxkbcommon + libwayland-server,
because those become independently load-bearing for the compositor's
own clients — different shape.)

**Tech Stack:**
- Userland shims: C99 with `wasm32posix-cc`; static libs under
  `sysroot/lib/`; headers under `sysroot/include/{drm/, alsa/,
  libinput.h, …}`.
- SDL2: vendor of upstream SDL 2.30.x (latest stable in the 2.x
  line; v2 is in long-term-maintenance mode but v3 has different
  ABI). Cross-compile via SDL's `configure` with explicit
  `ac_cv_*=no` overrides for host-feature detection
  misdetections (per CLAUDE.md's "Cross-Compilation and Configure
  Scripts" rule).
- Demo: `sdl2_demo.c` — a 320×240 spinning quad rendered through
  KMSDRM, a `Beep!` tone via ALSA, ESC-to-quit through evdev. ~250
  LoC; the smallest "real" SDL2 app that exercises all three
  backends.

**Companion design doc:** `docs/plans/2026-05-18-dri-design.md` §9
(SDL2 port; milestone D); §10 (compositor preview, plan 9 — *not* in
scope here).

**Critical wasm32 ABI detail — SDL2's `SDL_Surface` / `SDL_Event` /
`SDL_AudioSpec` cross the ABI between SDL2 binaries and SDL2-linked
apps.** SDL2 versions its ABI via `SDL_VERSIONNUM` and apps link
against a specific minor; we vendor 2.30.x and pin. The
SDL_RWops / SDL_AudioCVT / SDL_AudioStream structs are not ABI-
sensitive in v1 (no SDL2 app currently in scope dlopens SDL2 or
crosses build-version boundaries), but the kernel-userland ABI from
plans 2–6 is unchanged by this plan — SDL2 talks to the kernel
only through the existing ioctl + mmap + read/write surfaces.

**Clock source:** SDL2's `SDL_GetTicks()` / `SDL_GetPerformanceCounter`
maps to `clock_gettime(CLOCK_MONOTONIC, …)` via the existing musl
shim. Already pinned; no change. SDL2's audio + video pacing uses
the same monotonic clock plans 4–6 use, so cross-stream A-V-sync
profiling works.

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §9.1
(SDL2 backend selection), §9.2 (SDL2's KMSDRM video pipeline), §9.3
(ALSA audio pipeline), §9.4 (evdev input pipeline), §9.5 (the
scan-and-open udev-less enumeration path), §16 q6 (clock source).

**Consistency with plans 2 + 3 + 4 + 5 + 6:**
- This plan adds NO new kernel exports, NO new host imports, NO new
  ioctls, NO new device nodes. Every kernel surface SDL2 touches
  already exists from plans 2–6. The sysroot is the only thing that
  changes.
- libdrm-KMS subset wraps plan 4's KMS ioctls
  (`DRM_IOCTL_MODE_GETRESOURCES`, `DRM_IOCTL_MODE_GETCONNECTOR`,
  `DRM_IOCTL_MODE_GETCRTC`, `DRM_IOCTL_MODE_ADDFB2`,
  `DRM_IOCTL_MODE_SETCRTC`, `DRM_IOCTL_MODE_PAGE_FLIP`,
  `DRM_IOCTL_WAIT_VBLANK`, master set/drop) in the
  `drmModeAtomicReqAlloc` / `drmModeGetResources` / `drmModeAddFB2`
  / `drmModePageFlip` / `drmHandleEvent` API shape SDL2's
  `src/video/kmsdrm/SDL_kmsdrmvideo.c` calls. Plan 2's libgbm-stub
  (already vendored) handles the `gbm_surface` / `gbm_bo_create` /
  `gbm_bo_import` side; libdrm-KMS hands the bo's PRIME-fd to
  `MODE_ADDFB2`.
- alsa-lib subset wraps plan 6's `SNDRV_PCM_IOCTL_*` in the
  `snd_pcm_open` / `snd_pcm_hw_params_*` / `snd_pcm_writei` API
  SDL2's `src/audio/alsa/SDL_alsa_audio.c` calls. The subset does
  NOT pull in alsa-lib's config / conf-parser / `~/.asoundrc`
  surface (that's ~80% of alsa-lib's code and is orthogonal to the
  hardware path). SDL2's audio init survives an empty
  asound-config; alsa-lib's `snd_pcm_open("default", …)` is
  short-circuited in our subset to "open `/dev/snd/pcmC0D0p`
  directly".
- libinput-lite is a 200-LoC wrapper that does NOT ship the real
  libinput (libinput is ~30k LoC and pulls in udev, mtdev, libwacom,
  libevdev as deps; far too much for v1). Instead, libinput-lite
  exposes a minimal `libinput_dispatch` + `libinput_get_event` API
  that SDL2's libinput backend (when enabled) drives. We do NOT
  enable SDL2's libinput backend in v1 — we enable SDL2's *direct*
  evdev backend (`src/core/linux/SDL_evdev.c`) which scans
  `/dev/input/event*` itself. libinput-lite ships as a no-op stub
  that returns ENOTSUP from `libinput_udev_create_context` so any
  third-party app that links libinput but checks the return value
  degrades to the evdev fallback. (Plan 9's wpkcompositor will
  port real libinput when it needs the higher-level features —
  gesture recognition, palm rejection, pointer acceleration.)
- SDL2's `SDL_USE_LIBUDEV=0` build flag selects the
  scan-and-open fallback for input-device enumeration: at
  `SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_EVENTS)`,
  SDL2 walks `/dev/input/event[0-31]` directly via `open()`,
  reads `EVIOCGBIT` to classify each device, and registers
  keyboard + pointer handlers per device. We ship event0 +
  event1 (plan 5); SDL2's loop finds both and wires them.
- `CLOCK_MONOTONIC` already pinned across plans 4–6; SDL2's
  `SDL_GetTicks` inherits via the musl `clock_gettime` shim.
  A-V-sync invariant from plan 6's review carries through.

**Stack base:** Plan 6's `…-alsa-demo` branch tip. Plan 7 doesn't
extend any kernel code; the kernel is the same as it was at plan 6
merge.

**Branch:**
`emdash/explore-direct-rendering-infrastructure-sdl2-plan-XXXXX`
(chains off plan 6's tip per the branching rule). Three sub-branches
stack off it (shims / SDL2 / demo).

**Final PR base:** Plan 6's `…-alsa-demo` tip. Do not merge until
Brandon validates the design, plan 6 lands, **and Phase C's
profiling step confirms PROCESS_TABLE lock contention < 5% on each
of the three tick handlers (plan 6 cross-plan amendment).** If the
profiling gate fails, the OFD-table-split refactor (plan 4
open-architecture #2 / plan 5 open-architecture #1 / plan 6
open-architecture) lands as a focused inter-plan PR before plan 7
merges.

**Three PRs, coordinated merge.** Each task below is one commit.
Brandon's `scope(area): action` titles:

1. `sysroot(sdl2-shims): libdrm-KMS + alsa-lib subset + libinput-lite stub`
2. `sysroot(sdl2): vendor SDL2 2.30.x + cross-compile + backend wiring`
3. `examples(sdl2): sdl2_demo + browser spec + Phase C profiling gate`

PR base/head topology (stacked):

```
explore-webgl-exposition-demo                   (v1 tip)
 └── …-buffer-plan-XXXXX                        (plan 2)
      └── …-buffer-demo
           └── …-multiplexer-plan-YYYYY         (plan 3)
                └── …-mux-demo
                     └── …-kms-plan-ZZZZZ      (plan 4)
                          └── …-kms-demo
                               └── …-evdev-plan-WWWWW    (plan 5)
                                    └── …-evdev-demo
                                         └── …-alsa-plan-VVVVV    (plan 6)
                                              └── …-alsa-demo
                                                   └── …-sdl2-plan-UUUUU    (this plan)
                                                        └── …-sdl2-shims  (PR #1)
                                                             └── …-sdl2-port  (PR #2)
                                                                  └── …-sdl2-demo  (PR #3)
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass
with zero regressions before any PR is opened, and re-run before final
merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a
regression. Phase C adds: (a) manual `./run.sh browser` verification
of the sdl2 demo (CLAUDE.md item 6) — a 320×240 spinning quad
renders for 5 s with audio beep + responds to ESC; (b) the
PROCESS_TABLE lock-contention profiling gate from plan 6's
cross-plan amendment.

**ABI impact:** **None.** This plan adds no kernel exports, no host
imports, no new ioctls, no new device nodes, no new repr(C) structs
on the kernel-userland ABI. Every byte SDL2 sends to the kernel
goes through ioctls + mmap + read/write already defined by plans
2–6. `ABI_VERSION` does not bump; `abi/snapshot.json` does not
change. The PR does not run `scripts/check-abi-version.sh update`
because there's nothing to regenerate.

The sysroot DOES grow: `sysroot/lib/libdrm.a`, `sysroot/lib/
libasound.a`, `sysroot/lib/libinput.a`, `sysroot/lib/libSDL2.a`
land, plus their headers. The package-index ledger (PR #490
infrastructure) gets four new entries.

Existing kernel + host + ABI surfaces — all unchanged.

---

## Pre-implementation review

Devil's-advocate pass run in the session after drafting; findings
structured Brandon-style. Ten inline fixes flagged (folded
conceptually into the review; plan body retains its pre-review text
per the plan 6 convention so reviewers can see what changed). Four
open correctness items + two **load-bearing** open-architecture
items — the audio-thread model and the GL stack ownership — block
PR #2 merge regardless of how the other fixes land. Nine missing
tests; eleven trade-offs verified; six deliberately-not-flagged.
Two cross-plan follow-up notes leak back into plans 5 + 6; one
larger open-architecture item escalates to plans 2 + 3 (kept in
this review's open-architecture #2 rather than amending those plans
directly, because the user's session scope was 4 + 5 + 6).

### Inline fixes (10 — folded conceptually; plan body unchanged)

- **SDL2's audio model is thread-driven; `--disable-pthreads`
  makes `SDL_OpenAudioDevice` return 0.** SDL2 2.30's
  `SDL_OpenAudio_Internal` (in `src/audio/SDL_audio.c`)
  unconditionally calls `SDL_CreateThreadInternal(SDL_RunAudio,
  …)` and bails on NULL: `SDL_CloseAudioDevice(device->id);
  SDL_SetError("Couldn't create audio thread"); return 0;`. With
  `--disable-pthreads`, the SDL_thread backend reduces to
  `src/thread/generic/SDL_systhread.c` which returns NULL from
  `SDL_SYS_CreateThread`. The PR-body note that audio_cb "runs
  on the kernel-driven audio thread" conflates two things — the
  per-quantum kernel tick *advances hw_ptr*, but the userspace
  callback loop is a separate SDL_RunAudio thread that calls
  `audio_cb` then `PlayDevice` (= `snd_pcm_writei`). Without
  that thread, no demo audio. *Folded as open-architecture #1.
  Three viable resolutions: (a) vendor a libpthread shim that
  wraps WPK's `clone(CLONE_VM)` syscall + uses SAB futexes for
  sync — heaviest path, benefits plans 8–11; (b) patch SDL2's
  audio path to a polling model (`SDL_PumpAudio()` callable from
  the main loop, with non-blocking writei gated on
  `mmap_status->avail` from plan 6's status page) — ~150 LoC SDL2
  patch, confines threading question to v1; (c) defer SDL2 audio
  to a follow-up plan and ship plan 7 PR #3 with video + input
  only. Pick before Phase B's B2 commit lands.*
- **`-lEGL -lGLESv2 -lgbm` link line presumes libraries that no
  plan in the chain ships as static libs.** The design doc §2 says
  "v1 cmdbuf, EGL stubs, libGLESv2 stubs, `host_gl_*` host imports
  […] are all reused verbatim" — but in this worktree, v1's stubs
  aren't user-space static libs (`sysroot/lib/libEGL.a` /
  `libGLESv2.a` don't exist; nothing in `examples/libs/` ships
  them). Plan 2's draft also explicitly defers `gbm_surface_create`
  to "the next plan after multiplexer" (plan 2 line 1869); SDL2's
  KMSDRM backend in `SDL_kmsdrmvideo.c::KMSDRM_CreateSurfaces` calls
  `gbm_surface_create_with_modifiers` + `gbm_surface_lock_front_buffer`
  / `release_buffer`. None of plans 2/3/4 ship those entry points.
  *Folded as open-architecture #2. Resolution: a thin
  `examples/libs/libegl-stub/` + `examples/libs/libgles2-stub/`
  package set (static libs that wrap the v1 `host_gl_*` imports)
  PLUS extending plan 2's libgbm-stub to ship `gbm_surface_*` —
  either as a plan-2 follow-up PR before plan 7 PR #2 or bundled
  into plan 7 PR #1 (the shim PR). Lean: plan-2 follow-up, because
  gbm_surface is load-bearing for plans 8–11 too, not just SDL2.
  Block plan 7 PR #2 on it.*
- **`DRM_CLIENT_CAP_ATOMIC returns EINVAL on enable` fallback
  reasoning is doubly wrong.** First, an unimplemented ioctl on a
  chardev returns ENOTTY in POSIX (plan 4's dispatcher falls
  through to the default match arm); EINVAL is what an
  *implemented* ioctl returns for bad args. Second, SDL2 2.30's
  KMSDRM backend (`SDL_kmsdrmvideo.c::KMSDRM_CreateDevice` +
  `KMSDRM_VideoInit`) doesn't request atomic at all in v2 — it
  uses legacy `drmModeSetCrtc` + `drmModePageFlip` exclusively;
  atomic was experimental until SDL3. So there's no atomic probe
  to fall back from. *Folded: replace the cross-reference bullet
  with "SDL2 2.30 KMSDRM backend uses legacy SETCRTC + PAGE_FLIP
  exclusively (verified against `SDL_kmsdrmvideo.c::KMSDRM_VideoInit`);
  no `DRM_IOCTL_SET_CLIENT_CAP` call site to worry about." Risk
  register #2 downgraded from "mitigation: patch SDL2" to
  "verified — no patch needed."*
- **`sed -i` regex-rewrite of `snd_pcm_open_noupdate` in Task A5
  is brittle.** The plan acknowledges this ("A real patch file
  would be cleaner") but ships the sed anyway. The pattern
  `return snd_config_search_definition.*` is fragile across
  alsa-lib versions and will silently no-op if the call shape
  shifts. *Folded: replace with
  `examples/libs/alsa-lib/patches/0001-default-to-hw00.patch`
  applied via `git apply --directory=$SRC_DIR` against the
  pinned 1.2.10 commit. A5 Step 3 builds the patch file (~10
  lines of unified diff context); rejected hunks fail the build
  loudly.*
- **alsa-lib subset file list will not link `snd_pcm_open`.**
  SDL2's `snd_pcm_open("default", …)` enters `pcm.c`, which
  before the A5 short-circuit calls `snd_config_search_definition`
  + `snd_config_get_pointer` etc. — symbols defined in `src/conf.c`,
  `src/confeval.c`, `src/confmisc.c`, none of which are in A4's
  file list. The link succeeds only after A5's patch *also* removes
  the snd_config_* preamble (not just substitutes the name). *Folded:
  A5's patch must move the short-circuit to the *very top* of
  `snd_pcm_open_noupdate`, before any `snd_config_*` reference, AND
  the subset must add either (i) a `snd_config_*` stub TU that
  returns ENOTSUP from every entry point (zero-size archive, no
  config parser needed) or (ii) build `src/conf.c` standalone.
  Lean: (i), because the conf.c surface is huge and pulls in
  iconv/locale. Add `examples/libs/alsa-lib/src/conf_stubs.c` to
  the build.*
- **`SDL_PauseAudioDevice(audio, 0)` in B4 + C1 starts audio
  before the browser AudioContext has a user gesture.** Risk
  register #7 acknowledges this but the demo code doesn't wire
  the resume bridge. Without it, the browser-host SDL2 demo
  opens the audio device, `SDL_PauseAudioDevice(dev, 0)` triggers
  the per-quantum tick, and the AudioContext stays suspended →
  no `process()` calls → kernel ticks fire from a different
  source (or not at all). *Folded: C3 (manual browser
  verification) gains a host-side step before launching the demo
  — the browser page's "Run" button must call `audioCtx.resume()`
  first, then mount the demo. Add a 5-LoC wpk-host shim
  `wpk_audio_unlock()` in `examples/browser/lib/browser-kernel.ts`
  that the page invokes pre-mount. C2 (Node Vitest) is unaffected
  — no autoplay policy.*
- **`xf86drm_compat.h` content doesn't match its comment.** A2's
  generated header is:
  ```c
  #define HAVE_SYS_SYSCTL_H 0
  #define HAVE_VISIBILITY 1
  ```
  ...but the comment promises "stubs for setlocale, getpriority,
  sysconf(_SC_NPROCESSORS_ONLN)". Those would be `static inline`
  shims, not feature-test defines. *Folded: rewrite the comment
  to match — "feature-test macros disabling host detection
  paths; libdrm-KMS only calls those host APIs from error/init
  paths and our wasm sysroot returns ENOSYS where they're
  invoked." If actual stubs are needed (link errors later), add
  them then.*
- **`make -C src/pcm libasound_module_pcm_hw.la 2>/dev/null ||
  true` is vestigial.** The line tries to build a libtool dynamic
  module then ignores failures; the next block explicitly
  rebuilds the static archive from individual .o files. The make
  call achieves nothing except hiding errors from the upstream
  Makefile. *Folded: delete the line. Keep only the `make
  install-headers DESTDIR="$WORK"` step (which is the part that
  actually installs `include/alsa/*.h`) and the wasm32posix-cc
  loop.*
- **`SDL2 deps in B1's package.toml pin `libinput-lite = "0.1.0"`
  but libinput-lite (A6) doesn't declare a version.** Plan-7-
  internal package versions need to match. *Folded: A6's
  `package.toml` declares `version = "0.1.0"`; B1's dep pin then
  matches. Likewise verify alsa-lib's pin (B1 has `"1.2.10"`; A4
  matches via `[source].commit = "1.2.10"` but no explicit
  `version`).*
- **B2's `--disable-libudev` autotools flag's actual SDL 2.30
  configure spelling is `--enable-libudev=no`.** Both forms
  work in modern autotools (the `--disable-X` is sugar for
  `--enable-X=no`), but SDL2 2.30's `configure.ac` uses the
  `--enable-libudev` axis. *Folded as a nit: keep
  `--disable-libudev` (works fine), but document in the commit
  body that this maps to `SDL_USE_LIBUDEV=0` in the cmake-side
  equivalent for future maintainers reading SDL2's docs.*

### Plan 7 open correctness items (do not let these slip)

- **`EVIOCGKEY` / `EVIOCGREP` are missing from plan 5.** SDL2's
  `SDL_EVDEV_AddDevice` calls `ioctl(fd, EVIOCGKEY(sizeof(bits)),
  bits)` to learn the initial held-keys state and `ioctl(fd,
  EVIOCGREP, rep)` for the keyboard auto-repeat rate. Plan 5's
  default-ioctl arm should return ENOTTY (not EINVAL — Linux
  returns ENOTTY for unknown EVIOC* ioctls); SDL2 tolerates
  ENOTTY by treating "no keys held / default repeat" as the
  initial state. **Verify in B5's smoke test that
  `SDL_EVDEV_AddDevice` doesn't fatal-error.** If it does,
  plan 5 needs the two trivial-stub arms added (~10 LoC).
  Cross-plan follow-up note added to plan 5 below.
- **`drm_event_vblank` record size mismatch with libdrm's parser.**
  Plan 4 risk register #2 flags this — SDL2's `drmHandleEvent`
  parses `drm_event_vblank` records read from the card0 fd; the
  record layout must match libdrm 2.4.120's expectation (32-byte
  records on x86_64; smaller on Linux 32-bit). Plan 4 sketches
  24-byte records "verify against upstream"; plan 7's libdrm
  build uses upstream xf86drmMode.c's parser unmodified. *Lean:
  add a libdrm-side static-assert on `sizeof(drm_event_vblank)`
  in A3, and have plan 4's kernel-side record producer match
  libdrm's expectation (probably 32 bytes; plan 4 should adjust
  to match). B3's smoke test fails loudly on mismatch.*
- **`SDL_PauseAudioDevice` semantics + plan 6's per-quantum tick
  AudioContext-suspended start.** Plan 6's lean (c) "start at
  boot" was reconciled to "AudioContext starts suspended; first
  `process()` after user gesture's `resume()`". SDL2's
  `SDL_PauseAudioDevice(dev, 0)` happens before resume in the
  demo — this is fine for the Node host (no autoplay) but
  needs the wpk-host pre-mount `audioCtx.resume()` shim
  (above). *Lean: documented; C3 verification covers.*
- **`SDL_GL_SwapWindow` vblank synchronisation through plan 4.**
  SDL2's KMSDRM `SwapWindow` calls `gbm_surface_lock_front_buffer`
  + `drmModePageFlip` + `drmHandleEvent` to throttle to vblank.
  Plan 4 ships PAGE_FLIP + WAIT_VBLANK + page-flip-event delivery
  through the card0 fd. *Lean: the swap pipeline composes if open-
  architecture #2 (gbm_surface in plan 2) lands. Pre-merge gate:
  B3's smoke test runs `SDL_GL_SwapWindow` 60× and asserts the
  Vitest harness saw 60 PAGE_FLIP ioctls.*

### Plan 7 open architecture items (LOAD-BEARING — pick before SDL2 builds)

- **SDL2 audio thread model.** See inline fix #1. Three options:
  (a) libpthread shim wrapping `clone(CLONE_VM)` + SAB futexes;
  (b) SDL2 patch to a polling audio model; (c) defer SDL2 audio
  to a follow-up plan. Lean: **(a)** if plan 9's wpkcompositor
  also needs threads (likely — Wayland servers spawn worker
  threads for client connections); **(b)** if plans 8–11's seed
  apps can all live without pthreads; **(c)** if neither option
  resolves in time and the milestone-D ship needs to slip
  audio. Decision deadline: before B2's configure flag set
  finalises. Document the choice in PR #2's body.
- **GL stack ownership (libEGL.a + libGLESv2.a static libs +
  `gbm_surface_*` API surface).** See inline fix #2. Plans 2/3
  ship the kernel + host pipework but not the user-space static
  libs SDL2's `-lEGL -lGLESv2 -lgbm` link line wants. The clean
  resolution lives in plan 2/3 (the GL stack is a v2 deliverable,
  not a plan-7 SDL2-specific concern); plan 7 should not absorb
  these into its bundled-shims PR. **Block plan 7 PR #2 merge
  on a plan-2 follow-up PR landing the missing surface.**
  Coordinate via a tracking note in plans 2 + 3's open-
  architecture sections — left to the next session (the user's
  scope this session was plans 4/5/6, not 2/3).

### Missing tests (added to plan 7 review)

- **libEGL.a + libGLESv2.a + libgbm.a-with-gbm_surface present
  in `sysroot/lib/` before B2 runs.** A pre-flight check in B2's
  build.sh: `[ -f $WPK_SYSROOT/lib/libEGL.a ]` or fail-fast with
  "GL stack not landed; see open-architecture #2."
- **SDL2 `SDL_OpenAudioDevice` returns non-zero under the chosen
  audio-thread option (a/b/c).** New Vitest spec
  `sdl2_open_audio.spec.ts`: open device, assert `dev != 0`,
  assert `SDL_GetAudioStatus(dev) == SDL_AUDIO_PLAYING`.
- **`drmModeAtomicCommit` is never called by SDL2 2.30 KMSDRM
  backend.** Smoke test in B3 + grep across SDL2's source — if
  any future SDL2 bump introduces atomic calls, the test fails
  fast.
- **`drm_event_vblank` record size parity.** Add to B3:
  `_Static_assert(sizeof(struct drm_event_vblank) == 32, "match
  libdrm")` against the kernel-side producer (plan 4 follow-up
  if it's currently 24).
- **`EVIOCGKEY` / `EVIOCGREP` graceful-degrade.** Add to B5:
  after `SDL_EVDEV_AddDevice` registers event0, assert no fatal
  in SDL2's error queue (only ENOTTY-tolerated soft warnings).
- **Browser AudioContext pre-resume.** Add to C3's checklist:
  the page's "Run" button calls `audioCtx.resume()` before
  mounting the demo, and the demo's first audio-tick fires
  within 100 ms of mount.
- **`/dev/input/event[2..31]` ENOENT graceful skip.** SDL2's
  scan loop opens event0..event31; only event0 + event1 exist.
  Vitest spy on `open()`: assert no fatal logs on ENOENT
  returns.
- **`SDL_GetCurrentVideoDriver()` returns `"KMSDRM"` (upper
  case).** SDL2 may capitalise differently in 2.30 vs older
  versions; B3 asserts the exact string.
- **alsa-lib `snd_pcm_open("default")` short-circuit
  landing-point pinning.** Add a unit test that grep-asserts the
  A5 patch's `if (strcmp(name, "default") == 0)` arm fires before
  any `snd_config_*` symbol reference in the patched
  `snd_pcm_open_noupdate`.

### Trade-offs verified (eleven — don't relitigate)

- **Three bundled shims, not three sub-plans.** Sound: glue,
  not feature work. Plan 9 wpkcompositor splits libxkbcommon +
  libwayland-server because those are feature-load-bearing.
- **SDL2 2.30 over SDL3.** Sound: stable ABI, broader ecosystem
  as of 2026-05.
- **Compile-time backend trim (KMSDRM + ALSA + evdev only).**
  Sound: matches what we ship; no runtime surprise from a
  dangling x11 probe.
- **`SDL_VIDEODRIVER=kmsdrm` env var as belt+suspenders.**
  Sound: defends against future SDL2 default changes.
- **Three-PR stack (shims → SDL2 → demo) on plan 6's tip.**
  Sound: coordination boundary maps to test-gate boundary.
- **`CLOCK_MONOTONIC` reuse via musl shim.** Sound: A-V-sync
  invariant from plans 4/5/6 preserved.
- **5% per-tick-handler profiling threshold + per-handler (not
  aggregate) gate.** Sound: lower bound triggers OFD-table-split
  refactor focally, not blanket. Published numbers either way.
- **`--disable-render` (saves ~50 KB; demos drive GL directly).**
  Sound: plan 8 wpkdraw is the explicit replacement for non-GL
  apps.
- **`--disable-loadso` (no dlopen).** Sound: matches sysroot
  story; all backends statically linked.
- **alsa-lib subset = hardware-direct only (no config parser, no
  asound.conf, no plugins).** Sound: SDL2's ALSA backend doesn't
  exercise those paths.
- **ABI impact = zero.** Sound: every kernel surface SDL2
  touches is from plans 2–6. `abi/snapshot.json` byte-identical.

### Deliberately not flagged (six)

- **libdrm 2.4.120 vs 2.4.124 (current as of 2026-01).** Minor
  version bump; revisit at impl time if upstream's KMS surface
  shifted. Doesn't affect design.
- **`--disable-haptic --disable-joystick --disable-sensor
  --disable-power --disable-filesystem`.** Already documented
  as out-of-scope deferrals in "What this plan doesn't cover".
- **`Co-Authored-By: Claude` trailer convention.** Locked across
  plans 2–6.
- **"Brandon-style" PR body template.** Locked.
- **Total wasm bundle size (~15 MB for sdl2_demo).** Acceptable
  for v1 per design § runtime envelope; user-program wasms
  aren't part of the kernel bundle.
- **SDL2's internal `pthread_setname_np` / `clock_nanosleep`
  ac_cv_* override list.** Pure mechanical iteration per
  CLAUDE.md cross-compile rule; the actual list is a B2 build-
  error pass, not a design choice.

### Cross-plan amendment to plan 5

`SDL_EVDEV_AddDevice` calls `EVIOCGKEY` and `EVIOCGREP`; plan 5
doesn't implement them. Confirm both fall through to the
default-arm returning **ENOTTY** (Linux's convention for unknown
EVIOC* on a chardev), not EINVAL. If plan 5's current default-arm
returns EINVAL (per the existing inline-fix #292's note that A3
was returning EINVAL where Linux returns ENOTTY for EVIOCGABS),
extend that same fix to EVIOCGKEY + EVIOCGREP — both should
ENOTTY. SDL2 tolerates ENOTTY by treating the queries as "no
state available"; an EINVAL would cause SDL_EVDEV_AddDevice to
log a fatal. Follow-up paragraph appended to plan 5's open-
correctness #292.

### Cross-plan amendment to plan 6

SDL2's `SDL_OpenAudioDevice` spawns `SDL_RunAudio` (in
`src/audio/SDL_audio.c`), which calls `audio_cb` then
`PlayDevice` (`snd_pcm_writei`) in a tight loop. With
`--disable-pthreads`, that thread never starts; the audio
device opens but no callback fires. Plan 6's per-quantum tick
advances `hw_ptr` independently — but without a writer to call
`writei`, the ring stays empty and `process()` reads zeros.
**The thread-driven WRITEI model and plan 7's no-pthread model
are incompatible.** Either plan 6 grows a non-blocking WRITEI +
POLLOUT path that SDL2's audio loop can drive synchronously
from `SDL_PumpAudio`, OR plan 7 picks open-architecture #1
option (a) (libpthread shim). The choice ripples into plan 6's
risk-register: add risk #7 ("SDL2 audio thread requires either
libpthread shim or a SDL2-side polling patch; pre-merge gate
for plan 7 PR #2"). Follow-up paragraph appended to plan 6's
open-architecture section.

### Cross-plan amendment from plan 9's devil's-advocate — audio thread resolution: option (b)

Plan 9's devil's-advocate pass (session 10) **PICKS option (b)
for plan 7's open-architecture #1** (SDL2 audio thread model):
**non-blocking WRITEI + SDL2 polling patch + plan 6 EAGAIN
return arm**. Rationale:

- **Option (a)** (libpthread shim wrapping `clone(CLONE_VM)` +
  SAB futexes) is the heaviest path and benefits only one
  consumer in v1 (SDL2 audio). Plan 9's wpkcompositor was the
  argument for (a) ("Wayland servers spawn worker threads for
  client connections"), but plan 9's compositor is
  single-threaded poll-driven by design — no threads needed.
  No other v1 consumer wants pthreads.
- **Option (c)** (defer SDL2 audio) is a feature regression
  that blocks the SDL2 demo's audio track and pushes the
  ALSA-via-SDL2 path past v1.
- **Option (b)** (~150 LoC SDL2 patch + plan 6 EAGAIN arm) is
  the minimum-friction path that ships audio in v1 without
  introducing the pthread feature gate. Plan 6 already exposes
  the non-blocking + POLLOUT surface; the missing piece is
  `SNDRV_PCM_IOCTL_WRITEI_FRAMES` returning -EAGAIN (not
  -EBUSY) on a full ring, which plan 6's cross-plan amendment
  (added this session) pins.

The SDL2 patch lives under plan 7's Phase B (B2 + B4): patch
`src/audio/SDL_audio.c::SDL_RunAudio` so the audio loop is
driven from `SDL_PumpAudio` (called per main-loop iteration)
instead of from a dedicated `SDL_CreateThread` worker. The
patch is conditional on `SDL_THREADS_DISABLED` so upstream
SDL2 behavior is preserved when pthreads are present; on
wasm32 (where `--disable-pthreads`), the polling path engages.

**Resolution status:** **Option (b) is locked in.** Plan 7's
open-architecture #1 is now CLOSED; the matching open-arch on
plan 7's review (lines 412-423) carries a "resolved by plan 9's
devil's-advocate" pointer added at impl time. Plan 6's
cross-plan amendment from plan 9 (added this session) ships
the EAGAIN arm. Plan 7's B2 configure flag set adds
`--enable-audio-polling` (or the equivalent SDL2 patch). Plan
7 PR #2 can now merge once plan 2 + plan 3 GL stack follow-ups
land (open-arch #2 was already resolved by those follow-ups
in plan 8's devil's-advocate).

### Cross-plan amendment from plan 9's devil's-advocate — KMS-master coexistence

Plan 9's devil's-advocate pass (session 10) caught a missing
note in plan 7's review: **plan 7's SDL2 KMSDRM demo and plan
9's wpkcompositor BOTH call `drmSetMaster` on /dev/dri/card0.**
Plan 4 (lines 403-406 + 1116) enforces one-master-per-card; the
second caller gets EBUSY. The implication: SDL2 KMSDRM demo
and wpkcompositor are MUTUALLY EXCLUSIVE in v1.

Boot ordering invariants:
1. If `/etc/wpk/compositor` exists, init fork-execs the
   compositor at PID 2 BEFORE the user shell exec. SDL2 demos
   started by the shell hit EBUSY on `drmSetMaster` and exit 1
   (the explicit failure path plan 7 B3 documents).
2. If `/etc/wpk/compositor` is ABSENT, init goes straight to
   the user shell. The shell spawns the SDL2 demo, which takes
   master and runs direct-KMS — exactly as plan 7 documents.

The clean path forward is plan 11's `SDL_wpkvideo` backend —
an SDL2 video driver that uses libwpkclient instead of KMSDRM
direct, allowing SDL2 demos to coexist with the compositor.
Plan 11 ships in a later milestone; v1 plan 7 demo is direct-
KMS only.

*Resolution:* note added to plan 7's "Deliberately not flagged"
at impl time: "SDL2 KMSDRM demo (this plan's PR #2 + PR #3) and
wpkcompositor (plan 9) are mutually exclusive in v1 — both call
`drmSetMaster`. Boot ordering: if `/etc/wpk/compositor` exists,
SDL2 demos exit EBUSY. The SDL_wpkvideo demote backend (plan
11) is the post-v1 coexistence path."

No code change in this plan; documentation only. Plan 11's
scope is unaffected.

---

## Phase A — sysroot: bundled userland shims (PR #1)

Three new packages under `examples/libs/` — libdrm-KMS subset, alsa-
lib subset, libinput-lite stub — built into `sysroot/lib/` and
`sysroot/include/`. None of the shims touch kernel code or host
code; they're pure userland glue over plans 2–6's existing ioctl
surfaces.

### Task A1: libdrm-KMS subset — package scaffold

**Files:**
- Create: `examples/libs/libdrm/package.toml` — recipe.
- Create: `examples/libs/libdrm/build.toml` — build state.
- Create: `examples/libs/libdrm/build.sh` — cross-compile script.

**Step 1: Package recipe**

```toml
# examples/libs/libdrm/package.toml
name = "libdrm"
version = "2.4.120"  # latest stable as of 2026-05
license = "MIT"
description = "KMS subset of libdrm — wraps plan 4's DRM_IOCTL_* in libdrm's API"

[source]
type = "git"
url = "https://gitlab.freedesktop.org/mesa/drm.git"
commit = "libdrm-2.4.120"  # pin to the release tag

[deps]
# No external deps — libdrm-KMS subset is self-contained over the
# kernel's DRM ioctl surface, which plans 2–4 already provide.

[build]
script_path = "build.sh"
```

**Step 2: Build state**

```toml
# examples/libs/libdrm/build.toml
script_path = "build.sh"
repo_url = "https://gitlab.freedesktop.org/mesa/drm.git"
commit = "libdrm-2.4.120"
revision = 1

[binary]
index_url = "https://github.com/<repo>/releases/download/binaries-abi-v{abi}/index.toml"
```

**Step 3: Build script (will be expanded in A2)**

```bash
#!/usr/bin/env bash
# examples/libs/libdrm/build.sh
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

# A2 will fill this in with the actual configure + make incantation.
echo "TODO A2: configure + make libdrm-KMS subset"
exit 1
```

**Step 4: Cargo test**

```bash
cargo xtask build-deps resolve libdrm
```

Expected: `package.toml` parsed; build attempted; fails with "TODO
A2". That's OK — A2 wires the real build.

**Step 5: Commit**

```bash
git add examples/libs/libdrm/
git commit -m "sysroot(sdl2-shims): scaffold libdrm package"
```

---

### Task A2: libdrm-KMS subset — actual build

**Files:**
- Modify: `examples/libs/libdrm/build.sh`.

libdrm upstream ships a `meson.build` that configures a lot we don't
need (libdrm_amdgpu, libdrm_radeon, libdrm_intel, libdrm_nouveau,
…). We extract only the KMS-agnostic subset: `xf86drm.c`,
`xf86drmMode.c`, `xf86drmHash.c`, `xf86drmRandom.c`, and the
`include/` headers. We bypass meson entirely (meson + wasm32 +
cross-compile is a known footgun) and build with a hand-rolled
Makefile.

```bash
#!/usr/bin/env bash
# examples/libs/libdrm/build.sh
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"        # cargo xtask passes the cloned source dir
OUT_DIR="$2"        # output dir for libdrm.a + headers
WORK="$OUT_DIR/build"
mkdir -p "$WORK/lib" "$WORK/include/drm" "$WORK/include/libdrm"

# Copy the four KMS-side C files + the headers we need.
for f in xf86drm.c xf86drmMode.c xf86drmHash.c xf86drmRandom.c; do
    cp "$SRC_DIR/$f" "$WORK/"
done
cp -r "$SRC_DIR/include/drm/." "$WORK/include/drm/"
cp "$SRC_DIR/xf86drm.h" "$WORK/include/libdrm/"
cp "$SRC_DIR/xf86drmMode.h" "$WORK/include/libdrm/"

# Build static archive. WPK kernel doesn't ship setlocale,
# getpriority, sysconf(_SC_NPROCESSORS_ONLN); stub via
# -D overrides in xf86drm_compat.h that we create:
cat > "$WORK/include/libdrm/xf86drm_compat.h" <<'EOF'
// Stubs for missing libc surfaces. libdrm only calls these on
// error paths or for niche features (xf86drmHash uses srandom);
// our deterministic stubs return safe defaults.
#define HAVE_SYS_SYSCTL_H 0
#define HAVE_VISIBILITY 1
EOF

cd "$WORK"
wasm32posix-cc -c -O2 -fPIC \
    -I./include -I./include/libdrm -I./include/drm \
    -DHAVE_LIBDRM_ATOMIC_PRIMITIVES=0 \
    -DHAVE_VISIBILITY \
    -include libdrm/xf86drm_compat.h \
    xf86drm.c xf86drmMode.c xf86drmHash.c xf86drmRandom.c

llvm-ar rcs "$OUT_DIR/libdrm.a" \
    xf86drm.o xf86drmMode.o xf86drmHash.o xf86drmRandom.o

# Install headers into sysroot-relative layout.
mkdir -p "$OUT_DIR/include/libdrm" "$OUT_DIR/include/drm"
cp -r "$WORK/include/libdrm/." "$OUT_DIR/include/libdrm/"
cp -r "$WORK/include/drm/." "$OUT_DIR/include/drm/"
```

**Verification:** `cargo xtask build-deps resolve libdrm` succeeds;
produces `$OUT/lib/libdrm.a` (~80 KB) + `$OUT/include/libdrm/{xf86drm.h,
xf86drmMode.h}` + `$OUT/include/drm/{drm.h, drm_mode.h, drm_fourcc.h}`.

**Step 5: Cargo test**

```rust
// crates/xtask/tests/libdrm_resolution.rs
#[test]
fn libdrm_resolves_and_builds() {
    let out = run_resolve("libdrm");
    assert!(out.lib_dir.join("libdrm.a").exists());
    assert!(out.include_dir.join("libdrm/xf86drmMode.h").exists());
}
```

**Step 6: Commit**

```bash
git add examples/libs/libdrm/build.sh
git commit -m "sysroot(sdl2-shims): build libdrm-KMS subset (~80 KB static lib)"
```

---

### Task A3: libdrm-KMS subset — wire to plan 4's ioctl surface

**Files:**
- Modify: `examples/libs/libdrm/build.sh` — patch `xf86drmMode.c`
  with the WPK-specific ioctl overrides if needed.

libdrm's `xf86drmMode.c` calls the kernel via `drmIoctl(fd, request,
&arg)` which is `ioctl(fd, request, arg)`. Our kernel handles these
ioctls per plan 4 A4–A6. **No source patching needed** if plan 4's
ioctl numbers match Linux UAPI verbatim (which they do per plan 4
A1's static-assert against `include/uapi/drm/drm_mode.h`).

The integration verification is: build a tiny test program
(`programs/libdrm_smoke.c`) that calls `drmModeGetResources(fd)`
and `drmModeGetConnector(fd, …)` and prints the result. If plan 4's
ioctl encoded sizes match what libdrm computes from its struct
definitions, the smoke test compiles + runs + prints "1 connector,
1 encoder, 1 crtc" (the v1 single-output setup).

**Smoke test:**

```c
// programs/libdrm_smoke.c
#include <fcntl.h>
#include <stdio.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror("open"); return 1; }

    drmSetMaster(fd);
    drmModeRes *res = drmModeGetResources(fd);
    if (!res) { perror("GetResources"); return 1; }
    printf("connectors=%d encoders=%d crtcs=%d fbs=%d\n",
           res->count_connectors, res->count_encoders,
           res->count_crtcs, res->count_fbs);
    drmModeFreeResources(res);
    drmDropMaster(fd);
    close(fd);
    return 0;
}
```

**Step 1: Build the smoke test**

```bash
wasm32posix-cc -o programs/libdrm_smoke.wasm programs/libdrm_smoke.c -ldrm
```

**Step 2: Vitest**

```ts
// host/test/sdl2-libdrm-smoke.spec.ts
test("libdrm_smoke prints expected resource counts", async () => {
  const { stdout, exitCode } = await runProgram("programs/libdrm_smoke.wasm");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("connectors=1");
  expect(stdout).toContain("crtcs=1");
});
```

**Step 3: Commit**

```bash
git add programs/libdrm_smoke.c host/test/sdl2-libdrm-smoke.spec.ts
git commit -m "sysroot(sdl2-shims): libdrm_smoke — verify libdrm ↔ plan 4 KMS integration"
```

---

### Task A4: alsa-lib subset — package scaffold + build

**Files:**
- Create: `examples/libs/alsa-lib/package.toml`.
- Create: `examples/libs/alsa-lib/build.toml`.
- Create: `examples/libs/alsa-lib/build.sh`.

alsa-lib upstream is ~30k LoC and pulls in a config-file parser
(`~/.asoundrc` / `/etc/asound.conf`), a plugin system (dmix,
softvol, route), and the seq / timer / hwdep subsystems. None of
these are useful to us; SDL2 calls only the PCM hardware-direct
surface. We vendor the upstream source but build only:
`src/pcm/pcm.c`, `src/pcm/pcm_hw.c`, `src/pcm/pcm_misc.c`,
`src/pcm/pcm_params.c`, `src/pcm/pcm_mmap.c`,
`src/control/control.c`, `src/control/control_hw.c`,
`src/error.c`, `src/dlmisc.c` (with `dlopen` stubbed to return
NULL, so the plugin path short-circuits).

```bash
#!/usr/bin/env bash
# examples/libs/alsa-lib/build.sh
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"
OUT_DIR="$2"
WORK="$OUT_DIR/build"
mkdir -p "$WORK/include/alsa"

# Run upstream's configure with explicit overrides for host-feature
# detection misdetections + plugin disable flags.
ac_cv_func_uselocale=no \
ac_cv_func_eventfd=no \
ac_cv_func_clock_gettime=yes \
ac_cv_func_dlopen=no \
"$SRC_DIR/configure" \
    --host=wasm32-unknown-none \
    CC=wasm32posix-cc \
    --prefix="$OUT_DIR" \
    --enable-static --disable-shared \
    --disable-aload --disable-mixer --disable-rawmidi \
    --disable-hwdep --disable-seq --disable-ucm --disable-topology \
    --disable-alisp --disable-old-symbols \
    --without-versioned --without-debug

# Build only the files we want.
cd "$SRC_DIR"
make -C src/pcm libasound_module_pcm_hw.la 2>/dev/null || true
make install-headers DESTDIR="$WORK"

# Manually build the static archive — upstream's libtool dance
# doesn't cross-compile cleanly to wasm32-none.
cd "$WORK"
for f in src/pcm/{pcm,pcm_hw,pcm_misc,pcm_params,pcm_mmap}.c \
         src/control/{control,control_hw}.c \
         src/error.c src/dlmisc.c; do
    wasm32posix-cc -c -O2 -fPIC -I. -Iinclude \
        -DPIC -DHAVE_CONFIG_H \
        "$SRC_DIR/$f" -o "${f//\//_}.o"
done

llvm-ar rcs "$OUT_DIR/lib/libasound.a" *.o
cp -r "$SRC_DIR/include/." "$OUT_DIR/include/alsa/"
```

**Verification:** `cargo xtask build-deps resolve alsa-lib` succeeds;
produces `$OUT/lib/libasound.a` (~600 KB) + headers under
`$OUT/include/alsa/`.

**Smoke test:**

```c
// programs/alsa_lib_smoke.c
#include <alsa/asoundlib.h>
#include <stdio.h>

int main(void) {
    snd_pcm_t *pcm;
    int err = snd_pcm_open(&pcm, "default", SND_PCM_STREAM_PLAYBACK, 0);
    if (err < 0) {
        printf("snd_pcm_open failed: %s\n", snd_strerror(err));
        return 1;
    }
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

**Step 4: Vitest**

Run the smoke test under the centralised kernel; assert exit 0;
assert stdout has "rate=48000".

**Step 5: Commit**

```bash
git add examples/libs/alsa-lib/
git commit -m "sysroot(sdl2-shims): vendor alsa-lib PCM subset (~600 KB static lib)"
```

---

### Task A5: alsa-lib subset — short-circuit `snd_pcm_open("default")`

**Files:**
- Modify: `examples/libs/alsa-lib/build.sh` — add a sed patch.

alsa-lib's `snd_pcm_open("default", …)` normally parses
`/etc/asound.conf` to resolve `"default"` to a real device. We don't
ship asound.conf and don't want the config-parser pulled in. Patch
`src/pcm/pcm.c::snd_pcm_open_noupdate` to fast-path `"default"` to
`"hw:0,0"` (which maps to `/dev/snd/pcmC0D0p` via the hw_open path).

```bash
# In build.sh, before the `wasm32posix-cc -c` loop:
sed -i \
    -e 's|return snd_config_search_definition.*|if (strcmp(name, "default") == 0) name = "hw:0,0";\n    return snd_config_search_definition(root, "pcm", name, \&pcm_conf);|' \
    "$SRC_DIR/src/pcm/pcm.c"
```

(A real patch file would be cleaner; use `git apply` against a
pinned commit. Sketch above for brevity.)

**Verification:** alsa_lib_smoke now opens `/dev/snd/pcmC0D0p` (per
plan 6 A2) on `snd_pcm_open("default", …)`. Check the smoke test's
exit code didn't regress.

**Step 4: Commit**

```bash
git add examples/libs/alsa-lib/patches/
git commit -m "sysroot(sdl2-shims): alsa-lib short-circuits \"default\" to hw:0,0"
```

---

### Task A6: libinput-lite — no-op stub

**Files:**
- Create: `examples/libs/libinput-lite/package.toml`.
- Create: `examples/libs/libinput-lite/build.toml`.
- Create: `examples/libs/libinput-lite/build.sh`.
- Create: `examples/libs/libinput-lite/src/libinput_stub.c`.
- Create: `examples/libs/libinput-lite/include/libinput.h`.

libinput-lite is a stub: SDL2 doesn't link libinput in v1 (we use
SDL2's direct evdev backend), but third-party apps that grep for
`libinput.h` at configure-time get something. The stub returns NULL
from `libinput_udev_create_context` and `libinput_path_create_context`
so callers degrade to whatever fallback they have.

```c
// examples/libs/libinput-lite/src/libinput_stub.c
#include <libinput.h>

struct libinput { int unused; };

struct libinput *libinput_udev_create_context(
    const struct libinput_interface *interface,
    void *user_data, struct udev *udev) {
    (void)interface; (void)user_data; (void)udev;
    return NULL;  // udev path unavailable; caller should degrade
}

struct libinput *libinput_path_create_context(
    const struct libinput_interface *interface, void *user_data) {
    (void)interface; (void)user_data;
    return NULL;  // path-based context unavailable too
}

void libinput_unref(struct libinput *li) { (void)li; }
int libinput_dispatch(struct libinput *li) { (void)li; return 0; }
struct libinput_event *libinput_get_event(struct libinput *li) {
    (void)li; return NULL;
}
```

```c
// examples/libs/libinput-lite/include/libinput.h (minimal)
#ifndef LIBINPUT_H
#define LIBINPUT_H

struct libinput;
struct libinput_event;
struct libinput_interface;
struct udev;

struct libinput *libinput_udev_create_context(
    const struct libinput_interface *interface,
    void *user_data, struct udev *udev);
struct libinput *libinput_path_create_context(
    const struct libinput_interface *interface, void *user_data);
void libinput_unref(struct libinput *li);
int libinput_dispatch(struct libinput *li);
struct libinput_event *libinput_get_event(struct libinput *li);

#endif
```

```bash
# examples/libs/libinput-lite/build.sh
#!/usr/bin/env bash
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"  # actually our own src/ since this isn't vendored
OUT_DIR="$2"
mkdir -p "$OUT_DIR/lib" "$OUT_DIR/include"

wasm32posix-cc -c -O2 -fPIC -I include \
    src/libinput_stub.c -o /tmp/libinput_stub.o
llvm-ar rcs "$OUT_DIR/lib/libinput.a" /tmp/libinput_stub.o
cp include/libinput.h "$OUT_DIR/include/libinput.h"
```

**Verification:** `cargo xtask build-deps resolve libinput-lite`
succeeds; `$OUT/lib/libinput.a` exists (tiny — ~2 KB).

**Step 4: Vitest**

```c
// programs/libinput_stub_smoke.c
#include <libinput.h>
#include <stdio.h>
int main(void) {
    struct libinput *li = libinput_udev_create_context(NULL, NULL, NULL);
    printf("libinput=%p\n", (void *)li);
    return li == NULL ? 0 : 1;  // expect NULL → exit 0
}
```

Vitest: assert exit 0; assert stdout has "libinput=(nil)" or "0x0".

**Step 5: Commit**

```bash
git add examples/libs/libinput-lite/
git commit -m "sysroot(sdl2-shims): libinput-lite no-op stub (forces evdev fallback)"
```

---

### Task A7: Sysroot integration — wire the three shims into the SDK

**Files:**
- Modify: `scripts/fetch-binaries.sh` — add libdrm + alsa-lib +
  libinput-lite to the materialized-symlinks list.
- Modify: `sysroot/activate.sh` — append the new include + lib dirs
  to `WPK_CFLAGS` + `WPK_LDFLAGS` (already covered by the package-
  resolution flow, but verify).

**Step 1: Run**

```bash
scripts/fetch-binaries.sh --allow-stale
```

Verify `sysroot/lib/libdrm.a`, `sysroot/lib/libasound.a`,
`sysroot/lib/libinput.a` symlinks land under the consumer-facing
sysroot. Verify `sysroot/include/libdrm/xf86drmMode.h` etc. are
reachable from `wasm32posix-cc`'s default include path.

**Step 2: Smoke**

Rebuild `programs/libdrm_smoke.wasm`, `programs/alsa_lib_smoke.wasm`,
`programs/libinput_stub_smoke.wasm` and confirm they all link +
run cleanly under Vitest.

**Step 3: Commit**

```bash
git add scripts/fetch-binaries.sh
git commit -m "sysroot(sdl2-shims): wire libdrm + alsa-lib + libinput-lite into sysroot"
```

---

### Task A8: Phase A — full gauntlet + open PR #1

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

(ABI snapshot expected unchanged — this PR ships no kernel or
shared-ABI code.)

Push, open draft PR.

Title: `[explore-dri] sysroot(sdl2-shims): libdrm-KMS + alsa-lib subset + libinput-lite stub`

Body (Brandon style):

```markdown
## Summary
- Vendor libdrm 2.4.120 KMS subset (~80 KB) as
  `examples/libs/libdrm/` — wraps plan 4's `DRM_IOCTL_MODE_*`
  in libdrm's `drmModeGetResources` / `drmModeAddFB2` /
  `drmModePageFlip` API.
- Vendor alsa-lib PCM subset (~600 KB) as
  `examples/libs/alsa-lib/` — wraps plan 6's `SNDRV_PCM_IOCTL_*`
  in alsa-lib's `snd_pcm_open` / `snd_pcm_writei` API. No config
  parser, no plugins; `snd_pcm_open("default")` short-circuits to
  `hw:0,0` → `/dev/snd/pcmC0D0p`.
- New `examples/libs/libinput-lite/` — 200-LoC no-op stub so
  third-party apps that link `-linput` don't fail link-time but
  degrade to the SDL2 direct-evdev path.
- Three smoke tests (`libdrm_smoke`, `alsa_lib_smoke`,
  `libinput_stub_smoke`) under `programs/` + matching Vitest
  specs prove each shim talks to its kernel surface correctly.

## Why
Plan 7 of the DRI v2 design — milestone D (SDL2 port). SDL2's
KMSDRM video backend wants libdrm; its ALSA audio backend wants
alsa-lib; both are too much code to write from scratch but too
much to port whole. We vendor minimal subsets that wrap plans 4 +
6's existing ioctl surfaces. libinput-lite is the third stub so
the link-time surface is complete; SDL2's evdev backend handles
the actual input path without libinput.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`
- Three new smoke programs link + run under the centralised kernel.

## ABI impact
None — sysroot-only addition. No kernel exports, no host imports,
no new ioctls or device nodes, no shared-ABI struct changes.
`abi/snapshot.json` is byte-identical.

## Notes
- libdrm subset only ships the four KMS-side files (`xf86drm.c`,
  `xf86drmMode.c`, `xf86drmHash.c`, `xf86drmRandom.c`); no
  libdrm_amdgpu / libdrm_radeon / etc.
- alsa-lib subset disables `--enable-aload --enable-mixer
  --enable-rawmidi --enable-hwdep --enable-seq --enable-ucm
  --enable-topology --enable-alisp`. `--without-versioned`
  matches our flat-namespace ABI.
- libinput-lite is a deliberate stub — when plan 9's wpkcompositor
  needs real libinput for gesture / palm rejection, it ports the
  real library as a separate sub-plan and replaces this stub.
```

**Do not merge.**

---

## Phase B — sysroot: vendor SDL2 + cross-compile + backend wiring (PR #2)

### Task B1: SDL2 package scaffold

**Files:**
- Create: `examples/libs/sdl2/package.toml`.
- Create: `examples/libs/sdl2/build.toml`.
- Create: `examples/libs/sdl2/build.sh` (stub for now).

```toml
# examples/libs/sdl2/package.toml
name = "sdl2"
version = "2.30.0"
license = "Zlib"
description = "SDL2 cross-platform multimedia library, KMSDRM + ALSA + evdev backends"

[source]
type = "git"
url = "https://github.com/libsdl-org/SDL.git"
commit = "release-2.30.0"

[deps]
# B5 fills these in
libdrm = "2.4.120"
alsa-lib = "1.2.10"
libinput-lite = "0.1.0"

[build]
script_path = "build.sh"
```

**Commit:** `sysroot(sdl2): scaffold SDL2 package + dep manifest`

---

### Task B2: SDL2 configure flags — backend selection at compile time

**Files:**
- Modify: `examples/libs/sdl2/build.sh`.

SDL2's configure scans for available backends and includes whichever
it finds. We want a tight bill of backends: KMSDRM video, ALSA
audio, evdev input. Everything else off.

```bash
#!/usr/bin/env bash
# examples/libs/sdl2/build.sh
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"
OUT_DIR="$2"
WORK="$OUT_DIR/build"
mkdir -p "$WORK"
cd "$WORK"

# Cross-compile overrides per CLAUDE.md "Cross-Compilation and
# Configure Scripts" rule — disable host-detected functions not
# in our wasm sysroot.
ac_cv_func_feenableexcept=no \
ac_cv_func_pthread_setname_np=no \
ac_cv_func_clock_nanosleep=no \
ac_cv_func_getpriority=no \
ac_cv_func_setpriority=no \
ac_cv_func_mprotect=no \
ac_cv_func_posix_madvise=no \
"$SRC_DIR/configure" \
    --host=wasm32-unknown-none \
    --prefix="$OUT_DIR" \
    --enable-static --disable-shared \
    \
    --enable-video --enable-video-kmsdrm \
    --disable-video-x11 --disable-video-wayland \
    --disable-video-vivante --disable-video-cocoa \
    --disable-video-directfb --disable-video-dummy=no \
    --disable-video-offscreen \
    --enable-video-opengl --enable-video-opengles2 \
    \
    --enable-audio --enable-alsa --disable-alsa-shared \
    --disable-pulseaudio --disable-jack --disable-pipewire \
    --disable-sndio --disable-oss --disable-arts --disable-esd \
    --disable-nas --disable-fusionsound \
    \
    --enable-events --enable-input-events \
    --disable-libudev \
    --enable-input-tslib=no \
    \
    --disable-haptic --disable-joystick --disable-sensor \
    --disable-power --disable-filesystem --disable-loadso \
    --disable-render --disable-render-d3d \
    --disable-test --disable-rpath \
    \
    --disable-pthreads --disable-pthread-sem \
    CC=wasm32posix-cc

make -j$(nproc) V=1
make install
```

Notes on the disabled flags:
- `--disable-video-x11 --disable-video-wayland` — neither
  shipped in v1; forces SDL2 to skip those backends at
  `SDL_VIDEODRIVER` probe time. Combined with our `SDL_VIDEODRIVER=
  kmsdrm` env var (set at runtime by the demo), KMSDRM is the
  unambiguous selection.
- `--disable-pulseaudio --disable-jack --disable-pipewire` etc. —
  the audio fallback chain is ALSA only.
- `--disable-libudev` — forces SDL2's evdev path to use the
  scan-and-open fallback (`SDL_evdev.c::SDL_EVDEV_Init` falls
  through to opening `/dev/input/event[0-31]` directly when
  `SDL_USE_LIBUDEV` is undefined).
- `--disable-pthreads` — our libc has no POSIX threads in v1
  (`pthread_create` returns ENOSYS). SDL2 ships a `SDL_thread`
  emulation that uses fibers / stub-threads; v1 doesn't need
  real concurrency.
- `--disable-loadso` — no `dlopen`; SDL2 statically links
  everything. (alsa-lib in A4 also stubbed `dlopen` to NULL.)
- `--disable-render` — SDL2's 2D render API isn't needed for
  v1's demos; we drive GL directly. Saves ~50 KB of static lib.

**Step 4: Cargo test**

```bash
cargo xtask build-deps resolve sdl2
```

Expected: SDL2 source clones; configure runs without errors; make
runs; first failure pass identifies missing `ac_cv_*=no` overrides.
Iterate until build succeeds; document the final override list in
the commit body.

**Step 5: Commit**

```bash
git add examples/libs/sdl2/build.sh
git commit -m "sysroot(sdl2): SDL2 configure — KMSDRM + ALSA + evdev only, no udev"
```

---

### Task B3: SDL2 — KMSDRM backend smoke test

**Files:**
- Create: `programs/sdl2_kmsdrm_smoke.c`.

```c
// programs/sdl2_kmsdrm_smoke.c
#include <SDL2/SDL.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    setenv("SDL_VIDEODRIVER", "kmsdrm", 1);

    if (SDL_Init(SDL_INIT_VIDEO) < 0) {
        printf("SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }
    const char *driver = SDL_GetCurrentVideoDriver();
    printf("video driver: %s\n", driver ? driver : "(none)");

    SDL_Window *win = SDL_CreateWindow(
        "wpk-sdl-smoke", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
        320, 240, SDL_WINDOW_OPENGL);
    if (!win) {
        printf("SDL_CreateWindow failed: %s\n", SDL_GetError());
        return 1;
    }
    printf("window created\n");
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
```

**Vitest:** assert exit 0; stdout has "video driver: KMSDRM" and
"window created".

If the test fails: probably plan 4's `DRM_IOCTL_MODE_GETRESOURCES`
returns something SDL2 doesn't expect; check
`SDL_kmsdrmvideo.c::KMSDRM_VideoInit` for what it's reading.

**Commit:** `sysroot(sdl2): sdl2_kmsdrm_smoke — KMSDRM backend probe + window create`

---

### Task B4: SDL2 — ALSA backend smoke test

**Files:**
- Create: `programs/sdl2_alsa_smoke.c`.

```c
// programs/sdl2_alsa_smoke.c
#include <SDL2/SDL.h>
#include <stdio.h>
#include <math.h>

static double phase = 0.0;

static void audio_cb(void *user, Uint8 *stream, int len) {
    (void)user;
    int16_t *out = (int16_t *)stream;
    int frames = len / 4;  // S16_LE stereo
    for (int f = 0; f < frames; f++) {
        int16_t s = (int16_t)(sin(phase) * 8000);
        out[f * 2 + 0] = s;
        out[f * 2 + 1] = s;
        phase += 2.0 * 3.14159265 * 440.0 / 48000.0;
    }
}

int main(void) {
    if (SDL_Init(SDL_INIT_AUDIO) < 0) {
        printf("SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }
    SDL_AudioSpec want = {0}, have = {0};
    want.freq = 48000; want.format = AUDIO_S16LSB;
    want.channels = 2; want.samples = 1024;
    want.callback = audio_cb;
    SDL_AudioDeviceID dev = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (!dev) {
        printf("SDL_OpenAudioDevice failed: %s\n", SDL_GetError());
        return 1;
    }
    printf("audio: freq=%d channels=%d samples=%d\n",
           have.freq, have.channels, have.samples);
    SDL_PauseAudioDevice(dev, 0);  // start
    SDL_Delay(500);  // 0.5 s of sine
    SDL_PauseAudioDevice(dev, 1);  // stop
    SDL_CloseAudioDevice(dev);
    SDL_Quit();
    return 0;
}
```

**Vitest:** assert exit 0; stdout has "freq=48000 channels=2".

This is the "HW_REFINE wildcard probe" exercise the design doc
called out. `SDL_OpenAudioDevice` ends up calling
`snd_pcm_hw_params_set_rate_near(pcm, hw, 48000)` with a wildcard
request; alsa-lib funnels to `SNDRV_PCM_IOCTL_HW_REFINE`; plan 6's
HW_REFINE clamps to its supported [48000, 48000] range; the call
returns 48000; SDL2 commits.

**Commit:** `sysroot(sdl2): sdl2_alsa_smoke — ALSA backend probe + 0.5 s sine`

---

### Task B5: SDL2 — evdev backend smoke test

**Files:**
- Create: `programs/sdl2_evdev_smoke.c`.

```c
// programs/sdl2_evdev_smoke.c
#include <SDL2/SDL.h>
#include <stdio.h>

int main(void) {
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) < 0) {
        printf("SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }
    SDL_Window *win = SDL_CreateWindow(
        "evdev-smoke", 0, 0, 320, 240, SDL_WINDOW_OPENGL);
    if (!win) return 1;

    // Inject a fake key event from the test harness (Vitest spy on
    // kernel_input_event); we expect SDL2 to deliver a
    // SDL_KEYDOWN with sym = SDLK_a, then SDL_QUIT.
    SDL_Event ev;
    int got_key = 0;
    for (int i = 0; i < 100 && !got_key; i++) {
        if (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_KEYDOWN && ev.key.keysym.sym == SDLK_a) {
                printf("got SDLK_a\n");
                got_key = 1;
            }
        }
        SDL_Delay(10);
    }
    SDL_DestroyWindow(win);
    SDL_Quit();
    return got_key ? 0 : 1;
}
```

**Vitest:** start the smoke program; from the test harness, call
`kernel_input_event(0, EV_KEY, KEY_A, 1)` via the host's kernel
exports; assert the program exits 0 and stdout has "got SDLK_a".

This exercises:
- SDL2's `SDL_EVDEV_Init` scan-and-open path (it walks event[0-31]
  and finds event0 + event1 from plan 5);
- SDL2's evdev key-code → SDLK_* translation table — verify
  KEY_A maps to SDLK_a;
- the kernel's `kernel_input_event` → SAB ring → userspace
  `read()` → SDL2's `EVDEV_Poll` loop.

If the test fails on the scan side: SDL2 might be checking for a
`/dev/input/by-id/` directory that we don't synthesise. Plan 5
might need a follow-up to add `by-id/` symlinks (small change).

**Commit:** `sysroot(sdl2): sdl2_evdev_smoke — scan-and-open path + KEY_A round-trip`

---

### Task B6: Phase B — full gauntlet + open PR #2

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

Push, open draft PR.

Title: `[explore-dri] sysroot(sdl2): vendor SDL2 2.30.0 + cross-compile + backend wiring`

Body (Brandon style):

```markdown
## Summary
- Vendor SDL2 2.30.0 as `examples/libs/sdl2/`.
- Configure with KMSDRM video + ALSA audio + evdev input only;
  every other backend disabled. `SDL_USE_LIBUDEV=0` forces the
  scan-and-open fallback for input device enumeration.
- Three smoke programs (`sdl2_kmsdrm_smoke`, `sdl2_alsa_smoke`,
  `sdl2_evdev_smoke`) per-backend verify each surface from
  SDL2 → shim → kernel.
- `ac_cv_*=no` override list per CLAUDE.md cross-compile rule —
  documented in commit body.

## Why
Plan 7 of the DRI v2 design — milestone D. SDL2 is the first
application library that exercises plans 4 (KMS), 5 (input), and
6 (audio) under a real API surface. Once SDL2 builds + the three
smoke tests pass, the rest of the platform (wpkdraw / wpkcompositor
/ seed apps in plans 8–11) can build on top.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run` (three new sdl2-* spec files)
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

## ABI impact
None — SDL2 talks to the kernel only through ioctls + mmap +
read/write already defined by plans 4–6. `abi/snapshot.json`
byte-identical.

## Notes
- `SDL_VIDEODRIVER=kmsdrm` set at runtime by each demo (the
  smoke programs all set it before SDL_Init) — even with x11 +
  wayland compiled out, KMSDRM is the only driver SDL2 finds,
  but setting the env var explicitly is the documented way and
  defends against future configure default changes.
- SDL2's `pthread_create` shim returns ENOSYS in v1; SDL2's
  internal thread usage is for audio callback (fine — runs on
  the kernel-driven audio thread) and event-loop (SDL2 falls
  back to a polling main loop).
- libinput-lite stub returns NULL from `libinput_udev_create_context`;
  SDL2's evdev path skips libinput entirely (`--disable-libudev`
  also disables the udev probe).
- See cross-plan note in plan 6's review re: PROCESS_TABLE lock
  contention — Phase C profiling (in PR #3) is the gate.
```

**Do not merge until PR #1 (shims) is merged into this PR's base.**

---

## Phase C — examples: demo + browser verify + lock-contention profiling gate (PR #3)

### Task C1: `sdl2_demo.c` — combined video + audio + input demo

**Files:**
- Create: `programs/sdl2_demo.c`.

```c
// programs/sdl2_demo.c — ~250 LoC
// A 320×240 spinning OpenGL ES 2.0 quad rendered via SDL2's KMSDRM
// backend; a continuous 440 Hz tone via SDL2's ALSA backend; ESC
// exits via SDL2's evdev backend.

#define _GNU_SOURCE
#include <SDL2/SDL.h>
#include <SDL2/SDL_opengles2.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

// ----- Audio: continuous sine generator -----
static double audio_phase = 0.0;
static void audio_cb(void *user, Uint8 *stream, int len) {
    (void)user;
    int16_t *out = (int16_t *)stream;
    int frames = len / 4;
    for (int f = 0; f < frames; f++) {
        int16_t s = (int16_t)(sin(audio_phase) * 4000);
        out[f * 2 + 0] = s;
        out[f * 2 + 1] = s;
        audio_phase += 2.0 * 3.14159265 * 440.0 / 48000.0;
    }
}

// ----- Video: GLES2 vertex/fragment shaders for the quad -----
static const char *VERT_SRC =
    "attribute vec2 a_pos;\n"
    "uniform float u_angle;\n"
    "void main() {\n"
    "  float c = cos(u_angle), s = sin(u_angle);\n"
    "  gl_Position = vec4(c*a_pos.x - s*a_pos.y, "
    "                     s*a_pos.x + c*a_pos.y, 0, 1);\n"
    "}\n";
static const char *FRAG_SRC =
    "precision mediump float;\n"
    "uniform float u_t;\n"
    "void main() {\n"
    "  gl_FragColor = vec4(0.5+0.5*sin(u_t), 0.5, 0.5, 1.0);\n"
    "}\n";

static GLuint compile_shader(GLenum type, const char *src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    return s;
}

int main(void) {
    setenv("SDL_VIDEODRIVER", "kmsdrm", 1);
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_EVENTS) < 0) {
        printf("SDL_Init: %s\n", SDL_GetError());
        return 1;
    }

    // Video setup.
    SDL_Window *win = SDL_CreateWindow(
        "sdl2_demo", 0, 0, 320, 240, SDL_WINDOW_OPENGL);
    SDL_GLContext gl = SDL_GL_CreateContext(win);
    SDL_GL_MakeCurrent(win, gl);

    GLuint prog = glCreateProgram();
    glAttachShader(prog, compile_shader(GL_VERTEX_SHADER, VERT_SRC));
    glAttachShader(prog, compile_shader(GL_FRAGMENT_SHADER, FRAG_SRC));
    glLinkProgram(prog);
    glUseProgram(prog);

    float quad[8] = { -0.5,-0.5, 0.5,-0.5, -0.5,0.5, 0.5,0.5 };
    GLuint vbo; glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);
    GLint a_pos = glGetAttribLocation(prog, "a_pos");
    glVertexAttribPointer(a_pos, 2, GL_FLOAT, GL_FALSE, 0, NULL);
    glEnableVertexAttribArray(a_pos);
    GLint u_angle = glGetUniformLocation(prog, "u_angle");
    GLint u_t = glGetUniformLocation(prog, "u_t");

    // Audio setup.
    SDL_AudioSpec want = {0}, have = {0};
    want.freq = 48000; want.format = AUDIO_S16LSB;
    want.channels = 2; want.samples = 1024;
    want.callback = audio_cb;
    SDL_AudioDeviceID audio = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    SDL_PauseAudioDevice(audio, 0);

    // Main loop — 5 s timeout or ESC.
    Uint32 start = SDL_GetTicks();
    int running = 1;
    while (running && SDL_GetTicks() - start < 5000) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) running = 0;
            if (ev.type == SDL_KEYDOWN && ev.key.keysym.sym == SDLK_ESCAPE)
                running = 0;
        }
        float t = (SDL_GetTicks() - start) / 1000.0f;
        glUniform1f(u_angle, t);
        glUniform1f(u_t, t * 2.0f);
        glClearColor(0.1f, 0.1f, 0.1f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
        SDL_GL_SwapWindow(win);
    }

    SDL_PauseAudioDevice(audio, 1);
    SDL_CloseAudioDevice(audio);
    SDL_GL_DeleteContext(gl);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
```

Build via `wasm32posix-cc -o programs/sdl2_demo.wasm
programs/sdl2_demo.c -lSDL2 -ldrm -lasound -linput -lm -lEGL -lGLESv2`.

**Commit:** `examples(sdl2): sdl2_demo — combined video + audio + input demo`

---

### Task C2: Vitest end-to-end

**Files:**
- Create: `host/test/sdl2-demo.spec.ts`.

Runs `sdl2_demo.wasm` under the centralised kernel + NodeAudioDriver
+ NullInputSource; asserts:
- the demo exits 0 within 6 s (5 s runtime + 1 s margin);
- the host's `host_kms_set_fb` was called ~300 times (60 Hz × 5 s);
- the audio SAB contains non-silent samples;
- no kernel-side panics or fd leaks (existing harness check).

Then re-run with an injected ESC key event at t=2 s:
- assert demo exits 0 within 3 s;
- assert `host_kms_set_fb` count is ~120 (60 Hz × 2 s).

**Commit:** `host(sdl2): vitest — sdl2_demo end-to-end (timeout + ESC paths)`

---

### Task C3: Manual browser verification (the gate)

CLAUDE.md item 6. Build the demo, wire into `examples/browser/pages/
sdl2/`. The browser page mounts an `<iframe>` with the same
cross-origin-isolation headers `./run.sh browser` already sets;
clicking "Run" spawns the kernel, mounts the demo, and:
- a 320×240 canvas displays the spinning coloured quad for 5 s;
- a 440 Hz tone is audible (after the user-gesture autoplay
  unmute);
- pressing ESC quits early.

If the demo quits but the canvas is blank: plan 4's
`MODE_SETCRTC` path probably isn't wired to plan 2's gbm_bo, or
the EGL surface isn't binding to the right `gbm_surface`. Check
the browser console for any `EGL_*` errors.

If audio is silent but canvas works: plan 6's `kernel_audio_alloc_ring`
binding to the AudioWorklet's SAB-view probably isn't taking
effect — re-verify the per-quantum tick is firing in the worklet's
debug output.

If pressing keys does nothing: plan 5's DOM listener probably
isn't routing to the kernel — check `examples/browser/lib/
browser-kernel.ts`'s `kernel_input_event` invocations.

**No commit yet for this task — verification only.**

---

### Task C4: Phase C — PROCESS_TABLE lock-contention profiling gate

**Files:**
- Create: `benchmarks/suites/sdl2-lock-contention.ts` — custom
  suite that runs `sdl2_demo.wasm` and measures per-tick-handler
  wall-time breakdowns.

This is the gate from plan 6's cross-plan amendment + plan 4's
open-architecture #2 (carried through plans 5 + 6). Drive the SDL2
demo at peak load (continuous key-input via NullInputSource fake
events at 1000 Hz + audio + vblank); measure wall-time on each
tick handler's `PROCESS_TABLE.lock()` acquire vs body.

```ts
// benchmarks/suites/sdl2-lock-contention.ts
import { runBenchmark } from "../runner";

export const sdl2LockContention = {
  name: "sdl2-lock-contention",
  prerequisites: ["programs/sdl2_demo.wasm"],
  run: async (host) => {
    // Inject 1000 fake key events / sec for 5 s; measure
    // tick-handler wall-time.
    const stats = await runWithProfiling(host, "programs/sdl2_demo.wasm", {
      injectKeyHz: 1000,
      audioPcmHz: 375,  // per-quantum
      vblankHz: 60,
      durationSec: 5,
    });
    return {
      input_lock_percent: stats.input_lock_us / stats.input_total_us,
      audio_lock_percent: stats.audio_lock_us / stats.audio_total_us,
      vblank_lock_percent: stats.vblank_lock_us / stats.vblank_total_us,
    };
  },
};
```

**Gate:** PR body must include the measured percentages. If any of
the three exceeds 5%, the OFD-table-split refactor (plan 4
open-architecture #2) lands as a focused inter-plan PR BEFORE
this PR merges. Do not push the merge button if the gate fails —
ask Brandon to confirm the refactor PR is in flight.

If the gate passes (all three < 5%): document the baseline numbers
in the PR body as "OFD-table-split deferred per measured baseline;
re-measure on plan 7's tip when wpkcompositor lands."

**Commit:** `examples(sdl2): benchmarks suite — sdl2-lock-contention profiling gate`

---

### Task C5: Phase C — final gauntlet + open PR #3

PR title: `[explore-dri] examples(sdl2): sdl2_demo + browser spec + Phase C profiling gate`

Body (Brandon style):

```markdown
## Summary
- New `programs/sdl2_demo.c` — 320×240 spinning quad via KMSDRM +
  440 Hz sine via ALSA + ESC-to-quit via evdev. The smallest "real"
  SDL2 app exercising plans 2 + 3 + 4 + 5 + 6 simultaneously.
- New Vitest spec verifies the demo runs cleanly under
  NodeKernelHost + NodeAudioDriver + NullInputSource (timeout
  and ESC paths).
- New `benchmarks/suites/sdl2-lock-contention.ts` profiles
  PROCESS_TABLE acquisition rate per tick handler under peak load.
- Manual browser verification: canvas + audio + ESC quit
  confirmed in Chromium + Firefox.

## Why
Plan 7 of the DRI v2 design — milestone D. This PR closes the
loop on plans 4 + 5 + 6: SDL2's KMSDRM + ALSA + evdev backends
all drive the kernel under a real application workload (a tiny
one, but real). Validates the end-to-end design before plans 8
(wpkdraw) + 9 (wpkcompositor) + 10 (shell) + 11 (seed apps) build
on top.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`
- Manual browser verification: demo runs cleanly (5 s timeout +
  ESC quit confirmed on Chromium 120 + Firefox 122).
- **Profiling gate:** PROCESS_TABLE lock contention measured at
  input=X.X%, audio=Y.Y%, vblank=Z.Z% — all under 5% (or:
  contention exceeded; OFD-table-split refactor merged as
  PR #NNN before this PR).

## Dual-host parity proof
SDL2 demo runs identically on Node.js (Vitest spec) and Chromium /
Firefox (manual). Per-backend smoke tests in PR #2 already cover
each surface; the demo in this PR is the integration test.

## ABI impact
None — entirely an examples + benchmarks addition. No kernel,
host, or sysroot changes.

## Notes
- The demo sets `SDL_VIDEODRIVER=kmsdrm` at runtime — defensive
  even with x11/wayland compiled out, per the design doc.
- libinput-lite returns NULL from `libinput_udev_create_context`
  per Phase A; SDL2's evdev scan-and-open path handles input.
- 5 s demo runtime is the smallest interval that drives the
  full vblank + audio period cycle without the run-time tail
  dominating the benchmark.
- Profiling gate numbers published in PR body for baseline /
  future-regression catching even if the gate passes.
```

**Do not merge until PR #2 (SDL2 vendor) is merged into this PR's
base AND the profiling gate's "decision" is documented in the PR
body.**

---

## Final coordinated merge

When all three PRs (shims, sdl2-port, sdl2-demo) are reviewed and
approved, the browser demo runs cleanly, and the profiling gate's
decision is recorded:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 → PR #2's base.
3. Squash-merge PR #2 → PR #3's base.
4. Squash-merge PR #3 → plan 6's `…-alsa-demo` (or wherever plan
   6's tip lives at the time).
5. Tag: `[explore-dri-sdl2] milestone D merged at <sha>` in the
   next session-handoff doc.
6. **If the profiling gate failed and the OFD-table-split refactor
   landed:** add a follow-up "post-refactor re-measurement" task
   to the next session-handoff doc; re-run the profiling suite on
   the post-merge tip and publish updated numbers.

**Do not push to upstream until v1 + plans 2–7 are all merged
upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **Three bundled shims, not three sub-plans.** libdrm + alsa-lib +
  libinput-lite are userland glue with no independent feature
  surface; bundling keeps the dependency tight (PR #1's diff is
  one coherent change). Plan 9's wpkcompositor will get separate
  sub-plans for libxkbcommon + libwayland-server because those
  add independently load-bearing functionality (keymap
  translation + Wayland protocol parsing).
- **SDL2 2.30.0 (not SDL3).** v3 has a different ABI and (as of
  2026-05) less ecosystem deployment; v2 is in long-term-maintenance
  but is what every app in scope (plans 8–11) is written against.
- **`SDL_USE_LIBUDEV=0` at compile time + libinput-lite stub.**
  SDL2's evdev scan-and-open fallback (`SDL_evdev.c::SDL_EVDEV_Init`
  walks `/dev/input/event[0-31]` directly when udev isn't available)
  works without udev. Real libinput is post-v1.
- **Backends compiled-in: KMSDRM + ALSA + evdev only.** Every
  other SDL2 backend is `--disable-*`'d at configure time. SDL_VIDEODRIVER
  env var is set defensively but not load-bearing.
- **`SDL_VIDEODRIVER=kmsdrm` set by every demo's main().** Belt +
  suspenders — even with X11/Wayland compiled out, the env var
  guards against future SDL2 default changes.
- **SDL2 pthread disabled; SDL_thread is a fiber stub.** Our libc
  has no POSIX threads in v1; SDL2's emulation suffices for v1's
  workloads (audio callback on a kernel-driven thread; event-loop
  is polled, not pumped from a worker).
- **`--disable-loadso`.** No `dlopen`; SDL2 statically links all
  backends. Matches our sysroot story (no .so loader in libc).
- **`--disable-render`.** SDL2's 2D render abstraction isn't
  needed for v1 demos (they drive GL directly). Saves ~50 KB.
- **No SDL2 test suite, no SDL2 examples.** `--disable-test`;
  upstream's test programs aren't part of the v1 deliverable.
- **alsa-lib subset is hardware-direct only.** No config parser,
  no plugins, no `~/.asoundrc` reading. `snd_pcm_open("default")`
  hard-coded to `hw:0,0`. SDL2's ALSA backend doesn't need
  anything else.
- **`CLOCK_MONOTONIC` pinned via the existing musl shim** — SDL2's
  `SDL_GetTicks` already routes through `clock_gettime`; no
  change. Cross-stream A-V-sync invariant from plans 4/5/6
  preserved.
- **Profiling gate is per-tick-handler, not aggregate.** If only
  the input handler exceeds 5%, the input path's OFD-table-split
  is the targeted refactor; same for audio / vblank. The gate's
  threshold (5%) is the design-team's lean — lower threshold
  means more refactors deferred to plan 8; higher means worse
  latency tail under load.
- **No host imports, no kernel exports, no new ioctls.** Plan 7 is
  the first plan in the chain that adds zero kernel-userland ABI
  surface. The entire diff is sysroot + examples + benchmarks.

---

## Risk register

1. **SDL2's configure misdetections on cross-compile.** SDL2's
   `configure` has ~200 `AC_CHECK_FUNC` calls; some will detect
   host-OS functions that don't exist in our wasm sysroot.
   *Mitigation:* iterate `ac_cv_*=no` overrides via build-error
   pass (B2 budget). Document the final override list in the PR
   body so future SDL2 version bumps know what to keep.
2. **SDL2's KMSDRM backend expects `drmModeAtomicCommit`.** Plan 4
   ships legacy `MODE_SETCRTC` + page-flip only; SDL2 should
   gracefully fall back if `DRM_CLIENT_CAP_ATOMIC` returns EINVAL
   on enable. *Mitigation:* B3's smoke test catches this; if SDL2
   hangs at init, the `SDL_KMSDRMVideoData::has_kms_atomic` path
   probably isn't falling back correctly — patch SDL2 to force
   the legacy path. (~10 LoC change in `SDL_kmsdrmvideo.c`.)
3. **SDL2 evdev scan-and-open might miss `/dev/input/by-id/`.**
   SDL2's `SDL_evdev.c::SDL_EVDEV_Init` walks both `/dev/input/
   event*` and `/dev/input/by-id/*` if available. Plan 5 ships
   neither `by-id/` nor `by-path/`. *Mitigation:* SDL2 tolerates
   missing `by-id/`; the scan-and-open path on event[0-31] alone
   should work. If not, plan 5 follow-up adds a synthetic
   `by-id/` symlink dir (~30 LoC in devfs.rs, doesn't change
   ABI).
4. **Profiling gate threshold (5%) might be too tight or too
   loose.** *Mitigation:* publish the measured numbers regardless
   of pass/fail; reviewers can challenge the threshold during
   PR #3 review based on the actual data.
5. **alsa-lib's `snd_pcm_open("default")` short-circuit patch
   might break across alsa-lib versions.** *Mitigation:* pin to
   1.2.10; if upstream changes the call shape, the patch needs a
   rewrite (caught at build time by the smoke test).
6. **EGL surface creation through libgbm requires plans 2 + 3's
   bo/EGL surfaces to be in shape.** *Mitigation:* B3 smoke test
   catches this; if it fails at `SDL_GL_CreateContext`, the EGL
   ↔ gbm bridge isn't wired in plan 2 (or 3); diagnose and
   either patch plans 2/3 or the SDL2 backend. Pre-merge gate.
7. **AudioContext autoplay-policy + SDL2's auto-init mismatch.**
   SDL2 calls `SDL_OpenAudioDevice` and expects audio to play
   immediately. Browser AudioContext starts suspended; until user
   gesture, no `process()` fires. *Mitigation:* demo wires a
   "Run" button on the browser page that calls a tiny WPK shim
   to call `audioCtx.resume()` before launching the SDL2 demo.
   Browser-only concern; Node has no autoplay gate.
8. **libdrm + alsa-lib + SDL2 binary sizes blow out the kernel
   wasm.** Total ~5 MB additional static lib + ~10 MB SDL2; the
   wasm bundle for sdl2_demo might be ~15 MB. *Mitigation:* the
   binaries are user programs (separate wasm files), not part of
   the kernel wasm; bundle size only matters for the browser
   demo's load time. Acceptable for v1.

---

## What this plan doesn't cover (deferred)

- **SDL2 game controllers** (`SDL_INIT_GAMECONTROLLER`,
  `SDL_GameControllerOpen`). Plan 5 ships keyboard + pointer
  only; joystick / gamepad is post-v1.
- **SDL2 sensors** (`SDL_INIT_SENSOR`). No sensor surface in v1.
- **SDL2 power management** (`SDL_GetPowerInfo`). No power API
  in v1.
- **SDL2 filesystem APIs** (`SDL_GetBasePath`, `SDL_GetPrefPath`).
  `--disable-filesystem`; apps use libc directly.
- **SDL2 haptic** (`SDL_INIT_HAPTIC`). No vibration in v1.
- **SDL2 2D render API** (`SDL_Renderer`, `SDL_Texture`).
  `--disable-render`; apps use GL directly. (Plan 8's wpkdraw
  reintroduces a software 2D rendering path for apps that don't
  want GL.)
- **SDL_image / SDL_mixer / SDL_ttf / SDL_net**. Separate
  libraries; post-v1.
- **Real libinput.** Plan 9's compositor ports it for gesture /
  palm-rejection; v1's libinput-lite is the stub.
- **Real udev / libudev.** Plan 9's compositor evaluates whether
  a tiny libudev shim is needed for `/dev/input/by-id/`-style
  symlinks; v1 ships neither.
- **SDL2 dlopen** (`SDL_LoadObject`). `--disable-loadso`; no
  runtime plugin loading.
- **SDL3 migration.** When SDL3 has stable adoption (likely
  2027-08+), revisit. Plan 7's contract is SDL2 2.30.x.
- **Wayland video backend.** Plan 9's wpkcompositor is the
  Wayland server; until it ships, no SDL2 client can use the
  Wayland backend even if compiled in.
- **PulseAudio / PipeWire audio backends.** v1 ships ALSA only.
- **OFD-table-split refactor.** Triggered by Phase C profiling
  gate or deferred to plan 8; either way, not landed by plan 7
  itself.

---

End of plan.
