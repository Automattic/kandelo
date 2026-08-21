# DRI port onto kandelo:main — session 30 handoff (Phase B5 landed; Phase C next)

Continuation of [handoff-29](./2026-06-11-dri-kandelo-port-handoff-29.md). Session 30 landed B5 — Phase B is now complete. **Phase C is next: condense C1–C3 (sysroot + demo) into a small number of commits; C4 (manual browser verify) gates the PR.**

## TL;DR — read this twice

1. **Worktree is `explore-dri-evdev-plan`** at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`, branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`. Branched off `explore-dri-q4-vblank-gating` at `001729c67`.

2. **Thirteen commits landed on top of Q4:**
   - `b4c3464ac` — A1 shared ABI (session 24)
   - `fa47afa22` — A2 OFD plumbing (session 24)
   - `d8539d252` — A3 EVIOCG* ioctl dispatch (session 25)
   - `fd1b502d0` — A4 `kernel_input_event` + fan-out (session 25)
   - `479fe65c2` — A5 `sys_read` drain + `sys_poll` POLLIN (session 26)
   - `26393f20d` — A6 close + fork/exec serialise (session 27)
   - `e583f979f` — A7 ABI snapshot regen (session 27)
   - `6a71f593f` — Phase A devil's-advocate cleanup (session 28)
   - `4a15d3669` — B1 InputSource interface (session 29)
   - `cd147db1a` — B2 BrowserInputSource + key-code table (session 29)
   - `f0e83c9eb` — B3 NodeInputSource null-source (session 29)
   - `3d56c505f` — B4 wire `kernel_input_event` + dual-host boot path (session 29)
   - **`1d37940ef` — B5 vitest end-to-end key + pointer + ring overflow (this session)**

3. **One PR, ~14 commits total — 13/~14 in, ~1 to go (Phase C condensed).** Skip per-phase "open PR" steps. Manual browser verify still required before the PR opens.

4. **No PR opened yet.** User hasn't asked. Don't open it until they do.

5. **Phase C is next: sysroot header vendoring (C1) + demo wiring (C2) + browser host plumbing (C3).** Plan body at lines 1929–2070 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree). C4 (manual browser verify, lines 2071–2086) is required before PR but adds no commit.

6. **Wait for user input before each commit.** Standing instruction from handoff-24 still applies. Default to single-commit full tasks; only split if the task obviously exceeds one commit's worth.

## What landed this session (1 commit)

### B5 — `1d37940ef` — `host(input): vitest — end-to-end key + pointer + ring overflow`

Two files (+340, -0):

- **`programs/input-evdev-smoke.c`** (+103) — three-phase fixture, each phase gated on a stdin byte so the host injects events AFTER the OFD exists. `kernel_input_event` fans out at push time, so a pre-open injection would land nowhere. Inline `EVIOCGNAME`/`EVIOCGABS` macros (linux/input.h vendoring is Phase C/C1) + `wpk_event`/`wpk_absinfo` structs + `_Static_assert(sizeof == 24)` sanity. Drain loop reads one record at a time so we can count exactly; blocking read on an empty+clean ring returns 0 → drain terminator.

- **`host/test/input-evdev.test.ts`** (+184) — drives `NodeKernelHost.injectInputEvent` (B4) directly. `it.skipIf(!fixtureBinary)` matches the dri-kms-pageflip pattern. Uses `appendStdinData(pid, KICK)` to release each barrier. Asserts:
  - `EVIOCGNAME` → `"wpk virtual keyboard"`.
  - `EVIOCGABS(ABS_X).maximum` = `CANVAS_W - 1` (1023 with the 1024×768 test canvas).
  - `KEY_A↓` then `SYN_REPORT` round-trip with `BigInt`-arithmetic monotonic-non-decreasing `CLOCK_MONOTONIC` stamps.
  - `REL_X=+5` then `SYN_REPORT`.
  - Overflow: drain count = **1025** (1 synthesised `SYN_DROPPED` at index 0 + 1024 surviving ring records), `ov_last_type/code` is still `EV_KEY/KEY_A` (the **incoming** records were discarded, Linux semantics — see §"Architecturally load-bearing decisions" in handoff-29).

  The test does NOT pass `rootfsImage: "default"` — that requires `rootfs.vfs` which isn't in the cold-start dance. Raw `NodePlatformIO` is enough because `/dev/input/*` is kernel-managed (not VFS-managed).

