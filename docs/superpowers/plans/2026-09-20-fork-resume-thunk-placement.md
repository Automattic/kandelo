# Fork Resume-Thunk Placement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move resume-thunk placement out of the host and into the fork
module, so the slot numbering the module already decides is also applied by
the module, and the host's per-thunk round-trip collapses to one call per
activation. The host still calls in; what goes away is asking the module
where each individual thunk belongs -- 19,025 queries per php process start,
each answered by a linear scan over up to 28,568 entries.

**Architecture:** The fork module already OWNS and exports the resume table
and already decides every slot. The thunks live in each guest's own
`__wpk_fork_resume_catalog`, which the module cannot import because it is
instantiated before any guest exists — but the GUEST's table index space
already holds both tables: it owns the catalog and imports the resume table
(`crates/fork-instrument/src/runtime.rs:469-471`), and `fork-instrument`
already injects code that `call_indirect`s the resume table
(`instrument.rs:4087-4111`). So the copy belongs in an injected guest shim
reading the module's slot assignment, NOT in a host-owned mirror. The module
keeps the policy; the shim is a mechanical primitive, exactly as
`__wpk_fork_table_apply` is on the module side. `fm_resume_slots` op 0 and
`resume_slot_of` then have no callers and are deleted, and no new host
TypeScript is created.

**Tech Stack:** Rust (`no_std` PIC wasm side module), walrus (wasm injection),
TypeScript (host + Vitest), Rust integration tests (`crates/host-native`).

**Spec:** `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`
— decision 12, as corrected by the two amendment sections at the end of that
document. **Read those amendments before the decision itself**; decision 12's
stated mechanism is superseded and its original text is preserved only because
the amendment argues against it.

## Global Constraints

- ABI is **44** (`crates/shared/src/lib.rs:122`), unreleased, and this lane is
  already defining its contents. **No separate `ABI_VERSION` bump is required
  for this change** -- it lands inside an in-progress bump. What Task 7 still
  answers is the narrower question of whether `abi/snapshot.json` moves at
  all; the fork module's own imports appear nowhere in it, so an empty diff is
  the expected outcome and is itself the deliverable.
- Run `cd host && npx vitest run test/surface-budget.test.ts` before **every**
  commit and gate on its exit status, not grep output. **Never raise a ceiling
  to make a check pass.** Note `forkTypeScript` and `forkPlatformTypeScript`
  both carry `slack: 0`, so a net-positive line change requires editing
  `docs/surface-budget.json` in the same commit with a recorded reason — and
  this change should REDUCE `forkPlatformTypeScript`, which the budget test
  also flags.
- **Run host tests from `host/`, never the repo root.** There is no root
  vitest config; a repo-root run silently drops `testTimeout: 30_000`, the
  `forks` pool, and `globalSetup`.
- **Never run vitest while a build is running**, and never edit a file under
  `packages/registry/` while `xtask local-build` is live. This is a WORKAROUND
  for a defect, not a property to design around: `host/test/global-setup.ts:306-311`
  regenerates `packages/registry/program-packages.json` -- a build-graph input
  -- on every vitest invocation, so the test runner mutates the build graph
  merely by running. A test suite should be isolated from build machinery.
  Tracked in `docs/future-improvements.md` under Build freshness; if that is
  fixed before this plan executes, drop this constraint rather than preserving
  it out of habit.
- After changing `crates/fork-module/src/**` or `crates/fork-module-inject/src/**`,
  rebuild with `bash crates/fork-module/build-wasm.sh` and confirm
  `--verify-fresh` exits 0. Confirm the build key CHANGED after a
  perturbation; an unchanged key means the perturbation never reached the
  artifact.
- **Perturb every new guard until it fails**, then restore from a pristine
  copy taken first — never `git checkout --`, which silently discards
  uncommitted work and leaves built artifacts stale while `git status` looks
  clean.
- Commit subject begins `Area: Purpose`; subject and body wrap at 72 columns.
  Gate any wrap checker on EXIT STATUS: `awk 'length($0) > 72 { print; n++ }
  END { if (n) exit 1 }'` and check `$?`.
