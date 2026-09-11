# Fork TypeScript census — what grew, what is floor, and what is owed

Status: investigation and scoping only. No production code was changed
by this item. Measured at `4bdec312b` against the campaign merge-base
`9195dedd1` (1,093 commits).

## Why

The maintainer asked whether the fork-related TypeScript has been
migrated to Rust and deleted. It has not, and the dedicated fork
TypeScript grew during a campaign whose contract says it shrinks. This
document says where it went, what each of the 38 files actually is, and
what reversing it would cost.

The Rust-First Kernel And Fork Contract names a short floor — worker
spawn, the `fork()` syscall and syscall-channel transport,
`resolve_externref` identity materialization, anyref-transit
`Table.grow` sizing, PIC placement globals, the resume
`WebAssembly.Table`, and the Node/browser platform bridges — and assigns
everything else to `crates/fork-module` and `crates/fork-codec`. What
exists in `host/src` is 26,113 lines across 38 dedicated files.
Classifying them against that floor is the point of this census, so the
question stops being answered by file names.

Two findings dominate, and neither was the expected one.

**First, about 3,400 lines have no production caller at all.** They are
not a migration backlog; they are a superseded engine still sitting in
the tree. `fork-reference-recipes.ts` is 1,316 lines of which two type
declarations are live. This is deletable before any Rust is written.

**Second, `crates/fork-codec` already implements most of the rest**, and
the Rust modules say so in their own doc comments, naming the TypeScript
function each was ported from. So the bulk of this subsystem is deletion
debt behind a cutover that was never performed, not unwritten work.

This is the scoping input for what the campaign status document already
calls "campaign two's charter" — the `~9,900`-line driver-glue audit,
explicitly deferred out of the current campaign.

## The premise, verified

Every number in the request was re-measured before the work proceeded.
One is slightly off, one is materially misleading, and neither changes
the conclusion.

| measurement | merge-base | now | change | verdict |
|---|---|---|---|---|
| lines in `host/src/fork-*` + `vfork-*` | 23,246 | 26,113 | **+2,867** | confirmed exactly |
| dedicated file count | 27 | 38 | +11 | stated as 28 → 38 |
| `worker-main.ts` total lines | 6,083 | 7,536 | **+1,453** | confirmed exactly |
| `worker-main.ts` fork-mentioning lines | — | 1,010 | — | confirmed exactly |
| `process-lifecycle.ts` fork-mentioning lines | — | 398 | — | confirmed, but see below |
| files referencing `fm_` | — | 10 | — | confirmed exactly |

**The file count is 27 at the merge-base under the `fork-*`/`vfork-*`
prefix, not 28.** The "28" is reachable with a `*fork*` glob, which also
catches `dylink-fork-archive.ts` (since deleted) and, at HEAD,
`browser-fork-module-artifact.ts` — giving 28 → 39. Either pair is
internally consistent; the prefix pair is used throughout.

**`process-lifecycle.ts` should be withdrawn from the indictment.** It
did not exist at the merge-base. It was created by de-duplicating the
two kernel-worker entries, which fell from 3,939 + 4,538 = 8,477 lines
to 1,401 + 1,805 = 3,206. Across all three files the campaign is
**−454**. Every one of its largest commits is a `Share …` consolidation.
Its 398 fork mentions are a consolidation win being counted as growth.

The growth in the dedicated files and in `worker-main.ts` is real, is
not an artifact of counting method, and is **partly** an artifact of
file splitting — quantified below rather than waved at.

## The reconciliation the growth needs

Within `host/src`, total TypeScript went **105,562 → 104,237 (−1,325)**
while the file count went 87 → 112. The fork subsystem is the part of
`host/src` that grew, against a non-fork remainder that fell by ~4,200:

| | merge-base | now | change |
|---|---|---|---|
| fork + vfork files | 23,246 | 26,113 | **+2,867** |
| everything else in `host/src` | 82,316 | 78,124 | **−4,192** |
| `host/src` total | 105,562 | 104,237 | −1,325 |

Both statements are true at once: the campaign deleted more TypeScript
than it added, and the fork subsystem is where the additions
concentrated.

## Where the growth went

Across the 85 commits touching these files: **+11,072 added, −8,205
removed, net +2,867.** The deletions were large and real — the JS fork
reference engine and the JS continuation twin both went — and the
additions outpaced them anyway.

