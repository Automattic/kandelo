# Lane F (fork control-flow inversion) — closure report

Branch `brandonpayton/lane-f-fork-inversion`, worktree
`/Users/brandon/kandelo-lane-f`. Written 2026-09-16 at the maintainer's
direction to treat the lane as closeable.

**Status: closeable, and validated on both hosts.** The measure is met, the
three owed guards are gated, and the one thing that reopened it —
`crates/host-native` — is repaired here for the damage this lane did and handed
to **Lane J (native fork reconstruction)** for the subsystem underneath, by
maintainer decision.

Node: the host baseline is GREEN (64 expected failures, nothing new, nothing
unbanked, exit 0). Browser: 18/18 Chromium fork specs at `d3099c7c1`. Surface
budget: 99 checks pass.

What remains for the maintainer is listed at the end and is entirely decisions,
not work: three standing provisional ceiling raises, two target restatements,
and one provisioning defect that costs eleven baselined test files. The merge
itself has landed (`3ea310260`) and the re-merge of what followed is clean.

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

- **Host suite**: `host/test/expected-failures.json` lists **64** failing
  files:

      jq '.expectedFailures|length' host/test/expected-failures.json

  An earlier draft of this bullet said the suite matched that baseline
  "throughout". It did not: runs during this lane reported 185 and then 101
  expected failures against earlier baselines, as the lane restored coverage.
  "Throughout" was never one number and is not a claim this doc can support.

  One run late in the lane reported six package tests regressing — `bzip2`,
  `gzip`, `unzip`, `xz`, `zip`, `zstd` — and the account of that in
  `c23de3fa6` was WRONG, in a way worth recording because the corrected
  version is the useful one.

  What that run's error actually said was that BOTH routes to a program
  artifact refused: the `source-only-v1` tier for an absent program projection
  authority, and `local-binaries` as "local mirror targets are not one direct
  immutable local generation". I built a causal chain on the first refusal
  alone — projection retracted, retraction needs a complete build, php blocks
  the build — wrote it into this doc and a commit message, and never tested
  whether clearing the SECOND refusal would fix it.

  It does. A partial `local-build` (41 built, 19 already cached, stopped at
  php) gave `local-binaries` a fresh generation; `programs/wasm32/gzip.wasm`
  now resolves from `local-binaries/.kandelo-local-generations/...` and **all
  six tests pass, with the projection still absent**. The precise semantics of
  the local-generation refusal are NOT established here: what is verified is
  the before, the intervention, and the after.

  The lesson is the cheap one. The failure named two refusals and I acted on
  one without ruling out the other. The final run at
  `56020b54a` is GREEN: "host suite matches its baseline: 64 expected
  failures, nothing new, nothing unbanked", exit 0, 64 failed / 378 passed /
  4 skipped of 446 files.
- **Browser**: 18/18 fork specs in Chromium at `d3099c7c1`, the head carrying
  the staging-slab fix; and at `9bc5309e1` before it, re-verified after each
  change to the module up to that point. **The 18 are these six files**,
  named because "18/18" with no file list is a number nobody can refute:
  `fork-continuation` (5), `vfork-lifecycle` (9),
  `fork-module-worker-instantiation` (1), `funcref-fork-module-worker` (1),
  `gc-reference-cycle-fork-module-worker` (1) and
  `wasm-gc-reference-transport` (1) — the last of which does not have "fork" in
  its name, so a grep for fork specs misses it and lands on 17.

  RE-RUN for `a5e101770`, which changes `host/src/fork-module-backend.ts` —
  shared host TypeScript the browser kernel worker loads, not module-only, so
  the host-runtime parity contract makes it a cross-host change. **18 passed,
  exit 0, 2.0 minutes**, Chromium, at `d3099c7c1`. Playwright's own
  "Running 18 tests using 6 workers" confirms the six-file set above IS the 18,
  independently of counting `test(` calls.

  **What that establishes and what it does not.** It is PARITY evidence: the
  browser fork paths still work with the changed file. It is not evidence that
  the REWIND is exercised there — the rewind only matters across multiple forks
  in one worker, and what these specs' programs do inside the kernel was not
  established. The rewind itself is verified on the Node side by
  `host/test/fork-module-staging-rewind.test.ts`, which asserts an identical
  staging address across 32 forks and fails under both perturbations. Saying
  "18/18 green" without that distinction would claim the browser proved
  something it was not asked to.
- **Surface budget**: 99 checks pass. TWO ceilings were RAISED. The second is
  `forkTypeScript` 886 → 890, four lines for the staging-slab rewind (census
  204), taken after a check for something to bank found every method in
  `fork-module-*.ts` still has a caller. The first is
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

Run at `9bc5309e1`, the lane head before the staging-slab fix. Pinned to a
commit rather than "this branch", because the lane head has moved since and one
of the commits that moved it (`a5e101770`) changes fork host code these suites
exercise. Nobody
re-ran them; treat the table as evidence about `9bc5309e1` and re-run if that
distinction matters to you.

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

## `crates/host-native` — five fixes here, the rest is Lane N

**Maintainer decision, 2026-09-16: "native forking should be dedicated lane."**
Lane F repairs what it broke; the subsystem underneath goes to
`docs/plans/2026-09-16-lane-n-native-fork.md`.

`cargo test -p host-native` was **52 passed / 12 failed**, every failure a fork
test, and this lane caused it. The host suite does not build host-native, which
is why it went unseen. It is **56 passed / 8 failed / 4 ignored of 68** now.

Re-measured at `56020b54a` rather than quoted:
`cargo test -p host-native --target aarch64-apple-darwin`, 286s, exit 101.
**The `--target` is not optional** — `.cargo/config.toml` sets
`[build] target = "wasm32-unknown-unknown"` repo-wide, so the bare command
fails to build `errno`/`zstd-sys`, runs ZERO tests and exits 101 behind a wall
of `cargo:warning=` lines. Lane N's charter now carries that trap.

An earlier draft of this section said "fails **11 of 68**" directly beneath the
line above, contradicting it. That was a stale paragraph left behind by an
edit, not a second measurement, and it is deleted. Note also that 56 + 8 is 64,
not 68: four tests are `ignored`, which is what makes the two figures look
irreconcilable at a glance.

Five fixes landed, each independently correct:

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

### Why the remaining 8 became their own lane

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

When the scope was set to "make the 12 pass, nothing more", neither of us knew
that 8 of the 12 need native reference reconstruction to work at all. The five
fixed here were genuinely bounded; these eight are a subsystem, and the
maintainer opened **Lane J (native fork reconstruction)** for them.

Lane N also carries the two smaller pieces this trace turned up: the
swallowed-fault visibility defect — which is why a lane-caused regression
stayed invisible for days, and which that lane should fix FIRST because it
makes everything after it visible — and the divergent child protocol
(`fm_attach_child` versus the fine-grained sequence). Its charter has the full
account, what is already done here so it is not redone, and the working method
that found all of this.

## Still the maintainer's

1. **Provisional ceiling raises.** `docs/surface-budget.json` carries **44**
   provisional markers across the whole lane — 37 reading `PROVISIONAL RAISE`
   and 7 reading `PROVISIONALLY` — of which 3 carry an explicit `RULED` marker
   from 2026-09-15. Counted with
   `grep -o 'PROVISIONAL RAISE' docs/surface-budget.json | wc -l` and the same
   for the other two words; the command is written down so the next reader can
   refute the number in one step instead of trusting it.

   Earlier versions of this line said "thirteen" and then "27". The first was a
   miscount of this session's raises. The second was simply wrong when written
   and was not stale: the literal count was 37 before this session's last three
   commits and 37 after. **Five are from this session**, each with its reason
   and what it bought.

   Read them by where the surface NOW STANDS, not by the delta taken, because
   later banks in the same session repaid three of them:

   | Surface | Raise taken | Ceiling now | Target | Standing? |
   |---|---|---|---|---|
   | `forkTypeScript` | 886 → 890 | 890 | 484 | **yes** — the staging-slab rewind, census 204, in the closing commit |
   | `forkPlatformTypeScript` | 1629 → 1631 | 1631 | 500 | **yes** |
   | `forkModuleHostImports` | 6 → 7 | 7 | 7 | **yes** — and the target was restated to meet it |
   | `workerMainTypeScript` | 5409 → 5411 | 5356 | 5356 | no — repaid, and then some |
   | `forkModuleHostEntries` | 58 → 59 | 58 | 5 | no — repaid |

   So three raises are actually awaiting a ruling. The other two were taken and
   given back within the session; they are listed only so the `PROVISIONAL`
   markers in the ledger are not read as five outstanding debts.
2. **The merge LANDED, and the re-merge is clean. Nothing to resolve.**
   `3ea310260` ("Merge lane F: the fork host floor reaches zero") is an
   ancestor of `brandonpayton/rust-first-abi44-reconcile`, so the five-file /
   18-hunk ledger conflict this item used to describe is resolved and in. Only
   the B50 commits remain to come across, and `git merge-tree --write-tree`
   reports a CLEAN merge (exit 0, no conflicted paths) at
   `brandonpayton/rust-first-abi44-reconcile` head `41b5f2f0a`.

   This item previously said "two files", then "five files, 18 hunks", and now
   says none. Every one of those was true when measured and false when read.
   The number is not the thing to carry away; the command is:

       git merge-tree --write-tree --name-only \
         brandonpayton/rust-first-abi44-reconcile \
         brandonpayton/lane-f-fork-inversion

   It resolves nothing in the working tree, so it is safe to run before every
   statement anyone makes about this merge, and cheap enough that there is no
   excuse for quoting a remembered figure instead.

3. **`forkModuleHostEntries`' target of 5**, which census 195 argues is
   reachable only by diluting; ~8 is realistic once the follow-up lands.
4. **`workerMainForkTypeScript`'s target of 1200**, labelled a proposal in the
   budget because nobody has built the thing that would reveal the real floor.