- Work on branch `brandonpayton/lane-f-fork-inversion` (or its successor).
  Push after every commit. Trailer on every commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Two pre-existing unrelated modifications may be present
  (`apps/browser-demos/test-results/.last-run.json`, `libc/musl`). Never
  `git add -A`; stage explicit paths. `libc/musl` is dirty content inside the
  submodule, not a pointer move.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `crates/fork-module/src/lib.rs:498-505` | a comment asserting per-activation resume tables; corrected if Task 0 finds it stale | 0 |
| `host/test/fork-resume-placement-baseline.test.ts` | NEW: records where every activation's thunks land today, as the before/after comparison the spec calls "the test that matters" | 1 |
| `crates/fork-module/src/lib.rs` | placement-assignment publication; deletion of `resume_slot_of` and op 0 | 3, 6 |
| `crates/fork-instrument/src/instrument.rs` | NEW injected guest shim that copies catalog thunks into the imported resume table | 2 |
| `crates/fork-module/src/lib.rs` | publishes the slot assignment where the shim can read it | 3 |
| `crates/fork-module/src/lib.rs` | the `fm_place_resume_thunks` entry itself | 4 |
| `host/src/fork-module-backend.ts` | the host wrapper that calls that entry | 5 |
| `host/src/worker-main.ts` | calls placement after the guest instance exists, at both worker sites | 5 |
| the invocation site named by Task 0 | drives placement once per activation, after the guest instance exists | 4 |
| `host/src/fork-resume-table.ts` | loses `Table.set`; becomes release-only | 5 |
| `crates/host-native/src/guest.rs` | stops minting its own table and numbering slots | 6 |
| `crates/host-native/src/lib.rs` | the host-obligation pin moves with the entry list | 6 |

---

## Task 0: Establish the two facts the rest of this plan assumes

Tasks 2 through 5 are built on two assumptions that have not been checked
against a running instance. Both are cheap to settle and expensive to get
wrong, so they are settled FIRST, alone, before anyone writes a harness or a
mirror.

**Assumption 1 — the resume table is ONE module-owned object.**
`crates/fork-module/src/lib.rs:498-505` says "activation 0's table and
activation 1's table are distinct JS `WebAssembly.Table`s with independent
slot spaces", while `crates/fork-module-inject/src/main.rs:130-134` says the
resume table is "OWNED and exported by the module … one object". Both cannot
be true now. The likeliest reading is that the module comment predates the
move recorded at `main.rs:1037-1041` and was never updated — but this decides
whether one slot space is a deletion or a redesign.

**Assumption 2 — there is a single natural site to fill the mirror from.**
Task 5 must fill the merged mirror before calling placement. The activation
sink at `host/src/fork-activations.ts:106-116` drives the equivalent fill for
the function catalog, but the two worker sites
(`host/src/worker-main.ts:3905-3915` for the process worker, `:6510-6520` for
the pthread worker) call it in OPPOSITE order relative to catalog
publication — `:1034`/`:1042` versus `:4654`/`:4662`. Which site owns the fill
determines where Task 5 edits.

**Files:**
- Read: `crates/fork-module/src/lib.rs`, `crates/fork-module-inject/src/main.rs`,
  `host/src/fork-activations.ts`, `host/src/worker-main.ts`
- Modify: `crates/fork-module/src/lib.rs:498-505` (comment only, and only if
  Task 0 finds it stale)

**Interfaces:**
- Produces: a written answer to both assumptions, recorded in the task report
  and — for assumption 1 — as a corrected comment in the source. Tasks 1
  through 5 consume both.

- [ ] **Step 1: Settle the table-identity question against a running instance**

Do not infer this from comments; both comments are evidence and they disagree.
Run an existing multi-activation fork test and inspect the instance. The fork
module's exported tables are reachable from the instance record
(`host/src/fork-module-instance.ts:59-61`, `:313-315`), and the guest's
imports are bound at `host/src/fork-guest-imports.ts:140-149`.

The question to answer precisely: when two activations are loaded, do their
guests import the SAME `WebAssembly.Table` object, or two different ones?
Object identity (`===`), not structural equality.

