# DRI v2 — evdev plan (`/dev/input/event{0,1}`)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Add the two evdev device nodes the SDL2 + libinput stacks
look for first — `/dev/input/event0` (keyboard) and `/dev/input/event1`
(pointer / mouse) — exposing Linux's evdev UAPI: a `read(fd)`-able
stream of `struct input_event` records, the `EVIOCG*` introspection
ioctls (`EVIOCGNAME`, `EVIOCGID`, `EVIOCGBIT`, `EVIOCGABS`, `EVIOCGRAB`),
and `poll(POLLIN)` readiness. Records are produced from the host's
browser-side DOM event capture (`KeyboardEvent`, `PointerEvent`) — the
kernel never invents events; it only multicasts them onto every open
event-fd's per-OFD ring. The plan ships the **device + ring + record
producer** only; focus routing ("only the focused client sees the
keystroke") is deferred to plan 9 (wpkcompositor), which will gate
event delivery via `EVIOCGRAB` on a master-equivalent ownership model.
Plan 5 v1: every open event-fd gets every event.

**Architecture:** Two virtual devices, sourcing records from a single
host-side `InputSource` per input class (one keyboard, one pointer).
`/dev/input/event0` exposes keyboard `EV_KEY` + `EV_SYN`; `event1`
exposes pointer `EV_REL` (deltas) + `EV_KEY` (button) + `EV_ABS`
(absolute position for the pointer-lock-disabled case) + `EV_SYN`.
Per-OFD `InputFdState` carries a `VecDeque<u8>` event ring + a
`grabbed: bool` flag. A new kernel export `kernel_input_event(device,
ev_type, code, value)` is the single entrypoint — the host calls it
once per DOM event after translating browser-key-codes to evdev `KEY_*`
and pointer fields to `REL_X` / `REL_Y` / `BTN_LEFT` / etc. The kernel
walks every OFD opened on the matching `/dev/input/event*` node,
appends the 24-byte record, follows it with an `EV_SYN` (`SYN_REPORT`)
record at end-of-logical-event, and wakes any blocked-on-read OFD.
Companion design doc: `docs/plans/2026-05-18-dri-design.md` §7 (evdev)
+ §16 q6 (`CLOCK_MONOTONIC` timestamps).

**Tech Stack:** Rust kernel (wasm64), TypeScript host (browser
DOM event capture; Node = null-source), C user programs cross-compiled
with `wasm32posix-cc`. Sysroot side reuses musl's `<linux/input.h>` +
`<linux/input-event-codes.h>` headers; no library stub (libevdev is
not pulled in — apps that want it port their own; SDL2's evdev backend
talks to the device nodes directly via syscalls + ioctls).

**Critical wasm32 ABI detail — `struct input_event` is 24 bytes, not
16.** musl on wasm32 ships `time_t = int64_t` (Y2K38-safe; the same
choice every modern Linux distro made for 32-bit userland). That makes
`struct timeval` 12 bytes natural but 16 bytes with internal alignment
padding (`int64_t tv_sec` forces 8-byte alignment of the struct;
trailing `int32_t tv_usec` is padded out by 4 bytes). Adding
`__u16 type + __u16 code + __s32 value` (8 bytes, naturally 4-byte
aligned, fits into the 8 bytes after the 16-byte timeval) yields a
**24-byte record**. Linux's 32-bit-with-32-bit-time_t userland used
16 bytes; Linux's 64-bit userland uses 24 bytes. We match the
64-bit-userland layout exactly, which is also what musl wasm32 chose.
This is **load-bearing**: the kernel writes 24-byte records, the
sysroot reads 24-byte records, and the static-assert in Task A1 Step 2
catches drift.

**Clock source: `CLOCK_MONOTONIC`** (design §16 q6). evdev's default
on real Linux is also `CLOCK_MONOTONIC` (the kernel-side default
since v3.4; userland can opt into `CLOCK_REALTIME` via
`EVIOCSCLOCKID`, but we don't expose `EVIOCSCLOCKID` — clock is
fixed). Same monotonic helper plan 4 A7's `kernel_vblank` uses
(`crate::time::monotonic_us()`) — keeps evdev timestamps comparable
with vblank event timestamps for jitter/latency profiling.

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §7
(`/dev/input/event*`, seat punt) + §16 q6 (clock source). POSIX vs
Linux UAPI: `open` / `close` / `read` / `poll` / `ioctl` are POSIX;
`struct input_event` layout + `EV_*` / `KEY_*` / `BTN_*` / `REL_*` /
`ABS_*` / `SYN_*` codes + `EVIOCG*` ioctl numbers are Linux UAPI,
followed strictly (modulo the wasm32-vs-32-bit-Linux 24-vs-16-byte
record size — we match the 64-bit-userland shape).

**Consistency with plans 2 + 3 + 4:**
- Plan 4 introduced `VirtualDevice::DriCard0` + `OpenFileKind::DriCard`
  alongside plan 2's `DriRender0` / `DriRender`. Plan 5 adds
  `VirtualDevice::InputEvent { device: u8 /* 0 = kbd, 1 = ptr */ }`
  + `OpenFileKind::InputEvent { device: u8 }`. Single
  enum-variant-with-payload keeps `match_virtual_device` clean.
- Plan 4 lifted card0's per-fd state into the consolidated
  `Option<Box<DriOfdState>>` enum (`PrimeBo` / `RenderNode` / `Card`).
  Plan 5 does **not** join that enum — input event-fds have no
  relation to DRI bo state; introducing `InputEvent { input:
  InputFdState }` as a fourth variant would conflate two
  load-bearing-but-disjoint state machines. Plan 5 adds a separate
  `input: Option<Box<InputFdState>>` field to `OpenFileDesc`,
  parallel to `dri_state` (not nested under it).
- Plan 4 A7's `kernel_vblank` taught the kernel about host-driven
  ticks. Plan 5 A4's `kernel_input_event` is the same shape: an
  additive kernel export, host calls it on browser events, kernel
  fans out records to per-OFD rings and wakes blocked readers. No
  `ASYNCIFY_SAVE_SLOTS` change. Plan 5 reuses plan 4's wait-queue
  pattern (`crate::input::wait::{block_event_reader, wake_event_reader}`)
  — same primitive, separate queue (no false wakeups between
  vblank and input).
- Plan 4 noted that `CLOCK_MONOTONIC` (`monotonic_us()`) is the
  single time source for host-driven events. Plan 5 follows: every
  `struct input_event.time` is filled from
  `crate::time::monotonic_us()` at record-push time.

**Stack base:** Plan 4's `…-kms-demo` branch tip. Plan 5 extends the
kernel + host without touching plans 2–4's surfaces; the dispatcher
adds an `InputEvent` arm to `VirtualDevice`, the syscall layer adds
an `input::*` module, and the host gains an `input/` subdirectory
mirror of `dri/`. No regressions to plans 2–4 tests.

**Branch:** `emdash/explore-direct-rendering-infrastructure-evdev-plan-XXXXX`
(chains off plan 4 per the branching rule). Three sub-branches stack
off it.

**Final PR base:** Plan 4's `…-kms-demo` tip. Do not merge until
Brandon validates the design, plan 4 lands, and Phase C's manual
browser verification passes (CLAUDE.md item 6).

**Three PRs, coordinated merge.** Each task below is one commit.
Brandon's `scope(area): action` titles:

1. `kernel(input): /dev/input/event{0,1} + EVIOCG* + input_event ring`
2. `host(input): InputSource (browser DOM capture, Node null-source) + plumbing`
3. `examples(input): evdev_demo + browser spec`

PR base/head topology (stacked):

```
explore-webgl-exposition-demo                   (v1 tip)
 └── …-buffer-plan-XXXXX                        (plan 2 PR base)
      └── …-buffer-kernel  (plan 2 PR #1)
           └── …-buffer-host  (plan 2 PR #2)
                └── …-buffer-demo  (plan 2 PR #3)
                     └── …-multiplexer-plan-YYYYY    (plan 3 PR base)
                          └── …-mux-kernel    (plan 3 PR #1)
                               └── …-mux-host    (plan 3 PR #2)
                                    └── …-mux-demo  (plan 3 PR #3)
                                         └── …-kms-plan-ZZZZZ      (plan 4 PR base)
                                              └── …-kms-kernel    (plan 4 PR #1)
                                                   └── …-kms-host    (plan 4 PR #2)
                                                        └── …-kms-demo  (plan 4 PR #3)
                                                             └── …-evdev-plan-WWWWW    (this plan PR base)
                                                                  └── …-evdev-kernel  (PR #1)
                                                                       └── …-evdev-host  (PR #2)
                                                                            └── …-evdev-demo  (PR #3)
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass
with zero regressions before any PR is opened, and re-run before final
merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a
regression. Phase C adds manual `./run.sh browser` verification of the
evdev demo (CLAUDE.md item 6) — typed keystrokes + mouse moves appear
in the demo's on-canvas log.

**ABI impact:** **Additive only — no `ABI_VERSION` bump.** Per
`docs/abi-versioning.md` (PR #490 policy):
- New `repr(C)` struct in `shared::input` for the record:
  `WpkInputEvent` (24 bytes — exact wasm32 layout: `int64_t tv_sec +
  int32_t tv_usec + 4-byte pad + u16 type + u16 code + s32 value`).
  Sized-asserted in Task A1 Step 2.
- New ioctl numbers — verbatim Linux UAPI for the `'E'` magic (we do
  **not** prefix with `WPK_`):
  - `EVIOCGVERSION = _IOR('E', 0x01, int)` → `0x8004_4501`
  - `EVIOCGID = _IOR('E', 0x02, WpkInputId)` → `0x8008_4502`
  - `EVIOCGNAME(len) = _IOC(_IOC_READ, 'E', 0x06, len)` → variable
    (encoding length depends on caller-supplied buffer; we accept
    `len ∈ [1, 256]`, EINVAL otherwise)
  - `EVIOCGBIT(ev_type, len) = _IOC(_IOC_READ, 'E', 0x20 + ev_type,
    len)` → variable
  - `EVIOCGABS(abs_axis) = _IOR('E', 0x40 + abs_axis,
    WpkInputAbsinfo)` → `0x80...4540+axis`
  - `EVIOCGRAB = _IOW('E', 0x90, int)` → `0x4004_4590`
  - Sizes encoded in each constant are verified vs the wasm32 struct
    `size_of` in Task A1 Step 2.
- New kernel-wasm export: `kernel_input_event(device: u32, ev_type:
  u32, code: u32, value: i32)` — host fires this on every DOM event.
  *(Additive export; does not change existing signatures.)*
- **No new `host_input_*` imports.** The kernel doesn't call into the
  host for input — the host is the producer, kernel is the consumer.
  Mirror-image of plan 4's KMS, where host imports outnumber exports.
- No change to v1 `host_gl_*`, plan 2 `host_gbm_*`, plan 3
  `host_gl_bind_foreign_texture`, plan 4 `host_kms_*`, any existing
  struct layout, ioctl number, channel layout, syscall number, or
  asyncify slot.

Existing structs, ioctls, imports, and exports — all unchanged.

---

## Pre-implementation review

Devil's-advocate pass run in the next session after drafting; findings
below are structured Brandon-style. The five inline fixes were folded
back into the plan body in the same session; the open correctness +
open architecture items are load-bearing and must be picked before any
kernel code lands. One cross-plan note leaks back to plan 4 (`event_ring`
overflow protocol) — added to plan 4's review section.

### Inline fixes (5 — folded into the plan body)

- **`_pad: i32` at offset 12 is mandatory, not redundant.** The
  pre-impl placeholder hedged ("`repr(C)` may already insert padding
  making the explicit field redundant") and that hedging was
  backwards. `repr(C)` follows C's natural-alignment rule and does
  NOT insert *interior* padding between `tv_usec: i32` and `ev_type:
  u16` (the u16's 2-byte alignment is satisfied at offset 12).
  Without the explicit `_pad`, the Rust struct is still 24 bytes
  (trailing padding bumps it to the i64's 8-byte alignment), but
  `ev_type` sits at offset 12 — whereas userspace C reads it at
  offset 16 because `struct timeval` on wasm32-musl is 16 bytes
  (`int64_t tv_sec` forces the trailing `int32_t tv_usec` to be
  padded to 16). The size matches; every offset past byte 11
  diverges. Silent corruption on every record. *Fixed: A1 Step 2's
  cargo-test note rewritten to clarify the field-offset asserts are
  the gate; the wording "may be redundant" is gone; `cargo expand`
  is the confirmation tool, not the suggestion to delete the field.*
- **`EVIOCGRAB` from the same fd was returning `EBUSY`.** Linux
  semantics (`drivers/input/evdev.c::evdev_ioctl`): re-grab from the
  fd that already grabbed returns 0 (idempotent); the EBUSY arm only
  fires when a *different* fd holds the grab. v1 doesn't enforce
  cross-fd exclusivity (plan 9 does), so the EBUSY path was dead
  code AND wrong for the same-fd case. *Fixed: A3's EVIOCGRAB arm
  collapses to `i.grabbed = value != 0; Ok(())`. Cargo test
  `evioc_grab_twice_returns_ebusy` renamed to
  `evioc_grab_twice_from_same_fd_is_idempotent`; new test
  `evioc_grab_release_without_prior_grab_is_a_noop`.*
- **Ring-overflow protocol grew the ring unbounded.** A4 as drafted
  said "drop oldest record (24 bytes) + push SYN_DROPPED (24 bytes)
  + push the new event (24 bytes)" — net +24 bytes per overflow.
  Sustained mouse-drag would balloon the ring past INPUT_RING_MAX_BYTES.
  Also: appending SYN_DROPPED at the tail puts it *after* the buffered
  events in stream order, which is the wrong place — Linux's
  `evdev_pass_values` puts SYN_DROPPED at the **head of the next
  read** so the consumer's "I missed events, re-sync" signal arrives
  before any post-overflow data. *Fixed: InputFdState gains a
  `dropped: bool` flag; push_event on a full ring sets the flag and
  discards the incoming record (ring stays bounded); A5's read
  synthesises a SYN_DROPPED at the head of the returned buffer and
  clears the flag. POLLIN-ready iff `!event_ring.is_empty() ||
  input.dropped`. Three cargo tests added:
  `ring_overflow_consumes_dropped_flag_on_next_read`,
  `poll_pollin_ready_on_dropped_flag_alone`, and
  `read_with_buffer_too_small_for_any_record_returns_einval`.*
- **`onWheel` lost continuous-trackpad scrolls.** B2 as drafted did
  `Math.trunc(deltaY / -120)`; on macOS Safari with `deltaMode === 0`
  (PIXEL) and a single trackpad scroll-fling, `deltaY` is often
  ±1..±10, so the truncated quotient is 0 and **no `REL_WHEEL`
  emits**. The risk register entry #5 ("vertical-wheel quantisation")
  acknowledged this but the code didn't honour it. *Fixed: B2's
  onWheel clamps small-but-nonzero deltas to ±1 sign minimum, so
  continuous-scroll fires at least one tick per event. Mode-specific
  scale (LINE → 1, PIXEL → 120) keeps Chromium/Firefox quanta
  intact.*
- **`pointerlockchange` listener was missing.** Risk register entry
  #3 says "emit `EV_SYN { code: SYN_REPORT }` on lock-state change
  to give readers a re-sync point" — but B2 didn't actually subscribe
  to the event. Apps that toggle pointer-lock (FPS-style "press M
  for menu") would see the coord-system flip from REL to ABS
  underneath them with no marker. *Fixed: B2's `start()` adds
  `document.addEventListener('pointerlockchange', ...)` and emits
  `frame(1)` (a bare SYN_REPORT on event1) on every transition.
  Vitest asserts the listener is registered with the right target —
  `document`, not `window`.*

### Correctness — open, address before kernel PR opens

- **`kernel_set_input_canvas_dims` set-once vs set-many** is
  documented as set-once in A4 Step 3, but the fallback "1280x720 if
  not yet set" implies overridable semantics. v1 doesn't need
  resize (design §6.1: "canvas is a fixed size at boot"), so
  set-once via `AtomicU64` CAS-from-zero is the right call.
  Open: pick (a) "first call wins, subsequent calls are silent
  no-ops" — simplest, matches v1 design; (b) "last call wins +
  emit SYN_REPORT on every open pointer-fd OFD" — needed if a future
  plan adds canvas resize, but adds a kernel-side wakeup pathway not
  currently in scope. *Lean: (a)* — pin the semantics at A4 Step 3
  implementation time. If plan 9's compositor introduces canvas
  resize, the change to (b) is additive (no ABI break).
- **Boot-ordering: kernel_set_input_canvas_dims must precede the
  first `kernel_input_event`.** Otherwise EVIOCGABS callers in the
  ~ms window between boot and B4's wiring see the 1280x720 fallback.
  The B4 wiring sketch is correct; what's missing is an explicit
  ordering test. *Resolution:* B4 vitest asserts call order via
  spy-on-mocked exports — `kernel_set_input_canvas_dims` is
  observed before any `kernel_input_event` AND before the host's
  "kernel ready" signal goes high. Added to Missing tests below.
- **EVIOCGABS-on-keyboard returns EINVAL but Linux returns ENOTTY.**
  A3 sketch returns `Err(Errno::EINVAL)` for EVIOCGABS on event0.
  Linux's `drivers/input/evdev.c` returns `-ENOTSUPP` (mapped to
  `-EOPNOTSUPP = -95` for the libc translation, or `-ENOTTY = -25`
  in older paths depending on the ioctl number range). EINVAL is
  reserved for "axis out of range". libinput tolerates either, but
  precision matters: SDL2's evdev probe greps the errno text and
  EOPNOTSUPP-vs-EINVAL changes behaviour. *Lean:* return
  `EOPNOTSUPP` for EVIOCGABS on devices that don't advertise EV_ABS
  in their type bitmap (keyboard); `EINVAL` only for axis-out-of-
  range on a device that does. Folded as a follow-up note at A3 +
  added Missing test.

  *Follow-up after plan 7's devil's-advocate:* SDL2's
  `SDL_EVDEV_AddDevice` (`src/core/linux/SDL_evdev.c`) calls two
  more EVIOC* ioctls that plan 5 doesn't implement:
  `EVIOCGKEY(sizeof(bits))` (current held-keys bitmap) and
  `EVIOCGREP` (keyboard auto-repeat delay+rate). Linux returns
  `-ENOTTY` for unknown EVIOC* on a chardev; plan 5's
  default-arm should do the same (not EINVAL). Extend the same
  resolution above — `EOPNOTSUPP` / `ENOTTY` convention — to
  EVIOCGKEY + EVIOCGREP at A3's default match arm. SDL2 tolerates
  ENOTTY by treating "no keys held" / "default repeat" as the
  initial state; EINVAL would cause a fatal in the SDL2 error
  queue. ~10 LoC; cheap to land alongside the EVIOCGABS fix.
  Missing test added in plan 7's review (B5 smoke asserts
  `SDL_EVDEV_AddDevice` doesn't fatal on event0 registration).

### Architecture — open (load-bearing, pick before any kernel code lands)

- **`PROCESS_TABLE.lock()` at high input-event rates is a deeper
  scaling concern than the same lock at vblank rates.** Plan 4 A7
  takes PROCESS_TABLE briefly at 60 Hz; plan 5 A4 takes it at
  potentially 1000+ Hz (held-down key autorepeat + simultaneous
  mouse drag). The lock window is still O(open OFDs) — typically
  small — but the per-acquisition rate is 17× higher. Plan 4's
  open architecture #2 ("split OFD table out of PROCESS_TABLE")
  becomes meaningfully more pressing once plan 5 lands; ALSA in plan
  6 will add another producer at period-tick rate (~50 Hz, low) but
  multiplies the call-sites. *Lean:* defer the OFD-table-split
  refactor to a focused PR after plans 4+5 ship (no later than
  pre-SDL2-port-merge, since plan 7 will exercise all three host-
  driven event-stream tickers at once); flag pre-merge profiling as
  the trigger in Phase C. Cross-plan note added to plan 4's review.

  *Follow-up after plan 6's devil's-advocate:* plan 6 quantified the
  audio-side contribution as ~375 Hz (per AudioWorklet quantum at
  48 kHz, after plan 6's inline fix #4 collapsed the accumulator
  to per-quantum), not the original ~50 Hz period-rate estimate
  here. Combined worst-case under SDL2 load (plan 7) is now
  ~1500+ Hz across all three streams + WAIT_VBLANK consumers +
  WRITEI from userland. Plan 4's open-architecture #2 timing was
  upgraded in plan 6's cross-plan amendment from "before plan 7
  merge" to "**block plan 7 merge on Phase C profiling — >5% lock
  time in any tick handler triggers the OFD-table-split refactor
  as a plan-7 prerequisite**." This subsection's lean stands but
  the trigger is now numeric, not "no later than"-shaped.
- **`VecDeque<u8>` for the event ring is awkward.** Every record is
  exactly 24 bytes; storing as bytes means push/pop bookkeeping is
  per-byte (24 `push_back` calls per event). A `VecDeque<WpkInputEvent>`
  would push/pop one entry per event. The byte view was inherited
  from plan 4's `event_ring: VecDeque<u8>` (which makes sense there
  because DRM events are variable-sized — see plan 4 A1's
  `peek_next_record_len`). Plan 5's records are fixed-size; the byte
  view costs ~250 ns of overhead per overflowing event under no
  benefit. *Lean:* defer the change — uniformity with plan 4 wins
  for readability at v1 cost (microseconds at 1000 Hz, still negligible).
  Revisit if profiling shows the input fanout is a hotspot. Flag in
  trade-offs.
- **Multi-tab kbd-eavesdropping hazard (v1 fan-out semantics).**
  Plan 5 honours the seat-in-the-compositor punt: every open OFD
  gets every event in v1. A multi-tab browser session with each tab
  running a kernel sees all keystrokes across all tabs (within the
  same kernel instance, anyway — each browser tab is its own kernel
  worker). Single-tab is safe; multi-process inside one kernel is
  not. *Resolution:* documented in trade-offs; plan 9's
  wpkcompositor adds the EVIOCGRAB-based gate that closes the hazard
  before any production-shaped userland sits on top.

### Missing tests — add to implementation PRs

- **CLOCK_MONOTONIC alignment between `kernel_input_event` and
  `kernel_vblank`.** Fire one input event and one vblank tick in
  close succession (sub-millisecond); read both records; assert
  `|tv_input - tv_vblank| < 1 ms`. Locks the design §16 q6 invariant
  that the two host-driven event streams share a comparable clock.
- **Boot-order: `kernel_set_input_canvas_dims` precedes
  `kernel_input_event`.** B4 vitest spies the kernel-exports proxy
  and asserts call ordering. If the host calls kernel_input_event
  before setting dims, the test fails — locks the load-bearing
  contract.
- **EVIOCGABS-on-event0 returns EOPNOTSUPP, not EINVAL.** Linux
  semantics check (see "Correctness — open" above). Failing test
  drives the inline-fix-or-document decision.
- **Fork-shared OFD ring is read-once.** Two processes share a
  forked event0 OFD; push a single event; assert *either* process
  can read it but not both — Linux per-fd semantics, not broadcast.
  Defends against a reviewer "fixing" the ring to broadcast per
  process (which would break the OFD-shared-state invariant).
- **`grabbed` flag on a closed OFD doesn't leak.** A2's `on_final_close`
  for InputFdState test (under A6) asserts that re-opening event0
  after a grab-then-close cycles cleanly: `grabbed = false` on the
  new OFD. Guards against a "global grab" misimplementation.
- **POLLHUP semantics on event-fd close.** A blocked reader on the
  parent's event0 OFD sees POLLHUP after the child closes the last
  ref. v1 may not implement POLLHUP (POSIX permits a no-op return
  on close-while-blocked); if it doesn't, add a test that documents
  the v1 behaviour explicitly so plan 9 knows to add POLLHUP.

### Trade-offs verified against the design doc + handoff requirements

- **`struct input_event = 24 bytes` on wasm32 with explicit `_pad`.**
  Matches musl 64-bit-time_t layout, which matches Linux's 64-bit
  userland. The `_pad: i32` field at offset 12 forces `ev_type` to
  offset 16 to match C's `struct timeval`-as-substruct layout.
  Field-offset asserts in A1 Step 2 lock all five offsets. ✓
- **`CLOCK_MONOTONIC` from `crate::time::monotonic_us()`** — same
  source plan 4 A7 uses for vblank timestamps. Design §16 q6
  invariant honoured; the two host-driven event streams share a
  comparable clock for latency profiling. ✓
- **Additive ABI only — no `ABI_VERSION` bump** (PR #490 policy).
  ✓ Three new structs (`WpkInputEvent`, `WpkInputId`,
  `WpkInputAbsinfo`), the EV_*/KEY_*/BTN_*/REL_*/ABS_*/SYN_*
  constants, the EVIOC* ioctl numbers in the `'E'` magic, and the
  two new kernel exports (`kernel_input_event`,
  `kernel_set_input_canvas_dims`). No existing surface changes; no
  host imports — verified against `docs/abi-versioning.md`.
- **No host imports — pure producer-from-host / consumer-in-kernel.**
  Asymmetric vs plan 4's KMS (where host imports outnumber exports
  because the host needs to be notified of state changes — master,
  addfb, set_fb). Input has no kernel-side state for the host to
  react to; the host's `InputSource` is a self-contained DOM
  listener. Plan 6 (ALSA) will inherit the same asymmetry (with the
  caveat that PCM write-back may add one notify-on-underrun host
  import). ✓
- **`InputFdState` is a separate `Option<Box<…>>` on the OFD; does
  NOT join plan 4's `DriOfdState` enum.** The two state machines
  are disjoint — input has no DRI bo state; DRI has no event ring.
  The shape of plan 4's consolidation enum was "all DRI-related
  state on a card or render-node fd in one box"; plan 5's input
  state is parallel to that, not nested under it. Plan 6 will land
  `Option<Box<AlsaFdState>>` the same way. The right factoring is
  one `Option<Box<…>>` per **device class**, not per OFD. ✓
- **Per-OFD ring + per-OFD `dropped` flag + per-OFD `grabbed` flag.**
  Linux per-fd semantics preserved through fork's OFD-share-by-ref:
  parent + child see the same ring, the same dropped state, the
  same grabbed bit. First-come-first-served on event consumption.
  Match design §7.1. ✓
- **Two devices only (event0 = kbd, event1 = ptr).** Design §7.0;
  joystick / touch deferred to v2+. SDL2's evdev backend tolerates
  any number ≥ 1; two is the minimum useful set for a
  desktop-style userland. ✓
- **Wait-queue split mirrors plan 4 A7/A9.** Per-OFD wake
  (`input::wait::wake_event_reader(idx)`) for the read path; no
  broadcast queue (no "WAIT_INPUT_EVENT" analog of WAIT_VBLANK).
  ✓
- **`ASYNCIFY_SAVE_SLOTS` untouched.** A5's `block_event_reader`
  reuses the existing asyncify suspend/resume primitive (same shape
  pipes/ttys use). ABI-safe. ✓
- **POSIX-first: `open`/`close`/`read`/`poll`/`ioctl` on event-fds
  follow POSIX.** Only the struct layouts + ioctl numbers + EV_*/
  KEY_*/REL_*/ABS_* codes are Linux UAPI — followed verbatim,
  modulo the documented wasm32-24-byte-record deviation from
  32-bit-Linux's 16-byte record. ✓
- **`EVIOCGRAB` v1 records-without-enforces.** The only place plan
  5 knowingly diverges from Linux semantics — and the divergence is
  bounded to "every open fd gets every event", which is exactly
  what plan 9's compositor closes. Hazard documented; no userland
  in v1 exercises the cross-fd-grab case. ✓ (mechanism), ⚠
  (cross-fd EBUSY deferred).

### Deliberately not flagged

- Linux UAPI ioctl numbers (`'E'` magic, nrs `0x01`/`0x02`/`0x06`/
  `0x20+`/`0x40+`/`0x90`) — verified vs `include/uapi/linux/input.h`
  at v6.10 mainline; no collision with plan 2's `'d'` magic, plan 3's
  WPK extensions, or plan 4's KMS ioctl numbers. ✓
- `KEY_*`/`BTN_*`/`REL_*`/`ABS_*`/`SYN_*` codes — verified vs
  `include/uapi/linux/input-event-codes.h`. v1 covers a 130-entry
  subset of KEY_*; the rest are advertised in EVIOCGBIT bitmaps as
  zero. ✓
- `BUS_VIRTUAL = 0x06` for `EVIOCGID.bustype` — matches Linux's
  uinput driver convention for kernel-synthesised devices. ✓
- Major 13 (Linux `INPUT_MAJOR`) + minors 64/65 (Linux evdev range
  64..95) — matches `Documentation/admin-guide/devices.txt`. ✓
- No `/dev/input/mice` legacy node — PS/2 emulation; SDL2 + libinput
  prefer the modern evdev path. Skipping saves ~100 LoC of
  compat shim. ✓
- No write-side ioctls (EVIOCSREP / EVIOCSCLOCKID / EVIOCSKEYCODE)
  — keyboard repeat is the browser's job; clock is fixed
  MONOTONIC; keymap is libxkbcommon's job at plan 8. SDL2 +
  libinput gracefully degrade on EOPNOTSUPP. ✓
- 130-entry KEY_* lookup table in `key-code-table.ts` — derived
  from `KeyboardEvent.code` → `KEY_*`, doesn't translate shifted
  / AltGr-composed keys (locale-layer; userspace stacks handle it).
  ✓
- Stacked-PR topology (evdev-kernel → evdev-host → evdev-demo) —
  matches plans 2/3/4's stack shape and the user's branch-chaining
  rule. ✓
- DOM listener target = `window` (not canvas) — captures keystrokes
  even when the canvas doesn't have focus, which matches the
  "compositor owns the seat" design. Risk register #2 (macOS Cmd-key
  keyup loss) is the only edge case. ✓

### Cross-plan amendment to plan 4

A finding from this devil's-advocate pass leaks back to plan 4. Plan
4's `event_ring: VecDeque<u8>` (for FLIP_COMPLETE records) has no
overflow protocol — if userspace opens card0 and never `read`s, the
ring grows unbounded at 1 record (32 bytes) per vblank tick of a
queued flip. The risk is lower than plan 5's (1 Hz typical, vs
1000+ Hz under autorepeat + drag), but the unbounded shape is a
correctness gap. *Resolution:* bound plan 4's `event_ring` at 64
records (2 KiB; ~1 s of unread 60 Hz vblanks); on overflow drop the
*oldest* record silently. Linux's drm UAPI has no "DRM_EVENT_DROPPED"
analog of SYN_DROPPED, so the dropped-flag pattern doesn't translate;
a silent drop matches what real Linux does when the userspace event
ring overflows. Added as a follow-up note in plan 4's review.

### Cross-plan amendment from plan 8's devil's-advocate

Plan 8's devil's-advocate pass (session 9) caught that this plan's
`BrowserInputSource.onPointerMove` (Task B1, line 1655+) emits
**EV_ABS** (ABS_X + ABS_Y) by default — for the unlocked-pointer
case — and emits EV_REL only when `document.pointerLockElement` is
set (the locked / FPS-style case). Plan 8's hand-rolled
`wpk_widget_pump_events` (B1) initially handled `EV_REL`
exclusively, missing the default browser case entirely; without
pointer-lock the cursor position never updates inside wpkdraw
processes, and button-click dispatch silently fails.

The trade-off note "pointer device exposes EV_REL + EV_KEY +
EV_ABS" in the introduction (line 22-23) understates which arm is
the default: **EV_ABS is the default-state code; EV_REL is the
pointer-locked code**. Re-reading the producer logic confirms the
intent (locked → movementX/Y deltas → REL; unlocked → offsetX/Y
absolute → ABS) — the design is correct, but the documentation
phrased the two paths as symmetric peers when in practice the
ABS branch is hit ~99% of the time.

*Resolution for this plan:* clarify in the introduction (around
line 22-23): "EV_ABS (default, unlocked pointer with absolute
coordinates) + EV_REL (only when `document.pointerLockElement` is
set, e.g., FPS-style apps that requestPointerLock)." Folds into
plan 5 body at impl time, no code change — the producer already
gets it right. Plus a note in "Trade-offs verified": "Pointer
emits EV_ABS by default; consumers expecting cursor-on-default-
browser MUST handle the absolute arm. SDL2's libinput shim
internally translates both (so plan 7's SDL2 demo is unaffected);
hand-rolled evdev consumers (plan 8 wpkdraw, plan 11 wpk-shell)
need an explicit EV_ABS arm in their pump loops. Documented as a
cross-plan amendment from plan 8's review."

Also of note (for future-me reading plan 5 in isolation): the
SDL2-vs-handrolled split means plan 7's evdev consumer is
*shielded* from the EV_ABS/EV_REL choice by libinput's
translation layer, but plans 8/10/11 are not. Plan 9's
wpkcompositor will absorb the translation as part of its
libinput-real port, putting all post-v1 consumers on the
shielded path. v1 plan 8 just needs the explicit EV_ABS arm.

### Cross-plan amendment from plan 9's devil's-advocate — EVIOCGRAB enforcement (LOAD-BEARING)

Plan 9's devil's-advocate pass (session 10) escalated this plan's
EVIOCGRAB-without-enforcement compromise (this plan's A3
arm + the documented punt at lines 224-230 + the multi-process
hazard at lines 361-369: "every open OFD gets every event in
v1 … plan 9's wpkcompositor adds the EVIOCGRAB-based gate that
closes the hazard") into a **LOAD-BEARING cross-plan obligation**.
Without cross-OFD enforcement, plan 9's compositor can't actually
exclude a co-running wpkdraw-direct process from receiving every
keystroke — both will read identical event streams from a shared
`/dev/input/event0` ring, producing double-delivery of every
keypress + pointer motion. libinput by default does NOT call
`EVIOCGRAB`; plan 9 inline fix #4 adds the ioctl call in
`compositor_open_restricted`, but the kernel-side enforcement
(skip event delivery to non-grabbing OFDs when any other OFD on
the same device holds `grabbed = 1`) is what closes the hazard.

*Resolution (plan-5 follow-up landed BEFORE plan 9 Phase A opens —
or as part of plan 9 Phase A's first commit):* extend this plan's
`sys_read` arm on `/dev/input/event*` with a cross-OFD check.
~20 LoC of Rust:

```rust
// In sys_read for InputDevice:
if let Some(grab_holder) = device.grab_holder() {
    if grab_holder != current_ofd_idx {
        // Another OFD holds the grab. Skip event delivery to us.
        return Ok(0);  // or EAGAIN if O_NONBLOCK
    }
}
```

The change is a plan-5-amendment, landed either as a follow-up PR
before plan 9 opens or absorbed into plan 9's Phase A first commit
(scope-wise, ~half a day of work). The dead-code `EBUSY` arm in
this plan's A3 ioctl handler (mentioned in this plan's own review
lines 224-230) is the natural anchor for the cross-OFD check —
the grab-holder slot exists in `InputFdState`; the read arm just
needs to consult it.

Without this enforcement, plan 9 carries a documented hazard ("if
you run wpkdraw-direct concurrently with the compositor, both
receive every keystroke; v2 ships enforcement"). With it, plan 5's
seat-shared model becomes the v1-correct single-libinput-consumer
substrate plan 9 was designed against. **Lean: ship the
enforcement as part of plan 9 Phase A.** Note added to this plan's
"Trade-offs verified" subsection at impl time.

### Cross-plan amendment from plan 10's devil's-advocate — enumerate `/dev/input/event*` in devfs readdir

Plan 10's devil's-advocate pass (session 11) called out that
`devfs.rs` currently registers `event0`/`event1` as virtual
devices openable by path but explicitly does NOT enumerate them
via `readdir(2)` (see comment at `crates/kernel/src/devfs.rs:180`:
"No /dev/input/eventN evdev nodes yet (mousedev surface only)").
Plan 10's wpkshell built-in `ls /dev/input` would therefore show
only `mice` despite plan 9's compositor opening `event0`/`event1`
via path. Not LOAD-BEARING for plan 10 — the demo's `ls /` use
case doesn't depend on it — but a UX paper-cut worth closing.

*Resolution (plan 5 follow-up, low priority — landed alongside
plan 5's main PR sequence OR as a standalone PR before plan 10
opens):* extend `devfs.rs:180` to enumerate `event0`/`event1`
(and the future `event2..N`) under the `/dev/input` `readdir`
arm. ~10 LoC mirroring the existing `mice` entry. Update the
`mice_is_listed_in_dev_input_dir` test (line ~306) to assert
`event0` is also present.

Note added to this plan's "Missing tests" subsection at impl
time: assert `readdir("/dev/input")` returns `mice` AND
`event0` AND (when plan 5 grows to multi-keyboard) `event1`.

---

## Phase A — kernel: device + ring + ioctls + producer export (PR #1)

The kernel learns to (a) recognise `/dev/input/event0` and `/dev/input/event1`
as two distinct virtual devices, (b) hold per-OFD ring + grab state,
(c) accept records from the host via a new `kernel_input_event`
export, (d) drain rings via `read()` + report POLLIN, and (e) answer
the `EVIOCG*` introspection ioctls SDL2 + libinput call at open time.

### Task A1: Shared ABI module additions

**Files:**
- Modify: `crates/shared/src/lib.rs` — add `pub mod input { … }` with
  the record struct, the `EV_*` / `KEY_*` / `BTN_*` / `REL_*` /
  `ABS_*` / `SYN_*` constants, the `EVIOCG*` ioctl numbers, and the
  `WpkInputId` / `WpkInputAbsinfo` aux structs.

**Step 1: Constants and structs**

Append at the end of `crates/shared/src/lib.rs` (sibling of `pub mod
dri`):

```rust
pub mod input {
    use core::mem::size_of;

    // --- Event types (struct input_event.type) ---------------------------

    /// `EV_SYN` = 0. End-of-logical-event sentinel; readers use this
    /// to coalesce a (REL_X, REL_Y) pair into one cursor move.
    pub const EV_SYN: u16 = 0x00;
    /// `EV_KEY` = 1. Press / release / autorepeat. Value is
    /// 0 = release, 1 = press, 2 = repeat.
    pub const EV_KEY: u16 = 0x01;
    /// `EV_REL` = 2. Relative axis (pointer dx/dy/wheel).
    pub const EV_REL: u16 = 0x02;
    /// `EV_ABS` = 3. Absolute axis (pointer position when not locked,
    /// joystick, touch coords).
    pub const EV_ABS: u16 = 0x03;
    /// `EV_MSC` = 4. Misc events (scancode, timestamp). Not produced
    /// in v1.
    pub const EV_MSC: u16 = 0x04;

    // --- SYN codes (subset; struct input_event.code when type == EV_SYN)

    /// `SYN_REPORT` = 0. End-of-frame; readers should treat
    /// everything since the previous SYN_REPORT as atomic.
    pub const SYN_REPORT: u16 = 0x00;
    /// `SYN_DROPPED` = 3. Posted when the ring overflowed and the
    /// oldest record was dropped; userspace should resynchronise
    /// (re-query EVIOCG* state).
    pub const SYN_DROPPED: u16 = 0x03;

    // --- KEY_* codes (verbatim subset of linux/input-event-codes.h)

    pub const KEY_RESERVED: u16 = 0;
    pub const KEY_ESC: u16 = 1;
    pub const KEY_1: u16 = 2;
    // … (the full table — KEY_2 = 3, KEY_3 = 4, …, KEY_MICMUTE = 248
    //   — is appended verbatim from upstream input-event-codes.h)
    pub const KEY_A: u16 = 30;
    pub const KEY_Z: u16 = 44;
    pub const KEY_ENTER: u16 = 28;
    pub const KEY_BACKSPACE: u16 = 14;
    pub const KEY_LEFTSHIFT: u16 = 42;
    pub const KEY_RIGHTSHIFT: u16 = 54;
    pub const KEY_LEFTCTRL: u16 = 29;
    pub const KEY_RIGHTCTRL: u16 = 97;
    pub const KEY_LEFTALT: u16 = 56;
    pub const KEY_RIGHTALT: u16 = 100;
    pub const KEY_LEFTMETA: u16 = 125;
    pub const KEY_RIGHTMETA: u16 = 126;
    pub const KEY_SPACE: u16 = 57;
    pub const KEY_TAB: u16 = 15;
    pub const KEY_F1: u16 = 59;
    pub const KEY_F12: u16 = 88;
    pub const KEY_UP: u16 = 103;
    pub const KEY_LEFT: u16 = 105;
    pub const KEY_RIGHT: u16 = 106;
    pub const KEY_DOWN: u16 = 108;
    // The full table is ~128 entries; spelled out in the source.

    // --- BTN_* codes (button class; reuse the EV_KEY type) ---------------

    pub const BTN_LEFT: u16 = 0x110;
    pub const BTN_RIGHT: u16 = 0x111;
    pub const BTN_MIDDLE: u16 = 0x112;
    pub const BTN_SIDE: u16 = 0x113;
    pub const BTN_EXTRA: u16 = 0x114;

    // --- REL_* codes (relative axes; EV_REL records carry these) ---------

    pub const REL_X: u16 = 0x00;
    pub const REL_Y: u16 = 0x01;
    pub const REL_WHEEL: u16 = 0x08;
    pub const REL_HWHEEL: u16 = 0x06;

    // --- ABS_* codes (absolute axes; EV_ABS records carry these) ---------

    pub const ABS_X: u16 = 0x00;
    pub const ABS_Y: u16 = 0x01;

    // --- ioctl numbers ('E' magic, Linux UAPI verbatim) ------------------

    /// `_IOR('E', 0x01, int)` = `0x8004_4501`.
    pub const EVIOCGVERSION: u32 = 0x8004_4501;

    /// `_IOR('E', 0x02, WpkInputId)` = `0x8008_4502`.
    pub const EVIOCGID: u32 = 0x8008_4502;

    /// `_IOC(_IOC_READ, 'E', 0x06, len)` where `len` is the
    /// caller-supplied buffer size. We accept `1 ≤ len ≤ 256` and
    /// recompute the expected encoding at dispatch time (the userspace
    /// macro is `EVIOCGNAME(len)`; the kernel matches against the
    /// nr-byte + magic only, not the size — see A3 Step 1 for the
    /// "size in the ioctl number is informational" handling).
    pub const EVIOCGNAME_NR: u32 = 0x06;

    /// `EVIOCGBIT(ev_type, len)` — same variable-length shape as
    /// `EVIOCGNAME`. nr = 0x20 + ev_type.
    pub const EVIOCGBIT_NR_BASE: u32 = 0x20;

    /// `EVIOCGABS(axis)` — `_IOR('E', 0x40 + axis, WpkInputAbsinfo)`.
    /// Axis is a small integer (`ABS_X = 0`, `ABS_Y = 1`, …).
    pub const EVIOCGABS_NR_BASE: u32 = 0x40;

    /// `_IOW('E', 0x90, int)` = `0x4004_4590`.
    pub const EVIOCGRAB: u32 = 0x4004_4590;

    // --- marshalled structs ----------------------------------------------

    /// `struct input_event` on wasm32-musl (`time_t = int64_t`,
    /// `suseconds_t = int32_t`, `__u16` + `__u16` + `__s32`).
    /// Total = 24 bytes. The struct layout matches Linux's 64-bit
    /// userland exactly, which is what every modern Linux distro
    /// ships for 64-bit-time_t 32-bit userland too.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkInputEvent {
        pub tv_sec: i64,    // 0   CLOCK_MONOTONIC seconds since kernel boot
        pub tv_usec: i32,   // 8   microseconds; matches musl suseconds_t
        pub _pad: i32,      // 12  explicit pad to 8-align the trailing union
        pub ev_type: u16,   // 16  EV_KEY / EV_REL / EV_ABS / EV_SYN / EV_MSC
        pub code: u16,      // 18  KEY_* / BTN_* / REL_* / ABS_* / SYN_*
        pub value: i32,     // 20  press/release/repeat; delta; absolute pos
                            // total: 24
    }

    /// `struct input_id`. 8 bytes (4 × u16).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkInputId {
        pub bustype: u16,   // 0   BUS_VIRTUAL = 0x06 (closest match)
        pub vendor: u16,    // 2   0x1209 (Interbiometrics, generic)
        pub product: u16,   // 4   0x0001 for kbd, 0x0002 for ptr
        pub version: u16,   // 6   0x0001
                            // total: 8
    }

    /// `struct input_absinfo`. 24 bytes (5 × i32 + 1 × i32 pad).
    /// Used for ABS_X / ABS_Y on the pointer device when pointer
    /// lock is not active.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkInputAbsinfo {
        pub value: i32,     // 0   current value
        pub minimum: i32,   // 4
        pub maximum: i32,   // 8   = canvas width-1 / height-1
        pub fuzz: i32,      // 12  = 0
        pub flat: i32,      // 16  = 0
        pub resolution: i32,// 20  = 1 (1 unit per pixel)
                            // total: 24
    }

    // --- BUS_* constants (subset) ----------------------------------------

    /// `BUS_VIRTUAL` = 0x06 — closest match for a kernel-synthesised
    /// device (Linux uses this for `uinput`-backed devices).
    pub const BUS_VIRTUAL: u16 = 0x06;
}