5. **RULED 2026-09-17 and FIXED in `edbc3000a`.** The maintainer's ruling was
   "can we just fix this for every package by fixing at a shared layer?" — and
   yes: the wrapper IS the shared layer, every package's pkg-config goes
   through it, so there was no per-package fix to make. `build-php.sh` was
   already correct; the wrapper was discarding the paths it handed over.

   `buildPkgConfigEnv` now keeps a path when it is listed in
   `WASM_POSIX_DEP_PKG_CONFIG_PATH` — which `build_deps.rs:13809` sets on every
   build script's environment to the pkgconfig directory of each dependency the
   resolver installed. Provenance instead of spelling. The name test stays for
   callers outside a resolver-driven build, and a `/nix/store/...` path the
   resolver did not install is still dropped.

   **Verified end-to-end through the wrapper on PATH**, which is stronger than
   what `edbc3000a`'s own message claims (it recorded only a `node
   --experimental-strip-types` import of `buildPkgConfigEnv`, because the sdk
   package has no `node_modules` here and its vitest cannot start). Same icu
   directory, same lane cache path that defeated it before:

       PKG_CONFIG_PATH=<lane icu>/lib/pkgconfig \
         wasm32posix-pkg-config --exists icu-uc            -> exit 1

       PKG_CONFIG_PATH=<same> WASM_POSIX_DEP_PKG_CONFIG_PATH=<same> \
         wasm32posix-pkg-config --exists icu-uc            -> exit 0

   That is the shipped path — the `sdk/bin` shim execing the TypeScript — and
   the resolver sets that variable on every build script's environment, so
   php's configure sees exit 0 where it saw `No package 'icu-uc' found`.

   One assumption this rests on, checked rather than assumed: the match is by
   exact string, and canonicalization cannot change these paths because no
   component of the cache root is a symlink (`realpath == literal`).

   **Census 90 is now fully superseded.** It recorded TWO packages that could
   not build in this worktree: `php` (this defect) and `coreutils-docs` (the
   cold-cache kernel-boot blocker), with twelve more blocked behind them. In
   the 2026-09-17 validating run `coreutils-docs/wasm32` SUCCEEDED — fixed
   independently somewhere along the way — and php is what `edbc3000a`
   addresses. Both halves of that entry are closed, which is worth stating
   because the entry was still being cited as current this week.

   **Two things that fix cost, both worth knowing.** Changing `sdk/src`
   invalidates every package's cache key (it is a declared input), so the
   validating run is a FULL rebuild, not an incremental one. And there are TWO
   implementations of this filter: `sdk/bin/wasm32posix-pkg-config` shims to the
   TypeScript that actually runs, while `sdk/kandelo/bin/wasm32posix-pkg-config`
   is a separate bash `case` with the same rule that does NOT run here. This
   defect was diagnosed against the bash copy; only measuring the behaviour
   rather than reading it kept the fix out of a file nothing executes.

   **Which copy is authoritative is no longer open — I checked.**
   `sdk/kandelo/bin/wasm32posix-pkg-config` has NO caller: `sdk/package.json`'s
   `files` list is `activate.sh, bin, config.site, glue, src, sysroot,
   sysroot64`, so `kandelo/` is not published; `command -v` resolves to
   `sdk/bin/`, which shims to the TypeScript; and the only references to
   `kandelo/bin/` anywhere are two SDK tests (`cc.test.ts`,
   `native-cc.test.ts`) pointing at `wasm32posix-cc`, a DIFFERENT binary. The
   surrounding tree is live; this file in it is not.

   It now carries the OLD rule, so it is a trap for the next person who greps
   for the filter — exactly the trap I fell into. Recommend deleting it. Not
   deleted here: it is another owner's file, and removing it is a decision
   rather than a fix.

   The original analysis is kept below because the chain it describes is what
   made the defect invisible, and because an earlier version of this item (and
   commit `c23de3fa6`) got the scope wrong in both directions.

   **Known symptom, new reason.** Census §90 already recorded, earlier in this
   same lane, that `php` cannot find icu in this worktree, that packages were
   blocked behind it, and that the projection never materialised. It even gave
   a narrow command (`local-build run ... --product kernel`) that refreshes the
   co-resident side modules without touching the failing package. What §90 did
   NOT have is WHY php cannot find icu, and that is the part worth keeping:

   `sdk/kandelo/bin/wasm32posix-pkg-config` filters `PKG_CONFIG_PATH` to a
   `kandelo` namespace — deliberately, per `sdk/test/pkg-config.test.ts`, so a
   Nix shell's host `.pc` paths cannot make libcurl link host openssl. It
   matches the path SEGMENT `kandelo`. The lane's prescribed cache root is
   `/Users/brandon/.cache/kandelo-lane-f/source-only`, whose segment is
   `kandelo-lane-f`, so nothing matches and `configure` gets an empty
   `PKG_CONFIG_PATH` although the icu artifact is complete and all three `.pc`
   files sit exactly where `build-php.sh` points.

   **Confirmed end-to-end, not by reading the glob.** Point `PKG_CONFIG_PATH`
   at the real icu pkgconfig directory and ask the wrapper for the package;
   then point it at a SYMLINK to that same directory whose path carries a
   literal `kandelo` segment, and ask again:

       PKG_CONFIG_PATH=<lane cache>/...icu.../lib/pkgconfig \
         wasm32posix-pkg-config --exists icu-uc   -> exit 1

       PKG_CONFIG_PATH=/tmp/.../kandelo/pkgconfig \
         wasm32posix-pkg-config --exists icu-uc   -> exit 0

   Same directory, same three `.pc` files, same contents. The only difference
   is how the path is spelled, which is the whole claim. (Read the exit code
   directly: piping this through `tail` reports the pipe's status and says 0
   for both.)

   **What it blocks, measured.** `php/wasm32` is the ONLY package that fails a
   full `local-build` here; it blocks six php-dependent nodes (`wordpress`,
   `lamp`, `nginx-php-vfs` and three browser products). §90's second failing
   package, `coreutils-docs`, no longer fails — that part of §90 is itself
   stale. An incomplete build cannot republish the source-only program
   projection authority, because `package_projection_is_eligible` requires
   every selected package node to have succeeded.

   **What fixing it would buy, measured.** Eleven of the 64 baselined expected
   failures are php-dependent — the `php/*` tests plus `nginx`, and the
   `wordpress` suite, which the final run shows as `(0 test)` files. That is
   the real cost of this defect and the real return on closing it: eleven test
   files come back. It is a better number to weigh a remedy against than "the
   suite is red".

   **What it does NOT block, contrary to what this doc first said.** The six
   compression package tests. See the Validation section: the six that
   regressed did so because BOTH program-serving routes refused at that moment,
   and a partial rebuild restored one of them. They pass with the projection
   still absent, and the final suite run is green.

   Two remedies, and the choice is a judgment about the filter's threat model:

   - **Move the cache root** under a `kandelo` segment. No code change;
     satisfies the rule as written. But the lane cache roots are a standing
     instruction, so changing them is yours.
   - **Widen the allowlist** to `*/kandelo*/*`, which also admits
     `/tmp/kandelo-evil/`. Whether that is acceptable is a question about what
     the filter defends against, which `pkg-config.test.ts` answers only for
     the Nix-store case.
   - **A third option, more precise than either, and UNTESTED — I have neither
     implemented nor run it.** The resolver already publishes the right answer:
     `WASM_POSIX_DEP_PKG_CONFIG_PATH`, documented in
     `tools/xtask/src/build_deps.rs` as "a colon-joined list of every"
     dependency's pkgconfig directory, and exported to build scripts as a
     reserved resolver variable. The wrapper could allowlist exactly the
     entries in that variable when it is set: that admits precisely what the
     resolver handed this build and nothing else — no `kandelo` spelling rule,
     and no `/tmp/kandelo-evil/`.

     Two things to check before believing it. Exactly ONE package consumes the
     variable today (`libxml2`); `php` hand-composes `DEP_PKG_CONFIG_PATH` from
     each `$X_PREFIX/lib/pkgconfig` instead, so php would need to use it — and
     using it ALONE fixes nothing, because those are the same cache-root paths
     the filter already rejects. The change has to be at the wrapper. I am
     recording the option rather than taking it because it is SDK code whose
     tests encode a threat model I should not reinterpret.

   Recorded rather than fixed: outside this lane, the filter is
   security-shaped, and its tests encode intent I should not overrule.

   **Its cost is higher than "eleven test files".** While php cannot build, the
   source-only projection cannot republish, and the engine's side-module
   freshness check returns `Ok(())` on a missing manifest BY DESIGN. So one of
   the two checks over the module every fork depends on is switched off for as
   long as this stands. See "The pkg-config defect and B50 are the same story".

6. **The same tier shadowing is LIVE in two sibling modules, and the fix is
   three other subsystems' build scripts.** `dylink_module32` and
   `wasm_artifact_module32` are served from `source-only-v1` copies dated
   Sep 13 while this tree built new ones on Sep 16 — the wasm-artifact one 103
   bytes shorter. Export surfaces are identical, so nothing hits a missing
   symbol; it is behavioural drift, not an outage. Three options and the
   measurements are in "The same shadowing is LIVE in two sibling modules".
   Listed HERE because a decision that lives only in a section below the
   decision list is a decision nobody makes.

## The follow-up

`docs/plans/2026-09-16-fork-admit-activation-brief.md` on the stacked branch
`brandonpayton/lane-f-admit-activation`, cut from this HEAD.

## If B50 recurs: the three-command triage

Recorded here rather than in `docs/plans/2026-09-11-MASTER-PLAN.md` on purpose.
The parent has 11,026 lines in that file this branch does not, and the re-merge
is currently CLEAN; editing it from here would manufacture a large conflict to
deliver a paragraph. Copy this across if it is worth keeping.

**1. Objdump the file the host loads, not the obvious one.**

    cd host && npx tsx -e \
      'import("./src/binary-resolver.ts").then(m =>
         console.log(m.resolveBinary("fork_module32.wasm")))'

Run as written; it prints the path. `node -e` does NOT work here — plain node
cannot import a `.ts` module and dies with a stack trace, which is how this
line first shipped. Every command in this section was executed before being
written down, because an un-runnable diagnostic is worse than none: it costs
the reader time and teaches them to distrust the rest.

`resolveBinary` searches `local-binaries/source-only-v1/` FIRST, ahead of
`local-binaries/` and `host/wasm/`. B50's brief objdumps `host/wasm/…`, which
is the third choice. I perturbed that copy to prove this branch's new guards
and watched all three assertions SURVIVE, because nothing reads it.

**2. Ask whether the copies disagree.**

    bash crates/fork-module/build-wasm.sh --verify-fresh

As of `a655ad4d4` this compares the source-only copy against the stamped one
and fails naming which wins. Before that commit it checked only the stamped
copy, so a stale module one tier up passed freshness while being the module
both hosts load — which is the shape B50 has.

**3. Ask whether the SOURCE can even produce the bad module.**

    git worktree add --detach /tmp/probe <the-merge-sha>
    cd /tmp/probe && bash scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh
    bash scripts/dev-shell.sh bash -c \
      'wasm-objdump -j Import -x host/wasm/fork_module32.wasm | grep -i table'

Done for `3ea310260`: it produces a CORRECT module — three table imports
including `__wpk_fork_drive_table`, and `dylink` `tableSize 2`. A build from
the merged source does not reproduce the defect, which is why this branch ships
detection rather than a repair.

**What the brief's hypothesis turned out to be.** `body.table_size(catalog)` at
`fork-module-inject/src/main.rs:635` and `:740` emits a runtime `table.size`
INSTRUCTION inside generated catalog-scan loops. The injector never writes the
`dylink` section — one doc comment mentions it, to say it is preserved across
the round trip. That number comes from wasm-ld.

## The pkg-config defect and B50 are the same story

Reported for most of a day as two unrelated things. They are one chain, and
each link below was read or run, not inferred.

1. **`php/wasm32` cannot build here**, because the SDK's pkg-config wrapper
   allowlists a literal `kandelo` path segment and this lane's cache root is
   `kandelo-lane-f`. Demonstrated by exit code against the same directory
   under two spellings.
2. **So the source-only program projection never republishes.**
   `package_projection_is_eligible` requires EVERY selected package node to
   have succeeded; php has not, so `local_build` retracts rather than
   finalizes. `local-binaries/source-only-v1/.kandelo/source-only-program-
   projection-v1.json` is absent in this worktree.
3. **So the engine's side-module freshness check passes vacuously.**
   `verify_fresh_coresident_side_modules` (`tools/xtask/src/local_build.rs`)
   exists precisely to catch a fork module whose staged bytes disagree with
   what the projection declares -- its own comment describes the boot 500
   ("member size is X, expected Y") it was written for. It returns `Ok(())`
   when the manifest is missing, by design, "mirroring the kernel check's
   'not projected yet -> Ok' semantics". A missing manifest is not a
   staleness error, so with php broken this check has nothing to compare and
   says green.

   That behaviour is DELIBERATE and pinned: `l5_ok_when_no_projection_manifest
   _exists` asserts "absent projection manifest must not fail freshness". So it
   is not a bug to be quietly tightened -- a tree that has never projected is a
   legitimate state. The defect is that nothing else covered the gap while it
   applied. And the check is live, not dead code: it is called at
   `local_build.rs:968`, after the kernel artifact checks.
4. **And `resolveBinary` still serves the tier-root copy**,
   `local-binaries/source-only-v1/fork_module32.wasm`, ahead of
   `local-binaries/` and `host/wasm/`. That file is not a projected member;
   it is the tier root.

Put together: the copy both hosts load had NO validator. The projection check
was disabled by php, and `build-wasm.sh --verify-fresh` checked only the
`local-binaries/` copy it stamps. That is the whole of "nothing caught it",
and it is why B50 reached a kernel boot rather than a test.

`a655ad4d4` closes it without depending on the manifest -- it compares the two
files' bytes, so it holds whether or not a projection exists. That independence
matters, because the manifest stays missing until the pkg-config decision in
item 5 is made.

**It is not a new invariant, which is why it cannot fail spuriously.** The
projection engine ALREADY requires byte equality between the two:
`coresident_side_module_projection_is_current` reads
`local-binaries/<name>` and `<output_root>/<name>` and accepts only
`source == projected`. So a projected tree has them identical by construction.
The commit enforces at freshness-check time what the projection enforces at
projection time -- the same rule, moved earlier, to a moment that still happens
when the projection cannot.

**What this changes about item 5.** Its cost was reported as eleven baselined
test files. Add to that: while it stands, one of the two freshness checks over
the module every fork depends on is switched off.

## The same shadowing is LIVE in two sibling modules — RESOLVED

> **RESOLVED 2026-09-17 by `b26ca3240c`.** One shared helper
> (`scripts/lib/side-module-tier.sh`) stages and checks the tier copy, and all
> four co-resident scripts call it. Each call site was perturbed separately --
> append a byte to that module's tier copy, run that module's `--verify-fresh`
> -- and all four failed naming their OWN label and file pair, which is what
> distinguishes "the shared function works" from "this call site passes the
> right arguments". See "The tier guard, perturbed at all four call sites".
>
> **One claim below is also wrong as stated.** `resolveBinary` does NOT
> reliably serve the `source-only-v1` copy: measured twice in one session, it
> returned `local-binaries/` after a hand-staged `build-wasm.sh` and the tier
> copy after `./run.sh setup` republished the projection. The hazard is real;
> which copy wins is not fixed. See `bd63c6203`.


Found by measuring rather than reasoning, in this worktree, today. Reported
rather than fixed, because `dylink`, `wasi` and `wasm-artifact` are not this
lane's subsystems and four more build scripts is not a change to make
unilaterally.

`resolveBinary` serves the `local-binaries/source-only-v1/` copy for every
co-resident side module, not just the fork one:

    dylink_module32.wasm        -> local-binaries/source-only-v1/dylink_module32.wasm
    wasm_artifact_module32.wasm -> local-binaries/source-only-v1/wasm_artifact_module32.wasm
    wasi_module32.wasm          -> local-binaries/source-only-v1/wasi_module32.wasm

And right now two of those tier copies DISAGREE with the freshly built ones.
The dates are the point: the built copies are from this worktree's
`local-build` on Sep 16, the tier copies are from Sep 13.

    dylink_module32         built  371318 B  Sep 16 16:35
                            tier   371318 B  Sep 13 11:16   differ @ byte 1389
    wasm_artifact_module32  built  138622 B  Sep 16 16:35
                            tier   138519 B  Sep 13 11:16   differ @ byte 133
                                                            AND 103 BYTES SHORTER
    wasi_module32           agree
    sffs_module32           no tier copy
    fork_module32           both   249234 B  Sep 16 22:25   identical

`wasm_artifact_module32` is the one to look at first: a 103-byte size
difference is not a build id or an embedded timestamp, it is different code,
and the host loads the shorter three-day-old one. The fork module agrees only
because `a655ad4d4`'s rebuild staged all three tiers — which is what the other
four scripts do not do.

So the host currently loads a dylink module and a wasm-artifact module that are
not the ones this tree's build produced. **Nothing detects it.** Their
`crates/*/build-wasm.sh --verify-fresh` scripts mention `source-only-v1` ZERO
times (`grep -c`: dylink 0, sffs 0, wasi 0, wasm-artifact 0; fork-module 6
after `a655ad4d4`), and the engine's projection check is vacuous while the
manifest is missing — which it is, because php cannot build.

That is B50's mechanism exactly, in two more modules, sitting there now.

**A FULL REBUILD DOES NOT CLEAR IT — measured 2026-09-17.** The pkg-config fix
invalidated every package's cache key, so the validating run rebuilt the whole
set from zero cached. Afterwards:

    fork_module32           all three copies agree (8d5c6052)
    dylink_module32         still DIFFER (a54ab0c3 vs 65527ea7)
    wasm_artifact_module32  still DIFFER (e5e88698 vs d6a35fef)

All five co-resident artifacts, after that rebuild:

    fork_module32           agree     (its script stages every tier)
    fork_module64           agree     (same)
    wasi_module32           agree     -- NEITHER COPY HAS CHANGED since
                                         Sep 12 05:21; it has not been rebuilt
    dylink_module32         DIFFER    -- built Sep 16 16:35, tier Sep 13 11:16
    wasm_artifact_module32  DIFFER    -- built Sep 16 16:35, tier Sep 13 11:16

The dates give the rule, and it is not luck — an earlier draft of this section
said "by luck" before checking them, which was wrong in the direction that
UNDERSTATES the problem. **The tier copy goes stale exactly when the module is
rebuilt.** `wasi` agrees because nothing has touched it since Sep 12; it will
diverge the first time anything in its closure changes. So the gap is a
certainty for all three unprotected artifacts, not a coincidence that happens
to have caught two.

Byte-identical hashes to before the rebuild. The siblings' artifacts WERE
rebuilt into `local-binaries/`; the Sep 13 copies in the tier — the ones
`resolveBinary` serves — were never touched, because nothing stages there. The
fork module agrees only because its script does.

This settles the shape of the fix rather than leaving it a judgment call: a
check WITHOUT the staging would be a rejection nobody can clear. `--verify-fresh`
would fail, the operator would rebuild exactly as instructed, and it would fail
again identically.

**They are already ONE SET in the engine, which points at one of the three
options.** `CORESIDENT_SIDE_MODULES` (`tools/xtask/src/local_build.rs`) lists
five artifacts across four modules — `dylink_module32`, `wasi_module32`,
`wasm_artifact_module32`, and `fork_module32`/`64`. So
`verify_fresh_coresident_side_modules` already iterates all of them, and
`coresident_side_module_projection_is_current` already requires
`source == projected` for all of them. The gap is not that the siblings are a
different class; it is that BOTH of those live behind the projection manifest,
and only `fork-module/build-wasm.sh` grew a manifest-free check. That makes
"hoist it into one shared helper the scripts call" the option that matches how
the engine already models these, rather than five copies of ten lines.

(Read that constant with `awk '/CORESIDENT_SIDE_MODULES.*=/,/^\];/'`, not
`grep -A<n>`: a fixed window cuts the table off partway and I twice concluded
the siblings were excluded from it, which is the opposite of true.)

**The ask.** The fix is the same ten lines `a655ad4d4` added to the fork
module's script: compare the tier copy against the stamped artifact and fail
naming which wins. Cost is small and the invariant is already the projection
engine's own (`coresident_side_module_projection_is_current` accepts only
`source == projected`). But it touches three other subsystems' build scripts,
so it is the maintainer's call, not mine. Options as I see them: extend the
check to all five scripts; hoist it into one shared helper the scripts call;
or leave it and rely on the projection once php is fixed — which accepts that
the check stays off in every worktree where a package build is broken.

**Narrowed, after measuring rather than leaving it open.** The EXPORT SURFACES
are identical in both cases — `wasm_artifact_module32` exports the same 12
symbols in both copies, `dylink_module32` the same 42. So the sharp failure the
staging comment warns about, where "the export existed in two tiers and the
call resolved the third, so it read `undefined`", is NOT what is happening
here. Nothing will hit a missing symbol.

That lowers the severity from what an earlier draft of this section implied.
What remains is behavioural drift: two modules with identical APIs and
different internals, where the host runs the older one. Worth fixing, not worth
alarm.

**What I still did not establish.** Which copy is correct in each case, and
whether the drift changes any observable behaviour. I compared sizes, first
differing offsets, dates and export surfaces; I did not diff the code sections
or boot anything.

## 2026-09-17: the chain resolved, and a fork defect it was hiding

`./run.sh local-build`: **`Local build succeeded`, 98/98 nodes, Products
7/7, zero failed, zero blocked.** The source-only program projection
manifest is published again (524 KB) after being absent for this whole
session, so `verify_fresh_coresident_side_modules` is live rather than
vacuous. All five co-resident artifacts agree across tiers.

Five links, each measured rather than argued:

1. **The pkg-config filter rejected the resolver's own dependency
   paths.** It decided membership by spelling (`includes('kandelo/')`)
   and every per-worktree cache root is `kandelo-lane-f`. Fixed at the
   shared layer per the maintainer's ruling (`edbc3000a`): the wrapper
   now keeps a path the resolver listed in
   `WASM_POSIX_DEP_PKG_CONFIG_PATH`. One place, every package.
2. **php could not build, so `wordpress` and `lamp` were BLOCKED** and
   had never actually run in this worktree.
3. **When they finally ran they hit a fork defect that was mine.**
   `fm_set_identity_group` stores one entry per catalog export across
   every activation in a static capped at **512**; php needs **7,684**
   (`intl.so` alone is 4,129). Every php fork died with
   `errno 7` / E2BIG. Fixed to 16,384 with the counts recorded and a
   capacity guard (`9b13064204`).
4. **The projection could not republish** while any package node failed,
   which left the check over the module both hosts load switched off.
   Publishing it again is the visible end of that.
5. **Two co-resident modules had drifted stale** in that window, and a
   full 86-node rebuild did not repair them because nothing staged to
   the tier. The shared helper fixes staging and checking together
   (`b26ca3240c`).

**What this says about the earlier B50 work.** The guard added in
`b061db4dc` instantiates the shipped module in the gating suite, and
`a655ad4d4` made `verify-fresh` check the copy `resolveBinary` actually
returns. Neither would have caught the E2BIG defect -- that needed a
real program to fork -- which is the honest limit of artifact-level
guards, and why `fork-identity-capacity.test.ts` counts a real program's
exports instead.

**A reporting failure worth recording.** Throughout the 31-minute build
that exposed items 3-5, I reported "zero failures" from
`grep -cE '^FAILED [a-z]'`. The engine's tally format is
`FAILED · CONTINUING |`, so that matcher could never match. The build had
failed. Same class as [[gate-on-exit-codes-not-greps]], on a run whose
verdict I had already been told to read from the tool's own summary.

## The identity table: why mmap-backed growth was built and then reverted

The maintainer ruled "build mmap-backed growth" for the identity table, on my
framing that 16,384 is still a static and the count scales with the guest's
module set. I built it, and the build disproved the framing. Reverted, with the
evidence here, because the decision should be remade on what is now known.

**The static IS host-allocated memory.** `instantiateForkModule` computes
`staticBytes = alignUp(info.memorySize, info.memoryAlign)` from the module's
own `dylink` record and reserves the whole region in one `reserve(regionBytes)`
call. Growing `GLOBAL_IDENTITY_MAX` grows `info.memorySize`, and the host
reserves the larger region automatically -- which is why 512 -> 16,384 needed no
syscall and no host change. "Static" and "host-allocated" are not opposites
here; the static is the host allocation. My argument for mmap rested on treating
them as opposites.

**The spill is unreachable for every program this repo builds.** php with its
full extension set needs 7,684 identities, comfortably under the 16,384 inline
tier. So the mmap path would be dead code today, and dead code in a fork path is
only exercised in production.

**And it makes identity publishing BLOCK.** `channel_mmap` goes through
`channel_syscall`, which ends in

    while wasm_intr::memory_atomic_wait32(status_ptr, CH_PENDING, -1) == 0 {}

-- an untimed wait for a kernel worker to clear the status. Identities are
published during INSTANTIATION, so this would add a kernel round-trip to module
setup, turning a memory write into a rendezvous. A stalled kernel becomes a
stalled instantiation.

**It also cannot be tested where the module is tested.** Every fork-module unit
test drives a bare `WebAssembly.Memory` with no kernel behind the channel, so a
test that reaches the spill parks forever rather than failing. Mine did: 0% CPU,
killed after ten minutes. A guard that cannot run is worse than a stated bound.

**Where that leaves it.** `9b13064204` stands: 16,384 with the per-artifact
counts recorded, plus `fork-identity-capacity.test.ts`, which fails naming the
real number when a program's export count approaches the bound. That is a static
with a derivation and an alarm, not a magic number.

If the bound genuinely needs to grow later, the option that avoids every problem
above is a HOST-RESERVED identity region: add it to the layout in
`fork-module-instance.ts` (which already carves static, shadow stack and staging
slab) and seed its base through a module entry. No syscall, no blocking, sized
by the host -- which can count catalog exports before publishing. The cost is one
new `fm_*` entry, and `forkModuleHostEntries` is a budgeted surface, so it is a
raise to argue rather than take.

### The revert left a stale artifact, and the freshness check caught it

Worth recording because it is the first time this lane's own machinery caught
this lane's own mistake, unprompted.

Reverting the spill with `git checkout -- crates/fork-module/src/lib.rs`
restored the SOURCE and left the built artifact alone. `local-binaries/` still
held a `fork_module32.wasm` compiled from the mmap source, stamped with that
source's closure key. Nothing in the working tree looked wrong: `git status`
was clean, every unit test passed, and the wasm was a real, valid, recently
built module. It was simply built from code that no longer existed.

`./run.sh setup` refused it at projection finalization:

    source-only program authority: finalization failed: co-resident side
    module fork_module32.wasm is stale (build-key 3eb1a...)

and rebuilding from the reverted source moved the key to `5bd1ca79...`, which
is the whole proof: the key is a function of the source closure, so a changed
key means changed inputs and an unchanged key would have meant the check was
not measuring anything.

Two things follow. First, `git checkout --` is a build-invalidating operation
and does not act like one -- it is the one way to change a build input that
leaves no trace in the status output an agent habitually reads. Second, this is
exactly the failure class the lane was sent to fix, arriving by a route nobody
designed for: not a stale COMMIT, but a stale revert. The check did not care
about the distinction, which is the argument for keying on the closure rather
than on any notion of what the developer meant to do.

### Which check caught it, and why the vacuous one is not a hole

WHICH check fired matters, because the two are easy to mistake for redundant.

It was NOT `verify_fresh_coresident_side_modules`. That one reads
`local-binaries/source-only-v1/.kandelo/source-only-program-projection-v1.json`
and returns `Ok(())` when the file is absent -- a behaviour pinned by
`l5_ok_when_no_projection_manifest_exists`. The manifest WAS absent here
(verified directly; an earlier `find` of mine used a pattern that could not
match that filename, which is a false negative rather than evidence). So that
check passed without examining anything.

It was the projection FINALIZER, at publish time.

That division is correct, and this run is the evidence. The freshness check
answers "does what has been PROJECTED still agree with source?" -- when nothing
is projected there is genuinely nothing to disagree, so `Ok(())` is the true
answer, not a skipped test. The finalizer answers the different question "is
what I am ABOUT TO PUBLISH fresh?", and that question has an answer whether or
not a manifest exists yet. A stale artifact therefore cannot reach a projection
through the gap: the empty-manifest case is exactly the case the finalizer
covers.

The reason this is worth writing down is that the vacuous-pass reads like a
hole when you meet it in isolation, and the instinct is to "harden" it by
making a missing manifest an error. That would be wrong: it would fail every
first build, where no manifest can exist yet, and it would be defending a
boundary the finalizer already holds.

### And the shipped-artifact test would NOT have caught it

Stated because the test's name invites the opposite reading.
`fork-module-shipped-artifact.test.ts` asserts that every staged tier copy is
byte-identical to the one `resolveBinary` actually returns. Today all three
tiers held the SAME mmap-built bytes -- `build-wasm.sh` stages all three from
one build -- so they agreed perfectly, and that test would have passed while
the artifact was stale against source.

That is not a defect in it. Tier AGREEMENT and source FRESHNESS are different
properties, and they fail in different ways:

  * tiers disagree, source fine -- a stale copy in the first-searched tier
    shadows a fresh build (census 90, the three-hour-old module). Caught by
    the shipped-artifact test; invisible to a build key, because the key
    describes the build that wrote SOME copy, not which copy wins.
  * tiers agree, source moved -- today. Caught by the build-key stamp
    (`--verify-fresh`) and by the finalizer; invisible to a byte comparison
    between copies, because consistency says nothing about currency.

Neither check subsumes the other, and each is blind exactly where the other
looks. Worth keeping in view when either is next proposed for simplification:
they look redundant (both compare hashes of the same file) and are not.

## The pkg-config guard was inert -- RESOLVED

> **RESOLVED 2026-09-17 by `d11e73e3d`**, on the maintainer's instruction
> ("CI is not currently active. Can we make this part of a regular test suite
> for the build?"). `./run.sh test` gained an `sdk` suite in its default set.
> That was 8 files and 115 tests nothing was running. Perturbed until it
> failed: dropping the `resolverProvided.has(p)` arm takes the suite from 115
> passed to `2 failed | 113 passed`, naming the case.


The `sdk/src/bin/pkg-config.ts` path-spelling fix is the change that unblocked
php, and through php the wordpress and lamp products. The FIX is proven by the
build. Its regression guard is not, and cannot be, because nothing executes the
suite it lives in.

What I checked:

  * `sdk/package.json` has `"test": "vitest run"` and vitest as a
    devDependency, and there is no vitest config in `sdk/`, so the default
    include would pick up `sdk/test/pkg-config.test.ts`. The test is
    well-formed and would run if the suite were invoked.
  * Nothing invokes it. No workflow in `.github/workflows/` runs it -- the
    only `sdk` matches in CI are a comment about `developer-kandelo-sdk`
    license bytes. `run.sh`, `scripts/` and `tools/xtask/src/` contain no
    `npm --prefix sdk test` or equivalent; the sole `cd sdk` is an `npm
    unlink` hint in a warning string.
  * `sdk/` has no `node_modules` in this worktree, so it cannot be run here
    without an install. I exercised the two cases I added through
    `node --experimental-strip-types` instead, which proves the LOGIC and not
    the suite.

So the rule that a per-worktree cache root must survive `PKG_CONFIG_PATH`
filtering is currently enforced by nothing. The next person to tighten that
filter gets php failing again, thirty minutes into a build, with the same
unhelpful symptom this lane spent hours on.

This is the maintainer's call because the remedy is a CI change, which is
outside what B50 asked for:

  * wire `sdk` into CI (an install plus `npm --prefix sdk test`), which makes
    this and every future sdk test real; or
  * move the pkg-config cases into a suite that already runs, which fixes this
    one guard and leaves the suite inert for the next one; or
  * accept it as untested and say so, in which case the test file is
    documentation and should not look like a guard.

My recommendation is the first: the suite exists, has a runner declared, and
the only missing piece is the invocation. But adding a CI job is a scope
decision, not a fork fix, so I am not taking it unasked.

## B50 done criterion: MET, with the evidence

`./run.sh setup` in this worktree, after the fork-module rebuild:

    SETUP_EXIT=0
    "outcome":"succeeded"
    "state":"succeeded"  x98   (91 packages + 7 products, no other state)

The six browser products all present: `browser-lamp`, `browser-main-shell`,
`browser-nginx`, `browser-nginx-php`, `browser-node`, `browser-wordpress`
(plus `platform-rootfs`). `coreutils-docs/wasm32` and `shell/wasm32` both
reached a built state.

The exit code is read from the FILE, not from the job's status: the command
was `./run.sh setup > log 2>&1; echo "SETUP_EXIT=$?" >> log`, so the wrapper's
own exit is the `echo`'s and always 0. The number that matters is the one in
the log.

One `failed` string appears in 5,000+ lines, and it is the mirror fallback
working:

    WARN: gawk source fetch failed from https://ftpmirror.gnu.org/gawk/...

followed by `==> Configuring gawk for wasm32...` from the `ftp.gnu.org`
fallback added in `237768364`. The matcher used to find it was first proved
capable of a positive -- the same grep returns 115 hits on the previous,
genuinely failed log and 1 here -- because a failure scan that cannot match
is not a verdict.

## The errno diagnostic has nowhere to live -- DECIDED: dropped

> **DECIDED 2026-09-17: dropped, maintainer's call.** The approval predated
> two findings. `forkTypeScript` measures 890 against a ceiling of 890, so the
> one line the `FORK_MODULE_STATS` name costs cannot be paid without a raise --
> and the M3 cap guard already prints count, cap, per-artifact breakdown and
> the named consequence ("a fork in wordpress or lamp will fail with E2BIG"),
> at TEST time, before anyone reaches the runtime errno. So the trade was never
> "one line against an undiagnosable errno"; it was "one line against a
> diagnosis already reachable by running one test file". Not worth a ceiling.
>
> The reasoning below stands as the record of how the cost was established.


`forkTypeScript` measures **890 against a ceiling of 890**. Zero headroom.
(Measured with the budget test's own `codeLinesInSource`, extracted at
runtime rather than reimplemented, so the rule cannot drift from the test's:
463 backend + 69 host-capabilities + 199 instance + 159 capture-module.)

That decides the shape of the approved E2BIG work rather than merely
constraining it. The module side is free -- one `fm_stats` field, no new
`fm_*` entry, `forkModuleHostEntries` untouched -- but every host-side
formulation costs at least one line for the `FORK_MODULE_STATS` name, and
891 > 890. The errno-7 arm itself is free: the existing errno-16 ternary
extends to a second arm within the same single expression.

The identity count is not reachable any other way. `GLOBAL_IDENTITY_COUNT`
has exactly two readers (`set_identity_group_impl` and `identity_groups`),
both module-internal, and no exported accessor.

So the options are:

  * free one line in those four files by a simplification worth making on
    its own merits, and let the diagnostic pay for itself -- which is
    precisely what the ceiling comment in `call()` says to do, and the
    honest path if such a line exists;
  * raise the ceiling by one, which I will not do unasked: it is one of the
    three standing provisional raises B50 explicitly excluded, and "never
    raise a ceiling to make a check pass" is standing;
  * leave the errno undiagnosable and keep the recorded note in
    `crates/fork-module/src/lib.rs` as the reader's only help.

I am not taking the second. Reporting the first as attempted-or-not below.

### The three cap guards, perturbed until they failed

These two shipped BROKEN and passing on 2026-09-16 -- a missing
`readForkResumeCatalog` import made every read throw `ReferenceError`, and a
bare `catch { continue }` swallowed it, so both assertions were really
`0 <= cap`. They were fixed the same day. A fixed guard is a hypothesis until
its perturbation is re-run, so all three were re-perturbed here.

Pristine `crates/fork-module/src/lib.rs` sha256 `cef66616ede7438a`,
`--verify-fresh` exit 0 before and after. Each mutation edits a `const` that
`moduleCap` reads out of the SOURCE text, so it reaches the assertion without
a rebuild; each was reverted by inverse edit and the sha checked back to
pristine rather than trusted.

| # | mutation | sha256 | result |
|---|---|---|---|
| M1 | `ACTIVATION_CATALOG_ORD_CAP` 65_536 -> 4 | `7eaf6f78d26965e7` | exit 1, guard 1 failed |
| M2 | `ACT_EXN_TAGS_MAX_ACTS` 64 -> 2 | `b120a1f46c61b849` | exit 1, guard 2 failed |
| M3 | `GLOBAL_IDENTITY_MAX` 16_384 -> 64 | `d3bed7c4b4cb3ea5` | exit 1, guard 3 failed |

Restored: sha back to `cef66616ede7438a`, empty `git diff`, 3 passed.

The failure text is the point, and it also proves the repair. Each names a
REAL measured number where the broken versions read zero:

    php needs 47757 resume-catalog ordinals against
    ACTIVATION_CATALOG_ORD_CAP=4 (0.00x headroom). Per-artifact:
    curl.so=973 intl.so=7750 opcache.so=162 phar.so=213 php-fpm.wasm=19189
    php.wasm=19025 zend_test.so=138 zip.so=307

    php holds 8 activations against ACT_EXN_TAGS_MAX_ACTS=2

    php's artifacts need 7684 identity entries but GLOBAL_IDENTITY_MAX is
    64; a fork in wordpress or lamp will fail with E2BIG. Per-artifact:
    curl.so=131 intl.so=4129 opcache.so=69 phar.so=54 php-fpm.wasm=1606
    php.wasm=1603 zend_test.so=51 zip.so=41

47,757 against 65,536 is the 1.37x recorded for the resume catalog, and 7,684
against 16,384 is the 2.1x recorded for the identity table. Both numbers are
now measured by a guard rather than asserted in a comment.

### Which changes the errno decision above

M3's text is the diagnosis the runtime errno cannot give -- count, cap,
per-artifact breakdown, and the named consequence -- and it arrives at test
time, before anyone reaches the E2BIG. So the runtime detail word is worth
less than it was when the note in `lib.rs` was written: a reader who hits
`errno 7` today can run one test file and get all of it.

That does not make the runtime diagnostic worthless -- the guard only covers
programs this repo builds, and the failure it predicts happens on someone
else's machine with someone else's extension set. But it does mean the
honest trade is "one host line against a diagnostic that is already available
by another route", which is a weaker case than "one host line against an
undiagnosable errno". Offered as an argument for leaving the ceiling alone,
not as a reason to close the question.

### The tier guard, perturbed at all four call sites

The shared helper is one function, but four scripts call it, and proving the
FUNCTION fails proves nothing about whether a given call site passes the right
arguments. Each was perturbed separately: append one byte to that module's
source-only tier copy, run that module's `build-wasm.sh --verify-fresh`.

| module | tier sha under mutation | verify-fresh | message names |
|---|---|---|---|
| fork-module | `410a764bd061b311` | 1 | `fork-module:` + `fork_module32.wasm` |
| wasi-module | `16f6091423c5c725` | 1 | `wasi-module:` + `wasi_module32.wasm` |
| dylink-module | `c25a73b1ee2b973d` | 1 | `dylink-module:` + `dylink_module32.wasm` |
| wasm-artifact-module | `a050ddcea1dcb87f` | 1 | `wasm-artifact-module:` + `wasm_artifact_module32.wasm` |

All four killed. Each message names its OWN label and its OWN file pair, which
is what distinguishes "the shared function works" from "this call site is
wired correctly" -- a transposed basename would still have failed, just about
the wrong file. Restored to `a01f1cbdb407cb03`, `a54ab0c3fe898faf`,
`e5e8869847bd82fe` and `58ac5e338fdda995`; all four verify-fresh exit 0 and
every tier copy is byte-identical to its `local-binaries/` twin.

`fork-module` is the one that does NOT call `stage_side_module_tier_copy`,
and that is correct rather than an omission: its own staging step already
writes all three tiers in one go (`staged fork_module32.wasm -> local-binaries,
host/wasm, local-binaries/source-only-v1`). The helper's two halves exist so a
script that only CHECKS cannot create a rejection nobody can clear; fork-module
satisfies the staging half by other means.

Known scope, recorded rather than fixed: the vitest tier-agreement assertion
covers `fork_module` only. The three siblings are guarded by the shell check
alone, which runs on every build and every verify-fresh. That is adequate
coverage for the drift this lane found, and extending the vitest test to the
siblings would duplicate the shell guard rather than add a dimension -- so it
is left, named, for whoever decides otherwise.

## REGRESSION I CAUSED: the identity table took P-11's address space

`./run.sh setup` reaching exit 0 proves the BUILDS succeed. It does not prove
fork works, and those are different claims. Running the fork suite (73 files,
520 tests) found three failures, one of which is mine.

Triage first, because two of the three are not:

  * `fork-module-worker-instantiation` -- "drives a qualifying fork through
    the co-resident module" timed out at 30s in the full parallel run and
    PASSES in isolation (exit 0, 1 passed). A load flake, and the one test
    that most directly proves the co-resident fork path works.
  * `fork-host-import-runtime` (2 tests) -- reproduces in isolation, and is
    already in `host/test/expected-failures.json` (64 entries). Known, banked,
    not a regression. `wa_read_facts: malformed type section: invalid value
    type`.
  * `fork-instrument-coverage` -- "P-11 root and later continuation allocation
    failures preserve the parent". NOT baselined, reproduces in isolation, and
    is MINE.

### The chain

`9b13064204` raised `GLOBAL_IDENTITY_MAX` 512 -> 16,384 to fix the E2BIG that
blocked wordpress and lamp. That table is `[[u32; 4]; N]` in the module's
static BSS, and the host reserves the whole `dylink` `memorySize` out of the
guest's memory in one `reserve(regionBytes)` call. So the cap is not a private
module detail: it is guest address space.

Measured, not inferred -- same build, only the constant changed:

    16_384   memorySize 6,743,012   P-11 FAILS
       512   memorySize 6,489,060   P-11 PASSES
                  delta   253,952 = 16_384*16 - 512*16, exactly

`programs/p_11_fork_continuation_enomem.c` mmaps 64 KiB pages until ENOMEM and
needs at least two to set up its scenario; it reports "fewer than two filler
mappings were available". 253,952 bytes is about four such pages, so the guest
had only a couple of pages of slack and my change consumed them.

That is worth stating plainly: this is not a brittle test. It is the module's
static reservation leaving a guest almost nothing to map, which is the same
concern the mmap-revert section raised from the other direction.

### The trade, bisected

| cap | P-11 | php headroom (needs 7,684) |
|---|---|---|
| 512 | passes | E2BIG -- wordpress and lamp break |
| 8_192 | passes | 1.07x (508 spare entries) |
| 9_216 | FAILS | 1.20x |
| 10_240 | FAILS | 1.33x |
| 12_288 | FAILS | 1.60x |
| 16_384 | FAILS | 2.13x |

The threshold is in (8_192, 9_216]. So the 2.1x recorded in `lib.rs` as "a
bound with a reason" was never available: any cap that keeps P-11 green gives
php at most about 1.2x.

### What I did about it, and why not more

Restored to the committed 16_384 and rebuilt; all six artifacts came back
byte-identical (`58ac5e338fdda995` / `6391604b1641de07`), build-key
`5bd1ca7969137211`, verify-fresh 0.

I did NOT quietly drop the cap to 8_192 to turn P-11 green. It would work
today, and it is one line. But 508 spare entries is one PHP extension from the
same E2BIG this lane was sent to fix, and choosing to accept that risk is a
product decision rather than a tidy-up. Tuning a constant until a check passes
is the same move as raising a ceiling to make a check pass, which is standing
forbidden -- the number stops meaning anything.

So the options, all measured:

  * `8_192` -- P-11 green, every product still builds, php at 1.07x. One line.
  * `16_384` -- P-11 red, php at 2.13x. The committed state.
  * host-reserved identity region -- the durable answer, already written up
    above: the host sizes it (it can count catalog exports before publishing),
    it does not come out of the module's `dylink` static, and neither number
    has to be traded. Costs one `fm_*` entry against a budgeted surface, so it
    is a raise to argue.

My recommendation is the third, with `8_192` as the interim if P-11 needs to
be green before that lands. Not taken unasked: both change a bound whose terms
the maintainer set.

## PROVED: a channel syscall works at INSTANTIATION time

This was the crux risk for on-demand identity allocation, and it is now
settled empirically rather than by reading.

The worry: every existing `channel_mmap` caller runs during fork
(`begin_unwind_impl`) or dlopen (`commit_table_mutation_impl`), with the guest
live. Identities are published at INSTANTIATION, before the guest runs. If the
kernel does not service this process's channel yet, a syscall there parks
forever in `memory_atomic_wait32` and the design is dead.

It does service it. Probe: a temporary `channel_mmap` + `channel_munmap` of one
page inside `fm_set_format`, guarded on `channel_base != 0`, exercised through
`fork-module-worker-instantiation.test.ts` (a REAL centralized worker, parent +
fork child).

Three runs, because the first two could not tell the answers apart:

  1. `if let Ok(addr) = ...`      -> 1 passed. Proves only "did not hang":
     an Err would skip silently and pass identically.
  2. trap on Err                  -> 1 passed. So the mmap did NOT fail.
  3. trap on Ok (reachability)    -> 1 FAILED at 9900ms. So the success path
     really executes; run 2 was not passing vacuously with the probe skipped.

Run 3 is the one that matters, and it is the H-25 rule applied to a probe
rather than to a guard: a probe that cannot distinguish its own success from
its own absence proves nothing. Inverting it is what turns "the test passed"
into evidence.

Conclusion: the channel is live at `fm_set_format`, which the host calls at
`worker-main.ts:3781` -- before `ForkImportIdentity` publishes any identity at
:3920. On-demand identity chunks can therefore be mmap'd exactly where they are
needed, with no preallocation and no fixed bound.

Probe fully reverted: source back to sha256 `cef66616ede7438a`, all six
artifacts byte-identical to pre-probe, build-key `5bd1ca7969137211`,
verify-fresh 0, and 11 tests green across worker-instantiation,
shipped-artifact and identity-capacity. Worth stating because run 3 left a
TRAPPING fork module staged, which would have broken every fork in the tree if
it had been left there.

## What it would take for forking to work without co-resident guest memory

Asked by the maintainer, 2026-09-17, after P-11. Two different questions hide
in it, and only one of them is hard.

### First, why it is co-resident at all

The fork-module is a PIC side module that IMPORTS the guest's linear memory. A
wasm module's statics live in the memory it is linked against, so the engine's
state necessarily sits in the guest's address space. This is the real
difference from the TypeScript engine it replaced: that one kept its state as
JS objects on the worker's heap and cost the guest essentially nothing.

And the region is not carved from some reserved low area.
`instantiateForkModule`'s `reserve` callback calls `continuationMmap`, so the
module's region is an mmap from the SAME arena the guest's own `mmap()` draws
on -- taken first, and held for the worker's life.

### Question one: stop RESERVING the guest's window. Achievable now.

This is what P-11 actually objects to, and it needs no new engine feature.
The static is 6.18 MiB, and 94% of it is seven capped arrays:

    4.00 MiB  HEAP, the bump allocator
    0.75 MiB  RESUME_SLOT_CAP      [[u32; 3]; 65_536]
    0.25 MiB  RESUME_CATALOG_CAP   [u32; 65_536]
    0.25 MiB  ACTIVATION_CATALOG_ORD_CAP
    0.25 MiB  ACT_EXN_TAGS_ORD_CAP
    0.25 MiB  ACT_GC_CODEC_BYTES_CAP
    0.06 MiB  ACT_KFIG_BYTES_CAP
    ------
    5.81 MiB  of 6.18 MiB

Every one is the same shape the identity table was: a fixed array sized for the
largest program anyone might run, reserved whether that program is running or
not. The identity work took 0.25 MiB back by the mechanism that already
existed (`channel_mmap` / `channel_munmap`, as the frame arena does), and the
same move applies to each.

The bump heap is the interesting one at 65%. It is not a cap on a data
structure but a whole allocator, and `ALLOC.reset()` mid-fork is load-bearing
for how the module manages fork lifetimes -- so it is the biggest prize and the
most careful change, not a mechanical repeat.

Plausible end state: a module region of a few hundred KiB that grows only while
a fork is in flight, instead of 7.44 MiB held permanently. That would take
P-11's window from 6.0 pages to over a hundred, and make the co-residency
question academic for every process that is not deliberately squeezed.

### Question two: not being IN the guest's memory at all. Blocked on toolchain.

Genuinely separating the two address spaces needs the module to keep its own
statics, stack and heap in a memory the guest cannot see, while still reading
and writing the guest's memory to capture and replay frames. That is the
multi-memory proposal, and three things have to line up:

  * ENGINE: multi-memory. Broadly available in current engines; the least of
    the problems.
  * TOOLCHAIN: `wasm-ld` must place a PIC side module's `.data`/`.bss` in a
    memory other than index 0. This is the blocker. The dylink ABI is built
    around `__memory_base` being an offset into memory 0, and neither LLVM nor
    Rust has a way to say "put this program's own data in memory 1". Nothing
    in this repo can route around that.
  * CODE: every address in the module becomes ambiguous. Today a `u64` is a
    guest offset and `mem_mut()` is the only view. With two memories, each
    pointer must say which memory it belongs to, and the module's own Rust
    references would implicitly be in its private memory while every
    `fork-codec` offset stays a guest one. That is a pervasive, error-prone
    distinction that the type system would not be checking.

Copying between memories instead of sharing is not a way out either: without
multi-memory a copy has to go through the HOST (JS reading one memory and
writing the other), which puts the fork data path back in TypeScript -- the
exact direction this campaign is unwinding.

### Recommendation

Do question one and treat question two as blocked-upstream. Seven arrays and
one allocator stand between the current 7.44 MiB and a region that is
negligible for any realistic process, all using machinery already in the module
and already proven by the frame arena and now the identity table. Question two
buys isolation rather than space, and cannot start until a toolchain can place
side-module statics outside memory 0.

Worth recording that P-11 found all of this. A test deliberately capped at 384
pages is the only thing in the tree that notices what the fork engine takes
from a guest, which is an argument for keeping it exactly as tight as it is.

## The full host suite, and why "flaky" was the wrong first answer

4,227 tests across 448 files, 2,004s. 65 files failed against a 64-file
baseline (`host/test/expected-failures.json`), which compares as 4 regressions
and 3 unbanked improvements. None of the four is a code regression -- but
finding that out required correcting my own first explanation.

I saw another worktree running vitest concurrently and called all four load
flakes without reading them. Two are not races at all:

    rootfs-image-tree-parity   six VFS images MISSING
    vfs-image-kernel-lazy      same, and the test says so outright:
                               "shell.vfs.zst is missing; run ./run.sh setup
                               before this gate can prove anything"

### The cause was mine, and it is a defect worth reporting

`./run.sh rebuild kernel` -- run to try to clear the stale ambient-kernel gate
-- runs `clean_target` then `build_target`. The clean removed the kernel AND
every VFS image depending on it:

    removed local-binaries/source-only-v1/kernel.wasm
    removed .../wasm32/{lamp,nginx-php-vfs,nginx-vfs,node-vfs,shell,wordpress}.vfs.zst

The build then rebuilt only the kernel. Six images stayed deleted, silently. A
targeted rebuild that leaves the tree LESS complete than it found it is a
defect on its own, and it compounds the ambient-kernel problem: rebuilding the
kernel is the documented remedy there, so following the advice makes the tree
worse rather than better.

### Isolation is what separated them

Four failures that looked identical in a loaded run split cleanly when each was
re-run alone:

| test | alone | cause |
|---|---|---|
| `binary-resolver` | 85 passed | load |
| `fork-instrument-coverage` | 41 passed | load (P-08 and P-11 green) |
| `rootfs-image-tree-parity` | 7 failed | NOT load |
| `vfs-image-kernel-lazy` | 7 failed | NOT load |

`binary-resolver` is the sharpest case: it passed alone against the SAME
artifact-missing tree, which RULES OUT the missing images as its cause rather
than assuming. And after `./run.sh setup` restored the tree (exit 0, 98/98
nodes succeeded, 8 images back), the two image tests pass: 13 and 25.

So: zero code regressions across 4,227 tests.

### Why a full re-run was not needed

The other 61 failing files matched the baseline exactly, and neither confounder
can reclassify them: missing images cannot turn a baselined failure into a
pass, and CPU contention cannot either. The accounting closes from both
directions -- 65 failing minus 4 regressions, and 64 baselined minus 3
unbanked, are both 61. That reasoning saved a ~33-minute re-run, and it is
only valid because the two confounders are one-directional.

### A grep that counts the wrong thing

The restoring `setup` logs 56 lines containing "failed" where the earlier one
had 1. All are package-internal: PHP `opcache.so` load warnings, and the
opcache prewarm heuristic that DELIBERATELY bisects ("compile batch of 758
failed; splitting into 379 + 379"). They appear only because those packages
actually rebuilt this time instead of being cached. The authoritative signal is
`"state":"succeeded"` x98 and the exit code, not a grep for a word that appears
inside a working algorithm.

### For the maintainer: three unbanked improvements

    ../packages/registry/wordpress/test/wordpress-site-editor.test.ts
    test/man-shell-lazy-archive.test.ts
    test/terminfo-shared-db.test.ts

These are in the baseline and now pass. Per `suite-baseline.mjs`, leaving them
listed lets the next regression hide behind them, so they should be banked --
but `expected-failures.json` is shared state and that edit is not this lane's
to make.

## Reducing the module's static: what worked, and where the wall is

The module's static is mmap'd out of the GUEST's own window before the guest
allocates anything, so every byte of it is a byte a process cannot map. Asked
to shrink it using the identity table's dynamic-allocation approach.

### Done: the bump heap, 4 MiB -> 1 MiB floor (-3.00 MiB, -46%)

`memorySize` 6,480,916 -> 3,335,204; module region 7.44 MiB -> 4.44 MiB.

The heap was the outlier. Measured by trapping above a threshold and rebuilding:
a real single fork peaks between 256 and 512 KiB, so 4 MiB was 8-16x oversized
-- AND still a hard bound, so a heavier fork got a null allocation with no way
to ask for more. It is now a floor that maps 1 MiB chunks on demand and retains
them across `ALLOC.reset()`.

The floor's size is measured, not chosen. At a 64 KiB floor the growth path is
forced on every fork and 44 tests pass, including a real end-to-end fork -- that
is what proves growth serves production allocations rather than merely
compiling. The full lifecycle suite at that floor fails exactly ONE test: P-11,
which deliberately exhausts a 384-page process, because growth needs an mmap and
that fixture has no room for one. So the floor must cover the peak or a
memory-constrained fork cannot fork. At 1 MiB it does.

### "Blocked": the five catalog arenas -- THE REASONING BELOW IS WRONG

> **RETRACTED 2026-09-17, same day, on the maintainer asking whether I had
> given up.** The claim below is that a fork child "cannot syscall" while
> re-seeding, generalised from ONE failure: the GC codec conversion returning
> `errno 12` in a child. My own heap work refutes it. At the 64 KiB probe floor
> a child's allocations (measured peak 256-512 KiB) necessarily exceeded the
> floor, so children WERE calling `channel_mmap` to grow the heap, and 40 of 41
> lifecycle tests passed. Children can syscall.
>
> I never bisected the GC codec failure to find its real cause -- plausibly a
> bug in that conversion (it needed a type fix and carried fresh `copy_within`
> logic), or one specific moment in child setup rather than a blanket rule. I
> inferred a design law from a single data point and wrote it here as settled.
>
> What IS still true below: the arenas are not oversized (php uses 73% of
> each), so a small floor would refuse php. That half stands on measurement.
> Whether dynamic growth is available to them is OPEN, and settling it means
> bisecting the GC codec ENOMEM rather than accepting it.
>
> **SETTLED, later the same day, and the answer is neither of my guesses.**
> Three probes ruled out the platform: a 64 KiB heap floor forces children to
> grow and 40 of 41 lifecycle tests pass; a 4 KiB floor forces growth during
> child SETUP and a real fork still passes; and a throwaway one-page mmap at
> the exact failing point now succeeds (proven non-vacuous by inverting it to
> trap on success and watching 7 tests fail). Children can syscall, during
> setup, at that point.
>
> The first failure was ADDRESS-SPACE PRESSURE: the module region was 7.44 MiB
> then and is 4.44 MiB now, because the bump heap stopped reserving 4 MiB. The
> static and the dynamic allocation were competing for one window, and
> shrinking the static is what made the mapping fit. So the work that made me
> declare the rest blocked is what unblocked it.
>
> **The rebuilt conversion then failed P-11 anyway, for a THIRD reason: page
> granularity.** A per-activation `SYS_MMAP` rounds to 64 KiB, so eight
> activations holding a few hundred bytes each claim 512 KiB of pages -- to
> replace a 256 KiB static they SHARED. It is bigger, not smaller, and only in
> the processes that can least afford it: 39 lifecycle tests passed and P-11,
> with 2-6 pages of slack, failed with the same `errno 12` in isolation.
> Reverted.
>
> The fix is a SHARED growable arena -- the chunk mechanism the heap now uses,
> minus the per-fork reset -- so small sections share a page instead of
> claiming one each. Not built; it needs a floor decision like the heap's.
>
> Three wrong explanations for one failure, each confidently written down
> before it was tested. The pattern worth extracting: a failure that reproduces
> is still not a diagnosis, and "I know why" deserves the same experiment as
> "I know it works".


Two facts close this off, and both were measured rather than assumed.

**They are not oversized.** Unlike the heap, they are sized for real programs:
php uses 73% of each (47,757 resume-catalog ordinals against a 65,536 cap).
CORRECTED 2026-09-18: 47,757 sums php.wasm AND php-fpm.wasm, which no single
process loads together. Per process it is 28,568 or 28,732 -- 44%, not 73%.
See the measurement section at the end of this document.
A smaller floor would refuse php, which is the trap the identity table's old
`512` fell into.

**A fork child re-seeds them from scratch, and cannot syscall while it does.**
`set_format_impl` DELIBERATELY resets `ACT_CATALOG_ACT_COUNT`,
`ACT_CATALOG_ORD_USED`, `RESUME_SLOT_COUNT`, `RESUME_FREE_COUNT`,
`ACT_FUNC_CATALOG_BASE_COUNT` and `ACT_STATIC_ROOT_BASE_COUNT` on the child, so
the child's own per-activation seeding repopulates them. Seeding therefore
allocates, and allocation during child seeding is refused by the kernel -- the
child process is still being created. Measured directly: an attempt at the GC
codec arena (which is NOT reset, and so should have inherited) failed 16
lifecycle tests with `fm_set_activation_gc_codec failed with errno 12` (ENOMEM)
in the child. That attempt is reverted.

Put together: a dynamic arena needs a floor big enough for child re-seeding, and
child re-seeding is php-scale, so the floor is the array. There is no saving to
take by this route.

### What would move it

Not more effort on the same approach -- a change to WHEN children seed. If a
child seeded after the kernel considered it fully created, its catalogs could
grow like the heap does and the 1.56 MiB would follow the 3 MiB. That is a
process-lifecycle change well outside this lane, and it is the thing to
reconsider if the remaining static ever matters.

Also worth noting the asymmetry that made the heap tractable: it is reset per
fork and reconstructed, so a child never depends on inheriting it, while the
catalogs are state a child must have before it can run.

## Static reduction: what it actually bought, and where it stops

Five conversions landed, 63%:

    baseline            6,480,916   6.18 MiB
    heap floor          3,335,204              -3.00 MiB
    resume free bitmap  3,081,236              -0.24 MiB
    GC codec floor      2,852,644              -0.22 MiB
    catalog ord floor   2,624,052              -0.22 MiB
    exn tags floor      2,395,460   2.28 MiB   -0.22 MiB

### What kind of saving this is -- read this before quoting the number

Address space, not memory. The maintainer asked whether P-11 was driving the
work, and separating the dimensions is the honest answer:

  * PHYSICAL MEMORY: close to zero saved. A 4 MiB BSS heap that peaks at
    512 KiB only ever commits 512 KiB of real pages. Shrinking the
    DECLARATION does not free RSS that was never committed.
  * FORK COPY COST: close to zero, for the same reason -- untouched pages are
    not copied.
  * ADDRESS SPACE: genuinely reduced. But at the 1 GiB default that is
    7.44 MiB of a 1007 MiB window, 0.7%. It binds in constrained
    configurations, which today means P-11.

Nothing user-visible was measured: not fork latency, not RSS, not a program
that failed before and works now. The number is real and the dimension mostly
does not bind.

### P-11 shaped every floor, and that is worth knowing

`maxPages: 384` is a fixture choice, and the tightness is the POINT -- the
exhaustion path cannot be tested without exhausting something. But every floor
here was sized by it, not by a workload: the heap floor is 1 MiB because
64 KiB fails P-11, and the GC codec shares a floor because a mapping per
activation fails P-11. If that constraint is not representative, these floors
are too conservative and the design should be driven by a real workload.

### The one change that stands on its own merits

The resume free list: `[u32; 65_536]` -- 256 KiB of storage for 8 KiB of
information -- with an O(n) shift per allocation and an O(n log n) sort per
unregister, on a path php drives to 47,757 slots. Smaller AND faster. Keep it
whatever is decided about the rest.

### BLOCKED, and this one is not about memory pressure

`RESUME_SLOT_INDEX` (768 KiB, the largest remaining) converts to floor+chunks
cleanly and DEADLOCKS. At the real 4,096-entry floor every suite passes,
because no test ever needs a chunk. Forced with a 4-entry floor, every process
sleeps at 0% CPU for 30 minutes -- the signature of `channel_mmap` parking in
`memory_atomic_wait32` for a kernel that never services it, since a spin would
burn CPU instead. Slot registration happens during catalog seeding, and the
channel is not serviceable there.

php assigns 47,757 slots and WOULD have needed chunks. So the version that
measured 74% was one commit from a deadlock on the only workload that matters,
with every suite green. Reverted, saved out of the tree.

That also narrows an earlier claim of mine. "Children can syscall" was proven
for heap growth and for the GC codec seed; it is FALSE for slot registration.
They can syscall at some moments and not others, and which moment is the whole
question. Three times today I generalised one measurement into a rule about
the platform and three times it was wrong.

### What is left

`ACT_KFIG_BYTES` (64 KiB, same pattern, ~56 KiB to gain -- poor value for a
build-and-suite cycle) and `RESUME_SLOT_INDEX` (768 KiB, blocked above).

And a gap in what "dynamic" currently means here: this is allocation on
demand, NOT free. Chunks are retained for the worker's life; only the identity
table releases, on dlclose. A long-lived worker that peaks once holds that
memory forever.

## Inventory: every fork-related allocation, and who frees it

Assembled from source because the question "what are we actually allocating
for?" had no single answer anywhere. All of it lives inside the process's ONE
shared `WebAssembly.Memory`.

### 1. The co-resident module's region -- reserved per process

`instantiateForkModule`'s `reserve` goes through `continuationMmap`, so this
comes out of the guest's own mmap window and is held for the worker's life:

    alignUp(dylink memorySize + 1 MiB shadow stack) + 256 KiB staging slab
    = 4.44 MiB today (7.44 MiB before this work)

The staging slab is the host->module handover buffer; the shadow stack is the
module's own call stack.

### 2. Module statics, inside that memorySize

Twenty arrays, by purpose:

  * ALLOCATOR: `HEAP` (1 MiB floor), `SCRATCH` (64 KiB)
  * RESUME SLOTS: `RESUME_SLOT_INDEX` (768 KiB), `RESUME_FREE_BITS` (8 KiB),
    `RESUME_CATALOG` (256 KiB)
  * PER-ACTIVATION CATALOGS: activation ordinals, GC codec, exn tags, KFIG
    bytes -- each an arena plus a small index
  * PER-ACTIVATION SMALL TABLES: func-catalog bases, static-root bases,
    template ids, table-state owners (64-256 entries each, all tiny)
  * CAPTURE WORKING STATE: captured externrefs (16 KiB), vector stack,
    imported-global provenance (6 KiB)

### 3. Dynamic: EIGHT mmap sites, THREE munmap sites

| allocation | freed | by |
|---|---|---|
| frame chunks, per fork | yes | `ForkChunkList::release_all` |
| journal image, per capture | yes | `release_fork_chunks` drains `extra_chunks` |
| identity chunks | yes | `release_identity_activation`, on dlclose |
| heap chunks past the floor | no | retained deliberately, so growth is paid once |
| catalog / GC codec / exn-tag spills | no | live as long as the activation |
| table-patch records | no | see below |

`commit_table_mutation_impl` maps a record per table mutation, appends it into
the dlopen archive chain, and records nothing in `extra_chunks` -- no release
path names it. PREDATES this work, unmeasured, and flagged rather than
claimed: the archive may be reclaimed wholesale somewhere else. It is simply
the one site with no visible owner.

So "dynamic allocation" here is DEFERRED RESERVATION, not reclamation. Five of
eight sites never free, and everything added in this session is retained.

### 4. Guest process layout, below the mmap window

`mmapBase` is 16.19 MiB: control slab + syscall channel + a 16 MiB BRK
RESERVE. The window is [mmapBase, maxAddr), and `maxAddr` is
`maximumPages * 64 KiB`.

Worth stating plainly: the brk reserve alone is more than twice the module
region this session spent its effort shrinking, and it sits below the window
rather than inside it. If the goal is address space for guests, that is the
larger number, and it was never examined because the work anchored on the
module.

> **CORRECTION.** That 16 MiB is a FALLBACK, not what real programs get. It
> arrived in `95e31d2588` "Reduce initial process memory allocation" (#595,
> 2026-06-01) described as the "`MemoryManager::INITIAL_BRK` fallback for
> binaries without `__heap_base`", and `extractHeapBase` uses the program's own
> value when it has one. Measured: `php.wasm` declares 20.43 MiB, `bash.wasm`
> 9.44 MiB. So it is not "the larger number" for guests and I should not have
> said so.
>
> But the correction cuts a more interesting way. The TEST FIXTURES declare
> nothing -- `p_11_fork_continuation_enomem` and `d_01_single_fork` both return
> null from `extractHeapBase` -- so they take the 16 MiB fallback. P-11's mmap
> window is 7.81 MiB of its 24 MiB budget because a C program that needs a
> fraction of it is charged the fallback. With a 2 MiB heap base the same
> process would have a 21.81 MiB window. That is a second sense in which P-11's
> tightness is manufactured, and it is independent of the 384-page choice.


## P-11's origin, and why realigning it is sanctioned

Fixture and test entry both arrived in `b68524efa8` (2026-07-25), a 253-file
squashed "coherent ABI 42 platform foundation" commit whose message never
mentions either. The history explains nothing; the campaign plan does.

`docs/plans/2026-09-08-rust-first-fork-point-of-no-return.md` Phase 1, on
restoring dynamic mmap frame allocation:

> Realign the `fork-memory-clone` / P-10 / P-11 fixtures to the growable
> model (as new correct behavior, not test-relaxing).

and Phase 2 is titled "Module-mode partial-capture-abort (the P-11 /
truthful-failure foundation)".

So P-11's SUBJECT is a real correctness property -- allocation failure
mid-capture must fail truthfully and preserve the parent -- and its 384-page
budget is the MECHANISM for reaching that failure, calibrated for the old
fixed-reservation model. The plan anticipated those fixtures needing
realignment once allocation became growable.

Which means the floors in this lane are P-11-shaped by a fixture the plan
said to realign. The distinction the plan draws is the one to hold: realigning
it to the growable model is the planned work; raising `maxPages` until it goes
green is the test-relaxing it warns against. Those look alike and are not.

## The allocator is the real defect, and it is mine

The maintainer's read: "It sounds like you implemented your own allocator, but
that is wrong. You should allocate like the guest allocates." Researched, and
it lands -- though not where I first thought.

**The guest's allocator is not reachable.** `malloc`, `free`, `calloc` and
`realloc` do not appear among the guest binary's export names; musl
static-links them. The module cannot call the guest's allocator without the
SDK exporting it, which is a guest-ABI change.

**The module already allocates the way the guest does, mechanically.** The
guest's malloc sub-allocates inside regions obtained by brk/mmap syscalls; the
module's bump allocator sub-allocates inside chunks obtained by `SYS_MMAP`
through the same channel, out of the same memory. Same shape.

**The actual mistake is narrower.** For the per-activation catalogs I bypassed
the allocator and called raw `mmap` PER OBJECT. That is not how a few hundred
bytes get allocated, and it is the whole reason page granularity bit: an
`mmap_anonymous` rounds to 64 KiB, so eight small sections claimed 512 KiB to
replace a 256 KiB static they shared. The "shared floor" fix is sub-allocation
reinvented badly -- four ad-hoc floors, one per arena, each with its own spill
rule.

**What it should be: ONE non-reset allocator for long-lived module data.**
Exact sizes, real `free`, chunk-backed. The catalogs, GC codec, exn tags and
identity table all draw from it, and the four floors collapse into one. It also
closes the reclamation gap, because a real allocator has a free list where a
bump arena has none.

It cannot be the EXISTING heap: `ALLOC.reset()` rewinds that mid-fork and the
catalogs must outlive it. So it is a second allocator, which is precisely what
the four floors are impersonating one arena at a time.

Cost of doing it: it REPLACES four of the five conversions already committed
rather than extending them.

## Freeing is not blocked -- it is unwired

Checked per site, and none of the five that never free is prevented from it:

  * heap chunks past the floor -- retained deliberately so growth is paid once;
    could release at worker teardown.
  * catalog / GC-codec / exn-tag spills -- bounded by activation lifetime, and
    the hook already exists. `fm_resume_slots` op 1 is the dlclose signal the
    identity table already uses to free its chunks. The others were simply not
    wired to it.
  * table-patch records -- the one with no visible owner, predating this lane.

So "five of eight never free" describes a gap in what was built, not a
constraint that was discovered. Saying otherwise would be dressing an omission
as a finding.

## The floors have no remaining justification

Asked whether the reserved space is contiguous and exclusive, and what the
allocator actually allocates. Both answers point the same way.

**It is contiguous, exclusive, and reserved whether touched or not.** The
module's region comes from `mmap_anonymous`, which first-fits a gap by merging
two address-ordered lists (`mappings`, `reserved_regions`) and records the
result. So `find_gap` will never hand any of that range to another `mmap()`
while it is mapped. A 4 MiB heap peaking at 512 KiB still denies the other
3.5 MiB to everything else in the process. What it does NOT cost is committed
physical memory.

**It is both kinds of allocation at once**, which is the flaw. The bump
allocator sub-allocates inside the already-reserved static region; the chunk
growth I added obtains NEW address space by `channel_mmap`. A fixed floor with
dynamic expansion bolted on.

**And the floors are justified by nothing but P-11.** The original reason given
-- "a fork child cannot syscall while it is being created" -- was disproved
here: at a 4 KiB heap floor, where growth during child setup is mandatory, a
real end-to-end fork passes; at 64 KiB, 40 of 41 lifecycle tests pass and the
single failure is P-11.

So every floor in this lane exists to satisfy one fixture whose tightness is
manufactured twice: 384 pages AND a 16 MiB `__heap_base` fallback the fixture
does not need. Realign that -- which Phase 1 of the point-of-no-return plan
already sanctions as "new correct behavior, not test-relaxing" -- and the
floors go to essentially zero.

That reframes the allocator question. It is not "floor plus spill, done
better". It is NO FLOOR: one allocator that maps on demand, sub-allocates exact
sizes inside what it maps, and frees. The only thing in the way is a fixture
the plan says to realign.

## commit_table_mutation_impl leaks, and the chain is why

Investigated on the maintainer's instruction. It is a real leak by inspection.

`release_archive_writer` frees nothing -- it is a LOCK release, a
`compare_exchange(WRITER -> IDLE)` plus a notify. And the record is mapped and
then linked INTO the published archive:

    let size      = appended_record_size(&patch)?;
    let record_at = channel_mmap(channel_base()?, size)?;
    let plan      = plan_table_patch_append(&archive, head, tail, record_at, &patch);

The mapping's address becomes part of the structure later readers walk, so it
cannot be freed while the chain references it -- and the chain only grows, each
patch bumping `archive.generation` and appending.

Three properties make it worse than a per-fork leak:

  * PER TABLE MUTATION, not per fork. Every `dlopen` that mutates the indirect
    function table appends one. A long-lived worker that dlopens repeatedly --
    php-fpm loading extensions, the LXDE demo launching apps -- accumulates one
    mapping each.
  * PAGE GRANULARITY. `appended_record_size` is a small header plus runs, and
    `mmap_anonymous` rounds to 64 KiB, so most of each page is waste. The same
    defect as the per-object catalog mapping, already present here.
  * PROCESS-WIDE. The archive lives in the dlopen control region shared across
    the process's workers, so no fork or worker teardown resets it.

NOT established: whether anything reclaims the archive wholesale at process
exit, and what the real mutation rate is for a workload like php-fpm. Both are
measurable; neither is measured. Structural leak by inspection, unquantified in
practice.

It predates this lane and belongs to the dlopen archive subsystem rather than
fork capture -- but it has the same root cause as the catalog mistake, and one
non-reset allocator with exact-size allocation would fix both.

## Why not just use the guest's allocator

The maintainer pressed this twice, and it deserved a measured answer rather
than the one I gave first ("malloc is not exported, musl static-links it"),
which came from grepping ONE 51-export test fixture.

Measured across real binaries:

| binary | exports | malloc | free | __malloc_lock |
|---|---|---|---|---|
| `php.wasm` | 19,626 | yes | yes | yes |
| `bash.wasm` | 53 | no | no | no |
| `d_01_single_fork.wasm` | 51 | no | no | no |
| `p_11_fork_continuation_enomem.wasm` | 51 | no | no | no |

So php DOES export the allocator, and my first answer was wrong. But php is
the outlier: it exports ~19,600 symbols because it is a dynamic-extension
host. `bash` exports 53 and has no allocator among them; an ordinary
SDK-linked program keeps `malloc` internal.

**Availability rules it out as a general mechanism.** The module is
instantiated against EVERY guest. Calling an export that one program in the
tree happens to have would mean two code paths -- a real allocator for php and
a hand-rolled one for everything else -- which is worse than either alone.

**Safety points the same way, and `__malloc_lock` is the tell.** php also
exports `__malloc_lock` and `__malloc_atfork`. Those exist because musl's
allocator takes a LOCK and needs explicit coordination across `fork` -- the
classic hazard, and the reason POSIX restricts what a forked child may call.
The fork-module allocates exactly where that bites: during capture, and during
child setup while the process is still being created. Taking a lock the guest
may already hold, in a child that inherited it locked, deadlocks -- and that
failure looks precisely like the slot-chunk attempt above: every process asleep
at 0% CPU.

Not proven, but unlike the earlier guesses this one has evidence pointing AT it
rather than away: the guest's own libc ships an atfork handler for this exact
problem.

**What survives of the critique.** The module does need its own allocator. What
it does not need is FOUR ad-hoc floors and a raw `mmap` per object. One
non-reset allocator -- exact sizes, real free, mapping on demand, and per the
floor finding above, no fixed floor at all once P-11 is realigned.

### And why not the kernel's allocation APIs

Asked next, since the module shares the process memory. The module ALREADY
calls the kernel's allocator: `channel_mmap` issues `SYS_MMAP` over the syscall
channel and lands in `mmap_anonymous`. Access was never the constraint --
granularity is, and page granularity is mmap's contract rather than a
shortcut.

The kernel does have a byte-granular allocator, `kernel_alloc_scratch(size)`,
which calls its own Rust `alloc_zeroed`. It is unusable here: it returns a
KERNEL pointer, into the `Kernel` object's own `WebAssembly.Memory` in the
kernel worker (`host/src/kernel.ts` allocates the API scratch region from
`this.#memory`, and `KernelPointer` is a distinct type from a guest address).

