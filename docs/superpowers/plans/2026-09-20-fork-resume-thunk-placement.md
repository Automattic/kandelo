# Fork Resume-Thunk Placement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move resume-thunk placement out of the host and into the fork
module, so the slot numbering the module already decides is also applied by
the module, and the per-thunk host round-trip disappears.

**Architecture:** The fork module already OWNS and exports the resume table,
and already has a wasm primitive for writing a funcref into a table
(`__wpk_fork_table_apply`). What it lacks is a reachable SOURCE of thunk
funcrefs: they live in each guest instance's own `__wpk_fork_resume_catalog`,
and the module is instantiated before any guest exists. This adds a host-owned
merged mirror of those catalogs — the pattern `ForkMergedFunctionCatalog`
already uses — plus one placement entry point called after the guest instance
is created. `fm_resume_slots` op 0 and `resume_slot_of` then have no callers
and are deleted.

**Tech Stack:** Rust (`no_std` PIC wasm side module), walrus (wasm injection),
TypeScript (host + Vitest), Rust integration tests (`crates/host-native`).

**Spec:** `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`
— decision 12, as corrected by the two amendment sections at the end of that
document. **Read those amendments before the decision itself**; decision 12's
stated mechanism is superseded and its original text is preserved only because
the amendment argues against it.

## Global Constraints

- ABI is **44** (`crates/shared/src/lib.rs:122`) and unreleased. Whether this
  change needs a bump is a QUESTION FOR TASK 8, not an assumption: the fork
  module's own imports appear nowhere in `abi/snapshot.json`, so a
  regeneration may produce an empty diff.
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
  `packages/registry/` while `xtask local-build` is live. `host/test/global-setup.ts:306-311`
  regenerates `packages/registry/program-packages.json` — a build-graph input —
  on every vitest invocation.
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
| `host/test/fork-resume-placement-baseline.test.ts` | NEW: records where every activation's thunks land today, as the before/after comparison the spec calls "the test that matters" | 1 |
| `crates/fork-module/src/lib.rs` | comment correction; placement entry; deletion of `resume_slot_of` and op 0 | 1, 5, 7 |
| `host/src/fork-merged-resume-catalog.ts` | NEW: host-owned merged mirror of per-activation guest resume catalogs | 2 |
| `crates/fork-module-inject/src/main.rs` | declares the mirror import table for the module | 3 |
| `host/src/fork-module-instance.ts` | creates and binds the mirror table; re-exports it on the instance record | 3 |
| `crates/fork-module/src/lib.rs` + `host/src/fork-module-backend.ts` | the `fm_place_resume_thunks` entry and its host wrapper | 4, 5 |
| `host/src/fork-resume-table.ts` | loses `Table.set`; becomes release-only | 6 |
| `crates/host-native/src/guest.rs` | stops minting its own table and numbering slots | 7 |
| `crates/host-native/src/lib.rs` | the host-obligation pin moves with the entry list | 7 |

---

## Task 1: Record where thunks land today, and settle a stale comment

Nothing in the tree can produce the before/after comparison the spec requires.
Build it first, against unmodified code, so the baseline is trustworthy.

This task also settles a contradiction. `crates/fork-module/src/lib.rs:498-505`
says "activation 0's table and activation 1's table are distinct JS
`WebAssembly.Table`s with independent slot spaces", while
`crates/fork-module-inject/src/main.rs:130-134` says the resume table is
"OWNED and exported by the module … one object". Both cannot be true now. The
likeliest reading is that the module comment predates the move recorded at
`main.rs:1037-1041` and was never updated — but it decides whether one slot
space is a deletion or a redesign, so it must be CHECKED, not inferred.

**Files:**
- Create: `host/test/fork-resume-placement-baseline.test.ts`
- Modify: `crates/fork-module/src/lib.rs:498-505` (comment only, if stale)

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

- [ ] **Step 3: Answer the stale-comment question and record it**

With the fixture running, determine whether the resume table is ONE
module-owned object shared by all activations, or one per activation. Inspect
the live instance:

```bash
cd host && npx vitest run test/fork-resume-placement-baseline.test.ts
```

Report which it is, with the evidence. If `lib.rs:498-505` is stale, correct
it in this task and say so; if it is accurate, STOP and report — the rest of
this plan assumes one table, and a per-activation reality changes Tasks 2-5.

- [ ] **Step 4: Commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add host/test/fork-resume-placement-baseline.test.ts crates/fork-module/src/lib.rs
git commit -m "Fork: Record where resume thunks land before moving placement"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 2: A merged mirror of the guests' resume catalogs

The module cannot import N per-activation tables because it is instantiated
before any guest exists. `ForkMergedFunctionCatalog` solves exactly this for
the function catalog; its header says so verbatim: "The module is instantiated
BEFORE its guests … so it cannot import a guest's
`__wpk_fork_function_catalog` directly."

The resume thunks are NOT in that existing mirror. Verified two ways:
`inject_function_catalog` runs at `crates/fork-instrument/src/lib.rs:444`,
before `instrument_functions_with_targets_and_tail_sites` at `:485` creates
the thunks; and a built artifact carries them as separate exports
(`__wpk_fork_function_catalog` is table[3], `__wpk_fork_resume_catalog` is
table[7] in `p_11_fork_continuation_enomem.wasm`). So this needs its own
mirror.

**Files:**
- Create: `host/src/fork-merged-resume-catalog.ts`
- Test: `host/test/fork-merged-resume-catalog.test.ts`

**Interfaces:**
- Consumes: `forkResumeTargetsFromInstance` (`host/src/fork-resume-catalog.ts:117-146`),
  which reads a guest instance's `__wpk_fork_resume_catalog` by
  `table.get(localCatalogSlot)`.
- Produces: `ForkMergedResumeCatalog` with
  `take(activation: number, instance: WebAssembly.Instance): number` returning
  the base index at which that activation's thunks were copied.

- [ ] **Step 1: Read the precedent in full before writing**

```bash
cd /Users/brandon/kandelo-lane-f
sed -n '1,60p' host/src/fork-merged-catalog.ts
```

Copy its shape: grow the mirror, copy the guest table slot-by-slot preserving
funcref identity (its `:20-22` explains why identity matters), return the base.
Do NOT invent a different structure.

- [ ] **Step 2: Write the failing test**

Assert that two activations' catalogs land at disjoint ranges, that the base
returned for activation B equals activation A's length, and that a funcref
read back from the mirror is IDENTICAL (`toBe`, not `toEqual`) to the one in
the source guest table. Identity is the property that matters — a copied
funcref that is merely equal would place a thunk that is not the guest's.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd host && npx vitest run test/fork-merged-resume-catalog.test.ts
```

Expected: FAIL — the module does not exist yet.

- [ ] **Step 4: Implement, then re-run**

Expected: PASS.

- [ ] **Step 5: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add host/src/fork-merged-resume-catalog.ts host/test/fork-merged-resume-catalog.test.ts
git commit -m "Fork: Mirror guest resume catalogs where the module can reach them"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 3: Give the module an import table for the mirror

`crates/fork-module/src/lib.rs` declares ZERO real wasm table imports — its
comment at `:182-191` records why ("a reference-typed call Rust/LLVM cannot
emit"). All four existing tables are created by the injector.

**Files:**
- Modify: `crates/fork-module-inject/src/main.rs` (new import table)
- Modify: `host/src/fork-module-instance.ts:228-237`, `:264-266`, `:59-61`, `:313-315`

**Interfaces:**
- Produces: an `env` funcref import table named `__wpk_fork_resume_source`,
  initial 0, no maximum, and a `resumeSource: WebAssembly.Table` field on the
  `ForkModuleInstance` record.

- [ ] **Step 1: Declare the import table in the injector**

Follow the drive-table call shape exactly (`main.rs:1009-1016`):

```rust
    let (resume_source, _resume_source_import_id) = module.add_import_table(
        IMPORT_MODULE,
        RESUME_SOURCE_IMPORT,
        false,
        0,
        None,
        RefType::FUNCREF,
    );