- [ ] **Step 2: Record the answer and act on it**

If ONE object: `lib.rs:498-505` is stale. Correct it in this task, saying what
is true now and noting that the per-activation catalog machinery it justifies
(`fm_set_activation_resume_catalog`, `register_activation_slots`) is therefore
a candidate for deletion by the storage change that follows — flag it, do not
delete it here.

If TWO objects: **STOP AND REPORT.** Tasks 2 through 5 assume one table. A
per-activation reality means the module cannot own placement the way this plan
describes, and the plan needs rewriting rather than adapting.

- [ ] **Step 3: Name the mirror-fill site**

Read `host/src/fork-activations.ts:106-116` and both worker sites. State which
owns the fill for the function catalog today, and whether the resume mirror
can follow the same path or needs its own. Name the exact file and line Task 5
will edit. If the two worker sites genuinely differ in ordering, say what the
correct order is for a mirror that must be full BEFORE placement runs.

- [ ] **Step 4: Commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add crates/fork-module/src/lib.rs
git commit -m "Fork: Correct what the resume table's ownership actually is"
git push origin brandonpayton/lane-f-fork-inversion
```

If Step 2 found nothing to correct, commit nothing and say so in the report —
a task whose finding is "the comment was right" produces a report, not a
commit.

---

## Task 1: Record where thunks land today

Nothing in the tree can produce the before/after comparison the spec requires.
Build it against unmodified code, so the baseline is trustworthy, and build it
knowing Task 0's answer to the table-identity question.

**Files:**
- Create: `host/test/fork-resume-placement-baseline.test.ts`

**Interfaces:**
- Produces: a JSON baseline artifact at
  `.superpowers/sdd/2026-09-20-fork-resume-thunk-placement/placement-baseline.json`
  mapping `activation id -> [{ordinal, slot}]`, consumed by Task 7's
  verification.

- [ ] **Step 1: Find a fixture that produces more than one activation**

```bash
cd /Users/brandon/kandelo-lane-f
grep -rln "dlopen" host/test/fork-*.test.ts
```

Pick one that loads at least two activations — the dlopen side-module e2e
tests are the candidates. Record which you chose and why.

- [ ] **Step 2: Write the baseline test**

The test must, for a multi-activation fork fixture, capture for each
activation the ordinal→slot mapping the module currently assigns, and write it
to the JSON path above. Read it back from the live `WebAssembly.Table` the
module exports — not from `fm_resume_slots`, because that entry is being
deleted and a baseline that depends on it cannot outlive the change.

```ts
// WHY THIS EXISTS: the spec says the test that matters for this change is
// "that every activation's thunks land at the same slots they do now -- a
// before/after comparison, not a new assertion". Nothing could produce that
// comparison before this file. It reads the resume TABLE rather than asking
// `fm_resume_slots`, because op 0 is deleted by this same change.
```

- [ ] **Step 3: Run it and confirm the baseline is stable**

```bash
cd host && npx vitest run test/fork-resume-placement-baseline.test.ts
```

Run it TWICE and confirm the recorded mapping is identical both times. A
baseline that varies between runs is not a baseline — if the mapping moves,
stop and report what varied, because the comparison Task 5 depends on would
be meaningless.

- [ ] **Step 4: Commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add host/test/fork-resume-placement-baseline.test.ts
git commit -m "Fork: Record where resume thunks land before moving placement"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 2: Inject a placement shim into the guest

The guest's table index space already holds BOTH tables it needs: it owns
`__wpk_fork_resume_catalog` (emitted by
`crates/fork-instrument/src/instrument.rs:4456-4489`) and imports the module's
resume table (`crates/fork-instrument/src/runtime.rs:469-471`). So the copy
that today crosses into JS — `table.get` the thunk, `table.set` it at its
slot — is two instructions inside the guest.

This is a mechanical primitive, not policy. The module still decides every
slot; the shim only applies the decision, exactly as
`__wpk_fork_table_apply` does on the module side
(`crates/fork-module-inject/src/main.rs:2101-2108`: "Rust cannot emit
`table.set` on an imported table … only the write itself lives in emitted
wasm").

**Files:**
- Modify: `crates/fork-instrument/src/instrument.rs`
- Modify: `crates/fork-instrument/src/runtime.rs` (name constant)
- Test: `crates/fork-instrument`'s own test module, plus
  `host/test/fork-instrument-coverage.test.ts` for the end-to-end shape

**Interfaces:**
- Produces: a guest export `__wpk_fork_place_resume_thunks(ptr: i32, count: i32) -> i32`,
  returning the number of thunks placed. `ptr` addresses `count` packed
  `(ordinal: u32, slot: u32)` pairs in shared linear memory, written by the
  module in Task 3.

- [ ] **Step 1: Read the two precedents before writing any injection**

```bash
sed -n '4456,4495p' crates/fork-instrument/src/instrument.rs   # emit_resume_catalog
sed -n '4080,4120p' crates/fork-instrument/src/instrument.rs   # the existing call_indirect on resume_table
```

The second is the proof the resume table is reachable from injected guest
code. Confirm both table IDs are available in the same `runtime` struct
(`crates/fork-instrument/src/runtime.rs:255-257` holds `resume_table`), and
say in your report which field gives you the catalog.

- [ ] **Step 2: Write the failing test first**

Assert that after calling the new export with a two-entry assignment, the
imported resume table holds, at each named slot, the SAME funcref object the
catalog held at that ordinal. Identity, not equality — a merely-equal funcref
would place a thunk that is not the guest's.

Assert also that an out-of-range ordinal or slot TRAPS rather than writing
elsewhere. Both bounds are wasm's own, which is the same argument
`main.rs:2107-2108` makes for `table_apply`: "an out-of-range `dest` or
`catalog_slot` traps rather than writing somewhere else." Do not add a
hand-rolled bounds check that would mask it.

- [ ] **Step 3: Run it and watch it fail**

Expected: FAIL — the export does not exist.

- [ ] **Step 4: Inject the shim**

A loop over `count` pairs: load `ordinal` and `slot` from `ptr`,
`table.get(catalog, ordinal)`, `table.set(resume, slot, ref)`. Emit it beside
the existing resume-catalog emission so the two stay together.

Note the table64 hazard `main.rs:2131-2136` records: a wasm64 build needs `i64`
widening on table indices, and its absence was caught by wasm64 validation
rather than by a test. If this instrument path serves both widths, handle it
and say how you verified.

- [ ] **Step 5: Rebuild the fixtures and re-run**

Instrumented guests must be rebuilt for the new export to exist. Say exactly
what you rebuilt.

- [ ] **Step 6: Perturb**

Change the shim to write `slot + 1`. The test must fail on identity at every
slot. Restore by hand from a pristine copy; never `git checkout --`.

- [ ] **Step 7: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add crates/fork-instrument/src/instrument.rs crates/fork-instrument/src/runtime.rs
git commit -m "Fork: Let the guest place its own resume thunks"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 3: Publish the slot assignment the shim reads

The module already holds every `(ordinal, slot)` decision — `resume_assignment_of`
(`crates/fork-module/src/lib.rs:778-791`) is the walk that survives this
change. This task writes that assignment somewhere the guest shim can read it,
and decides who invokes the shim.

The module and its guests are CO-RESIDENT in one `WebAssembly.Memory`, so a
pointer written by the module is directly readable by the guest. No copy
across a host boundary is required or wanted.

**Files:**
- Modify: `crates/fork-module/src/lib.rs`

**Interfaces:**
- Produces: `fm_publish_resume_assignment(activation: u32) -> i64`, returning
  a packed `(ptr, count)` — or -1 with errno set. The storage must survive the
  per-fork bump-heap reset, so it belongs in the same fixed BSS region the
  per-activation catalogs use, NOT in the bump heap
  (`reset_bump_heap` runs at four points during a single fork).

- [ ] **Step 1: Choose the storage and justify it against the reset**

Read why the existing catalogs are in fixed BSS (`crates/fork-module/src/lib.rs`,
the "Like the global catalog, these live in a fixed BSS region so they survive
the per-fork bump-heap reset" comment). State in your report where you put the
assignment buffer and why it survives.

- [ ] **Step 2: Decide the invocation path, and record the choice**

Two options, and this plan does not pick for you:

* **Host-invoked** — the host calls `fm_publish_resume_assignment`, then calls
  the guest's `__wpk_fork_place_resume_thunks(ptr, count)`. One host call per
  activation, replacing 19,025 per process start.
* **Module-driven** — the shim is registered in `__wpk_fork_drive_table` and
  the module `call_indirect`s it, the way it already drives guest code. Zero
  host calls, but it couples placement to the drive machinery.

Read how the drive table is populated today before choosing. Say which you
chose, what it costs, and what you would have needed to know to choose the
other. If module-driven turns out to be straightforward, prefer it — it is the
version with no host involvement at all, which is the campaign's direction.

- [ ] **Step 3: Write the failing test, implement, re-run**

Assert the published `(ptr, count)` describes exactly the assignment
`resume_assignment_of` reports for that activation, and that a second call
after a fork still returns a live buffer — the reset hazard is the reason
Step 1 exists.

- [ ] **Step 4: Rebuild, verify fresh**

```bash
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"   # 0
```

- [ ] **Step 5: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add crates/fork-module/src/lib.rs
git commit -m "Fork: Publish the resume-slot assignment for the guest shim"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 4: Wire the invocation and prove placement end to end

Tasks 2 and 3 built the two halves — a guest shim that can place, and a module
that publishes what to place. This task connects them at the path Task 3's
Step 2 chose, and proves the result matches the Task 1 baseline.

There is deliberately no module-side `table.set` here. An earlier draft of this
plan routed the thunks through a host-owned mirror and a new module import
table so the module could write them with `__wpk_fork_table_apply`. That was
wrong: it added host TypeScript to a campaign whose direction is removing it,
and it existed only because the draft had not noticed that the guest's own
index space already holds both tables.

**Files:**
- Modify: whichever invocation path Task 3 Step 2 selected — the module's
  drive-table registration, or the host call site named by Task 0
- Modify: `host/src/fork-module-backend.ts` (the wrapper, if host-invoked)
- Modify: `host/src/worker-main.ts` (the call site, if host-invoked)

**Interfaces:**
- Consumes: `__wpk_fork_place_resume_thunks(ptr, count)` (Task 2),
  `fm_publish_resume_assignment(activation)` (Task 3).

- [ ] **Step 1: Use Task 0's answer; do not re-derive it**

Task 0 named the invocation site and stated the correct ordering for the two
worker sites, which register activations in OPPOSITE order relative to catalog
publication (`host/src/worker-main.ts:1034`/`:1042` versus `:4654`/`:4662`).
Read Task 0's report and follow it. If its answer does not match what you see
in the code, STOP — one of you is wrong about a sequencing hazard, and
guessing which costs a silently mis-placed thunk.

- [ ] **Step 2: Connect the two halves at the chosen path**

If module-driven: register the shim in `__wpk_fork_drive_table` and invoke it
from the module after the assignment is published. If host-invoked: publish,
then call the guest export, once per activation, after the guest instance
exists.

The one fact to re-confirm yourself, because everything depends on it: the
guest instance is created at `host/src/worker-main.ts:4643-4652`, while slots
are assigned much earlier at `:3780`. Placement must happen after the former.

- [ ] **Step 3: Verify against the Task 1 baseline**

```bash
cd host && npx vitest run test/fork-resume-placement-baseline.test.ts
```

Expected: the mapping is IDENTICAL to the recorded baseline. This is the
comparison the spec calls "the test that matters". A difference is a
regression, not a new normal — do not re-record the baseline to make it pass.

- [ ] **Step 4: Confirm the host no longer writes the table**

```bash
grep -n "\.set(" host/src/fork-resume-table.ts
```

The per-thunk `Table.set` should now be unreachable. Do not delete it yet —
Task 5 does that, separately, so a placement regression stays attributable
from a deletion.

- [ ] **Step 5: Run the fork surface**

```bash
cd host && npx vitest run test/fork-*.test.ts
```

Compare against the last recorded baseline for that suite. Any new failure
must be understood before proceeding.

- [ ] **Step 6: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add -- ':!apps' ':!libc'
git status --short
git commit -m "Fork: Drive resume-thunk placement without the host writing it"
git push origin brandonpayton/lane-f-fork-inversion
```