The fork-module's data has to live in the GUEST's memory, because `fork-codec`
indexes it by absolute guest offset, capture and replay read it while operating
on the guest's address space, and a COW child inherits it only by virtue of
being inside the memory that gets copied. A kernel-heap pointer satisfies none
of those.

So the kernel offers a page-granular allocator over guest memory and a
byte-granular one over kernel memory, and the module needs byte-granular over
GUEST memory -- which neither provides, and which nothing else can, because
sub-allocating inside a mapping is by definition the job of whoever owns the
mapping.

All three routes therefore close on evidence rather than preference:

  * the guest's allocator -- absent from most guests, fork-hazardous where
    present (`__malloc_lock`, `__malloc_atfork`);
  * the kernel's fine-grained allocator -- wrong address space;
  * the kernel's guest-memory allocator -- page-granular by contract.

A module-owned allocator is not a taste; it is the only place the two
requirements meet. What was wrong was the implementation -- four ad-hoc floors
and a raw `mmap` per object -- not the decision to have one.

### Correcting why mmap is page-granular

I justified it as "mmap's contract -- a mapping must be independently
protectable, and protection is tracked per page". That is FALSE in Kandelo, and
the source says so: `MemoryManager::Mapping::prot` is commented "tracked but
not enforced", and `sys_mprotect` is a no-op pinned by
`test_mprotect_succeeds_noop`. Wasm linear memory has no MMU, so protection
cannot be enforced at all. I reasoned from general POSIX systems instead of
from this one.