| | files | lines |
|---|---|---|
| New files | 12 | **+5,868** |
| Deleted files | 1 | −2,079 |
| Grew in place | 8 | +965 |
| Shrank in place | 4 | −1,887 |
| | | **net +2,867** |

### The largest additions, by commit

| net | commit | subject |
|---|---|---|
| +1,025 | `0fa4de302` | capture-session floor extraction + fork-container severance |
| +791 | `283b06917` | un-gate externref/GC/static-root fork capture on Node+browser |
| +582 | `52ba17d1b` | WIP: P3b parent-replay re-source + V8 capture wiring |
| +558 | `eae52dedb` | dlopen multi-activation frames through the module (D7a.1a) |
| +554 | `d18bcdf69` | drive qualifying forks through the co-resident module (D5) |
| +405 | `4b2385146` | migrate peer-table replication off the JS reference engine |
| +384 | `778a92a31` | sever child-reconstruction ForkReferenceTransaction |
| +221 | `8b9a1e0bd` | ship + instantiate fork-module in the worker behind the flag |
| +219 | `b71a80fa0` | reserve a bounded in-guest fork-frame arena (Fix X) |
| +193 | `0d5dd2880` | externref reconstruction driven through the module (D6.2) |

and the largest removals:

| net | commit | subject |
|---|---|---|
| −2,541 | `ace9756b1` | physically delete the dead JS fork reference engine |
| −1,326 | `eeea97c94` | delete the JS continuation twin |
| −453 | `d8ad27833` | delete now-uncalled capture-side reference encoders |
| −294 | `608194508` | make dynamic mmap frame allocation the only capture path |
| −269 | `5f5fb0ec2` | remove host bindings for deleted DRIVE exports |

**What each large addition was for.** Most of the largest are the
TypeScript side of driving the Rust fork-module: `d18bcdf69`,
`eae52dedb`, `0d5dd2880`, `8b9a1e0bd` and ten smaller "Route X through
the coarse `fm_*` entry" commits each added host-side wrapper, staging
and post-condition code alongside a Rust capability. That work was
genuinely required — the `fm_*` contract must be spoken from somewhere —
but it was written as a *driver* rather than a thin call.

Two of the largest are **not** driver glue and read differently.
`0fa4de302` (+1,025) created `fork-capture-session.ts`, described in its
subject as a floor extraction; this census classifies the result as
ORCHESTRATION, so the extraction moved capture policy sideways rather
than to Rust. `283b06917` (+791) un-gated capture paths — feature work
that happened to land in TypeScript.

### How much of the growth is file splitting

Some, and it is measurable with rename detection:

- `3c141d5d7` created `fork-reference-wire.ts` (+1,123) by moving −1,033
  lines out of `fork-reference-segments.ts`. Net **+88**; git scores it
  a rename.
- `14ce74fd6` created `fork-reference-scratch.ts` (+263) by moving −138
  out of `fork-reference-transaction.ts`. Net **+125**.

So roughly 1,170 of the 5,868 "new file" lines are re-homed rather than
newly written. The remaining ~4,700 are new, and the `fork-module-*`
driver family is 2,921 of them.

### `worker-main.ts`: +1,453 with no large commit

55 commits touched it, `+2,370 / −917`. The largest single net change is
**+146**. By area prefix the split is `Fork:` **+1,405**, `Dylink:`
+102, `WASI:` +17, `WIP:` +17, `Host:` −89 — essentially all of it is
the fork-module cutover.

| net | commit | subject |
|---|---|---|
| +146 | `45d873bcf` | fork-from-thread through the co-resident module (D7b) |
| +102 | `d18bcdf69` | drive qualifying forks through the co-resident module (D5) |
| +100 | `29cf0de87` | drive the typed-GC fork reconstruction through the module |
| +89 | `ca287f31b` | drive static-root WasmGC references through the module |
| +89 | `eae52dedb` | dlopen multi-activation frames through the module (D7a.1a) |

**The pattern behind the growth, stated precisely.** Each cutover step
moved an *algorithm* into Rust and left behind a host-side **seeding and
base-arithmetic loop** to feed the module facts the module then
re-derives. Funcref catalog bases, static-root bases and widths, and
drive-table slot numbers are all computed in TypeScript *and* encoded in
`fork_codec::drive_plan`. Two commits show it sharply:

- `ca287f31b` and `29cf0de87` compute bases on both sides.
- `4f0d67972` added a host pre-walk for exnref tag validity (+48);
  `d9191ef98` then "moved the gate into `fm_attach_child`" — and was
  `+73 / −69` in `worker-main.ts`, a **net +4**. Migrating that check to
  Rust replaced a host walk with a host *seeding loop* and shrank
  nothing.

So the direction of travel has been honored for algorithms and violated
for plumbing, and the plumbing is now the majority of the file's fork
surface. `worker-main.ts` imports 23 of the 38 dedicated fork modules;
no single decision grew it and no single revert shrinks it.

## The census

38 dedicated files, 26,113 lines, read rather than sampled. FLOOR (named
in the contract, or irreducible for a stated reason), TRANSPORT
(marshalling across `fm_*`), ORCHESTRATION (sequencing, capture, replay
or policy the contract assigns to Rust), DEAD (no production caller).

Every file has at least one production importer, so DEAD below is
reported at export and path granularity — except
`fork-reference-recipes.ts`, where only two type declarations are live
and the verdict is effectively file-level.

### Module driver and capture

| file | lines | class | note |
|---|---|---|---|
| `fork-module-instance.ts` | 639 | **FLOOR** | PIC placement globals, resume table; the 133 `fm_` hits are a required-exports manifest, not logic |
| `fork-module-trampoline.ts` | 286 | **FLOOR** | only the host can mint a per-activation `WebAssembly.Module`; cleanest floor in the set |
| `fork-module-reconstruction.ts` | 343 | **FLOOR** | anyref-transit `Table.grow` sizing from `fm_decoded_node_count` |
| `fork-reference-scratch.ts` | 263 | **FLOOR** | LIFO bump allocator over guest memory; header comment cites a deleted file |
| `fork-module-host-capabilities.ts` | 73 | **FLOOR** | literally `resolve_externref` identity materialization |
| `fork-module-backend.ts` | 1,347 | **TRANSPORT** | + 3 residual decisions: typed-error routing, wasm64 lo/hi splitting, duplicated `DRIVE_SLOT_*` |
| `fork-reference-capture-module.ts` | 233 | **TRANSPORT** | unusually clean; hardcoded record offsets are the one risk |
| `fork-capture-session.ts` | 997 | **ORCHESTRATION** | capture strategy selection, a 7-call exception sequence, host-assigned cache indices |
| `fork-table-snapshot.ts` | 380 | **ORCHESTRATION** | restore-composition ordering; genuine floor core in its decode surface |

### Codec and module state

| file | lines | class | note |
|---|---|---|---|
| `fork-module-state.ts` | 3,860 | **ORCHESTRATION** | ~929 orchestration / ~2,901 transport / ~15 floor; the 709-line arena engine is the spine |
| `fork-reference-wire.ts` | 1,131 | **TRANSPORT** | all 1,131 lines have a Rust twin; no floor item appears in it |
| `fork-gc-codec.ts` | 905 | **split** | ~82 floor, ~579 transport, 244 orchestration (the provenance registry) |
| `fork-replay-events.ts` | 738 | **split** | ~18 floor (the resume `Table`), ~427 transport, ~293 orchestration — already ported |

### Reference machinery

This group is where the dead code is. Of 5,245 lines, roughly **2,900
have no production caller**, ~600 are live orchestration already
duplicated in Rust, and only about **475 are on the far side of the
engine floor**.

| file | lines | class | note |
|---|---|---|---|
| `fork-reference-recipes.ts` | 1,316 | **DEAD** | a complete second wire format ("KFRR v1") plus a transactional replay coordinator; only 2 type declarations are live |
| `fork-reference-segments.ts` | 1,098 | **split** | ~555-line encoder is DEAD (capture writes KFRV from Rust); the ~190-line decoder is live TRANSPORT |
| `fork-early-reference-provider.ts` | 1,619 | **ORCHESTRATION** | ~60 floor; ~270 dead data-feed; ~450 drive-order already in Rust |
| `fork-reference-broker.ts` | 680 | **FLOOR** by role | but only ~97 lines are the named floor; ~455 are a lifetime ledger and ~40 are dead |
| `fork-static-root-catalog.ts` | 236 | **FLOOR**, narrowly | ~45 floor (harvest + `WeakRef`); ~89 migratable |
| `fork-reference-contracts.ts` | 134 | **FLOOR** | interfaces only; nothing to execute, nothing to migrate |
| `fork-function-catalog.ts` | 120 | **FLOOR** | `encode` is irreducible (see below); `decode` is not |
| `fork-externref-provenance.ts` | 42 | **FLOOR** | records at the production site; the one file here not to touch |

