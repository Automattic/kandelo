# Fork-module storage: dynamic allocation with lifetime-correct release

Date: 2026-09-18
Lane: F (fork inversion)
Status: approved in shape; four scope decisions recorded below

## Maintainer decisions

Recorded 2026-09-18, in answer to a question batch.

1. **`ResumeSlotIndex` is IN, decided after the experiment.** The maintainer
   first ruled that the deadlock experiment should run and that THEY would
   decide on its result. It ran (see Experiment results below): it disproved
   the proposed explanation -- that a forked child makes the mapping syscall
   before the kernel can answer it -- without finding the real cause.

   The maintainer then ruled the conversion in, on the grounds that the new
   design differs from the broken one in the way that matters. The reverted
   version tracked its chunks in a list living in the bump heap, which
   `ALLOC.reset()` wipes on every fork while the chunks it points to stay
   mapped. The shared arena keeps that list INSIDE the chunks, which is what
   the identity registry already does and what `lib.rs:986` says to do.
2. **Chunk testing: the full suite runs in BOTH builds** -- the default one and
   one with every arena's first chunk forced small enough to chain.
3. **`build-programs.sh`: use the SDK and delete the duplicate.** Test programs
   route through the worktree-local SDK as `CLAUDE.md` requires; the
   hand-maintained `LINK_POST_LIBS` array goes away entirely, so the two copies
   of the link contract cannot drift again. If the SDK turns out to be
   unavailable at that point in the build, that obstacle is reported rather
   than routed around with a second copy.
4. **Missing `__heap_base`: fail loud, AFTER the build is fixed.** The guard
   and the build fix land together, guard sequenced second, so the suite is
   never red on a defect the same change is removing.
5. **A test that requires the module to be BIG is fixed first, on its own.**
   `host/test/fork-module-instance.test.ts` asserts the module's reserved
   region exceeds 4 MiB, so it fails when the module gets SMALLER -- which is
   the point of this work. The experiment tripped it:
   `expected 3735552 to be greater than 4194304`.

   It is fixed in its own commit before any conversion lands, asserting what
   it actually cares about (the region holds the module's declared
   `memorySize` plus its shadow stack) rather than a constant. The same commit
   checks whether other tests hard-code sizes or layout constants the same
   way; this one was invisible until something shrank.
6. **All NINE hand-maintained copies of the link contract converge onto the
   SDK.** Not just `build-programs.sh`. The full list is
   `scripts/build-programs.sh`, `scripts/run-browser-posix-tests.sh`,
   `scripts/run-browser-sortix-tests.sh`,
   `crates/host-native/fixtures/build-fixtures.sh`,
   `examples/dlopen/build.sh`, and three fork side-module fixtures under
   `host/test/`, against the authority in `sdk/src/lib/flags.ts`.
7. **The build work is a SEPARATE change, landed BEFORE the storage work**, so
   arena sizing decisions are made against the final memory layout rather than
   one about to change.
8. **P-11 becomes two fixtures, and the SDK learns to honour a smaller
   stack.** The tight fixture keeps the error paths reachable; the adaptive
   one proves the same behaviour at production layout.

   `mainThreadStackSize` (`sdk/src/lib/flags.ts:218-231`) currently returns
   `max(8 MiB, requested)`, so an explicit smaller request is silently
   discarded -- the SDK builds something other than what was asked for and
   does not say so. That changes: an explicit request below the floor is
   HONOURED with a loud warning naming the risk, while ABSENCE of a request
   still gets 8 MiB silently. Those are different situations -- a deliberate
   choice versus flags lost to drift -- and the current code conflates them.

   The warning is informational, not the safety mechanism. A build-log
   warning is a weak guard, as this lane's own missing `__heap_base` shows.
   The default remains the protection.
9. **The 4,096-deep recursion's stack headroom is investigated and fixed as
    part of the plan**, not deferred.
