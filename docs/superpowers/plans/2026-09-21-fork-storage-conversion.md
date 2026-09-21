# Fork-Module Storage Conversion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the co-resident fork module from reserving 2,395,460 bytes of
static memory out of every fork-capable THREAD's mmap window before it forks,
by moving eleven durable stores, the allocator floor and one guest-facing
transient onto chunk-and-chain storage that is allocated at first use during a
fork and released at `dlclose`. The per-instance, per-thread reservation goes
from **3,735,552 bytes to roughly 1,179,648** — and, for the first time, the
per-activation registries get a release path at all.

**Architecture:** One payload arena of never-moved, variable-size records
tagged `(activation_id, kind)`, plus a directory chain of fixed-size
`(activation_id, records_head)` entries. Records never move, so an address
published to a reader stays valid until the owning activation is released;
directory entries are fixed size, so they compact in place exactly as the
identity registry's do. Two more chains — the resume free-slot bitmap and the
guest-facing scratch stack — have their own roots for their own reasons. Every
chain follows `crates/fork-module/src/lib.rs:986-999`: the list lives IN the
chunks, never in a `Vec` that `ALLOC.reset()` reclaims.

**Tech Stack:** Rust (`no_std` PIC wasm side module, `crates/fork-module`),
TypeScript (host + Vitest, run from `host/`), Rust integration tests
(`crates/host-native`).

**Spec:** `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md` —
Change 3, "Storage conversion". **Read the two amendment sections at the end
before the decisions they supersede.**

**Research that overrides the spec:**
`.superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/change3-research.md`
— a read-only inventory taken against `a73642d7b`. It found twelve stale spec
claims and two findings the spec does not contain. **Where the research and
the spec disagree, the research is right.** Task 0 below carries everything
you need from it; do not re-derive those figures.

## What this plan assumes Change 2 has already landed

Change 2 is `docs/superpowers/plans/2026-09-20-fork-resume-thunk-placement.md`
— resume-thunk placement moved out of the host and into an injected guest
shim. **Do not start this plan until it has landed on the branch.** Three
specific consequences are load-bearing here:

1. **`fm_resume_slots` op 0 no longer exists.** `fm_resume_slots` has exactly
   one operation left — op 1, the per-activation release the host issues on
   `dlclose`. Every release path in this plan hooks there, beside the existing
   `release_identity_activation` call.
2. **`resume_slot_of(activation_id, ordinal)` is deleted.** It was the only
   reader of `RESUME_SLOT_INDEX` that needed `(activation, ordinal)` as a
   random-access key. Its removal is what makes Task 3 a walk-only conversion
   — the spec calls this "the hardest conversion in the storage change, made
   easy", and it is the only reason Task 3 is a conversion rather than a
   redesign.
