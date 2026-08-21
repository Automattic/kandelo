# DRI port onto kandelo:main — session 29 handoff (Phase B1–B4 landed; B5 next)

Continuation of [handoff-28](./2026-06-11-dri-kandelo-port-handoff-28.md). Session 29 landed B1, B2, B3, B4 — every Phase B commit except the end-to-end vitest gate (B5). **B5 is still next.**

## TL;DR — read this twice

1. **Worktree is `explore-dri-evdev-plan`** at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan/`, branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`. Branched off `explore-dri-q4-vblank-gating` at `001729c67`.

2. **Twelve commits landed on top of Q4:**
   - `b4c3464ac` — A1 shared ABI (session 24)
   - `fa47afa22` — A2 OFD plumbing (session 24)
   - `d8539d252` — A3 EVIOCG* ioctl dispatch (session 25)
   - `fd1b502d0` — A4 `kernel_input_event` + fan-out (session 25)
   - `479fe65c2` — A5 `sys_read` drain + `sys_poll` POLLIN (session 26)
   - `26393f20d` — A6 close + fork/exec serialise (session 27)
   - `e583f979f` — A7 ABI snapshot regen (session 27)
   - `6a71f593f` — Phase A devil's-advocate cleanup (session 28)
   - **`4a15d3669` — B1 InputSource interface (this session)**
   - **`cd147db1a` — B2 BrowserInputSource + key-code table (this session)**
   - **`f0e83c9eb` — B3 NodeInputSource null-source (this session)**
   - **`3d56c505f` — B4 wire `kernel_input_event` + dual-host boot path (this session)**

   A1–A6 + B1–B4 are pure-additive at the kernel-wasm export layer. A7 captures A4's two new exports in `abi/snapshot.json`. **No `ABI_VERSION` bump.** No Rust changes this session.

3. **One PR, ~14 commits — 12/~14 in, ~2 to go (B5 + Phase C condensed).** Skip per-phase "open PR" steps. Manual browser verify still required before the PR opens.

4. **No PR opened yet.** User hasn't asked. Don't open it until they do.

5. **B5 is next: vitest end-to-end key + pointer round-trip + ring overflow.** Plan body at lines 1891–1915 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree).

6. **Wait for user input before each commit.** Standing instruction from handoff-24 still applies. The user has repeatedly pushed back on splitting tasks — when in doubt, do the full task in one commit and only split if it genuinely exceeds one commit's worth of scope.

## What landed this session (4 commits)

### B1 — `4a15d3669` — `host(input): InputSource interface`

Two files (+69, -0):
- `host/src/input/input-source.ts` — `InputEvent { device: 0 | 1; ev_type; code; value }` and `InputSource { start(dispatch); stop() }`. Doc-comment encodes the SYN_REPORT framing convention.
- `host/test/input-source.test.ts` — 1 sanity test with a `StubSource` recording dispatched events.

### B2 — `cd147db1a` — `host(input): BrowserInputSource — DOM capture + KEY_*/BTN_*/REL_*/ABS_* translation`

Three files (+565, -0):
- `host/src/input/key-code-table.ts` — 132-entry `KeyboardEvent.code` → `KEY_*` lookup mirroring `shared::input::KEY_*` constant values. Covers letters, digits, punctuation, F1–F24, control/arrow pad, numpad, modifiers, IME/CJK, media/audio, browser hotkeys, Sun-heritage editing keys. Returns `null` for unmapped codes.
- `host/src/input/browser-input-source.ts` — DOM keyboard/pointer/wheel capture; lock-aware coord convention (REL when locked, ABS unlocked); wheel normalisation with small-delta clamp-to-±1; lock-change emits a bare SYN_REPORT re-sync. Listeners tracked in `bindings` array for symmetric removal in `stop()`.
- `host/test/browser-input-source.test.ts` — 17 specs covering every translation path. Uses a `FakeTarget` EventTarget stub + `vi.stubGlobal("document", …)` so no jsdom / happy-dom dep is needed.

### B3 — `f0e83c9eb` — `host(input): NodeInputSource — null-source for headless tests`

Two files (+42, -0):
- `host/src/input/node-input-source.ts` — `start()` and `stop()` both deliberate no-ops. Doc-comment names the dual-host-parity reason.
- `host/test/node-input-source.test.ts` — 2 specs.

### B4 — `3d56c505f` — `host(input): wire kernel_input_event + dual-host boot path`