## Architectural decisions this session

### Drain count = 1025, not 1024

Plan body §B5 (`docs/plans/2026-06-15-dri-evdev-plan.md` line 1909-1910) phrases the expectation as: "ring's first record is `SYN_DROPPED`, then 1023 of the most recent events." That phrasing implies total = 1024 records returned by a single read into a 24576-byte (1024×24) buffer — which would leave 1 record in the ring for the next read.

The B5 vitest reads one record at a time and drains until `read` returns 0. That yields **1025** records (1 synth + 1024 ring), not 1024. The kernel-side cap (`INPUT_RING_MAX_RECORDS = 1024` in `crates/kernel/src/ofd.rs:188`) is the source of truth; the plan body's "1023" was a single-read framing, not a total-records expectation. The test counts the total and asserts 1025; `ov_real` (non-SYN_DROPPED count) is 1024.

If a future reader thinks this is off-by-one, double-check `INPUT_RING_MAX_RECORDS` and re-derive from there.

### Fixture compile path

`scripts/build-programs.sh` already builds every `programs/*.c` unconditionally; no extra registry plumbing was needed. Verified locally on macOS with homebrew LLVM (`/opt/homebrew/opt/llvm/bin/clang`) and the Q4-derived sysroot — produced `local-binaries/programs/wasm32/input-evdev-smoke.wasm` in one pass.

### Why not `rootfsImage: "default"`

First attempt used it (copy-paste from `centralized-test-helper.ts` worker-thread path). It blew up because `rootfs.vfs` isn't part of the cold-start dance — handoff-29's restore copies sysroot + libc/musl + 8 prebuilt `examples/*.wasm` but never `rootfs.vfs`. Switching to raw `NodePlatformIO` (no `rootfsImage` option) made the test pass; `/dev/input/event{0,1}` is served by `DeviceFileSystem`, not the rootfs mount. **Don't add `rootfsImage: "default"` back without also adding `rootfs.vfs` to the cold-start dance.**

## Cold-start dance — addendum

Handoff-29's dance now also needs `local-binaries/` populated for the vitest to find `kernel.wasm` and `programs/input-evdev-smoke.wasm`. Two sub-cases:

```bash
# Case A: you already have a freshly-built 9vbaz local-binaries/.
# Symlink it in (cheapest, but couples evdev to 9vbaz's build state).
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/local-binaries \
      /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/local-binaries
# CAVEAT: 9vbaz's kernel.wasm is built from a different branch state.
# It probably does NOT export `kernel_input_event` /
# `kernel_set_input_canvas_dims`. B5 will silently no-op those calls
# and fail the `kbd_name=...` assertion at `read returned 0` time.
# Don't trust this for B5 verification — only for kms-pageflip-smoke
# and other tests whose semantics are kernel-stable.

# Case B (RECOMMENDED for B5/Phase C work): build the evdev kernel
# in this worktree so the new exports are present.
cd /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan
cargo build --release -p kandelo -Z build-std=core,alloc
mkdir -p local-binaries
cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm local-binaries/kernel.wasm

# Then build programs (requires homebrew llvm; `set PATH` if not).
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
export LLVM_BIN="/opt/homebrew/opt/llvm/bin"
bash scripts/build-programs.sh
# → local-binaries/programs/wasm32/*.wasm including input-evdev-smoke.wasm
```

`scripts/build-programs.sh` also auto-builds the `wasm-fork-instrument` tool via cargo on first run; takes ~2 min cold. After that subsequent runs are fast.