10. **The rule is "nothing reserved at process START", not "no statics".** A
    statically sized list is acceptable when it corresponds to a known fixed
    quantity. What is not acceptable is paying for it before it is needed: the
    module's `dylink.0` `memorySize` is reserved out of the guest's mmap window
    at instantiation, so every fixed array is billed to every fork-capable
    process whether it ever forks. Allocation happens at first use during a
    fork, and only forking processes pay.
11. **A per-chain ROOT POINTER is allowed** -- one 8-byte `AtomicU64` naming
    the first chunk, zero when nothing is mapped. It is a root, not a
    reservation: it cannot overflow and its size does not vary with workload.
    `IDENTITY_HEAD` is the existing precedent.
12. **The module imports the host's resume table and places the thunks
    itself**, and this lands BEFORE the storage conversion as its own change.

    The module already owns the POLICY -- `fork-resume-table.ts:88` says "each
    thunk goes where `fm_resume_slots` says, and the module made that
    decision". The host owns only the MECHANISM, because `Table.set` acts on a
    JS object the module has no handle to. Importing that table alongside the
    guest's catalog table lets the module do the placement with
    `table.get`/`table.set`.

    Ordering matters and is not arbitrary. Today the host asks
    `fm_resume_slots` op 0 once per thunk, and `resume_slot_of` answers by
    LINEAR SCAN: for php that is 19,025 lookups over up to 28,568 entries,
    about 10^8 comparisons per process start, on a fixed array, today. When
    the module places thunks itself it walks one activation's assignment
    sequentially instead. `fm_resume_slots` op 0 and the random
    `(activation, ordinal)` lookup both disappear, which turns
    `RESUME_SLOT_INDEX` from a random-access store into a WALK-ONLY one --
    the hardest conversion in the storage change, made easy. Converting
    storage first would mean designing around a lookup pattern about to be
    deleted.

    This is an ABI change: a new table import, and `required_imports` is in
    `abi/snapshot.json`. ABI 44 is not released and this project defines its
    contents, so the snapshot is regenerated in the same change.

No static allocation exemptions are requested. `VECTOR_IN_FLIGHT` was
withdrawn as a candidate: it is a matched push/pop stack whose lifetime fits
the bump heap, and its depth-8 limit is a correctness assertion, not storage.
As a bump-heap `Vec` with an explicit depth check the refusal becomes
intentional rather than a side effect of array capacity.

## Why

The co-resident fork module reserves 2.26 MiB of static memory out of the
guest's own mmap window, whether a program forks or not. Twenty fixed-size
arrays account for 99.0% of it (measured against the built module's `dylink.0`
`memorySize` of 2,395,460 bytes).

None of those bounds exist on `main`. `crates/fork-module` and
`crates/fork-codec` are not on `main` at all; the same data lives in growable
JavaScript collections -- a plain array in `fork-resume-catalog.ts`, `Map`s in
`fork-activation-registry.ts` and `fork-gc-codec.ts` -- with no floor, no cap
and no pre-sizing. A `no_std` PIC wasm module cannot reach a JS heap, so the
port replaced growable collections with fixed statics, and each static then
needed a number nobody had.