Stage explicit paths rather than the pattern above if it stages anything you
did not touch; check `git status --short` before committing either way.

---

## Task 5: Make `ForkResumeTable` release-only

With placement gone, the class that was "not a slot ALLOCATOR" is no longer a
slot WRITER either. What remains is release.

**Files:**
- Modify: `host/src/fork-resume-table.ts`
- Modify: `host/test/fork-resume-table.test.ts`

- [ ] **Step 1: Delete the placement path and its `Table.set`**

Remove the per-thunk write loop and the op-0 query that fed it. Keep
`unregisterActivation` / `releaseResumeSlots` — the dlclose path
(`__wasm_dlclose` → `lk.dlclose` → `unregisterActivation` →
`prepared.unregister()` → `resumeTable.unregisterActivation` →
`releaseResumeSlots`) is unchanged by this plan.

- [ ] **Step 2: Rewrite the file header to match what it now does**

Its current header narrates a history that ends at "this class ASKS
(`fm_resume_slots`)". After this task it neither allocates nor writes nor
asks. Say that, and say what it still owns. A header describing a previous
version is the defect class this lane has repeatedly found.

- [ ] **Step 3: Update its tests, and report every contract you changed**

For each test whose expectation changes, record the original assertion, what
it encoded, and why the new contract is correct. A test edited to match new
code, without that record, hides a decision.

