# DRI port onto kandelo:main — session 26 handoff (evdev A5 COMMITTED; A6 next)

Continuation of [handoff-25](./2026-06-11-dri-kandelo-port-handoff-25.md). Session 26 landed A5 (`sys_read` ring drain + `poll_check` POLLIN gating + SYN_DROPPED resync). Stopped before A6 to free context; A6 was scoped but not edited.

## TL;DR — read this twice

1. **Worktree is `explore-dri-evdev-plan`** at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`, branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`. Branched off `explore-dri-q4-vblank-gating` at `001729c67`.

2. **Five evdev commits landed on top of Q4:**
   - `b4c3464ac` — A1 shared ABI (session 24)
   - `fa47afa22` — A2 OFD plumbing (session 24)
   - `d8539d252` — A3 EVIOCG* ioctl dispatch (session 25)
   - `fd1b502d0` — A4 `kernel_input_event` + fan-out + ring overflow (session 25)
   - `479fe65c2` — **A5 `sys_read` drain + `sys_poll` POLLIN + SYN_DROPPED** (this session; 1 file / +323 / -9)

   All five pure-additive — no `ABI_VERSION` bump needed. Snapshot regen deferred to A7.

3. **One PR, 15 commits — 5/15 in, 10 to go.** User directive (handoff-24 §3) collapses the plan's 3-PR split. Skip per-phase "open PR" steps. Manual browser verify still required before the PR opens.

4. **No PR opened yet.** User hasn't asked. Don't open it until they do.

5. **A6 is next: `on_final_close` releases grab + drops ring.** Plan body at lines 1511–1552 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, **in the 9vbaz worktree**, NOT the evdev worktree). **Architectural pivot:** the plan body references an `OpenFileDesc::on_final_close(pid, host_io, ofd_idx)` method that **does not exist in our codebase**. The actual close-time cleanup is procedural inside `sys_close` (`crates/kernel/src/syscalls.rs:2021`), which snapshots `dri_state` when `ref_count == 1`, calls `dec_ref` (which sets `entries[idx] = None` on last ref), then invokes `dri_release_ofd_state` (`syscalls.rs:1610`) with the snapshot. **Mirror this pattern for input_state, OR rely on the automatic Drop of `entries[idx] = None`** — see §"Tactical pointers for A6" below.

6. **Wait for user input before each commit.** Standing instruction from handoff-24 still applies.

## Commits this session

```
479fe65c2 kernel(input): sys_read drains ring + sys_poll POLLIN gating + SYN_DROPPED resync  (A5; 1 file / +323 / -9)
fd1b502d0 kernel(input): kernel_input_event export + fan-out + ring overflow handling      (A4; session 25)
d8539d252 kernel(input): EVIOCG* ioctl dispatch + populate_evbit                           (A3; session 25)
fa47afa22 kernel(input): add /dev/input/event{0,1} + InputFdState on OFD                   (A2; session 24)
b4c3464ac kernel(input): shared ABI — struct input_event + EV_*/KEY_*/EVIOC* constants     (A1; session 24)
001729c67 dri(kernel+host+libdrm): retire PAGE_FLIP on vblank pump tick                    (Q4 base)
```

Co-author footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. **No `🤖 Generated with` line** (CLAUDE.md anti-emoji rule).

## What landed in A5 (commit 479fe65c2)

Single file: `crates/kernel/src/syscalls.rs`. Three regions touched.

### Region 1 — `sys_read` `InputEvent` arm (was line 2660; now ~2660+ where the new block lives)

Replaced A2's `VirtualDevice::InputEvent { .. } => 0,` placeholder with:
- `usable = (buf.len() / 24) * 24`; if `usable == 0` return **`EINVAL`** (sub-record buffer is an evdev protocol error).
- `input = input_state_mut(proc, ofd_idx)?`.
- Empty ring + no `dropped` latch: **`EAGAIN` on `O_NONBLOCK`, else `Ok(0)`** — mirrors DriCard0 (kernel never blocks; host poll-retry loop is the wake path until Phase B).
- If `input.dropped`: synthesise a 24-byte `WpkInputEvent { tv_sec, tv_usec, _pad: 0, ev_type: EV_SYN, code: SYN_DROPPED, value: 0 }` at the **head** of the read output (timestamp from `host.host_clock_gettime(CLOCK_MONOTONIC).unwrap_or((0,0))`; nsec → usec via `/1_000`), clear `input.dropped`, advance `written = 24`.
- Drain whole 24-byte records: `while written + 24 <= usable && !ring.is_empty()` pop_front 24 bytes into `buf[written..written+24]`.
- Yield `written` as the arm value (assigned to `n`, returned as `Ok(n)` at line ~2703).