#[cfg(test)]
mod input_tests {
    use super::input::*;
    use core::mem::size_of;
    use crate::ioc;  // helper introduced by plan 2 Task A1

    #[test]
    fn input_struct_sizes_match_wasm32_repr_c() {
        assert_eq!(size_of::<WpkInputEvent>(), 24);
        assert_eq!(size_of::<WpkInputId>(), 8);
        assert_eq!(size_of::<WpkInputAbsinfo>(), 24);
    }

    #[test]
    fn input_event_field_offsets() {
        // The 24-byte layout is load-bearing — every reader walks
        // the ring 24 bytes at a time. Lock the offsets explicitly.
        let e = WpkInputEvent::default();
        let base = (&e as *const _) as usize;
        assert_eq!((&e.tv_sec as *const _ as usize) - base, 0);
        assert_eq!((&e.tv_usec as *const _ as usize) - base, 8);
        assert_eq!((&e.ev_type as *const _ as usize) - base, 16);
        assert_eq!((&e.code as *const _ as usize) - base, 18);
        assert_eq!((&e.value as *const _ as usize) - base, 20);
    }

    #[test]
    fn evioc_numbers_match_linux_uapi() {
        let ior = 0x4000_0000;  // _IOC_READ shifted to dir bits
        let iow = 0x8000_0000;  // _IOC_WRITE — verify against plan 2's helper
        // The ioc helper plan 2 introduced is the source of truth;
        // these literal expected values are documentation of the
        // wire format for grep-ability.
        assert_eq!(EVIOCGVERSION,
            ioc(/*IOC_READ*/ 1, 'E' as u32, 0x01, 4));
        assert_eq!(EVIOCGID,
            ioc(/*IOC_READ*/ 1, 'E' as u32, 0x02, size_of::<WpkInputId>() as u32));
        assert_eq!(EVIOCGRAB,
            ioc(/*IOC_WRITE*/ 2, 'E' as u32, 0x90, 4));
        // EVIOCGABS(0) — ABS_X — base is 0x40.
        assert_eq!(
            ioc(/*IOC_READ*/ 1, 'E' as u32, EVIOCGABS_NR_BASE + ABS_X as u32,
                size_of::<WpkInputAbsinfo>() as u32),
            0x8018_4540);
    }
}
```

**Step 2: Run**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib input_tests
```

