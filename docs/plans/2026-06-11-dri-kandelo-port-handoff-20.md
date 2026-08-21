# DRI port onto kandelo:main — session 20 handoff

Continuation of [2026-06-10-dri-kandelo-port-handoff-19.md](./2026-06-10-dri-kandelo-port-handoff-19.md). Read that first for the full chain back. This doc covers session 20 — push, PR open, stutter verified, roadmap surveyed, fork cleanup. Pre-Q4.

## TL;DR — read this twice

1. **Branch shipped.** Pushed `explore-direct-rendering-infrastructure` (HEAD `7c9dd5872`, 23 commits ahead of `main`) to `Automattic/kandelo` and opened **draft PR #678** — *"Add Direct Rendering Infrastructure (DRI/KMS) and Kandelo Modeset pane"*. Body landed verbatim from the v19-built draft. URL: https://github.com/Automattic/kandelo/pull/678.

2. **Stutter-when-idle verified gone.** User confirmed the Modeset pane behavior didn't change after manual browser check via `./run.sh browser`. This was the one unverified item v19 carried forward; v17's three suspects (50 ms `sys_poll` fallback, modeset.c `read+usleep`, `OffscreenCanvas` commit timing) are all moot — visually correct.

3. **Kernel size analysis (vs published main kernel `abi14-wasm32-5fd1a94b`):**

   | Build | Bytes | KiB |
   |---|---:|---:|
   | main | 663,713 | 648.2 |
   | branch HEAD | 693,907 | 677.6 |
   | **Δ** | **+30,194** | **+29.5 KiB (+4.55%)** |

   ~97 % of the growth landed in the **Code** section. **Imports** grew by 22 entries — all the new `host_gbm_*` / `host_kms_*` / `host_gl_*` / `host_proc_*` hooks. **Exports** net +1 (4 added: `kernel_vblank`, `kernel_mmap`, `kernel_kms_commit_count`, `kernel_kms_last_frame_us`; 3 stale GPU-tier removed by `7c9dd5872`). Data, Global, Table unchanged. The kernel didn't gain fluff — it gained handler code. ~8 bytes per net source line: tight.

4. **Roadmap surveyed.** Eight plans in `docs/plans/`, all dated:

   ```
   2026-06-10-dri-q4-vblank-gating-plan.md       ◀ immediate next
   2026-06-15-dri-evdev-plan.md                  ┐
   2026-06-22-dri-alsa-plan.md                   ├ DRI v2 (kernel work)
   2026-06-29-sdl2-port-plan.md                  ◀ milestone D (sysroot-only proof)
   2026-07-06-wpkdraw-plan.md                    ┐
   2026-07-13-wpkcompositor-plan.md              │
   2026-07-20-wpk-shell-plan.md                  ├ desktop ecosystem (sysroot/user-space)
   2026-07-27-wpk-seed-apps-plan.md              ┘
   ```

5. **Fork removed.** User deleted `mho22/wasm-posix-kernel`. Repointed `origin` of `/Users/mho/Work/projects/kandelo/wasm-posix-kernel/.git` to `git@github.com:Automattic/kandelo.git`; removed the now-redundant `upstream` remote. Worktrees share the same `.git`, so the change is repo-wide. No audit was run for fork-only branches (the 40+ branches that existed only on `mho22` — DOOM line, `dri-kms-kernel`, `dri-multiplexer-phase-c`, several `emdash/*` worktree branches) before deletion; if anything is missed downstream, the commit objects are GC'd after ~90 days.

## Mission for session 21

**Q4 vblank gating — kernel-side fix.** Read `docs/plans/2026-06-10-dri-q4-vblank-gating-plan.md`. The work-list is in there; the key new dependency is a `process_table::with_processes` accessor that hands `&mut Process` for every live process so `dri::vblank_tick` (called from `kernel_vblank`) can walk every open card0 fd's `pending_flips`. Today `handle_dri_card_ioctl` retires `pending_flips` immediately into `event_ring`, so `drmHandleEvent` returns at ioctl rate (~2 kHz) and `modeset.c` masks it with a program-level 60 Hz throttle. Architectural fix: drain only from `kernel_vblank` at vblank cadence. `modeset.c`'s program throttle is harmless either way and should not be removed in the same PR (regression-safety).

**Branch off `main`, not off `explore-direct-rendering-infrastructure`.** Q4 is a follow-up PR, not an addendum. PR #678 may merge first, may not — keep them independent. If #678 has merged by the time you start, branch off `main` after pulling. If it hasn't, branch off `main` anyway and accept that you'll have a tiny merge after #678 lands.

## Findings worth preserving (file these as separate issues post-merge)

### 1. Resolver bug — `xtask build-deps resolve` symlinks libs but not headers

Hit on `openssl` + `zlib` during the browser stutter check. The cached extractions at `/Users/mho/.cache/kandelo/libs/<pkg>-<ver>-<arch>-<hash>/` are complete (have both `lib/` and `include/`), but the resolver only creates symlinks under `sysroot/lib/`. `sysroot/include/openssl/` and `sysroot/include/zlib.h` stay missing.

Compounding: `has_zlib()` and `has_openssl()` in `run.sh` (lines 310-311) only check for the `.a` file, so the guard says "already installed" and `build_zlib` / `build_openssl` short-circuit on the next run. The libs are linked, the headers are not, and source-builds of downstream packages (curl, sqlite, …) fail at configure with "`<sysroot>` is a bad `--with-openssl` prefix".