3. **Access to the resume-slot store is walk-only.** The three surviving
   readers are `resume_register_impl` (append), `resume_unregister_impl`
   (remove one activation's entries) and `resume_assignment_of` (collect one
   activation's entries). All three are "everything belonging to activation
   A" or "append", which is exactly what a per-activation record serves.

**Change 2 also ADDS a static this plan must convert.** Its Task 3 creates
`fm_publish_resume_assignment`, whose buffer "belongs in the same fixed BSS
region the per-activation catalogs use, NOT in the bump heap". This plan's
Task 3 converts it. Its name is not knowable in advance, so Task 3 Step 1
greps for it.

Verify the assumption before Task 1:

```bash
cd /Users/brandon/kandelo-lane-f
grep -n "resume_slot_of\|=> match resume_slot_of" crates/fork-module/src/lib.rs
```

Expected: **no output**. If `resume_slot_of` still exists, Change 2 has not
landed — STOP and report, rather than converting a store around a lookup
pattern that is about to be deleted.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Run host tests from `host/`, never the repo root.** There is no root
  vitest config; a repo-root run silently drops `testTimeout: 30_000`, the
  `forks` pool and `globalSetup`, so it is not the same suite and its verdict
  does not transfer.
- **Never run vitest or Playwright while an `xtask local-build` closure is
  live**, and never edit a file under `packages/registry/` mid-closure.
  `host/test/global-setup.ts:306-311` regenerates
  `packages/registry/program-packages.json` — a build-graph input — on every
  vitest invocation, so the test runner mutates the build graph merely by
  running. Editing a registry file mid-closure invalidated a build plan and
  cost two hours. This is a WORKAROUND for a defect, tracked in
  `docs/future-improvements.md` under Build freshness; if it is fixed before
  this plan executes, drop the constraint rather than preserving it out of
  habit.
- **After changing `crates/fork-module/src/**`, rebuild and verify:**

  ```bash
  bash crates/fork-module/build-wasm.sh
  bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"   # must be 0
  ```

  And after any perturbation, **confirm the build key CHANGED**:

  ```bash
  cat local-binaries/fork_module32.wasm.build-key
  ```

  An unchanged key means the perturbation never reached the artifact, so the
  test you just ran did not test what you think it did.
- **The build key is derived from SOURCE, not environment.**
  `build-wasm.sh`'s `closure_sha()` folds the cargo closure of
  `fork-module,fork-module-inject` plus the recipe script. An
  `option_env!`-driven or `RUSTFLAGS`-driven build variant would produce
  different artifact bytes under an identical key — the exact stale-artifact
  defect the stamp exists to prevent. **The forced-chunk build in Task 12 is
  therefore a one-line SOURCE edit**, which moves the key, as the spec's own
  experiment confirmed (`6c9de4d1…` → `e504d969…`).
- **Perturb every new guard until it fails**, then restore from a pristine
  copy taken FIRST:

  ```bash
  cp crates/fork-module/src/lib.rs /tmp/claude-501/pristine-lib.rs
  # ... perturb, run, watch it fail ...
  cp /tmp/claude-501/pristine-lib.rs crates/fork-module/src/lib.rs
  ```

  **Never `git checkout -- <path>`.** It silently discards uncommitted work in
  that file AND leaves built artifacts stale while `git status` looks clean.
- **Run the surface-budget gate from `host/` before EVERY commit and gate on
  its EXIT STATUS with `&&`, never `;`:**

  ```bash
  cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
  ```

  **Never raise a ceiling to make a check pass.** If a ceiling must move, STOP
  and report rather than committing against a red gate. Note the budget test
  also fails on REDUCTIONS with `slack: 0`, so a commit that shrinks a surface
  lowers its ceiling in the same commit with a recorded reason. The surfaces
  this plan moves: `forkTypeScript` (ceiling 894, slack 0 — covers
  `host/src/fork-module-*.ts`), `forkModuleEntryPoints` (71, slack 2),
  `forkModuleHostEntries` (58, slack 2), `forkModuleEntriesWithoutProductionCaller`
  (2, slack 0 — **already at its ceiling, so this plan adds no test-only
  `fm_*` entry**).
- **The spec's testing requirement (decision 2):** the full suite must pass in
  BOTH the default build AND a build with every arena's first chunk forced
  small enough to chain. A conversion whose chunk path has not executed is not
  tested. The forced-spill build is proven practical: it ran 185 tests across
  29 files in about 25 minutes and surfaced two real defects invisible in the
  default build. Task 12 runs it.
- **Each new chain needs a leak observable of its own**, following
  `identity_chunk_count()` (`crates/fork-module/src/lib.rs:1186-1194`),
  asserted to return to zero after release. **The count alone is not a
  guard.** It walks the list, and release unlinks a chunk BEFORE the
  best-effort `channel_munmap` — so a chunk that is unlinked but never
  unmapped reads as zero, which is blind to exactly the leak the observable
  exists for. Assert the responder's `SYS_MUNMAP` tally beside it, one unmap
  per chunk, as `host/test/fork-identity-release.test.ts:145-205` already
  does. **Both halves, or neither is a guard.**
- **`fm_stats` field numbers for new observables start at 101.** 100 is
  `IDENTITY_CHUNK_COUNT_FIELD`, deliberately far above the reference table's
  contiguous index space so the next counter appended cannot shadow it
  (`crates/fork-module/src/lib.rs:10916-10929`). Use 101, 102, 103, 104 and
  keep the same gap reasoning. `host/test/fork-module-backend.test.ts` asserts
  these stay above `FORK_MODULE_STATS.length`.
- **ABI is 44, unreleased, and this lane is already defining its contents.**
  No separate `ABI_VERSION` bump is in scope. Task 6 removes an `fm_*` entry,
  which is an ABI change landing inside an in-progress bump — the spec
  establishes that as acceptable (decision 12, still standing on this point).
- Commit subject begins `Area: Purpose`; subject and body wrap at 72 columns.
  Gate a wrap check on EXIT STATUS:
  `awk 'length($0) > 72 { print; n++ } END { if (n) exit 1 }'` and check `$?`.
- Work on branch `brandonpayton/lane-f-fork-inversion` (or its successor).
  Push after every commit. Trailer on every commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Never `git add -A`; stage explicit paths.** Kandelo worktrees are shared
  and two real losses have happened this way. Two pre-existing unrelated
  modifications may be present (`apps/browser-demos/test-results/`,
  `libc/musl`). `libc/musl` is dirty content inside the submodule, not a
  pointer move.
- **Never `cargo fmt` a whole crate.** Kandelo is not rustfmt-clean;
  formatting `crates/fork-module` rewrites the file and buries the diff.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `crates/fork-module/src/lib.rs` (new module block, placed beside the identity registry at `:986`) | `arena_*`: the payload record arena, the directory chain, their two roots, their two observables, the per-activation and whole-arena release paths | 1 |
| `crates/fork-module/src/lib.rs:600-651, 733-763` | `free_bits_*`: the resume free-slot bitmap becomes a chain bounded by `RESUME_NEXT_SLOT` instead of a deleted `RESUME_SLOT_CAP` | 2 |
| `crates/fork-module/src/lib.rs:587-793` | `RESUME_SLOT_INDEX` → one arena record per activation; `RESUME_SLOT_CAP` deleted | 3 |
| `crates/fork-module/src/lib.rs:1401-1530` | `ACT_KFIG_BYTES` + `ACT_KFIG_INDEX` → arena records | 4 |
| `crates/fork-module/src/lib.rs:1877-1900, 2038-2110` | `ACT_GC_CODEC_*` + `ACT_EXN_TAGS_*` → arena records | 5 |
| `crates/fork-module/src/lib.rs:441-540, 664-673, 795-921, 7118-7160` | `CatalogCell` merged into the activation-keyed store; `fm_set_resume_catalog` and both legacy-harness branches removed | 6 |
| `host/src/fork-module-backend.ts:92, 215, 275, 367` | the host half of the catalog merge; `FORK_MODULE_RESUME_CATALOG_CAP` deleted | 6 |
| `crates/host-native/src/guest.rs:5551, 5564, 6296, 6510, 7058, 7639, 11220` | the native host's copies of the same contract | 6 |
| `host/src/fork-module-instance.ts:105-113, 210-214` | the staging slab, resized from a measurement | 7 |
| `crates/fork-module/src/lib.rs:1240-1254, 1555-1567, 1660-1670, 945-958, 1779-1790` | the five small per-activation stores → arena records | 8 |
| `crates/fork-module/src/lib.rs:3595-3640` | `HEAP_FLOOR` → 0; the retracted justification comment corrected | 9 |
| `crates/fork-module/src/lib.rs:3893-3899, 8507-8537` | `ScratchCell` → its own chain, with an abort hook at all four reset points | 10 |
| `crates/fork-module/src/lib.rs:8124-8135, 4716-4730` | `CapturedExternrefs` → bump heap, with the corrected ordering | 11 |
| `host/test/fork-arena-release.test.ts` | NEW: the arena's leak observable, chunk count AND munmap tally | 1 |
| `host/test/fork-arena-lifetime.test.ts` | NEW: release removes the directory entry, and a re-seed after release reads the NEW payload | 1 |
| `host/test/fork-arena-cow-scrub.test.ts` | NEW: a COW child's `fm_set_format` returns every chunk it inherited | 1 |
| `host/test/fork-resume-slot-bitmap.test.ts` | NEW: a freed slot beyond the first bitmap chunk is reused, not leaked | 2 |
| `host/test/fork-module-instance.test.ts` | the region assertion, already derivation-based; extended with the measured target | 13 |
| `docs/surface-budget.json` | ceilings lowered as surfaces shrink | 6, 7 |
| `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md` | the twelve stale claims corrected in place | 13 |

---

## Task 0: SETTLED — read this before Tasks 1-13

This is not a work item. It is what the research settled, and what this plan
decided on top of it. **Do not re-derive any of it.**

### A. The twelve stale spec claims

| # | The spec says | The truth |
|---|---|---|
| 1 | `host/src/fork-module-state.ts:2812` is the arena precedent | **The file does not exist on this branch** (deleted by `49d7f65744`). Readable only via `git show main:host/src/fork-module-state.ts`. And it is only HALF a precedent: it keeps a JS-side `this.chunks` array that both its overflow path and its `release()` read instead of the chain. **The Rust design must not copy that**, because `ALLOC.reset()` reclaims the Rust equivalent — which is what broke `RESUME_SLOT_INDEX`. |
| 2 | `FORK_MODULE_STAGING_BYTES` (`lib.rs:443`) | **No such identifier exists.** The real constant is `STAGING_SLAB_BYTES` (`host/src/fork-module-instance.ts:113`). The comment at `lib.rs:441-445` is a dangling cross-reference the spec inherited. The arithmetic it asserts IS true: `256 * 1024 == 65_536 * 4`, with zero headroom. |
| 3 | The reservation is `staticBytes + SHADOW_STACK_BYTES + STAGING_SLAB_BYTES` | **Four terms, not three.** `host/src/fork-module-instance.ts:210-214` rounds `staticBytes + SHADOW_STACK_BYTES` UP to a 64 KiB page before adding the slab. Real region today is **3,735,552**, not the spec's implied 3,706,180. This is finding B below. |
| 4 | Risk 7: `identity_chunk_count()` is dead and unproven; PREREQUISITE WORK | **Already done.** It is exported through `fm_stats` field 100 (`lib.rs:10929`) and asserted by `host/test/fork-identity-release.test.ts`, which publishes 4,100 identities, asserts 2 chunks, releases, asserts 0 chunks AND a `SYS_MUNMAP` delta of 2. Risk 7 is retired; follow the identity registry as a PROVEN path. |
| 5 | Decision 5: fix the 4 MiB region assertion first, in its own commit | **Already done** by `d7faaf1bb0`. `host/test/fork-module-instance.test.ts:47-58` asserts by derivation. **This plan needs no prerequisite commit.** |
| 6 | `CapturedExternrefs`: allocate AFTER `fm_capture_begin`'s reset | **`fm_capture_begin` never calls `reset_captured_externrefs()`.** The three clear sites are `set_format_impl:3534`, `begin_capture_impl:4725` and `capture_peer_tables_impl:10368`. The real hazard is the OPPOSITE order, at `begin_capture_impl`: it clears at `:4725` then calls `begin_unwind_impl` at `:4727`, which may `reset_bump_heap()` at `:4599`. Task 11 handles it. |
| 7 | `reset_bump_heap()` at `:4580`, `:5166`, `:7928`, `:10332` | **All four are wrong by 18-19 lines.** Current: `:4599`, `:5185`, `:7947`, `:10351`. And `begin_unwind_impl`'s is CONDITIONAL on `CAPTURE_ARMED` (`lib.rs:4594`). |
| 8 | The legacy-harness retirement removes one branch | **Two branches in two functions**: `resume_register_impl`'s `Ok(0)` (`lib.rs:670`) AND `register_activation_slots`'s `committed_ordinals` arm (`lib.rs:915-920`), which the spec never cites. Removing only one leaves either dead code or a silent no-slots activation. |
| 9 | The empty-catalog case "may be unreachable in practice" | **It is reachable and it is in the suite.** `libneeded-provider.so` in `fork-from-dlopen-side-module-e2e` seeds an EMPTY resume catalog, and `lib.rs:717-731` records that mistaking it for "never registered" already cost a real fork. The refusal must not catch it. |
| 10 | `lib.rs:1003-1153`; `HEAP_FLOOR` comment at `:3602` | Now `:1003-1192` and `:3620-3625`. |
| 11 | `VectorInFlight` — withdrawn in the decision notes, "its own chain too" in the table | **The spec contradicts itself.** Task 11 Step 5 stops and asks rather than picking. |
| 12 | "checking three lifetime classifications found two errors" | **Three of three.** The `CapturedExternrefs` remedy itself is wrong (row 6). |

Everything in the spec's per-store BYTE table is still exactly right, and the
module's `dylink.0 memorySize = 2,395,460` is unchanged in artifacts built
2026-09-19.

### B. Finding: the 36,164-byte threshold, and how this plan is structured around it

`regionBytes` rounds `staticBytes + SHADOW_STACK_BYTES` up to a 64 KiB page
BEFORE adding the slab. Today `stackTopOffset = 3,444,036` sits at 52.55
pages, rounded to 53. **Dropping to 52 pages needs a saving of at least
36,164 bytes before anything is observable at all.** Seven of the eleven
stores are individually below that line.

The spec's own experiment demonstrated this and drew no conclusion: shrinking
`ACT_GC_CODEC_FLOOR` from 32,768 to 1 left `regionBytes` at exactly
3,735,552, unchanged.

**So this plan does not land one store per commit.** Conversions are batched
so that each commit either crosses a page boundary or says plainly that it
moves zero region bytes and names what it DOES buy. The ledger below is
computed from `staticBytes` at each step and is the expected result of each
task. **Every task's verification step checks its own row.** A task that
reports a different number has either not reached the artifact or has changed
something this plan did not predict — in both cases, stop.

| Task | Store(s) | static Δ | staticBytes after | stackTopOffset | pages | **regionBytes Δ** |
|---|---|---|---|---|---|---|
| — | baseline | — | 2,395,460 | 3,444,036 | 53 | — (3,735,552) |
| 1 | arena + directory (no store) | +~64 | ~2,395,524 | ~3,444,100 | 53 | **0** (enabling) |
| 2 | `ResumeFreeBits` | −8,192 | 2,387,268 | 3,435,844 | 53 | **0** (correctness) |
| 3 | `ResumeSlotIndex` | −786,432 | 1,600,836 | 2,649,412 | 41 | **−786,432** |
| 4 | `ActKfigBytes`+`Index` | −67,584 | 1,533,252 | 2,581,828 | 40 | **−65,536** |
| 5 | GC codec + exn tags | −68,608 | 1,464,644 | 2,513,220 | 39 | **−65,536** |
| 6 | `CatalogCell` + activation catalog | −296,448 | 1,168,196 | 2,216,772 | 34 | **−327,680** |
| 7 | staging slab | 0 | 1,168,196 | 2,216,772 | 34 | **−(measured), exact** |
| 8 | the five small stores | −14,592 | 1,153,604 | 2,202,180 | 34 | **0** (correctness) |
| 9 | `HEAP_FLOOR` | −1,048,576 | 105,028 | 1,153,604 | 18 | **−1,048,576** |
| 10 | `ScratchCell` | −65,536 | 39,492 | 1,088,068 | 17 | **−65,536** |
| 11 | `CapturedExternrefs` | −16,384 | 23,108 | 1,071,684 | 17 | **0** (correctness) |

Three tasks move ZERO region bytes: **2, 8 and 11**. Each says so in its own
text. **Do not let an implementer land one of them and wonder why nothing
changed.**

Two arithmetic facts you will need:

* **Task 1 has 29,372 bytes of headroom before it pushes the region UP a
  page.** `3,473,408 − 3,444,036 = 29,372`. New Rust *code* lives in the code
  section and costs nothing here; only new *statics* count. The arena's four
  roots are 32 bytes. If Task 1's measured `memorySize` rises by more than
  29,372, something is wrong — stop.
* **Task 7's saving is the only exact one in the plan.** The slab is added
  AFTER the page round-up (`regionBytes = stagingOffset + STAGING_SLAB_BYTES`),
  so a byte off the slab is a byte off the region with no rounding.

The observable that matters is `regionBytes`, and it lags. `dylink.0
memorySize` moves on every conversion. Report both.

### C. Finding: the compaction-safety premise is already false, and how this plan resolves it

The spec's release design rests on "nothing may hold an absolute address into
the chain, because compaction moves surviving records down". **Four of the
eleven stores violate that premise today, by design, before the conversion
starts:**

* `ACT_CATALOG_INDEX` — `[activation_id, guest_addr, len]`. `lib.rs:825-826`:
  "Pack into the shared floor when it fits, else give this catalog its own
  mapping. **Either way the index records an absolute address.**"
* `ACT_GC_CODEC_INDEX` — `[activation_id, guest_addr, byte_len]`
  (`lib.rs:1887`).
* `ACT_EXN_TAGS_INDEX` — `[activation_id, guest_addr, len]`, "absolute so a
  floor-resident set and a spilled one read alike" (`lib.rs:2047-2048`).
* `ACT_KFIG_INDEX` — `[space, activation_id, offset, byte_len]`
  (`lib.rs:1411`) — an offset, rebasable, but still invalidated by compaction
  of the pool it indexes.

Worse, `activation_catalog()` (`lib.rs:868-878`) hands back
`Option<&'static [u32]>` — a `'static` slice into the floor or into a mapping.
**The `'static` is a lie under any scheme that can move or unmap that
storage.** It is safe today only because nothing ever frees.

Convert the byte pools to compacting chunks and leave the indexes as they are,
and every lookup after the first release reads a stale address into reused
memory. That is a wrong VALUE, not a trap — the exact class the spec's risk 6
calls "the failure mode this lane has been worst at catching".

**This plan resolves it structurally rather than by guard, in Task 1, before
anything is ever released.** Two allocation disciplines, chosen by whether a
record's address is ever published:

1. **Payload records NEVER MOVE.** A chunk header carries `used` (bytes
   handed out, monotonic within the chunk) and `live` (bytes still owned by a
   live record). Releasing a record subtracts its size from `live` and moves
   nothing. A chunk whose `live` reaches zero is unlinked and
   `channel_munmap`ed. So a published payload address is valid for exactly as
   long as its owning activation is — which is the borrow's real lifetime, and
   makes `&'static` honest by construction instead of by luck.
2. **Directory entries ARE compacted**, order-preserving copy-down, exactly as
   `release_identity_activation` (`lib.rs:1128-1140`) does — because nothing
   stores an address INTO the directory. Directory entries are found by
   walking, never by a cached pointer.

And the one remaining way to get a stale address — caching a slice across a
release — is closed because the release removes the directory entry FIRST, so
a post-release lookup returns `None`. Task 1 Step 6 tests exactly that, end to
end, through existing `fm_*` entries.

**This is a deliberate deviation from the spec**, which says "RELEASING:
compaction, not tombstones and not holes." Record it in the commit message.
The cost is bounded internal fragmentation within a partially released chunk;
the benefit is that the premise the whole release design rests on becomes
true.

### D. Two further deviations from the spec, argued

**D1. No binary search, no ascending-append guard, no sorted directory.** The
spec designs a directory "sorted by construction, searched in O(log n)", with
an `EINVAL` on an append not strictly greater than the last. Two problems: the
invariant is held by a different component than the one relying on it (the
spec says so — `claimActivationId` accepts a caller-supplied
`replayActivationId`), and a sorted insert across a CHUNKED directory needs a
cascading shift between chunks, which the forced-chunk build would be the only
thing to ever exercise.

Instead: **a linear walk over the directory chain, plus a one-entry memo**
(`DIRECTORY_MEMO_ACT` / `DIRECTORY_MEMO_AT`, 12 bytes of static) for the hot
callers — `func_catalog_base` runs per funcref reference during replay and
`table_state_owned` per guest import call, and consecutive lookups in replay
are overwhelmingly the same activation. That gives the hot path O(1) with no
ordering invariant to hold, and no guard whose failure is silent.

**STOP AND REPORT if any fixture's live activation count exceeds 64.** At the
measured maximum of 7 the walk is three cache lines; at "hundreds", which is
the workload the spec is designing for, the memo carries it. Past 64 the
sorted design is worth revisiting and that is the maintainer's call, not
yours.

**CONTROLLER RULING (D1-a): make that bound a runtime fact, not an
instruction.** "Stop and report" binds only the implementer, at authoring
time, and only for fixtures they happened to run — it is exactly the kind of
guard whose failure is silent that D1 rejects in the spec's design. Task 1
must therefore carry the bound in code:

* maintain a live directory-entry count alongside the chain;
* expose it as a new `fm_stats` field (follow the `IDENTITY_CHUNK_COUNT_FIELD
  = 100` convention added in Phase 0 — a high, explicitly numbered index with
  a matching pin, NOT the next free slot, so a later insertion cannot shadow
  it);
* when the count first exceeds 64, emit the module's existing loud diagnostic
  once, naming the count and this ruling, and keep running. Do NOT return an
  errno and do NOT abort: exceeding 64 is a performance signal, not a
  correctness failure, and turning a linear walk's cost into a fork failure
  would be the "convenient illusion" inversion — a working system reported as
  broken.

That makes the revisit trigger observable from any run, including a browser
one, instead of depending on which fixtures an implementer chose.

**D2. `RESUME_FREE_BITS` is a redesign, not a conversion** (research R-D).
`RESUME_NEXT_SLOT` (`lib.rs:628`) is monotonic and the only thing bounding
slot numbers is `count + catalog.len() > RESUME_SLOT_CAP` at `lib.rs:681`.
Delete `RESUME_SLOT_CAP` and the guard at `lib.rs:745`
(`if (slot as usize) < RESUME_SLOT_CAP`) has nothing to compare against, and a
freed slot beyond the bitmap's extent is **silently not freed** — the slot
leaks, numbering drifts, and the module and the guest's table place thunks by
different rules. Task 2 gives the bitmap a real bound (`RESUME_NEXT_SLOT`) and
chunks it by slot range, and lands BEFORE Task 3 deletes the cap.

### E. Two live defects this conversion is also fixing (research R-C)

**The eleven stores have no release path at all today, and the spilled
mappings leak.** `channel_munmap` has exactly three call sites in the module
(`lib.rs:1153`, `:4305`, `:5026`) and none of them releases a catalog, codec,
exception-tag or KFIG spill mapping. The `else` branch of
`set_activation_resume_catalog_impl` (`lib.rs:847-857`) takes a `channel_mmap`
that no code path ever returns.

And the floors are bump-only within a worker: `ACT_CATALOG_ORD_USED`
(`:832`), `ACT_KFIG_BYTES_USED` (`:1505`), `ACT_GC_CODEC_BYTES_USED` (`:1980`)
and `ACT_EXN_TAGS_ORD_USED` (`:2100`) are only ever stored forward.

**So a `dlopen`/`dlclose` loop monotonically exhausts these floors today and
then leaks a 64 KiB mapping per seed, in a worker that never forks.** There is
no existing release semantics to port — only one to invent. That is why Tasks
2, 8 and 11 are worth landing even though they move zero region bytes.

### F. The COW-child scrub is a release point the spec never names

`set_format_impl` (`lib.rs:3480-3545`) resets the per-activation COUNTERS so a
COW child can re-seed without tripping the re-seed refusals. It does not free
anything, because today there is nothing to free — the arenas are static BSS
the child inherits through the memory clone.

**On a chain, that is no longer true.** A COW child's address space is a clone
of the parent's, so the parent's chunk mappings are real mappings in the
child. Resetting a root to zero without unmapping leaks every one of them in a
long-lived child. So Task 1 gives the arena `arena_release_all()` and the
scrub calls it — **sequenced AFTER `CHANNEL_BASE` is stored** (`lib.rs:3532`),
because the release needs a serviced channel. Task 1 Step 7 tests it.

### G. The native host is a third consumer with no staging slab (research R-G)

`crates/host-native/src/guest.rs:6712-6720` computes the region independently
as `static_bytes + FORK_MODULE_SHADOW_STACK_BYTES` — **no slab at all** — and
places the region to END at `layout.max_addr`. It also carries its own
`FORK_MODULE_RESUME_CATALOG_CAP = 65_536` (`:5551`) and
`FORK_MODULE_CATALOG_SCRATCH_BYTES = CAP * 4` (`:5564`).

So the "must hold `RESUME_CATALOG_CAP * 4`" contract has **three
hand-maintained copies**: `crates/fork-module/src/lib.rs:446`,
`host/src/fork-module-backend.ts:92`, `crates/host-native/src/guest.rs:5551`.
Task 6 deletes all three together, or the dangling cross-reference at
`lib.rs:441-445` simply gains a second dangling name.

---

## Task 1: The arena, the directory, and their release paths

Nothing is converted here. This task builds the mechanism every later task
uses, proves its release path with the same pair of assertions
`host/test/fork-identity-release.test.ts` already makes, and closes the
absolute-address problem structurally before anything can be released.

**This task moves ZERO region bytes.** It is the enabling step. Its
verification checks that `memorySize` rose by less than 29,372 bytes — the
headroom before the region would move UP a page — not that anything shrank.

**Files:**
- Modify: `crates/fork-module/src/lib.rs` — a new block immediately after the
  identity registry's `set_identity_group` (ends `lib.rs:~1192`), so the two
  chain implementations sit together
- Modify: `crates/fork-module/src/lib.rs:3480-3545` (`set_format_impl`) — the
  COW-child scrub calls `arena_release_all()`
- Modify: `crates/fork-module/src/lib.rs:11003` (`fm_resume_slots` op 1) —
  calls `arena_release_activation()` beside `release_identity_activation()`
- Modify: `crates/fork-module/src/lib.rs:10916-10929` — two new `fm_stats`
  fields
- Create: `host/test/fork-arena-release.test.ts`
- Create: `host/test/fork-arena-lifetime.test.ts`
- Create: `host/test/fork-arena-cow-scrub.test.ts`

**Interfaces:**
- Produces, for Tasks 2-11:

```rust
/// The one knob the forced-chunk build edits (Task 12). SOURCE, not env:
/// the build key is derived from source, so an env-driven variant would
/// produce different bytes under an identical key.
const ARENA_CHUNK_BYTES: u64 = 65_536;
/// +0 next: u64, +8 size: u64, +16 used: u32, +20 live: u32.
/// WIDER THAN THE IDENTITY REGISTRY'S 16, and the two extra fields are why:
/// `size` because a chunk holding an oversized record is not
/// `ARENA_CHUNK_BYTES` and release must unmap exactly what it mapped, and
/// `live` separate from `used` because payload records never move, so
/// "handed out" and "still owned" are different numbers.
const ARENA_CHUNK_HEADER: u64 = 24;
/// +0 next_in_activation: u64, +8 kind: u32, +12 byte_len: u32.
const RECORD_HEADER: u64 = 16;
/// +0 activation_id: u64, +8 records_head: u64.
const DIRECTORY_ENTRY_BYTES: u64 = 16;

/// Record kinds. One per (store, space) pair; a directory entry names an
/// activation, and the activation's records are distinguished by kind.
const REC_KIND_RESUME_ASSIGNMENT: u32 = 1;
const REC_KIND_KFIG: u32 = 2;               // imported globals (space 0)
const REC_KIND_KFIT: u32 = 3;               // imported tables  (space 1)
const REC_KIND_GC_CODEC: u32 = 4;
const REC_KIND_EXN_TAGS: u32 = 5;
const REC_KIND_RESUME_CATALOG: u32 = 6;
const REC_KIND_PROVENANCE: u32 = 7;
const REC_KIND_TABLE_STATE_OWNER: u32 = 8;
const REC_KIND_TEMPLATE_ID: u32 = 9;
const REC_KIND_FUNC_CATALOG_BASE: u32 = 10;
const REC_KIND_STATIC_ROOT_BASE: u32 = 11;

/// Allocate `byte_len` bytes owned by `(activation_id, kind)`, returning the
/// PAYLOAD address in guest linear memory. The bytes are zeroed.
/// `EINVAL` if `(activation_id, kind)` already has a record.
fn arena_alloc(activation_id: u32, kind: u32, byte_len: usize) -> Result<u64, Errno>;

/// The payload address and byte length for `(activation_id, kind)`, or `None`.
fn arena_find(activation_id: u32, kind: u32) -> Option<(u64, usize)>;

/// Grow an existing record by re-allocating and copying. Used only by the
/// stores that append one fixed-size entry at a time (Task 8).
fn arena_extend(activation_id: u32, kind: u32, extra_bytes: usize) -> Result<u64, Errno>;

/// Drop every record `activation_id` owns and its directory entry, freeing
/// chunks that empty. Called from `fm_resume_slots` op 1.
fn arena_release_activation(activation_id: u32);

/// Drop EVERY record and unmap every chunk. Called from the COW-child scrub
/// in `set_format_impl`, after `CHANNEL_BASE` is stored.
fn arena_release_all();

fn arena_record_chunk_count() -> u32;
fn arena_directory_chunk_count() -> u32;
```

- [ ] **Step 1: Take a pristine copy before touching anything**

```bash
cd /Users/brandon/kandelo-lane-f
mkdir -p /tmp/claude-501/fork-storage-pristine
cp crates/fork-module/src/lib.rs /tmp/claude-501/fork-storage-pristine/lib.rs
git rev-parse HEAD > /tmp/claude-501/fork-storage-pristine/base-sha
```

Every perturbation in this plan restores from this copy, never from
`git checkout --`.

- [ ] **Step 2: Record the baseline numbers you are about to move**

```bash
cd /Users/brandon/kandelo-lane-f
node -e '
const fs=require("fs");
const m=new WebAssembly.Module(fs.readFileSync("local-binaries/fork_module32.wasm"));
const s=WebAssembly.Module.customSections(m,"dylink.0")[0];
const b=new Uint8Array(s); let i=0;
const uleb=()=>{let r=0,sh=0,x;do{x=b[i++];r|=(x&0x7f)<<sh;sh+=7}while(x&0x80);return r>>>0};
const id=b[i++]; const len=uleb();
console.log("subsection",id,"memorySize",uleb(),"memoryAlign",uleb(),"tableSize",uleb());
'
```

Expected: `memorySize 2395460 memoryAlign 4`. **If it is anything else, stop
and report** — every number in Task 0's ledger is derived from 2,395,460, and
a different baseline means the ledger is wrong before you start.

- [ ] **Step 3: Write the failing release test**

Create `host/test/fork-arena-release.test.ts`. Model it directly on
`host/test/fork-identity-release.test.ts` — the same
`instantiateFixtureModule()` shape with a `CHANNEL_RESPONDER` worker, the same
`MUNMAP_COUNTER` read, the same `afterAll` terminate.

The arena has no host-facing allocator of its own (this plan adds no `fm_*`
entry — `forkModuleEntriesWithoutProductionCaller` is at its ceiling with zero
slack), so drive it through an entry that will use it from Task 3 onward. For
THIS task, drive it through `fm_set_identity_group`'s neighbour: seed enough
per-activation KFIG sections to span more than one arena chunk once Task 4
lands. Until then, the test cannot allocate. **So this file's first version
tests the chunk-count observable against zero and the directory against zero,
and Task 4 Step 4 extends it to the real allocation.** Say that in the file
header, because a test file that asserts only zeros is otherwise
indistinguishable from one that has stopped working.

```ts
/**
 * WHY THIS EXISTS
 *
 * A fixed array could not leak; a chunk list can, so the release path needs
 * an observable. This is the arena's, and it follows
 * `host/test/fork-identity-release.test.ts` deliberately: BOTH halves or
 * neither is a guard.
 *
 * `arena_record_chunk_count()` walks `RECORD_HEAD` and the `next` pointers,
 * so it observes LIST MEMBERSHIP. `arena_release_activation` unlinks a chunk
 * BEFORE calling `channel_munmap`, which is best-effort by design. A chunk
 * unlinked but never unmapped therefore reads as zero here -- blind to
 * exactly the leak the observable exists for. So the `SYS_MUNMAP` tally is
 * asserted beside it: one unmap per chunk released.
 *
 * SCOPE TODAY: the arena has no store on it yet (this landed with the
 * mechanism, before any conversion). It asserts the empty state and the
 * observable's own wiring. `Task 4` extends it to a real multi-chunk
 * allocation once KFIG sections are arena-backed. Until then the zeros below
 * ARE the assertion -- specifically that the fields are wired and return 0
 * rather than the -1 an unclaimed `fm_stats` field answers.
 */
const ARENA_RECORD_CHUNK_COUNT_FIELD = 101;
const ARENA_DIRECTORY_CHUNK_COUNT_FIELD = 102;

it("wires both arena observables and starts empty", () => {
  const x = instantiateFixtureModule();
  // NOT `toBeFalsy()`. An unclaimed `fm_stats` field answers -1, and -1 is
  // truthy -- but a `toBe(0)` here fails loudly against a module built
  // without the field, which is the case this assertion exists to catch.
  expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD)).toBe(0);
  expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD)).toBe(0);
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
cd host && npx vitest run test/fork-arena-release.test.ts
```

Expected: FAIL, both fields returning `-1` — the module has no such fields.

- [ ] **Step 5: Implement the arena and the directory**

Place the block immediately after the identity registry so the two chain
implementations sit together, and follow its accessor idiom exactly: every
accessor re-derives `mem_mut()` rather than holding a slice across calls,
because `channel_mmap` GROWS the shared linear memory and invalidates any view
taken before it.

```rust
// -- The shared record arena and its directory -------------------------
//
// THE LIST LIVES IN THE CHUNKS, for the reason the identity registry above
// records: `ALLOC.reset()` runs mid-fork and "only rewinds the bump cursor;
// it neither frees nor zeroes the bytes, and the next allocations REUSE
// those low addresses". A bump-heap list of chunk addresses would be
// clobbered while the chunks it named stayed mapped. That is the concrete
// defect that broke the reverted `RESUME_SLOT_INDEX` conversion, and it is
// also why `main`'s `ForkModuleStateArena` is only HALF a precedent -- it
// keeps a JS-side `this.chunks` array beside the in-chunk pointer, and both
// its overflow path and its `release()` read the array.
//
// TWO DISCIPLINES, chosen by whether a record's address is ever published.
//
// PAYLOAD RECORDS NEVER MOVE. `activation_catalog()` hands out
// `&'static [u32]` into this storage, and three index stores this arena
// replaces recorded ABSOLUTE addresses by design
// ("Either way the index records an absolute address"). Compacting payloads
// would make every one of those a stale address into reused memory -- a
// wrong VALUE, not a trap. So a chunk tracks `used` (handed out, monotonic)
// and `live` (still owned), a release subtracts from `live` and moves
// nothing, and a chunk whose `live` reaches zero is unlinked and unmapped.
// A published payload address is then valid for exactly as long as its
// owning activation, which is what makes the `'static` honest rather than
// lucky.
//
// DIRECTORY ENTRIES ARE COMPACTED, order-preserving copy-down, exactly as
// `release_identity_activation` does -- because nothing stores an address
// INTO the directory. It is found by walking, never by a cached pointer.
//
// Chunk layout (both chains), little-endian:
//     +0   next: u64    (0 = end of list)
//     +8   size: u64    (what was mapped, so release unmaps exactly that)
//     +16  used: u32    (bytes/entries handed out; MONOTONIC in a record
//                        chunk, because payload records never move)
//     +20  live: u32    (record chain: live bytes; directory: live entries)
//     +24  body
//
// Record layout inside a record chunk:
//     +0   next_in_activation: u64  (0 = end of this activation's records)
//     +8   kind: u32
//     +12  byte_len: u32
//     +16  payload
//
// Directory entry (fixed 16 bytes):
//     +0   activation_id: u64
//     +8   records_head: u64
const ARENA_CHUNK_BYTES: u64 = 65_536;
const ARENA_CHUNK_HEADER: u64 = 24;
const RECORD_HEADER: u64 = 16;
const DIRECTORY_ENTRY_BYTES: u64 = 16;

static RECORD_HEAD: AtomicU64 = AtomicU64::new(0);
static DIRECTORY_HEAD: AtomicU64 = AtomicU64::new(0);

// A ONE-ENTRY MEMO, not a sorted index. `func_catalog_base` runs per funcref
// reference during replay and `table_state_owned` per guest import call, and
// consecutive lookups in replay are overwhelmingly the same activation.
//
// The spec designed a directory "sorted by construction, searched in
// O(log n)", with an `EINVAL` on an append not strictly greater than the
// last. That invariant is held by a DIFFERENT component than the one relying
// on it -- `claimActivationId` accepts a caller-supplied
// `replayActivationId` -- and its violation is a silent "not found" for a
// live activation. A sorted insert across a CHUNKED directory also needs a
// cascading shift between chunks that only the forced-chunk build would ever
// exercise. A memo buys the hot path O(1) with no ordering invariant to hold
// and no guard whose failure is silent.
//
// Invalidated on every release, because a memo that survives one is the
// stale pointer this whole design exists to prevent.
static DIRECTORY_MEMO_ACT: AtomicU32 = AtomicU32::new(u32::MAX);
static DIRECTORY_MEMO_AT: AtomicU64 = AtomicU64::new(0);

fn arena_u32(addr: u64) -> u32 {
    let m = unsafe { mem_mut() };
    let i = addr as usize;
    u32::from_le_bytes([m[i], m[i + 1], m[i + 2], m[i + 3]])
}

fn arena_set_u32(addr: u64, value: u32) {
    let m = unsafe { mem_mut() };
    let i = addr as usize;
    m[i..i + 4].copy_from_slice(&value.to_le_bytes());
}

fn arena_u64(addr: u64) -> u64 {
    let m = unsafe { mem_mut() };
    let i = addr as usize;
    let mut b = [0u8; 8];
    b.copy_from_slice(&m[i..i + 8]);
    u64::from_le_bytes(b)
}

fn arena_set_u64(addr: u64, value: u64) {
    let m = unsafe { mem_mut() };
    let i = addr as usize;
    m[i..i + 8].copy_from_slice(&value.to_le_bytes());
}

/// Map a fresh chunk of at least `want` usable bytes and link it at the TAIL
/// of `head`'s chain. Returns the chunk address.
///
/// AT LEAST, not exactly: a record larger than `ARENA_CHUNK_BYTES` gets a
/// chunk sized to hold it. That path is NOT only a forced-build curiosity --
/// php seeds 19,026 resume ordinals, which is 76,104 bytes, so it runs on
/// every real php process start.
fn arena_map_chunk(head: &AtomicU64, want: u64) -> Result<u64, Errno> {
    let size = page_round_up(core::cmp::max(ARENA_CHUNK_BYTES, ARENA_CHUNK_HEADER + want));
    let base = channel_base()?;
    let fresh = channel_mmap(base, size)?;
    arena_set_u64(fresh, 0);            // next
    arena_set_u64(fresh + 8, size);     // size, for the unmap
    arena_set_u32(fresh + 16, 0);       // used (bytes handed out from the body)
    arena_set_u32(fresh + 20, 0);       // live
    let mut tail = 0u64;
    let mut chunk = head.load(Ordering::Relaxed);
    while chunk != 0 {
        tail = chunk;
        chunk = arena_u64(chunk);
    }
    if tail == 0 {
        head.store(fresh, Ordering::Relaxed);
    } else {
        arena_set_u64(tail, fresh);
    }
    Ok(fresh)
}
```

Then `arena_alloc`, `arena_find`, `arena_extend`,
`arena_release_activation`, `arena_release_all`, and the two counts. Write
them following the identity registry's shapes: one walk doing several jobs,
best-effort `channel_munmap` on unlink ("a munmap hiccup must not fail an
otherwise-complete dlclose"), and `memory` views re-derived per access.

Wire the two `fm_stats` fields beside field 100, as single `if` compares
before the reference table, with the same reasoning the existing comment at
`lib.rs:10916-10929` gives:

```rust
const ARENA_RECORD_CHUNK_COUNT_FIELD: u32 = 101;
const ARENA_DIRECTORY_CHUNK_COUNT_FIELD: u32 = 102;
```

- [ ] **Step 6: Write the lifetime test — the one that catches the stale address**

Create `host/test/fork-arena-lifetime.test.ts`. This is the test that makes
Task 0 section C a fact rather than a claim, and it runs entirely through
existing `fm_*` entries.

```ts
/**
 * WHY THIS EXISTS
 *
 * Four of the stores this arena replaces recorded ABSOLUTE guest addresses
 * into their payloads by design, and `activation_catalog()` hands back
 * `&'static [u32]` into that storage. The `'static` was safe only because
 * nothing ever freed. This arena frees, so the discipline that makes it
 * honest -- payload records never move, and a release removes the directory
 * entry FIRST -- has to be asserted rather than described.
 *
 * WHAT WOULD BE WRONG WITHOUT IT, and what this catches: if a release left
 * the directory entry behind, or if a record ever moved, the second seed
 * below would read the FIRST seed's ordinals out of reused memory. That is a
 * wrong value, not a trap, and no other test in the suite looks at it.
 */
it("a released activation's storage is gone, not stale", () => {
  const x = instantiateFixtureModule();

  // Seed three ordinals, then release, then re-seed FIVE different ones.
  x.seedActivationCatalog(ACTIVATION, [10, 20, 30]);
  expect(x.errno()).toBe(0);
  expect(x.slots(1, ACTIVATION, 0), "three slots freed").toBe(3);

  // The re-seed must SUCCEED. A directory entry that survived the release
  // would make this the `EINVAL` re-seed refusal instead.
  x.seedActivationCatalog(ACTIVATION, [11, 22, 33, 44, 55]);
  expect(x.errno(), "re-seeding a released activation").toBe(0);

  // And the module must now hold FIVE, not the first seed's three. A stale
  // address surviving the release reads back the old length here.
  expect(x.slots(1, ACTIVATION, 0), "five slots freed on the second release").toBe(5);
});
```

`seedActivationCatalog` is `fm_set_activation_resume_catalog(act, ptr, count)`
with the ordinals written into shared memory first; copy the staging idiom
from `host/test/fork-module-imported-globals-seed.test.ts`.

**This test cannot pass until Task 3 puts the resume assignment on the arena.**
Land the file now with `it.skip`, and Task 3 Step 6 un-skips it. Say so in the
file header — a skipped test nobody un-skips is a test that cannot fail.

- [ ] **Step 7: Write the COW-scrub test and wire the scrub**

Create `host/test/fork-arena-cow-scrub.test.ts`.

A COW child's address space is a clone of the parent's, so the parent's chunk
mappings are real mappings in the child. `set_format_impl` today resets
counters and frees nothing, because there was nothing to free. Now there is.

```ts
/**
 * WHY THIS EXISTS
 *
 * `set_format_impl` is the COW-child scrub: a child's fork-module instance
 * sees the PARENT's already-populated statics, because BSS is not re-zeroed
 * on instantiation and the memory is a clone. Today the scrub resets
 * counters; the arenas behind them are static BSS the child simply
 * overwrites.
 *
 * A CHAIN IS DIFFERENT. The child inherits real mappings. Zeroing the root
 * without unmapping leaks every 64 KiB chunk the parent ever took, in a
 * child that may outlive it. The scrub therefore RELEASES, and the release
 * needs a serviced channel -- so it is sequenced AFTER `fm_set_format`
 * stores `CHANNEL_BASE`, not before.
 */
it("a second fm_set_format returns every chunk the first one's records held", () => {
  const x = instantiateFixtureModule();
  x.seedActivationCatalog(ACTIVATION, ordinalsSpanningTwoChunks);
  expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD)).toBeGreaterThan(0);
  const before = x.munmaps();
  const held = x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD)
    + x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD);

  x.setFormat();   // the COW-child scrub

  expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD), "records").toBe(0);
  expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD), "directory").toBe(0);
  // The count above cannot see a mapping leak; the tally can.
  expect(x.munmaps() - before, "one unmap per chunk the scrub released").toBe(held);
});
```

Also `it.skip` until Task 3. Then wire the scrub:

```rust
// The chains the counters above describe are MAPPINGS the COW child
// inherited through the memory clone, not static BSS it can simply
// overwrite. Zeroing a root without unmapping leaks every chunk the parent
// took. Released here rather than at the counter resets above because the
// release syscalls, and `CHANNEL_BASE` is stored by this same call.
arena_release_all();
```

**Placed after `CHANNEL_BASE` is stored (`lib.rs:3532`), not with the counter
resets.** Read the surrounding code and confirm the ordering yourself.

- [ ] **Step 8: Rebuild, verify fresh, and check the headroom**

```bash
cd /Users/brandon/kandelo-lane-f
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"
```

Then re-run the `memorySize` reader from Step 2. Expected: **between
2,395,460 and 2,424,832.** The upper bound is Task 0's 29,372-byte headroom —
beyond it the region moves UP a page, which is the opposite of the point.
Report the exact number.

- [ ] **Step 9: Perturb both halves of the leak observable**

Two perturbations, both required, because they catch different things.

(a) Delete the `channel_munmap` call in `arena_release_activation`. The chunk
count still reaches zero; the munmap tally does not. Expected: the tally
assertion fails, the count assertion passes. **If both pass, the tally
assertion is not wired.**

(b) Delete the unlink in `arena_release_activation` (leave the munmap).
Expected: the count assertion fails.

After each:

```bash
bash crates/fork-module/build-wasm.sh
cat local-binaries/fork_module32.wasm.build-key   # MUST differ from the pre-perturbation value
cd host && npx vitest run test/fork-arena-release.test.ts
cd .. && cp /tmp/claude-501/fork-storage-pristine/lib.rs crates/fork-module/src/lib.rs
```

Wait — the pristine copy predates this task's own work. Take a SECOND pristine
copy of your finished implementation before perturbing:

```bash
cp crates/fork-module/src/lib.rs /tmp/claude-501/fork-storage-pristine/lib-task1.rs
```

and restore from that one. Rebuild after restoring and confirm the key returns
to its pre-perturbation value.

- [ ] **Step 10: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs \
  host/test/fork-arena-release.test.ts \
  host/test/fork-arena-lifetime.test.ts \
  host/test/fork-arena-cow-scrub.test.ts
git status --short
git commit -m "Fork: Give the module one arena with a real release path"
git push origin brandonpayton/lane-f-fork-inversion
```

