# SDL2 browser rendering handoff #6 — audio fix LANDED (3 missing TS wrappers), visual NOT rendering after kernel rebuild (KMSDRM ADDFB pipeline)

Successor handoff to `2026-06-17-sdl2-browser-rendering-handoff-5.md`. **Audio §C still fixed AND now reproducible from a fresh boot.** **NEW REGRESSION: SDL2 demo canvas is blank (no rotating square).** No console errors. Branch tip `4f88111bb` unchanged on disk; no commits.

## TL;DR — read this first

1. **Branch:** `explore-dri-sdl2`, tip still `4f88111bb`. NOT pushed. PR #709 untouched. Seven predecessor handoffs (`fix`, `rendering`, `-2`, `-3`, `-4`, `-5`, this).
2. **Handoff-5 was incomplete in three quiet ways the user hit immediately on the next hard-reload:**
   - **Kernel WASM was never rebuilt.** `local-binaries/kernel.wasm` (16:12:43) pre-dated the three new audio exports (`kernel_audio_init_appl_ptr_sab`, `kernel_audio_get_hw_ptr`, `kernel_audio_get_state`) added in handoff-4/5 source. The audio fix worked on the user's already-booted tab because `audioInitApplPtrSab` only fires once at boot — a hard reload + fresh boot threw `TypeError: this.kernel.audioInitApplPtrSab is not a function` in `kernel-worker.ts:7522` and the kernel-worker entry never wired the audio path. Result: canvas frozen, audio stuttering.
   - **`host/src/kernel.ts` was missing three wrapper methods** that `host/src/kernel-worker.ts` already calls (`audioInitApplPtrSab(pcmId, base)`, `audioGetHwPtr(pcmId)`, `audioGetState(pcmId)`). `bash build.sh` failed at the `tsup` DTS step until they were added. ALSO `KernelCallbacks` was missing `firstKmsCanvasCrtc?: () => number | undefined` which `kernel-worker.ts:865` provides — same DTS error.
   - **New `DRM_IOCTL_MODE_ADDFB` handler in `crates/kernel/src/syscalls.rs:1379` is necessary at runtime** for the rebuilt `sdl2.wasm` (22:39 build), but visual is **still** blank when it's present + active. Without it (when I temporarily reverted the hunk and rebuilt), nothing renders AND audio breaks too — the new SDL2 build (cache `sdl2-2.30.0-rev4-wasm32-15f95860/`) hard-depends on the legacy ADDFB path. So the hunk MUST stay.
3. **What works now (verified audibly by user this session):**
   - Audio: clean from a fresh boot, no stutter. Console is clean (only unrelated 404s for `gallery.json` and `favicon.ico`).
4. **What does NOT work:**
   - **SDL2 canvas is blank (pure black).** No console errors. The demo boots, audio plays, but no pixel hits the canvas. `kandelo-sdl2.spec.ts` (Playwright) will fail its canvas spread/animation gates — has NOT been re-run since the kernel rebuild.
5. **Current working tree** (clean of session-only diagnostic edits; only the legitimate additions remain):

```
M abi/snapshot.json
M crates/kernel/src/audio/{pcm_ioctl.rs,sab.rs,tick.rs}
M crates/kernel/src/syscalls.rs                    ← +66 lines: DRM_IOCTL_MODE_ADDFB handler (REQUIRED, do not remove)
M crates/kernel/src/wasm_api.rs                    ← +40 lines: audio_init_appl_ptr_sab/get_hw_ptr/get_state exports
M crates/shared/src/lib.rs                         ← HWSYNC constant + UAPI assertion
M host/src/audio/*.ts host/src/audio/wpk-audio-worklet.js
M host/src/browser-kernel-{host,protocol,worker-entry}.ts
M host/src/kernel-worker.ts host/src/kernel.ts     ← kernel.ts NEW THIS SESSION: 3 audio wrappers + firstKmsCanvasCrtc type
M host/src/node-kernel-{host,protocol,worker-entry}.ts
M images/vfs/scripts/build-shell-vfs-image.ts
M packages/registry/sdl2/build-sdl2.sh
M packages/registry/sdl2/patches/0002-polling-audio-eagain.patch
M scripts/build-programs.sh
D apps/browser-demos/test/kandelo-{espeak,evdev}.spec.ts
D programs/{evdev_demo,sdl2_demo}.c
A programs/sdl2/main.c
A host/test/sdl2.test.ts                           (renamed from sdl2-demo.test.ts)
?? apps/browser-demos/test/kandelo-sdl2.spec.ts
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff-6.md (THIS FILE)
```