**The `fm_ref_*` flip makes the data-feed unreachable.**
`worker-main.ts:3873-3880` replaces seven `__wpk_fork_ref_*` imports
with the module's `fm_ref_*` exports, and `:4759-4763` flips the funcref
and externref decoders too — all placed after the JS import builders, so
they win. The gate `moduleReferenceKindsSupported` is unconditionally
true: `useForkModule` is set `true` with no remaining fallback, and
`decodedChildReferences` is assigned for every child. The JS bodies
survive only as the shape of a fallback Phase 4 deleted.

### Activation and continuation

| file | lines | class | note |
|---|---|---|---|
| `fork-activation-registry.ts` | 2,098 | **ORCHESTRATION** | ~1,430 orchestration / ~285 transport / ~170 floor; its own header calls it "this deletable engine file" |
| `fork-process-continuation.ts` | 1,471 | **ORCHESTRATION** | ~1,180 sequencing; ~40 lines of genuine floor (`continuationImports`); ~190 lines are a duplicated borrowed-child path |
| `vfork-lifetime.ts` | 346 | **FLOOR** | worker spawn + platform bridges; not a second copy of fork sequencing |
| `fork-replay-gate.ts` | 229 | **FLOOR** | `Atomics.wait` is the only primitive available inside a sync Wasm import |
| `fork-continuation.ts` | 190 | **FLOOR** | what survived the 1,040 → 190 shrink is leaf primitives; 3 dead exports |
| `vfork-workspace.ts` | 175 | **ORCHESTRATION** | placement policy the module already performs for the COW path |
| `fork-anyref-transit.ts` | 148 | **FLOOR** | genuinely just `Table.grow` sizing; one 2-line policy leak |
| `fork-resume-catalog.ts` | 134 | **split** | ~30 floor (`table.get`), ~100 duplicated decode |
| `fork-unwind-transport.ts` | 47 | **FLOOR** | `WebAssembly.Tag` is a host object with no Rust equivalent |
| `fork-mechanism-trace.ts` | 10 | live diagnostic | not fork control flow at all; folds into `process-lifecycle.ts` |

### Host imports, externref ownership and exceptions

| file | lines | class | note |
|---|---|---|---|
| `fork-externref-import-mailbox.ts` | 1,314 | **TRANSPORT** | ~450 floor-adjacent SAB rendezvous / ~850 TS-authored codec and registry |
| `fork-imported-globals.ts` | 1,229 | **ORCHESTRATION** | **not** the PIC-placement floor item; those live in `pic-side-module.ts` and `fork-module-instance.ts` |
| `fork-worker-import-exceptions.ts` | 912 | **ORCHESTRATION** | a serialization codec written in TS; ~60-line fatal-trap floor sliver |
| `fork-exception-provider.ts` | 507 | **ORCHESTRATION** | decode already ported to Rust; the broker probe loop is policy |
| `fork-host-import-runtime.ts` | 497 | **TRANSPORT** | ~40 lines are the strongest floor claim in the group; ~170 lines production-dead |
| `fork-externref-process-owner.ts` | 232 | **FLOOR** | the identity table is the named floor; the fork scan (72-139) is not |
| `fork-worker-exception-capability.ts` | 134 | **FLOOR** | size proportional to job; no sequencing, no wire format |

**The whole group serves four descriptors in production.**
`ForkHostImportOwnerRuntime.register()` has zero production callers, so
the catalog contains exactly the four installed from the constructor —
BEGIN, CHUNK, COMMIT, ABORT. Only COMMIT returns an externref; nothing
in production ever passes an externref *parameter*. This ~4,825-line
subsystem exists in production to shred a thrown JS value into UTF-16
chunks, ship it over a SAB mailbox, and rebuild it as a durable
capability.