The commit body records: this moves zero region bytes and is the enabling
step; payload records never move and why; the directory is walked with a memo
rather than binary-searched and why.

---

## Task 2: Bound the resume free-slot bitmap by something real

**This task moves ZERO region bytes** (8,192 bytes, against a 29,564-byte
threshold at this point in the ledger). It lands for correctness, and it lands
BEFORE Task 3 because Task 3 deletes the constant this bitmap's bound comes
from.

`RESUME_FREE_BITS` is indexed by SLOT NUMBER (`lib.rs:747`), behind a guard
`if (slot as usize) < RESUME_SLOT_CAP` (`lib.rs:745`) whose stated purpose is
"a slot outside the table cannot corrupt it". But slot numbers come from
`RESUME_NEXT_SLOT` (`lib.rs:628`), which is monotonic, and the only thing
bounding them is `count + catalog.len() > RESUME_SLOT_CAP` at `lib.rs:681`.

Delete `RESUME_SLOT_CAP` and that guard has nothing to compare against. A
freed slot beyond the bitmap's extent would be **silently not freed** — the
slot leaks, numbering drifts, and the module and the guest's resume table
place thunks by different rules. Silent, not a trap.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:600-651` (declaration, `resume_allocate_slot`)
- Modify: `crates/fork-module/src/lib.rs:733-763` (`resume_unregister_impl`)
- Modify: `crates/fork-module/src/lib.rs:3510-3525` (the scrub's `.fill(0)`)
- Create: `host/test/fork-resume-slot-bitmap.test.ts`

**Interfaces:**
- Consumes: `arena_map_chunk`, `arena_u32/u64`, `arena_set_u32/u64` (Task 1)
- Produces:

```rust
/// Head of the free-slot bitmap chain. Each chunk covers a CONTIGUOUS slot
/// range `[base_slot, base_slot + FREE_BITS_PER_CHUNK)`, and slot numbers are
/// dense and monotonic from `RESUME_NEXT_SLOT`, so the chunks are a dense
/// ascending sequence with no gaps to search.
static FREE_BITS_HEAD: AtomicU64 = AtomicU64::new(0);
const FREE_BITS_PER_CHUNK: u32 = ((ARENA_CHUNK_BYTES - ARENA_CHUNK_HEADER) * 8) as u32;

