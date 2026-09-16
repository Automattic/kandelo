# Lane F (fork control-flow inversion) — closure report

Branch `brandonpayton/lane-f-fork-inversion`, worktree
`/Users/brandon/kandelo-lane-f`. Written 2026-09-16 at the maintainer's
direction to treat the lane as closeable.

## What the lane was for

Set aside all fork TypeScript, implement everything possible in the Rust
fork-module, and leave one thin TypeScript layer shared by both JS hosts —
**reducing the host API surface**. The measure the maintainer set was
`forkGuestImportsUnserved`: how many of the 46 fork imports a real instrumented
guest declares are NOT served by the co-resident module.

## The measure is met

`forkGuestImportsUnserved` is **0**. Every one of the guest's 46 fork imports
comes from the module. `buildForkGuestImports` no longer takes a host floor at
all: `ForkGuestHostFloor`, `FORK_GUEST_HOST_FLOOR_NAMES`,
`host/src/fork-guest-host-floor.ts` and `host/src/fork-exception-broker.ts` are
deleted, and a pthread worker supplies nothing for fork exceptions.

`forkAtticImports` is 0 and the attic itself is gone (23,174 lines).
`forkGuestObjectImportsUnserved` is 2 and **that is its target** as of today's
ruling: both remaining imports are the floor, for reasons that were probed
rather than assumed (§199 as corrected by §203).

### The finding worth carrying to the other lanes

The floor went **6 → 4 → 3 → 2 → 1 → 0**, and **not one entry left because a
new WebAssembly capability appeared.** Every floor argument had the shape
*"X cannot do Y, therefore Z must be host"* — every premise true, every
inference wrong:

| entry | the argument | what was actually true |
|---|---|---|
| `encode_funcref`, `table_mutation_commit` | wasm cannot compare two funcrefs | true, and the host only had to answer *that*; the scan moved into a shim |
| `table_state_owned` | the host elects which coordinate owns a table | electing is not answering — seed the answer once |
| `provenance_externref` | provenance must be recorded at the production site | nothing read the recording; what remained was `\|v\| v` |
| `exn_ingress_throw` | it must re-enter wasm with a tagged exception | nothing can mint the token, so it only stated a refusal the module states itself |
| `exn_broker_throw_recipe` | same | **the honest one** — and neither has to *throw*, both can *call* a guest export that throws |
| `__wpk_fork_resume_table` | Rust cannot hold a funcref | true, and holding is not what a *table* needs |

**`therefore` is the load-bearing word, not `cannot`.**

## Four defects found, three fixed

None of these was the thing the lane set out to do; all four came from one
question — *are these two derivations of the same value fed the same inputs at
the same time?*

1. **Two resume-slot allocators diverged (§194).** Same four rules, guarded by a
   test that compared the rules. `dlopen A, dlopen B, dlclose A, dlopen C,
   fork` puts three slots out of step; the guest resumes into another
   activation's thunk — a real function of the right type, so nothing traps.
   Fixed: one allocator, in the module.
2. **An activation with no fork-instrumented function could not `dlclose`
   (§194).** It seeds an empty catalog, holds no slots, and the release path
   read "no entries" as "never registered". The child exited non-zero and the
   parent reported only its own `8`. Fixed.
3. **A second static-root base map filled where nothing looks (§201).** The
   child-install path recomputed a layout `ForkMergedStaticRoots` had already
   settled and published; the module reads the registered one. An unfilled slot
   is a legal `null`, so the child would rebuild a null where a statically
   initialised reference belonged. Fixed, −82 lines.
4. **A third copy of the resume rule in `crates/host-native` (§194 addendum).**
   `let slot = i as u64 + 1;` — correct today only because that host has one
   activation and never unregisters. **Not fixed**, by maintainer decision: it
   goes with the follow-up, which has to validate host-native properly anyway.

## What is gated now

All three guards §191 and §192 recorded as owed are gated, each with the
mutation that proves it (§196, §197). The provenance shim's gate needed a guest
built for the purpose through `scripts/run-wasm-fork-instrument.sh`, because
nothing in the tree calls an externref-returning import *directly* — the
mutation that had passed the entire fork suite now fails on the first call.

## Validation

- **Host suite**: matches its baseline throughout — 64 expected failures,
  nothing new, nothing unbanked. Run after every commit that touched code.
- **Browser**: 18/18 fork specs in Chromium, re-verified after each change to
  the module.
