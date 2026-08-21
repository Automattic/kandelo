# DRI port onto kandelo:main — session 27 handoff (evdev A6 + A7 COMMITTED; B1 next)

Continuation of [handoff-26](./2026-06-11-dri-kandelo-port-handoff-26.md). Session 27 landed A6 (close-time `input_state` cleanup + full fork/exec serialisation + 2 tests) and A7 (additive ABI snapshot regen for the 2 new evdev exports). Stopped after A7 to free context; Phase B was scoped but not edited.

## TL;DR — read this twice

1. **Worktree is `explore-dri-evdev-plan`** at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`, branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`. Branched off `explore-dri-q4-vblank-gating` at `001729c67`.

2. **Seven evdev commits landed on top of Q4:**
   - `b4c3464ac` — A1 shared ABI (session 24)
   - `fa47afa22` — A2 OFD plumbing (session 24)
   - `d8539d252` — A3 EVIOCG* ioctl dispatch (session 25)
   - `fd1b502d0` — A4 `kernel_input_event` + fan-out + ring overflow (session 25)
   - `479fe65c2` — A5 `sys_read` drain + `sys_poll` POLLIN + SYN_DROPPED (session 26)
   - `26393f20d` — **A6 close releases grab + fork/exec serialises input_state** (this session; 2 files / +196 / -8)
   - `e583f979f` — **A7 ABI snapshot regen (additive)** (this session; 1 file / +10 / -0)

   A1–A6 are pure-additive at the kernel-wasm export layer. A7 captures A4's two new exports in `abi/snapshot.json`. **No `ABI_VERSION` bump.**

3. **One PR, 15 commits — 7/15 in, 8 to go.** User directive (handoff-24 §3) collapses the plan's 3-PR split. Skip per-phase "open PR" steps. Manual browser verify still required before the PR opens.

4. **No PR opened yet.** User hasn't asked. Don't open it until they do.

5. **B1 is next: `InputSource` module + interface.** Plan body at lines 1646–1680 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, **in the 9vbaz worktree**, NOT the evdev worktree). **Phase B touches host code — dual-host parity is load-bearing** per CLAUDE.md §"Two hosts: Browser AND Node.js". B1's interface lands in shared host code; B2 + B3 are the per-host implementations and they MUST land in the same commit window. See §"Tactical pointers for B1" below.

6. **Wait for user input before each commit.** Standing instruction from handoff-24 still applies. **But** the user has repeatedly pushed back on splitting tasks (A6a/A6b was redirected to single-commit A6) — when in doubt, do the full task in one commit and only split if it genuinely exceeds one commit's worth of scope.

## Commits this session

```
e583f979f abi: regenerate snapshot for additive evdev kernel exports                              (A7; 1 file / +10 / -0)
26393f20d kernel(input): release input_state on close + serialise across fork/exec               (A6; 2 files / +196 / -8)
479fe65c2 kernel(input): sys_read drains ring + sys_poll POLLIN gating + SYN_DROPPED resync     (A5; session 26)
fd1b502d0 kernel(input): kernel_input_event export + fan-out + ring overflow handling           (A4; session 25)
d8539d252 kernel(input): EVIOCG* ioctl dispatch + populate_evbit                                 (A3; session 25)
fa47afa22 kernel(input): add /dev/input/event{0,1} + InputFdState on OFD                         (A2; session 24)
b4c3464ac kernel(input): shared ABI — struct input_event + EV_*/KEY_*/EVIOC* constants           (A1; session 24)
001729c67 dri(kernel+host+libdrm): retire PAGE_FLIP on vblank pump tick                          (Q4 base)
```

Co-author footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. **No `🤖 Generated with` line** (CLAUDE.md anti-emoji rule).

## What landed in A6 (commit 26393f20d)

Two files: `crates/kernel/src/syscalls.rs` (+120 / -0) and `crates/kernel/src/fork.rs` (+84 / -8).

### Production changes — `syscalls.rs`

**New helper `input_release_ofd_state` (placed right after `dri_release_ofd_state` at ~line 1659):**
```rust
pub(crate) fn input_release_ofd_state(
    _pid: i32,
    _host: &mut dyn HostIO,
    _ofd_idx: usize,
    state: Option<alloc::boxed::Box<crate::ofd::InputFdState>>,
) {
    let _ = state;
}
```
- v1 body is just an explicit drop of the boxed state — per-OFD ring + grab + dropped flag go with it.
- `_pid` / `_host` / `_ofd_idx` reserved for the plan-9 grab-released hook (`host.input_grab_released(pid, device)`).
- Signature mirrors `dri_release_ofd_state` for symmetry at the close call site.