`local-binaries/` is gitignored (see `.gitignore`); won't pollute the commit.

## Phase A + B roadmap — current state (complete)

| # | Task | Commit | Notes |
|---|---|---|---|
| 1 | A1 — shared ABI | `b4c3464ac` | session 24 |
| 2 | A2 — OFD plumbing | `fa47afa22` | session 24 |
| 3 | A3 — EVIOCG* dispatch | `d8539d252` | session 25 |
| 4 | A4 — `kernel_input_event` | `fd1b502d0` | session 25 |
| 5 | A5 — sys_read drain + POLLIN | `479fe65c2` | session 26 |
| 6 | A6 — close + fork serialise | `26393f20d` | session 27 |
| 7 | A7 — ABI snapshot regen | `e583f979f` | session 27 |
| 8 | cleanup — Phase A devil's-advocate | `6a71f593f` | session 28 |
| 9 | B1 — InputSource interface | `4a15d3669` | session 29 |
| 10 | B2 — BrowserInputSource + key table | `cd147db1a` | session 29 |
| 11 | B3 — NodeInputSource null-source | `f0e83c9eb` | session 29 |
| 12 | B4 — wire kernel_input_event + parity | `3d56c505f` | session 29 |
| 13 | **B5 — vitest end-to-end** | **`1d37940ef`** | **session 30** |

## Phase C roadmap — what's left

Plan body lines 1929–2086. Three commit-shaped tasks + 1 verify gate. **Strategy: do C in one commit if possible, two at most. Don't split per the original plan's C1/C2/C3 split if they cohere.**

| # | Plan task | Plan body lines | Files |
|---|---|---|---|
| 14 | **C1** — Vendor `linux/input.h` + `input-event-codes.h` subset under `musl-overlay/include/linux/`. Verify `_Static_assert(sizeof(struct input_event) == 24)` compiles in a wasm32 user program. | 1931–1979 | `musl-overlay/include/linux/input.h` (new), `musl-overlay/include/linux/input-event-codes.h` (new) |
| 15 | **C2** — Demo wiring. Add a `Cube` / SDL2 / libinput-y example that consumes `/dev/input/event*`, OR — likelier — wire the existing `modeset.c` / `dri-modeset` fluid sim to take keyboard input via the new path. | 1980–2030 (approx) | depends on what's chosen; likely a small `examples/` or `apps/browser-demos/` edit |
| 16 | **C3** — Browser-side: confirm `BrowserKernel.attachInputSource(new BrowserInputSource(window, canvas), …)` wiring works in the actual demo app. May need a Playwright spec under `packages/registry/<pkg>/test/` or `apps/browser-demos/test/`. | 2031–2070 | per CLAUDE.md "Two hosts" §, a Playwright path is the dual-host parity proof |
| ✓ | **C4** — Manual browser verify (`./run.sh browser`). Per CLAUDE.md §"Test Verification" item 6. No commit; gates the PR. | 2071–2086 | — |

C4 cannot be done on this machine without `./run.sh browser` working end-to-end with `nix`. Session 31 should attempt it on a host with the toolchain, OR coordinate with the user.

After C4 passes, open the single PR for all ~14 commits.

## Tactical pointers for Phase C

### Read these in order before touching code

1. **Plan body C1–C4**: `docs/plans/2026-06-15-dri-evdev-plan.md` lines 1929–2086.
2. **musl-overlay layout**: under `libc/musl-overlay/` in the worktree. C1 vendoring goes here; `scripts/build-musl.sh` re-runs the overlay merge.
3. **`build-musl.sh` is NOT automatic.** Per CLAUDE.md: after editing anything under `libc/musl-overlay/`, run `scripts/build-musl.sh` first. Otherwise programs link against a stale `sysroot/lib/libc.a` and the ABI side drifts silently.
4. **B5's `input-evdev-smoke.c` inlines the EVIOC macros + structs.** Once C1 lands the vendored headers, you can _optionally_ refactor `input-evdev-smoke.c` to `#include <linux/input.h>` — but doing so is just a cleanup, not load-bearing. The test still works as-is.
5. **For C3 dual-host parity**: re-run the symmetry grep from handoff-29 §"Dual-host parity surface". The B4 wiring already provides parallel structure; C3 should just exercise the browser side via Playwright, not add new symbols.