Asked for the spec citation, I could not give one honestly: no network access,
and fabricating a URL or quoting text I cannot verify would be worse than
admitting the gap. From memory and flagged as unverified: POSIX's strongest
page language is in `munmap` (it removes mappings for ENTIRE PAGES containing
the range), `mmap` speaks of zero-filling a partial page at the end of an
object, and the page size itself is implementation-defined via
`sysconf(_SC_PAGESIZE)`. "Conventional mmap semantics" is what I should have
written, not "POSIX contract".

What actually forces 64 KiB here:

  * it is the WASM PAGE, `memory.grow`'s unit, so it is the granularity the
    kernel can OBTAIN memory in -- though that governs acquisition, not the
    bookkeeping of what is handed out;
  * `munmap` removing whole pages means two mappings sharing a page could not
    be unmapped independently, and unlike prot flags that IS guest-observable.

Whether Kandelo needs guest-visible mmap to stay page-granular is a real
question and not settled here, and the maintainer has said they do not want
mmappings to be unnecessarily large regardless, so it stays on the table.

What I wrote next -- "it does not change what the module should do: map one
region and sub-allocate inside it" -- was a conclusion I stated as shared when
it was mine alone, and the maintainer said so. It is also wrong for half the
buckets. See the next section.

## Is the aggregate catalog size known at allocation time?

