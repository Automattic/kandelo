# DRI port onto kandelo:main — session 47 handoff (SDL2 Phase A — libdrm package A1+A2 landed)

Continuation of [handoff-46](./2026-06-15-dri-kandelo-port-handoff-46.md). Session 47's job was the milestone-D pivot: read the rest of `docs/plans/2026-06-29-sdl2-port-plan.md` and start Phase A Task A1 (libdrm package scaffold). Ended with **Phase A Tasks A1 + A2** committed on a new branch off audio PR #698's tip, plus an unresolved architectural call about the in-tree libdrm stub coupling.

## TL;DR — read this twice

1. **New branch: `explore-dri-sdl2-shims`** off `d1b1156e8` (audio PR #698 tip = `explore-dri-evdev-and-alsa`). Single commit so far: **`a763e24c3` — `Vendor upstream libdrm 2.4.120 as a packages/registry recipe`** (3 files, +246/−0). PR #1 (`sysroot(sdl2-shims): libdrm + alsa-lib + libinput-lite`) is NOT open yet — it opens at A8, after all three shims + sysroot wiring land.

2. **Plan-vs-repo schema divergence resolved.** Plan 7's `examples/libs/<name>/` with abstract TOML schema does NOT match repo's actual `packages/registry/<name>/` with `kind="library"` / `kernel_abi` / `depends_on` / `[source].url+sha256` (tarball) / `[outputs]`. **User confirmed: adapt to repo conventions.** `packages/registry/libdrm/{package.toml, build.toml, build-libdrm.sh}` matches the libxml2/libpng/ncurses shape.

3. **libdrm 2.4.120 actually builds.** Resolver fires the build script via `cargo run -p xtask -- build-deps resolve libdrm`; output is `lib/libdrm.a` (96 KB) + `include/drm/{drm.h, drm_mode.h, drm_fourcc.h, drm_sarea.h}` + `include/libdrm/{xf86drm.h, xf86drmMode.h}` under `/Users/mho/.cache/kandelo/libs/libdrm-2.4.120-rev1-wasm32-d41b98f4/`.

4. **Source-tarball sha256:** `3bf55363f76c7250946441ab51d3a6cc0ae518055c0ff017324ab76cdefb327a` (libdrm-2.4.120.tar.xz from `https://dri.freedesktop.org/libdrm/`). Already pinned in `package.toml`.

5. **Three non-obvious cross-compile fixes are embedded in `build-libdrm.sh`** — DO NOT lose these on a rewrite:
   - `-D__linux__=1` — selects libdrm's Linux ioctl-macro flavour. The BSD branch (`xf86drm.h` lines 59–70) references `IOC_OUT` / `IOC_IN` from `<sys/ioccom.h>` which musl doesn't ship.
   - `-DMAJOR_IN_SYSMACROS=1` — points `xf86drm.c` at musl's `<sys/sysmacros.h>` for `major()` / `minor()`. Without it the `MAJOR_IN_MKDEV` and `MAJOR_IN_SYSMACROS` `#ifdef` blocks both skip and the symbols are undeclared.
   - **`linux/types.h` + `asm/ioctl.h` shim headers** generated into `$BUILD_DIR/{linux,asm}/`. The DRM UAPI starts with `#include <linux/types.h>` (kernel-style `__u8` / `__u32` / `__kernel_size_t` typedefs — Linux UAPI, NOT libc surface) and `#include <asm/ioctl.h>`. Musl ships neither. The shims forward to `<stdint.h>` + `<sys/ioctl.h>` (musl's `bits/ioctl.h` already defines `_IOC` / `_IO` / `_IOW` / `_IOR` / `_IOWR`). Also typedefs `__kernel_size_t` / `__kernel_ssize_t` / `__kernel_long_t` / `__kernel_ulong_t` which `drm.h` references at struct field declarations.
   - `gen_table_fourcc.py` runs as a build step — `xf86drm.c` `#include`s `generated_static_table_fourcc.h` which is meson-generated from `drm_fourcc.h`.

6. **The `xf86drm_compat.h` content/comment mismatch flagged in plan 7's pre-impl review #6 IS fixed in this commit** — comment now accurately describes the feature-test macros (`HAVE_SYS_SYSCTL_H=0`, `HAVE_VISIBILITY=1`, plus the two ioctl/sysmacros fixes above), not "stubs for setlocale, getpriority, sysconf".

## What was NOT done this session

- **A3 — libdrm_smoke integration test.** The existing `programs/libdrm-kms-smoke.c` + `host/test/dri-libdrm-kms.test.ts` (left over from plan 4's earlier work) already exercise `drmModeGetResources` / `GetConnector` / `GetEncoder` / `GetCrtc` / `AddFB2` / `RmFB` / `SetMaster` / `DropMaster` against the in-tree `libc/glue/libdrm_stub.c`. With upstream libdrm wired into the sysroot, that test becomes A3's verification. **Not run this session.**
- **A4–A6 — alsa-lib subset + patch + libinput-lite stub.** Pure pending; not started.
- **A7 — Sysroot wiring (replace stub).** Attempted, then **reverted** mid-session. See "Open architectural items" below.
- **A8 — Gauntlet + PR #1 open.** Pending.
- **PR #698 (audio) CI watch + post-merge gauntlet.** Pending per handoff-46 §"Open todos for session 47" #1–#3. Did not open `gh pr checks 698 --watch` this session.
- **Plan-2/3 follow-up PRs (libEGL.a / libGLESv2.a / `gbm_surface_*`).** Still blocked on plans 2/3 — those PRs block Phase B (SDL2 vendor PR #2), not Phase A (this PR). Not in scope for session 47.

## Decisions that override prior handoffs

- **Plan 7's `examples/libs/<name>/` path is DEAD for this implementation.** Repo's `packages/registry/<name>/` wins. Plan body has not been amended — fix once `[package.toml/build.toml]` shape is settled across all three shims. Files at `examples/libs/{libdrm,alsa-lib,libinput-lite,sdl2}/` should NOT be created by future sessions.
- **Plan 7 A1's `package.toml` schema (`name`, `version`, `[source].type="git"`, `[deps]`, relative `script_path`) is DEAD.** Use the libpng/libxml2 shape: `kind="library"`, `kernel_abi=<current>`, `depends_on=["<dep>@<ver>"]`, `[source].url+sha256` tarball, `[license]`, full-repo-root-relative `script_path`, `[outputs].{libs,headers,pkgconfig}`. **Tarball sources only — no `type="git"` packages exist in the repo.**
- **`build.toml` `commit` field** is the project recipe-provenance commit (not the upstream source commit). Used `d1b1156e8d166d1fd596806d4ecd000b15241cac` (branch base) for now; bump on each meaningful recipe change so `build_deps.rs` cache-key invalidates.
- **`kernel_abi = 15`** on packages added on this branch (the branch base `d1b1156e8` has `ABI_VERSION=15`; on `explore-direct-rendering-infrastructure` worktree HEAD `7c9dd5872` it's still 14 — so verify before adding new packages from the SDL2 worktree's HEAD).

## Open architectural items the user should weigh on before A7

### #1 — libdrm stub-replacement couples libgbm_stub.c

The user explicitly picked **"Replace stub with upstream libdrm"** (option 1) over "Parallel coexistence" (option 2) for the new package's relationship with `libc/glue/libdrm_stub.c`. Mid-session I started wiring `scripts/build-musl.sh` step 10 to copy upstream libdrm artifacts into `$SYSROOT/{lib,include}/` instead of building from `libc/glue/libdrm_stub.c`, **then reverted** when the libgbm coupling surfaced:

- `libc/glue/libgbm_stub.c` (275 lines) `#include`s `<gbm.h>`, `<xf86drm.h>`, `<drm/drm.h>`, `<drm/drm_mode.h>`, `<drm/drm_fourcc.h>`. Replacing the libdrm headers wholesale changes what `libgbm_stub.c` sees at compile time — the overlay's `xf86drm.h` is 69 lines (stub subset) while upstream's is 978 lines (full API). Risk: `libgbm_stub.c` may fail to compile or behave subtly differently.
- The overlay's `drm/{drm.h, drm_mode.h, drm_fourcc.h}` files are very close to upstream (overlay drm.h 1416 lines vs upstream 1408 — slight version drift) but not byte-identical. Plan 4's static-assert was meant to ensure size compatibility against `include/uapi/drm/drm_mode.h`, but the assertion runs against the overlay headers today, not upstream.

**Two viable continuations** for session 48:

1. **Replace AND fix libgbm coupling in the same step.** Wire upstream libdrm into sysroot (step 10 modified to `cargo run -p xtask -- build-deps resolve libdrm` + cp). Delete `libc/musl-overlay/include/{xf86drm.h, xf86drmMode.h, drm/{drm.h, drm_mode.h, drm_fourcc.h}}`. Delete `libc/glue/libdrm_stub.c`. Rebuild — fix any `libgbm_stub.c` compile errors that surface (likely none, since upstream is a superset). Re-run `host/test/dri-libdrm-kms.test.ts` as A3 verification. If green, commit; if red, diagnose kernel-side UAPI mismatch.

2. **Parallel coexistence (the option NOT picked, but lower-risk).** Keep the in-tree stub at `sysroot/lib/libdrm.a`; SDL2 explicitly links upstream's archive from the resolver cache via `WASM_POSIX_DEP_LIBDRM_DIR`. Two `libdrm.a` files coexist; risk of consumer confusion but no in-tree code deletion.

Recommendation **(1)** — the user's explicit choice; the libgbm coupling is mechanical (likely zero diff in compile output since upstream's headers are a superset of the overlay's). But verify dri-libdrm-kms.test.ts passes against upstream before deleting anything, as that's the kernel-UAPI smoke gate.

### #2 — How A4 (alsa-lib subset) handles existing libc/glue ALSA path

There may or may not be an in-tree alsa-lib stub. Did not check this session. Before starting A4, run `find libc -name "libasound*" -o -name "*alsa*"` to see if plan 6's audio work shipped a hand-written alsa stub similar to libdrm. If yes, the same coexistence-vs-replace question applies.

### #3 — `build-musl.sh` cargo dependency

`scripts/build-musl.sh` currently does NOT call `cargo` directly. Adding `cargo run -p xtask -- build-deps resolve libdrm` to step 10 introduces a cargo+nix-dev-shell dependency on every musl rebuild. This is probably fine (CI already runs musl builds via `scripts/dev-shell.sh`), but worth flagging — and worth checking whether `scripts/dev-shell.sh` is already the entry point for CI musl rebuilds before wiring this.

## Phase A task status

| Task | Status | Notes |
|---|---|---|
| A1 — libdrm package scaffold | **DONE** (committed in `a763e24c3`) | Adapted to repo schema (not plan's literal schema) |
| A2 — libdrm-KMS actual build | **DONE** (committed in `a763e24c3`) | `libdrm.a` 96 KB, headers under `include/{drm,libdrm}/` |
| A3 — libdrm_smoke integration test | **PENDING** | Existing `programs/libdrm-kms-smoke.c` + `host/test/dri-libdrm-kms.test.ts` work as A3 verification once upstream wired into sysroot |
| A4 — alsa-lib subset scaffold + build | **PENDING** | See open-arch #2 first |
| A5 — alsa-lib `snd_pcm_open("default")` short-circuit | **PENDING** | Real patch file under `packages/registry/alsa-lib/patches/0001-default-to-hw00.patch` (per pre-impl review fix #4) |
| A6 — libinput-lite no-op stub | **PENDING** | Smallest of the three; ~200 LoC |
| A7 — Sysroot wiring | **PENDING** | See open-arch #1 first |
| A8 — Full gauntlet + open PR #1 | **PENDING** | Single bundled commit per session 46 decision |

## Reference — locations after session 47

| Thing | Where |
|---|---|
| SDL2 work branch | `explore-dri-sdl2-shims` tip `a763e24c3`, off `d1b1156e8` |
| SDL2 plan worktree | `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/` |
| SDL2 plan doc | `docs/plans/2026-06-29-sdl2-port-plan.md` (2076 lines — **fully read this session**) |
| Audio PR #698 branch | `explore-dri-evdev-and-alsa` tip `d1b1156e8` in audio worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/` |
| Resolver cache for libdrm | `/Users/mho/.cache/kandelo/libs/libdrm-2.4.120-rev1-wasm32-d41b98f4/` |
| In-tree libdrm stub (still active) | `libc/glue/libdrm_stub.c` (391 lines) — feeds `sysroot/lib/libdrm.a` via `scripts/build-musl.sh` step 10 |
| In-tree libgbm stub (untouched) | `libc/glue/libgbm_stub.c` (275 lines) — includes the libdrm headers; coupling risk #1 |
| In-tree overlay libdrm headers | `libc/musl-overlay/include/{xf86drm.h (69 lines), xf86drmMode.h (157), drm/drm.h (1416), drm/drm_mode.h (1362), drm/drm_fourcc.h (1614)}` |
| Existing libdrm Vitest test | `host/test/dri-libdrm-kms.test.ts` + `programs/libdrm-kms-smoke.c` (use as A3) |
| Dev shell entry | `export PATH="/nix/var/nix/profiles/default/bin:$PATH"; bash scripts/dev-shell.sh ...` |
| xtask resolver invocation | `cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps resolve <name>` |
| xtask cache path query | `cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps path <name>` |

## Trade-offs already locked in by this session (don't relitigate)

- **`packages/registry/<name>/` not `examples/libs/<name>/`** — repo conv beats plan-doc abstraction. Plan body should be amended (low priority).
- **Tarball + sha256 source, not git** — repo validator rejects `[source].type="git"`; no precedent in `packages/registry/`.
- **Branch rooted at audio PR #698 tip `d1b1156e8`, not `main` and not `explore-direct-rendering-infrastructure`** — per handoff-46 §"Stack base" + user instruction. PR #1's base will be `explore-dri-evdev-and-alsa` (or whatever name that branch has at PR-open time).
- **No `superpowers:subagent-driven-development` skill invoked** — that skill is referenced in the plan and handoff-46's standing instruction but is NOT in this Claude Code install's user-invocable skill list. Falling back to manual TaskCreate-driven execution; this is fine and the plan progresses task-by-task.
- **`xf86drm_compat.h` comment fix from plan 7 pre-impl review #6** — applied this session.

## Open todos for session 48

| # | Task | Blocker? |
|---|---|---|
| 1 | Resolve open-arch #1: decide replace-and-fix-libgbm vs parallel coexistence. Likely option 1 per user's prior pick. | Yes — A7 |
| 2 | A7 — wire upstream libdrm into sysroot via `scripts/build-musl.sh` step 10 (replace stub) or via per-program build flags (parallel). | Yes — A3 verification |
| 3 | A3 — re-run `host/test/dri-libdrm-kms.test.ts` against upstream libdrm. Test exists; just needs sysroot wired and `programs/libdrm-kms-smoke.c` rebuilt. | Yes — confirms A2's output works against the kernel |
| 4 | A4 — alsa-lib package recipe + build. First check `find libc -name "libasound*" -o -name "*alsa*"` for existing in-tree alsa code (open-arch #2). | No |
| 5 | A5 — real patch file `packages/registry/alsa-lib/patches/0001-default-to-hw00.patch` for `snd_pcm_open("default")` short-circuit. Per pre-impl review fix #4 — NOT the sed-based approach the plan body shows. Plus `conf_stubs.c` per fix #5. | No |
| 6 | A6 — libinput-lite stub package. ~200 LoC; minimal. | No |
| 7 | A8 — gauntlet + open draft PR #1, base `explore-dri-evdev-and-alsa`, single bundled commit (per session 46 decision). | No |
| 8 | Watch PR #698 CI (`gh pr checks 698 --watch`) — handoff-46 carryover. | No |
| 9 | Audio worktree gauntlet on `d1b1156e8` (cargo / vitest / libc-test / posix-test / browser-demo) — handoff-46 carryover. | No |
| 10 | Plan 7 body amendment: replace `examples/libs/` references with `packages/registry/` and the abstract TOML schema with the repo's real one. Low priority — code wins; docs can drift until they bite a reviewer. | No |

## Standing instruction for session 48 — print THIS sentence

> *"Read `docs/plans/2026-06-15-dri-kandelo-port-handoff-47.md` first (in the SDL2-plan worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Branch `explore-dri-sdl2-shims` tip is `a763e24c3` — Phase A Tasks A1+A2 of the SDL2 port (libdrm package recipe + working upstream-2.4.120 build at `packages/registry/libdrm/`) are landed; A3–A8 are pending. Continue with A7 (wire upstream libdrm into the sysroot — the user picked 'replace stub' but the libgbm_stub.c coupling needs verifying first; see handoff-47 §'Open architectural items #1'), then A3 (run `host/test/dri-libdrm-kms.test.ts` against the upstream-backed sysroot to confirm A2's output answers the kernel's KMS ioctls correctly), then A4–A6 (alsa-lib + libinput-lite). PR #1 opens at A8 as a SINGLE bundled commit (per session 46's anti-grouping decision) with base `explore-dri-evdev-and-alsa`. DO NOT target `main`. DO NOT resurrect per-commit grouping. DO NOT stage `docs/plans/*` or handoff markdowns into the PR. DO NOT use `examples/libs/<name>/` — repo uses `packages/registry/<name>/` and that's the locked schema for this work. The three non-obvious cross-compile fixes in `build-libdrm.sh` (`-D__linux__=1`, `-DMAJOR_IN_SYSMACROS=1`, the `linux/types.h` + `asm/ioctl.h` shims) are load-bearing — preserve them on any rewrite. `export PATH=\"/nix/var/nix/profiles/default/bin:$PATH\"` before `scripts/dev-shell.sh`. Auto-mode default; bias to action; pause on architectural calls."*
