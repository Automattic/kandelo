# DRI port onto kandelo:main — session 28 handoff (devil's-advocate trim of Phase A; B1 still next)

Continuation of [handoff-27](./2026-06-11-dri-kandelo-port-handoff-27.md). Session 28 ran a devil's-advocate pass over the seven Phase A commits (A1–A7), pruned five ceremony patterns into a single cleanup commit (`6a71f593f`), and left Phase B untouched. **B1 is still next** — the cleanup was a pure subtraction at the kernel layer; no new functionality landed.

## TL;DR — read this twice

1. **Worktree is `explore-dri-evdev-plan`** at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`, branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`. Branched off `explore-dri-q4-vblank-gating` at `001729c67`.

2. **Eight commits landed on top of Q4:**
   - `b4c3464ac` — A1 shared ABI (session 24)
   - `fa47afa22` — A2 OFD plumbing (session 24)
   - `d8539d252` — A3 EVIOCG* ioctl dispatch (session 25)
   - `fd1b502d0` — A4 `kernel_input_event` + fan-out (session 25)
   - `479fe65c2` — A5 `sys_read` drain + `sys_poll` POLLIN (session 26)
   - `26393f20d` — A6 close + fork/exec serialise (session 27)
   - `e583f979f` — A7 ABI snapshot regen (session 27)
   - **`6a71f593f` — cleanup: ring_high_water / wake stub / close helper (this session; 7 files / +39 / -191)**

   A1–A6 are pure-additive at the kernel-wasm export layer. A7 captures A4's two new exports in `abi/snapshot.json`. **No `ABI_VERSION` bump.** The cleanup is entirely below the export surface — `abi/snapshot.json` is byte-identical before/after.

3. **One PR, 15 commits — 8/15 in, 7 to go.** The cleanup commit replaces one of the eight A-phase commits in the count *only conceptually*; it's a new commit on top, so the PR will carry all eight. **Skip per-phase "open PR" steps.** Manual browser verify still required before the PR opens.

4. **No PR opened yet.** User hasn't asked. Don't open it until they do.

5. **B1 is next: `InputSource` module + interface.** Plan body at lines 1646–1680 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, **in the 9vbaz worktree**, NOT the evdev worktree). **Phase B touches host code — dual-host parity is load-bearing** per CLAUDE.md §"Two hosts: Browser AND Node.js". B1's interface lands in shared host code; B2 + B3 are the per-host implementations and they MUST land in the same commit window. See handoff-27 §"Tactical pointers for B1".

6. **Wait for user input before each commit.** Standing instruction from handoff-24 still applies. The user has repeatedly pushed back on splitting tasks — when in doubt, do the full task in one commit and only split if it genuinely exceeds one commit's worth of scope.

## What landed in commit 6a71f593f (this session)

Seven files: `crates/kernel/src/{fork.rs, input/dispatch.rs, input/mod.rs, ofd.rs, syscalls.rs, wasm_api.rs}` (modified) + `crates/kernel/src/input/wait.rs` (deleted). Net **+39 / -191**.

### Ceremony pattern 1 — `ring_high_water` field on `InputFdState`

**Removed:** the `u32` peak-record counter, its inc-on-push in `dispatch::push_event`, its serialise/deserialise in `fork.rs`, the `push_event_tracks_high_water` test, and the assertion in `input_accessors_route_to_attached_state`.

**Why:** the field was documented as "debug-only, not exposed to userspace." Zero production readers; the only consumer was its own dedicated test. The fork wire carried 4 unused bytes per OFD.

### Ceremony pattern 2 — `crate::input::wait::wake_event_reader` stub

**Removed:** the entire `input/wait.rs` file, its `pub mod wait;` declaration in `input/mod.rs`, the `was_empty`/`woken_ofds` bookkeeping in `dispatch::push_event` that fed it, and the inline comments in `sys_read`/`read_eventN_returns_zero_before_any_event` that referenced it by name.