6. **Built artifacts on disk:**
   - `local-binaries/kernel.wasm` — **22:59:03**, has `kernel_audio_{init_appl_ptr_sab,get_hw_ptr,get_state}` + `DRM_IOCTL_MODE_ADDFB` handler.
   - `local-binaries/programs/wasm32/sdl2.wasm` — **22:39:12**, linked against `sdl2-2.30.0-rev4-wasm32-15f95860`.
   - `host/wasm/rootfs.vfs` — **22:39:58**.
   - `host/wasm/kandelo-kernel.wasm` — **16:12:43** (stale, irrelevant — resolver prefers `local-binaries/kernel.wasm`).
   - `host/dist/*` — rebuilt 22:38ish via `bash build.sh`.

7. **Vite dev server** — running on **5403** (PID changed multiple times this session; check `lsof -nP -iTCP:5403 -sTCP:LISTEN`). Caches at `apps/browser-demos/node_modules/.vite` + `host/node_modules/.vite` are WIPED.

## What this session did, in chronological order

1. Re-verified §C audio audibly (user: "clean — fix holds") — this used the **already-booted** tab on the 16:12 kernel, masking the missing-export bug.
2. Ran the three CLAUDE.md test suites (all green): `scripts/run-libc-tests.sh` (302/0/20 XFAIL/1 FLAKE-PASS/1 TIME), `scripts/run-posix-tests.sh` (174/0/3 XFAIL/2 SKIP), Playwright `kandelo-sdl2.spec.ts` (1/1 pass — note: on **16:12 kernel + old sdl2.wasm**, so it passed with the now-broken visual path).
3. Investigated the spidermonkey vitest "flake" the handoff flagged — **deterministic, pre-existing bug, not a flake**. Mount of `/usr/local/lib/{npm,kandelo}` fails because the default rootfs MANIFEST has no `/usr/local` (only `/usr` and `/usr/bin`). Kernel's path resolver bails out at the missing parent before reaching the runtime-mounted HostFileSystem extras. **Fix already exists upstream:** commit `e73532843` "Add rootfs usr-local mount parents" on `origin/polecat/capable/kad-wtb.17@hq-06x0` — 4-line MANIFEST addition for `/usr/local`, `/usr/local/bin`, `/usr/local/lib`. Branch is unmerged to main.
4. **The investigation chain that caused this session's chaos** (DO NOT REPEAT): I added diagnostic `console.error` probes to `host/src/kernel.ts::hostOpen/hostOpendir` and `host/src/node-kernel-worker-entry.ts::handleInit`. Vite HMR'd them into the user's running browser tab. After I reverted (`git checkout -- kernel.ts` and a targeted Edit on the worker entry), the source on disk was clean but the user's browser tab had stale HMR'd worker modules. Killed Vite (PID 2600), wiped both `.vite` caches, restarted on 5403. User hard-reloaded — and now the *fresh* boot path hit the missing `audioInitApplPtrSab` for the first time.
5. User pasted console: `TypeError: this.kernel.audioInitApplPtrSab is not a function at CentralizedKernelWorker.audioInitApplPtrSab (kernel-worker.ts:7522)`. Root cause: stale kernel WASM missing three audio exports declared by handoff-4/5 source but never rebuilt to wasm.
6. Ran `bash build.sh` — failed at `tsup` DTS step with four errors:
   ```
   src/kernel-worker.ts(865,7): error TS2353: 'firstKmsCanvasCrtc' does not exist in type 'KernelCallbacks'.
   src/kernel-worker.ts(7522,17): error TS2339: Property 'audioInitApplPtrSab' does not exist on type 'WasmPosixKernel'.
   src/kernel-worker.ts(7555,24): error TS2339: Property 'audioGetHwPtr' does not exist on type 'WasmPosixKernel'.
   src/kernel-worker.ts(7559,24): error TS2339: Property 'audioGetState' does not exist on type 'WasmPosixKernel'.
   ```