- **Surface budget**: 99 checks pass. One ceiling was RAISED —
  `forkModuleHostImports` 6 → 7 — and it records a true growth discovered late
  rather than growth introduced now. **How it was late is worth reading:** that
  measure reads a hand-maintained constant out of `crates/host-native`, kept
  honest by a Rust test that `suite-baseline.mjs` does not run. Ratchet trusts
  a constant; constant is kept honest by a test; test never runs. A surface
  that measures a copy is only as current as whatever checks the copy. Every
  other movement is a bank with its reason.
- `cargo test -p fork-codec -p fork-module-inject`; `cargo check -p host-native`.

### Conformance — and the gap that had to be closed to claim it

`host/test/suite-baseline.mjs` does **not** cover `tests/posix`, `tests/libc`
or `tests/sortix`: its vitest `include` is `host/test`, `web-libs`,
`packages/registry/*/test`, `tests/package-system` and `examples/dlopen`. Fork
is process lifecycle, which is exactly what the validation contract says not to
stop short of — so a closure report resting on the baseline alone would have
been claiming more than it ran.

Run against this branch:

| suite | result |
|---|---|
| sortix `process` (fork, waitpid, zombies, setpgid, setsid) | **24 / 24 pass** |
| sortix `signal` + `io` | **87 / 87 pass** |
| the four `os-test-local` tests that call `fork()` — epoll fd inheritance, SysV msg/shm/sem across processes | **3 pass, 1 pre-registered XFAIL** |

Those four are the only tests in the conformance trees that fork, found by
grepping for `fork(` rather than by name.

**Provisioning note for whoever repeats this.** `tests/sortix/os-test` is not
checked out in this worktree, and `--init` refuses because the runner had
already written a `build/` directory into the empty submodule path. The suite
reported "Discovered 0 tests" and exited 0 — a green run of nothing. Point
`KANDELO_OS_TEST_DIR` at a populated checkout of the **same commit**
(`7e8f0082ab`) instead; that override exists for precisely this, and the runner
keeps its build output on the repository's own filesystem.

## NOT CLOSEABLE YET — `crates/host-native` (open, 2026-09-16)

`cargo test -p host-native` fails **11 of 68**, every one a fork test, and this
lane caused it. The host suite does not build host-native, which is why it went
unseen for days.

Three fixes landed, each independently correct:

1. **The drive table bound 3 of 16 slots, gated on the guest having a typed-GC
   codec** — so a plain fork bound NOTHING. The module began driving the
   lifecycle slots during this lane (`DRIVE_SLOT_UNWIND_BEGIN` = 10, commit
   b14077b5ba), and eleven tests trapped with `undefined element: out of bounds
   table access` inside `__wpk_fork_unwind_transport_*`. Now every slot the
   module drives is bound, sized to the whole stride, offsets read from
   `fork_codec` rather than copied, required slots failing loudly.
2. **Five guest fork imports were bound by a hand-written list** where the
   module now serves all 46. The first the module actually drove was
   `__wpk_fork_module_state_record_reserve`, from `wpk_fork_module_state_save`:
   *"unknown import ... has not been defined"*, inside a fork that had already
   committed its frames. Now a nameless loop over the artifact's own import
   list binds whatever the module exports and nothing above it has claimed.
3. **The obligation pin said 6; the module needs 7.**
   `__wpk_fork_host_externref_handle` arrived in this lane.

4. **The module's reference-graph builder was never armed.**
   `fm_parent_begin_capture` begins the UNWIND; it does not create the builder,
   and `capture_builder()` refuses to make one lazily unless the capture was
   armed. host-native never called `fm_capture_begin` — the JavaScript hosts
   call it immediately before `parentBeginCapture`. Without it the fork ran to
   completion and the seal answered `EINVAL` with its frames already committed.
5. **The activation template id was never seeded**, which the seal also
   requires. `GuestForkFormat` now carries a SHA-256 over the guest's module
   bytes — matching `computeForkModuleTemplateId` byte for byte — written to a
   scratch page carved beside the GC codec's, with the same "outlives every
   capture" lifetime.

**Where it stands: 12 failures → 8**, 52 → 56 passing. Plain fork, the
no-reference path and vfork-exit all pass. The remaining 8 are the
reference-carrying forks (externref, GC, static root) plus vfork-execve, and
they no longer fail with an errno: the child SPAWNS and then hangs
(`pump timed out after 30s (2 processes)`). That is a child-replay problem,
a different and deeper thing than the five above, and it is where this stops.

**How the last two were found, because guessing had stopped working.** Four
hypotheses in a row each cost a six-minute full-suite run and each was wrong.
The fifth step was to instrument instead: give every fallible step inside
`seal_capture_impl` a DISTINCT errno, rebuild, and run **one** test — which
takes 30 seconds, not 370. It answered `13` on the first try, naming
`capture_builder()` exactly. The instrumentation was reverted immediately and
the artifact verified back to its committed bytes.