### Anti-patterns to avoid

- **Don't add `rootfsImage: "default"` to a new test without also adding `rootfs.vfs` to the cold-start dance.** Session 30 hit this; raw `NodePlatformIO` is fine for `/dev/input/*`.
- **Don't try to read into a single 24576-byte buffer expecting 1024 records.** That's what the plan body suggests but it leaves 1 record dangling. Drain one-at-a-time and count.
- **Don't refactor away `_Static_assert(sizeof(struct input_event) == 24)` in `input-evdev-smoke.c`.** It's a load-bearing safety net for ABI drift — same reason `WpkInputEvent._pad: i32` exists at offset 12 in `crates/shared/src/lib.rs`.

## Verification snapshot (at session 30 close)

```bash
# All five input vitest files pass.
cd host && npx vitest run \
  test/input-source.test.ts \
  test/browser-input-source.test.ts \
  test/node-input-source.test.ts \
  test/input-attach-source.test.ts \
  test/input-evdev.test.ts
# → 5/5 files, 24/24 tests pass

# tsc on host — no new errors related to input.
cd host && npx tsc --noEmit 2>&1 | grep -E "src/input/|test/.*input"
# → empty
```

**CLAUDE.md suites 1, 3, 4, 5 (cargo, libc-test, posix, abi-check) NOT re-run this session** — B5 is pure host TS + a user-space C fixture. Run all five suites before opening the PR (after C is done).

## Architecturally load-bearing decisions (don't relitigate during Phase C)

All entries from handoff-29 carry forward. Session 30 deltas:

- **NEW (session 30): Ring drain total is 1025 records (1 synth SYN_DROPPED + 1024 surviving)**, not 1024. The plan body's "1023 of the most recent" was a per-read framing assuming a 24576-byte buffer.
- **NEW (session 30): Phase B vitests do NOT need `rootfsImage: "default"`.** `/dev/input/*` is `DeviceFileSystem`, not VFS-managed.
- **NEW (session 30): EVIOC* macros in `programs/input-evdev-smoke.c` use the bit-twiddled `(dir << 30) | (size << 16) | (magic << 8) | nr` shape verbatim from Linux UAPI.** Re-derived locally; the kernel A3 dispatch in `crates/kernel/src/syscalls.rs:1480-1490` matches on `(dir, magic, nr)` exclusively, so the size field is informational on the userspace side (the kernel re-computes the buffer length from `size`).

## Cold-start dance (revised — preserve for restart-after-clean)

Per handoff-29 + session-30 additions:

```bash
cd /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan

# Source-tree copies — these are mutated by builds.
cp -R /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-q4-vblank-gating/sysroot   sysroot
rm -rf libc/musl
cp -R /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-q4-vblank-gating/libc/musl libc/musl

# Read-only symlinks from 9vbaz.
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/node_modules         node_modules
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/open-posix-testsuite open-posix-testsuite
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/host/node_modules    host/node_modules

# Prebuilt examples/*.wasm — global-setup.ts skips rebuild if mtime is new.
for f in putenv_test getaddrinfo_test sysv_ipc_test wasm_trap_test \
         abort_test mount_probe_test getpwent_smoke thread-exit-group; do
  cp /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/examples/$f.wasm \
     examples/
done
touch examples/*.wasm

# NEW (session 30): build the evdev kernel + user programs locally.
# This populates local-binaries/{kernel.wasm,programs/wasm32/*.wasm}
# so the B5 vitest (and any new Phase C vitests) can run end-to-end.
cargo build --release -p kandelo -Z build-std=core,alloc
mkdir -p local-binaries
cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm local-binaries/kernel.wasm

export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
export LLVM_BIN="/opt/homebrew/opt/llvm/bin"
bash scripts/build-programs.sh   # ~2 min cold (builds wasm-fork-instrument too)
```