7. Added the four missing pieces to `host/src/kernel.ts`:
   - `firstKmsCanvasCrtc?: () => number | undefined;` to the `KernelCallbacks` interface (alongside `getKmsCanvas`).
   - Three new methods on `WasmPosixKernel` following the existing `audioGetApplPtr` / `audioInitSab` patterns:
     - `audioInitApplPtrSab(pcmId, base)` → `kernel_audio_init_appl_ptr_sab(pcmId, BigInt(base))`
     - `audioGetHwPtr(pcmId)` → `Number(kernel_audio_get_hw_ptr(pcmId))` (returns bigint, returns 0 if missing)
     - `audioGetState(pcmId)` → `kernel_audio_get_state(pcmId)` (returns u32 directly, returns 0 if missing)
8. `bash build.sh` succeeded. Kernel rebuilt at 22:38:32 with all three audio exports + the existing ADDFB hunk. SDL2 rebuilt at 22:39:12. rootfs.vfs at 22:39:58.
9. User hard-reloaded — **audio works clean from fresh boot, canvas blank**. No console errors.
10. **My misdiagnosis of the visual regression:** I noted `DRM_IOCTL_MODE_ADDFB` (1379) in `syscalls.rs` is the ONLY new visual-relevant hunk (66 lines added vs HEAD), and theorized SDL2 was falling back to ADDFB2 before. I removed the hunk and rebuilt kernel → **catastrophe** (user: "no image no sound or a sound that is fucked up"). The new `sdl2.wasm` (linked against SDL2 rev4 with fix-B) hard-depends on the new ADDFB path; without it the whole pipeline collapses. I restored the hunk and rebuilt (kernel now at 22:59:03). Audio back to clean, canvas still blank.

## What the next session must investigate — the actual visual bug

The 16:12 kernel + the OLD `sdl2.wasm` (whatever existed before `bash build.sh` ran in this session) **animated correctly** — Playwright `kandelo-sdl2.spec.ts` passed with `canvas spread > 400` gates at the start of this session. After `bash build.sh` rebuilt BOTH the kernel AND `sdl2.wasm` together, audio works but the canvas paints nothing. So one of:

- **(A) Kernel ADDFB → host_kms_addfb → KMS canvas wiring is the regression.** The new kernel handler at `syscalls.rs:1379` validates `req.pitch != bo_stride` (line 1403) — if SDL2 passes a pitch that doesn't equal the BO's registered stride, returns `EINVAL` and SDL2 silently fails. Verify by adding a `host_debug_log` print in that handler (the `host_debug_log` import is right there in `wasm_api.rs:33` and the compiler currently warns "never used" so it's wired). Look for: does ADDFB get called? does it return EINVAL? does host-side `this.kms.addFb({...})` (`host/src/kernel.ts:1089`) ever run? See `host/src/dri/kms-registry.ts` for `addFb` behavior.
- **(B) `sdl2.wasm` rebuilt against a different SDL2 cache state than the one that worked.** Pre-session SDL2 cache directories listed in `~/.cache/kandelo/libs/`: `sdl2-2.30.0-rev1-{2ede9b12,abe6fa24}`, `rev2-{2c0ecd05,7aa4bdd8}`, `rev3-{3f05e53c,8b9e3ccc}`, `rev4-15f95860`. The current `build.toml` revision is **4**, so the build linked against `rev4-15f95860/lib/libSDL2.a` (mtime 21:31:26, NOT touched by this session's build — the SDL2 lib itself wasn't rebuilt). So this is unlikely unless the SDL2 archive on disk differs from what the old `sdl2.wasm` was linked against. Cheap check: `md5 /Users/mho/.cache/kandelo/libs/sdl2-2.30.0-rev4-wasm32-15f95860/lib/libSDL2.a` and compare against any archive in `binaries/`.
- **(C) Host-side KMS canvas registration or vblank pump regressed somewhere in this session's host TS work.** All the `host/src/*` changes per the diff above were AUDIO-side per the handoffs, but several files were touched (browser-kernel-host, browser-kernel-worker-entry, kernel-worker). Check if `kmsCanvases` ever gets populated for the SDL2 crtc, whether `firstKmsCanvasCrtc()` returns a real id, and whether `kernel_vblank()` is actually draining anything. The kernel has the `kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us` exports — call `kernel_kms_commit_count` from a `setInterval` host-side and watch whether it advances when the demo runs.
- **(D) The KMS canvas binding requires the kernel-side ADDFB path to call something the old ADDFB2 path didn't.** Compare what host events fire on ADDFB vs ADDFB2 and whether the canvas binding triggers on either.

**Start with (A)**: add the `host_debug_log` calls inside the ADDFB handler at three points (entry, after pitch check, after `host.kms_addfb`), rebuild kernel, hard-reload, watch console for what shows up — this answers in one cycle whether ADDFB is even getting called and where it fails.

## Files added/changed this session (only the legitimate additions, all diagnostic probes reverted)

```
M host/src/kernel.ts                                   ← NEW THIS SESSION:
                                                         + KernelCallbacks.firstKmsCanvasCrtc?
                                                         + WasmPosixKernel.audioInitApplPtrSab
                                                         + WasmPosixKernel.audioGetHwPtr
                                                         + WasmPosixKernel.audioGetState
                                                         (all bridge to existing Rust kernel exports)
?? docs/plans/2026-06-17-sdl2-browser-rendering-handoff-6.md  (this file)
```

Everything else listed in the working tree was already present at session start per handoff-5.

## Tests run this session

| Suite | Result | Notes |
|---|---|---|
| §C audio audible (user, real Chrome) | ✅ clean, no stutter | Verified BEFORE kernel rebuild on already-booted tab AND AFTER rebuild on fresh boot |
| `scripts/run-libc-tests.sh` | ✅ 302 PASS, 0 FAIL, 20 XFAIL, 1 FLAKE-PASS, 1 TIME | Pre-rebuild kernel — re-run after any kernel change |
| `scripts/run-posix-tests.sh` | ✅ 174 PASS, 0 FAIL, 3 XFAIL, 2 SKIP | Pre-rebuild kernel — re-run after any kernel change |
| Playwright `kandelo-sdl2.spec.ts` | ✅ 1/1 pass (9.3 s) | Pre-rebuild — **WILL NOW FAIL** on the visual gates (`canvas spread > 400`) |
| cargo `-p kandelo --lib` | NOT re-run this session | Was 1080/1080 in handoff-5 |
| ABI snapshot | NOT re-run this session | Was in sync in handoff-5 |
| vitest spidermonkey cowsay | ❌ deterministic failure (not a flake) | See §3 above — fix exists upstream on `e73532843` |

## Things NOT to do (carry-forward + new from this session)

- **DO NOT remove the `DRM_IOCTL_MODE_ADDFB` hunk in `crates/kernel/src/syscalls.rs:1379`.** The new `sdl2.wasm` build hard-depends on it. Removing it gave the user "no image no sound or a sound that is fucked up". The fix lives ELSEWHERE in the pipeline.
- **DO NOT revert the four `host/src/kernel.ts` additions this session.** Without them the `bash build.sh` DTS step fails immediately.
- **DO NOT add `console.error` probes to `host/src/kernel.ts` hot paths (hostOpen, hostOpendir, hostStat).** Use `host_debug_log` from Rust kernel side instead — it goes through the same channel without flooding browser HMR/SW state. The Vite HMR + SW caching of probe-tainted modules cost us 30 min this session.
- All carry-forward "Things NOT to do" from handoff-5 §"Things NOT to do" still apply unchanged (especially: do NOT change `tick()` for non-RUNNING states, do NOT revert HWSYNC handler / SAB-backed `appl_ptr` / SDL2 fix-B patch, do NOT change `want.samples` back to 800).

## Open items rolled forward from handoff-5 (still open)

- **§A — mmap-status broader fix.** `crates/kernel/src/audio/mmap.rs::map_status_page` / `map_control_page` return anonymous pages disconnected from the kernel's `audio.mmap_status`. Fix-B sidesteps it for SDL2 polled mode by going through `SNDRV_PCM_IOCTL_STATUS`; any other ALSA consumer using `snd_pcm_avail_update` directly still sees `avail = buffer_size` forever. Two design paths: SAB-backed mmap pages or implementing `SNDRV_PCM_IOCTL_SYNC_PTR`.
- **§B — SDL2 patch pristine verification.** Delete `packages/registry/sdl2/sdl2-src/` and re-run `cargo xtask build-deps resolve sdl2` to confirm `0002-polling-audio-eagain.patch` applies cleanly against pristine SDL2-2.30.0.
- **§C — Spidermonkey cowsay vitest.** Deterministic, pre-existing. Wait for upstream `e73532843` to merge to main (or cherry-pick the 4-line MANIFEST patch on a separate branch).
- **§E — Working tree state for commit.** Once visual is back, the diff is a single PR. PR body should now ALSO mention the four `host/src/kernel.ts` additions this session, and explain that the kernel WASM MUST be rebuilt for the new audio exports to be callable.

## Standing instruction for the next session — PRINT THIS SENTENCE

> *"Read `docs/plans/2026-06-17-sdl2-browser-rendering-handoff-6.md` first, then its predecessors `-5.md`, `-4.md`, `-3.md`, `-rendering-handoff-2.md`, `-rendering-handoff.md`, `-fix-handoff.md`. Branch is `explore-dri-sdl2`, tip still `4f88111bb` (NOT pushed, PR #709 untouched). **AUDIO §C is RESOLVED and reproducible from a fresh boot** after handoff-6 added four missing pieces to `host/src/kernel.ts` (KernelCallbacks.firstKmsCanvasCrtc + three audio wrapper methods: audioInitApplPtrSab/audioGetHwPtr/audioGetState — all bridging Rust exports the handoff-5 kernel source had but the binary lacked). **NEW REGRESSION: SDL2 canvas paints nothing** (blank/black) even though audio is clean, no console errors. The new `DRM_IOCTL_MODE_ADDFB` handler at `crates/kernel/src/syscalls.rs:1379` is REQUIRED (removing it broke audio AND visual — sdl2.wasm rev4 hard-depends on it) so the visual bug is elsewhere in the kernel-ADDFB → host_kms_addfb → KMS canvas wiring (handoff-6 §"the actual visual bug" theory A-D). **First step:** add `host_debug_log` calls at three points inside the ADDFB handler in `syscalls.rs:1379` (entry, after pitch check, after `host.kms_addfb`), rebuild kernel via `cargo build --release -p kandelo -Z build-std=core,alloc && cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm local-binaries/kernel.wasm`, hard-reload the demo at 127.0.0.1:5403/?demo=sdl2, watch console. **DO NOT** use `console.error` probes in `host/src/kernel.ts` hot paths (Vite HMR/SW caching turns them into pain). Vite restart command: `bash scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx vite --host 127.0.0.1 --port 5403 --strictPort'`. SDL2 cache at `~/.cache/kandelo/libs/sdl2-2.30.0-rev4-wasm32-15f95860/` (libSDL2.a mtime 21:31:26 today, NOT rebuilt by `bash build.sh`). Tests: cargo not re-run after the ADDFB-restore rebuild, run it first. Playwright `kandelo-sdl2.spec.ts` will now FAIL its canvas spread gates — that confirms the visual regression is real, not a tab-only thing. The spidermonkey cowsay vitest is a deterministic pre-existing bug fixed upstream at commit `e73532843` (4-line MANIFEST patch, branch `origin/polecat/capable/kad-wtb.17@hq-06x0`) — leave it alone. Auto-mode default; bias to action on read-only investigation, pause before commit/push/PR. Vite dev server should be on 5403 (restart if dead); kernel.wasm at `local-binaries/kernel.wasm` (22:59:03 today) is the canonical binary."*