Every fixed bound here was introduced by the migration. The identity table was
the first instance the maintainer caught ("We keep trying to pre-reserve
address space"); the rest are the same defect wearing different constants.

**But this is intentional architecture, not only the repair of a regression.**
`main` never designed these lifetimes -- it inherited them from a garbage
collector. Its catalog storage is unbounded by ACCIDENT: a JS `Map` grows
because the heap grows, and entries disappear when they become unreachable.
`fork-activation-registry.ts` does delete per activation explicitly
(`:751`, `:755`, `:757`), but `fork-gc-codec.ts` and `fork-resume-catalog.ts`
free nothing at all; their storage simply stops being referenced.

A `no_std` PIC wasm module has no collector, so every lifetime has to be
STATED. That is more work than `main` ever did, and it is also a stronger
guarantee: a stated lifetime can be audited, perturbed and tested, where
reachability can only be reasoned about. Restoring `main`'s behaviour would
mean growing without bound and freeing by luck. The target is better than
that -- grow on demand, and release at a named, testable point.

The principle is the reason, not the byte count: a foundation that still fits
when the scenario changes. Two of these arenas are sized against workloads that
do not exist yet, and sizing them by today's measurements would bake in an
assumption about tomorrow.

## What already exists

Two working precedents, so none of this is invented:

* `main`'s `ForkModuleStateArena` (`host/src/fork-module-state.ts:2812`,
  `:3142-3148`): root chunk of one wasm page; on overflow allocate ONE new
  chunk of `alignUp(max(PAGE, header + totalSize), PAGE)`; chain it through a
  pointer in the chunk header; write into the tail chunk regardless of which
  activation a record belongs to. Nothing copied, nothing doubled, nothing
  pre-reserved.
* This module's identity registry (`crates/fork-module/src/lib.rs:1003-1153`):
  64 KiB chunks via `channel_mmap`, chained, and `channel_munmap` for chunks
  that empty. It is the only store here that already frees.

The release trigger also already exists. `fm_resume_slots` op 1
(`lib.rs:10944`) IS the dlclose entry point into the module, reached through
`__wasm_dlclose` -> `lk.dlclose` -> `unregisterActivation` ->
`prepared.unregister()` -> `resumeTable.unregisterActivation` ->
`releaseResumeSlots`, carrying the `activation_id`. It already calls
`resume_unregister_impl` and `release_identity_activation`.

**No new `fm_*` entries are required.** Every setter either declares its size
(`fm_set_activation_gc_codec`, `_exception_codec`, `_resume_catalog`,
`_imports` all take a byte length or count) or appends one fixed-size entry
(`_template_id`, `_catalog_base`, `_static_root_base`, `_table_state_owner`,
`fm_set_import_provenance`). ABI stays 44.

## Design

### One mechanism, two instances

A single chunk-and-chain allocator, instantiated twice with different lifetime
policies:

* **`RegistryArena`** -- durable. Survives `ALLOC.reset()`. Records are tagged
  with their owning `activation_id` and released on dlclose. Chunks that empty
  are `channel_munmap`ed, exactly as the identity registry does.
* **the bump heap** -- per fork. `Bump::reset()` stores `offset = 0` and
  `region = 0`, so the next allocations REUSE those addresses.

They must not share a chain. That is a correctness constraint, not a
preference: a post-fork reset would hand out addresses sitting on live registry
records. The codebase already learned this -- `lib.rs:986` reads "THE REGISTRY
LIVES IN THE CHUNKS, not in a `Vec`. `ALLOC.reset()` runs...".

### Finding a record, and releasing one

Both follow the identity registry (`lib.rs:995-1159`) rather than inventing
anything.

CHUNK LAYOUT: `+0 next: u64` (0 ends the list), `+8 used: u32` (live entries,
always a dense prefix), `+12 pad`, `+16` entries. The `next` pointer lives
INSIDE the chunk it describes, deliberately: a bump-heap list of chunk
addresses would be clobbered by the `ALLOC.reset()` that runs mid-fork, while
the chunks it named stayed mapped.

FINDING: walk the chain and scan each chunk's live prefix. No type tag, no
absolute addresses stored outside the chain.

