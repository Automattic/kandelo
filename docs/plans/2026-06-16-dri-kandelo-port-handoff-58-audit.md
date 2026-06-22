# Devil's-advocate audit — PR #709 (10 commits, ABI 16)

Session 58 audit. Branch `explore-dri-sdl2` tip `e6cc2f5d8`. Verified:

- Cargo: **1069 passed, 0 failed** (re-run this session).
- Vitest tip: 703 pass / 151 fail / 41 skip (handoff-57 numbers).
- Vitest base (`origin/explore-dri-evdev-and-alsa` at `d1b1156e8`, freshly built in `/tmp/kandelo-base`): **676 pass / 76 fail / 133 skip**.
- libc-test / posix-tests: GREEN per handoff-57 logs.

## Correction to handoff-57's claim

Handoff-57 stated "the 151 failures are all preexisting." That is **not strictly true**:

- **79 of the 151 tip failures do not appear in the base failure set** (`comm -23 tip-failures base-failures` = 79 lines).
- They are *not* regressions in our 10 commits. They are **cache-state artifacts**: tests in `packages/registry/{erlang,git,php,spidermonkey,wordpress}/` and `host/test/{exec-brk-base,wasm-binary-parse}` SKIP on the base worktree (binaries absent in `/tmp/kandelo-base`'s fresh cache) but RUN-AND-FAIL on the tip worktree (binaries present in `~/.cache/kandelo/binaries/` but built with wasm-exnref → Node 24 refuses to compile without `--experimental-wasm-exnref`).
- Evidence: 94 failures in the tip log carry the literal substring `WebAssembly.compile(): invalid value type 'exn', enable with --experimental-wasm-exnref`. The 79 "new on tip" set is a strict subset of the wasm-exnref + cache-staleness cluster.
- All test files in the tip's SDL2/DRI/audio/evdev surface (the 20 files in handoff-57 Finding §1) pass.

**Action**: revise the PR body to drop "all 151 are preexisting" and replace with "79 tip-only failures are environment/cache-state artifacts, with proof: failure-message signatures match." Or shorter: list only the tip's SDL2/DRI/audio/evdev surface and assert *those* are green.

---

## Per-commit audit

### `4dc64cf79` — libdrm/alsa-lib/libinput-lite + CTL ioctl + IoctlEncoded marshalling

(a) **Worry**: The new `_IOC_SIZE` extraction `(req >>> 16) & 0x3fff` in `host/src/kernel-worker.ts` could misbehave at size=0 (legacy ioctls), at size=0x3fff (max 14-bit), or via a signed-shift hazard.

(b) **Confirm/refute**: **REFUTED**. Uses unsigned right-shift (`>>>`). Size-0 path falls back to a 256-byte floor that covers FIONBIO/FIOCLEX/FIONCLEX/FIONREAD/FIOASYNC (the only size-0 ioctls in `crates/kernel/src/syscalls.rs` lines 8741–8790). Size=0x3fff (=16383) is honoured as-is. CTL ioctl encodings in `crates/kernel/src/audio/ctl_ioctl.rs:31,41` decompose correctly: `_IOR('U', 0x00, int)` → dir=2, type=0x55, size=4 ✓.

(c) **What to do if confirmed**: N/A.

**Tangential issues**:
- **Missing test**: no dedicated vitest exercises the IoctlEncoded marshalling path at boundary (size=0 floor, size=0x3fff). End-to-end alsa-lib smoke is the only coverage. **Recommend**: add a focused host-level test that round-trips a synthetic 0x3fff-sized ioctl payload.
- **Docs not updated**: `docs/abi-versioning.md`, `docs/posix-status.md`, `docs/architecture.md` should mention the IoctlEncoded variant and the new CTL surface. CLAUDE.md says "If a feature is worth implementing, it is worth documenting."

---

### `9312b390f` — WpkAlsaPcmStatus/MmapStatus/MmapControl wasm32 alignment

(a) **Worry**: Shrinking `WpkAlsaPcmMmapStatus` 64→56 B could leave callers writing past the new end.

(b) **Confirm/refute**: **REFUTED**. All allocations use `size_of::<T>()` (`crates/kernel/src/audio/pcm_ioctl.rs:1285`) or `Box::new(WpkAlsaPcmMmapStatus::default())` (`crates/kernel/src/audio/mmap.rs:87,108`). Compile-time size asserts at `crates/shared/src/lib.rs:3342–3345` would fail the build on drift. Fork serialize/deserialize updated symmetrically (`crates/kernel/src/fork.rs:434–450,632–657`). No hardcoded `64` / `56` left over.

(c) **What to do if confirmed**: N/A.

---

### `6eda62af4` — SDL2 2.30.0 scaffold

(a) **Worry**: SDL2 2.30.0 is the chosen version — is there a CVE or wasm-relevant fix in 2.30.1+ we'd want?

(b) **Confirm/refute**: **Not investigated this session**. The version is pinned; reviewer should consult SDL2 release notes 2.30.1..latest if a follow-up matters. Most security-relevant SDL2 CVEs in recent history are platform-native (Windows/macOS), not wasm.

(c) **What to do if confirmed**: bump source pin in `packages/registry/sdl2/build.toml` + revision bump.

**No stale code** in this commit (pure scaffold).

---

### `8ffe0c0b2` — configure overrides + evdev shim + dynapi patch

(a) **Worry**: `sdl2-evdev-shim.h` (389 LoC) redefines `<linux/input.h>` constants — could be off-by-one vs. kernel's evdev encoding, silently breaking ESC.

(b) **Confirm/refute**: **REFUTED**. Verified byte-identical across four sources:
- Kernel (`crates/shared/src/lib.rs:2495,2662–2664`): `KEY_ESC=1, EV_KEY=0x01, SYN_REPORT=0x00, BTN_LEFT=0x110`.
- musl sysroot (`libc/musl-overlay/include/linux/input-event-codes.h:18–27`): same values.
- SDL2 shim (`packages/registry/sdl2/src/sdl2-evdev-shim.h`): uses `#ifndef` guards so musl definitions take precedence; the shim only adds *supplementary* codes (media keys, gamepad).
- Test injection (`host/test/sdl2-demo.test.ts:22–25`): `KEY_ESC = 1`, etc., as literals matching kernel.
- Host→kernel path (`host/src/kernel.ts:286–296` → `crates/kernel/src/wasm_api.rs:10286–10307`): no translation, cast direct.

(c) **What to do if confirmed**: N/A.

---

### `1d38beac3` — `host_kms_mode_info` + dep-symlink + namehint stub

(a) **Worry**: `buildVirtualConnectorMode()` (`host/src/dri/kms-registry.ts:21`) ignores `connector_id` (parameter prefixed `_`). A future multi-head probe would receive identical 1024×768 modes for every connector.

(b) **Confirm/refute**: **CONFIRMED-as-intentional-limit**. Comment at `kms-registry.ts:12–20` and `:67–70` documents v1's single-connector posture; kernel advertises exactly one connector (`crates/kernel/src/syscalls.rs:1260–1263,1336–1367`). No multi-head probe site exists yet. Not a bug; not stale either — the parameter must remain in the signature so a multi-head extension is a typed change, not a signature change.

(c) **What to do if confirmed**: leave as-is; the underscore-prefix is the canonical "intentionally unused" mark in TypeScript. Optional: add a literal `TODO(multi-head)` next to the comment so a future grep finds it.

---

### `f60ccff85` — polling-audio patch

(a) **Worry-1**: `wpk_polled_audio_devices[8]` (`packages/registry/sdl2/patches/0002-polling-audio-eagain.patch:51–60`) silently no-ops on the 9th register. The 9th `SDL_OpenAudioDevice` returns success but the device never gets pumped.

(b) **Confirm/refute (worry-1)**: **CONFIRMED but low-severity**. Demo opens 1 device; sdl2-alsa smoke opens 1. No call site exercises ≥8. Adding an assertion or `SDL_SetError` + bail on cap-exceeded is the upstream-idiomatic fix.

(c) **What to do if confirmed (worry-1)**: change the patch to surface an error instead of silent no-op. ~5 lines. Bump SDL2 build.toml revision (rev3 → rev4) to invalidate the cached archive.

(a) **Worry-2**: EAGAIN-forever from `snd_pcm_writei` (a dead kernel-side consumer) would churn the polled path silently.

(b) **Confirm/refute (worry-2)**: **CONFIRMED behavior, but matches Linux ALSA non-blocking semantics**. The pumped path returns immediately; no escalation. Real kernel-side death would surface as `snd_pcm_writei` returning a non-EAGAIN error (which the patched path *does* handle via `ALSA_snd_pcm_recover`). Acceptable.

(c) **What to do if confirmed (worry-2)**: leave as-is. The polled loop has nothing useful to do on persistent EAGAIN that the kernel-side audio.rs tick doesn't already do.

**Missing test**: no test exercises the 9th open, the duplicate-register case, or the EAGAIN path.

---

### `a11dc1bb2` — libEGL + libgbm extensions

(a) **Worry-1**: 2-BO ring (`libc/glue/libgbm_stub.c`) — what happens on lock-lock-lock without intermediate release, on release-without-lock, or destroy-with-locked-BO?

(b) **Confirm/refute (worry-1)**: **REFUTED**. `lock_front_buffer` returns NULL+EBUSY when both in-use (`libgbm_stub.c:447–467`). `release_buffer` ignores non-existent BO (line 478). `gbm_surface_destroy` unlinks regardless of in-use state, no double-free. SDL2's `KMSDRM_GLES_SwapWindow` is strict release→lock paired (`SDL_kmsdrmopengles.c:89–150`).

(a) **Worry-2**: `libegl_stub.c` may miss EGL functions SDL2 dereferences when `SDL_VIDEO_STATIC_ANGLE=1`.

(b) **Confirm/refute (worry-2)**: **REFUTED**. All 20 core LOAD_FUNC names map to defined stubs. Extension LOAD_FUNC_EGLEXT routes via `eglGetProcAddress` which returns NULL — SDL2 treats NULL as "extension not present," documented safe.

(c) **What to do if confirmed**: N/A.

**Missing test**: `grep -rn "gbm_surface" host/test/ packages/registry/*/test/` returns zero. The 2-BO ring is exercised only indirectly through sdl2-demo. **Recommend**: add a C smoke (`programs/gbm_surface_smoke.c`) that does lock → lock → has_free_buffers (=0) → release → lock → release and asserts the state transitions.

---

### `cf610100d` — pcm_ioctl refine periods/buffer fix

(a) **Worry-1**: With caller pinning `periods=2, period=1024, buffer=4096` simultaneously (inconsistent: 2*1024=2048 ≠ 4096), does the kernel silently overwrite buffer to 2048?

(b) **Confirm/refute**: **REFUTED**. The eager-derivation guard at `crates/kernel/src/audio/pcm_ioctl.rs:359–373` includes `derived >= buffer_min && derived <= buffer_max`. With buffer pinned to [4096,4096] and derived=2048, the guard fails — buffer is NOT overwritten. The inconsistency surfaces later in `read_interval_single` for one of the now-mismatched intervals, returning EINVAL to the caller. No silent corruption.

(c) **What to do if confirmed**: N/A.

(a) **Worry-2**: Are NEW tests added for the intersection-empty case (lines 343–345) and eager-derivation case (lines 359–373), or did existing tests just get adjusted to keep passing?

(b) **Confirm/refute**: **PARTIALLY CONFIRMED**. The diff at `crates/kernel/src/audio/pcm_ioctl.rs` shows the test helper `refined_hw_params()` was modified to pin periods to the derived value. No new `#[test] fn` was added that specifically exercises (i) intersection-empty → EINVAL or (ii) eager-derivation pinning. The existing 26 audio::pcm_ioctl tests pass, but the dedicated regression case for "caller set periods.min=2 and kernel honoured it" is implicit only.

(c) **What to do if confirmed**: add two focused tests in `crates/kernel/src/audio/pcm_ioctl.rs::tests`:
1. `refine_with_user_periods_min_honoured` — caller sets periods=[2,…], buffer=[256,4096], period=[64,512]; assert refined periods.min ≥ 2.
2. `refine_with_empty_intersection_returns_einval` — caller sets periods=[8,8] with buffer/period derivation forcing [2,2]; assert EINVAL.

---

### `1ed6bb394` — `-DSDL_VIDEO_STATIC_ANGLE=1`

(a) **Worry**: Are there OTHER LOAD_FUNC paths in SDL2 that skip the SDL_VIDEO_STATIC_ANGLE guard?

(b) **Confirm/refute**: **REFUTED**. Only `src/video/SDL_egl.c` carries the LOAD_FUNC pattern. `src/render/opengles2/` does not dynamic-load — it uses GLES2 symbols resolved at link time. No hidden dlopen path.

(c) **What to do if confirmed**: N/A.

**Stale-code candidate**: the build.toml revision bump (`rev2 → rev3`) is necessary to invalidate the cache_key_sha. Verified — not stale.

---

### `e6cc2f5d8` — sdl2_demo.c + vitest end-to-end

(a) **Worry-1**: `frames=N` in stdout (`programs/sdl2_demo.c:209`) is loop-tick count, not rasterized-frame count. The test (`host/test/sdl2-demo.test.ts:57,64`) asserts `frames > 0`, which passes if the loop runs at all — silently green even if rendering is broken end-to-end.

(b) **Confirm/refute**: **CONFIRMED**. Per handoff-53, GLES2 commands flow through but don't currently rasterize via the kernel's KMS canvas bridge in this build path. The metric is misleading.

(c) **What to do if confirmed**: rename the test description from "renders frames" → "drives the main loop without crashing" (`sdl2-demo.test.ts:45`). Or add an explicit kernel-canvas readback assertion comparing pixel hash before/after to confirm rasterization happened. The first is honest; the second is a more rigorous gate.

(a) **Worry-2**: SDL_Quit ticks-base wrap.

(b) **Confirm/refute**: **REFUTED**. `programs/sdl2_demo.c:200` captures `elapsed` before `SDL_Quit` at line 207. Comment lines 197–199 documents *why*. Correct.

(a) **Worry-3**: Over-commenting per CLAUDE.md "explain WHY not WHAT."

(b) **Confirm/refute**: **CONFIRMED**. Specific candidates for trim:
- `programs/sdl2_demo.c:46` — `/* int16 stereo: 4 bytes per frame */` explains the arithmetic, not why. **Remove**.
- `programs/sdl2_demo.c:84–85` — `belt + suspenders` narrative. The setenv calls are self-explanatory; remove the comment.
- `programs/sdl2_demo.c:182–184` — `Polling-audio: drive…` repeats the patch's docstring. Trim to 1 line referencing the patch.
- `programs/sdl2_demo.c:34–38` — extern fallback note for `SDL_PumpAudioDevices` is defensive history; if the header is correctly gated, the extern is unnecessary. **Investigate whether removing the extern still compiles; if yes, remove both extern + comment.**
- `host/test/sdl2-demo.test.ts:104–106` — "Release shortly after" explains what the next two lines do. **Remove**.

Keep:
- `programs/sdl2_demo.c:88–97` (SDL_EVDEV_DEVICES setenv) — explains WHY libudev is absent and why the env var is needed. Non-obvious, load-bearing for the test.
- `programs/sdl2_demo.c:197–199` (SDL_Quit ticks-base wrap) — explains WHY the early capture matters. Non-obvious.

(c) **What to do if confirmed**: edit `programs/sdl2_demo.c` and `host/test/sdl2-demo.test.ts` to trim ~6 lines of WHAT-comments. Optional: re-run `bash build.sh` + the relevant smoke tests to confirm parity.

---

## Cross-cutting findings

### F1. Tests for new functionality

Per CLAUDE.md ("Each new functionality… should have its dedicated test"), four pieces are uncovered by a dedicated test:

| Functionality | Owning commit | Current coverage | Missing test |
|---|---|---|---|
| IoctlEncoded host marshalling boundary | 4dc64cf79 | indirect via alsa-lib smoke | size=0 / size=0x3fff round-trip |
| `wpk_polled_audio_devices[8]` overflow | f60ccff85 | none | open ≥9 devices |
| `gbm_surface_*` 2-BO ring | a11dc1bb2 | indirect via sdl2-demo | lock/release/has_free_buffers |
| `refine_hw_params` periods intersection | cf610100d | helper-adjusted | empty-intersection EINVAL |

### F2. Stale-code probe

I didn't find dead code from earlier attempts:
- All TypeScript exports are referenced.
- All Rust new-test functions have matching code paths.
- The `_connectorId` underscore is intentional, not a leftover.
- libegl_stub.c stubs all correspond to SDL_egl.c LOAD_FUNC entries.
- No unused build.toml fields, no unused .patch hunks.

### F3. Over-commenting

The `programs/sdl2_demo.c` candidates (lines 46, 84–85, 182–184, 34–38) and `host/test/sdl2-demo.test.ts:104–106` are the main offenders. Other files (kernel-worker.ts, kms-registry.ts, libegl_stub.c, conf_stubs.c, pcm_ioctl.rs) read fine: their long-form comments explain non-obvious WHY (page_size=4096 vs wasm 64 KB, sentinel pattern for config_unref, cmdbuf mmap timing for gl_bind, etc.).

### F4. Documentation

`docs/abi-versioning.md`, `docs/posix-status.md`, `docs/architecture.md` are unchanged. The 10 commits add CTL ioctl support, IoctlEncoded marshalling, three vendored sysroot libraries, a polling-audio architectural choice, and the 2-BO gbm_surface ring. At minimum:
- `docs/posix-status.md`: list new CTL ioctl numbers as implemented.
- `docs/architecture.md`: a short section on IoctlEncoded vs legacy ioctl handling in the kernel worker.
- A new `docs/audio.md` covering the SDL_THREADS_DISABLED polling architecture would help future readers.

### F5. PR body needs the corrected failure-attribution

Per the correction at the top of this document, the PR body should not claim "all 151 failures are preexisting." It should claim "the 20 SDL2/DRI/audio/evdev test files are GREEN; the 79 failures unique to tip's vitest run are wasm-exnref + cache-staleness artifacts of the local cache, not changes our PR introduces." Both true; only the second is defensible.

---

## What I propose to do, pending user permission

I cannot push, edit PR #709, or otherwise mutate shared state without explicit in-session approval. The audit's read-only output is the markdown above. The candidate code changes are:

**Cheap (≈30 min, low risk)**:
1. Trim ~6 over-comment lines in `programs/sdl2_demo.c` + `host/test/sdl2-demo.test.ts`.
2. Rename `sdl2-demo.test.ts:45` description from "renders frames" → "drives the SDL2 main loop end-to-end without crashing".
3. Investigate whether the `extern void SDL_PumpAudioDevices(void)` fallback at `sdl2_demo.c:34–38` is needed; if not, remove.

**Moderate (≈1–2 hr, low risk)**:
4. Add two `#[test] fn` cases in `crates/kernel/src/audio/pcm_ioctl.rs::tests` for the intersection-empty and user-periods-min-honoured cases.
5. Add a vitest exercising IoctlEncoded boundary marshalling.
6. Add a smoke C program + vitest for the gbm_surface 2-BO ring.

**Larger (≈half day, scope creep)**:
7. Author the documentation updates (architecture / posix-status / audio).
8. Patch the polling-audio cap to surface an error on overflow.

**Not in PR #709 scope (separate PR)**:
- Fix `scripts/check-abi-version.sh`'s pipefail+`grep -q` SIGPIPE bug (handoff-57 Finding §3).
- Recompile cached `~/.cache/kandelo/binaries/` archives without wasm-exnref so the tip vitest run matches handoff-57's claim.