### The two shared files

`worker-main.ts` — ~3,832 fork-bearing lines by whole-region measure
(1,010 by the narrower grep-mention measure; the ratios agree):

| category | lines | share |
|---|---|---|
| FLOOR | 777 | 20% |
| TRANSPORT | 498 | 13% |
| **ORCHESTRATION** | **2,543** | **66%** |
| DEAD | 14 | — |

The largest single orchestration block is lines 4896-5270 (375 lines):
the merged funcref-catalog mirror, per-activation base arithmetic,
drive-table binding, GC-codec and exception-tag seeding, and static-root
base/width computation. Roughly **420 further lines** are near-verbatim
duplication between the process path and the thread path — any Rust
migration that lands once must currently be written twice.

`process-lifecycle.ts` — ~1,352 fork-bearing lines:

| category | lines | share |
|---|---|---|
| FLOOR | 605 | 45% |
| TRANSPORT | 449 | 33% |
| ORCHESTRATION | 298 | 22% |
| DEAD | 0 | — |

This file is overwhelmingly floor and transport, which matches the
contract — it is worker spawn and the worker-message boundary. Its only
real orchestration is ~230 lines of vfork lifetime policy, which is
process state and so belongs in `crates/kernel` rather than the
fork-module.

## Two corrections to the floor itself

**The contract's floor list is missing an item.**
`fork-function-catalog.ts:84-94` maps a live function object to its
catalog ordinal through a `WeakMap`, and it is as irreducible as
`resolve_externref` for a different engine reason: **WebAssembly has no
funcref equality instruction** — `ref.eq` is defined over `eqref`, not
`funcref`. A module cannot answer "which ordinal is this function?" at
all, and `fork-capture-session.ts:284` asks on every capture. An agent
classifying against the current list would have to re-derive this or
wrongly mark it migratable. Recommend adding "funcref identity → catalog
ordinal" to the contract text.

**`resolve_externref` adjacency is much narrower than the filenames
suggest.** Across 5,245 lines of files whose names all say "reference",
exactly ~97 lines (`fork-reference-broker.ts:583-680`) implement the
named floor item and exactly one line
(`fork-early-reference-provider.ts:1240`) calls it. Everything else
about recipes, segments, catalogs, provenance ordering, brokering and
leases is on the near side. Name-adjacency to a floor item is not
evidence of floor status, and this census found it misleading in both
directions.

## Duplicated authority, and one hazard worth naming alone

`crates/fork-codec` carries Rust ports whose doc comments name their
TypeScript origin by file and function: `gc_codec.rs`,
`replay_events.rs`, `replay_journal.rs`, `reference_segments.rs`,
`reference_segments_writer.rs`, `reference_transaction.rs`,
`reference_recipes.rs`, `reference_replay.rs`, `reference_feed.rs`,
`drive_plan.rs`, `drive_plan_hints.rs`, `module_state.rs`,
`module_state_records.rs`, `imported_globals.rs`, `imported_tables.rs`,
`exception_codec.rs`, `catalogs.rs`. Parity was spot-checked rather than
assumed: the `vector_intern_key` constants in
`reference_transaction.rs:92-99` match `fork-reference-wire.ts:865-879`
exactly.

**One inherited claim was disproved here and should not propagate.**
`crates/fork-codec/src/replay_journal.rs:15` says the slice is "PURELY
ADDITIVE and validated-but-unused. TypeScript still drives every fork at
runtime." That doc comment is stale: `crates/fork-module/src/lib.rs`
imports and uses both `ReplayEventJournal` and `ResumeSlotTable`, while
the JS `ForkResumeTable` is simultaneously live at
`fork-process-continuation.ts:127`.

The real state is worse than "unused", and it is the strongest single
argument in this document for finishing the cutover:

> the module's `ResumeSlotTable` numbering MUST match the JS one exactly
> or `call_indirect` targets the wrong thunk (silent corruption).
> — `crates/fork-module/src/lib.rs:227`

Two implementations of resume-slot numbering run concurrently, kept in
agreement by the host seeding the same catalog into both via
`fm_set_resume_catalog`. The failure mode of divergence is silent memory
corruption, not a loud error.

### A second host already pays this cost, measurably