**Why:** the function body was empty. The bookkeeping built a `Vec<usize>` whose only purpose was to feed a no-op. Phase B (B4 specifically) needs real wake routing — that's the right place to add a `wake_event_reader` (or whatever the routing layer turns out to be named) where it's actually wired. Stubs ahead of wiring are an attempt-artifact, not architecture.

### Ceremony pattern 3 — `input_release_ofd_state` helper + sys_close snapshot

**Removed:** the helper (`pub(crate) fn input_release_ofd_state(_pid, _host, _ofd_idx, state)` whose body was `let _ = state;`), the input_state snapshot block in `sys_close` that took the box off the OFD before `dec_ref`, and the call site after `dri_release_ofd_state`.

**Why:** parity-for-parity. The DRI release helper exists because it calls into the host (`dri_release_handle` per GEM handle). The input helper had no host call — the body was a literal explicit-drop. Slot Drop on `dec_ref` already releases the box. The snapshot/take/helper pattern was modeled on DRI without examining whether the model fit.

The two A6 tests (`close_releases_grab_so_next_open_can_grab` and `fork_then_close_in_child_keeps_grab_on_parent`) still pass — they verify the *outcome* (slot is None after close; parent retains grab after child closes its copy), which is exactly what slot Drop achieves.

### Ceremony pattern 4 — `VirtualDevice::InputEvent` host_handle catchall

**Removed:** the three-arm match (`InputEvent { device: 0 } => -10` / `InputEvent { device: 1 } => -11` / `InputEvent { .. } => -10`).

**Replaced with:** `InputEvent { device } => -10 - device as i64`.

**Why:** the trailing `=> -10` was an attempt-artifact from satisfying the type checker on the overly-permissive `device: u8`. It returned the *keyboard's* handle for any out-of-range device, which would have aliased silently if ever hit. The arithmetic form is total without inventing a wrong handle.

### Ceremony pattern 5 — over-long doc comments in `wasm_api.rs`

