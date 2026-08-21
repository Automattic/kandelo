# DRI port onto kandelo:main — session 25 handoff (evdev A3+A4 COMMITTED; A5 next)

Continuation of [handoff-24](./2026-06-11-dri-kandelo-port-handoff-24.md). Session 25 landed A3 (EVIOCG* ioctl dispatch) + A4 (kernel_input_event export + fan-out + ring overflow). Stopped cleanly on user direction to free context before A5.

## TL;DR — read this twice

1. **Worktree is `explore-dri-evdev-plan`** at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`, branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`. Branched off `explore-dri-q4-vblank-gating` at `001729c67`.

2. **Four evdev commits landed on top of Q4:**
   - `b4c3464ac` — A1 shared ABI (session 24)
   - `fa47afa22` — A2 OFD plumbing (session 24)
   - `d8539d252` — `kernel(input): EVIOCG* ioctl dispatch + populate_evbit` (A3; 3 files / +553)
   - `fd1b502d0` — `kernel(input): kernel_input_event export + fan-out + ring overflow handling` (A4; 4 files / +343 / -3)

   All four pure-additive — no `ABI_VERSION` bump needed. Snapshot regen deferred to A7.

3. **One PR, 15 commits — 4/15 in, 11 to go.** User directive (handoff-24 §3) collapses the plan's 3-PR split. Skip per-phase "open PR" steps. Manual browser verify still required before the PR opens.

4. **No PR opened yet.** User hasn't asked. Don't open it until they do.

5. **A5 is next: `sys_read` drains the ring + `sys_poll(POLLIN)` gates on non-empty + `SYN_DROPPED` resync.** Plan body at lines 1435–1510 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, **in the 9vbaz worktree**, NOT the evdev worktree). A2 left a placeholder `Ok(0)` in `sys_read`'s `InputEvent` arm — A5 replaces it.

6. **Wait for user input before each commit.** Standing instruction from handoff-24 still applies.

## Commits this session

```
fd1b502d0 kernel(input): kernel_input_event export + fan-out + ring overflow handling  (A4; 4 files / +343 / -3)
d8539d252 kernel(input): EVIOCG* ioctl dispatch + populate_evbit                       (A3; 3 files / +553)
fa47afa22 kernel(input): add /dev/input/event{0,1} + InputFdState on OFD               (A2; session 24)
b4c3464ac kernel(input): shared ABI — struct input_event + EV_*/KEY_*/EVIOC* constants (A1; session 24)
001729c67 dri(kernel+host+libdrm): retire PAGE_FLIP on vblank pump tick                (Q4 base)
```

Co-author footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. **No `🤖 Generated with` line** (CLAUDE.md anti-emoji rule).

## What landed in A3 (commit d8539d252)

Files: `crates/kernel/src/input/mod.rs` (NEW; 180 LoC) + `crates/kernel/src/lib.rs` (+1 `pub mod input;`) + `crates/kernel/src/syscalls.rs` (+380).

- `input/mod.rs`:
  - `canvas_dims()` / `set_canvas_dims(w, h)` — two `AtomicU32` defaults (1280, 720). A4 added the `kernel_set_input_canvas_dims` wasm export that calls `set_canvas_dims`. Clamped to ≥1 so `maximum = w - 1` doesn't go negative.
  - `populate_evbit(device, ev_type, buf)` — packs the bitmap for EVIOCGBIT. Keyboard advertises every KEY_* in `1..=KEY_MICMUTE` (one loop, no 248-entry table). Pointer advertises BTN_LEFT/RIGHT/MIDDLE/SIDE/EXTRA for EV_KEY, REL_X/Y/WHEEL/HWHEEL for EV_REL, ABS_X/Y for EV_ABS.
  - 9 unit tests in `input::tests`.