### Region 2 — `poll_check` `InputEvent` arm (was line 8200 block; now ~8214+ after Region 1's +61)

Added a new `else if` arm right after the `DriCard0` arm in the `CharDevice` branch:
- Matches `ofd.file_type == FileType::CharDevice && matches!(VirtualDevice::from_host_handle(ofd.host_handle), Some(VirtualDevice::InputEvent { .. }))`.
- `POLLIN` iff `!ofd.input().is_empty() || ofd.input().dropped` (the SYN_DROPPED marker alone is a readable record).
- **Never `POLLOUT`** — evdev is read-only.

This single arm covers `sys_poll`, `sys_ppoll` (wraps `sys_poll`), `sys_select` (calls `poll_check` directly), and `sys_pselect6` (wraps `sys_select`). The handoff-25 instruction "Mirror every DriCard0 site in sys_select too" turned out to be a no-op: there is no separate DriCard0 arm in sys_select — they all funnel through `poll_check`.

### Region 3 — 9 new tests at end of `syscalls::tests` block (append before closing `}` at the previous end of the module)

Inline helpers added once in the test block:
```rust
fn push_event_into_ofd(proc: &mut Process, ofd_idx: usize, ev_type: u16, code: u16, value: i32)
fn extract_record_at(buf: &[u8], off: usize) -> WpkInputEvent
```

Tests skip `dispatch::push_event` to avoid registering test processes in `GLOBAL_PROCESS_TABLE` — they inject records by directly mutating `input.event_ring` via `input_mut()`. Pattern is reusable for A6 if needed.

| Test | What it gates |
|---|---|
| `read_returns_einval_for_buffer_shorter_than_one_record` | 12-byte buf → EINVAL |
| `read_drains_whole_records_from_ring` | 3 pushed, 72-byte read → exactly 3 records, ring empty, values match |
| `read_truncates_to_whole_record_boundary_and_leaves_remainder` | 3 pushed, 50-byte read → 48 bytes (2 records), 1 record stays |
| `read_with_dropped_flag_emits_syn_dropped_and_clears_flag` | dropped=true + empty ring, 24-byte read → SYN_DROPPED synth, flag cleared |
| `read_after_overflow_emits_syn_dropped_then_real_records` | 2 records + dropped=true, 72-byte read → SYN_DROPPED first, then 2 real records, flag cleared |
| `read_empty_ring_with_nonblock_returns_eagain` | O_NONBLOCK + empty + clean → EAGAIN (NOT Ok(0)) |
| `poll_pollin_idle_then_ready_after_event_pushed` | empty → revents=0; push → revents=POLLIN |
| `poll_pollin_ready_when_only_dropped_flag_is_set` | dropped=true + empty ring → POLLIN fires |
| `poll_never_reports_pollout_for_evdev_fd` | request POLLIN|POLLOUT, get neither when empty (no POLLOUT ever) |

The pre-existing A2 placeholder test `read_eventN_returns_zero_before_any_event` (line ~22655) had its stale comment updated to describe the actual A5 semantics; the test body still passes because empty ring + no NONBLOCK + no dropped → `Ok(0)`.