The maintainer asked this directly, and it is the question that dissolves
half the argument above. Answer: yes for two of the four buckets, no for the
other two, and the split is not about allocator design at all -- it is about
WHEN each catalog is seeded.

Every seeding entry point already carries an exact size, so no individual
catalog is ever a guess:

  * `fm_set_activation_gc_codec(activation_id, ptr, byte_len)` -- lib.rs:7191
  * `fm_set_activation_exception_codec(activation_id, ptr, byte_len)` -- :2116
  * `fm_set_activation_resume_catalog(activation_id, ptr, count)` -- :7124
  * `fm_set_resume_catalog(ptr, count)` -- :7099

### Known: the GC codec and exception codec arenas

`host/src/worker-main.ts:4373` builds `gcCodecBytes` as a COMPLETE
`Map<activationId, Uint8Array>` by walking every compiled module's custom
sections; `:4391` does the same for `exceptionCodecBytes`. Both maps are
finished at `:4386` and `:4401`. The loops that consume them do not run until
`:4795` and `:4825`.

Between those points the host holds every byte array it will ever hand over.
The aggregate is one `reduce` over the map's values, available roughly four
hundred lines before the first setter call.

Those two maps back `ACT_GC_CODEC_FLOOR` (32 KiB) and `ACT_EXN_TAGS_ORD_FLOOR`
(8,192 ordinals, 32 KiB) -- both of the arenas that got a floor plus a spill
chunk list in this lane.