Nine files (+343, -1):
- `host/src/kernel.ts` — `WasmPosixKernel.injectInputEvent(device, ev_type, code, value)` (calls `kernel_input_event`) and `setInputCanvasDims(w, h)` (calls `kernel_set_input_canvas_dims`). Silent-drop when kernel module not yet instantiated.
- `host/src/kernel-worker.ts` — `CentralizedKernelWorker.injectInputEvent` (delegates + `scheduleWakeBlockedRetries()` so blocked event readers wake) and `setInputCanvasDims`.
- `host/src/browser-kernel-protocol.ts` + `host/src/node-kernel-protocol.ts` — `InputEventInjectMessage` + `SetInputCanvasDimsMessage`, both added to `MainToKernelMessage` union.
- `host/src/browser-kernel-worker-entry.ts` + `host/src/node-kernel-worker-entry.ts` — `case "input_event_inject"` + `case "set_input_canvas_dims"` switch routing.
- `host/src/browser-kernel-host.ts` + `host/src/node-kernel-host.ts` — `injectInputEvent`, `setInputCanvasDims`, and `attachInputSource(source, dims)` — the parallel boot helper. Both host classes import `InputSource` from B1.
- `host/test/input-attach-source.test.ts` — 3 specs covering Node-side `attachInputSource` wiring + standalone `setInputCanvasDims` / `injectInputEvent`. Bypasses `init()` (which spawns a real worker_thread) by monkey-patching `sendToWorker` after `new NodeKernelHost()` (the constructor only stores options).

## Architectural decisions this session

### Wake mechanism — B4 chose "extend pendingPipeReaders"

Handoff-28 marked the wake routing open in B4. B4 resolved it by calling `this.scheduleWakeBlockedRetries()` inside `CentralizedKernelWorker.injectInputEvent` — the same wake path `/dev/input/mice` uses for blocked readers (kernel-worker.ts:7235 for mice, kernel-worker.ts:7253 for evdev). This reuses the existing pending-readers tick rather than carving a separate wake-idx space. **If B5's end-to-end test surfaces a wake bug, revisit this choice — the alternative (separate wake-idx space) is still on the table.**

### Plan-body B4 path was stale