**Plan deviations folded into A5 (carry forward — don't relitigate):**

1. **Plan body's `crate::time::monotonic_us()` doesn't exist.** Used `host.host_clock_gettime(CLOCK_MONOTONIC).unwrap_or((0, 0))` and converted nsec→usec, same factoring as A4's `kernel_input_event` (handoff-25 §A4 deviation #2 already documented this).
2. **Plan body's `block_event_reader(ofd_idx)?` call: skipped.** `wake_event_reader` is the v1 no-op stub (handoff-25 §"Architecturally load-bearing decisions"). Kernel never parks the reader; behaviour mirrors DriCard0: `EAGAIN` on `O_NONBLOCK`, else `Ok(0)`. Phase B wires real routing.
3. **Plan body's `read_blocks_on_empty_ring_resumes_on_push_event` test: skipped.** Unreachable — kernel never blocks here. Replaced with `read_empty_ring_with_nonblock_returns_eagain` for the only error path that's actually live.
4. **Handoff-25's "sub-record returns the floor or EINVAL" question:** chose EINVAL (the plan body's behaviour). Sub-24-byte reads on an evdev fd are a protocol bug — libinput never does it; SDL2's only sub-record path is a probe that wants `errno`.
5. **Tests inject records directly** (helper `push_event_into_ofd` mutates `ofd.input_mut().event_ring`) instead of routing through `dispatch::push_event`. The dispatch module already covers fan-out + overflow; cross-coverage isn't worth dragging the global PROCESS_TABLE into syscalls::tests.

## Verification snapshot (at A5 close)

```bash
cargo test -p kandelo --target aarch64-apple-darwin --lib  # → 982/982 pass (+9 vs A4's 973)
cargo check -p kandelo --target wasm32-unknown-unknown --release  # → clean (47 pre-existing warnings, 0 errors)
```