Expected: 3 new tests pass; plan 2 + plan 3 + plan 4 tests still pass.

**The `_pad: i32` field is mandatory, not optional.** `repr(C)` follows
C's "natural alignment, trailing padding to struct alignment" rule —
it does NOT insert *interior* padding between `tv_usec: i32` (offset
8..11) and `ev_type: u16` (which would otherwise land at offset 12).
Without the explicit `_pad`, the Rust struct is still 24 bytes (the
trailing padding bumps it to the i64's 8-byte alignment), but `ev_type`
sits at offset 12 — whereas userspace C reads it at offset 16 because
`struct timeval` is itself 16 bytes on wasm32-musl (`int64_t tv_sec`
forces 8-byte alignment of the substruct, padding the trailing
`int32_t tv_usec` to 16). The two layouts agree on size but disagree
on every offset past byte 11: the kernel would write `ev_type` at byte
12 and read `value` from bytes 16..20; userspace would read `ev_type`
from bytes 16..18 (which is the kernel's `value` low half) and `value`
from bytes 20..24 (zero pad). Silent corruption on every record. The
field-offset asserts above are the gate; if you see `ev_type` at
offset 12 it means someone deleted `_pad` — restore it. `cargo expand`
confirms the actual layout.

**Step 3: Commit**

```bash
git add crates/shared/src/lib.rs
git commit -m "kernel(input): shared ABI — struct input_event + EV_*/KEY_*/EVIOCG* constants"
```

---

### Task A2: `VirtualDevice::InputEvent` + devfs entries + `OpenFileKind::InputEvent` + `InputFdState` on OFD

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend `VirtualDevice`
  enum + `match_virtual_device` to recognise `/dev/input/event0`
  and `/dev/input/event1`.
- Modify: `crates/kernel/src/devfs.rs` — add `event0` and `event1`
  entries under a new `input/` subdirectory.
- Modify: `crates/kernel/src/ofd.rs` — add `OpenFileKind::InputEvent
  { device: u8 }` and an `input: Option<Box<InputFdState>>` field on
  `OpenFileDesc`.

**Step 1: Device enum**

```rust
pub enum VirtualDevice {
    // … existing variants …
    DriRender0,       // /dev/dri/renderD128 (plan 2 + 3)
    DriCard0,         // /dev/dri/card0     (plan 4)
    InputEvent {      // /dev/input/event{0,1} (plan 5 — this task)
        device: u8,   // 0 = kbd, 1 = ptr
    },
}
```

Extend `match_virtual_device` to map `/dev/input/event0` and
`/dev/input/event1` into the two variants. Other `/dev/input/event*`
paths return `ENOENT` (not a stub — really not present in v1).

**Step 2: devfs entries**

Add a new `input` subdirectory under `/dev` with two synthetic char
entries:

```rust
// In devfs.rs, alongside the existing /dev/dri synthetic dir:
synthetic_subdir("input", &[
    synthetic_entry("event0", DT_CHR, 13 /* INPUT_MAJOR */, 64),
    synthetic_entry("event1", DT_CHR, 13,                    65),
]);
```

(Major 13 is the Linux input subsystem major; minors 64..95 are the
event-device range. Conventional, not load-bearing.)

**Step 3: `InputFdState` on the OFD**

In `crates/kernel/src/ofd.rs`:

```rust
/// Per-fd state for `/dev/input/event{0,1}` opens. Disjoint from
/// `DriOfdState` (plan 4) — input fds carry no DRI bo state. We
/// keep `input` as a separate `Option<Box<…>>` field on the OFD
/// rather than folding it into `DriOfdState` because the two state
/// machines have no shared invariants.
#[derive(Default, Clone, Debug)]
pub struct InputFdState {
    /// Which device this fd is bound to (0 = kbd, 1 = ptr). Cached
    /// to avoid a second VirtualDevice lookup on read/write.
    pub device: u8,

    /// Ring of 24-byte records. Bounded at 1024 events (24 KiB) per
    /// the Pre-impl review entry "Event-ring bound". On overflow,
    /// `dropped` flips to true and the **new** record is discarded
    /// (Linux's `drivers/input/evdev.c::evdev_pass_values` semantics:
    /// while the dropped flag is set, no new events land on the
    /// ring; the *next* read synthesises a SYN_DROPPED record at the
    /// head of the returned buffer and clears the flag). This
    /// preserves the invariant that the ring never exceeds
    /// INPUT_RING_MAX_BYTES.
    pub event_ring: VecDeque<u8>,

    /// `EVIOCGRAB`-set ownership flag. v1 records the flag but
    /// doesn't gate event delivery on it — plan 9 (wpkcompositor)
    /// adds the focus-routing layer.
    pub grabbed: bool,

    /// Set when push_event finds the ring full; cleared on the next
    /// `read()` *after* a SYN_DROPPED synthetic record is delivered
    /// at the head of that read's output. While set, new pushes are
    /// silently discarded — userspace re-syncs via EVIOCG* state.
    pub dropped: bool,

    /// Per-OFD ring high-water-mark for diagnostics (peak record
    /// count seen). Not exposed via ioctl; debug-only.
    pub ring_high_water: u32,
}

pub const INPUT_RING_MAX_RECORDS: usize = 1024;
pub const INPUT_RING_MAX_BYTES: usize =
    INPUT_RING_MAX_RECORDS * 24;  // 24 KiB per OFD ring
```

Attach `input: Option<Box<InputFdState>>` to `OpenFileDesc`, parallel
to `dri_state` (plan 4's consolidated enum). Set to
`Some(Box::new(InputFdState { device, ..Default::default() }))` on
`open("/dev/input/event{0,1}")`; `None` for any other path.

**Step 4: Cargo tests**

```rust
#[test]
fn open_event0_yields_input_state_with_device_zero() { /* … */ }

#[test]
fn open_event1_yields_input_state_with_device_one() { /* … */ }

#[test]
fn fork_inherits_input_state_via_ofd_dup() {
    // Same OFD shared by ref → same InputFdState (Linux per-fd
    // semantics preserved through fork's ref-bump). The ring is
    // shared too — child and parent see the same events. (Plan 9's
    // compositor adds a per-process focus filter on top.)
}

#[test]
fn open_nonexistent_event_path_returns_enoent() {
    // /dev/input/event2 → ENOENT (we only synthesise 0 and 1).
}
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/devfs.rs \
        crates/kernel/src/ofd.rs
git commit -m "kernel(input): add /dev/input/event{0,1} + InputFdState on OFD"
```

---

### Task A3: `EVIOCG*` ioctl dispatch — GVERSION / GID / GNAME / GBIT / GABS / GRAB

**Files:**
- Create: `crates/kernel/src/input/mod.rs` — the input subsystem
  module (sibling of `dri/`).
- Modify: `crates/kernel/src/syscalls.rs` — dispatcher for input-fd
  ioctls (new `handle_input_ioctl(pid, fd, request, buf)` callable).

**Step 1: Dispatcher**

```rust
fn handle_input_ioctl(pid: i32, fd: i32, request: u32, buf: &mut [u8])
    -> Result<(), Errno>
{
    use wasm_posix_shared::input::*;

    // Decode the ioctl number's nr byte and direction. The "size"
    // sub-field of EVIOCGNAME / EVIOCGBIT is informational — Linux
    // matches on the (dir, magic, nr) triple and uses
    // `_IOC_SIZE(request)` to learn the caller's buffer length.
    let dir = (request >> 30) & 0x3;
    let magic = (request >> 8) & 0xff;
    let nr = request & 0xff;
    let size = ((request >> 16) & 0x3fff) as usize;

    if magic != 'E' as u32 { return Err(Errno::EINVAL); }

    match nr {
        // EVIOCGVERSION
        0x01 if dir == 1 => {
            let version_be: u32 = 0x0001_0001;  // EV_VERSION = 0x010001
            write_u32(buf, version_be)?;
            Ok(())
        }

        // EVIOCGID
        0x02 if dir == 1 => {
            let device = with_input_ofd(pid, fd, |i| i.device)?;
            let id = WpkInputId {
                bustype: BUS_VIRTUAL,
                vendor: 0x1209,
                product: if device == 0 { 0x0001 } else { 0x0002 },
                version: 0x0001,
            };
            write_struct(buf, &id)?;
            Ok(())
        }

        // EVIOCGNAME(len) — fixed device name; truncate to caller's len.
        0x06 if dir == 1 => {
            let device = with_input_ofd(pid, fd, |i| i.device)?;
            let name: &[u8] = if device == 0 {
                b"wpk virtual keyboard\0"
            } else {
                b"wpk virtual pointer\0"
            };
            let copy_len = name.len().min(size);
            buf[..copy_len].copy_from_slice(&name[..copy_len]);
            Ok(())
        }

        // EVIOCGBIT(ev_type, len) — bit array of which codes are
        // supported. For ev_type = 0 (the special "what types do
        // you support" query), return EV_KEY | EV_REL | EV_ABS |
        // EV_SYN as a bitmap. For EV_KEY, return the bits for every
        // KEY_* we deliver. For EV_REL on event1, REL_X | REL_Y.
        // For EV_ABS on event1, ABS_X | ABS_Y. event0 advertises
        // KEY only; event1 advertises KEY (buttons) + REL + ABS.
        nr if (0x20..0x20 + 32).contains(&nr) && dir == 1 => {
            let ev_type = (nr - 0x20) as u16;
            let device = with_input_ofd(pid, fd, |i| i.device)?;
            for b in buf.iter_mut() { *b = 0; }
            populate_evbit(device, ev_type, buf);
            Ok(())
        }

        // EVIOCGABS(axis) — only meaningful on event1 (pointer).
        nr if (0x40..0x40 + 64).contains(&nr) && dir == 1 => {
            let axis = (nr - 0x40) as u16;
            let device = with_input_ofd(pid, fd, |i| i.device)?;
            if device != 1 { return Err(Errno::EINVAL); }
            // Canvas dimensions come from plan 4's KmsRegistry-side
            // canvas attachment — for v1 we cache them in a kernel-
            // global static set at boot via `HostIO::input_canvas_dims`
            // (call wired in A4 Step 3 below). Fallback to 1280x720
            // if not yet set.
            let (w, h) = crate::input::canvas_dims();
            let abs = match axis {
                ABS_X => WpkInputAbsinfo { value: 0, minimum: 0,
                    maximum: (w as i32) - 1, fuzz: 0, flat: 0,
                    resolution: 1 },
                ABS_Y => WpkInputAbsinfo { value: 0, minimum: 0,
                    maximum: (h as i32) - 1, fuzz: 0, flat: 0,
                    resolution: 1 },
                _ => return Err(Errno::EINVAL),
            };
            write_struct(buf, &abs)?;
            Ok(())
        }

        // EVIOCGRAB(int) — value != 0 sets grab, value == 0 releases.
        //
        // Linux semantics (drivers/input/evdev.c::evdev_ioctl): re-grab
        // from the **same fd** is idempotent (returns 0); cross-fd grab
        // while another fd holds returns EBUSY. v1 records the grab
        // per-OFD but doesn't enforce cross-fd exclusivity (every open
        // fd still sees every event); plan 9's compositor adds the
        // cross-fd gate. The Ok(()) on re-grab matches Linux exactly;
        // the EBUSY-on-other-fd's-grab path lands with plan 9.
        0x90 if dir == 2 => {
            let value = read_u32(buf)? as i32;
            with_input_ofd_mut(pid, fd, |i| {
                i.grabbed = value != 0;
                Ok(())
            })?
        }

        _ => Err(Errno::EOPNOTSUPP),
    }
}
```

`populate_evbit(device, ev_type, buf)` writes the supported-codes
bitmap. Sketch:

```rust
fn populate_evbit(device: u8, ev_type: u16, buf: &mut [u8]) {
    fn set_bit(buf: &mut [u8], bit: u16) {
        let byte = (bit as usize) >> 3;
        let shift = (bit as usize) & 7;
        if byte < buf.len() { buf[byte] |= 1 << shift; }
    }
    match (device, ev_type) {
        (_, 0) => {  // ev_type 0 = "what types?"
            set_bit(buf, EV_KEY);
            set_bit(buf, EV_SYN);
            if device == 1 {
                set_bit(buf, EV_REL);
                set_bit(buf, EV_ABS);
            }
        }
        (0, t) if t == EV_KEY => {
            // Keyboard: every KEY_* we advertise.
            for &k in &[KEY_ESC, KEY_1, /* … */ KEY_A, KEY_Z,
                        KEY_ENTER, KEY_BACKSPACE, KEY_LEFTSHIFT,
                        /* … full set; ~128 entries spelled out */] {
                set_bit(buf, k);
            }
        }
        (1, t) if t == EV_KEY => {
            // Pointer: only the BTN_* buttons.
            for &b in &[BTN_LEFT, BTN_RIGHT, BTN_MIDDLE,
                        BTN_SIDE, BTN_EXTRA] {
                set_bit(buf, b);
            }
        }
        (1, t) if t == EV_REL => {
            set_bit(buf, REL_X);
            set_bit(buf, REL_Y);
            set_bit(buf, REL_WHEEL);
            set_bit(buf, REL_HWHEEL);
        }
        (1, t) if t == EV_ABS => {
            set_bit(buf, ABS_X);
            set_bit(buf, ABS_Y);
        }
        _ => { /* unsupported (type, device) — leave buf zero */ }
    }
}
```

**Step 2: Wire into the syscall ioctl router**

In `sys_ioctl`, before falling through to "unrecognised ioctl on this
device":

```rust
if let Some(OpenFileKind::InputEvent { device: _ }) =
    ofd.kind.as_ref()
{
    return handle_input_ioctl(pid, fd, request, buf);
}
```

**Step 3: Cargo tests**

```rust
#[test]
fn evioc_gversion_returns_010001() { /* … */ }

#[test]
fn evioc_gid_keyboard_vs_pointer_differs_by_product() { /* … */ }

#[test]
fn evioc_gname_event0_returns_keyboard_string() { /* … */ }

#[test]
fn evioc_gbit_keyboard_advertises_ev_key_and_ev_syn_only() { /* … */ }

#[test]
fn evioc_gbit_pointer_advertises_rel_and_abs_too() { /* … */ }

#[test]
fn evioc_gabs_keyboard_returns_einval() { /* … */ }

#[test]
fn evioc_grab_sets_flag_then_release_clears_it() { /* … */ }

#[test]
fn evioc_grab_twice_from_same_fd_is_idempotent() {
    // EVIOCGRAB(1) on a fd that already has grabbed=true returns 0,
    // not EBUSY — matches Linux's per-fd idempotent semantics
    // (drivers/input/evdev.c). The cross-fd EBUSY case lands with
    // plan 9.
}

#[test]
fn evioc_grab_release_without_prior_grab_is_a_noop() {
    // EVIOCGRAB(0) on a never-grabbed fd returns 0, not an error.
    // Matches Linux.
}
```

**Step 4: Commit**

```bash
git add crates/kernel/src/input/ crates/kernel/src/syscalls.rs
git commit -m "kernel(input): EVIOCG* ioctl dispatch + populate_evbit"
```

---

### Task A4: `kernel_input_event()` export — host pushes events; kernel fans out + wakes

**Files:**
- Create: `crates/kernel/src/input/dispatch.rs` — the producer +
  ring management.
- Modify: `crates/kernel/src/wasm_api.rs` — add the kernel-wasm
  export `kernel_input_event`.
- Modify: `crates/kernel/src/process.rs` — `HostIO::input_canvas_dims`
  is called by the host once at boot to set the pointer device's
  ABS axis maxima; cached in `input::canvas_dims()` (Task A3's
  fallback path).

**Step 1: The producer**

```rust
// crates/kernel/src/input/dispatch.rs

use wasm_posix_shared::input::*;
use crate::ofd::{InputFdState, INPUT_RING_MAX_RECORDS, INPUT_RING_MAX_BYTES};

/// Push a single input event onto every open OFD bound to the
/// matching device. Called from `kernel_input_event` (the wasm-side
/// export the host invokes). `device` must be 0 (kbd) or 1 (ptr);
/// other values are dropped.
///
/// Ring overflow protocol (matches Linux's `evdev_pass_values`):
/// when an OFD's ring is full, set `dropped = true` and **discard
/// the incoming record**. The `dropped` flag is consumed by the next
/// `read()` on that OFD (Task A5): the read prepends a synthesised
/// `EV_SYN { code: SYN_DROPPED, value: 0 }` record and clears the
/// flag. Userspace re-syncs state via EVIOCGKEY / EVIOCGLED / etc.
/// Crucially: the ring NEVER exceeds INPUT_RING_MAX_BYTES, even
/// under pathological producers — the bound holds for free because
/// pushes-while-dropped are no-ops.
pub fn push_event(device: u8, ev_type: u16, code: u16, value: i32) {
    if device > 1 { return; }
    let now = crate::time::monotonic_us();  // CLOCK_MONOTONIC
    let ev = WpkInputEvent {
        tv_sec: (now / 1_000_000) as i64,
        tv_usec: (now % 1_000_000) as i32,
        _pad: 0,
        ev_type,
        code,
        value,
    };
    // Take PROCESS_TABLE lock briefly (OFDs live inside it per plan
    // 3 A3 + plan 4 A7). Iterate `pt.ofds.entries`; cost is O(N) over
    // open OFDs of the matching device, which is small (typically
    // one per running program). Same lock-order resolution plan 4
    // A7's `kernel_vblank` arrived at — see plan 4's "open
    // correctness — `kernel_vblank()` lock-order" note.
    let mut woken: Vec<usize> = Vec::new();
    {
        let mut pt = crate::PROCESS_TABLE.lock();
        for (idx, slot) in pt.ofds.entries.iter_mut().enumerate() {
            let Some(ofd) = slot.as_mut() else { continue; };
            let Some(input) = ofd.input.as_mut() else { continue; };
            if input.device != device { continue; }

            // Ring overflow: set the dropped flag, discard the
            // record. read() at A5 synthesises SYN_DROPPED at the
            // head of its next return + clears the flag.
            if input.event_ring.len() >= INPUT_RING_MAX_BYTES {
                input.dropped = true;
                continue;  // do NOT wake — reader has nothing new
            }
            push_record(&mut input.event_ring, &ev);
            let count = (input.event_ring.len() / 24) as u32;
            if count > input.ring_high_water {
                input.ring_high_water = count;
            }
            woken.push(idx);
        }
    }
    // Wake every OFD that got new bytes (per-OFD wake, same shape
    // as plan 4 A7's `wake_event_reader`).
    for idx in woken {
        crate::input::wait::wake_event_reader(idx);
    }
}

fn push_record(ring: &mut VecDeque<u8>, ev: &WpkInputEvent) {
    let bytes: &[u8; 24] = unsafe { core::mem::transmute(ev) };
    for &b in bytes.iter() { ring.push_back(b); }
}
```

**Step 2: The kernel export**

```rust
// crates/kernel/src/wasm_api.rs

/// Called by the host on every DOM keyboard / pointer event after
/// translating the browser-side code to evdev's KEY_* / BTN_* /
/// REL_* / ABS_* + EV_SYN follow-up. Single entrypoint; the kernel
/// fans out to every open OFD on the matching device's node.
///
/// `device`: 0 = `/dev/input/event0` (kbd), 1 = `event1` (ptr).
/// `ev_type`: EV_KEY / EV_REL / EV_ABS / EV_SYN.
/// `code`: KEY_* / BTN_* / REL_* / ABS_* / SYN_*.
/// `value`: press(1) / release(0) / repeat(2) for KEY; delta for
///   REL; absolute pos for ABS; SYN_REPORT carries 0.
///
/// Convention: the host emits the type-specific record first
/// (EV_KEY, EV_REL, etc.) then a matching EV_SYN(SYN_REPORT, 0)
/// to close the logical event. SDL2 + libinput coalesce on
/// SYN_REPORT.
#[no_mangle]
pub extern "C" fn kernel_input_event(device: u32, ev_type: u32,
    code: u32, value: i32)
{
    crate::input::dispatch::push_event(
        device as u8, ev_type as u16, code as u16, value);
}
```

**Step 3: Canvas-dims wiring**

The pointer device's `ABS_X` / `ABS_Y` maxima come from the canvas
the browser host attached for KMS (plan 4 B3's `attachKmsCanvas`).
At boot, the host calls a one-shot kernel export:

```rust
#[no_mangle]
pub extern "C" fn kernel_set_input_canvas_dims(width: u32, height: u32) {
    crate::input::set_canvas_dims(width, height);
}
```

(Additive export; ABI-safe.) The Node host can call this with stub
values for null-source tests.

**Boot-ordering contract (load-bearing).** B4 wires this so:
`kernel_set_input_canvas_dims(w, h)` is called **before** the host
starts the `InputSource` (browser DOM listeners or Node null-source)
AND before the kernel signals "ready" to user processes. This avoids
the race where a process opens `/dev/input/event1` and calls EVIOCGABS
between boot and the host setting dims — the kernel's "1280x720
fallback" exists for defensive correctness but B4 must guarantee the
real call has landed first. Vitest in B4 asserts call ordering.

The dims are stored in an `AtomicU64` (low 32 = width, high 32 =
height) — set-once on first call; subsequent calls are silently
ignored (canvas resize is post-v1 per design §6.1). The current
canvas size is never queryable from userspace except via EVIOCGABS;
if a future plan adds canvas resize, change the semantics from
"first wins" to "last wins" + emit a SYN_REPORT on every open
pointer-fd OFD so readers re-sync via EVIOCGABS. v1 doesn't ship
that.

**Step 4: Cargo tests**

```rust
#[test]
fn push_event_appends_24_bytes_to_every_matching_ofd() { /* … */ }

#[test]
fn push_event_with_no_matching_ofd_is_a_noop() { /* … */ }

#[test]
fn ring_overflow_drops_oldest_and_emits_syn_dropped() {
    // Open event0, push 1025 records without draining → the first
    // record is gone, then a SYN_DROPPED marker, then the 1024 most
    // recent records. (Total ring bytes after = 1025 × 24 = 24600 −
    // 24 (oldest dropped) + 24 (SYN_DROPPED) = 24600.)
}

#[test]
fn push_event_wakes_blocked_reader() { /* … */ }
```

**Step 5: Commit**

```bash
git add crates/kernel/src/input/ crates/kernel/src/wasm_api.rs \
        crates/kernel/src/process.rs
git commit -m "kernel(input): kernel_input_event export + fan-out + ring overflow handling"
```

---

### Task A5: `read(/dev/input/event*)` drains the ring; `poll(POLLIN)` gates

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — `sys_read` arm for
  `OpenFileKind::InputEvent`; `sys_poll` arm for POLLIN.

```rust
// In sys_read, before the host-handle fast path, for InputEvent OFDs:
if let Some(input) = ofd.input.as_mut() {
    // POLLIN-ready iff there's a real record OR an unconsumed
    // dropped flag. Park only when both are empty.
    if input.event_ring.is_empty() && !input.dropped {
        crate::input::wait::block_event_reader(ofd_idx)?;
    }
    let usable = (user_buf.len() / 24) * 24;
    if usable == 0 {
        return Err(Errno::EINVAL);  // libinput would never do this
    }
    let mut written = 0;
    // If the producer dropped events, synthesise the SYN_DROPPED
    // marker at the head of this read (Linux's evdev convention).
    // The marker carries the current monotonic timestamp — userspace
    // doesn't use it but the field must be valid.
    if input.dropped {
        let now = crate::time::monotonic_us();
        let dropped_ev = WpkInputEvent {
            tv_sec: (now / 1_000_000) as i64,
            tv_usec: (now % 1_000_000) as i32,
            _pad: 0,
            ev_type: EV_SYN,
            code: SYN_DROPPED,
            value: 0,
        };
        let bytes: &[u8; 24] = unsafe { core::mem::transmute(&dropped_ev) };
        user_buf[..24].copy_from_slice(bytes);
        written = 24;
        input.dropped = false;
    }
    // Drain whole 24-byte records into the remaining buffer. Linux
    // evdev semantics: read() returns a multiple of sizeof(struct
    // input_event); partial-record returns are forbidden.
    while written + 24 <= usable && !input.event_ring.is_empty() {
        for i in 0..24 {
            user_buf[written + i] = input.event_ring.pop_front().unwrap();
        }
        written += 24;
    }
    return Ok(written);
}
```

`poll(input_fd, POLLIN)` returns ready iff `!event_ring.is_empty() ||
input.dropped` — the dropped marker alone counts as a readable record.

**Cargo tests:**
- `read_with_short_buffer_returns_floor_of_24_byte_multiple` —
  caller passes `len = 50` → reader returns 48 bytes (2 records),
  not 50.
- `read_blocks_on_empty_ring_resumes_on_push_event`.
- `poll_pollin_idle_then_ready_after_push_event`.
- `ring_overflow_consumes_dropped_flag_on_next_read` — push 1100
  events without reading; assert ring stays bounded at 1024 records
  (24576 bytes); next read returns SYN_DROPPED at offset 0 followed
  by the 1024 *oldest* records (since overflow drops *new* events,
  not old ones — matches Linux semantics, where the buffered events
  are still valid history); dropped flag clears after the read.
- `poll_pollin_ready_on_dropped_flag_alone` — drain the ring, set
  the dropped flag, assert POLLIN is ready and the next read
  returns exactly 24 bytes (the synthesised SYN_DROPPED).
- `read_with_buffer_too_small_for_any_record_returns_einval` —
  `len = 12` → EINVAL (not partial-record return).

**Commit:** `kernel(input): read(input_event) drains ring + poll(POLLIN)`

---

### Task A6: `on_final_close` releases grab + drops ring

**Files:**
- Modify: `crates/kernel/src/ofd.rs` — extend `on_final_close`.

```rust
impl OpenFileDesc {
    pub fn on_final_close(&mut self, pid: i32, host_io: &mut dyn HostIO,
        ofd_idx: usize)
    {
        // … plan 2's prime_bo cleanup …
        // … plan 3's dri.handles + dri.gl.bindings cleanup …
        // … plan 4's kms cleanup (master, fbs, pending_flips) …
        if let Some(input) = self.input.take() {
            // No host-side per-OFD state to clean — the host's
            // InputSource is a single producer; per-OFD ring lives
            // in the kernel only. Grab flag is dropped with the
            // OFD; event_ring is GC'd.
            //
            // (When plan 9's wpkcompositor adds focus routing, an
            // EVIOCGRAB-held OFD closing will need to notify the
            // compositor so it can re-grant ownership. Stub a
            // log-only `host_io.input_grab_released(pid, device)`
            // call here at plan-9-merge time; v1 doesn't need it.)
            let _ = input;  // explicit drop for clarity
        }
    }
}
```

**Cargo tests:**
- `close_releases_grab_so_next_open_can_grab` — Process A opens
  event0, EVIOCGRAB. Close. Process B opens event0, EVIOCGRAB →
  succeeds.
- `fork_then_close_in_child_keeps_grab_on_parent` — OFD shared by
  fork; child close → refcount = 1, parent still holds grab; parent
  close → on_final_close runs, grab released.

**Commit:** `kernel(input): on_final_close drops input ring + grab`

---

### Task A7: ABI snapshot regen (additive)

**Files:**
- Modify: `abi/snapshot.json` (auto-generated).
- DO NOT modify: `ABI_VERSION`.

Expected diff: new entries for `WpkInputEvent`, `WpkInputId`,
`WpkInputAbsinfo`, the EV_* / KEY_* / etc. constants, the EVIOC*
ioctl numbers, and the two new exports (`kernel_input_event`,
`kernel_set_input_canvas_dims`). **No** changes to any existing row.

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
bash scripts/check-abi-version.sh
git add abi/snapshot.json
git commit -m "kernel(input): regen ABI snapshot — additive input surface"
```

---

### Task A8: Phase A — full gauntlet + open PR #1

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

Push, open draft PR.

Title: `[explore-dri] kernel(input): /dev/input/event{0,1} + EVIOCG* + input_event ring`

Body (Brandon style):

```markdown
## Summary
- Add `/dev/input/event0` (keyboard) and `/dev/input/event1` (pointer)
  as virtual devices alongside plan 4's `/dev/dri/card0`.
- Per-OFD 24 KiB event ring; bounded with SYN_DROPPED overflow
  signaling per the Linux UAPI convention.
- EVIOCG* introspection ioctls SDL2 + libinput call at open time:
  GVERSION / GID / GNAME / GBIT / GABS / GRAB.
- `kernel_input_event(device, ev_type, code, value)` export —
  host calls this on every DOM keyboard / pointer event after
  translation; kernel fans out to every open OFD and wakes blocked
  readers.
- `struct input_event` is 24 bytes on wasm32 (matches musl's
  64-bit-time_t layout, which matches modern Linux's 64-bit
  userland).

## Why
Plan 5 of the DRI v2 design (`docs/plans/2026-05-18-dri-design.md`
§7) — input devices are the second-of-three host-driven
event-streams (vblank in plan 4; input here; ALSA in plan 6).
Prereq for SDL2's evdev input backend (plan 7, milestone D) and
for the compositor's focus routing (plan 9).

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

## ABI impact
Additive only — no `ABI_VERSION` bump. New `repr(C)` structs
(`WpkInputEvent`, `WpkInputId`, `WpkInputAbsinfo`), new ioctl numbers
in the `'E'` magic (verbatim Linux UAPI), two new kernel exports
(`kernel_input_event`, `kernel_set_input_canvas_dims`). **No new
host imports** — the host is the producer, kernel is the consumer.
No existing surface changes.

## Notes
- `CLOCK_MONOTONIC` timestamps (design §16 q6); shared with plan
  4's `kernel_vblank` for latency profiling.
- v1 fans every event to every open OFD (no focus routing).
  EVIOCGRAB is recorded but not enforced — plan 9's compositor
  adds the focus gate on top.
- Event-ring cap = 1024 records per OFD; overflow emits
  SYN_DROPPED per Linux UAPI convention.
- `struct input_event = 24 bytes` on wasm32, **not** 16. Static-
  assert in A1 Step 2 locks the layout.
```

**Do not merge.**

---

## Phase B — host: `InputSource` (browser DOM capture, Node null-source) + plumbing (PR #2)

### Task B1: `InputSource` module + interface

**Files:**
- Create: `host/src/input/input-source.ts`.

```ts
// host/src/input/input-source.ts

/** Records a single evdev-shaped event ready for kernel dispatch. */
export interface InputEvent {
  device: 0 | 1;
  ev_type: number;
  code: number;
  value: number;
}

export interface InputSource {
  /** Begin capturing input. `dispatch` is called once per evdev
   * record; the host wires it to `kernel.exports.kernel_input_event`.
   * Convention: the source emits the type-specific record (EV_KEY,
   * EV_REL, …) and then an EV_SYN(SYN_REPORT, 0) to close the
   * logical frame — same shape Linux evdev produces. */
  start(dispatch: (ev: InputEvent) => void): void;

  /** Stop capturing; remove DOM listeners or clear timers. */
  stop(): void;
}
```

**Vitest:** import-and-instantiate sanity only.

**Commit:** `host(input): InputSource interface`

---

### Task B2: `BrowserInputSource` — DOM event capture + key-code translation

**Files:**
- Create: `host/src/input/browser-input-source.ts`.
- Create: `host/src/input/key-code-table.ts` — `KeyboardEvent.code`
  → `KEY_*` map (~130 entries, derived from
  `linux/input-event-codes.h`).

```ts
// host/src/input/browser-input-source.ts
import type { InputSource, InputEvent } from './input-source';
import { codeToKey } from './key-code-table';

const EV_SYN = 0x00, EV_KEY = 0x01, EV_REL = 0x02, EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const REL_X = 0x00, REL_Y = 0x01, REL_WHEEL = 0x08, REL_HWHEEL = 0x06;
const ABS_X = 0x00, ABS_Y = 0x01;
const BTN_LEFT = 0x110, BTN_RIGHT = 0x111, BTN_MIDDLE = 0x112;

export class BrowserInputSource implements InputSource {
  private dispatch: ((ev: InputEvent) => void) | null = null;
  private bindings: Array<[EventTarget, string, EventListener]> = [];

  constructor(private target: EventTarget = window,
              private canvas?: HTMLCanvasElement | OffscreenCanvas) {}

  start(dispatch: (ev: InputEvent) => void): void {
    this.dispatch = dispatch;
    this.bind('keydown', this.onKeyDown);
    this.bind('keyup',   this.onKeyUp);
    this.bind('pointermove', this.onPointerMove);
    this.bind('pointerdown', this.onPointerDown);
    this.bind('pointerup',   this.onPointerUp);
    this.bind('wheel', this.onWheel);
    // Lock-mode change shifts the pointer coord-system between REL
    // (locked → movementX/Y deltas) and ABS (unlocked → offsetX/Y
    // absolute). Emit a bare SYN_REPORT on transition so readers
    // (libinput, SDL2) see a re-sync point. document.addEventListener
    // (not this.bind on window) — pointerlockchange fires on
    // document only.
    document.addEventListener('pointerlockchange',
        this.onPointerLockChange.bind(this));
  }

  private onPointerLockChange() {
    this.frame(1);
  }

  stop(): void {
    for (const [t, n, l] of this.bindings) t.removeEventListener(n, l);
    this.bindings = [];
    this.dispatch = null;
  }

  private bind(name: string, handler: (e: any) => void) {
    const wrapped = handler.bind(this);
    this.target.addEventListener(name, wrapped as any);
    this.bindings.push([this.target, name, wrapped as any]);
  }

  private emit(device: 0 | 1, ev_type: number, code: number, value: number) {
    this.dispatch!({ device, ev_type, code, value });
  }

  private frame(device: 0 | 1) {
    // Close the logical event with SYN_REPORT — Linux convention.
    this.emit(device, EV_SYN, SYN_REPORT, 0);
  }

  private onKeyDown(e: KeyboardEvent) {
    const key = codeToKey(e.code); if (key === null) return;
    e.preventDefault();
    this.emit(0, EV_KEY, key, e.repeat ? 2 : 1);
    this.frame(0);
  }

  private onKeyUp(e: KeyboardEvent) {
    const key = codeToKey(e.code); if (key === null) return;
    e.preventDefault();
    this.emit(0, EV_KEY, key, 0);
    this.frame(0);
  }

  private onPointerMove(e: PointerEvent) {
    if (document.pointerLockElement) {
      // Locked: emit deltas via REL_X / REL_Y.
      if (e.movementX !== 0) this.emit(1, EV_REL, REL_X, e.movementX);
      if (e.movementY !== 0) this.emit(1, EV_REL, REL_Y, e.movementY);
    } else {
      // Unlocked: emit absolute coords via ABS_X / ABS_Y.
      this.emit(1, EV_ABS, ABS_X, Math.round(e.offsetX));
      this.emit(1, EV_ABS, ABS_Y, Math.round(e.offsetY));
    }
    this.frame(1);
  }

  private onPointerDown(e: PointerEvent) {
    const btn = pointerButton(e); if (btn === null) return;
    this.emit(1, EV_KEY, btn, 1);
    this.frame(1);
  }

  private onPointerUp(e: PointerEvent) {
    const btn = pointerButton(e); if (btn === null) return;
    this.emit(1, EV_KEY, btn, 0);
    this.frame(1);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    // Linux convention: wheel events are integer ticks. Browsers
    // report deltaY in three modes (deltaMode): 0 = PIXEL (Safari on
    // macOS, often values like ±1 to ±10), 1 = LINE (Firefox, ±3 per
    // notch), 2 = PAGE (rare). Chromium also uses PIXEL but with
    // ±100/±120 quanta per notch. Normalise: divide by the
    // mode-specific scale, then **clamp small-but-nonzero deltas to
    // ±1** so a continuous-trackpad scroll still emits at least one
    // tick (otherwise Math.trunc(0.3 / 120) = 0 and the entire
    // scroll event disappears).
    const scaleY = e.deltaMode === 1 ? 1 : 120;  // LINE → 1 per notch
    const scaleX = e.deltaMode === 1 ? 1 : 120;
    let ticks_y = Math.trunc(e.deltaY / -scaleY);
    let ticks_x = Math.trunc(e.deltaX / scaleX);
    if (ticks_y === 0 && e.deltaY !== 0) ticks_y = e.deltaY < 0 ? 1 : -1;
    if (ticks_x === 0 && e.deltaX !== 0) ticks_x = e.deltaX > 0 ? 1 : -1;
    if (ticks_y !== 0) this.emit(1, EV_REL, REL_WHEEL, ticks_y);
    if (ticks_x !== 0) this.emit(1, EV_REL, REL_HWHEEL, ticks_x);
    if (ticks_y !== 0 || ticks_x !== 0) this.frame(1);
  }
}

function pointerButton(e: PointerEvent): number | null {
  switch (e.button) {
    case 0: return BTN_LEFT;
    case 1: return BTN_MIDDLE;
    case 2: return BTN_RIGHT;
    default: return null;
  }
}
```

`key-code-table.ts` is a 130-entry lookup: `KeyA → KEY_A = 30`,
`Escape → KEY_ESC = 1`, etc. Generated by hand from
`linux/input-event-codes.h` (we're matching Linux UAPI verbatim — same
table SDL2's evdev backend would consume on real Linux). Returns
`null` for codes we don't translate (Fn keys some keyboards expose,
locale-specific keys, etc. — they're rare and userspace stacks like
libxkbcommon handle the locale layer anyway).

**Vitest:** drive a synthetic `KeyboardEvent({ code: 'KeyA' })` into a
`BrowserInputSource` with a dispatch-recording stub; assert two
records emitted in order: `(0, EV_KEY, KEY_A, 1)` then `(0, EV_SYN,
SYN_REPORT, 0)`. Similarly for `keyup` (value=0), `pointermove` with
pointer-lock-mock toggled (`REL_X` vs `ABS_X`), `pointerdown` for
each button, `wheel` for vertical scroll.

**Commit:** `host(input): BrowserInputSource — DOM capture + KEY_*/BTN_*/REL_*/ABS_* translation`

---

### Task B3: `NodeInputSource` — null-source for tests + headless runs

**Files:**
- Create: `host/src/input/node-input-source.ts`.

```ts
// host/src/input/node-input-source.ts
import type { InputSource, InputEvent } from './input-source';

/** No-op source. Node host has no DOM; tests drive events directly
 * via `kernel.exports.kernel_input_event(…)` calls. The host registers
 * this source at boot so the kernel-worker init path is symmetric
 * with the browser (CLAUDE.md "dual-host parity"). */
export class NodeInputSource implements InputSource {
  start(_dispatch: (ev: InputEvent) => void): void { /* no-op */ }
  stop(): void { /* no-op */ }
}
```

**Vitest:** start+stop is a no-op; no records ever emitted unless the
test calls `kernel.exports.kernel_input_event(…)` directly.

**Commit:** `host(input): NodeInputSource — null-source for headless tests`

---

### Task B4: Wire `kernel_input_event` + dual-host parity

**Files:**
- Modify: `examples/browser/lib/browser-kernel.ts` — instantiate
  `BrowserInputSource(window, canvas)` at boot, wire
  `dispatch = (ev) => kernel.exports.kernel_input_event(ev.device,
  ev.ev_type, ev.code, ev.value)`.
- Modify: `host/src/node-kernel-host.ts` — instantiate
  `NodeInputSource()` (so the boot path is parallel).
- Both: call `kernel.exports.kernel_set_input_canvas_dims(w, h)` once
  the canvas is attached.

Dual-host parity (CLAUDE.md): symmetry check — both entries call
`source.start(dispatchInto(kernel))` after `kernel_set_input_canvas_dims`.

**Vitest:** run the Node init path; assert `NodeInputSource.start`
was called; assert `kernel.exports.kernel_set_input_canvas_dims` was
invoked exactly once with the test canvas dims. (Browser path tested
in Playwright at Phase C.)

**Commit:** `host(input): wire kernel_input_event + dual-host boot path`

---

### Task B5: Vitest — end-to-end key + pointer round-trip

**Files:**
- Create: `host/test/input-evdev.spec.ts`.

Setup (driven via the Node host + fake DOM events synthesised
directly into `kernel_input_event`):

- Open `/dev/input/event0` from a fixture process. Assert
  EVIOCGNAME returns `"wpk virtual keyboard"`.
- Push `(0, EV_KEY, KEY_A, 1)` then `(0, EV_SYN, SYN_REPORT, 0)`.
- `read(event0, buf, 48)` → 48 bytes; parse two `WpkInputEvent`s;
  assert the first is `KEY_A` down, the second is `SYN_REPORT`,
  both with monotonic-increasing `tv_sec/tv_usec`.
- Open `/dev/input/event1`. EVIOCGABS(ABS_X) → maximum is the test
  canvas width minus 1.
- Push `(1, EV_REL, REL_X, 5) + SYN_REPORT`. `read(event1, …)` →
  same shape.
- Push 1100 events without reading → drain → assert ring's first
  record is `SYN_DROPPED`, then 1023 of the most recent events.

**Commit:** `host(input): vitest — end-to-end key + pointer + ring overflow`

---

### Task B6: Phase B — full gauntlet + open PR #2

Push, open draft PR.

Title: `[explore-dri] host(input): InputSource (browser + Node) + plumbing`

Body: Summary / Why / Verification / **Dual-host parity proof** (both
Node and browser kernel-worker entries instantiate an
`InputSource`, call `start()`, and route dispatch into
`kernel_input_event`; symmetry verified before commit) / Notes.

---

## Phase C — sysroot + demo + browser (PR #3)

### Task C1: Sysroot input headers — verify musl exports them

**Files:**
- Inspect: `musl-overlay/include/linux/input.h`,
  `musl-overlay/include/linux/input-event-codes.h`.
- If missing or stale: vendor a subset under `musl-overlay/include/linux/`.

musl ships `<linux/input.h>` upstream as part of the kernel-uapi
headers package (`linux-headers-${VER}`). Verify they're present in
the wasm32 sysroot; if not, vendor:

```c
// musl-overlay/include/linux/input.h (minimal subset)
#include <linux/input-event-codes.h>
#include <linux/ioctl.h>
#include <sys/time.h>

struct input_event {
    struct timeval time;
    __u16 type;
    __u16 code;
    __s32 value;
};

struct input_id {
    __u16 bustype, vendor, product, version;
};

struct input_absinfo {
    __s32 value, minimum, maximum, fuzz, flat, resolution;
};

#define EVIOCGVERSION       _IOR('E', 0x01, int)
#define EVIOCGID            _IOR('E', 0x02, struct input_id)
#define EVIOCGNAME(len)     _IOC(_IOC_READ, 'E', 0x06, len)
#define EVIOCGBIT(ev, len)  _IOC(_IOC_READ, 'E', 0x20 + (ev), len)
#define EVIOCGABS(abs)      _IOR('E', 0x40 + (abs), struct input_absinfo)
#define EVIOCGRAB           _IOW('E', 0x90, int)
```

`input-event-codes.h` is the giant `KEY_*` / `BTN_*` table; vendor the
upstream copy verbatim (it's ABI-frozen).

**Verification:** `wasm32posix-cc -c programs/evdev_probe.c` compiles
without missing-include errors; `sizeof(struct input_event) == 24`
(cargo test in A1 already asserts this kernel-side; the userspace-
side assertion is a one-line `_Static_assert` in `evdev_demo.c`).

**Commit:** `sysroot(input): vendor linux/input.h + input-event-codes.h subset`

---

### Task C2: `programs/evdev_demo.c` — keystroke + pointer log demo

**Files:**
- Create: `programs/evdev_demo.c`.

```c
// programs/evdev_demo.c — ~100 LoC
// Opens /dev/input/event0 + event1, polls both for POLLIN, prints
// every record received for 10 simulated seconds. exit 0 if at
// least one keystroke + one pointer move were observed.

#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

_Static_assert(sizeof(struct input_event) == 24,
    "struct input_event must be 24 bytes on wasm32 (musl 64-bit time_t)");

int main(void) {
    int kbd = open("/dev/input/event0", O_RDONLY | O_CLOEXEC);
    int ptr = open("/dev/input/event1", O_RDONLY | O_CLOEXEC);

    char name[256];
    ioctl(kbd, EVIOCGNAME(sizeof name), name);
    printf("kbd: %s\n", name);
    ioctl(ptr, EVIOCGNAME(sizeof name), name);
    printf("ptr: %s\n", name);

    int saw_key = 0, saw_move = 0;
    struct pollfd pfds[2] = {
        { .fd = kbd, .events = POLLIN },
        { .fd = ptr, .events = POLLIN },
    };

    for (int tick = 0; tick < 600; tick++) {  // 10 s @ 60 Hz polling
        int n = poll(pfds, 2, 16 /* ms */);
        if (n < 0) break;
        struct input_event evs[16];
        if (pfds[0].revents & POLLIN) {
            ssize_t r = read(kbd, evs, sizeof evs);
            for (size_t i = 0; i < r / sizeof(evs[0]); i++) {
                if (evs[i].type == EV_KEY && evs[i].value == 1) {
                    printf("key down: code=%u\n", evs[i].code);
                    saw_key = 1;
                }
            }
        }
        if (pfds[1].revents & POLLIN) {
            ssize_t r = read(ptr, evs, sizeof evs);
            for (size_t i = 0; i < r / sizeof(evs[0]); i++) {
                if (evs[i].type == EV_REL || evs[i].type == EV_ABS) {
                    printf("ptr %s code=%u value=%d\n",
                        evs[i].type == EV_REL ? "rel" : "abs",
                        evs[i].code, evs[i].value);
                    saw_move = 1;
                }
            }
        }
    }
    return (saw_key && saw_move) ? 0 : 1;
}
```

Build via `wasm32posix-cc -o programs/evdev_demo.wasm
programs/evdev_demo.c`. Wire into `scripts/build-programs.sh`.

**Commit:** `examples(input): evdev_demo — POLLIN-driven kbd + ptr log`

---

### Task C3: Vitest end-to-end

**Files:**
- Create: `host/test/input-evdev-demo.spec.ts`.

Runs `evdev_demo.wasm` under the centralised kernel; drives synthetic
`KeyboardEvent("KeyA")` and `PointerEvent("pointermove", { offsetX:
100, offsetY: 200 })` into the kernel via `kernel_input_event` calls;
asserts the demo's stdout contains `key down: code=30` (KEY_A) and at
least one `ptr abs code=0 value=100` line.

**Commit:** `host(input): vitest — evdev_demo end-to-end`

---

### Task C4: Manual browser verification (the gate)

CLAUDE.md item 6. Build the demo, wire into `examples/browser/pages/
evdev/`. `./run.sh browser`, navigate; click into the canvas (browser
needs focus); type a few keys, move the mouse; watch the on-canvas
log update in real-time. Smooth, no missed keystrokes, pointer move
deltas reasonable. If pointermove is jittery or keys silently
disappear, check the DOM listener target (window vs. canvas — focus
matters) and the `key-code-table.ts` coverage.

**No commit yet for this task — verification only.** If the browser
demo fails but Node + Vitest passes, that's a host-parity bug — PR
#410 cautionary tale (CLAUDE.md "Two hosts" rules).

---

### Task C5: Phase C — final gauntlet + open PR #3

PR title: `[explore-dri] examples(input): evdev_demo + browser spec`

Body: Summary / Why / Verification (gauntlet + browser screenshot of
the on-canvas log with a typed-keystroke + pointer-move record) /
Dual-host parity proof / Notes.

---

## Final coordinated merge

When all three PRs (kernel, host, examples) are reviewed and approved,
and Brandon has signed off on the demo running cleanly in browser +
Node:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 → PR #2's base.
3. Squash-merge PR #2 → PR #3's base.
4. Squash-merge PR #3 → plan 4's `…-kms-demo` (or wherever plan 4's
   tip lives at the time).
5. Tag: `[explore-dri-evdev] milestone (input) merged at <sha>` in
   the next session-handoff doc.

**Do not push to upstream until v1 + plans 2–5 are all merged
upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **Two devices only — `event0` (kbd), `event1` (ptr).** No
  `/dev/input/event2` joystick / touch in v1. SDL2's evdev backend
  enumerates `/dev/input/event*` and uses whatever's there; two
  devices is the minimum useful set. Joystick / touch are post-v1
  (will require browser GamepadAPI / Touch capture, neither of
  which the v1 design budgets).
- **Every open OFD gets every event.** No focus routing. Plan 9's
  wpkcompositor adds the EVIOCGRAB-based focus gate. The v1
  evdev_demo opens one fd so the eavesdropping hazard isn't
  surfaced; security-sensitive deployments must wait for plan 9.
- **`CLOCK_MONOTONIC` timestamps.** Same clock as plan 4's vblank
  events — readers can compare timestamps directly for latency
  profiling. No `EVIOCSCLOCKID` (the only knob Linux exposes here);
  fixing the clock removes a class of footguns (Y2K38, DST, NTP
  skew) and we don't have a `CLOCK_REALTIME` source worth offering
  in the Wasm sandbox anyway.
- **`struct input_event = 24 bytes` on wasm32.** Matches musl's
  64-bit-time_t layout, which matches modern Linux 64-bit
  userland. Userspace `_Static_assert` in C2 locks the
  expectation; kernel-side static-assert in A1 Step 2 locks the
  layout.
- **Ring cap = 1024 records per OFD; oldest dropped on overflow
  with `SYN_DROPPED` marker.** Linux UAPI convention. Userspace
  responds to `SYN_DROPPED` by re-querying `EVIOCG*` state.
- **No `EVIOCSREP` / `EVIOCSCLOCKID` / `EVIOCSKEYCODE` (write
  ioctls).** Keyboard repeat is the browser's job (it sets
  `KeyboardEvent.repeat` via the OS auto-repeat); clock is fixed
  MONOTONIC; the kernel doesn't expose a remappable keymap (locale
  / layout is libxkbcommon's job at plan-8 time).
- **No `/dev/input/mice` or `/dev/input/mouse*` legacy nodes.**
  Those are PS/2 emulation; SDL2 / libinput prefer the modern
  evdev path. Skipping them shaves ~100 LoC of compatibility
  shim.
- **`BUS_VIRTUAL` for `EVIOCGID.bustype`.** Closest match to
  "host-synthesised event source". Linux's `uinput` driver does
  the same.
- **No host imports.** Kernel is consumer, host is producer; the
  control flow is one-way (`kernel_input_event` export only). Plan
  4 layered host imports for KMS because the host needed to be
  notified of state changes (master, addfb, set_fb). Input has no
  state for the host to react to; the host's `InputSource` is a
  self-contained DOM listener.
- **Plan 5 does not join plan 4's `DriOfdState` enum.** Input
  state and DRI state are disjoint; a single `OpenFileDesc.input:
  Option<Box<InputFdState>>` field beats nesting the input state
  under a `DriOfdState::InputEvent { … }` variant. Plan 6 (ALSA)
  will likely follow the same shape — its own
  `Option<Box<AlsaFdState>>` rather than joining DRI's enum.

---

## Risk register

1. **`KeyboardEvent.code` → `KEY_*` table coverage.** The 130-
   entry table in `key-code-table.ts` covers US-ASCII + common
   navigation + function keys; locale-specific keys (e.g., AltGr-
   composed characters, Japanese IME state) are not translated.
   *Mitigation:* document the gap; libxkbcommon at plan-8 time
   handles locale-layer translation independently.
2. **macOS Cmd-key keyup loss.** Browser-level bug: Safari and
   Chrome on macOS don't fire `keyup` for keys held while Cmd is
   pressed. *Mitigation:* on every `keydown` with `metaKey = true`
   that arrives without an intervening `keyup` for the same code,
   emit a synthetic release pair. Document the workaround; not
   strictly correct but matches user expectation.
3. **Pointer lock interaction.** Locked pointer emits `movementX/Y`
   (REL_*); unlocked emits `offsetX/Y` (ABS_*). Apps that mix
   modes (e.g., FPS toggle to menu) see the device-coordinate
   model change underneath them. *Mitigation:* document; emit
   `EV_SYN { code: SYN_REPORT }` on lock-state change to give
   readers a re-sync point. The plan-9 compositor may want to
   layer "logical absolute coords" on top.
4. **Ring overflow under sustained high-rate input.** A
   1000-event/sec mouse drag fills a 1024-record ring in 1
   second; a paused or wedged reader will see SYN_DROPPED.
   *Mitigation:* the bound is correct (24 KiB per OFD, capped
   memory growth); the userspace expectation is "drain on every
   poll wake" which SDL2 / libinput do.
5. **Vertical-wheel quantisation across browsers.** Chromium uses
   `deltaY = ±100` per tick; Firefox uses `±120`; macOS Safari
   uses `±1` (continuous). *Mitigation:* the host emits one
   `REL_WHEEL` per quantum, clamping to ±1 if `deltaMode === 0`
   (PIXEL) and the absolute value is below the tick threshold.
   Document the quantum normalisation in `BrowserInputSource`.
6. **`/dev/input/event*` device-number-vs-class mismatch with
   real Linux.** On real Linux, the kernel-side device order is
   driver-load-dependent; SDL2 enumerates and queries each via
   EVIOCGID. We pin `event0 = kbd, event1 = ptr` by convention.
   *Mitigation:* document; SDL2's enumerate-and-query path works
   correctly because each device's EVIOCGID returns a distinct
   product, so the order doesn't matter to userspace.

---

## What this plan doesn't cover (deferred)

- **Joystick / gamepad** (`/dev/input/js*`, GamepadAPI). v2+.
  Will need a third virtual device + browser GamepadAPI capture.
- **Touch input** (Touch + multi-touch via `ABS_MT_*` codes,
  TouchEvent / PointerEvent type=touch). v2+. The `ABS_MT_*`
  protocol is significantly larger than ABS_X/ABS_Y.
- **`uinput`** (`/dev/uinput`, the userland-pushes-events device).
  v2+. Lower priority; mostly useful for test harnesses and
  accessibility tools we don't ship.
- **Focus routing via EVIOCGRAB.** The kernel records the grab
  but doesn't enforce. Plan 9's wpkcompositor adds the gate.
- **Keymap / layout** (`EVIOCSKEYCODE`, `xkb_keymap`). Plan 8 (Xkb /
  libxkbcommon port) layers locale-aware translation on top of the
  raw KEY_* stream.
- **Auto-repeat tuning** (`EVIOCSREP`). Browser auto-repeat is
  governed by the OS; we don't expose tuning. Plan 9 may surface
  a compositor-level setting if needed.
- **`/dev/input/mice` legacy PS/2 emulation.** Dead protocol; SDL2
  and libinput don't need it.
- **ALSA** (`/dev/snd/*`). Plan 6.
- **SDL2 port** (milestone D, plan 7) — requires plans 3 + 4 + 5 + 6.
- **wpkcompositor** (plans 8-9) — focus routing + keymap.

---

End of plan.