The campaign status document argues the glue audit "wants evidence that
does not exist yet — a second real host built against a stable
baseline". The second host exists: `crates/host-native` is the Wasmtime
conformance host, loads the same real `kernel.wasm`, and its `guest.rs`
is 13,577 lines with 1,113 fork mentions and a
`drive_fork_capture_seal_and_launch_child` driver. **It calls 55
distinct `fm_*` entries** against TypeScript's ~85.

That does not refute the argument — the baseline is not frozen, which
was the point — but the duplication is measurable today rather than
hypothetical. A second host has already reimplemented roughly two thirds
of the `fm_*` driver surface. That is the V4 cost the contract exists to
prevent, observed rather than predicted.

## Dead production code

Every item was checked transitively, and the largest were independently
re-verified repo-wide before being listed.

| item | only reached from | lines |
|---|---|---|
| `fork-reference-recipes.ts:142-1316` — KFRR codec, type catalog, replay coordinator | tests + one fixture generator | ~1,244 |
| `fork-reference-segments.ts` encoder (7 ranges) | tests + one fixture generator | ~555 |
| `fork-early-reference-provider.ts:620-909` data feed | tests — `fm_ref_*` wins the import binding on every path | ~270 |
| `fork-host-import-runtime.ts` `register()` + owner-route branches + 4 signature helpers | tests only | ~170 |
| mailbox externref-*parameter* path (1197-1227) | unreachable — no production descriptor declares one | ~30 |
| `fork-reference-broker.ts` `acquire`/`release`/`holderCount`/`resolve` | tests only | ~40 |
| `journalImageForChild` (`fork-module-state.ts:2005`) | nothing — yet its producer `appendJournalImage` is live | 30 |
| `ForkModuleContinuationBackend.driveTypedGraph`, `.beginReferenceReplay`, `.addActivationChildReplay`, `.addActivationBorrowedChildReplay` | nothing (comments only) | ~130 |
| `forkSaveBufferOverrun` (`worker-main.ts:2944`) | tests only — **and already callerless at the merge-base** | 14 |
| `tombstoneForWire` (`fork-externref-process-owner.ts:188`) | **nothing, repo-wide** | 10 |
| `invokeForkContinuationBegin`, `LINKED_FRAME_FORMAT_*` aliases, `interface AbortFailure` | tests / nothing | ~25 |
| `encodeForkModuleStateDescriptor`, `activeSessionCount`, `generationId`, `forkExternrefImportMailboxBytes`, `FORK_STATIC_ROOT_CATALOG_SECTION` | tests only | ~50 |
| `InstantiateForkModuleOptions.transitTable` | a test asserting the no-op | ~10 |
| `apps/browser-demos/test/fixtures/borrowed-process-runtime.ts` + `borrowed-active-side-replay-browser-worker.ts` | each other, plus 2 string keys in `kernel-scratch-contract.test.ts` | 2 files |

The last row is the same class of artifact as the one deleted in
`9638a2023` — they import the deleted `LinkedForkContinuation` and
cannot compile, so this residue is known and recurring.

`journalImageForChild` deserves its own look: the arena *writes* a
`JournalImage` record on a live path that nothing in the tree ever reads
back. That is a write-only record, not merely a dead reader.

Also stale but not dead: ~14 doc citations in
`crates/fork-codec/src/{linked_frames_writer,rewind_driver}.rs` and
`crates/host-native/src/guest.rs` point at `fork-continuation.ts` and
`fork-process-continuation.ts` line numbers that no longer exist, and
the header comments of `fork-reference-contracts.ts`,
`fork-early-reference-provider.ts` and `fork-reference-scratch.ts`
describe the deleted `fork-reference-transaction.ts` as extant.

## Sizing

Derived from per-file section splits rather than whole-file verdicts.
Treat the totals as ±15%.

| category | lines | share |
|---|---|---|
| FLOOR | ~3,700 | 14% |
| TRANSPORT | ~7,000 | 27% |
| **ORCHESTRATION** | **~12,000** | **46%** |
| **DEAD** | **~3,400** | **13%** |

Adding `worker-main.ts`'s fork-bearing regions brings orchestration to
roughly **14,500 lines** across the dedicated files and the hub.

Of the ~12,000 orchestration lines in dedicated files:

- **~7,000 are cutover** — Rust exists, byte-compatible,
  fixture-guarded. The work is wiring and deletion, not porting.
- **~3,400 need the five named Rust gaps** below.
- **~1,600 delete rather than migrate**, because module-mode capture
  removes their reason to exist. The GC provenance registry is the
  clearest case: it bridges live JS object identity to a recipe id, and
  in module mode there are no live values, only resolved coordinates.

## What blocks each, concretely

**The `fm_*` contract is already broad, not thin.** `crates/fork-module`
exports 75 `pub extern "C"` functions; the TypeScript names ~85 `fm_*`
symbols. Adding an entry is cheap and routine.

**Adding to the fork-module costs nothing on the kernel host surface.**
The fork-module's own import object is **9 entries, of which exactly one
is a function**: `env.memory`, four tables, three placement globals, and
`resolve_externref`. Moving orchestration into the fork-module does not
touch the kernel's host-import floor at all.

**That kernel floor is 72 host functions plus `env.memory`** — a raw
import-*entry* count reads 73. The pin is
`crates/host-native/src/lib.rs:214`, whose comment records the
measurement method. This worktree has no built `kernel.wasm`, so this
figure is **reported from the pin, not measured from the artifact**; the
campaign's standing rule is to measure the artifact, and that was not
done here.

Costs therefore rank:

1. **Free — deletion.** ~3,400 lines. No Rust, no `fm_*` change.
2. **Cheapest with work — a new `fm_*` export whose Rust logic already
   exists.** Most of the remainder.
3. **Cheap — a new `fm_*` export needing new Rust.** Five named gaps.
4. **Not required anywhere in this census — a new host import.** Nothing
   found needs the 72-function surface to grow. This is the most useful
   single result for sequencing: **the work is host-import-neutral.**

### The five gaps that need new Rust

1. **A KFMS writer.** The largest gap. `crates/fork-codec` has
   `linked_frames_writer.rs` and `reference_segments_writer.rs` but **no
   `module_state_writer.rs`**; the reserve/commit/seal arena allocator
   exists only in TypeScript. The `ContinuationAllocate` /
   `ContinuationDeallocate` callbacks are already injected, so the seam
   is clean. Needs `fm_arena_begin/reserve_record/commit/seal/release`.
2. **Record kinds 9, 10 and 11** — imported-global bindings, activation
   continuations, imported-table bindings. `module_state_records.rs`
   explicitly defers them. ~620 lines with no live-object dependency.
3. **`validateRecordOwnership`** (275 lines), including its D7a.1a mode
   branch, which should become a typed mode parameter rather than a `??`
   fallback. `module_state.rs` names this a deferred follow-on.
4. **An externref-handle scan entry.** `6da756719` deleted the unused
   `fm_scan_externref_handles` rather than wiring it, and
   `docs/future-improvements.md:824-838` already records that
   `fork-codec` should own the scan.
5. **A borrowed-workspace placement op** — the borrowed twin of the
   dynamic mmap placement the module already performs — which retires
   `vfork-workspace.ts`.

## Proposed ordering

The internal import graph layers cleanly: `fork-module-state.ts` is the
hub most files depend on; `fork-activation-registry.ts`,
`fork-table-snapshot.ts` and `fork-process-continuation.ts` are the
top-level consumers; `worker-main.ts` imports 23 of 38. Nothing below
requires a new host import or a kernel ABI epoch, and each step is
independently shippable.

**F0 — free deletions.** Everything in the dead table except the
maintainer-decision row, plus the two orphaned fixtures and the stale
doc citations. ~3,400 lines and 3 files, zero risk, no `fm_*` change. Do
it first: it removes 13% of the subsystem and shrinks what every later
step must read. The three largest pieces — `fork-reference-recipes.ts`,
the `fork-reference-segments.ts` encoder, and the
`fork-early-reference-provider.ts` data feed — are ~2,070 lines on their
own. Two fixture generators must be repointed at the Rust encoders
first, following the precedent `catalogs.rs:5-11` already sets.

**F1 — retire decoders already ported to Rust.**
`fork-resume-catalog.ts`'s decode, `fork-exception-provider.ts`'s
descriptor decode, and `fork-reference-wire.ts` in full. Each has a
byte-compatible Rust twin with committed cross-language fixtures. One
small accessor per format. Depends on F0.