For these, the right shape is neither a module sub-allocator nor a change to
mmap granularity. It is ONE mmap of the exact summed size, rounded up once,
taken before the seeding loop starts: no floor, no chunk list, no spill index,
no allocator. Page rounding then costs at most 64 KiB ONCE for the whole
worker rather than once per activation, and the size tracks the program
instead of tracking P-11.

This retires the sub-allocation claim for these buckets outright. There is
nothing to sub-allocate when the total is a single known number.

### Not known: the resume catalog

`fm_set_activation_resume_catalog` is called from `instantiateSideActivation`
(`worker-main.ts:897`), once per `dlopen`, as each module loads. Nothing at
that moment knows how many `dlopen`s follow.

That covers `ACTIVATION_CATALOG_ORD_FLOOR` (32 KiB) and `RESUME_SLOT_INDEX`
(`RESUME_SLOT_CAP` 65,536 entries of `[u32; 3]`, 768 KiB).

The aggregate for these IS known at fork time -- `forkActivations.ordered()`
enumerates every activation -- but it is needed at dlopen time, which is
strictly earlier. That ordering, not allocator design, is the whole of the
difficulty.

Options, none of them chosen here:

  * geometric growth: mmap a larger region, copy, unmap the old one. Real
    work, but bounded and amortized, and it is what a growable vector does.
  * move the seed point later, so the aggregate is known before the first
    write. This changes when resume slots are numbered, which resume-slot
    parity depends on; not obviously safe.
  * leave it. The `RESUME_SLOT_INDEX` floor+chunk attempt already DEADLOCKED
    when forced below its floor (see the earlier section), so this bucket has
    a measured reason to be treated separately.