Plan body §B4 said to edit `examples/browser/lib/browser-kernel.ts` — that file does NOT exist. The canonical browser boot path is `host/src/browser-kernel-host.ts` (per CLAUDE.md's parallel-implementations table). B4 wired into `host/src/{browser,node}-kernel-host.ts` and added a public `attachInputSource(source, dims)` API on each. App layers (apps/browser-demos) call this; the host class doesn't auto-instantiate a `BrowserInputSource` at boot — apps own that, because canvas / window context comes from the app.

### Dual-host parity surface (CLAUDE.md hard requirement)

Every new symbol shows parallel structure in both trees. Symmetry-grep at the end of session 29:

| Symbol | Browser | Node |
|---|---|---|
| Protocol type `input_event_inject` | `browser-kernel-protocol.ts:229` | `node-kernel-protocol.ts:191` |
| Protocol type `set_input_canvas_dims` | `browser-kernel-protocol.ts:244` | `node-kernel-protocol.ts:204` |
| Switch case `input_event_inject` | `browser-kernel-worker-entry.ts:1658` | `node-kernel-worker-entry.ts:1306` |
| Switch case `set_input_canvas_dims` | `browser-kernel-worker-entry.ts:1661` | `node-kernel-worker-entry.ts:1309` |
| `injectInputEvent` method | `browser-kernel-host.ts:825` | `node-kernel-host.ts:294` |
| `setInputCanvasDims` method | `browser-kernel-host.ts:846` | `node-kernel-host.ts:314` |
| `attachInputSource` method | `browser-kernel-host.ts:861` | `node-kernel-host.ts:329` |
| Shared `WasmPosixKernel` exports | `kernel.ts:286` + `:306` | (same file) |
| Shared `CentralizedKernelWorker` | `kernel-worker.ts:7247` + `:7262` | (same file) |

## What deliberately stays NOT done

Carrying from handoff-28, with session-29 deltas marked:

- **Q4 PR not opened.** User declined.
- **Modeset dye-fade experiment.** Don't redo.
- **`modeset.c`'s 60 Hz throttle.** Keep (standing instruction since v20).
- **`MockHostIO` not promoted to `pub(crate)`.** Phase B host tests use whatever pattern existing host tests use.
- **`build-libdrm-stub.sh` Q4 follow-up.** Not blocking plan 5.
- **Q4 follow-up: kernel-level `sys_read(card0)` blocking semantics.** Deferred to v3.
- **PR #629 upstream snapshot drift.** Pre-existing; A7 documents it.
- **NEW: Wake mechanism choice locked.** B4 picked "extend pendingPipeReaders" via `scheduleWakeBlockedRetries`. Revisit only if B5 surfaces a wake bug.
- **NEW: `BrowserInputSource` is NOT auto-instantiated by `BrowserKernel`.** Apps own the `new BrowserInputSource(window, canvas)` and pass it to `attachInputSource`. Reason: the host class doesn't have a canvas until the app gives it one — same pattern as the existing `BrowserMouseSource` / `attachKmsCanvas`.

## Phase A + B roadmap — current state

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
| 9 | **B1 — InputSource interface** | **`4a15d3669`** | **session 29** |
| 10 | **B2 — BrowserInputSource + key table** | **`cd147db1a`** | **session 29** |
| 11 | **B3 — NodeInputSource null-source** | **`f0e83c9eb`** | **session 29** |
| 12 | **B4 — wire kernel_input_event + parity** | **`3d56c505f`** | **session 29** |

## Phase B roadmap — what's left

| # | Task | Plan body lines | Files |
|---|---|---|---|
| 13 | **B5** — Vitest end-to-end key + pointer + ring overflow | 1891–1915 | `host/test/input-evdev.spec.ts` (new) |

Then Phase C (sysroot + demo, 3 commits C1–C3 at lines 1931–2070). C4 (manual browser verify at lines 2071–2086) required before PR, adds no commit. **B6 / C5 are skipped** under the single-PR strategy.

## Tactical pointers for B5

### Read these in order before touching code

1. **Plan body B5**: `docs/plans/2026-06-15-dri-evdev-plan.md` lines 1891–1915 (in the 9vbaz worktree).
2. **The B4 wiring landed in `3d56c505f`** — the public surface is `host.attachInputSource(source, dims)` / `host.injectInputEvent(device, ev_type, code, value)` / `host.setInputCanvasDims(w, h)` on `NodeKernelHost`. B5 drives the kernel through `injectInputEvent` directly (per plan body: "fake DOM events synthesised directly into `kernel_input_event`").
3. **Existing end-to-end host tests for reference:**
   - `host/test/centralized-spawn.test.ts` — how to construct + init a `NodeKernelHost`, spawn a fixture program, await its exit.
   - `host/test/device-fs.test.ts` — how a fixture process opens a `/dev/*` device and reads from it.
   - `host/test/dri-kms-pageflip.test.ts` — closest in shape to B5: drives kernel calls, polls back, asserts.
4. **Fixture program for B5:** Plan body suggests a small C program that opens `/dev/input/event{0,1}`, performs EVIOCGNAME/EVIOCGABS, then reads `WpkInputEvent` records. The repo's pattern is `examples/<name>.c` compiled to `.wasm` by `global-setup.ts`. If B5 needs a new fixture, add it under `examples/` and add the source name to `TEST_PROGRAMS` in `host/test/global-setup.ts`. **OR** drive everything from the JS test side without a C fixture by opening fds via host APIs — TBD what's tractable.
5. **`WpkInputEvent` layout** is 24 bytes total: `tv_sec: i64@0`, `tv_usec: i32@8`, `_pad: i32@12`, `ev_type: u16@16`, `code: u16@18`, `value: i32@20`. The pad is load-bearing (see `crates/shared/src/lib.rs:2699-2710` for the why). The C reader expects `ev_type` at offset 16. Test parsing must respect this.
6. **Ring overflow semantics** (per architecturally-load-bearing decisions): per-OFD ring is 1024 records (24 KiB). Overflow latches `dropped`; the **incoming** record is discarded (Linux semantics). On the next `sys_read` after a drop, the first record returned is a synthesised `SYN_DROPPED`, then the next 1023 ring records (the most recent surviving ones).

### Worktree cold-start gotchas — additions to handoff-28's dance

If the worktree was wiped, handoff-28's cold-start dance is **incomplete** for running vitest. Session 29 had to add:

```bash
# host/node_modules — vitest itself lives here, not in the worktree-root
# node_modules. Without this symlink, npx vitest can't find vitest/config.
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/host/node_modules host/node_modules

# Pre-built test wasm artifacts — global-setup.ts tries to compile 8
# fixture C programs with wasm32posix-cc, which isn't on PATH unless
# the SDK is built locally. Copy the prebuilt artifacts from 9vbaz so
# the mtime-skip path in global-setup.ts engages.
for f in putenv_test getaddrinfo_test sysv_ipc_test wasm_trap_test \
         abort_test mount_probe_test getpwent_smoke thread-exit-group; do
  cp /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/examples/$f.wasm \
     examples/
done
touch examples/*.wasm   # ensure mtime > .c source so skip-rebuild engages
```

**Note:** `scripts/dev-shell.sh` is a no-go here — `nix` isn't installed on this machine; running it explodes with `nix: command not found`. Cargo / rustc work fine on PATH; only the wasm32 toolchain is unavailable, which is why we copy the prebuilt artifacts.

### Dual-host parity reminder (CLAUDE.md hard requirement)

B5 is a **Node-side** vitest. Per CLAUDE.md, this does NOT protect the browser path. The plan defers browser-side end-to-end to Phase C (Playwright). That's fine **only because** the BrowserInputSource translation logic is already fully covered by B2's 17 vitest specs (which run under Node but exercise the pure translation logic via `vi.stubGlobal`). The kernel side is the same wasm binary in both hosts. So a B5 Node vitest pass plus B2 pure-logic coverage is sufficient evidence the browser path will work — but Phase C's Playwright run is still required before opening the PR.

## Architecturally load-bearing decisions (don't relitigate during B5)

Carrying from handoff-28, with this session's deltas marked:

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
- **`OpenFileDesc::on_final_close` does NOT exist** — close-time cleanup is procedural in `sys_close`.
- **Fork wire format for `input_state`:** `INPUT_TAG_NONE`/`INPUT_TAG_SOME` byte + device + grabbed + dropped + ring_len + ring bytes. Reader still bounds-checks against `INPUT_RING_MAX_BYTES` and rejects non-record-aligned lengths.
- **A7 ABI surface delta is the 2 exports only.** `WpkInputEvent` / EV_* / KEY_* / EVIOC* constants are in `shared::input`, not tracked by `abi/snapshot.json`.
- **`ABI_VERSION` stays at 14.** PR #629 drift is pre-existing and documented.
- **Single-PR strategy.** All commits land together on `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001`.
- **User pushed back on A6a/A6b split.** Default to single-commit full tasks unless the task obviously exceeds one commit's worth.
- **`crate::input::wait` module does not exist.** Removed in session 28. B4 picked the wake mechanism instead.
- **`VirtualDevice::InputEvent` host_handle encoding is `-10 - device as i64`.** Round-trip is still gated on `device ∈ {0,1}` by `from_host_handle` accepting only -10 and -11.
- **NEW (session 29): wake mechanism is `scheduleWakeBlockedRetries`** — same path mice uses. If B5 surfaces a wake bug, revisit; otherwise this stays.
- **NEW (session 29): the host-side public input API is `injectInputEvent(device, ev_type, code, value)` + `setInputCanvasDims(w, h)` + `attachInputSource(source, dims)` on BOTH `BrowserKernel` and `NodeKernelHost`.** Worker protocol message types are `input_event_inject` and `set_input_canvas_dims`. Both protocol files (`browser-kernel-protocol.ts`, `node-kernel-protocol.ts`) carry both messages in their `MainToKernelMessage` union. Both worker entries (`browser-kernel-worker-entry.ts`, `node-kernel-worker-entry.ts`) have the matching `case` arms.
- **NEW (session 29): App owns `BrowserInputSource` instantiation, NOT `BrowserKernel`.** Apps call `browserKernel.attachInputSource(new BrowserInputSource(window, canvas), {width, height})` themselves — the host can't auto-instantiate because it doesn't have the canvas / window context.

## Verification snapshot (at session 29 close)

```bash
# All four input vitests pass.
cd host && npx vitest run \
  test/input-source.test.ts \
  test/browser-input-source.test.ts \
  test/node-input-source.test.ts \
  test/input-attach-source.test.ts
# → 4/4 files, 23/23 tests pass

# tsc on edited input + host files — no NEW errors.
cd host && npx tsc --noEmit 2>&1 | grep -E "src/input/|test/.*input"
# → empty (zero new errors)

# Pre-existing errors in browser-kernel-host.ts (Vite ?url imports +
# import.meta.env) and openssl TLS code are unchanged from
# session-28 baseline.
```

**CLAUDE.md suites 1, 3, 4, 5 (cargo, libc-test, posix, abi-check) NOT re-run this session** — no Rust changes; B1–B4 are pure host TS additions. Run all five suites before opening the PR (after C is done).

## Cold-start dance (revised — preserve for restart-after-clean)

Session 29 found handoff-28's dance was incomplete. Updated full sequence:

```bash
cd /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-evdev-plan

# Real copies — these trees are mutated by builds. Source from the Q4
# worktree, NOT 9vbaz — Q4's sysroot has the post-Q4 libdrm.a rebuild.
cp -R /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-q4-vblank-gating/sysroot   sysroot
rm -rf libc/musl
cp -R /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/explore-dri-q4-vblank-gating/libc/musl libc/musl

# Top-level symlinks — read-only sources from 9vbaz.
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/node_modules         node_modules
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/open-posix-testsuite open-posix-testsuite

# NEW (session 29): host package's own node_modules — vitest lives here.
ln -s /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/host/node_modules host/node_modules

# NEW (session 29): prebuilt test wasm so global-setup.ts doesn't try
# to invoke wasm32posix-cc (not on PATH; nix isn't installed).
for f in putenv_test getaddrinfo_test sysv_ipc_test wasm_trap_test \
         abort_test mount_probe_test getpwent_smoke thread-exit-group; do
  cp /Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/examples/$f.wasm \
     examples/
done
touch examples/*.wasm
```

Git status at session-29 close (besides committed files):

```
 m libc/musl                              (cp -R workaround; submodule shows dirty)
?? docs/plans/2026-06-11-dri-kandelo-port-handoff-24.md   (carried untracked since session 24)
?? node_modules                          (cold-start symlink)
?? host/node_modules                     (cold-start symlink — session 29)
?? examples/*.wasm                       (cold-start prebuilt — session 29; 8 files)
?? open-posix-testsuite                  (cold-start symlink)
```

Plan-doc handoffs (21 → 29) stay untracked in the 9vbaz worktree. **Stage exactly the code files per commit; never `git add -A`.**

## Standing instruction for session 30

**Print this sentence in the next session's first turn:**

> *"Read `docs/plans/2026-06-11-dri-kandelo-port-handoff-29.md` first (in the 9vbaz worktree at `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz/`). Plan-5 / evdev A1–A7 + session-28 cleanup + B1–B4 are committed at `b4c3464ac` / `fa47afa22` / `d8539d252` / `fd1b502d0` / `479fe65c2` / `26393f20d` / `e583f979f` / `6a71f593f` / `4a15d3669` / `cd147db1a` / `f0e83c9eb` / `3d56c505f` on branch `emdash/explore-direct-rendering-infrastructure-evdev-plan-23001` off Q4 base `001729c67`; no PR opened. **Strategy: ONE PR, ~14 commits total** — 12 landed, 2 to go (B5 + Phase C condensed); do NOT split into the plan's 3-PR shape. **B5 is next: vitest end-to-end key + pointer + ring overflow.** Plan body at lines 1891–1915 of `docs/plans/2026-06-15-dri-evdev-plan.md` (untracked, in the 9vbaz worktree). **Drive the kernel via `host.injectInputEvent(device, ev_type, code, value)`** — that's the B4-landed public API; see handoff-29 §"Tactical pointers for B5" for the existing-test patterns to copy. **Wake mechanism is locked: `scheduleWakeBlockedRetries`** (session 29 chose "extend pendingPipeReaders"); revisit only if B5 surfaces a wake bug. **WpkInputEvent layout: 24 bytes with `_pad: i32` at offset 12 — load-bearing**, C reader expects `ev_type` at offset 16. Default to single-commit full tasks unless the task obviously > 1 commit. **Wait for user input before each commit.** Do NOT open the Q4 PR. Do NOT touch modeset.c's 60 Hz throttle. Do NOT redo the dye-fade experiment. Do NOT re-prune the `KEY_*` constant table, `WpkInputEvent._pad`, the `grabbed` field, or the single `InputEvent { device: u8 }` variant — see handoff-28 §"What deliberately stayed in Phase A". `bash scripts/check-abi-version.sh` will fail on pre-existing PR #629 drift — that's branch-wide, not a regression. If the worktree was wiped, re-run the **revised** cold-start dance in handoff-29 §"Cold-start dance" (NOT handoff-28's — that one's missing `host/node_modules` symlink + 8 prebuilt `examples/*.wasm`). `scripts/dev-shell.sh` doesn't work on this machine — nix isn't installed; use direct `npx vitest` + the prebuilt wasm path."*