RELEASING: compaction, not tombstones and not holes. Surviving entries are
copied down over removed ones, `used` is rewritten, and a chunk that reaches
zero is unlinked and `channel_munmap`ed (best-effort -- "a munmap hiccup must
not fail an otherwise-complete dlclose"). Entries stay a dense prefix, which
preserves publish order among survivors.

WHY COMPACTION IS SAFE HERE: it moves records, so nothing may hold an absolute
address into the chain. Releases remove a whole ACTIVATION's records at once
and the directory entry naming them goes with it, so no stale address
survives.

THE DIRECTORY IS NOT A STATIC ARRAY. Activations need random lookup by
`activation_id` -- `func_catalog_base` runs per funcref reference during
replay, `table_state_owned` per guest import call. The directory answering
those is itself a record kind in the chain, appended as activations register.
With a measured maximum of 7 activations one chunk holds thousands, so the
prefix scan is O(1) with a tiny constant. There is no `MAX_ACTS`.

A TREE WOULD BUY NOTHING. Trees pay off on large keyspaces with arbitrary
lookup. Every random-access key here ranges over single digits; the one large
keyspace (`RESUME_SLOT_INDEX`) stops being randomly accessed once decision 12
lands, and is walked sequentially instead.

AN OBSERVABLE IS REQUIRED. `identity_chunk_count()` exists because "a fixed
array could not leak; a chunk list can, so the release path needs an
observable", and `fork-identity-capacity.test.ts` asserts it returns to zero.
Each new chain needs the same.

Shared chunks across all registries (rather than one chain per registry) is
what keeps page waste bounded. Measured on php's 7 activations: one mapping per
activation costs 524,288 bytes to hold 114,272 (78% waste), because six of the
seven are under 31 KiB and each still burns a whole 64 KiB page. A shared tail
chunk puts the waste on the last chunk alone -- 13% -- and needs no aggregate
known in advance.

### Every static, and where it goes

**Durable per-activation registries -> `RegistryArena`, released on dlclose:**

| store | bytes today |
|---|---|
| `ActKfigBytes` + `ActKfigIndex` | 67,584 |
| `ActGcCodecBytes` + `ActGcCodecIndex` | 34,304 |
| `ActExnTagsOrds` + `ActExnTagsIndex` | 34,304 |
| `ActivationCatalogOrds` + `ActivationCatalogIndex` | 34,304 |
| `ImportedGlobalProvenanceTable` | 8,192 |
| `ActTableStateOwners` | 3,072 |
| `ActTemplateIds` | 2,304 |
| `ActFuncCatalogBase` | 512 |
| `ActStaticRootBase` | 512 |
| `ResumeSlotIndex` + `ResumeFreeBits` | 794,624 |
| `CatalogCell` (merged, see below) | 262,144 |

`ImportedGlobalProvenanceTable` belongs here despite an earlier claim of mine
that it was keyed by import rather than activation. Its key is the composite
`(space, consumer_activation, import_ordinal)` (`lib.rs:1303-1306`), so the
dlclose trigger applies unchanged. It also holds imported TABLES, not only
globals, so its name understates it.

**`CatalogCell` is merged, not moved.** It holds resume ordinals for activation
0 -- the same data `ActivationCatalogOrds` holds for activations 1..N. The
split runs backwards against measurement: php.wasm needs 19,025 ordinals
against the largest extension's 7,750, so the biggest consumer sits on the
fixed 256 KiB static while the small ones got growth. Merging makes activation
0 an ordinary entry and the duplicate path disappears.

Its stated reason for being static is a lifetime requirement, not a sizing one:
"A fixed BSS buffer holds the catalog so it survives the per-fork heap reset".
Retained arena chunks satisfy that identically.

One hazard to handle deliberately: `resume_register_impl` falls back to
`resume_catalog()` when `activation_catalog(id)` is `None`, documented as a
"legacy harness path: fall back to committed-ordinal numbering". The merge must
either preserve that fallback or retire it explicitly, not silently.

**The allocator itself:**

`HeapCell`'s 1 MiB floor goes to zero; the first chunk comes from
`channel_mmap` like any other. Verified: `channel_mmap` performs no allocation,
so calling it from inside the global allocator cannot recurse, and nothing
allocates before `fm_set_format` stores `CHANNEL_BASE` (`lib.rs:3532`) as the
first module call the backend makes.

The floor's stated justification is false and must be corrected in the same
change. `lib.rs:3602` reads "a fork CHILD re-seeds its catalogs while the
kernel is still creating it, and a syscall there is refused". This lane
retracted that claim (`docs/plans/2026-09-16-lane-f-closure.md:1531`): at a
64 KiB probe floor a child's measured 256-512 KiB peak necessarily exceeded the
floor, so children WERE calling `channel_mmap`, and 40 of 41 lifecycle tests
passed. The comment still asserts the retracted reason.

**Per-fork transients -> the bump heap:**

`ScratchCell` (65,536 B, "transient exchange storage for the guest's recursive
payload codecs") and `CapturedExternrefs` (16,384 B, explicitly
"capture-scoped: cleared when a capture begins"). Their lifetime IS the bump
heap's lifetime, so they become ordinary allocations from it.

`VectorInFlight` (96 B) joins them. It is a matched push/pop stack -- depth
incremented at `lib.rs:9860`, decremented at `:9923` -- used while building
reference vectors during capture, so its lifetime is the bump heap's. Its
depth-8 limit is a correctness assertion rather than storage ("an overflow is
a loud refusal rather than a silently mis-counted vector"), and as a bump-heap
`Vec` with an explicit depth check that refusal becomes intentional instead of
a side effect of array capacity.

### P-11 realignment

Two threads, both in scope.

**Thread A -- recover `__heap_base`.** `read_heap_base`
(`crates/wasm-artifact/src/facts.rs`) finds the heap base only via an exported
global named `__heap_base`. No SDK-linked test program exports it, so every one
falls back to `PROCESS_MEMORY_FALLBACK_BRK_BASE` = 16,777,216 (kernel side:
`MemoryManager::INITIAL_BRK = 0x01000000`).

Root cause: the test programs are NOT built with the Kandelo SDK.
`scripts/build-programs.sh:128` invokes `clang` directly with a hand-maintained
`LINK_POST_LIBS` array -- a second copy of the SDK's link contract that has
drifted from `sdk/src/lib/flags.ts:259-298`. It is missing
`--export=__heap_base`, `-z,stack-size=8388608` and `--global-base=1114112`,
while carrying every other flag from the same block. The export was never
dropped; it was never requested.

This is a platform defect with its own justification, independent of this lane.
`crates/runtime-core/src/memory.rs:66` asserts "For programs built with our SDK
this is always overridden before `_start` runs" -- false for everything the SDK
program path builds. The same comment names the hazard the override exists to
prevent: `INITIAL_BRK` "may sit inside the stack region of programs with a
large data section (e.g. mariadbd's `__heap_base` = 16.32MB), causing the heap
and shadow stack to overlap". Whether mariadbd overlaps today is untested and
must be checked.

Work: converge `build-programs.sh` onto the SDK's link contract (preferably by
using the SDK rather than duplicating its flags -- `CLAUDE.md` requires build
scripts to "use the worktree-local SDK"), and add a guard that fails loudly
when a program admits without `__heap_base` instead of silently taking a 16 MiB
penalty.

**Thread B -- the fallback's value.** Once the export is recovered, 16 MiB is
serving the case it documents rather than every program. Its value should then
be chosen for that case. Note `DEFAULT_BRK_RESERVE_PAGES = 256` in
`host/src/process-memory.ts:22` is dead -- `@deprecated`, referenced nowhere --
and should be deleted rather than retuned.

P-11's own tightness is NOT to be relaxed. The test fills the address space to
`ENOMEM` and proves six things: root continuation failure returns `ENOMEM` with
no child; no phantom child; parent syscalls still work; a 4,096-deep fork fails
MID-UNWIND (exercising `ABORT_UNWINDING`, not the root-allocation path); the
aborted transaction unmapped all three pages; and a later recovery fork
succeeds. The tightness is the test.

## P-11: two fixtures, and why both

`fork_at_depth(4096)` and the address-space fill test different halves of the
same contract, and one layout cannot serve both once the build path is fixed.

**Tight fixture** -- the error paths: root-allocation `ENOMEM` with no child,
no phantom child, parent syscalls still usable, mid-unwind `ABORT_UNWINDING`,
all three pages reusable after abort, recovery fork succeeds. Reaching those
requires a controlled small address space.

Today that tightness comes from a DEFECT: the missing `__heap_base` export
forces a 16 MiB brk fallback out of a 24 MiB process. The fixture is therefore
calibrated against a bug, and fixing the bug without pinning the fixture would
make it silently stop exercising what it claims. Pinning via `maxPages` makes
the constraint intentional and stated.

**Adaptive fixture** -- that the same behaviour holds at PRODUCTION layout:
real `__heap_base`, the SDK's 8 MiB shadow stack, an ordinary page budget.
That is the configuration real software runs in, and nothing covers it today.

### The recursion headroom question

`fork_at_depth(4096)` currently runs on wasm-ld's 64 KiB default shadow stack,
because `build-programs.sh` never passes `-z,stack-size`. At 16 bytes per frame
that is the entire stack, and WebAssembly has no guard page -- an overflow
writes past `__data_end` into `.bss` rather than trapping.

It passes today, so either the frames are smaller than that estimate or
something else is true. Measuring `fork_at_depth`'s actual frame size is part
of the plan, because a memory-exhaustion fixture running near a
silent-corruption boundary is a live defect independent of this work, and it
changes how carefully its layout may be altered.

Note the stack-size measurement trap: `stackTop - dataEnd` OVERSTATES the
stack by the whole of `.bss`, since `.bss` occupies address space but emits no
data segment. The authoritative figure is the link flag, not the artifact.

## Testing

The maintainer chose one change with a combined test pass, which concentrates
risk: nine-plus chunk boundaries land together.

**Every landed conversion in this lane has an unexercised spill path.** The GC
codec floor is 32,768 bytes holding 16-byte sections, so spilling needs 2,048
activations; tests use at most 8. The exception-tag floor is 8,192 ordinals
against an observed maximum of 4 and a structural ceiling of 5
(`perl.wasm`'s tag section). Those paths have never run.

That is the same blind spot that made `RESUME_SLOT_INDEX` look green: it passed
every suite at a 4,096-entry floor because no test ever needed a chunk, then
deadlocked every process at a forced 4-entry floor -- all parked in
`channel_mmap` on `memory_atomic_wait32`.

So the combined test pass must include a build where **every** arena's first
chunk is forced small enough to chain, and the full suite must pass in that
build as well as the default one. A conversion whose chunk path has not
executed is not tested.

Per-guard perturbation still applies: every new guard must be made to fail
before it is trusted.

## Risks

1. **The `RESUME_SLOT_INDEX` deadlock is not yet explained.** It must be
   understood before that conversion is written, not after.

   What is established: `resume_register_impl` runs only from `resume_reseed`,
   called from `fm_set_resume_catalog` and `fm_set_activation_resume_catalog`
   -- both seeding entries. On a fork CHILD those run inside
   `replayDlopens`, which `worker-main.ts:4679-4696` places in the `else`
   branch of the parent's `setupChannelBase` call: the child seeds every side
   activation "before the process transaction is attached".

   The symptom was every process in state S at 0% CPU, parked in
   `channel_mmap` on `memory_atomic_wait32`. That is a syscall ISSUED and
   never answered -- not a missing channel base, which would return `EINVAL`,
   and not the `ENOMEM` the GC codec attempt produced. So the child had a
   usable channel and nobody serviced it.

   HYPOTHESIS, not yet tested: the child issues its first `channel_mmap`
   before the kernel has registered it as a schedulable process, so the
   request parks forever; the parent stays blocked in `fork()` waiting for the
   child, and the kernel waits on the fork it is still completing.

   EXPERIMENT that would settle it: force the floor small again, and record in
   the module which `fm_*` entry is on the stack when `channel_mmap` is
   entered, together with whether the kernel has registered the child pid at
   that moment. If the parking call is the child's first seed and registration
   has not happened, the hypothesis holds and the fix is ordering rather than
   allocation strategy. `setupChannelBase` itself is NOT the asymmetry -- it
   concerns the guest's channel base (TLS slot or imported global), not the
   module's, which `fm_set_format` supplies at `lib.rs:3532`.
2. **`ResumeSlotIndex` is 89.7% of what remains** after the other conversions
   (786,432 of 876,640 bytes). Deferring it leaves most of the static in place;
   including it puts the one demonstrated failure inside the combined pass.
3. **`ResumeFreeBits` is sized from `RESUME_SLOT_CAP`.** Making slots dynamic
   requires the free-list representation to change with them.
4. **The GC codec arena is sized for a workload that does not exist.** All 99
   fork-instrumented binaries report `layouts=0, fields=0`; clang/wasm32 emits
   no wasm GC types. Making it dynamic removes the need to guess, which is why
   the maintainer chose that over resizing it.

## Out of scope

* `commit_table_mutation_impl`'s archive-chain record per table mutation, which
  has no release path naming it (structural leak by inspection, unmeasured,
  predates this lane).
* Any change to what P-11 asserts.

## Experiment results (2026-09-18)

The maintainer chose "run the experiment first". Rather than reconstruct the
reverted chunked `RESUME_SLOT_INDEX`, the cheaper discriminator was to force
the GC codec arena to spill on EVERY activation -- `ACT_GC_CODEC_FLOOR` from
32,768 to 1 -- so each child seed calls `channel_mmap` through code that
already exists. Build key moved `6c9de4d1…` -> `e504d969…`, confirming the
perturbation reached the artifact; source and key were restored afterwards
(`verify-fresh` 0).

### 1. The ordering hypothesis is REFUTED

`fork-module-gc-replay.test.ts` passed 5/5 with every activation's codec taking
its own mapping during child seeding. **A fork child's `channel_mmap` is
serviced.** The child does not park for want of registration, so the
`RESUME_SLOT_INDEX` deadlock is not explained by the seeding phase and the
remaining candidates are specific to that conversion's own code.

This also retires the last trace of "children cannot syscall", which the
`HEAP_FLOOR` comment still asserts.

### 2. A test asserts the module must be LARGER than 4 MiB

`host/test/fork-module-instance.test.ts:50` failed with
`expected 3735552 to be greater than 4194304`. Shrinking one arena shrank the
reserved region below a hard-coded 4 MiB expectation.

That is a FLOOR ON MEMORY USE wearing the shape of a guard: it fails on any
static reduction, including the ones this lane already landed, and it would
have blocked this work at the first conversion. It must be reworked to assert
what it actually cares about -- that the region covers the module's declared
`memorySize` plus its shadow stack -- rather than a constant.

### 3. `errno 12` is an ADMISSION BUDGET refusal, and the number is 16,973,824

`fork-module-worker-instantiation.test.ts` failed with:

    [kernel-worker] fork worker launch failed: ProcessMemoryCapacityError:
      Process memory request exceeds admission budget 16973824
    fork aborted with errno=12: the kernel refused to create the child process

This is the SAME `errno 12` the GC codec conversion attempts produced, and it
was never about children being unable to syscall. It is a process memory
admission budget of 16,973,824 bytes (16.19 MiB) being exceeded.

**It is also direct empirical support for the shared-arena design.** Giving
each activation its own mapping -- approach B, and approach C for the
size-declaring registries -- is exactly what blew the budget here, which is the
78%-page-waste arithmetic showing up as a hard refusal rather than as waste.
One shared chain does not. That choice is now measured rather than argued.

### 4. The "both builds" requirement is practical

The forced-spill build ran 185 tests across 29 files in about 25 minutes and
surfaced both findings above immediately. Two failures out of 185, both real,
neither visible in the default build. The requirement costs a suite run and
earns a class of defect the default configuration cannot reach.
