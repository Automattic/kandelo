# Lane N — native fork reconstruction

Dedicated lane, opened 2026-09-16 by maintainer decision ("native forking
should be dedicated lane") when lane F's closure found the work was a subsystem
rather than a fix.

Branch `brandonpayton/lane-n-native-fork`, cut from
`brandonpayton/lane-f-fork-inversion`. Intended worktree
`/Users/brandon/kandelo-lane-n`.

## Why this is a lane and not a bug

`cargo test -p host-native` fails **8 of 68**, every one a fork test. The cause
is not a missing call. It is that **`crates/host-native` still keeps its own
reference graph**:

```rust
// host-native, at seal:
write_module_state_arena(guest_mem, fm.empty_module_state_root, &accumulated.graph, ...)

// the module, in parent_replay_impl:
Some(module) => module.module_state.root(),
```

`NativeReferenceCapture` is, in its own doc comment, "the native port of
`ForkReferenceTransaction`'s node/vector tables". Meanwhile the module's
builder is populated by the GUEST, through the `__wpk_fork_ref_*` imports lane
F moved into the module. So there are **two reference graphs at two arena
roots**, the parent replays the module's, and host-native believes in its own.
The guest then asserts on references that are not there:

```
wasm 'unreachable' instruction executed
  wpk_fork_resume_start -> __wpk_fork_resume_1 -> <guest frames>
```

This is the same "two implementations of one thing" that lane F found in the
resume-slot allocators (census 194) and the static-root base maps (census 201),
at the largest scale yet — and the resolution is the same shape: **one owner**.
Retiring `NativeReferenceCapture` in favour of the module's builder is the
lane's main work.

## Already done in lane F — do not redo

Five host-native fixes landed there, taking the suite 52/12 to 56/8:

1. **Drive table**: bound 3 of 16 slots and only for typed-GC guests, so a
   plain fork bound nothing. Now every slot the module drives, sized to the
   whole stride, offsets read from `fork_codec`, required slots failing loudly.
2. **Guest fork imports**: a hand-written list of five where the module serves
   all 46. Now a nameless loop over the artifact's own import list, running
   after every conditional wire that has a reason for its exact function.
3. **`EXPECTED_FORK_MODULE_HOST_IMPORT_COUNT`** 6 -> 7
   (`__wpk_fork_host_externref_handle`).
4. **`fm_capture_begin` was never called.** `fm_parent_begin_capture` begins
   the UNWIND; it does not arm the builder.
5. **The activation template id was never seeded.** `GuestForkFormat` now
   carries a SHA-256 over the guest's module bytes, in a scratch page with the
   "outlives every capture" lifetime.

## The work, in dependency order

1. **Retire `NativeReferenceCapture`.** One graph, the module's. This is the
   lane's reason to exist and everything else waits on it.
2. **Stop swallowing guest faults.** `run_fork_capable_entry`'s `match result`
   treats a `wasm unreachable` trap as this host's own exit path — which it
   legitimately is, because the kernel commits the exit status and then traps
   via `kernel_exit`'s `unreachable`. So a reconstruction fault and a clean
   exit arrive as the same value and the fault vanishes into a 30-second pump
   timeout with no message. **This is why a lane-caused regression stayed
   invisible for days.** host-native has the information to tell them apart —
   the kernel recorded the exit — and does not check it here. Worth doing
   FIRST: it makes everything after it visible.
3. **The child protocol.** host-native drives `fm_begin_reference_replay` +
   `fm_build_gc_plan` + `fm_drive_execute` where the JavaScript hosts use the
   coarse `fm_attach_child` — which is where lane F moved the exnref tag gate,
   the drive-plan build and the static-root seeding.
4. **`crates/host-native/src/guest.rs`'s `let slot = i as u64 + 1;`** — a third
   copy of the resume-slot rule, correct today only because this host has one
   activation and never unregisters. Six lines: call `fm_resume_slots` op 0 per
   ordinal. Census 194's addendum has the reasoning.

## How to work on it, learned the expensive way

- **`host/test/suite-baseline.mjs` does not build host-native.** Its vitest
  `include` is `host/test`, `web-libs`, `packages/registry/*/test`,
  `tests/package-system`, `examples/dlopen`. A green host suite says nothing
  about this lane. `cargo test -p host-native` is the gate; `cargo check` is a
  compile check, not a behaviour one.
- **One test is 30 seconds; the suite is 370.** `cargo test -p host-native
  <test_name>` — use it. Four hypotheses were burned at six minutes each before
  anyone noticed.
- **Instrument, do not guess.** Giving every fallible step in
  `seal_capture_impl` a DISTINCT errno found the real cause on the first try
  after four wrong guesses. Revert the instrumentation and verify the artifact
  is back to its committed bytes.
- **Compare against a passing test.** The difference between
  `smoke_fork_parent_child` (green) and the failing ones is one line of trace:
  in the passing case the resumed guest never returns, because it runs to
  process exit. That is what identified the swallowed fault.
- Rebuild the module with `crates/fork-module/build-wasm.sh` and record the
  **build key** per mutation, so "artifact unchanged" is never read as
  "mutation survived".

## The bar this lane is held to

The same one lane F was: never raise a ceiling to make a check pass, perturb
every new guard until it fails, and say what was run rather than what was
implied. The host-runtime contract makes Node, browser and native peers — this
lane is what makes that true for fork.