- `syscalls.rs`:
  - `input_state(proc, ofd_idx)` + `_mut` accessors near `dri_state` / `kms_state`.
  - `handle_input_ioctl(proc, ofd_idx, request, buf)` — dispatch for GVERSION / GID / GNAME / GBIT / GABS / GRAB.
  - Dispatch site in `sys_ioctl` right after the DRI block: `if let Some(VirtualDevice::InputEvent { .. }) = …` → `handle_input_ioctl`.
  - 15 EVIOC tests in `syscalls::tests`.

**Plan deviations folded into A3 (carry forward — don't relitigate):**
1. Plan body's draft uses `with_input_ofd(pid, fd, |i| …)`. Codebase pattern is `(proc, ofd_idx)`. I match the codebase.
2. Plan body's comments label dirs as `dir == 1` for read and `dir == 2` for write. **Linux's actual values are `IOC_READ = 2 / IOC_WRITE = 1`**, matching A1's `evioc_numbers_match_linux_uapi` test. I used Linux-correct values: GVERSION/GID/GNAME/GBIT/GABS gated on `dir == 2`, GRAB on `dir == 1`.
3. Plan body's `write_struct` / `write_u32` helpers don't exist. I used `core::ptr::write_unaligned` for structs and `buf[..N].copy_from_slice(&val.to_le_bytes())` for u32s — matches `handle_dri_ioctl` style.
4. Plan body's EVIOCGNAME strings: `"wpk virtual keyboard\0"` / `"wpk virtual pointer\0"` (handoff-24 had a typo claiming `"wpk-kbd"` / `"wpk-ptr"` — ignore that; plan-body strings won).
5. **Foreign magic (non-'E') returns `ENOTTY`**, not `EINVAL`. Plan-7 SDL2 carve-out: greps errno, fatals on EINVAL. Gated by `evioc_foreign_magic_on_evdev_fd_returns_enotty`. Same for unknown nr.
6. **Keyboard `EVIOCGABS` returns `ENOTTY`**, not `EINVAL`. Same SDL2 reason.

## What landed in A4 (commit fd1b502d0)

Files: `crates/kernel/src/input/dispatch.rs` (NEW; ~250 LoC) + `crates/kernel/src/input/wait.rs` (NEW; ~25 LoC) + `crates/kernel/src/input/mod.rs` (+`pub mod dispatch; pub mod wait;`) + `crates/kernel/src/wasm_api.rs` (+56).

- `input/dispatch.rs`:
  - `pub fn push_event(device, ev_type, code, value, tv_sec, tv_usec) -> usize` — walks `process_table::with_processes`, fans the 24-byte `WpkInputEvent` record to every OFD whose `input_state.device == device`. Returns count of OFDs accepted.
  - Overflow protocol mirrors `evdev_pass_values`: ring at `INPUT_RING_MAX_BYTES` → set `dropped = true`, **discard the incoming record**. Bound holds for free because pushes-while-dropped are no-ops; A5 clears `dropped` after emitting `SYN_DROPPED`.
  - Tracks `ring_high_water` (debug only).
  - On every empty-to-non-empty transition, calls `crate::input::wait::wake_event_reader(ofd_idx)`.
  - 7 tests; built without touching `MockHostIO` (which is private to `mod tests` in syscalls.rs — see plan deviation #2 below).
- `input/wait.rs`:
  - `pub fn wake_event_reader(_ofd_idx: usize)` — **v1 stub, no-op**. Header comment explains the routing problem: `wakeup::push(ofd_idx, WAKE_READABLE)` would collide with the pipe-index namespace (`drainAndProcessWakeupEvents` in `host/src/kernel-worker.ts` looks up `wakeIdx` in `pendingPipeReaders`, which is keyed by pipe_idx). Phase B will either allocate a separate wake-idx space (mirror `wakeup::alloc_accept_wake_idx`) or add a new wake-type bit.
- `wasm_api.rs`:
  - `kernel_input_event(device, ev_type, code, value)` — gets `(tv_sec, tv_usec)` from `WasmHostIO.host_clock_gettime(CLOCK_MONOTONIC)` (same source as `kernel_vblank`), then calls `push_event`. Errors fall back to (0, 0).
  - `kernel_set_input_canvas_dims(width, height)` — thin wrapper around `crate::input::set_canvas_dims`.

**Plan deviations folded into A4 (carry forward):**
1. Plan body says `crate::input::dispatch.rs`; handoff-24 said "grow `input/mod.rs`; new `input/wait.rs`". I created both submodules to match the plan body's structural intent — `mod.rs` stays focused on EVIOCG* helpers + canvas dims.
2. Plan body uses `crate::time::monotonic_us()`; that helper doesn't exist. I use `host.host_clock_gettime(CLOCK_MONOTONIC)` via `WasmHostIO` at the export boundary, then pass `(tv_sec, tv_usec)` into `push_event` so the producer stays testable without a host (exact same factoring as `kernel_vblank` → `drain_pending_flips`).
3. Plan body's "wake every OFD" cites "plan 4 A7's `wake_event_reader`" — **that function was never written**. Q4 (commit `5e0c15f1d`) does synchronous retire-on-read for DRI card0 and relies on the host's poll-retry timeout to wake. A4 mirrors that: stub wake; B-phase wires real routing.
4. Plan body's Step 3 mentions adding `HostIO::input_canvas_dims` in `process.rs`. **Not needed** — the host calls the wasm export `kernel_set_input_canvas_dims` directly. The data flow is host → kernel, not kernel → host.
5. `MockHostIO` is private to `mod tests` inside `syscalls.rs` and can't be reused cross-module. Dispatch tests construct OFDs directly via `proc.ofd_table.create(FileType::CharDevice, O_RDWR, host_handle, path)` + manual `input_state = Some(Box::new(InputFdState { device, ..Default::default() }))`. Pattern is reusable for A5/A6 tests if needed.

## Verification snapshot (at A4 close)

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib  # → 23/23 pass (no change since A2)
cargo test -p kandelo            --target aarch64-apple-darwin --lib  # → 973/973 pass (+24 A3 + +7 A4 vs A2's 942)
cargo check -p kandelo --target wasm32-unknown-unknown --release      # → clean (warnings pre-existing)
```

CLAUDE.md suites still NOT re-run this session (kernel-only churn that doesn't touch syscall ABI):
- vitest — host has no plan-5 code yet.
- musl libc-test — no libc changes.
- POSIX Test Suite — no syscall semantics changes.
- ABI snapshot — A1–A4 are additive; A7 regenerates.

Run **all five suites** before opening the PR (after C is done).

## Phase A roadmap — what's left (3 commits to wrap kernel side)

Plan body line indexes refer to `docs/plans/2026-06-15-dri-evdev-plan.md` in the 9vbaz worktree.

| # | Task | Plan body lines | New files |
|---|---|---|---|
| 5/15 | **A5** — `sys_read` drains the ring; `sys_poll(POLLIN)` gates on non-empty | 1435–1510 | none (modify `syscalls.rs`) |
| 6/15 | **A6** — `on_final_close` releases grab + drops ring | 1511–1552 | hook in existing close-path |
| 7/15 | **A7** — ABI snapshot regen (additive) | 1553–1573 | `abi/snapshot.json` regenerated |

Then Phase B (host, 5 commits B1-B5) and Phase C (sysroot + demo, 3 commits C1-C3). C4 (manual browser verify) required before PR, adds no commit. **A8 / B6 / C5 are skipped** under the single-PR strategy.

## Tactical pointers for A5

Plan body lines 1435–1510 describes:
1. Replace `sys_read`'s `InputEvent { .. }` placeholder `Ok(0)` (A2 left this — grep `InputEvent { device } =>` in the `sys_read` match around line 2600-ish of `syscalls.rs`).
2. Read drains whole records (24 bytes each). Return bytes copied, truncating to whole-record boundary if buf is short. `O_NONBLOCK` is implicit — if ring empty, return 0 (current behavior; matches DRI card0 read). The plan body may sketch `EAGAIN`-on-nonblock semantics; the DRI card0 path returns 0, so match that.
3. **SYN_DROPPED resync:** if `input_state.dropped == true` and we're about to emit any bytes, prepend one synthetic `SYN_DROPPED` record (24 bytes: tv_sec/tv_usec from kernel clock, `_pad: 0`, `ev_type: EV_SYN`, `code: SYN_DROPPED`, `value: 0`) and clear the flag. Caller must already have at least 24 bytes of buf for this.
4. **`sys_poll` arm:** add `InputEvent { .. }` recognition alongside the existing `DriCard0` arm at line ~8200 of `syscalls.rs`. Gate `POLLIN` on `!input_state.event_ring.is_empty()` OR `input_state.dropped == true`. Never POLLOUT (read-only device).
5. **`sys_select` arm:** same shape if there's a parallel select path; check `grep -n "DriCard0" crates/kernel/src/syscalls.rs` and mirror every site.

Tests to add (in `syscalls::tests` block):
- `read_drains_one_record` — push via `crate::input::dispatch::push_event`, then `sys_read` → 24 bytes match the pushed event.
- `read_drains_multiple_records` — push N, read all 24N bytes.
- `read_truncates_on_whole_record_boundary` — push 3 records, read with 50-byte buf → returns 48 (2 records), ring still has 1.
- `read_short_buffer_smaller_than_one_record_returns_zero_or_einval` — match what DRI card0 does for sub-record reads (check first).
- `read_empty_ring_returns_zero` — already covered by A2's placeholder test, but extend it to use the dispatch path.
- `read_after_overflow_emits_syn_dropped_first_then_records` — fill ring to MAX, push one more (sets `dropped`), read 48 bytes → first record is SYN_DROPPED synth, second is the oldest queued real event, `dropped` is now false.
- `poll_pollin_gates_on_ring_non_empty` — empty: revents=0; push: revents=POLLIN.
- `poll_pollin_fires_if_dropped_even_with_empty_ring` — edge case: if the ring drained but `dropped` is still latched, POLLIN should still fire so the reader picks up the SYN_DROPPED. (Actually `dropped` only sets on overflow, which requires the ring to be FULL. Once ring is drained, `dropped` was already cleared by the prior read. This test may be unreachable; skip if so — depends on plan body's spec.)

Commit message (mirror prior style):
```
kernel(input): sys_read drains ring + sys_poll POLLIN gating + SYN_DROPPED resync
```

## Cold-start dance (preserve for restart-after-clean)

If the worktree was wiped, re-run handoff-24 §"Cold-start dance":

```bash
cd /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan

# Real copies — these trees are mutated by builds. Source from the Q4
# worktree, NOT 9vbaz — Q4's sysroot has the post-Q4 libdrm.a rebuild.
cp -R /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-q4-vblank-gating/sysroot   sysroot
rm -rf libc/musl
cp -R /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-q4-vblank-gating/libc/musl libc/musl

# Symlinks — read-only sources from 9vbaz.
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/node_modules         node_modules
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/open-posix-testsuite open-posix-testsuite
```

Git status at session-25 close (besides committed files):

```
 m libc/musl                              (cp -R workaround; submodule shows dirty)
?? node_modules                          (cold-start symlink)
?? open-posix-testsuite                  (cold-start symlink)
```

Plan-doc handoffs (21 → 25) stay untracked in the 9vbaz worktree. **Stage exactly the code files per commit; never `git add -A`.**

## Architecturally load-bearing decisions (don't relitigate during A5)

These were folded into A1 / A2 / A3 / A4 or carry from earlier sessions:

- **24-byte `WpkInputEvent` with explicit `_pad: i32` at offset 12.** Drift = silent corruption. `input_event_field_offsets` gates this.
- **`input_state` parallel to `dri_state` on OFD**, NOT nested under `DriOfdState`. Disjoint state machines.
- **Per-OFD ring is 1024 records (24 KiB).** Overflow latches `dropped`; **incoming** record discarded (Linux semantics). Next `read()` synthesises `SYN_DROPPED` at head + clears flag.
- **`EVIOCGRAB` recorded but NOT enforced in v1.** Cross-OFD enforcement is plan 9's compositor task — must land before wpkcompositor opens.
- **Unknown `EVIOCG*` and non-'E' magic return `ENOTTY`**, not `EINVAL` (SDL2 carve-out). Keyboard `EVIOCGABS` returns `ENOTTY` for the same reason.
- **`crate::input::wait::wake_event_reader` is a v1 no-op stub.** Real routing lands in Phase B. Today's wake path is the host's poll-retry timeout (same as DRI card0).
- **`BrowserInputSource.onPointerMove` emits `EV_ABS` by default**; `EV_REL` only on `pointerLockElement`. B2 wiring concern (plan-8 review).
- **`/dev/input` `readdir` lists event0 + event1.** Already done in A2.
- **CLOCK_MONOTONIC for all event timestamps** — `kernel_input_event` stamps via `WasmHostIO.host_clock_gettime` (same source as `kernel_vblank`).
- **Single-PR strategy.** All 15 commits land together on `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`.
- **Plan-5 sub-skill `superpowers:subagent-driven-development` is not in the registry.** Continue task-by-task with disciplined verification.

## What deliberately stays NOT done

- **Q4 PR not opened.** User declined.
- **Modeset dye-fade experiment.** Don't redo.
- **`modeset.c`'s 60 Hz throttle.** Keep (standing instruction since v20).
- **`MockHostIO` not promoted to `pub(crate)`.** New test modules construct OFDs directly via `proc.ofd_table.create()` + manual `input_state` (see A4 deviation #5).
- **`input_state` fork serialisation.** TODO breadcrumbs live in `fork.rs` at the two deserialise sites — wire when A5 / A6 demand it.
- **`build-libdrm-stub.sh` Q4 follow-up.** Not blocking plan 5.
- **Q4 follow-up: kernel-level `sys_read(card0)` blocking semantics.** Deferred to v3.

## Standing instruction for session 26

**Print this sentence in the next session's first turn:**

> *"Read `docs/plans/2026-06-11-dri-kandelo-port-handoff-25.md` first (in the 9vbaz worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Plan-5 / evdev A1–A4 are committed at `b4c3464ac` / `fa47afa22` / `d8539d252` / `fd1b502d0` on branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001` off Q4 base `001729c67`; no PR opened. **Strategy: ONE PR, 15 commits total** — 4 landed, 11 to go; do NOT split into the plan's 3-PR shape. **Next task: A5 — `sys_read` drains the ring + `sys_poll(POLLIN)` gates + `SYN_DROPPED` resync.** Plan body at lines 1435–1510 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree). A2 left a placeholder `Ok(0)` in `sys_read`'s `InputEvent` arm — replace it. SYN_DROPPED is synthesised at the **head** of the next read after `dropped` latches; clear the flag afterward. `sys_poll(POLLIN)` mirrors the DRI card0 arm (line ~8200 of `syscalls.rs`). Mirror every `DriCard0` site in `sys_select` too. **`wake_event_reader` is a v1 no-op stub** — do NOT route through `wakeup::push` (collides with pipe_idx namespace); Phase B wires real routing. **Wait for user input before each commit.** Do NOT open the Q4 PR. Do NOT touch modeset.c's 60 Hz throttle. Do NOT redo the dye-fade experiment. If the worktree was wiped, re-run the cold-start dance in handoff-25 §"Cold-start dance" (sources from the Q4 worktree, NOT 9vbaz)."*