/// Mark `slot` free. `EINVAL` for a slot never handed out -- which is now a
/// REAL bound (`slot < RESUME_NEXT_SLOT`) rather than a comparison against a
/// cap that no longer exists.
fn free_bits_mark(slot: u32) -> Result<(), Errno>;

/// Take the smallest free slot, or `None`. Smallest-first is the fourth of
/// the four slot rules and this is its only implementation.
fn free_bits_take_smallest() -> Option<u32>;

/// Drop every chunk. Called from the COW-child scrub, replacing `.fill(0)`.
fn free_bits_release_all();

fn free_bits_chunk_count() -> u32;
```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * WHY THIS EXISTS
 *
 * The bitmap used to be `[u64; RESUME_SLOT_CAP / 64]` and the guard that
 * kept an out-of-range slot from corrupting it compared against that cap.
 * The cap is being deleted, so the guard needs a bound that is TRUE:
 * `RESUME_NEXT_SLOT`, the highest slot ever handed out.
 *
 * WHAT GOES WRONG WITHOUT THIS TEST: a freed slot past the bitmap's extent
 * is silently not freed. The slot leaks, later numbering drifts, and the
 * module and the guest's resume table place thunks by different rules --
 * which is a wrong `call_indirect` target, not a trap. The assertion below
 * frees a slot in the SECOND bitmap chunk and requires it to come back.
 */
const RESUME_FREE_CHUNK_COUNT_FIELD = 103;

it("reuses a freed slot from beyond the first bitmap chunk", () => {
  // Seed one activation with more ordinals than a single bitmap chunk
  // covers, so the highest slots live in chunk 2.
  const n = FREE_BITS_PER_CHUNK + 16;
  x.seedActivationCatalog(ACTIVATION_A, range(1, n));
  expect(x.errno()).toBe(0);
  expect(x.stats(RESUME_FREE_CHUNK_COUNT_FIELD), "nothing freed yet").toBe(0);

  x.slots(1, ACTIVATION_A, 0);                    // release: every slot freed
  expect(x.stats(RESUME_FREE_CHUNK_COUNT_FIELD)).toBeGreaterThan(1);

  // A fresh activation must reuse the SMALLEST freed slot, which is 1 -- not
  // a newly grown one. Observed through the module's own numbering: seeding
  // one ordinal and releasing it must free exactly one slot, and the total
  // slot high-water must not have advanced.
  x.seedActivationCatalog(ACTIVATION_B, [1]);
  expect(x.errno()).toBe(0);
  expect(x.slots(1, ACTIVATION_B, 0)).toBe(1);
  expect(x.stats(RESUME_FREE_CHUNK_COUNT_FIELD), "every chunk returned").toBe(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd host && npx vitest run test/fork-resume-slot-bitmap.test.ts
```

Expected: FAIL — field 103 returns -1.

- [ ] **Step 3: Implement the chained bitmap**

Chunk layout reuses Task 1's 24-byte header, with the two chain-specific
fields where the record chain keeps `used` and `live`:
`+0 next: u64`, `+8 size: u64`, `+16 base_slot: u32`, `+20 live_bits: u32`,
`+24 bits`. `free_bits_mark` walks to the chunk covering
`slot`, mapping intermediate chunks as needed; `free_bits_take_smallest`
walks chunks in order and takes `trailing_zeros` of the first non-zero word,
unlinking and unmapping a chunk whose `live_bits` reaches zero.

Replace the guard:

```rust
// A REAL bound, not a comparison against a cap that no longer exists. A slot
// this module never handed out cannot be freed, and saying so is a truthful
// refusal rather than a silently dropped free.
if slot == 0 || slot >= RESUME_NEXT_SLOT.load(Ordering::Relaxed) {
    return Err(Errno::EINVAL);
}
```

And in `set_format_impl`, replace the `.fill(0)` at `lib.rs:3522` with
`free_bits_release_all()`, keeping the existing comment's reason ("a stale bit
would hand the child a slot the child never assigned") and adding the mapping
reason from Task 0 section F.

- [ ] **Step 4: Rebuild, verify fresh, check the ledger row**

```bash
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"
```

Expected `memorySize`: **2,387,268** (baseline minus 8,192), modulo Task 1's
measured delta. Expected `regionBytes`: **unchanged at 3,735,552**. Say both
numbers in your report, and say the region did not move and why.

- [ ] **Step 5: Perturb the new bound**

Change the guard to `if slot == 0` (drop the upper bound). A freed
out-of-range slot then silently allocates a bitmap chunk for a slot that
never existed. Add one assertion that catches it — free slot
`RESUME_NEXT_SLOT + 1000` and require `EINVAL` — then confirm it fails with
the guard weakened and passes with it restored. Restore from
`/tmp/claude-501/fork-storage-pristine/lib-task1.rs` plus your Task 2 diff, or
from a Task 2 pristine copy taken before perturbing.

- [ ] **Step 6: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/fork-resume-slot-bitmap.test.ts
git commit -m "Fork: Bound the resume free-slot bitmap by slots actually issued"
git push origin brandonpayton/lane-f-fork-inversion
```

Body states: moves zero region bytes; lands for the silent-leak class
described above; sequenced before the cap's deletion.

---

## Task 3: The resume-slot assignment becomes one record per activation

**The largest single store: 786,432 bytes, 63% of the eleven. This commit
moves regionBytes by 786,432 — twelve pages.**

Change 2 made this possible: `resume_slot_of` is gone, so no reader needs
`(activation, ordinal)` as a key. The three surviving readers are all "this
activation's entries" or "append", which one contiguous per-activation record
serves with no walk at all.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:587-598` (delete `RESUME_SLOT_CAP`,
  `ResumeSlotIndex`, `RESUME_SLOT_INDEX`, `RESUME_SLOT_COUNT`)
- Modify: `crates/fork-module/src/lib.rs:664-704` (`resume_register_impl`)
- Modify: `crates/fork-module/src/lib.rs:733-763` (`resume_unregister_impl`)
- Modify: `crates/fork-module/src/lib.rs:778-791` (`resume_assignment_of`)
- Modify: `crates/fork-module/src/lib.rs:3517-3518` (the scrub)
- Modify: whatever Change 2's Task 3 added (Step 1 finds it)
- Modify: `host/test/fork-arena-lifetime.test.ts`,
  `host/test/fork-arena-cow-scrub.test.ts` (un-skip)

**Interfaces:**
- Consumes: `arena_alloc`, `arena_find`, `arena_release_activation` (Task 1);
  `free_bits_take_smallest`, `free_bits_mark` (Task 2)
- Produces: one record per activation under `REC_KIND_RESUME_ASSIGNMENT`,
  payload = a packed `[(ordinal: u32, slot: u32)]` array, count derivable from
  the record's `byte_len / 8`.

- [ ] **Step 1: Find the static Change 2 added, and fold it in**

```bash
cd /Users/brandon/kandelo-lane-f
grep -n "fm_publish_resume_assignment" -A 30 crates/fork-module/src/lib.rs | \
  grep -n "static \|UnsafeCell\|const .*: usize"
git log --oneline -20 -- crates/fork-module/src/lib.rs
```

Change 2's Task 3 Step 1 required the implementer to "state in your report
where you put the assignment buffer and why it survives" the reset. Find that
buffer. **It is a fixed BSS static this task converts**, and the record this
task creates is the same data — so in most shapes the buffer simply becomes
the record's payload and the copy disappears. Say in your report what you
found and whether the publish now hands out the record address directly.