**F2 — the externref scan.** Restore an `fm_*` scan entry and retire
`forkGenerationFromContinuation`'s TS re-decode. Small, written up twice
in-tree, and it clears `fork-reference-wire.ts`'s last consumer. Depends
on F1.

**F3 — the resume-slot cutover.** Delete the JS `ForkResumeTable`
allocator and let the module own the numbering. The one step that buys
correctness as well as lines: it closes the silent-corruption parity
hazard. `replay_journal.rs` already has the implementation. Depends on
F1.

**F4 — the KFMS writer.** The largest new-Rust gap and the gate for
everything in `fork-module-state.ts`. Independent of F1-F3 and can run
in parallel, but F5 and F6 wait on it.

**F5 — record kinds 9/10/11 and `validateRecordOwnership`.** Mechanical
once F4 lands; retires ~900 lines of `fork-module-state.ts`. Depends on
F4.

**F6 — `fork-imported-globals.ts`.** The planner moves behind one
"ordered instantiation plan" export; the host keeps a dumb plan
executor. Depends on F5 for the binding records.

**F7 — the capture engine.** `fork-capture-session.ts`'s strategy
selection and 7-call exception sequence, and
`fork-activation-registry.ts`'s GC/externref/provenance block. Highest
orchestration density, and most `fm_*` mirrors already exist. Depends on
F4; benefits from F3.

**F8 — the sequencers.** `fork-process-continuation.ts`'s drive-bind
loops and duplicated borrowed-child path, plus `vfork-workspace.ts`.
Largely mechanical once F7 removes the policy they sequence around.
Depends on F7.

**F9 — `worker-main.ts`.** The base-arithmetic and seeding loops,
chiefly lines 4896-5270. Only after F1-F8, because most of its +1,453
lines are wiring for the things above; attempting it first is what
produced the growth. Fold the ~420 duplicated thread-path lines into the
process path in the same pass, so the next migration lands once rather
than twice.

Two items are **maintainer decisions, not agent calls**, and are
deliberately not scheduled:

1. **The generic owner-import registration path** (~170 lines in
   `fork-host-import-runtime.ts`, plus the mailbox typed-signature layer
   it alone serves, ~850 more). Deleting it is right if no externref
   host imports are intended and wrong if that surface is planned work.
   It has never had a production caller.
2. **The "engine-floor half" wording** in
   `crates/fork-codec/src/exception_codec.rs:37` and
   `imported_globals.rs:39`. Both label work as engine-floor and, in the
   same sentence, as deferred to the co-resident module. Those are
   contradictory, and the phrase is the most likely single reason a
   1,200-line planner reads as floor. Worth settling once, in writing.

A third, smaller item is also the maintainer's: whether to add "funcref
identity → catalog ordinal" to the contract's floor list, per the
correction above.

## What was examined, and what was not

**Examined:** all 38 dedicated files, read rather than sampled, across
six parallel censuses; the fork-bearing regions of `worker-main.ts` and
`process-lifecycle.ts`; `crates/fork-codec/src` (25 files, 19,911
lines); `crates/fork-module/src/lib.rs` (5,366 lines); the 13 fixture
generators under `crates/fork-codec/testdata`; `crates/host-native` for
the second-host comparison; and the git history of every file across the
1,093 commits since the merge-base.

**Verified independently** rather than taken from a subagent: every
premise number in the request; the per-file and per-commit deltas; the
`fm_*` export counts on both sides; the fork-module import object; the
host-import pin; the `process-lifecycle.ts` non-existence at the
merge-base and the −454 three-file total; and eleven dead-code claims,
each re-grepped repo-wide.

**Not done:** no test suite was run, and none was needed for a census.
The 72-function host floor is reported from the source pin, **not
measured from a built `kernel.wasm`**, because this worktree has none.
Line-count splits inside large files are section estimates, not
token-accurate measurements, and are marked ±15%. The classification of
`fork-reference-broker.ts`'s ledger assumes its home would be
`crates/kernel` rather than the fork-module, since it runs in the kernel
worker — that is a design question, flagged rather than settled. No
judgement is offered on whether campaign two should begin before PR
#1350 ships; the status document already records that as the
maintainer's call.