### What was measured, and what was not

The 73%-occupancy figure for php (47,757 ordinals of 65,536) is the RESUME
catalog -- the streaming side, not the known-aggregate side. It has now been
re-derived: the arithmetic is exact, but the SCOPE is wrong. See the
measurement section below.

Nothing in this section has been implemented. It is a reading of the two call
paths, with line numbers so it can be refuted in one step.

## Measured: what actually fills each catalog (2026-09-18)

Every number below is decoded from the wasm custom sections of the 399
binaries under `local-binaries/`, using `WebAssembly.Module.customSections` --
the same call `worker-main.ts:4374` makes. Record counts, not byte sizes.

Wire formats, so any of this can be rederived:

  * resume catalog: 12-byte header, count at `+8`, 8 bytes/record
    (`host/src/fork-resume-catalog.ts:19`). The COUNT is readable from twelve
    bytes; no parse of the body is needed to learn the size.
  * GC codec: 16-byte header, layout count at `+8`, field count at `+12`,
    44 bytes/layout, 12 bytes/field (`crates/fork-codec/src/gc_codec.rs:11`).
  * exception codec: 8-byte header, count at `+4`, 16 bytes/record.

### The GC codec catalog is EMPTY in every binary in the tree

All 99 fork-instrumented modules report `layouts=0, fields=0`. The section is
a bare 16-byte header, byte-identical across php, wget, node and the test
fixtures alike:

    4b464743 0100 1000 00000000 00000000
     K F G C   v1  hdr=16  layouts=0  fields=0