**`sys_close` snapshot block (placed after the `dri_state_for_release` snapshot at ~line 2053):**
```rust
let input_state_for_release = {
    let ofd = proc.ofd_table.get(idx).ok_or(Errno::EBADF)?;
    if ofd.ref_count == 1 {
        proc.ofd_table.get_mut(idx).and_then(|ofd| ofd.input_state.take())
    } else {
        None
    }
};
```
And call right after `dri_release_ofd_state(...)` in the `if freed {` block (~line 2078):
```rust
input_release_ofd_state(proc.pid as i32, host, idx, input_state_for_release);
```

### Production changes — `fork.rs`

**New tag constants next to `DRI_TAG_*` (~line 282):**
```rust
const INPUT_TAG_NONE: u8 = 0;
const INPUT_TAG_SOME: u8 = 1;
```

**`write_input_state(w, state)` (placed after `write_dri_state`):**
- Tag byte; if `Some`: device (u8) + grabbed (u8) + dropped (u8) + ring_high_water (u32) + ring_len (u32) + ring bytes.

**`read_input_state(r) -> Result<Option<Box<InputFdState>>, Errno>` (placed before `read_dri_state`):**
- Bounds-checks `ring_len <= INPUT_RING_MAX_BYTES` and `ring_len % size_of::<WpkInputEvent>() == 0`. Returns `EINVAL` on bad stream.

**Wired into 4 sites** — both `TODO(plan-5 A4/A5)` breadcrumbs removed:
- Fork serialise (after `write_dri_state(..., preserve_master=false)` at ~line 624): `write_input_state(&mut w, ofd.input_state.as_deref())?;`
- Fork deserialise (~line 927): `let input_state = read_input_state(&mut r)?;` then `input_state,` in the OFD struct (replacing `input_state: None`).
- Exec serialise (after `write_dri_state(..., preserve_master=true)` at ~line 1400): same call as fork serialise.
- Exec deserialise (~line 1546): same read pattern as fork deserialise.

### Tests added

1. **`close_releases_grab_so_next_open_can_grab`** (pid 616): open event0 → EVIOCGRAB → close → assert OFD slot is `None` → reopen event0 → assert fresh `InputFdState` (empty ring, `dropped=false`, `grabbed=false`) → EVIOCGRAB again succeeds.
2. **`fork_then_close_in_child_keeps_grab_on_parent`** (pid 617): parent opens event0 + EVIOCGRAB + pushes 2 events via `push_event_into_ofd`; calls `crate::fork::serialize_fork_state` + `deserialize_fork_state` (child pid 717); asserts child carries grab + 48-byte ring; `sys_close` in child; asserts child OFD slot is `None` AND parent's OFD still has grab + 48-byte ring.