Workaround for this session:
```bash
ln -sf /Users/mho/.cache/kandelo/libs/openssl-3.3.2-rev1-wasm32-7c06f906/include/openssl sysroot/include/openssl
ln -sf /Users/mho/.cache/kandelo/libs/zlib-1.3.1-rev1-wasm32-f20ca548/include/zlib.h     sysroot/include/zlib.h
ln -sf /Users/mho/.cache/kandelo/libs/zlib-1.3.1-rev1-wasm32-f20ca548/include/zconf.h    sysroot/include/zconf.h
```

Symlinks were removed after the stutter check (untracked, gitignored).

Right fix is in the resolver — either symlink `include/` too when the package declares headers, or have `build_zlib` / `build_openssl` install headers from cache regardless of the lib-only guard. Out of scope for the DRI branch.

### 2. Browser demo gallery drift — same "142 vitest carry-forward" pattern v19 noted

`./run.sh browser` static imports a whole gallery of demo binaries via `@binaries/...?url` in `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` + `apps/browser-demos/lib/init/shell-lazy-files.ts`. Several entries fail the Vite import-graph at module-load time:

- **Stale** (file present, fails `hasWasmArtifactPolicyFailures` / `hasVfsArtifactPolicyFailures` — ABI mismatch or fork-instrumentation drift): `less.wasm`, `wordpress.vfs.zst` (likely more — exhaustive scan not run).
- **Missing**: `nginx-vfs.vfs.zst`, `nginx-php-vfs.vfs.zst`.

Workaround for this session: patched `apps/browser-demos/vite.config.ts` `resolveBinariesAlias` to fall back to a stub path instead of `this.error(...)`. Modeset pane doesn't fetch any of these — `?url` only generates URL strings; runtime fetch is lazy. Patched, verified stutter, reverted.

Right fix is a fleet rebuild of the affected packages plus a backfill on the `binaries-abi-v14` release index. Same surface that v19 already documented as "pre-existing exnref / instrumentation drift, unrelated to DRI". Not blocking PR #678.

### 3. SpiderMonkey SDK pinning under Nix

SpiderMonkey's build refuses SDK 14.4 ("too old, please upgrade to at least 15.5"). Nix's clang picks up an old 14.4 SDK by default. Override with:

```bash
scripts/dev-shell.sh bash -c 'export WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk && ./run.sh browser'
```

`WASM_POSIX_MACOS_SDK_DIR` is NOT on the `--keep` list in `scripts/dev-shell.sh`, so it MUST be exported inside the inner `bash -c`. Setting it outside the dev shell does nothing — the var gets scrubbed.

On the user's machine `MacOSX.sdk` resolves to 26.5, well above the 15.5 minimum. If a future Xcode update breaks that symlink, point to `MacOSX15.sdk` or higher explicitly.

## What I deliberately did NOT touch

- **Untracked handoff + plan docs** in `docs/plans/` (`2026-06-10-dri-kandelo-port-handoff-1{0..9}.md`, all the `dri-*-plan.md` and post-DRI plan docs, `dri-q4-vblank-gating-plan.md`). User explicitly said "don't stage docs/plans" when creating PR #678. They remain untracked in the worktree; the PR body links to two of them by relative path, GitHub renders them as broken links until they're separately committed (acceptable — they're internal planning docs, not user-facing).
- **The 47 pre-existing cargo build warnings** flagged in v18.
- **The 142 full-sweep vitest carry-forward failures.** Not in any DRI file.
- **Fork audit before deletion.** User chose to delete without scanning the 40+ fork-only branches.

## State at end of session

- `7c9dd5872` is the branch HEAD. No new commits this session.
- Working tree clean apart from pre-existing submodule pointer drift (`libc/musl`, `tests/sortix/os-test`) and untracked plan/handoff docs in `docs/plans/`.
- PR #678 open as **DRAFT** on `Automattic/kandelo`.
- `origin` → `git@github.com:Automattic/kandelo.git`. `upstream` removed.
- Workaround symlinks under `sysroot/include/` removed. `vite.config.ts` patch reverted.

## Standing instruction for session 21

**Print this sentence in the next session's first turn so I have a single fixed entry point:**

> *"Read `docs/plans/2026-06-11-dri-kandelo-port-handoff-20.md` first. Branch `explore-direct-rendering-infrastructure` is at `7c9dd5872` with PR #678 open as DRAFT on `Automattic/kandelo`. Mission is Q4 vblank gating — read `docs/plans/2026-06-10-dri-q4-vblank-gating-plan.md` and implement the `process_table::with_processes` accessor + drain logic inside `kernel_vblank()`. Branch off `main` (not off `explore-direct-rendering-infrastructure`) — Q4 is a follow-up PR. Source `/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh` before invoking `scripts/dev-shell.sh`. If any source-build fires (curl / sqlite / SpiderMonkey), the resolver-header bug from §1 of v20 means you may need to re-symlink `sysroot/include/openssl` + `zlib.h` + `zconf.h` from `/Users/mho/.cache/kandelo/libs/<pkg>/include/`. SpiderMonkey source-builds need `WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` exported inside the inner `bash -c`. Do NOT bump `ABI_VERSION` unless kernel exports change semantically — Q4 is expected to be additive (a new accessor, no signature changes to existing exports). Dual-host parity: confirm Node + Browser handle the new vblank cadence identically — `kernel_vblank` is called the same way on both, but `OffscreenCanvas` commit timing on the worker is browser-specific and worth a manual check. `modeset.c`'s program-level 60 Hz throttle is harmless either way; do NOT remove it in the same PR. Wait for user input before each commit."*
