# DRI port onto kandelo:main — session 6 handoff

Continuation of [2026-06-09-dri-kandelo-port-handoff-5.md](./2026-06-09-dri-kandelo-port-handoff-5.md). Read that first — this doc only covers what changed in session 6.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Per the user's standing instruction the branch lives on Automattic/kandelo only; do **not** push to mho22.

## Branch state at end of session 6

- Working branch: `explore-direct-rendering-infrastructure`.
- **No new commits landed in this session.** Eleven local commits as of session-5 tip; the would-be Commit 11.5 (build-programs.sh DRI linkage fix) was prepared but `git commit` was interrupted by the user mid-call and never finished — the working-tree diff is still in `scripts/build-programs.sh`.
- The Playwright spec from would-be Commit 12 was written but never committed; it lives at `apps/browser-demos/test/kandelo-modeset.spec.ts` as an untracked file.

```
873093270 kandelo(dri): wire Modeset surface into MachineView + modeset preset  ← still the tip
…(see handoff-5 for commits 1–11)…
```

## What this session actually did

This session was **only** about running the gauntlet locally (something handoff-4/5 couldn't do — no nix on that host), discovering the libdrm-linkage regression in `scripts/build-programs.sh`, drafting the Playwright spec, and starting to write Commit 11.5 + Commit 12.

### Local environment notes for next session

- **Nix is installed but not on PATH by default.** It lives at `/nix/var/nix/profiles/default/bin/nix` (v2.34.7). Add it explicitly:
  ```bash
  export PATH="/nix/var/nix/profiles/default/bin:$PATH"
  ```
  Then `scripts/dev-shell.sh bash …` works as documented in CLAUDE.md.
- The bare `nix develop` invoked by `scripts/dev-shell.sh` uses `--ignore-environment --keep …`, so PATH is rebuilt inside the shell — only the outer `nix` binary needs to be findable.
- A full `bash build.sh` takes ~10 minutes here (kernel cargo + host TS + rootfs build, which source-builds packages via the resolver).

### Gauntlet state at end of session 6

After running `bash build.sh` once (kernel + host TS + programs + rootfs all freshly built):

| Gate | Status | Notes |
|---|---|---|
| `cargo test -p kandelo --target aarch64-apple-darwin --lib` | ✅ **929 passed**, 0 failed | Unchanged from session 5. |
| `cd host && npx vitest run` | ⚠️ **7 failed / 702 passed / 110 skipped (822 tests)** | Was 36 failures before the linker fix; the unstaged `scripts/build-programs.sh` change brings it to 7. Of the 7 remaining: 5 are DRI runtime/fixture mismatches that need per-test triage (see below); 2 are pre-existing wasm64 `hello64.wasm` misses that are out of scope (no sysroot64 on this host). |
| `scripts/run-libc-tests.sh` | ✅ 0 FAIL, 21 XFAIL, 1 FLAKE-PASS, 1 TIME (`functional/spawn`) | All XFAILs/TIME acceptable per CLAUDE.md. |
| `scripts/run-posix-tests.sh` | ✅ 0 FAIL, 3 XFAIL (`mlock/12-1`, `munmap/1-{1,2}`), 2 SKIP (`sched_get_priority_{max,min}/1-3`) | All acceptable. |
| `bash scripts/check-abi-version.sh` | ❌ Drifted (expected; same three additive exports `kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us` as in v5). Closing Commit 13 fixes. |

### The libdrm/libgbm linkage regression (would-be Commit 11.5)

**Root cause.** The DRI port's build script (committed on mho22 as part of the original PRs) had a per-program case block that linked `libdrm.a` / `libgbm.a` into DRI programs and auto-appended `libEGL.a` / `libGLESv2.a` based on header scanning. The "bring-forward" commit `b25ef5942` did not re-apply that block to `scripts/build-programs.sh` against kandelo:main's evolved version, leaving the script with a uniform `build_program "$src" "$OUT_DIR_32"` call. Without those archives the linker (under `-Wl,--allow-undefined`) silently emitted `drmSetMaster`, `drmModeGetResources`, `gbm_create_device`, … as `env.*` undefined imports. The host's `worker-main.ts` stubs them with `throw new Error("Unimplemented import: env.<name>")`, so any DRI program crashed at instantiation. This was invisible to session-5 because vitest never ran there.

The "169871-byte modeset" mentioned in v5 was a stale artifact from before kandelo:main's `build-programs.sh` overwrote whatever rebuilt it. A fresh `bash build.sh` here produced a 40 622-byte modeset (no libdrm/libgbm linked), then the unstaged fix produced 57 724 bytes.

**Fix shape (unstaged, in `scripts/build-programs.sh`).**

1. Split `LINK_FLAGS` into `LINK_PRE_LIBS` (channel_syscall + compiler_rt + crt1.o) and `LINK_POST_LIBS` (libc.a + -Wl,...) so extra archives can be spliced BEFORE libc.a (libdrm/libgbm reference mmap/ioctl/calloc which libc resolves in the same wasm-ld pass).
2. `build_program` takes optional extra archives after the standard two args (`shift 2; local extra_libs=("$@")`).
3. `build_program` greps the source for `#include <EGL/…>` / `<GLES{2,3}/…>` and auto-appends `libEGL.a` + `libGLESv2.a` when present.
4. The program loop wraps the `build_program` call in a case block:
   - `modeset.c | dri_paint.c | dumb_roundtrip.c` → libgbm.a + libdrm.a (EGL/GLES2 added by auto-detect when applicable, e.g. modeset.c).
   - `libdrm-kms-smoke.c` → libdrm.a only.

**Verification.** `wasm-objdump -x --section=Import` on `local-binaries/programs/wasm32/modeset.wasm` after the fix shows zero `env.drm` / `env.gbm` / `env.gl` / `env.egl` imports.

**The exact draft commit message I had queued** (the `git commit` call was interrupted, so this is what to use when re-running):

```
build(dri): link libdrm/libgbm into DRI programs + auto-link EGL/GLES2

The DRI port's build script came forward from mho22 with a uniform
build_program call that no longer linked libdrm.a / libgbm.a into
DRI programs. Without those archives the linker silently emitted
drmSetMaster / drmModeGetResources / gbm_create_device / ... as
`env.*` undefined imports, and any program that touched libdrm
crashed at instantiation with `Unimplemented import: env.drmSetMaster`.

Restore the per-program extra-libs path that lived in the original
DRI build script:

  - Split LINK_FLAGS into LINK_PRE_LIBS (syscall glue + crt1) and
    LINK_POST_LIBS (libc.a + -Wl,...), so extra archives can be
    spliced BEFORE libc.a — required for the wrappers' internal
    references (mmap, ioctl, calloc, ...) to resolve in a single
    wasm-ld pass.
  - build_program now accepts extra archives after the standard
    two args, and grep-detects `#include <EGL/...>` / `<GLES{2,3}/...>`
    to auto-append libEGL.a + libGLESv2.a (no-op for non-GL programs).
  - The per-program case block routes modeset / dri_paint /
    dumb_roundtrip to libgbm.a + libdrm.a, and libdrm-kms-smoke to
    libdrm.a alone.

Effect on the vitest gauntlet: 36 failing tests → 7 (the latter set
is unrelated to linkage — DRI runtime / fixture mismatches that
predate this branch's bring-forward and need investigation per-test).
```

The user told me **not** to commit yet during this session; resume by re-running that commit (after re-confirming the diff is still the one above).

### The Playwright spec (would-be Commit 12)

Written, untracked, at `apps/browser-demos/test/kandelo-modeset.spec.ts`. Single test that:

1. `goto /?demo=modeset` (with the v4-style `gotoOrSkip` so a missing-binary vite-error overlay skips instead of failing).
2. Waits for the `.kpane-head` whose `.kpane-head-title` matches `/MODESET/` — confirms the surface mounted.
3. Polls the same pane head's inner text for `/[1-9]\d*\s+flips/` — confirms `stats.commitCount` > 0 in the SAB the Modeset pane drains.

Why polling the pane head and not the canvas: `attachKmsDisplay` does `canvas.transferControlToOffscreen()`, so the main thread can no longer read pixels via `getContext("2d")` — fbDOOM's "non-zero pixel" assertion does not work for KMS. The pane's status badge ("N flips · Xµs") is the load-bearing UI signal.

The spec is matched by `playwright.config.ts`'s default `testMatch: "*.spec.ts"` — no config change needed.

**Caveat:** the spec has never been executed yet. It can't be run reliably until either (a) the remaining DRI runtime failures (next section) are fixed so the modeset binary actually produces PAGE_FLIPs in-browser, or (b) the spec is validated against the running app even though vitest's headless modeset test fails for an arguably unrelated reason (the test fixture expects an older `programs/modeset.c` shape — see below).

### The remaining 5 DRI vitest failures (NOT addressed this session)

After the linker fix, vitest still has 7 failing tests in 6 files. Two are pre-existing wasm64 misses (`programs/wasm64/hello64.wasm` not built — needs `sysroot64`, out of scope). The other five are integration failures that need triage:

1. **`test/dri-modeset.test.ts`** — expects stdout to match `/modeset OK frames=(\d+) w=(\d+) h=(\d+)/`. The current `programs/modeset.c` is Pavel's fluid-sim (commit `0357884bf`) which (a) ignores `argv` entirely (`(void)argc; (void)argv;`), (b) never prints "modeset OK", (c) returns 1 from `main` via `FAIL("open /dev/input/mice")` if `/dev/input/mice` doesn't exist. The test was written against the **older** modeset.c from commit `d741378d8` ("examples(dri): modeset demo — page-flip + vblank events via libdrm/libgbm"). Either retarget the test at the new fluid-sim shape, retarget the test at a new `modeset-cli.c`-style fixture binary, or restore the old summary printf in the current modeset.c (not recommended — the binary is now demo code).

2. **`test/dri-smoke.test.ts`** — 5 s vitest default timeout fires. The inner race timeout is 10 s but the outer `it(…)` doesn't override `testTimeout`. Could be a literal timeout (the program hangs after CREATE_DUMB / MAP_DUMB / mmap because PRIME pause never completes), or could be that the `it` needs `it("…", async () => {…}, 20_000)`.

3. **`test/dri-kms-pageflip.test.ts`** — stderr=`short read`. The program reads a `struct drm_event_vblank` from the DRM fd and gets a short read (n != sizeof(ev)). Suggests either the kernel's PAGE_FLIP event delivery is wrong on this branch, or the program's read loop needs an `EAGAIN`/poll iteration that the kernel's centralized worker isn't supporting yet.

4. **`test/dri-dumb-roundtrip.test.ts`** — child reports `FAIL: child pixel (0,0) = 0x00000000; want 0xff000000` after fork → PRIME export → child PRIME import → child mmap. Suggests PRIME export isn't carrying the bo binding through fork, or the child's mmap isn't pulling the SAB region the parent wrote into. Could intersect with `crates/kernel/src/fork.rs` DriOfdState inheritance (commit `50d7934b9`).

5. **`test/dri-cube-pyramid.test.ts`** — both forked processes return rc=1. Likely an EGL/GLES2 stub gap in the host's `host_gl_*` bridge for some path the cube_pyramid demo exercises.

None of these are *regressions* — none of them were passing on this branch before this session (vitest was blocked locally per the v5 handoff). They're load-bearing for "completing any branch" per CLAUDE.md §Test Verification but they are the real DRI integration work that the port hasn't yet finished against kandelo:main's evolved kernel + host.

### Remaining handoff todos (in priority order for next session)

| # | Task | What to do |
|---|---|---|
| 1 | Re-commit the libdrm linkage fix | The unstaged `scripts/build-programs.sh` diff is the right change. `git diff scripts/build-programs.sh` to confirm, then commit with the message in the box above. This is what would-be Commit 11.5 was going to do. |
| 2 | Verify Commit 11.5 still cargo-clean / vitest-improves | `cargo test -p kandelo --target aarch64-apple-darwin --lib` and `cd host && npx vitest run`. Expected: cargo unchanged, vitest = 7 failures (the 5 DRI + 2 wasm64). |
| 3 | Decide what to do about the 5 DRI integration failures | These are real port-completeness work and need user direction. Options: (a) fix them now before opening the PR (per CLAUDE.md gauntlet rule), (b) update the test files to expect the new modeset.c shape where feasible (only #1 in the list above), (c) declare them out of scope and add a known-broken section to the PR body. Ask the user before sinking effort. |
| 4 | Commit 12 (Playwright spec) | The spec file already exists (`apps/browser-demos/test/kandelo-modeset.spec.ts`). Verify it works manually against the running app — start `npx vite --config apps/browser-demos/vite.config.ts --host 127.0.0.1 --port 5401 --strictPort` (or rely on the playwright `webServer` block) and `npx playwright test --project=chromium kandelo-modeset.spec.ts`. Commit only after seeing the spec pass at least once. |
| 5 | Commit 13 (ABI regen + docs) | `bash scripts/check-abi-version.sh update`, confirm only additive (`kernel_vblank`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`), no `ABI_VERSION` bump. Then update `docs/architecture.md`, `docs/posix-status.md`, `docs/porting-guide.md`, `docs/browser-support.md`, `README.md` per CLAUDE.md §Documentation. |
| 6 | Final gauntlet check + PR | After Commits 11.5–13, re-run all five test gates. Open PR against `Automattic/kandelo:main`. **Do not** push to `mho22/wasm-posix-kernel`. |

## Gotchas discovered this session

- **The `OPTIONAL_BINARY_URL` glob in `live-setup.ts` will throw at runtime** if `local-binaries/programs/wasm32/modeset.wasm` is missing or rejected by the resolver's `hasBinaryArtifactPolicyFailures` check. The resolver rejects wasms missing required exports (`__abi_version`, `_start`) or with mismatched ABI version. After my linker fix the modeset wasm has the right exports and ABI, but if a future build re-stripes without libdrm linked, the `?demo=modeset` URL will surface "modeset is not built. Run: ./run.sh build programs" in the console instead of the pane silently showing "waiting for PAGE_FLIP" forever.

- **`scripts/build-programs.sh` doesn't error out when `sysroot/lib/libdrm.a` is missing.** It would silently fall back to the case-block's no-op default. If a future hand-cleaned sysroot regenerates without those archives, the regression returns. Consider adding a `[ -f "$SYSROOT/lib/libdrm.a" ]` guard in the case block, but this isn't blocking for the PR.

- **The Pavel modeset.c opens `/dev/input/mice` and FAILs hard if it's missing** (line 800). The kernel doesn't currently expose `/dev/input/mice`, which means even after the linker fix and even in-browser, `modeset` exits with `perror("open /dev/input/mice")` + return 1, never gets to KMS setup, never commits a PAGE_FLIP. **This is almost certainly why the Playwright spec will not pass against the current modeset.c.** Either (a) the kernel needs an evdev stub at `/dev/input/mice` (there's a session plan for evdev — `docs/plans/2026-06-15-dri-evdev-plan.md`), or (b) the demo's `setup_kms` path needs to tolerate missing input devices, or (c) the spec needs to assert against a different fixture binary. The handoff-4 doc's mention of "the modeset binary spawns and the Modeset pane shows commitCount progress" was aspirational, not verified — the user never ran this end-to-end in a browser either.

- **Build-rootfs spends most of `bash build.sh`'s wall-time** source-building cached packages via `xtask build-deps resolve <pkg>` (sed, findutils, ...). The kernel + host TS finish in the first ~30s. If you're only iterating on programs/, run `scripts/build-programs.sh` directly inside the dev shell.

## Reference points

- **Session 1 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff.md`.
- **Session 2 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff-2.md`.
- **Session 3 handoff**: `docs/plans/2026-06-08-dri-kandelo-port-handoff-3.md`.
- **Session 4 handoff**: `docs/plans/2026-06-09-dri-kandelo-port-handoff-4.md`.
- **Session 5 handoff**: `docs/plans/2026-06-09-dri-kandelo-port-handoff-5.md`.
- **The libdrm shims**: `libc/glue/libdrm_stub.c`, `libc/glue/libgbm_stub.c`, `libc/glue/libegl_stub.c`, `libc/glue/libglesv2_stub.c`. Pre-built into `sysroot/lib/{libdrm.a, libgbm.a, libEGL.a, libGLESv2.a}` — these come from `scripts/build-musl.sh` (libdrm/libgbm) and `scripts/build-gles-stubs.sh` (libEGL/libGLESv2). The "build-musl rebuilds libdrm" assumption isn't reflected anywhere I could find; the .a files in sysroot/lib are dated 2026-06-05 even after this session's full rebuild — they appear to be manually-prebuilt artifacts, which is fragile but not load-bearing for the current commit set.
- **Pavel's modeset.c**: `programs/modeset.c` — EGL/GLES2 fluid sim. Opens `/dev/input/mice` and `/dev/dri/card0`; `setup_kms` does `drmSetMaster` → `drmModeGetResources` → `gbm_bo_create` → `drmModeAddFB2` → `drmModeSetCrtc`; main loop does `drmModePageFlip` + read(drm_fd, struct drm_event_vblank). **Does not exit cleanly on its own** — designed for the demo to be killed externally. The Playwright spec assumes the pane drains stats.commitCount during the program's run.
- **Stats SAB slot layout** (unchanged, set by `CentralizedKernelWorker.tickVblank`):
  - 0: pump frame count (host)
  - 1: last blit timestamp ms
  - 2: scanout width
  - 3: scanout height
  - 4: last blit µs
  - 5: kernel-side PAGE_FLIP commit count
  - 6: kernel-side last frame µs
- **Modeset pane status badge text** (load-bearing for the Playwright spec): `${stats.commitCount} flips · ${stats.lastFrameUs}µs` once `hasFrame` (width > 0 && height > 0), else `"waiting for PAGE_FLIP"`. See `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:135-138`.

## Important constraints, do not violate

(Carried forward from v1–v5, unchanged. Repeat here because v5's drift caught me in the loop.)

- **One PR against `Automattic/kandelo:main`.** Local commit count will be ~13–14 when the dust settles; that's fine for one PR.
- **All five test gates green before the PR opens.** ABI gate is the easy one; vitest's 5 DRI failures are the hard ones and need user direction.
- **Dual-host parity** for any `host/src/` touch. (Nothing in this session touched host code.)
- **No Asyncify, anywhere.**
- **Use the Kandelo React UI pane, not a legacy standalone page.**
- **Ask before any destructive git op.**
- **Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`.**
- **Wait for user input after each commit.** (This is the standing instruction from session 6's opening message.)