**Plan deviations folded into A6 (carry forward — don't relitigate):**

1. **Plan body's `OpenFileDesc::on_final_close` method doesn't exist.** Mirrored the procedural pattern from `dri_release_ofd_state` instead. The architectural pivot was already flagged in handoff-26 §"Architectural pivot".
2. **User redirected the proposed A6a / A6b split into a single A6 commit.** Don't split tasks pre-emptively. The fork serialisation is mechanical wire-format work — well within scope for one commit. **Rule of thumb going forward:** propose full-scope commits; only split if the task genuinely exceeds one commit's worth.
3. **Fork wire format is intentionally minimal** — `ring_high_water` is carried for debug fidelity even though A7 doesn't add it to `abi/snapshot.json`. The fork stream is an internal kernel format, not an ABI surface tracked by the structural snapshot.
4. **No host-side notification at v1 grab-release.** Plan 9 will wire `host.input_grab_released(pid, device)` — that's the only reason the helper exists at all instead of relying on automatic Drop.
5. **Test `fork_then_close_in_child_keeps_grab_on_parent` lives in `syscalls.rs::tests`, not `fork.rs::tests`.** It needs both `open_evdev` / `sys_close` (only in syscalls.rs) and `serialize_fork_state` / `deserialize_fork_state` (only in fork.rs); putting it in syscalls.rs keeps fewer cross-module test helpers.

## What landed in A7 (commit e583f979f)

Single file: `abi/snapshot.json` (+10 / -0).

```
+    { "kind": "func", "name": "kernel_input_event",            "signature": "(i32,i32,i32,i32) -> ()" }
+    { "kind": "func", "name": "kernel_set_input_canvas_dims",  "signature": "(i32,i32) -> ()" }
```

Both inserted alphabetically (`kernel_input_event` between `kernel_inject_mouse_event` and `kernel_ioctl`; `kernel_set_input_canvas_dims` between `kernel_set_fork_fd_action` and `kernel_set_max_addr`).

**`scripts/check-abi-version.sh update`** also touched `libc/glue/abi_constants.h` and `host/src/generated/abi.ts` but both were already byte-identical to the regenerated source — A4 had hand-stubbed them in sync. No diff there.

**`bash scripts/check-abi-version.sh` (verify) still fails the same way it did before A7** — that's pre-existing upstream snapshot drift from PR #629 (pthread slot dynamism). The script reports:
- `breaking: changed top-level section "host_adapter"`
- `breaking: removed kernel_exports entry "kernel_reserve_host_region"`
- `breaking: removed kernel_exports entry "kernel_reserve_host_region_at"`
- `breaking: changed top-level section "process_memory_layout"`

These are NOT introduced by plan-5; they were already there. The commit message references the precedent `00d123bf9` ("abi: regenerate snapshot for additive kernel exports") which documented the same drift. **Step 5 of CLAUDE.md's test verification will fail on this branch until the upstream snapshot is regenerated — that's a branch-wide condition, not a regression.** The PR description should call this out.

`ABI_VERSION` stays at 14.

## Verification snapshot (at A7 close)

```bash
cargo test -p kandelo --target aarch64-apple-darwin --lib  # → 984/984 pass (+2 vs A5's 982)
cargo check -p kandelo --target wasm32-unknown-unknown --release  # → clean (47 pre-existing warnings, 0 errors)
bash scripts/check-abi-version.sh  # → exits 1 with pre-existing drift; additive evdev surface is recognised
```

CLAUDE.md suites still NOT re-run this session (kernel-only churn that doesn't touch the syscall ABI):
- vitest — host has no plan-5 code yet.
- musl libc-test — no libc changes.
- POSIX Test Suite — no syscall semantics changes.

Run **all five suites** before opening the PR (after C is done). Step 5 will fail on the pre-existing PR #629 drift — that's a documented branch-wide condition, not a plan-5 regression.

## Phase A roadmap — DONE

| # | Task | Commit | Notes |
|---|---|---|---|
| 1/15 | A1 — shared ABI | `b4c3464ac` | session 24 |
| 2/15 | A2 — OFD plumbing | `fa47afa22` | session 24 |
| 3/15 | A3 — EVIOCG* dispatch | `d8539d252` | session 25 |
| 4/15 | A4 — `kernel_input_event` | `fd1b502d0` | session 25 |
| 5/15 | A5 — sys_read drain + POLLIN | `479fe65c2` | session 26 |
| 6/15 | A6 — close + fork serialise | `26393f20d` | this session |
| 7/15 | A7 — ABI snapshot regen | `e583f979f` | this session |

## Phase B roadmap — what's left (5 commits to host)

Plan body line indexes refer to `docs/plans/2026-06-15-dri-evdev-plan.md` in the 9vbaz worktree.

| # | Task | Plan body lines | Files |
|---|---|---|---|
| 8/15 | **B1** — `InputSource` module + interface | 1646–1680 | `host/src/input/index.ts` (or similar — TBD) |
| 9/15 | **B2** — `BrowserInputSource` — DOM event capture + key-code translation | 1681–1840 | `host/src/input/browser-input-source.ts` + dual-host parity |
| 10/15 | **B3** — `NodeInputSource` — null-source for tests + headless runs | 1841–1866 | `host/src/input/node-input-source.ts` + dual-host parity |
| 11/15 | **B4** — Wire `kernel_input_event` + dual-host parity | 1867–1890 | `host/src/node-kernel-worker-entry.ts` + `host/src/browser-kernel-worker-entry.ts` + adapters |
| 12/15 | **B5** — Vitest end-to-end key + pointer round-trip | 1891–1915 | `host/test/...` + new `apps/browser-demos/...` spec for browser parity |

Then Phase C (sysroot + demo, 3 commits C1–C3 at lines 1931–2070). C4 (manual browser verify at lines 2071–2086) required before PR, adds no commit. **B6 / C5 are skipped** under the single-PR strategy.

## Tactical pointers for B1

### Read these in order before touching code

1. **Plan body B1**: `docs/plans/2026-06-15-dri-evdev-plan.md` lines 1646–1680 (in the 9vbaz worktree).
2. **CLAUDE.md §"Two hosts: Browser AND Node.js — DUAL-HOST PARITY IS LOAD-BEARING"** — this is load-bearing for B2+. PR #388 / #410 were both one-sided host changes that broke the browser demo. Don't repeat that mistake.
3. **The existing host input plumbing** for `/dev/input/mice`:
   - `host/src/node-kernel-host.ts` + `host/src/browser-kernel-host.ts` — host entry points
   - `host/src/node-kernel-worker-entry.ts` + `host/src/browser-kernel-worker-entry.ts` — spawn / fork / exec / clone / exit / terminate handlers
   - `host/src/worker-adapter.ts` + `host/src/worker-adapter-browser.ts` — worker adapters
   - The browser side currently uses `BrowserMouseSource` (search `apps/browser-demos/` or `host/src/` for the symbol) — that's the closest existing analogue to `BrowserInputSource`. Read it first.
4. **`crate::input::dispatch::push_event`** in `crates/kernel/src/input/dispatch.rs` — this is what `kernel_input_event` calls into. Phase B's host wiring just calls the export with `(device, ev_type, code, value)` per kernel event.
5. **The wake-event-reader stub** at `crates/kernel/src/input/wait.rs` — module docs explain the wake-routing decision deferred to Phase B. **B4 may need to revisit the wake-namespace question** (pendingInputReaders registry vs separate wake-idx space). See handoff-25 §"Architecturally load-bearing decisions" — that decision is open.

### Dual-host parity reminder (CLAUDE.md hard requirement)

A change is incomplete unless ALL of these hold:

1. **Symmetry check first.** Before writing any host-side change, run `grep -rn "<symbol>" host/ apps/browser-demos/` for every callsite of the affected function. Both trees should show parallel structure; if one is missing handlers the other has, that's the change.
2. **Both PRs of the wiring land in the same commit.** Don't merge a host-side change with a TODO/follow-up note for the other side.
3. **Tests cover both paths.** A vitest test (Node) does not protect the browser path. Add a browser test under `packages/registry/<pkg>/test/**/*.spec.ts` (Playwright) or `apps/browser-demos/test/`, OR manually verify the affected demo via `./run.sh browser`.
4. **PR description names both hosts.** The reviewer should not have to ask "what about the browser?"

### Suggested B1 commit message

```
host(input): InputSource module + interface
```

If B1 ends up shared infrastructure only (no per-host code), one commit. If B1+B2 are genuinely tight together, consider folding — but check user before doing so.

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

Git status at session-27 close (besides committed files):

```
 m libc/musl                              (cp -R workaround; submodule shows dirty)
?? docs/plans/2026-06-11-dri-kandelo-port-handoff-24.md   (carried untracked since session 24)
?? node_modules                          (cold-start symlink)
?? open-posix-testsuite                  (cold-start symlink)
```

Plan-doc handoffs (21 → 27) stay untracked in the 9vbaz worktree. **Stage exactly the code files per commit; never `git add -A`.**

## Architecturally load-bearing decisions (don't relitigate during B1)

These were folded into A1 / A2 / A3 / A4 / A5 / A6 / A7 or carry from earlier sessions:

- **24-byte `WpkInputEvent` with explicit `_pad: i32` at offset 12.** Drift = silent corruption.
- **`input_state` parallel to `dri_state` on OFD**, NOT nested under `DriOfdState`.
- **Per-OFD ring is 1024 records (24 KiB).** Overflow latches `dropped`; **incoming** record discarded (Linux semantics).
- **`sys_read` returns `Ok(0)` on empty + clean ring + blocking mode; `EAGAIN` on `O_NONBLOCK`.** Mirrors DriCard0. Kernel never parks the reader.
- **`sys_read` returns `EINVAL` on sub-24-byte buffer.**
- **POLLIN gates on `!event_ring.is_empty() || dropped`.** Single arm in `poll_check` covers poll/ppoll/select/pselect6.
- **`EVIOCGRAB` recorded but NOT enforced in v1.** Cross-OFD enforcement is plan 9's compositor task.
- **Unknown `EVIOCG*` and non-'E' magic return `ENOTTY`**, not `EINVAL` (SDL2 carve-out).
- **`crate::input::wait::wake_event_reader` is a v1 no-op stub.** Real routing lands in Phase B — open question whether to allocate a separate wake-idx space or extend the `pendingPipeReaders` registry.
- **`BrowserInputSource.onPointerMove` emits `EV_ABS` by default**; `EV_REL` only on `pointerLockElement`. **B2 wiring concern.**
- **`/dev/input` `readdir` lists event0 + event1.**
- **CLOCK_MONOTONIC for all event timestamps** — `kernel_input_event` stamps via `WasmHostIO.host_clock_gettime`.
- **`OpenFileDesc::on_final_close` does NOT exist** — close-time cleanup is procedural in `sys_close` (snapshot + `dec_ref` + `dri_release_ofd_state` + **A6's `input_release_ofd_state`**).
- **Fork wire format for `input_state`:** `INPUT_TAG_NONE`/`INPUT_TAG_SOME` byte + device + grabbed + dropped + ring_high_water + ring_len + ring bytes. Reader bounds-checks against `INPUT_RING_MAX_BYTES` and rejects non-record-aligned lengths. Not in `abi/snapshot.json` — fork stream is internal.
- **A7 ABI surface delta is the 2 exports only.** `WpkInputEvent` / EV_* / KEY_* / EVIOC* constants are in `shared::input`, not tracked by `abi/snapshot.json`.
- **`ABI_VERSION` stays at 14.** PR #629 drift is pre-existing and documented.
- **User pushed back on A6a/A6b split.** Default to single-commit full tasks unless the task obviously exceeds one commit's worth of work.
- **Single-PR strategy.** All 15 commits land together on `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`.

## What deliberately stays NOT done

- **Q4 PR not opened.** User declined.
- **Modeset dye-fade experiment.** Don't redo.
- **`modeset.c`'s 60 Hz throttle.** Keep (standing instruction since v20).
- **`MockHostIO` not promoted to `pub(crate)`.** Phase B host tests use whatever pattern the existing `BrowserMouseSource` tests use.
- **Real `wake_event_reader` routing.** Open in B4. Decide: separate wake-idx space vs extend `pendingPipeReaders`.
- **`build-libdrm-stub.sh` Q4 follow-up.** Not blocking plan 5.
- **Q4 follow-up: kernel-level `sys_read(card0)` blocking semantics.** Deferred to v3.
- **PR #629 upstream snapshot drift.** Pre-existing; A7 documents it. Not a plan-5 fix.

## Standing instruction for session 28

**Print this sentence in the next session's first turn:**

> *"Read `docs/plans/2026-06-11-dri-kandelo-port-handoff-27.md` first (in the 9vbaz worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Plan-5 / evdev A1–A7 are committed at `b4c3464ac` / `fa47afa22` / `d8539d252` / `fd1b502d0` / `479fe65c2` / `26393f20d` / `e583f979f` on branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001` off Q4 base `001729c67`; no PR opened. **Strategy: ONE PR, 15 commits total** — 7 landed, 8 to go; do NOT split into the plan's 3-PR shape. **Phase A is complete; B1 is next: `InputSource` module + interface.** Plan body at lines 1646–1680 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree). **Phase B touches host code — dual-host parity (Node + Browser, same commit) is load-bearing per CLAUDE.md.** Symmetry-check first; PR #388 / #410 were both one-sided host fixes that broke production demos. Default to single-commit full tasks (user redirected A6a/A6b → single A6 commit) unless task obviously > 1 commit. **Wait for user input before each commit.** Do NOT open the Q4 PR. Do NOT touch modeset.c's 60 Hz throttle. Do NOT redo the dye-fade experiment. `bash scripts/check-abi-version.sh` will fail on pre-existing PR #629 drift — that's branch-wide, not a regression. If the worktree was wiped, re-run the cold-start dance in handoff-27 §"Cold-start dance" (sources from the Q4 worktree, NOT 9vbaz)."*