Git status at session-30 close (besides committed files):

```
 m libc/musl                              (cp -R workaround)
?? docs/plans/2026-06-11-dri-kandelo-port-handoff-24.md   (carried untracked)
?? node_modules                          (cold-start symlink)
?? host/node_modules                     (cold-start symlink)
?? examples/*.wasm                       (cold-start prebuilt — 8 files)
?? open-posix-testsuite                  (cold-start symlink)
```

`local-binaries/`, `target/`, `tools/bin/` are all gitignored.

Plan-doc handoffs (21 → 30) stay untracked in the 9vbaz worktree. **Stage exactly the code files per commit; never `git add -A`.**

## Standing instruction for session 31

**Print this sentence in the next session's first turn:**

> *"Read `docs/plans/2026-06-11-dri-kandelo-port-handoff-30.md` first (in the 9vbaz worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Plan-5 / evdev A1–A7 + session-28 cleanup + B1–B5 are committed at `b4c3464ac` / `fa47afa22` / `d8539d252` / `fd1b502d0` / `479fe65c2` / `26393f20d` / `e583f979f` / `6a71f593f` / `4a15d3669` / `cd147db1a` / `f0e83c9eb` / `3d56c505f` / `1d37940ef` on branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001` off Q4 base `001729c67`; no PR opened. **Strategy: ONE PR, ~14 commits total** — 13 landed, ~1 to go (Phase C condensed); do NOT split into the plan's 3-PR shape. **Phase C is next: C1 vendor `linux/input.h` + `input-event-codes.h` under `musl-overlay/include/linux/`; C2 demo wiring; C3 browser-side Playwright; C4 manual `./run.sh browser` gates the PR but adds no commit.** Plan body at lines 1929–2086 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree). **Default to ONE Phase-C commit unless C obviously needs more.** After editing `libc/musl-overlay/`, run `scripts/build-musl.sh` BEFORE anything else — stale `sysroot/lib/libc.a` produces silent ABI drift. **Ring drain total is 1025 records (1 synth SYN_DROPPED + 1024 surviving), not 1024 — plan body's "1023 of the most recent" was a per-read framing.** **Phase B vitests do NOT use `rootfsImage: "default"`** — `/dev/input/*` is `DeviceFileSystem`, not VFS-managed; adding rootfs needs a cold-start-dance update too. **WpkInputEvent layout: 24 bytes with `_pad: i32` at offset 12 — load-bearing**, C reader expects `ev_type` at offset 16. Default to single-commit full tasks unless the task obviously > 1 commit. **Wait for user input before each commit.** Do NOT open the Q4 PR. Do NOT touch modeset.c's 60 Hz throttle. Do NOT redo the dye-fade experiment. Do NOT re-prune the `KEY_*` constant table, `WpkInputEvent._pad`, the `grabbed` field, or the single `InputEvent { device: u8 }` variant — see handoff-28 §"What deliberately stayed in Phase A". Do NOT add `rootfsImage: "default"` back without also adding `rootfs.vfs` to the cold-start dance. `bash scripts/check-abi-version.sh` will fail on pre-existing PR #629 drift — that's branch-wide, not a regression. If the worktree was wiped, re-run the **session-30 revised** cold-start dance in handoff-30 §"Cold-start dance" — it now also builds `local-binaries/{kernel.wasm,programs/wasm32/*.wasm}` via `cargo build -p kandelo` + `scripts/build-programs.sh` (homebrew llvm on PATH). `scripts/dev-shell.sh` doesn't work on this machine — nix isn't installed; use direct `npx vitest` + the build-locally path."*