- [ ] **Step 4: Measure what actually moved, not just the line count**

This task is where the campaign's goal lands, so measure the goal rather than
its proxy. Line count is banked in Step 5; it is the CONSEQUENCE, not the
result.

**(a) Count the host's calls into the module, before and after.** The spec
quantifies today's cost as 19,025 `fm_resume_slots` op-0 queries per php
process start, each answered by a linear scan over up to 28,568 entries. Pick
a multi-activation fixture you can actually run, instrument the boundary, and
report the real number for that fixture both before this change and after.
A before/after pair on a small fixture is worth more than php's number quoted
from a document — quote php only as context, and say it is quoted.

**(b) Audit what is left for RULES, not lines.** Go through every remaining
member of `ForkResumeTable` and classify it: does it implement a rule the
module could own (an allocation policy, an ordering, a numbering, a retry), or
does it only hold a reference and forward a lifetime event? The file's own
history says it "used to be" a slot allocator and stopped; the question this
task answers is whether anything of that kind survives.

Any surviving rule is a FINDING, not a leftover. Report it with the reason it
could not move, because "the host still decides X" is precisely the claim this
campaign exists to retire, and a rule nobody noticed is how one survives.

**(c) State the end condition plainly.** After this task, is the host out of
the resume-slot business entirely, or does it retain something? Write the
answer in one sentence. If the honest answer is "it still does Y", that
sentence is more valuable than the diffstat.

