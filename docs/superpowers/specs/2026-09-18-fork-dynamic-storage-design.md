# Fork-module storage: dynamic allocation with lifetime-correct release

Date: 2026-09-18
Lane: F (fork inversion)
Status: proposed, awaiting maintainer approval

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

**This is regression repair, not optimization.** Every fixed bound here was
introduced by the migration. The identity table was the first instance the
maintainer caught ("We keep trying to pre-reserve address space"); the rest are
the same defect wearing different constants.

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

**One static requested to remain, needing explicit permission:**

`VectorInFlight` -- 96 bytes, `[[u32; 3]; 8]`. Its bound is semantic, not a
capacity guess: it limits how deeply reference-vector builds may NEST, and the
comment records "eight is far past what the emitted code reaches (a frame
vector holding an aggregate whose field vector holds another aggregate is depth
three), and an overflow is a loud refusal rather than a silently mis-counted
vector". A depth limit on recursion is not the scaling hazard this work
targets. **Maintainer permission required; if refused, it moves to the bump
heap with the rest.**

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

1. **The `RESUME_SLOT_INDEX` deadlock is unexplained.** It must be understood
   before that conversion is written, not after. `resume_register_impl` runs
   only from `resume_reseed`, called from `fm_set_resume_catalog` and
   `fm_set_activation_resume_catalog` -- both seeding entries. Why allocation
   there parks every process is not yet known.
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