CLAUDE.md suites still NOT re-run this session (kernel-only churn that doesn't touch syscall ABI):
- vitest — host has no plan-5 code yet.
- musl libc-test — no libc changes.
- POSIX Test Suite — no syscall semantics changes.
- ABI snapshot — A1–A5 are additive; A7 regenerates.

Run **all five suites** before opening the PR (after C is done).

## Phase A roadmap — what's left (2 commits to wrap kernel side)

Plan body line indexes refer to `docs/plans/2026-06-15-dri-evdev-plan.md` in the 9vbaz worktree.

| # | Task | Plan body lines | Files |
|---|---|---|---|
| 6/15 | **A6** — close releases grab + drops ring | 1511–1552 | `crates/kernel/src/syscalls.rs` (sys_close + new helper) and/or `ofd.rs` (none needed if Drop suffices) |
| 7/15 | **A7** — ABI snapshot regen (additive) | 1553–1573 | `abi/snapshot.json` regenerated |

Then Phase B (host, 5 commits B1–B5) and Phase C (sysroot + demo, 3 commits C1–C3). C4 (manual browser verify) required before PR, adds no commit. **A8 / B6 / C5 are skipped** under the single-PR strategy.

## Tactical pointers for A6

### Architectural pivot — plan body assumes a method that doesn't exist

Plan body lines 1511–1552 sketch:
```rust
impl OpenFileDesc {
    pub fn on_final_close(&mut self, pid: i32, host_io: &mut dyn HostIO, ofd_idx: usize) {
        // … plan 2's prime_bo cleanup …
        // … plan 3's dri.handles + dri.gl.bindings cleanup …
        // … plan 4's kms cleanup …
        if let Some(input) = self.input.take() {
            // No host-side per-OFD state to clean.
            let _ = input;
        }
    }
}
```

**There is no `OpenFileDesc::on_final_close` method.** The DRI / KMS / prime-bo cleanup the plan body cites is implemented procedurally:

- **`sys_close` (`crates/kernel/src/syscalls.rs:2021`)** — snapshots `dri_state` via `take()` when `ref_count == 1`, then `dec_ref` (`ofd.rs:388`) which sets `entries[idx] = None` on last ref, then **calls `dri_release_ofd_state` with the snapshot** outside the ref-counted slot.
- **`dri_release_ofd_state` (`syscalls.rs:1610`)** — does the actual bo decref, fb destroy, master release, host notification. Lives in syscalls.rs, not on the OFD impl.

Note: A5's edits did NOT shift `sys_close` (still 2021) or `dri_release_ofd_state` (still 1610) since both sit before the sys_read InputEvent arm at the old 2660. Lines BELOW that arm shifted +61; lines below `poll_check` shifted a further +16 (total +77). `sys_poll` moved from 8049 → ~8110.

### Two valid implementations for A6

**Option (a) — Match the dri_release_ofd_state pattern.** New helper `input_release_ofd_state(pid, ofd_idx, state: Option<Box<InputFdState>>)` in syscalls.rs. In `sys_close`, snapshot `input_state.take()` when `ref_count == 1`, call the helper after `dec_ref`. The helper body is a no-op for v1 (drop happens via the Box going out of scope at the end of the helper); the function exists for symmetry and as a hook point for plan 9's `host_io.input_grab_released(pid, device)`.

**Option (b) — Rely on automatic Drop.** Do nothing in production code. When `dec_ref` does `entries[idx] = None`, the `OpenFileDesc` drops, which drops its `input_state: Option<Box<InputFdState>>`, which reclaims the `VecDeque<u8>` and the `grabbed` bool. No leak. The only thing missing is the symmetric hook point.

**Recommendation: Option (a) for symmetry + future plan-9 hook**, but it's a one-line callsite + a 5-line helper. Both options are correct for v1; (a) reduces churn at plan-9-merge time.

### Tests called for by the plan body

1. `close_releases_grab_so_next_open_can_grab` — Process A opens event0, EVIOCGRAB, close. Process B opens event0, EVIOCGRAB → succeeds. **Caveat:** this test is a v1 low bar because cross-OFD grab is NOT enforced (handoff-25 §"Architecturally load-bearing decisions"). It mostly exercises that close-doesn't-panic + a fresh OFD can grab. Still worth keeping.
2. `fork_then_close_in_child_keeps_grab_on_parent` — OFD shared by fork; child close → refcount=1, parent still holds grab; parent close → grab released (last-ref path). **Subtle dependency:** wpk's fork machinery serialises OFDs (see `crates/kernel/src/fork.rs` — the OFD table is copied, not shared by reference). Handoff-25 §"What deliberately stays NOT done" notes: "`input_state` fork serialisation. TODO breadcrumbs live in `fork.rs` at the two deserialise sites — wire when A5 / A6 demand it." **A6 may need to land that fork serialisation first.** Check `fork.rs` around lines 304, 438, 457, 2223, 2294, 2370 for the breadcrumbs.

If wiring fork serialisation is too large for one commit, **split A6 into A6a (close-time cleanup + first test) and A6b (fork serialisation + second test)** — that takes the PR to 16 commits, which the user has previously accepted as a fair trade for atomic semantics. Or skip the second test for v1 and document the gap.

### Suggested commit message (A6, single commit)

```
kernel(input): close releases grab + drops ring on last ref
```

If split:
```
kernel(input): release input_state on close (last-ref hook)
kernel(input): fork serialises input_state ring + grab
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

Git status at session-26 close (besides committed files):

```
 m libc/musl                              (cp -R workaround; submodule shows dirty)
?? docs/plans/2026-06-11-dri-kandelo-port-handoff-24.md   (carried untracked since session 24)
?? node_modules                          (cold-start symlink)
?? open-posix-testsuite                  (cold-start symlink)
```

Plan-doc handoffs (21 → 26) stay untracked in the 9vbaz worktree. **Stage exactly the code files per commit; never `git add -A`.**

## Architecturally load-bearing decisions (don't relitigate during A6)

These were folded into A1 / A2 / A3 / A4 / A5 or carry from earlier sessions:

- **24-byte `WpkInputEvent` with explicit `_pad: i32` at offset 12.** Drift = silent corruption. `input_event_field_offsets` gates this.
- **`input_state` parallel to `dri_state` on OFD**, NOT nested under `DriOfdState`. Disjoint state machines.
- **Per-OFD ring is 1024 records (24 KiB).** Overflow latches `dropped`; **incoming** record discarded (Linux semantics). Next `read()` synthesises `SYN_DROPPED` at head + clears flag.
- **`sys_read` returns `Ok(0)` on empty + clean ring + blocking mode; `EAGAIN` on `O_NONBLOCK`.** Mirrors DriCard0. Kernel never parks the reader.
- **`sys_read` returns `EINVAL` on sub-24-byte buffer.** Floor-to-record-boundary kicks in only when buf >= 24.
- **POLLIN gates on `!event_ring.is_empty() || dropped`.** Single arm in `poll_check` covers poll/ppoll/select/pselect6.
- **`EVIOCGRAB` recorded but NOT enforced in v1.** Cross-OFD enforcement is plan 9's compositor task — must land before wpkcompositor opens.
- **Unknown `EVIOCG*` and non-'E' magic return `ENOTTY`**, not `EINVAL` (SDL2 carve-out). Keyboard `EVIOCGABS` returns `ENOTTY` for the same reason.
- **`crate::input::wait::wake_event_reader` is a v1 no-op stub.** Real routing lands in Phase B. Today's wake path is the host's poll-retry timeout (same as DRI card0).
- **`BrowserInputSource.onPointerMove` emits `EV_ABS` by default**; `EV_REL` only on `pointerLockElement`. B2 wiring concern (plan-8 review).
- **`/dev/input` `readdir` lists event0 + event1.** Already done in A2.
- **CLOCK_MONOTONIC for all event timestamps** — `sys_read`'s SYN_DROPPED synth + `kernel_input_event` both stamp via `WasmHostIO.host_clock_gettime` (same source as `kernel_vblank`).
- **Single-PR strategy.** All 15 commits land together on `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`.
- **Plan-5 sub-skill `superpowers:subagent-driven-development` is not in the registry.** Continue task-by-task with disciplined verification.

## What deliberately stays NOT done

- **Q4 PR not opened.** User declined.
- **Modeset dye-fade experiment.** Don't redo.
- **`modeset.c`'s 60 Hz throttle.** Keep (standing instruction since v20).
- **`MockHostIO` not promoted to `pub(crate)`.** A5 tests construct events by mutating `ofd.input_mut().event_ring` directly; A6 tests can do the same (helpers `push_event_into_ofd` + `extract_record_at` are in scope in syscalls::tests).
- **`input_state` fork serialisation.** TODO breadcrumbs live in `fork.rs` at the two deserialise sites — A6's `fork_then_close_in_child_keeps_grab_on_parent` test may force this; see §"Tactical pointers for A6".
- **`build-libdrm-stub.sh` Q4 follow-up.** Not blocking plan 5.
- **Q4 follow-up: kernel-level `sys_read(card0)` blocking semantics.** Deferred to v3.
- **Real `wake_event_reader` routing.** Phase B wires it.

## Standing instruction for session 27

**Print this sentence in the next session's first turn:**

> *"Read `docs/plans/2026-06-11-dri-kandelo-port-handoff-26.md` first (in the 9vbaz worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Plan-5 / evdev A1–A5 are committed at `b4c3464ac` / `fa47afa22` / `d8539d252` / `fd1b502d0` / `479fe65c2` on branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001` off Q4 base `001729c67`; no PR opened. **Strategy: ONE PR, 15 commits total** — 5 landed, 10 to go; do NOT split into the plan's 3-PR shape. **Next task: A6 — close releases grab + drops ring.** Plan body at lines 1511–1552 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree). **The plan body's `OpenFileDesc::on_final_close` method does NOT exist** — our codebase does close-time cleanup procedurally via `sys_close` (syscalls.rs:2021) snapshotting `dri_state` and calling `dri_release_ofd_state` (syscalls.rs:1610). Either (a) mirror that pattern with a new `input_release_ofd_state` helper for symmetry + plan-9 hook (recommended), or (b) rely on automatic Drop of `entries[idx] = None`. Both correct for v1. Tests called for: `close_releases_grab_so_next_open_can_grab` (low bar — cross-OFD grab not enforced in v1) and `fork_then_close_in_child_keeps_grab_on_parent` (may force wiring `input_state` fork serialisation — TODO breadcrumbs in `fork.rs` ~lines 304/438/457/2223/2294/2370). Acceptable to split A6 into A6a (close cleanup + test 1) and A6b (fork serialisation + test 2) → 16-commit PR. **Wait for user input before each commit.** Do NOT open the Q4 PR. Do NOT touch modeset.c's 60 Hz throttle. Do NOT redo the dye-fade experiment. If the worktree was wiped, re-run the cold-start dance in handoff-26 §"Cold-start dance" (sources from the Q4 worktree, NOT 9vbaz)."*