```

with a constant beside the existing ones, and a comment saying WHY it is an
import while the resume table beside it is module-owned: the destination is
one object the module numbers, the source is a per-activation guest table the
module cannot import, so the host mirrors it.

- [ ] **Step 2: Create and bind it on the host**

`host/src/fork-module-instance.ts` already has the helper:

```ts
  const emptyTable = (element: "anyfunc" | "anyref"): WebAssembly.Table =>
    new WebAssembly.Table({ element: element as "anyfunc", initial: 0 });
```

Add `const resumeSource = emptyTable("anyfunc");`, bind
`__wpk_fork_resume_source: resumeSource` alongside the three existing table
imports at `:264-266`, and re-export it on the instance record at `:59-61`
and `:313-315`.

- [ ] **Step 3: Rebuild and verify freshness**

```bash
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"   # 0
```

- [ ] **Step 4: Confirm the import is satisfied**

```bash
cd host && npx vitest run test/fork-module-instance.test.ts
```

Expected: PASS. An unsatisfied import fails at instantiation, so a green run
here is the proof the binding is correct.

- [ ] **Step 5: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add crates/fork-module-inject/src/main.rs host/src/fork-module-instance.ts
git commit -m "Fork: Import the merged resume source into the module"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 4: Place the thunks from inside the module

**Files:**
- Modify: `crates/fork-module/src/lib.rs` (new `fm_place_resume_thunks` entry)
- Modify: `crates/fork-module-inject/src/main.rs` if the write shim needs a
  second instantiation

**Interfaces:**
- Produces: `fm_place_resume_thunks(activation: u32, base: u32) -> i32`,
  returning the number of thunks placed, or -1 with errno set.
- Consumes: `__wpk_fork_table_apply(dest, catalog_slot, clear)`, the existing
  write primitive (`crates/fork-module-inject/src/main.rs:2101-2108`:
  "Rust cannot emit `table.set` on an imported table, so the fork module
  declares `__wpk_fork_table_apply(dest, catalog_slot, clear)` as an import
  and this replaces it with the three instructions it stands for").

- [ ] **Step 1: Read the write primitive and confirm its source table**

```bash
sed -n '2101,2170p' crates/fork-module-inject/src/main.rs
```

`table_apply` reads from one table and writes to another. Establish which
tables it is wired to today and whether it can be pointed at the new
`__wpk_fork_resume_source` → `__wpk_fork_resume_table` pair, or whether a
second shim instance is needed. Report which, with the line evidence. Do NOT
guess: a shim wired to the wrong source silently places the wrong funcref,
which is the failure mode this whole change exists to make impossible.

- [ ] **Step 2: Grow the destination before writing**

The resume table starts at initial 1 (slot 0 is the reserved "no resume event"
sentinel — `main.rs:1030-1032`). Growth uses the same pattern as
`inject_transit_grow` (`main.rs:1569-1624`). Confirm whether a resume-table
grow shim already exists; if not, add one following that precedent exactly.

- [ ] **Step 3: Write the entry, with a test that fails first**

The entry walks the activation's assignment (the walk that survives,
`resume_assignment_of` at `lib.rs:778-791`), and for each `(ordinal, slot)`
calls the write primitive with `dest = slot`, `catalog_slot = base + ordinal`.

Write a module-level test asserting the destination table holds the expected
funcref at each slot after the call, and that it returns the count. Run it,
watch it fail, then implement.

- [ ] **Step 4: Rebuild, verify fresh, re-run**

```bash
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"
cd host && npx vitest run test/fork-module-instance.test.ts
```

- [ ] **Step 5: Perturb**

Change the entry to write `slot + 1` instead of `slot`. The baseline
comparison from Task 1 must go red. Restore by hand from a pristine copy,
rebuild, and confirm the build key returns to its pre-perturbation value.

- [ ] **Step 6: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add crates/fork-module/src/lib.rs crates/fork-module-inject/src/main.rs
git commit -m "Fork: Place resume thunks from inside the module"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 5: Switch the host to call placement, keeping op 0 alive

Land the switch and the deletion separately, so a placement regression is
attributable without also bisecting a deletion.

**Files:**
- Modify: `host/src/fork-module-backend.ts` (wrapper for the new entry)
- Modify: `host/src/worker-main.ts` (call placement after guest instantiation)
- Modify: `host/src/fork-activations.ts` if the mirror fill belongs in the
  existing activation sink

**Interfaces:**
- Consumes: `ForkMergedResumeCatalog.take` (Task 2),
  `fm_place_resume_thunks` (Task 4).

- [ ] **Step 1: Find both call sites, and mind their ORDER**

The process worker and the pthread worker register activations in OPPOSITE
order relative to catalog publication — `host/src/worker-main.ts:1034`/`:1042`
versus `:4654`/`:4662`. Placement reads a mirror the host fills, so the order
matters. Read both and state what you found before editing either.

The guest instance whose catalog you mirror is created at
`host/src/worker-main.ts:4643-4652`; slots are assigned much earlier, at
`:3780`. Placement must happen after the former.

- [ ] **Step 2: Fill the mirror and call placement**

At each site, after the guest instance exists: `take()` the activation's
catalog into the mirror, then call the placement entry with the returned base.

- [ ] **Step 3: Verify against the Task 1 baseline**

```bash
cd host && npx vitest run test/fork-resume-placement-baseline.test.ts
```

Expected: identical mapping to the recorded baseline. This is the comparison
the spec calls "the test that matters". A difference here is a regression, not
a new normal — do not re-record the baseline to make it pass.

- [ ] **Step 4: Run the fork surface**

```bash
cd host && npx vitest run test/fork-*.test.ts
```

Compare against the last recorded baseline for that suite. Any new failure
must be understood before proceeding.

- [ ] **Step 5: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
cd .. && git add host/src/fork-module-backend.ts host/src/worker-main.ts host/src/fork-activations.ts
git commit -m "Fork: Let the module place thunks the host used to write"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 6: Make `ForkResumeTable` release-only

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

- [ ] **Step 4: Budget, then commit**

```bash
cd host && npx vitest run test/fork-resume-table.test.ts
cd host && npx vitest run test/surface-budget.test.ts > /tmp/b.txt 2>&1
echo "BUDGET_EXIT: $?"
```

This should REDUCE `forkPlatformTypeScript`. The budget test fails on
reductions too, so lower the ceiling in `docs/surface-budget.json` in the same
commit and record the reduction as banked.

```bash
cd .. && git add host/src/fork-resume-table.ts host/test/fork-resume-table.test.ts docs/surface-budget.json
git commit -m "Fork: Retire the host's resume-slot writer"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 7: Delete op 0 and `resume_slot_of`, and convert the native host

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

## Task 8: Decide the ABI question against the code

The spec said "ABI snapshot regenerated". That does not follow, and this task
answers it rather than assuming either way.

**Files:**
- Possibly modify: `crates/shared/src/lib.rs:122` (`ABI_VERSION`),
  `abi/snapshot.json`

- [ ] **Step 1: Regenerate the snapshot and diff it**

Find the generator (`tools/xtask/src/dump_abi.rs` is the source; locate the
verb rather than guessing) and run it. Diff the result.

- [ ] **Step 2: Decide, and record the reasoning**

`required_imports` lives at `/program_artifact/fork_instrumentation/required_imports`
and describes the GUEST's `env` imports. The fork module's own tables appear
nowhere in the snapshot. So an empty diff is the expected outcome.

If the diff IS empty: record that the ABI surface did not move, and state
whether an `ABI_VERSION` bump is still wanted as an epoch marker — that is a
maintainer decision, not an implementer one. **Stop and ask rather than
bumping or not bumping on your own judgment.**

If the diff is NOT empty: the research was wrong, the snapshot moves, and an
`ABI_VERSION` bump is required in the same commit per the ABI contract.

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