### The remaining 8, diagnosed: native reference reconstruction faults

Traced with the same technique — milestone prints, one 30-second test — and
the answer is not where the symptom pointed. The child is fine: it enters,
seeds, replays references and reconstructs, every step. **The PARENT's own
resume traps**, with `wasm 'unreachable' instruction executed` inside
`wpk_fork_resume_start` -> `__wpk_fork_resume_1` -> the guest's own frames.
That is the guest's assertion firing on a reference that did not come back
right, on a host whose reference reconstruction is the fine-grained
`fm_begin_reference_replay` + `fm_build_gc_plan` + `fm_drive_execute`
sequence rather than the coarse `fm_attach_child` the JavaScript hosts use.

**Comparing against a passing test is what found it.** In
`smoke_fork_parent_child` (now green) the resumed guest NEVER RETURNS — it runs
to process exit, which is correct. In the failing tests it returns with an
error. One trace of each, side by side, and the difference is a single line.

### And the reason it looked like a hang

`run_fork_capable_entry`'s `match result` treats a `wasm unreachable` trap as
this host's own exit path — which it legitimately is, because the kernel
commits the exit status and then traps via `kernel_exit`'s `unreachable`. So a
genuine reconstruction fault and a clean process exit arrive as the same value,
and the fault is swallowed: no message, no failure, just a pump that waits 30
seconds for a process that already gave up.

**That is worth fixing on its own**, independent of the reconstruction work: a
host that cannot tell "the guest exited" from "the guest faulted" will hide the
next one of these too. The JavaScript hosts distinguish them because the kernel
records the exit before the trap; host-native has the same information and does
not check it here.

### The root cause class: host-native still runs its OWN capture

`crates/host-native` keeps `NativeReferenceCapture` — its own port of the
reference graph builder, described in its doc comment as "the native port of
`ForkReferenceTransaction`'s node/vector tables". At seal it writes THAT graph
into the arena with

```rust
write_module_state_arena(guest_mem, fm.empty_module_state_root, &accumulated.graph, ...)
```

while the module's own `parent_replay_impl` replays from

```rust
Some(module) => module.module_state.root(),
```

**Two reference graphs and two arena roots.** The module's builder is populated
by the guest through the `__wpk_fork_ref_*` imports the module now serves — the
same imports lane F spent itself moving — and the parent replays from the
module's root. host-native's parallel graph, at a different root, is what it
still believes in. Neither host calls `fm_capture_intern` and friends directly;
the guest does, into the module. So the parent replays a graph host-native
never wrote to, and the guest asserts on the references that are not there.

This is the same "two implementations of one thing" pattern the lane found in
the resume slots and the static-root bases, at the largest scale yet — and the
fix is not another missing call. It is retiring `NativeReferenceCapture` in
favour of the module's builder, which is precisely the full-peer-parity work
ruled OUT of scope when the instruction was "make the 12 pass, nothing more".

**That instruction and this finding now conflict, and the conflict is new
information rather than an excuse.** When the scope was set, neither of us knew
that 8 of the 12 need native reference reconstruction to work at all. The five
fixed above were genuinely bounded; these eight are a subsystem.

The two smaller pieces — the swallowed-fault visibility defect, and the
divergent child protocol (`fm_attach_child` versus the fine-grained sequence)
— are native-host work of their own and neither is a sixth instance of the five
fixed above.

## Still the maintainer's

1. **Provisional ceiling raises.** `docs/surface-budget.json` carries **27**
   `PROVISIONAL RAISE` markers across the whole lane, of which 3 have an
   explicit `RULED` marker from 2026-09-15. **Four are from this session**
   (`forkTypeScript` 887→893, `workerMainTypeScript` 5409→5411,
   `forkPlatformTypeScript` 1629→1631, `forkModuleHostEntries` 58→59), each
   with its reason and what it bought. An earlier report of this said
   "thirteen"; that was a miscount of this session's, corrected here.
2. **The budget-ledger conflict with the parent branch.** A trial merge
   conflicts in exactly two files — `docs/surface-budget.json` and
   `host/test/surface-budget.test.ts` — because both lanes evolved the same
   surfaces. Not merged, per instruction.
3. **`forkModuleHostEntries`' target of 5**, which census 195 argues is
   reachable only by diluting; ~8 is realistic once the follow-up lands.
4. **`workerMainForkTypeScript`'s target of 1200**, labelled a proposal in the
   budget because nobody has built the thing that would reveal the real floor.

## The follow-up

`docs/plans/2026-09-16-fork-admit-activation-brief.md` on the stacked branch
`brandonpayton/lane-f-admit-activation`, cut from this HEAD.