**Trimmed:** the "Convention: the host emits the type-specific record first…" paragraph on `kernel_input_event` (caller-side expectation, not function behaviour), the "Additive export; ABI-safe. See the boot-ordering contract in plan 5 §A4 step 3" line on `kernel_set_input_canvas_dims`, and the multi-line "doesn't actually park the reader…wake_event_reader gets real routing in Phase B" comment in `sys_read` (reduced to one sentence that doesn't name the deleted symbol).

### Test count

`cargo test -p kandelo --target aarch64-apple-darwin --lib` → **983 / 983 pass.** Was 984 / 984 before the cleanup; -1 for the deleted `push_event_tracks_high_water` test (the field it tested is gone). Zero new test failures.

### ABI surface

`bash scripts/check-abi-version.sh update` → snapshot regenerated; `git diff abi/snapshot.json libc/glue/abi_constants.h host/src/generated/abi.ts` → **0 lines.** The cleanup did not touch any exported symbol's signature, kernel global, or marshalled struct. `ABI_VERSION` stays at 14.

`bash scripts/check-abi-version.sh` (verify) still fails on the same pre-existing PR #629 drift items (`host_adapter`, `kernel_reserve_host_region`, `kernel_reserve_host_region_at`, `process_memory_layout`) — branch-wide condition, not a regression, documented in handoff-27 §"What landed in A7".

## What deliberately stayed in Phase A (don't re-prune in session 29)

These were considered and kept:

1. **The full `KEY_*` / `BTN_*` / `REL_*` / `ABS_*` constant table in `shared::input`.** Only `KEY_MICMUTE`, `KEY_A`, `KEY_Z`, `KEY_ESC`, `BTN_LEFT` are referenced today (by `populate_evbit` and tests). The rest are anticipated by **B2's DOM → evdev translation table** (Plan-5 §B2 in `docs/plans/2026-06-15-dri-evdev-plan.md`, lines 1681–1840). Removing them now to re-add in B2 is churn, not cleanup. The published evdev ABI surface is a deliberate one-shot.

2. **`WpkInputEvent._pad: i32` + its long doc.** The pad is load-bearing because the wasm32-musl `struct timeval` substruct is 16 bytes (i64 `tv_sec` forces 8-byte alignment of the trailing `i32 tv_usec`), so the C reader expects `ev_type` at offset 16. Without the pad, `repr(C)` puts `ev_type` at offset 12 → silent corruption on every record. The `input_event_field_offsets` test gates this; the comment explains why the gate exists.

3. **`grabbed: bool` field on `InputFdState`** — recorded but NOT enforced in v1. Plan 9 (wpkcompositor) adds cross-OFD focus routing. The field has a clear consumer in plan 9 and the round-trip tests guard its fork survival. Don't drop just because v1 doesn't enforce.

4. **The `InputFdState.device: u8` cache.** It avoids a second `VirtualDevice::from_host_handle()` lookup in `push_event` and the EVIOC* dispatch. Trivially worth the byte.

5. **The split `VirtualDevice::InputEvent { device: u8 }` as one variant** (rather than `InputKeyboard` / `InputPointer` two variants). The u8 representation matches "event{N}" suffix, is convenient as ABI input to `dispatch::push_event`, and the cleanup of pattern 4 above closed the only correctness gap. Splitting into two variants would ripple through 6+ call sites for no functional gain.

## What deliberately stays NOT done (carry from handoff-27)

- **Q4 PR not opened.** User declined.
- **Modeset dye-fade experiment.** Don't redo.
- **`modeset.c`'s 60 Hz throttle.** Keep (standing instruction since v20).
- **`MockHostIO` not promoted to `pub(crate)`.** Phase B host tests use whatever pattern existing host tests use.
- **Real `wake_event_reader` routing.** Open in B4. **Now genuinely absent from the codebase** (this session removed the stub). Decide at B4 time: separate wake-idx space vs extend `pendingPipeReaders`.
- **`build-libdrm-stub.sh` Q4 follow-up.** Not blocking plan 5.
- **Q4 follow-up: kernel-level `sys_read(card0)` blocking semantics.** Deferred to v3.
- **PR #629 upstream snapshot drift.** Pre-existing; A7 documents it. Not a plan-5 fix.

## Phase A roadmap — DONE + audited

| # | Task | Commit | Notes |
|---|---|---|---|
| 1 | A1 — shared ABI | `b4c3464ac` | session 24 |
| 2 | A2 — OFD plumbing | `fa47afa22` | session 24 |
| 3 | A3 — EVIOCG* dispatch | `d8539d252` | session 25 |
| 4 | A4 — `kernel_input_event` | `fd1b502d0` | session 25 |
| 5 | A5 — sys_read drain + POLLIN | `479fe65c2` | session 26 |
| 6 | A6 — close + fork serialise | `26393f20d` | session 27 |
| 7 | A7 — ABI snapshot regen | `e583f979f` | session 27 |
| 8 | **cleanup — Phase A devil's-advocate pass** | **`6a71f593f`** | **this session** |

## Phase B roadmap — what's left (5 commits to host)

Plan body line indexes refer to `docs/plans/2026-06-15-dri-evdev-plan.md` in the 9vbaz worktree.

| # | Task | Plan body lines | Files |
|---|---|---|---|
| 9 | **B1** — `InputSource` module + interface | 1646–1680 | `host/src/input/index.ts` (or similar — TBD) |
| 10 | **B2** — `BrowserInputSource` — DOM event capture + key-code translation | 1681–1840 | `host/src/input/browser-input-source.ts` + dual-host parity |
| 11 | **B3** — `NodeInputSource` — null-source for tests + headless runs | 1841–1866 | `host/src/input/node-input-source.ts` + dual-host parity |
| 12 | **B4** — Wire `kernel_input_event` + dual-host parity + **real wake routing** | 1867–1890 | host worker entries + adapters; **see "What deliberately stays NOT done" above re wake routing** |
| 13 | **B5** — Vitest end-to-end key + pointer round-trip | 1891–1915 | `host/test/...` + new `apps/browser-demos/...` spec for browser parity |

Then Phase C (sysroot + demo, 3 commits C1–C3 at lines 1931–2070). C4 (manual browser verify at lines 2071–2086) required before PR, adds no commit. **B6 / C5 are skipped** under the single-PR strategy.

## Tactical pointers for B1 (unchanged from handoff-27)

### Read these in order before touching code

1. **Plan body B1**: `docs/plans/2026-06-15-dri-evdev-plan.md` lines 1646–1680 (in the 9vbaz worktree).
2. **CLAUDE.md §"Two hosts: Browser AND Node.js — DUAL-HOST PARITY IS LOAD-BEARING"** — load-bearing for B2+. PR #388 / #410 were both one-sided host changes that broke the browser demo.
3. **The existing host input plumbing** for `/dev/input/mice`:
   - `host/src/node-kernel-host.ts` + `host/src/browser-kernel-host.ts`
   - `host/src/node-kernel-worker-entry.ts` + `host/src/browser-kernel-worker-entry.ts`
   - `host/src/worker-adapter.ts` + `host/src/worker-adapter-browser.ts`
   - The browser side currently uses `BrowserMouseSource` — closest existing analogue to `BrowserInputSource`. Read it first.
4. **`crate::input::dispatch::push_event`** in `crates/kernel/src/input/dispatch.rs` — what `kernel_input_event` calls into. Phase B's host wiring just calls the export with `(device, ev_type, code, value)` per kernel event.
5. **B4 wake routing is open.** No stub to grep for now — the symbol was deleted this session. Pick a wake mechanism (separate wake-idx space vs extend `pendingPipeReaders`) when wiring B4.

### Dual-host parity reminder (CLAUDE.md hard requirement)

A change is incomplete unless ALL of these hold:

1. **Symmetry check first.** Run `grep -rn "<symbol>" host/ apps/browser-demos/` for every callsite of the affected function. Both trees should show parallel structure.
2. **Both PRs of the wiring land in the same commit.** Don't merge a host-side change with a TODO for the other side.
3. **Tests cover both paths.** Vitest does not protect the browser path. Add a browser test OR manually verify the affected demo via `./run.sh browser` per CLAUDE.md item 6.
4. **PR description names both hosts.** The reviewer should not have to ask "what about the browser?"

## Architecturally load-bearing decisions (don't relitigate during B1)

Carrying from handoff-27, with this session's deltas marked:

- **24-byte `WpkInputEvent` with explicit `_pad: i32` at offset 12.** Drift = silent corruption.
- **`input_state` parallel to `dri_state` on OFD**, NOT nested under `DriOfdState`.
- **Per-OFD ring is 1024 records (24 KiB).** Overflow latches `dropped`; **incoming** record discarded (Linux semantics).
- **`sys_read` returns `Ok(0)` on empty + clean ring + blocking mode; `EAGAIN` on `O_NONBLOCK`.** Mirrors DriCard0.
- **`sys_read` returns `EINVAL` on sub-24-byte buffer.**
- **POLLIN gates on `!event_ring.is_empty() || dropped`.**
- **`EVIOCGRAB` recorded but NOT enforced in v1.** Plan 9's compositor task.
- **Unknown `EVIOCG*` and non-'E' magic return `ENOTTY`**, not `EINVAL` (SDL2 carve-out).
- **`/dev/input` `readdir` lists event0 + event1.**
- **CLOCK_MONOTONIC for all event timestamps.**
- **`OpenFileDesc::on_final_close` does NOT exist** — close-time cleanup is procedural in `sys_close` (snapshot + `dec_ref` + `dri_release_ofd_state`). **This session removed `input_release_ofd_state` entirely;** the input box now relies on slot Drop after dec_ref. If plan 9 needs a grab-release host notification, wire it at the call site at that time — the helper is not architecturally required.
- **Fork wire format for `input_state`:** `INPUT_TAG_NONE`/`INPUT_TAG_SOME` byte + device + grabbed + dropped + ring_len + ring bytes. **`ring_high_water` removed from wire this session.** Reader still bounds-checks against `INPUT_RING_MAX_BYTES` and rejects non-record-aligned lengths.
- **A7 ABI surface delta is the 2 exports only.** `WpkInputEvent` / EV_* / KEY_* / EVIOC* constants are in `shared::input`, not tracked by `abi/snapshot.json`.
- **`ABI_VERSION` stays at 14.** PR #629 drift is pre-existing and documented.
- **Single-PR strategy.** All commits land together on `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`.
- **User pushed back on A6a/A6b split.** Default to single-commit full tasks unless the task obviously exceeds one commit's worth.
- **NEW: `crate::input::wait` module does not exist.** Removed this session. B4 picks the wake mechanism and the symbol name when wiring real routing.
- **NEW: `VirtualDevice::InputEvent` host_handle encoding is `-10 - device as i64`.** Round-trip is still gated on `device ∈ {0,1}` by `from_host_handle` accepting only -10 and -11.

## Verification snapshot (at session 28 close)

```bash
cargo test -p kandelo --target aarch64-apple-darwin --lib  # → 983/983 pass
cargo check -p kandelo --target wasm32-unknown-unknown --release  # → clean (47 pre-existing warnings, 0 errors)
bash scripts/check-abi-version.sh  # → exits 1 with pre-existing PR #629 drift only; additive evdev exports recognised
```

CLAUDE.md suites 2–4 (vitest / musl libc-test / Open POSIX) NOT re-run this session — the cleanup is kernel-only and below the syscall ABI; nothing in those suites could shift. Run all five suites before opening the PR (after C is done).

## Cold-start dance (preserve for restart-after-clean — unchanged from handoff-27)

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

Git status at session-28 close (besides committed files):

```
 m libc/musl                              (cp -R workaround; submodule shows dirty)
?? docs/plans/2026-06-11-dri-kandelo-port-handoff-24.md   (carried untracked since session 24)
?? node_modules                          (cold-start symlink)
?? open-posix-testsuite                  (cold-start symlink)
```

Plan-doc handoffs (21 → 28) stay untracked in the 9vbaz worktree. **Stage exactly the code files per commit; never `git add -A`.**

## Standing instruction for session 29

**Print this sentence in the next session's first turn:**

> *"Read `docs/plans/2026-06-11-dri-kandelo-port-handoff-28.md` first (in the 9vbaz worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Plan-5 / evdev A1–A7 + the session-28 devil's-advocate cleanup are committed at `b4c3464ac` / `fa47afa22` / `d8539d252` / `fd1b502d0` / `479fe65c2` / `26393f20d` / `e583f979f` / `6a71f593f` on branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001` off Q4 base `001729c67`; no PR opened. **Strategy: ONE PR, ~14 commits total** — 8 landed, ~6 to go; do NOT split into the plan's 3-PR shape. **Phase A is complete and audited; B1 is next: `InputSource` module + interface.** Plan body at lines 1646–1680 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree). **Phase B touches host code — dual-host parity (Node + Browser, same commit) is load-bearing per CLAUDE.md.** Symmetry-check first; PR #388 / #410 were both one-sided host fixes that broke production demos. Default to single-commit full tasks unless task obviously > 1 commit. **Wait for user input before each commit.** Do NOT open the Q4 PR. Do NOT touch modeset.c's 60 Hz throttle. Do NOT redo the dye-fade experiment. Do NOT re-prune the `KEY_*` constant table, `WpkInputEvent._pad`, the `grabbed` field, or the single `InputEvent { device: u8 }` variant — see handoff-28 §"What deliberately stayed in Phase A". `crate::input::wait` no longer exists; B4 picks the wake mechanism when actually wiring. `bash scripts/check-abi-version.sh` will fail on pre-existing PR #629 drift — that's branch-wide, not a regression. If the worktree was wiped, re-run the cold-start dance in handoff-28 §"Cold-start dance" (sources from the Q4 worktree, NOT 9vbaz)."*