- [ ] **Step 5: Budget, then commit**

```bash
cd host && npx vitest run test/fork-resume-table.test.ts
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
```

This should REDUCE `forkPlatformTypeScript`. The budget test fails on
reductions too, so lower the ceiling in `docs/surface-budget.json` in the same
commit and record the reduction as banked — with Step 4's measurement, not the
line delta alone, as the reason.

```bash
cd .. && git add host/src/fork-resume-table.ts host/test/fork-resume-table.test.ts docs/surface-budget.json
git commit -m "Fork: Retire the host's resume-slot writer"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 6: Delete op 0 and `resume_slot_of`, and convert the native host

**Files:**
- Modify: `crates/fork-module/src/lib.rs` (delete the op-0 arm and
  `resume_slot_of`)
- Modify: `crates/host-native/src/guest.rs:8155-8196`
- Modify: `crates/host-native/src/lib.rs:1379` (`fork_module_host_obligation_is_pinned`,
  exact-list assert at `:1513-1521`)

- [ ] **Step 1: Prove op 0 has no callers left**

```bash
grep -rn "fm_resume_slots" host/src crates --include=*.ts --include=*.rs | grep -v node_modules
```

Every remaining hit must be op 1 (release) or the entry's own definition. If
any op-0 caller survives, it fails at INSTANTIATION rather than at use once
the arm is gone — so this grep is the guard, not the test suite.

- [ ] **Step 2: Delete the arm and the linear scan**

`resume_slot_of` is the function the spec cites as "about 10^8 comparisons per
process start" for php. It exists only to answer op 0.

- [ ] **Step 3: Convert the native host**

`crates/host-native/src/guest.rs:8155-8196` mints its own resume table and
numbers slots `i+1` itself, never consulting the module. Once the module owns
placement, that path imports a table nobody fills. Make it use the module's
table and placement entry. This was not named in the spec and is in scope.

```bash
cargo test -p wasm-posix-host-native
```

- [ ] **Step 4: Move the host-obligation pin**

`fork_module_host_obligation_is_pinned` asserts an exact list. It SHOULD go
red when the entry set changes — that is its job. Update it to the new set and
say in the commit what moved and why.

- [ ] **Step 5: Rebuild, verify fresh, run both suites**

```bash
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"
cd host && npx vitest run test/fork-*.test.ts
cd .. && cargo test -p wasm-posix-host-native
```

- [ ] **Step 6: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add crates/fork-module/src/lib.rs crates/host-native/src/guest.rs crates/host-native/src/lib.rs
git commit -m "Fork: Delete the resume-slot query and its linear scan"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 7: Settle whether the ABI snapshot moves

The spec said "ABI snapshot regenerated". That does not follow, and this task
answers it rather than assuming either way.

**No `ABI_VERSION` bump is in scope.** ABI 44 is unreleased and this lane is
already defining its contents, so this change lands inside an in-progress
bump. Do not bump, and do not ask whether to -- that question is already
answered. What remains is purely whether `abi/snapshot.json` moves.

**Files:**
- Possibly modify: `abi/snapshot.json`

- [ ] **Step 1: Regenerate the snapshot and diff it**

Find the generator (`tools/xtask/src/dump_abi.rs` is the source; locate the
verb rather than guessing) and run it. Diff the result.

- [ ] **Step 2: Decide, and record the reasoning**

`required_imports` lives at `/program_artifact/fork_instrumentation/required_imports`
and describes the GUEST's `env` imports. The fork module's own tables appear
nowhere in the snapshot. So an empty diff is the expected outcome.

If the diff IS empty: record that the ABI surface did not move, and why —
`required_imports` describes the guest's `env` imports, and the fork module's
own tables are not in the snapshot. An empty diff with that reasoning written
down is the deliverable; it retires a claim the spec made.

If the diff is NOT empty: the research was wrong. Report what moved and stop —
an unexpected snapshot change means something about this design reaches
further than anyone established, and that is worth a maintainer's attention
before it lands, even inside an in-progress ABI.

- [ ] **Step 3: Commit whatever the answer was**

Including the case where nothing changed — a recorded "the ABI did not move,
and here is the diff proving it" is the deliverable.

---

## What this plan does NOT cover

- **Change 3, the storage conversion.** Its plan is written after this one
  lands, because this change turns `RESUME_SLOT_INDEX` from a randomly
  accessed store into a walk-only one, which the spec calls "the hardest
  conversion in the storage change, made easy". Sizing those eleven
  conversions before this lands would repeat the ordering mistake the spec
  exists to prevent.
- **The per-activation catalog machinery.** If Task 1 finds the resume table
  is genuinely one object, `fm_set_activation_resume_catalog`,
  `register_activation_slots` and the flat ordinal arena become removable —
  but that is a deletion Change 3 should make alongside the `CatalogCell`
  merge it already plans, not a side effect of this change.
- **The dangling D5 citation.** `crates/fork-module/src/lib.rs` cites
  D5 section "Other couplings" item 1 for the resume-slot parity contract;
  `"Other couplings"` appears nowhere else in the repository. Worth fixing,
  not here.