`crates/fork-instrument/src/module_gc_codec.rs:1950,1981,2114` builds layout
records from the module's wasm GC `struct` and `array` types. clang/wasm32
emits none, so the catalog is structurally empty for everything this toolchain
produces.

This measurement is admissible as "what exists" and INADMISSIBLE as "what will
exist". A guest compiled from a GC-using language would produce a non-empty
catalog scaling with its type graph, and no such guest exists here to measure.
The committed fixture `crates/fork-codec/testdata/gc-codec-wasm32.bin` is 432
bytes for 7 layouts and 9 fields; at that shape `ACT_GC_CODEC_FLOOR = 32_768`
holds roughly 400 layouts. Whether that is the right target is not a question
the empty measurement can answer, and the empty measurement does NOT license
shrinking the floor.

### The exception-tag floor has no defence

Observed maximum across all 99 fork-instrumented binaries: **4 tags**. php,
wget, node and ruby declare 1 each; plain-C programs declare 0. The hard
ceiling from the wasm side is the module's tag section, whose largest instance
in the tree is **5 entries** (`perl.wasm`) -- a module cannot declare more
exception-codec records than it has tags.

`ACT_EXN_TAGS_ORD_FLOOR = 8_192` ordinals stands against that.

I sized it by symmetry with `ACTIVATION_CATALOG_ORD_FLOOR`, which is a RESUME
catalog floor fed by an entirely different input, and never looked at what
produces exception tags. It is the clearest case in this lane of a constant
chosen to match a neighbour rather than to match its input.

### `MAX_ACTS = 64` against an observed maximum of 7

The largest real activation set in the tree is php: the program plus six
extension `.so` files. Everything else is 1-3.

The cap is not a reservation -- `ACT_GC_CODEC_INDEX` is `[[u64; 3]; 64]`,
1,536 bytes -- so its cost is trivial and its risk is a program that exceeds
it and takes `E2BIG`. Nothing here does. The same 64 appears in
`ACTIVATION_CATALOG_MAX_ACTS`, `FUNC_CATALOG_BASE_MAX_ACTS`,
`TEMPLATE_ID_MAX_ACTS`, `STATIC_ROOT_BASE_MAX_ACTS` and
`ACT_EXN_TAGS_MAX_ACTS`; `ACT_KFIG_MAX_ACTS = 128` breaks the pattern for no
reason found.

### The resume catalog, and the scope error in 47,757

Per-activation ordinal counts for the php package:

    php.wasm        19,025      php-fpm.wasm    19,189
    intl.so          7,750      curl.so            973
    zip.so             307      phar.so            213
    opcache.so         162      zend_test.so       138

The 47,757 this document has been quoting is arithmetically EXACT -- it is the
sum of all eight -- but it sums `php.wasm` AND `php-fpm.wasm`, and no single
process loads both. The per-process figures are:

    php CLI + 6 extensions      28,568 ordinals   (7 activations)
    php-fpm + 6 extensions      28,732 ordinals   (7 activations)

So `RESUME_SLOT_CAP = 65_536` is 44% used at php scale, not 73%. The
occupancy argument in the earlier sections overstates by counting two mutually
exclusive programs.

I first reported this as "the figure is wrong, the real number is 28,568".
That was itself wrong: the figure is right and its SCOPE is wrong, which is a
different defect and a more dangerous one, because the arithmetic checks out.

### Why mapping strategy matters for this catalog and not the others

With one mmap per activation, sized exactly and rounded to the 64 KiB page:

    php.wasm      76,100 bytes -> 2 pages      131,072
    intl.so       31,000 bytes -> 1 page        65,536
    curl.so        3,892 bytes -> 1 page        65,536
    zip.so         1,228 bytes -> 1 page        65,536
    phar.so          852 bytes -> 1 page        65,536
    opcache.so       648 bytes -> 1 page        65,536
    zend_test.so     552 bytes -> 1 page        65,536
                                   total       524,288

524,288 bytes mapped to hold 114,272 bytes of content: **78% waste**. Six of
the seven activations are under 31 KiB and each still burns a whole page.

One aggregate mapping of 114,272 bytes rounds to 131,072 -- **13% waste**.

The waste is a function of HOW MANY SEPARATE MAPPINGS are made, not of mmap's
granularity. That is the concrete form of "I don't want any mmappings to be
unnecessarily large", and it splits the three catalogs by one property: how
large one activation's content is relative to a page.

  * resume catalog: 552 bytes to 76 KB per activation, aggregate over 100 KB.
    Mapping strategy dominates.
  * GC codec: 16 bytes today, unknown later. Mapping strategy is irrelevant at
    today's sizes; the only real question is what it should be sized for.
  * exception tags: 0 to 16 bytes, structural ceiling around 5 records. Will
    never approach a page under any guest.

### Knowing the resume aggregate ahead of time

Three mechanisms, none chosen, listed with their costs:

  1. BUILD-TIME MANIFEST. The VFS image builder already enumerates every `.so`
     it ships and each count is a 12-byte header read, so the sum is free at
     image-build time. But it is an upper bound over what MIGHT load, not what
     does -- php selects extensions from `php.ini` -- and it cannot cover an
     object built at runtime.
  2. SCAN AT EXEC. Enumerate the program's extension directory and sum. This
     puts program-specific knowledge in the kernel, which reads as squarely
     against the platform-values contract. Accept or reject on contract
     grounds, not performance.
  3. DO NOT PREDICT; AMORTIZE. One region, geometric growth: on overflow map
     the next power of two, `memory.copy` the contents over, unmap the old.
     php would grow about twice, copying at most 64 KiB each time. Waste
     converges on the aggregate case without needing the aggregate.

What makes (3) cheap here is that the data is append-only and nothing reads it
during seeding except the `ACT_*_INDEX` entries, which hold absolute addresses
and would need rewriting on each move -- at most 64 of them.

NOT MEASURED: the wall-clock cost of a 64 KiB `memory.copy` or of a
`channel_mmap` round trip. Without those, option 3's cost is an argument, not
a number, and nothing here should be decided on it.