If Change 2 chose a bump-heap buffer instead, STOP and report: that
contradicts its own Task 3 interface note ("NOT in the bump heap
(`reset_bump_heap` runs at four points during a single fork)") and the
disagreement matters more than this conversion.

- [ ] **Step 2: Rewrite the three readers against the record**

```rust
/// Assign this activation's slots from its seeded catalog.
///
/// ONE RECORD, not entries scattered through a shared index. The three
/// surviving readers are all "everything belonging to activation A" or
/// "append" -- `resume_slot_of`, the only reader that needed
/// `(activation, ordinal)` as a key, went with `fm_resume_slots` op 0 when
/// the guest shim took over thunk placement. So the duplicate-activation
/// scan that used to walk the full live prefix (up to 47,757 entries for
/// php, once per activation registration) is now `arena_find`'s directory
/// lookup, and the per-ordinal append that re-loaded `RESUME_SLOT_COUNT`
/// every iteration is one bounded write into a record sized up front.
fn resume_register_impl(activation_id: u32) -> Result<u32, Errno> {
    let catalog = activation_catalog(activation_id).ok_or(Errno::EINVAL)?;
    if arena_find(activation_id, REC_KIND_RESUME_ASSIGNMENT).is_some() {
        return Err(Errno::EINVAL); // already registered
    }
    let mut sorted: Vec<u32> = catalog.to_vec();
    sorted.sort_unstable();
    for window in sorted.windows(2) {
        if window[0] == window[1] {
            return Err(Errno::EINVAL); // repeated ordinal
        }
    }
    // ZERO ORDINALS IS A SUCCESS with a record, not an absent one.
    // `libneeded-provider.so` in `fork-from-dlopen-side-module-e2e` seeds an
    // EMPTY resume catalog, and mistaking that for "never registered"
    // already cost a real fork (see `resume_unregister_impl`). An empty
    // record says "registered, holding nothing"; no record says "never
    // registered". Those are different facts and the arena can hold both.
    let at = arena_alloc(activation_id, REC_KIND_RESUME_ASSIGNMENT, sorted.len() * 8)?;
    let mut assigned = 0u32;
    for (i, ordinal) in sorted.iter().enumerate() {
        let slot = match free_bits_take_smallest() {
            Some(slot) => slot,
            None => {
                let next = RESUME_NEXT_SLOT.load(Ordering::Relaxed);
                RESUME_NEXT_SLOT.store(next + 1, Ordering::Relaxed);
                next
            }
        };
        arena_set_u32(at + (i as u64) * 8, *ordinal);
        arena_set_u32(at + (i as u64) * 8 + 4, slot);
        assigned += 1;
    }
    Ok(assigned)
}
```

`resume_unregister_impl` becomes: find the record, walk its pairs calling
`free_bits_mark(slot)`, then `arena_release_activation(activation_id)`.
`resume_assignment_of` becomes `arena_find` + a read of the pairs.

**Note the compaction-semantics change and assert it.** Today
`resume_unregister_impl` compacts by SWAP-REMOVE
(`index[position] = index[count-1]`, `lib.rs:757`), which does not preserve
order. A per-activation record has no ordering to disturb at all. The spec
presents this as a like-for-like move and it is not; `resume_assignment_of`'s
consumer sorts, so it is harmless, but it has never been asserted anywhere.
Add one assertion that the pairs come back in ascending-ordinal order.

- [ ] **Step 3: Delete the cap and the index**

```bash
grep -n "RESUME_SLOT_CAP\|RESUME_SLOT_INDEX\|RESUME_SLOT_COUNT" crates/fork-module/src/lib.rs
```

Every hit must be gone except in comments you rewrite. The bitmap already
stopped depending on the cap in Task 2 — confirm no `RESUME_FREE_WORDS`
remains.

- [ ] **Step 4: Un-skip Tasks 1's two deferred tests**

Remove `it.skip` from `host/test/fork-arena-lifetime.test.ts` and
`host/test/fork-arena-cow-scrub.test.ts`, and delete the "skipped until Task
3" sentences from their headers. **A header that still says a test is skipped,
on a test that runs, is the comment-without-a-test class this lane keeps
finding.**

```bash
cd host && npx vitest run test/fork-arena-lifetime.test.ts test/fork-arena-cow-scrub.test.ts
```

Both must now pass.

- [ ] **Step 5: Rebuild, verify fresh, check the ledger row**

```bash
cd /Users/brandon/kandelo-lane-f
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"
```

Expected `memorySize`: **1,600,836**. Expected `regionBytes`: **2,949,120**
(down 786,432, twelve pages). Verify the region by running
`host/test/fork-module-instance.test.ts` and reading `fm.regionBytes`, not by
arithmetic alone:

```bash
cd host && npx vitest run test/fork-module-instance.test.ts
```

- [ ] **Step 6: Run the fork surface — this is the store that deadlocked before**

```bash
cd host && npx vitest run test/fork-*.test.ts
```

The reverted chunked `RESUME_SLOT_INDEX` deadlocked every process at a forced
4-entry floor, all parked in `channel_mmap` on `memory_atomic_wait32`, and the
spec's experiment refuted the only proposed mechanism without finding the real
one. **If anything hangs here, that is the diagnosis happening inside the
change, which the spec's risk 1 explicitly anticipated.** Report what parked
and where; do not work around it.

The concrete difference from the reverted design, and the reason the
maintainer ruled this in: the chunk list lives INSIDE the chunks, not in a
bump-heap `Vec` that `ALLOC.reset()` reclaims mid-fork while the chunks it
named stay mapped.

- [ ] **Step 7: Perturb**

Make `resume_unregister_impl` skip `free_bits_mark` for the last pair. The
bitmap chunk-count-returns-to-zero assertion in
`host/test/fork-resume-slot-bitmap.test.ts` must fail. Restore from a Task 3
pristine copy, rebuild, confirm the key returns.

- [ ] **Step 8: Budget, then commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/fork-arena-lifetime.test.ts \
  host/test/fork-arena-cow-scrub.test.ts
git commit -m "Fork: Put the resume-slot assignment on the arena"
git push origin brandonpayton/lane-f-fork-inversion
```

Body: 786,432 bytes, twelve pages off the per-thread reservation; the
duplicate-activation scan becomes a directory lookup; the swap-remove
compaction semantics are gone and the ordering is now asserted.

---

## Task 4: The KFIG/KFIT section pool becomes records

**67,584 bytes. This commit moves regionBytes by 65,536 — one page** (the
threshold at this point is 27,972 bytes; margin 39,612).

This is the first byte-pool conversion, and it is the one where the
offset-into-a-shared-pool index (`[space, activation_id, offset, byte_len]`,
`lib.rs:1411`) becomes a record. It proves the pattern for Task 5.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:1401-1420` (declarations)
- Modify: `crates/fork-module/src/lib.rs:1440-1530`
  (`set_activation_imports_impl`, `activation_imports`)
- Modify: `crates/fork-module/src/lib.rs:3480-3545` (any KFIG counter reset)
- Modify: `host/test/fork-arena-release.test.ts` (the real allocation)

**Interfaces:**
- Consumes: `arena_alloc`, `arena_find` (Task 1)
- Produces: `activation_imports(space, activation_id) -> Option<&'static [u8]>`
  — signature unchanged, now backed by `arena_find(activation_id, kind)` with
  `kind = REC_KIND_KFIG` for space 0 and `REC_KIND_KFIT` for space 1.

- [ ] **Step 1: Extend the arena release test to a real multi-chunk allocation**

Replace `host/test/fork-arena-release.test.ts`'s zero-only assertions with the
real thing, and delete the "SCOPE TODAY" paragraph from its header.

Derive the entry count from the module's own constants rather than asserting
a number, exactly as `fork-identity-release.test.ts` does:

```ts
/**
 * How many bytes to seed, DERIVED from the module's own constants.
 *
 *     ARENA_CHUNK_BYTES  = 65_536
 *     ARENA_CHUNK_HEADER = 24
 *     RECORD_HEADER      = 16
 *
 * so one chunk holds 65,536 - 24 = 65,512 bytes of records, and a record
 * costs 16 bytes of header. Two activations at 40,000 payload bytes each
 * therefore need 2 chunks: 40,016 fits in the first, the second does not
 * (80,032 > 65,512).
 */
const CHUNK_BODY = 65_536 - 24;
const PAYLOAD = 40_000;
const EXPECTED_CHUNKS = 2;
```

Then: seed two activations' KFIG sections, assert `EXPECTED_CHUNKS`, capture
the munmap baseline (must be 0 — seeding only ever maps), release both, assert
the count is 0 AND the munmap delta equals `EXPECTED_CHUNKS` plus the
directory's chunk. **Both halves.**

- [ ] **Step 2: Run it and watch it fail**

```bash
cd host && npx vitest run test/fork-arena-release.test.ts
```

Expected: FAIL — the count stays 0, because KFIG is still a static pool.

- [ ] **Step 3: Convert**

```rust
// Was a 64 KiB static byte pool plus a 128-entry index recording an OFFSET
// into it. The offset was rebasable but still invalidated by any compaction
// of the pool, and the pool was bump-only within a worker
// (`ACT_KFIG_BYTES_USED` was only ever stored forward), so a dlopen/dlclose
// loop exhausted it and never gave anything back. One arena record per
// (activation, space) gives both halves a lifetime.
fn set_activation_imports_impl(
    space: u32,
    activation_id: u32,
    ptr: u64,
    byte_len: u64,
) -> Result<(), Errno> {
    if space != IMPORT_SPACE_GLOBAL && space != IMPORT_SPACE_TABLE {
        return Err(Errno::EINVAL);
    }
    let kind = if space == IMPORT_SPACE_GLOBAL { REC_KIND_KFIG } else { REC_KIND_KFIT };
    // ... existing bounds check against guest memory, unchanged ...
    // The idempotent-re-seed and conflicting-re-seed rules are unchanged;
    // they now compare against `arena_find` rather than the index prefix.
    if let Some((at, len)) = arena_find(activation_id, kind) {
        let stored = guest_bytes(at, len)?;
        return if stored == incoming { Ok(()) } else { Err(Errno::EINVAL) };
    }
    let at = arena_alloc(activation_id, kind, byte_len)?;
    // Copied AFTER the allocation: `channel_mmap` grows the shared memory and
    // invalidates any view taken before it.
    let m = unsafe { mem_mut() };
    m.copy_within(start..end, at as usize);
    Ok(())
}
```

Keep every existing refusal and its errno. `E2BIG` for the arena and
activation caps no longer has a cap to hit — **the `E2BIG` arms go away, and
a `channel_mmap` failure's truthful `ENOMEM`/`EAGAIN` replaces them.** Say so
in the commit body: an `E2BIG` that can no longer occur is a refusal for a
boundary that no longer exists.

- [ ] **Step 4: Rebuild, verify fresh, check the ledger row**

Expected `memorySize`: **1,533,252**. Expected `regionBytes`: **2,883,584**.

- [ ] **Step 5: Perturb the idempotent-re-seed rule**

Make the conflicting-re-seed comparison always return `Ok(())`. A test that
seeds the same activation with DIFFERENT bytes must go red. If no test covers
that, write one — the rule is stated in the code today and its coverage is
worth confirming rather than assuming.

- [ ] **Step 6: Budget, then commit**

```bash
cd host && npx vitest run test/fork-*.test.ts
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/fork-arena-release.test.ts
git commit -m "Fork: Put imported-global and imported-table sections on the arena"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 5: The GC-codec and exception-tag floors become records

**68,608 bytes together. This commit moves regionBytes by 65,536 — one page**
(threshold 25,924; margin 42,684). **Batched deliberately: neither crosses the
threshold alone**, and landing them separately would produce a commit that
moves nothing while implying it moved something.

Both stores are the same shape as each other and as Task 4's, with one extra
property: both index halves hold **absolute** guest addresses today
(`lib.rs:1887`, `lib.rs:2047-2048`), so this is where Task 0 section C's
discipline earns its keep.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:1877-1900, 1905-2000`
  (`ACT_GC_CODEC_*`, `set_activation_gc_codec_impl`)
- Modify: `crates/fork-module/src/lib.rs:2038-2110`
  (`ACT_EXN_TAGS_*`, `store_activation_exception_tags`)
- Modify: `crates/fork-module/src/lib.rs:3501-3511` (the scrub's deliberate
  non-reset of the GC codec — the reason changes and the comment must too)

**Interfaces:**
- Consumes: `arena_alloc`, `arena_find` (Task 1)
- Produces: the accessors keep their existing signatures, backed by
  `arena_find(activation_id, REC_KIND_GC_CODEC)` and
  `arena_find(activation_id, REC_KIND_EXN_TAGS)`.

- [ ] **Step 1: Read the COW-child non-reset before changing anything**

```bash
sed -n '3495,3515p' crates/fork-module/src/lib.rs
```

`ACT_GC_CODEC_*` is **deliberately not reset** by the scrub: the native host
does NOT re-seed it on a COW child and relies on inheriting the parent's,
while the Node/browser host DOES re-seed. A reset destroyed the inherited
codec and broke `fm_build_gc_plan` with errno 22 for every GC / static-root
fork.

**Task 1's `arena_release_all()` in the scrub releases EVERY record,
including the GC codec's.** That reintroduces the exact defect this comment
records. Resolve it here, explicitly, one of two ways, and say which:

* **(a)** `arena_release_all()` gains a kind exclusion for
  `REC_KIND_GC_CODEC`, with the inherited-codec reason copied into the arena's
  own comment so a reader of `arena_release_all` sees why one kind survives.
* **(b)** The native host starts re-seeding on a COW child, making both hosts
  agree, and the exclusion is unnecessary.

**(b) is the better answer and (a) is the safe one.** (b) removes a
Node/browser divergence the host-runtime contract calls out, but it changes
`crates/host-native` behaviour on a path this plan does not otherwise touch.
Take (a) in this task, and **report (b) as a follow-up with the divergence
named** — do not bundle a native-host behaviour change into a storage
conversion.

- [ ] **Step 2: Write the failing test**

Extend `host/test/fork-arena-release.test.ts` (or add a sibling) with: seed a
GC codec section and an exception-tag set for one activation, confirm the
arena chunk count rises, release the activation, confirm it returns to zero
AND the munmap tally matches.

Then add the COW case from Step 1: seed a GC codec, call `fm_set_format`
again, and assert the codec is **still readable** — the assertion that would
have caught the errno-22 defect had it existed. Drive the read through
`fm_build_gc_plan` or whichever existing entry consumes the codec; if no entry
exposes it, say so and assert through the fixture that already covers GC
replay (`host/test/fork-module-gc-replay.test.ts`).

- [ ] **Step 3: Run it and watch it fail**

- [ ] **Step 4: Convert both stores**

Same shape as Task 4. The spill branches (`channel_mmap` for a section that
does not fit the floor, `lib.rs:847-857` and its exception-tag twin) **go
away entirely** — the arena is the only path now, and its oversized-chunk
route (`arena_map_chunk`'s `max(ARENA_CHUNK_BYTES, header + want)`) serves a
section larger than a chunk.

**That closes the leak in Task 0 section E**: those spill mappings had no
release path at all. Say so in the commit body.

- [ ] **Step 5: Rebuild, verify fresh, check the ledger row**

Expected `memorySize`: **1,464,644**. Expected `regionBytes`: **2,818,048**.

- [ ] **Step 6: Perturb the COW exclusion**

Remove the `REC_KIND_GC_CODEC` exclusion from `arena_release_all()`. The
Step 2 COW assertion must go red. This is the one perturbation in the plan
that reproduces a defect the tree already paid for once — confirm the errno
you see matches the 22 the comment records, and say so.

- [ ] **Step 7: Budget, then commit**

```bash
cd host && npx vitest run test/fork-*.test.ts
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/fork-arena-release.test.ts
git commit -m "Fork: Put GC-codec and exception-tag sections on the arena"
git push origin brandonpayton/lane-f-fork-inversion
```

Body: batched because neither crosses the 64 KiB page step alone; the two
never-released spill mappings now have a lifetime; the GC-codec COW exclusion
and the follow-up it defers.

---

## Task 6: Merge `CatalogCell` into the activation-keyed catalog

**296,448 bytes. This commit moves regionBytes by 327,680 — five pages.** It
is also the plan's only ABI change and its only `fm_*` deletion.

The split runs backwards against measurement, and the code says so:
`lib.rs:519-523` records "the largest shipped programs (php-fpm 19190, php
19026, node/spidermonkey 16555) all fit" in the 65,536-ordinal static, while
the per-activation path — whose largest extension is 7,750 — got the growable
8,192-ordinal floor. **The biggest consumer sits on the fixed 256 KiB static
and the small ones got growth.**

**Files:**
- Modify: `crates/fork-module/src/lib.rs:441-470` (delete `RESUME_CATALOG_CAP`,
  `CatalogCell`, `RESUME_CATALOG`, `RESUME_CATALOG_LEN`,
  `set_resume_catalog_impl`, `resume_catalog`)
- Modify: `crates/fork-module/src/lib.rs:520-545, 795-878` (the activation
  catalog onto the arena)
- Modify: `crates/fork-module/src/lib.rs:664-673` (the `None` arm's `Ok(0)`)
- Modify: `crates/fork-module/src/lib.rs:893-921`
  (`register_activation_slots`'s `committed_ordinals` arm)
- Modify: `crates/fork-module/src/lib.rs:7118-7141` (delete
  `fm_set_resume_catalog`)
- Modify: `host/src/fork-module-instance.ts:36`
  (`FORK_MODULE_REQUIRED_EXPORTS`)
- Modify: `host/src/fork-module-backend.ts:92, 215-220, 271-278, 363-385`
- Modify: `host/src/worker-main.ts:102, 6430-6440`
- Modify: `crates/host-native/src/guest.rs:5544-5564, 6296-6300, 6510, 7058,
  7639-7655, 11220-11226`
- Modify: `crates/host-native/src/lib.rs:1379, 1513-1521`
  (`fork_module_host_obligation_is_pinned`)
- Modify: `docs/surface-budget.json`

**Interfaces:**
- Produces: `fm_set_activation_resume_catalog(activation, ptr, count)` is the
  ONLY catalog seed. Activation 0 seeds through it like every other
  activation. `resume_catalog()` and `fm_set_resume_catalog` no longer exist.

- [ ] **Step 1: Retire BOTH legacy-harness branches, together**

The spec treats this as removing one branch. It is **two branches in two
functions** (research item 8), and removing either alone is worse than
removing neither:

```bash
sed -n '664,675p' crates/fork-module/src/lib.rs     # the Ok(0)
sed -n '908,921p' crates/fork-module/src/lib.rs     # the committed_ordinals arm
```

Removing only the `Ok(0)` leaves the `committed_ordinals` arm
unreachable-but-present; removing only the arm turns `Ok(0)` into a silent
no-slots activation.

**The refusal must distinguish two cases, and one of them is in the suite.**
Seeding an EMPTY catalog is legitimate — `libneeded-provider.so` in
`fork-from-dlopen-side-module-e2e` does exactly that, and `lib.rs:717-731`
records that mistaking it for "never registered" already cost a real fork.
NEVER seeding is the loud one:

```rust
// NEVER SEEDED is a build that went wrong, not a legacy artifact.
// Instrumentation ships with the fork support that consumes it, and this
// project keeps no backwards compatibility, so a binary arriving here with
// nothing seeded means the instrumentation step did not run. Silently
// switching to committed-ordinal numbering is worse than failing: the module
// and the guest's resume table would then number slots by different rules,
// which is exactly the divergence the seeded catalog exists to make
// impossible by construction.
//
// AN EMPTY CATALOG IS NOT THIS CASE. A side module with no fork-instrumented
// function seeds an empty one -- `libneeded-provider.so` in
// `fork-from-dlopen-side-module-e2e` is exactly that -- and it holds zero
// slots legitimately. The arena distinguishes them: an empty RECORD says
// "registered, holding nothing"; NO record says "never registered".
let catalog = activation_catalog(activation_id).ok_or(Errno::EINVAL)?;
```

- [ ] **Step 2: Write the failing tests — both cases**

Two assertions, and neither is optional:

```ts
it("refuses an activation whose catalog was never seeded", () => {
  // No `fm_set_activation_resume_catalog` for this activation at all.
  expect(x.registerSlots(ACTIVATION_NEVER_SEEDED)).toBe(-1);
  expect(x.errno()).toBe(22);   // EINVAL
});

it("accepts an activation seeded with an EMPTY catalog", () => {
  x.seedActivationCatalog(ACTIVATION_EMPTY, []);
  expect(x.errno(), "an empty catalog is a legitimate seed").toBe(0);
  // ZERO SLOTS IS A SUCCESS. `libneeded-provider.so` seeds one of these, and
  // reading it as "never registered" already cost a real fork once.
  expect(x.slots(1, ACTIVATION_EMPTY, 0)).toBe(0);
  expect(x.errno()).toBe(0);
});
```

And run the fixture that proves it end to end:

```bash
cd host && npx vitest run test/fork-from-dlopen-side-module-e2e.test.ts
```

- [ ] **Step 3: Convert, delete, and retire all three cap copies**

The activation catalog moves onto the arena as
`REC_KIND_RESUME_CATALOG`. Then:

```bash
cd /Users/brandon/kandelo-lane-f
grep -rn "RESUME_CATALOG_CAP\|FORK_MODULE_RESUME_CATALOG_CAP\|fm_set_resume_catalog" \
  crates/fork-module/src crates/host-native/src host/src host/test | grep -v node_modules
```

**Every hit must go**, including `crates/host-native/src/guest.rs:5551` and
`:5564` (`FORK_MODULE_CATALOG_SCRATCH_BYTES`). The contract has three
hand-maintained copies (Task 0 section G) and the module comment at
`lib.rs:441-445` already names a constant that does not exist. Deleting the
module's copy alone turns that comment into a second dangling citation.

Also fix `FORK_MODULE_REQUIRED_EXPORTS` (`host/src/fork-module-instance.ts:36`)
and the exact-list assert in `fork_module_host_obligation_is_pinned`
(`crates/host-native/src/lib.rs:1513-1521`). **That test SHOULD go red — that
is its job.** Update it and say in the commit what moved and why.

```bash
cargo test -p wasm-posix-host-native
```

- [ ] **Step 4: Rebuild, verify fresh, check the ledger row**

Expected `memorySize`: **1,168,196**. Expected `regionBytes`: **2,490,368**.

- [ ] **Step 5: Lower the ceilings this commit reduces**

```bash
cd host && npx vitest run test/surface-budget.test.ts
```

It will fail on reductions. Lower, in `docs/surface-budget.json`, in this same
commit, each with a recorded reason:

* `forkModuleEntryPoints` 71 → 70 and `forkModuleHostEntries` 58 → 57 —
  `fm_set_resume_catalog` removed, the duplicate seeding entry for activation
  0.
* `forkTypeScript` — by the measured reduction in
  `host/src/fork-module-backend.ts` and `fork-module-instance.ts`.

**Do not raise anything.** If a ceiling needs to go UP, stop and report.

- [ ] **Step 6: Perturb the never-seeded refusal**

Change `.ok_or(Errno::EINVAL)?` back to a fall-through that returns `Ok(0)`.
The never-seeded test must go red and the empty-catalog test must stay green.
**If both stay green, the two cases are not distinguished and the refusal is
catching nothing.**

- [ ] **Step 7: Commit**

```bash
cd host && npx vitest run test/fork-*.test.ts
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/src/fork-module-backend.ts \
  host/src/fork-module-instance.ts host/src/worker-main.ts \
  crates/host-native/src/guest.rs crates/host-native/src/lib.rs \
  docs/surface-budget.json host/test/
git status --short
git commit -m "Fork: Merge the process-wide resume catalog into the per-activation one"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 7: Resize the staging slab from a measurement

**The only saving in this plan that is exact.** `regionBytes = stagingOffset +
STAGING_SLAB_BYTES` (`host/src/fork-module-instance.ts:214`) adds the slab
AFTER the 64 KiB round-up, so a byte off the slab is a byte off the region.

The slab's own comment calls it "a tuning choice, not a correctness boundary
… sized well above that internal scratch while staying small against the
module's ~4 MiB static footprint" — sized RELATIVE TO a static footprint Tasks
1-6 have now deleted. And its arithmetic justification
(`STAGING_SLAB_BYTES == RESUME_CATALOG_CAP * 4`, exactly, with zero headroom)
lost its right-hand side in Task 6.

**Do not pick a number. Measure one.**

**Files:**
- Modify: `host/src/fork-module-instance.ts:105-113`
- Modify: `docs/surface-budget.json` if the edit is a net reduction
- Create or extend: a test that exercises a staged request LARGER than the
  slab

- [ ] **Step 1: Measure the largest staged request across the fork suite**

Instrument the staging path in `host/src/fork-module-backend.ts` to record the
maximum byte length it stages, then:

```bash
cd host && npx vitest run test/fork-*.test.ts 2>&1 | tee /tmp/claude-501/staging.txt
grep -i "staging max" /tmp/claude-501/staging.txt
```

Report the number. Also note the ceiling that matters in production: php seeds
19,026 resume ordinals, which is **76,104 bytes** — above a 64 KiB slab.

- [ ] **Step 2: Test the over-slab fallback FIRST, because it has never run**

The spec asserts "a request larger than the slab already falls back to the
growing channel mmap". That path has no test. Write one: stage a catalog
larger than `STAGING_SLAB_BYTES` and assert the seed succeeds and reads back
byte-identically.

```bash
cd host && npx vitest run test/fork-module-backend.test.ts
```

**This test must exist and pass before the slab shrinks**, or the shrink is
choosing an untested path for every php boot.

- [ ] **Step 3: Choose the size, and say what the choice costs**

Two defensible answers, and the measurement decides:

* If the measured maximum and php's 76,104 both fit under a page-aligned size
  materially below 262,144 — size the slab to `page_round_up(max)` and record
  the measurement in the comment, replacing the deleted
  `RESUME_CATALOG_CAP * 4` justification.
* If they do not — size it to 65,536 (the module's own internal scratch, which
  is the one number in that comment that survives Task 6) and record that php
  now takes the channel-mmap fallback on every boot, with the measured cost.

**Write the number's reason in the file.** A tuning constant whose stated
justification has been deleted is how the dangling
`FORK_MODULE_STAGING_BYTES` citation happened in the first place.

- [ ] **Step 4: Fix the dangling citation in the module**

`crates/fork-module/src/lib.rs:441-445` names `FORK_MODULE_STAGING_BYTES`,
which does not exist anywhere in the repository. Task 6 deleted most of that
comment block; whatever survives must name `STAGING_SLAB_BYTES`
(`host/src/fork-module-instance.ts:113`) or be deleted outright.

```bash
grep -rn "FORK_MODULE_STAGING_BYTES" . --include=*.rs --include=*.ts | grep -v node_modules
```

Expected after this step: **no output.**

- [ ] **Step 5: Check the native host's region, which has no slab at all**

`crates/host-native/src/guest.rs:6712-6720` reserves
`static_bytes + FORK_MODULE_SHADOW_STACK_BYTES` and places the region to END
at `layout.max_addr`. It carries no slab term, so this task does not change
it — but confirm that, rather than assume it, and say so:

```bash
sed -n '6705,6730p' crates/host-native/src/guest.rs
cargo test -p wasm-posix-host-native
```

- [ ] **Step 6: Perturb the fallback test**

The Step 2 test is the one this task's correctness rests on, and it is new, so
prove it can fail. Break the fallback deliberately — make the over-slab branch
in `host/src/fork-module-backend.ts` stage into the slab anyway, truncating —
and confirm the byte-identical read-back assertion goes red. Restore from a
copy taken first.

**If it stays green, the test is not reading back what was staged**, and
shrinking the slab would then be choosing an unverified path for every seed
above the new size.

- [ ] **Step 7: Verify the region and commit**

```bash
cd host && npx vitest run test/fork-module-instance.test.ts
```

Read `fm.regionBytes` and confirm it fell by exactly
`262,144 − <new slab>`. No rounding, no page step.

```bash
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add host/src/fork-module-instance.ts host/src/fork-module-backend.ts \
  crates/fork-module/src/lib.rs host/test/ docs/surface-budget.json
git commit -m "Fork: Size the staging slab from a measurement, not a deleted cap"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 8: The five small per-activation stores

**This commit moves ZERO region bytes.** 14,592 bytes against a 43,948-byte
threshold at this point in the ledger. Even together they cannot move the
reservation, and this task says so rather than implying a win it does not
deliver.

**What it DOES buy, and why it is worth a commit:**

1. **The rule, which is not "no statics".** Decision 10: "nothing reserved at
   process START". The module's `dylink.0 memorySize` is reserved out of the
   guest's mmap window at instantiation, so every fixed array is billed to
   every fork-capable thread whether it ever forks. 14,592 bytes × the thread
   count is real, it is just below the page step the region reports in.
2. **A lifetime, which none of them has.** All five are bump-only within a
   worker with no release path (Task 0 section E). `ACT_TABLE_STATE_OWNER_COUNT`
   and the two base maps are reset by the COW scrub; the provenance table and
   the template ids are not reset anywhere. A `dlopen`/`dlclose` loop
   monotonically exhausts all five today.
3. **Uniformity.** After this, `arena_release_activation` is the ONE place a
   `dlclose` frees per-activation state, rather than one place plus five
   arrays nobody frees.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:1240-1320`
  (`IMPORTED_GLOBAL_PROVENANCE`, `set_import_provenance_impl`)
- Modify: `crates/fork-module/src/lib.rs:1555-1600` (`ACT_TEMPLATE_IDS`)
- Modify: `crates/fork-module/src/lib.rs:1660-1700` (`ACT_TABLE_STATE_OWNERS`)
- Modify: `crates/fork-module/src/lib.rs:945-958` (`ACT_FUNC_CATALOG_BASE`)
- Modify: `crates/fork-module/src/lib.rs:1779-1800` (`ACT_STATIC_ROOT_BASE`)
- Modify: `crates/fork-module/src/lib.rs:3510-3530` (the scrub's four counter
  resets)

**Interfaces:**
- Consumes: `arena_alloc`, `arena_extend`, `arena_find` (Task 1)
- Note: these five APPEND one fixed-size entry at a time rather than declaring
  a size up front, which is what `arena_extend` exists for. `ProvenanceEntry`
  is 32 bytes under `#[repr(C, align(8))]` (five `u32`, 4 bytes tail padding,
  one `u64`); `ActTemplateIds` entries are 36 bytes (`u32` + `[u8; 32]`, no
  padding). Both figures are re-derived and correct; do not recompute them
  from the struct definitions.

- [ ] **Step 1: Read `arena_extend`'s cost before using it five times**

`arena_extend` re-allocates and copies, because records never move. For the
three stores whose entry count is bounded by a real quantity — one table
coordinate per activation, one catalog base, one static-root base — the record
is one or two entries and the copy is free. For `IMPORTED_GLOBAL_PROVENANCE`
(up to 256 entries, keyed by the composite
`(space, consumer_activation, import_ordinal)`) it is not.

**Group provenance entries by their consumer activation** — the key's
`consumer_activation` component is the dlclose trigger's key — and size the
record from the count the host declares if one is available. If none is, use
`arena_extend` and report the measured re-allocation count across the fork
suite. If it exceeds the entry count (i.e. it is re-allocating more than once
per entry), stop: the growth policy is wrong and copying it five times over
would be worse.

- [ ] **Step 2: Write the failing test — the dlopen/dlclose exhaustion**

This is the defect Task 0 section E names, and nothing in the tree tests it:

```ts
/**
 * WHY THIS EXISTS
 *
 * These five stores were bump-only within a worker with no release path.
 * `ACT_TEMPLATE_ID_COUNT` and `IMPORTED_GLOBAL_PROVENANCE_COUNT` are not
 * reset even by the COW-child scrub, so a dlopen/dlclose loop monotonically
 * exhausted them: the 65th activation got `E2BIG` for template ids and the
 * 257th coordinate got it for provenance, in a worker that never forked.
 *
 * The loop below runs past both of those numbers. It could not have passed
 * before this task.
 */
it("survives more dlopen/dlclose cycles than the old caps allowed", () => {
  const x = instantiateFixtureModule();
  for (let act = 1; act <= 300; act += 1) {
    x.seedActivationCatalog(act, [1, 2]);
    x.seedTemplateId(act, templateIdFor(act));
    x.seedTableStateOwner(act, 1, 1);
    expect(x.errno(), `seeding activation ${act}`).toBe(0);
    x.slots(1, act, 0);                            // dlclose
    expect(x.errno(), `releasing activation ${act}`).toBe(0);
  }
  // And every chunk goes back.
  expect(x.stats(ARENA_RECORD_CHUNK_COUNT_FIELD)).toBe(0);
  expect(x.stats(ARENA_DIRECTORY_CHUNK_COUNT_FIELD)).toBe(0);
});
```

300 exceeds both `TEMPLATE_ID_MAX_ACTS` (64) and
`IMPORTED_GLOBAL_PROVENANCE_MAX` (256). **Run it against the pre-task module
first and confirm it fails with `E2BIG`** — a test written for a defect that
turns out not to reproduce is a test that cannot fail.

- [ ] **Step 3: Convert all five**

Preserve every existing refusal semantic exactly, because they differ
deliberately and the differences are documented:

* `ACT_TEMPLATE_IDS` — a re-seed with the SAME id is idempotent (a COW child
  re-seeds with the same hash of the same module's bytes); a re-seed with a
  DIFFERENT id is `EINVAL` ("two modules under one activation").
* `ACT_TABLE_STATE_OWNERS` — a re-seed **UPDATES**, deliberately the opposite
  of the catalogs, "because the host re-elects whenever a lower coordinate
  registers for the same physical table, so the incumbent must be demotable.
  Refusing the second seed would freeze the first election and leave two
  writers." Owner 0 is `EINVAL`.
* `IMPORTED_GLOBAL_PROVENANCE` — a re-seed of a coordinate **UPDATES**, same
  reason; an unknown `kind` is `EINVAL`, and `BASE_IMPORT` is excluded on
  purpose.
* The two base maps — a re-seed is `EINVAL`; an EMPTY map means
  single-activation and the reader defaults `base = 0`, byte-identical to raw
  ordinals. **`arena_find` returning `None` must keep meaning `base = 0`, not
  become an error.**

- [ ] **Step 4: Remove the four counter resets from the scrub**

`ACT_FUNC_CATALOG_BASE_COUNT`, `ACT_STATIC_ROOT_BASE_COUNT`,
`ACT_TABLE_STATE_OWNER_COUNT` and the KFIG/catalog counters Tasks 4 and 6
already removed are now `arena_release_all()`'s job. **Delete the dead stores,
do not leave them.** The comment block at `lib.rs:3480-3545` explains each
reset's reason; rewrite it to describe what the scrub now does, in one place,
rather than leaving reasons for resets that no longer exist.

- [ ] **Step 5: Rebuild, verify fresh, confirm the ZERO**

Expected `memorySize`: **1,153,604**. Expected `regionBytes`: **2,490,368 −
(Task 7's slab reduction)** — **unchanged by this task**.

```bash
cd host && npx vitest run test/fork-module-instance.test.ts
```

**Say the region did not move, and say why** (14,592 bytes against a 43,948
threshold). Do not report a `memorySize` delta as if it were a reservation
delta.

- [ ] **Step 6: Perturb the table-state UPDATE semantics**

Change the table-state-owner re-seed from update to `EINVAL`. The election
tests must go red. This is the one of the five whose refusal semantics differ
from its neighbours' on purpose, so it is the one most likely to be
homogenised by accident during a five-store conversion.

- [ ] **Step 7: Budget, then commit**

```bash
cd host && npx vitest run test/fork-*.test.ts
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/
git commit -m "Fork: Give the five small per-activation stores a lifetime"
git push origin brandonpayton/lane-f-fork-inversion
```

Body: **states plainly that this moves zero region bytes**, and that it lands
for the stated rule (nothing reserved at process start) and for the
dlopen/dlclose exhaustion it closes.

---

## Task 9: The heap floor goes to zero

**1,048,576 bytes — sixteen pages, the largest single saving in the plan**,
larger than the resume-slot index. The spec treats it as an aside under "The
allocator itself"; it is not.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:3595-3640` (`HEAP_FLOOR`, `HeapCell`,
  `HEAP`, and the two contradictory comment paragraphs)
- Modify: `crates/fork-module/src/lib.rs` (`Bump::region_span`,
  `Bump::advance_region`, `Bump::grow` — the "region 0 is the static floor"
  special case)

- [ ] **Step 1: Confirm the two preconditions yourself**

The spec asserts both; verify them rather than inherit them.

(a) `channel_mmap` performs no allocation, so calling it from inside the
global allocator cannot recurse:

```bash
sed -n '4219,4234p' crates/fork-module/src/lib.rs
```

It calls `channel_syscall` with a fixed `[i64; 6]`. No `Vec`, no `Box`, no
`format!`. Confirm.

(b) Nothing allocates before `fm_set_format` stores `CHANNEL_BASE`:

```bash
grep -n "CHANNEL_BASE.store" crates/fork-module/src/lib.rs
```

`fm_set_format` is the first module call the backend makes. Confirm the store
precedes every allocating path in that function — including the
`arena_release_all()` Task 1 added, which is why that was sequenced after it.

**If either fails, STOP.** A floor of zero with a recursing allocator is an
infinite loop at instantiation, not a test failure.

- [ ] **Step 2: Correct the retracted justification, in the same change**

`lib.rs:3620-3625` still reads: "a fork CHILD re-seeds its catalogs while the
kernel is still creating it, and a syscall there is refused". **This lane
retracted that claim** (`docs/plans/2026-09-16-lane-f-closure.md:1531`), and
the spec's own experiment refuted it directly: forcing `ACT_GC_CODEC_FLOOR` to
1 made every activation's codec take its own mapping during child seeding, and
`fork-module-gc-replay.test.ts` passed 5/5. **A fork child's `channel_mmap` is
serviced.**

The same block also carries a stale paragraph at `lib.rs:3606-3610` claiming
"4 MiB comfortably covers a single fork's peak state", immediately above the
paragraph saying it was 4 MiB and is now 1 MiB — two contradictory statements
of the constant's value in one comment. Both go.

- [ ] **Step 3: Write the failing test**

The floor's disappearance is observable: the allocator's first allocation now
maps a chunk, so a module that never allocates holds zero heap chunks and one
that does holds at least one.

```ts
/**
 * WHY THIS EXISTS
 *
 * `HEAP_FLOOR` was 1 MiB of static BSS reserved out of the guest's mmap
 * window whether a program forked or not -- "a fork CHILD re-seeds its
 * catalogs while the kernel is still creating it, and a syscall there is
 * refused". That justification was RETRACTED: the spec's experiment made
 * every activation's GC codec take its own mapping during child seeding and
 * `fork-module-gc-replay.test.ts` passed 5/5. A fork child's `channel_mmap`
 * IS serviced.
 *
 * So the floor is gone and the first chunk comes from `channel_mmap` like
 * any other. The assertion that matters is that a module which has done
 * nothing holds NOTHING -- which is the whole point of the change, and which
 * the 1 MiB static made untestable.
 */
it("holds no heap before the first allocation", () => {
  const x = instantiateFixtureModule();
  expect(x.mmaps(), "instantiation alone maps nothing").toBe(0);
  x.seedActivationCatalog(ACTIVATION, [1, 2, 3]);
  expect(x.mmaps(), "the first real work maps").toBeGreaterThan(0);
});
```

`mmaps()` reads the responder's `SYS_MMAP` tally; add it beside the existing
`MUNMAP_COUNTER` in `host/test/fork-module-capture-fixture` if it is not
already there.

- [ ] **Step 4: Implement**

`HEAP_FLOOR` → 0, `HeapCell`/`HEAP` deleted, and `Bump`'s "region 0 is the
static floor" special case goes with them — `region == 0` now means "no region
yet", and the first `alloc` takes the `grow()` path. Read
`Bump::region_span`, `advance_region` and `grow` together before editing; the
floor is referenced in all three.

The retained-chunk behaviour is unchanged and is what makes this cheap: chunks
are kept across `reset()`, so a worker pays for growth once and reuses it for
every later fork.

- [ ] **Step 5: Rebuild, verify fresh, check the ledger row**

Expected `memorySize`: **105,028**. Expected `regionBytes`:
**1,179,648 + (Task 7's slab)** — down 1,048,576 from Task 8.

```bash
cd host && npx vitest run test/fork-module-instance.test.ts
```

- [ ] **Step 6: Run the child path specifically**

The retracted justification was about CHILDREN. Run the tests that fork:

```bash
cd host && npx vitest run test/fork-module-gc-replay.test.ts \
  test/fork-from-dlopen-side-module-e2e.test.ts \
  test/fork-module-worker-instantiation.test.ts
```

`fork-module-worker-instantiation.test.ts` is the one that failed in the
spec's experiment with `ProcessMemoryCapacityError: Process memory request
exceeds admission budget 16973824`. **After this task the module's region is
roughly a third of what it was, so that budget should now be comfortable.**
Report whether it is, with the number.

- [ ] **Step 7: Perturb**

Set `HEAP_FLOOR` back to a small non-zero value (4,096) and confirm the "maps
nothing at instantiation" assertion goes red. That proves the assertion is
reading the allocator and not something else.

- [ ] **Step 8: Budget, then commit**

```bash
cd host && npx vitest run test/fork-*.test.ts
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/
git commit -m "Fork: Take the allocator floor to zero and retire its false reason"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 10: The guest-facing scratch stack gets its own chain

**65,536 bytes — one page.** And it is the transient the spec got right for
the right reason: `ScratchCell` is a GUEST-FACING allocator, so it goes on its
own chain, **not** the bump heap.

`__wpk_fork_ref_scratch_reserve(len)` returns
`(SCRATCH.0.get() as usize).wrapping_add(top)` — a raw guest linear-memory
address the guest writes through directly across its own recursive encode,
calling back into the module in between. A bump reset between reserve and
release would hand the next reserve a region overlapping a live one, arriving
by a route `__wpk_fork_ref_scratch_release`'s trap cannot see.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:3893-3910` (`SCRATCH_SIZE`,
  `ScratchCell`, `SCRATCH`, `SCRATCH_TOP`, `SCRATCH_HIGH_WATER`)
- Modify: `crates/fork-module/src/lib.rs:8507-8537` (the two guest entries)
- Modify: `crates/fork-module/src/lib.rs:3980-4000` (`reset_bump_heap`)
- Modify: `crates/fork-module/src/lib.rs:10880-10905` (the high-water
  `fm_stats` reader, which reads `SCRATCH_HIGH_WATER`)

**Interfaces:**
- Produces:

```rust
static SCRATCH_HEAD: AtomicU64 = AtomicU64::new(0);
/// The chunk frames are currently being cut from.
static SCRATCH_CUR: AtomicU64 = AtomicU64::new(0);
/// Offset within `SCRATCH_CUR`'s body.
static SCRATCH_TOP: AtomicUsize = AtomicUsize::new(0);

/// Abandon every open frame and return every chunk. Called at all four
/// `reset_bump_heap` points.
fn scratch_abort_frames();
fn scratch_chunk_count() -> u32;
```

- [ ] **Step 1: Preserve the reset coupling — it is a fixed defect, not an artifact**

`reset_bump_heap` already zeroes `SCRATCH_TOP` and `SCRATCH_HIGH_WATER`
(`lib.rs:3988-3990`), with a reason in the code:

> A capture that trapped or aborted mid-encode leaves its staging frames on
> the scratch stack. Reclaim them with the bump, or the next fork in this
> worker starts with a stack that never comes back down.

**Moving the STORAGE off the bump heap does not remove that coupling.** And
there is a second, sharper consequence the spec misses: today a reset between
a reserve and its release turns into a **trap**, because the release's
`need > top` check fires against a zeroed `top`. A chain-backed scratch that
kept its cursor across a reset would silently lose that trap.

So the chain needs an explicit abort at each reset point, not merely a
different backing store. Call `scratch_abort_frames()` at all four — and use
the CURRENT line numbers, not the spec's, which are all wrong by 18-19:

| function | current line |
|---|---|
| `begin_unwind_impl` | `lib.rs:4599` (CONDITIONAL on `CAPTURE_ARMED == 0`, `lib.rs:4594`) |
| `begin_child_replay_impl` | `lib.rs:5185` |
| `fm_capture_begin` | `lib.rs:7947` |
| `capture_peer_tables_impl` | `lib.rs:10351` |

Put the call inside `reset_bump_heap` itself, beside the existing
`SCRATCH_TOP.store(0)` it replaces, so there is one site rather than four.

- [ ] **Step 2: Handle the frame-crosses-a-chunk case explicitly**

`__wpk_fork_ref_scratch_release(ptr, len)` today computes
`base.wrapping_add(top - need)` against ONE contiguous region. On a chain, a
reserve that does not fit the current chunk takes a new one and places the
frame at its base — so `top` restarts and the arithmetic breaks.

The fix is per-chunk: a scratch chunk uses a 32-byte header — Task 1's
`+0 next: u64`, `+8 size: u64`, `+16 used: u32`, `+20 live: u32`, plus
`+24 prev: u64` — and a release whose `need > top` pops to `prev` and
recomputes there,
**still trapping** if the resulting address does not name the frame the caller
passed. The trap is the contract ("a release that does not match the top means
the nesting the whole scheme assumes has been violated, and continuing would
hand the next reserve a region that overlaps a live one"). Do not soften it.

**A frame larger than `ARENA_CHUNK_BYTES` gets its own oversized chunk**, via
the same `max(ARENA_CHUNK_BYTES, header + want)` rule.

- [ ] **Step 3: Write the failing test**

```ts
/**
 * WHY THIS EXISTS
 *
 * The scratch stack hands the GUEST a raw linear-memory address it writes
 * through directly across a recursive encode. Chaining it means a frame can
 * now land at the base of a fresh chunk, so the release arithmetic --
 * "`ptr` must equal `base + top - need`" -- has to work across a chunk
 * boundary, and must still TRAP when it does not. That trap is the only
 * thing standing between a mis-nested release and silent capture corruption.
 */
const SCRATCH_CHUNK_COUNT_FIELD = 104;

it("reserves and releases across a chunk boundary", () => { ... });
it("traps on a release that does not name the top frame", () => { ... });
it("returns every chunk when a reset aborts open frames", () => {
  // Reserve without releasing, then drive a reset. Every chunk must come
  // back -- the defect the existing `SCRATCH_TOP.store(0)` comment records
  // as already fixed, arriving by a new route.
  expect(x.stats(SCRATCH_CHUNK_COUNT_FIELD)).toBe(0);
  expect(x.munmaps() - before).toBe(chunksHeld);
});
```

- [ ] **Step 4: Keep the high-water observable honest**

`fm_stats` reads `SCRATCH_HIGH_WATER` (`lib.rs:10900-10903`). Across chunks,
"the deepest top reached" is no longer a single offset. Make it total bytes
across all live chunks, and **update the field's doc comment to say what it
now measures.** A stat whose comment describes the previous definition is the
class this lane keeps finding.

- [ ] **Step 5: Rebuild, verify fresh, check the ledger row**

Expected `memorySize`: **39,492**. Expected `regionBytes`: down 65,536.

- [ ] **Step 6: Perturb the trap**

Make the release accept a `ptr` that is merely within the current chunk rather
than exactly the top frame. The trap test must go red. **The wasm trap is the
observable here** — the test asserts the call traps, so confirm it does by
seeing the failure, not by reading the code.

- [ ] **Step 7: Budget, then commit**

```bash
cd host && npx vitest run test/fork-*.test.ts
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/
git commit -m "Fork: Chain the guest-facing scratch stack and keep its trap"
git push origin brandonpayton/lane-f-fork-inversion
```

---

## Task 11: `CapturedExternrefs` to the bump heap, with the corrected ordering

**This commit moves ZERO region bytes.** 16,384 bytes against a 47,684-byte
threshold. It lands because the store's lifetime is genuinely per-capture and
the bump heap is where per-capture storage belongs — and because the spec's
ordering requirement for it names the wrong function, which is worth correcting
in the tree.

**Files:**
- Modify: `crates/fork-module/src/lib.rs:8124-8135` (`CAPTURED_EXTERNREF_MAX`,
  `CapturedExternrefs`, `CAPTURED_EXTERNREFS`, count, overflow flag)
- Modify: `crates/fork-module/src/lib.rs:4716-4730` (`begin_capture_impl` —
  the ordering fix)
- Modify: `crates/fork-module/src/lib.rs:3409-3418` (`VectorInFlight` — Step 5)

- [ ] **Step 1: Read the real hazard, which is not the one the spec guards**

The spec says: "Since `fm_capture_begin` is itself one of the reset points,
the allocation must happen AFTER the reset in that entry, not before."

**`fm_capture_begin` does not call `reset_captured_externrefs()` at all.**

```bash
sed -n '7921,7960p' crates/fork-module/src/lib.rs
grep -n "reset_captured_externrefs" crates/fork-module/src/lib.rs
```

The three real clear sites are `set_format_impl:3534` (the COW-child scrub),
`begin_capture_impl:4725` (the real "cleared when a capture begins") and
`capture_peer_tables_impl:10368`.

**The hazard is at `begin_capture_impl`, and it is the OPPOSITE ordering.** It
clears at `:4725` and THEN calls `begin_unwind_impl(0, channel_base)` at
`:4727`, which may `reset_bump_heap()` at `:4599`. As a bump allocation, the
buffer made at `:4725` is reclaimed at `:4599` while the capture that will
write into it is only just starting — **and a reclaimed bump region is REUSED,
not poisoned, so the result is a wrong externref lease rather than a trap.**
That is the silent-wrong-answer class the spec's risk 6 names, and the spec's
own remedy walks into it.

`capture_peer_tables_impl` already has the safe order (reset at `:10351`,
clear at `:10368`).

- [ ] **Step 2: Write the failing test FIRST, against the ordering**

```ts
/**
 * WHY THIS EXISTS
 *
 * `CapturedExternrefs` becomes a bump-heap allocation, and the bump heap is
 * reset at four points during a single fork. `begin_capture_impl` clears the
 * set and THEN calls `begin_unwind_impl`, which may reset the bump -- so an
 * allocation made before that call is handed back out to the next
 * allocation. A reclaimed bump region is REUSED, not poisoned, so the
 * failure is a wrong externref lease, not a trap, and nothing else in the
 * suite would see it.
 *
 * The assertion is therefore on the VALUES, not on a count: capture a known
 * set of externrefs and require every one to come back identical.
 */
it("reports the externrefs it captured, not whatever reused their storage", () => {
  const known = [11, 22, 33, 44];
  x.captureWith(known);
  expect(x.capturedCount()).toBe(known.length);
  for (let i = 0; i < known.length; i += 1) {
    expect(x.capturedAt(i), `externref ${i}`).toBe(known[i]);
  }
});
```

`capturedCount` / `capturedAt` are the existing `fm_captured_externref_count`
(`lib.rs:8156`) and `fm_captured_externref` (`lib.rs:8165`) host queries. No
new entry.

- [ ] **Step 3: Fix the ordering, then convert**

Move the `reset_captured_externrefs()` at `lib.rs:4725` to AFTER the
`begin_unwind_impl` call at `:4727`, matching the order
`capture_peer_tables_impl` already has, with the reason written down. **Then**
make the storage a bump allocation.

- [ ] **Step 4: Rebuild, verify fresh, confirm the ZERO**

Expected `memorySize`: **23,108**. Expected `regionBytes`: **unchanged**. Say
so explicitly.

- [ ] **Step 5: STOP on `VectorInFlight` and ask**

**Do not decide this one.** The spec contradicts itself:

* Decision notes: "`VECTOR_IN_FLIGHT` was withdrawn as a candidate: it is a
  matched push/pop stack whose lifetime fits the bump heap, and its depth-8
  limit is a correctness assertion, not storage."
* The "Every static, and where it goes" table: "**its own chain too**", on the
  grounds that the guest holds a handle across `begin`/`finish` and a reset
  between them reclaims the backing.

At **96 bytes** (`VECTOR_STACK_DEPTH = 8`, entries `[[u32; 3]; 8]`) it is the
cheapest of all twenty statics, and decision 10 explicitly permits leaving it
("a statically sized list is acceptable when it corresponds to a known fixed
quantity" — here, a nesting depth of 8 that the emitted code reaches 3 of).
Converting it would add a chain, a root, an observable, a release path and a
perturbation test for 96 bytes.

Land the part that is not in dispute — make the depth-8 overflow "a loud
refusal rather than a silently mis-counted vector", as an explicit assertion
rather than a side effect of array capacity — and then **STOP and ask the
maintainer which of the spec's two statements governs.** State the cost of
each option and your recommendation (leave it static, under decision 10). Do
not self-defer and do not silently convert it.

- [ ] **Step 6: Perturb the ordering fix**

Move `reset_captured_externrefs()` back before `begin_unwind_impl`. The Step 2
value assertion must go red. **If it stays green, the reset is not reaching
the buffer and the test is not testing the ordering** — find out why before
proceeding, because a green test on this path is exactly the silent-wrong-
answer the task exists to prevent.

- [ ] **Step 7: Budget, then commit**

```bash
cd host && npx vitest run test/fork-*.test.ts
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/
git commit -m "Fork: Bump-allocate the captured-externref set after the reset"
git push origin brandonpayton/lane-f-fork-inversion
```

Body: moves zero region bytes; corrects an ordering the spec got backwards;
`VectorInFlight` left for the maintainer with the argument recorded.

---

## Task 12: The forced-chunk build, and the full suite in both

This is the spec's decision 2, and it is not optional: **a conversion whose
chunk path has not executed is not tested.**

The precedent is direct. `RESUME_SLOT_INDEX` passed every suite at a
4,096-entry floor because no test ever needed a chunk, then deadlocked every
process at a forced 4-entry floor — all parked in `channel_mmap` on
`memory_atomic_wait32`. And forcing `ACT_GC_CODEC_FLOOR` to 1 ran 185 tests
across 29 files in about 25 minutes and surfaced two real defects invisible in
the default build.

**Files:**
- Temporarily modify: `crates/fork-module/src/lib.rs` (`ARENA_CHUNK_BYTES`)
- Modify: whatever the run surfaces

- [ ] **Step 1: Confirm no build is live, then take a pristine copy**

```bash
cd /Users/brandon/kandelo-lane-f
pgrep -fl "xtask local-build" || echo "no local-build running"
git status --short
cp crates/fork-module/src/lib.rs /tmp/claude-501/fork-storage-pristine/lib-task12.rs
cat local-binaries/fork_module32.wasm.build-key > /tmp/claude-501/key-before.txt
```

**Never run vitest while an `xtask local-build` closure is live** — the test
runner regenerates `packages/registry/program-packages.json`, a build-graph
input.

- [ ] **Step 2: Force every chain's first chunk small**

One line, because Task 1 put every chain on one constant:

```rust
const ARENA_CHUNK_BYTES: u64 = 4_096;
```

**A source edit, not an env var**, for the reason in Global Constraints: the
build key is derived from source, so an env-driven variant would produce
different artifact bytes under an identical key.

4,096 is a whole wasm page's worth of records for the small stores and forces
the oversized-chunk path for every real catalog. If the chunk allocator
refuses a size below one wasm page, use the smallest it accepts and say so —
the point is that chunks CHAIN, not that they are tiny.

```bash
bash crates/fork-module/build-wasm.sh
diff <(cat local-binaries/fork_module32.wasm.build-key) /tmp/claude-501/key-before.txt \
  && echo "KEY UNCHANGED -- THE PERTURBATION DID NOT REACH THE ARTIFACT; STOP" \
  || echo "key moved, as expected"
```

- [ ] **Step 3: Run the full suite, and record what it ran**

```bash
cd host && npx vitest run 2>&1 | tee /tmp/claude-501/forced-chunk-run.txt
echo "SUITE EXIT: $?"
tail -20 /tmp/claude-501/forced-chunk-run.txt
```

**Gate on the exit status, and record the file and test counts**, not just
"passed". The spec's baseline is 185 tests across 29 files in ~25 minutes; a
run that covers materially less has not run the suite, and a green summary
line printed in an unconditional block says "ok" on the same run that lists
failures.

If anything HANGS, that is the `RESUME_SLOT_INDEX` deadlock reproducing inside
the change, which the spec's risk 1 anticipated. Capture where every worker is
parked before killing anything.

- [ ] **Step 4: Fix what it surfaced, in the default build**

Every defect the forced build finds is a real defect. Fix each one, and for
each: name the store, name the chunk boundary it crossed, and say whether the
default build could ever have reached it.

- [ ] **Step 5: Restore, rebuild, and run the suite again in the default build**

```bash
cd /Users/brandon/kandelo-lane-f
cp /tmp/claude-501/fork-storage-pristine/lib-task12.rs crates/fork-module/src/lib.rs
```

**Re-apply any Step 4 fixes on top of the restored file** — the pristine copy
predates them. Then:

```bash
cd /Users/brandon/kandelo-lane-f
bash crates/fork-module/build-wasm.sh
bash crates/fork-module/build-wasm.sh --verify-fresh; echo "FRESH: $?"
diff <(cat local-binaries/fork_module32.wasm.build-key) /tmp/claude-501/key-before.txt \
  && echo "key restored" || echo "key differs -- expected if Step 4 changed source"
cd host && npx vitest run 2>&1 | tee /tmp/claude-501/default-run.txt
echo "SUITE EXIT: $?"
```

**Both runs must be green.** Report both, with their file and test counts and
their durations.

- [ ] **Step 6: Commit**

```bash
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/
git status --short
git commit -m "Fork: Fix what the forced-chunk build found"
git push origin brandonpayton/lane-f-fork-inversion
```

If Step 4 found nothing, commit nothing and say so — but say it with the two
run summaries attached, because "the forced build was green" is a claim and
the run is its evidence.

---

## Task 13: Measure the result and correct the record

The plan predicted a ledger. This task checks it, banks it, and fixes the
documents that are now wrong — including this plan's own source spec, which
Task 0 catalogued twelve stale claims in.

**Files:**
- Modify: `host/test/fork-module-instance.test.ts`
- Modify: `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`
- Modify: `docs/surface-budget.json` (final banking, if anything moved that
  Tasks 6 and 7 did not already bank)
- Modify: `crates/fork-module/src/lib.rs` (any comment still describing a
  static that no longer exists)

- [ ] **Step 1: Measure the real result, both numbers**

```bash
cd /Users/brandon/kandelo-lane-f
node -e '
const fs=require("fs");
const m=new WebAssembly.Module(fs.readFileSync("local-binaries/fork_module32.wasm"));
const b=new Uint8Array(WebAssembly.Module.customSections(m,"dylink.0")[0]); let i=0;
const uleb=()=>{let r=0,sh=0,x;do{x=b[i++];r|=(x&0x7f)<<sh;sh+=7}while(x&0x80);return r>>>0};
i++; uleb();
console.log("memorySize", uleb());
'
cd host && npx vitest run test/fork-module-instance.test.ts
```

Report `memorySize` and `fm.regionBytes` against the ledger's final row
(**~23,108** and **~1,179,648 + slab**). A discrepancy is a finding, not a
rounding error — say what it is.

Also state the honest shape of the win, which the spec does state and which it
would be easy to overclaim: **the reservation still has a shadow stack in
it.** 1,048,576 of the remaining ~1.18 MiB is the module's own Rust call
stack, and WebAssembly has no guard page, so an overflow corrupts rather than
traps. Shrinking it requires measuring the module's actual maximum stack depth
across a fork — recorded as follow-up work with that measurement named, not
done here.

- [ ] **Step 2: Assert the result, in a form that cannot become a floor**

`host/test/fork-module-instance.test.ts:47-58` already asserts by derivation
rather than by constant, which is why it survived this work. **Do not add a
`toBeLessThan(<constant>)` beside it** — that is the same defect the
`toBeGreaterThan(4 MiB)` was, pointing the other way, and it would fail on any
future static ADDITION regardless of whether the addition was correct.

Assert instead that the region contains nothing it does not need:

```ts
// The region is exactly what the layout formula says, and the formula's
// terms are the module's own declared sizes. This is the shape that survived
// the storage conversion: the previous `toBeGreaterThan(4 MiB)` was a FLOOR
// ON MEMORY USE wearing the shape of a guard, and it failed on the first
// conversion that shrank anything.
expect(fm.regionBytes).toBe(
  Math.ceil((fm.staticBytes + fm.shadowStackBytes) / 65536) * 65536
    + fm.stagingBytes,
);
```

That is the FOUR-term formula (research item 3), which the spec renders as
three and which is why its arithmetic came out 29,372 bytes short.

- [ ] **Step 3: Correct the spec in place**

Task 0 lists twelve stale claims. Fix each one in
`docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`, in place,
with a dated amendment line — not by appending a thirteenth section.

Priority order (the ones that would cost a future reader most):

1. `host/src/fork-module-state.ts` does not exist on this branch.
2. `FORK_MODULE_STAGING_BYTES` does not exist.
3. The reservation formula has four terms.
4. Risk 7's prerequisite is done; delete risk 7.
5. Decision 5's prerequisite commit is done.
6. `CapturedExternrefs`'s ordering names the wrong function.
7. The four `reset_bump_heap` line numbers.
8. The legacy-harness retirement is two branches.
9. The empty-catalog case is reachable and is in the suite.
10-12. Line drift, the `VectorInFlight` self-contradiction, and "three of
    three".

**Also add the two findings the spec does not contain**: the 36,164-byte
threshold and the already-false compaction premise. A future reader of that
spec should not have to find the research document to learn either.

- [ ] **Step 4: Sweep the module for comments describing deleted statics**

```bash
cd /Users/brandon/kandelo-lane-f
grep -n "RESUME_CATALOG_CAP\|HEAP_FLOOR\|ACT_KFIG_BYTES_CAP\|ACT_GC_CODEC_FLOOR\|\
ACT_EXN_TAGS_ORD_FLOOR\|ACTIVATION_CATALOG_ORD_FLOOR\|RESUME_SLOT_CAP\|\
TEMPLATE_ID_MAX_ACTS\|TABLE_STATE_OWNER_MAX\|IMPORTED_GLOBAL_PROVENANCE_MAX\|\
FUNC_CATALOG_BASE_MAX_ACTS\|STATIC_ROOT_BASE_MAX_ACTS\|SCRATCH_SIZE" \
  crates/fork-module/src/lib.rs
```

Every surviving hit is either a comment about a constant that no longer
exists, or a constant this plan failed to delete. Both are findings. Resolve
each and say which it was.

Also check that no doc comment names a test that does not assert what it
claims — the defect the identity registry's own comment carried for its whole
existence, corrected at `lib.rs:1160-1185`:

```bash
grep -n "asserted by\|asserts\|test that\|\.test\.ts" crates/fork-module/src/lib.rs
```

For each named test, open it and confirm it CALLS the module rather than
reading its source with a regex.

- [ ] **Step 5: Final full suite, both hosts' Rust side, and the budget**

```bash
cd /Users/brandon/kandelo-lane-f
cargo test -p wasm-posix-host-native 2>&1 | tail -20; echo "NATIVE EXIT: $?"
cd host && npx vitest run 2>&1 | tail -20; echo "SUITE EXIT: $?"
cd host && npx vitest run test/surface-budget.test.ts && echo "BUDGET OK"
```

Gate on every exit status with `&&`, never `;`.

- [ ] **Step 6: Commit**

```bash
cd /Users/brandon/kandelo-lane-f
git add crates/fork-module/src/lib.rs host/test/fork-module-instance.test.ts \
  docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md \
  docs/surface-budget.json
git status --short
git commit -m "Fork: Bank the storage conversion and correct its spec"
git push origin brandonpayton/lane-f-fork-inversion
```

The body carries the measured before/after for BOTH numbers, names the
remaining shadow stack as the largest surviving term, and says the twelve spec
corrections landed.

---

## What this plan does NOT cover

- **The build path (Change 1 of the spec).** The nine hand-maintained copies
  of the link contract, the `__heap_base` guard, the SDK honouring a smaller
  stack, P-11's two fixtures and the 4,096-deep recursion's headroom. The spec
  orders it BEFORE this change, so it either landed already or the arena sizes
  here were chosen against a layout about to move. **Check which before Task 1**
  — `scripts/build-programs.sh` still invoking `clang` with a hand-maintained
  `LINK_POST_LIBS` array means it has not landed.
- **`commit_table_mutation_impl`'s archive-chain record per table mutation**,
  which has no release path naming it. Structural leak by inspection,
  unmeasured, predates this lane. Out of scope by the spec.
- **Any change to what P-11 asserts.** Out of scope by the spec.
- **The shadow stack.** 1,048,576 bytes and the largest surviving term after
  this work. Shrinking it requires measuring the module's actual maximum stack
  depth across a fork rather than asserting a number, and WebAssembly's lack
  of a guard page means a wrong answer corrupts rather than traps. Follow-up,
  with that measurement named.
- **The native host re-seeding the GC codec on a COW child** (Task 5 Step 1
  option (b)). It would remove a Node/browser divergence, and it is a
  native-host behaviour change that does not belong in a storage conversion.
  Reported as follow-up.
- **`VectorInFlight`.** Task 11 Step 5 lands the depth-8 assertion and asks
  the maintainer which of the spec's two contradictory statements governs.
