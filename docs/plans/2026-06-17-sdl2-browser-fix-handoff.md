# SDL2 browser fix handoff — Phase 0 rename + two kernel bug fixes mid-flight

This is a *direction + state* handoff written before a `/clear`. Phase 0 (the rename) is in the working tree green; two kernel bugs surfaced while gating it on browser boot; one is fully landed, the other landed in code but not yet re-verified end-to-end.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`, tip `4f88111bb`. NOT pushed. PR #709 untouched.
2. **Plan choice locked:** User picked **Plan 1 — GLSL Playground** (file `docs/plans/2026-06-17-sdl2-glsl-playground-plan.md`). Plan 2 (Earth C++) is a future side project. Do NOT draft Plan 2 in this session.
3. **Phase 0 (rename `sdl2_demo` → `sdl2`) is done in the working tree.** Build + Node-side vitest + cargo + shared all green. Browser-boot gate exposed two preexisting kernel bugs (NOT introduced by Phase 0).
4. **Both kernel bugs have code changes landed but uncommitted.** Bug 1 (legacy DRM_IOCTL_MODE_ADDFB) is fully verified — demo progressed from frame-0-fail to 8 frames rendering. Bug 2 (WRITEI returns 0 instead of EAGAIN on full ring) had code + tests written + 1072/1072 cargo green + kernel rebuilt; the Playwright re-run wasn't done before the session was cut for this handoff.
5. **Order from the user for the next session:**
   1. Verify SDL2 boot in the browser end-to-end (kandelo-sdl2.spec.ts should reach `sdl2: OK frames=… exit=timeout`).
   2. Trim the debug `fprintf` instrumentation in `programs/sdl2/main.c` and the diagnostic `console.log`s in `apps/browser-demos/test/kandelo-sdl2.spec.ts`.
   3. Remove the **Evdev** demo (browser-side only — keep evdev tech for SDL2 input).
   4. Remove the **ALSA-Espeak-NG** demo (browser-side only — keep ALSA tech for SDL2 audio).
   5. Run the CLAUDE.md test suite.
   6. Commit only with explicit per-session approval.
6. **Do NOT:** push, `gh pr *`, regenerate the ABI 16 artifacts, bump `revision` fields, touch `scripts/check-abi-version.sh` (broken per handoff-57 §3 — orthogonal).
7. **Dev-shell entry** (CLAUDE.md says use `scripts/dev-shell.sh` but `nix` isn't on PATH by default in this harness): `source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && bash scripts/dev-shell.sh bash -c '…'`. The user had to point this out last session; reach for it directly.

## What the user reported mid-session

> "Nothing is concretely working. Evdev input log, ALSA – Espeak-NG, SDL2 demo — these three demos are broken. Anyway, in this PR I would like you to remove entirely the Evdev input log and ALSA – Espeak-NG since their features will be used in the SDL2 demo. […] Remove the evdev demo from the browser but keep the evdev device/technology inside the project since we need it for SDL2. Remove the Espeak-ng demo from the browser but keep the ALSA device/technology inside the project since we need it for SDL2. Fix the SDL2 broken demo in the browser. This will prepare us for Step 1."

"Step 1" = Phase 1 of the GLSL Playground plan. The order is therefore: **fix SDL2 first, then remove the two doomed demos, then start Phase 1**.

## SDL2 browser bug — root-cause trace

The Playwright spec `apps/browser-demos/test/kandelo-sdl2.spec.ts` (NEW; created this session) drove the diagnostic. Symptoms:

- **Before any fix:** boot reached `tick("running sdl2...")` then bash's PTY printed `sdl2: SDL_Init OK (video=KMSDRM, audio=alsa)` and then spammed `ERROR: Could not get a framebuffer` forever (never exited).
- **After kernel fix #1 (legacy ADDFB):** demo rendered frames 0–7 cleanly at ~50 ms apparent / iteration, then `SDL_PumpAudioDevices` blocked. Per-stage instrumentation showed the last visible output was `DBG: f16 post-poll` — i.e. inside the audio pump. Math: 16 × 1024 frames × 4 bytes/frame at 48 kHz stereo = 65536 bytes = exactly the `ringBytes: 64 * 1024` configured in `live-setup.ts`. Ring saturated; kernel returned `result = 0`; SDL2's polled ALSA path hit the `status == 0` branch and `SDL_Delay`'d forever.
- **After kernel fix #2 (WRITEI returns EAGAIN on full ring):** end-to-end Playwright not yet re-run.

### Fix 1 — legacy `DRM_IOCTL_MODE_ADDFB` (LANDED + VERIFIED)

`crates/kernel/src/syscalls.rs` only handled `DRM_IOCTL_MODE_ADDFB2`; SDL2's `KMSDRM_FBFromBO` (`packages/registry/sdl2/sdl2-src/src/video/kmsdrm/SDL_kmsdrmvideo.c:334`) uses the legacy single-plane `drmModeAddFB(fd, w, h, depth=24, bpp=32, stride, handle, &fb_id)`. The ioctl number `_IOWR('d', 0xAE, struct drm_mode_fb_cmd)` resolves to `0xc01c_64ae`; the struct is 7 × u32 = 28 bytes.

Added (all uncommitted):
- `crates/shared/src/lib.rs`: `DRM_IOCTL_MODE_ADDFB: u32 = 0xc01c_64ae;` and `WpkDrmModeFbCmd` (fb_id/width/height/pitch/bpp/depth/handle, 28 B). Added size + ioctl-number assertions in the existing `kms_struct_sizes_match_linux_abi` and `kms_ioctl_numbers_match_linux_uapi` tests.
- `crates/kernel/src/syscalls.rs`: new dispatch arm placed before the `ADDFB2` arm. Maps `(depth, bpp)` → fourcc:
  - `(24, 32)` → `DRM_FORMAT_XRGB8888`
  - `(32, 32)` → `DRM_FORMAT_ARGB8888`
  - `(16, 16)` → `DRM_FORMAT_RGB565`
  - else → `EINVAL`
  Then mirrors `ADDFB2`'s `dri_state(...).handles[handle] → bo_id`, `with_registry(incref)`, `kms.fbs.insert(KmsFb {…})`, `host.kms_addfb(…)`. Writes the new `fb_id` back to `req.fb_id` and returns Ok.

Both `cargo test -p kandelo --target aarch64-apple-darwin --lib` (1072/1072) and `cargo test -p wasm-posix-shared --lib --target aarch64-apple-darwin` (28/28, including the new struct size + ioctl number assertions) pass. Kernel rebuilt via `bash packages/registry/kernel/build-kernel.sh`. ABI impact: **purely additive** — new ioctl number + new struct, no existing struct or ioctl number changed. Per CLAUDE.md: "additions are allowed without a bump if existing entries are unchanged." Snapshot drift expected; CI gate is `scripts/check-abi-version.sh` which is independently broken (handoff-57 §3) so verify by inspection.

### Fix 2 — `SNDRV_PCM_IOCTL_WRITEI_FRAMES` returns EAGAIN on full ring (LANDED, NOT RE-VERIFIED)

`crates/kernel/src/audio/pcm_ioctl.rs::handle_writei` previously returned `Ok(())` with `req.result = 0` when the ring was full. The kernel-side comment documented this as deliberate: *"v1 has no audio wait queue (A6 territory), so the call returns 0 frames written rather than blocking."*

That contract is incompatible with SDL2's polling-audio patch (`packages/registry/sdl2/patches/0002-polling-audio-eagain.patch`), which only handles `status == -EAGAIN` to return early — the `status == 0` branch in `ALSA_PlayDevice` (line 394 of upstream `SDL_alsa_audio.c`) does `SDL_Delay(delay); continue;` and spins forever when the AudioWorklet doesn't drain the ring (e.g., headless Playwright pre-gesture, or in real browsers when the worklet falls behind a 48 kHz stereo write rate).

Change: when `frames_req > 0 && to_write == 0`, return `Err(Errno::EAGAIN)`. A zero-frame request still succeeds with `result = 0`. Updated comment block on `handle_writei`. Renamed and rewrote `writei_when_ring_full_writes_zero_frames` → `writei_when_ring_full_returns_eagain`. Cargo (1072/1072) green. Kernel rebuilt.

**What was NOT done before the session was cut:** re-running `kandelo-sdl2.spec.ts` against the EAGAIN kernel to confirm the demo now completes its 5 s and emits `sdl2: OK frames=… exit=timeout`. That is task #1 next session.

### Why this isn't an espeak regression

The user noted the espeak demo is being deleted anyway. But also: the espeak demo's audio config is mono @ 22050 Hz with the same `ringBytes: 64 * 1024` — that's 65536 / 2 = 32768 samples = 1.486 s of ring depth vs SDL2's 0.341 s. Espeak's ~3 s utterance writes through the worklet's draining without ever long-saturating the ring under normal conditions, so the `Err(EAGAIN)` change is unlikely to surface for espeak in practice. The pre-existing `kandelo-espeak.spec.ts` would catch any regression; since the demo is on the chopping block, just delete that spec along with the rest of the espeak demo wiring.

## Working tree state (all uncommitted)

### Phase 0 rename (clean)
- `programs/sdl2_demo.c` → `programs/sdl2/main.c` via `git mv`. **WARNING: still contains diagnostic `fprintf(stderr, "DBG: …")` instrumentation** (created window / gl ctx / shaders / vbo / audio device / loop entry, plus per-frame `f%d enter/post-pump/post-poll/post-audio/pre-swap/post-swap`, plus `loop exited` line). All `DBG:` lines must be stripped before commit. Clean Phase 0 main.c keeps only:
  - Header docstring rewrite (path + build-script note)
  - printf prefixes `sdl2_demo:` → `sdl2:` (3 sites: `SDL_Init OK`, `OK frames=…`, plus the `SDL_CreateWindow` title `"sdl2_demo"` → `"sdl2"`)
- `host/test/sdl2-demo.test.ts` → `host/test/sdl2.test.ts` via `git mv`. Docstring + describe label + 4 string matchers + 2 argv updates. Vitest 2/2 (`SDL2 playground — video + audio + input combined`).
- `scripts/build-programs.sh`: removed obsolete `sdl2_demo.c)` case from the main `for src in *.c` loop; widened SDL2 resolver guard at line ~207 to also catch `programs/sdl2/*.c`; added a post-loop multi-source block that globs every `.c` under `programs/sdl2/` and links them into a single `sdl2.wasm` with `libSDL2.a + libasound.a + libinput.a + libgbm.a + libdrm.a + libEGL.a + libGLESv2.a`. Build log line: `Compiling sdl2 (multi-source: N file(s))...`.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`: every enumerated touch point updated (`import.meta.glob × 2`, `optionalBinaryUrl` paths+label, `failOn` tag, `writeVfsBinary` path, `runShellCommand` target, 4 `tick(...)` log strings, JSDoc on `LiveProfile.sdl2Demo` field).
- Stale-comment cleanups: `programs/sdl2_alsa_smoke.c:18`, `programs/sdl2_kmsdrm_smoke.c:17`, `packages/registry/sdl2/build-sdl2.sh:4`.
- Stale `local-binaries/programs/wasm32/sdl2_demo.wasm` still on disk. Delete after Phase 0 boot is green (Playwright spec passes).

### Kernel bug fixes (cargo green, browser re-verification pending)
- `crates/shared/src/lib.rs`: `DRM_IOCTL_MODE_ADDFB` const + `WpkDrmModeFbCmd` struct + assertions (size = 28, ioctl = `0xc01c_64ae`).
- `crates/kernel/src/syscalls.rs`: legacy ADDFB dispatch arm (~65 LOC) inserted before `DRM_IOCTL_MODE_ADDFB2`.
- `crates/kernel/src/audio/pcm_ioctl.rs`: `handle_writei` returns `Err(EAGAIN)` on full-ring non-zero-request; updated comment; renamed/rewrote unit test.
- `host/wasm/kandelo-kernel.wasm` + `local-binaries/kernel.wasm` rebuilt.

### Diagnostic test (NEW, needs trimming)
- `apps/browser-demos/test/kandelo-sdl2.spec.ts`: verbose Playwright spec — captures syslog, switches surface tabs, dumps terminal text at 15 s + 45 s, logs page console errors. For commit, trim to a Modeset-style minimal spec that asserts:
  - syslog shows `running sdl2` within 90 s
  - syslog shows `sdl2 exited` within 30 s after
  - syslog does NOT show `sdl2 failed`
  - terminal/PTY shows `sdl2: SDL_Init OK` and `sdl2: OK frames=` matching `exit=timeout`
  - canvas screenshot byte length > some threshold (mirroring modeset spec's WebGL gate)

### Background processes
- A Vite dev server is running in the background at port **5403** (and 5401, 5402 from prior sessions). The Playwright spec auto-targets 5401 (via `KANDELO_PLAYWRIGHT_PORT=5401`) and `reuseExistingServer` honors it. If those processes are stale or you don't trust them, `pkill -f 'vite'` and start fresh.

### Symlink farm
- `/tmp/kandelo-llvm-bin/` was set up as a fallback when I was bypassing the dev-shell (brew llvm is missing `wasm-ld` which lives in brew `lld`). This is **stale and not needed** — the dev shell via `nix-daemon.sh` works correctly. Delete `/tmp/kandelo-llvm-bin/` if it bothers you; harmless if left.

## Removing the Evdev and Espeak demos — concrete touch points

When you get to tasks #3 and #4, the surface to delete (verified by grep this session):

### Evdev demo
- `apps/browser-demos/pages/kandelo/presets.ts`: drop the `"evdev"` entry.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`:
  - Remove `"evdev"` from `LIVE_DEMO_IDS`.
  - Remove `LIVE_PROFILE_SPECS.evdev`.
  - Remove `LiveProfile.evdevDemo: boolean` field + JSDoc.
  - Remove `evdevDemo: normalized === "evdev"` in `profileFor`.
  - Remove `evdevDemo: false` in `customVfsProfile`.
  - Remove the entire `else if (profile.evdevDemo)` spawn block.
  - Remove the `OPTIONAL_BINARY_URLS` entries for `evdev_demo.wasm` (4 lines, 2 import.meta.glob calls).
- Delete `programs/evdev_demo.c`.
- Delete `apps/browser-demos/test/kandelo-evdev.spec.ts`.
- Delete stale `evdev_demo.wasm` from `binaries/programs/wasm32/` and `local-binaries/programs/wasm32/`.
- Check `web-libs/kandelo-session/src/demo-guides.ts` and `demo-config.ts` for any `"evdev"` references (built-in presentation / guide entries).
- Check `docs/browser-support.md` and any `docs/architecture.md` mention.
- **KEEP** the kernel-side evdev syscall code, libinput-lite package, `sdl2_evdev_smoke` test, `host/test/input-evdev.test.ts`, `BrowserInputSource`. These are SDL2 prerequisites.

### ALSA-Espeak-NG demo
- `apps/browser-demos/pages/kandelo/presets.ts`: drop the `"espeak"` entry.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`: parallel removals to the evdev list above (`espeak` from `LIVE_DEMO_IDS`, `LIVE_PROFILE_SPECS.espeak`, `LiveProfile.espeakDemo` + JSDoc, `profileFor` assignment, `customVfsProfile` default, the entire `else if (profile.espeakDemo)` spawn block).
- Delete `apps/browser-demos/test/kandelo-espeak.spec.ts`.
- `images/vfs/build-shell-vfs-image.ts`: remove `populateEspeakRuntime()` and its call site. This drops espeak-ng + its `espeak-ng-data/` directory from the shell VFS image — incidentally fixing handoff-62 §C "espeak-source-missing" because the shell-vfs image no longer needs to resolve espeak-ng during the build.
- Check `web-libs/kandelo-session/src/demo-guides.ts` and `demo-config.ts` for any `"espeak"` references.
- Check `docs/browser-support.md` for the espeak entry.
- **KEEP** `packages/registry/espeak-ng/` package recipe (third-party library packaging — leave the package even if unused for now). KEEP `packages/registry/alsa-lib/`, `sdl2_alsa_smoke`, `host/test/sdl2.test.ts` (Node-side audio smoke), `BrowserAudioDriver`, `wpk-audio-worklet.js`, the kernel-side ALSA syscalls. SDL2 needs all of these.

## Things NOT to do

- Do NOT push or `gh pr *`. Branch stays local.
- Do NOT commit, push, or PR without explicit per-session approval.
- Do NOT bump `revision` fields in `build.toml` files.
- Do NOT regenerate the ABI 16 artifacts already in `local-binaries/programs/wasm32/`.
- Do NOT spend time on `scripts/check-abi-version.sh` — broken per handoff-57 §3.
- Do NOT remove the `packages/registry/espeak-ng/` recipe — only the demo wiring (the user asked to remove the *demo*, not the underlying package).
- Do NOT remove `packages/registry/alsa-lib/`, `libinput-lite`, `BrowserAudioDriver`, `BrowserInputSource`, or the `sdl2_*_smoke` programs — SDL2 needs them.
- Do NOT introduce a `WASM_POSIX_DEV_NO_ABI_CHECK` bypass.
- Do NOT add an SDL2-side patch to call `drmModeAddFB2` instead of `drmModeAddFB`. The kernel-side legacy-ADDFB shim is the chosen path because: it doesn't require bumping the SDL2 package revision (matches the "do NOT bump revision" guidance), it's more general (any future user binary that uses legacy ADDFB just works), and the SDL2 patch surface stays smaller for upstream-rebase ergonomics.

## Reverted fixes from session 63 — still pending as separate follow-up PRs

Mention in the SDL2 PR description so reviewers know the local-binaries → ABI 16 path remains reproducible only after these merge:

1. Per-package build-script `.o` cleanup for bzip2/less/unzip/zip + msmtpd (handoff-63 §"How the staleness bug actually works").
2. nethack host-link pre-clean for `src/{monst,objects,drawing,decl,alloc,dlb}.o` (handoff-62 §B).
3. shell-vfs-image espeak-optional skip (handoff-62 §C) — **partially absorbed** by the espeak demo removal above (the shell-vfs no longer bakes espeak, so the espeak-source-missing failure path goes away naturally).

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-sdl2-browser-fix-handoff.md` first. Branch is `explore-dri-sdl2`, tip still `4f88111bb` (NOT pushed, PR #709 untouched). Working tree has uncommitted Phase 0 rename of `sdl2_demo` → `sdl2`, plus two SDL2 browser-fix changes in the kernel: legacy `DRM_IOCTL_MODE_ADDFB` shim added (verified — demo went from frame-0-fail to 8 frames rendering), and `SNDRV_PCM_IOCTL_WRITEI_FRAMES` now returns `EAGAIN` on full ring instead of `result=0` (cargo green, Playwright re-run pending). User picked Plan 1 (GLSL Playground); Plan 2 (Earth C++) is a future side project. Order from the user: (1) verify SDL2 boot end-to-end via `kandelo-sdl2.spec.ts` against the EAGAIN kernel; (2) strip the debug `fprintf(stderr, "DBG: …")` instrumentation in `programs/sdl2/main.c` and trim the diagnostic `console.log`s out of the Playwright spec; (3) remove the Evdev demo (browser only — keep evdev tech for SDL2 input); (4) remove the ALSA-Espeak-NG demo (browser only — keep ALSA tech for SDL2 audio); (5) run the CLAUDE.md test suite; (6) commit + PR only with explicit per-session approval. Three reverted fixes from session 63 remain useful follow-up PRs after this one lands. `scripts/check-abi-version.sh` still broken per handoff-57 §3 — out of scope. Dev-shell entry: `source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && bash scripts/dev-shell.sh bash -c '…'`. Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR."*
