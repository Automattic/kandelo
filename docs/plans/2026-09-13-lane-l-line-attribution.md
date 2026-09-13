# Lane L — every line attributed, and why that still does not give a target

**Date: 2026-09-13. Status: complete. This is the measurement the L1 census
said it had not made.**

The L1 census (`docs/plans/2026-09-11-lane-l1-census.md`) replaced lane L's
guessed 1,500-line target with a derived 3,600 and said so in bold: *"Target
derived, not provisional."* **It is not derived.** Its per-unit "After" column
is smaller than the lines its own Findings table says must stay, and nobody
had put the two tables beside each other.

This is the campaign's own standing lesson applied to the campaign: **an
accepted cost is a claim, and claims get measured.**

## Method

Every top-level declaration in the four files was attributed to the
declaration that owns it, with a preceding doc-comment block counted as part
of the declaration it documents. Totals are `wc -l`, the unit the budget uses
on this branch. The census's own words on its method were: *"It was derived by
reading, not by attributing every line."*

## Where the census's arithmetic does not close

**`process-memory.ts`: census says 1,337 → ~400, "allocation and lease
mechanics stay".**

Measured, the allocation and lease mechanics are **1,030 lines** —
`ProcessMemoryAllocator` alone is 634, `OwnedProcessMemoryLease` 72, the
retirement thresholds, backlog errors and capacity errors another ~190, and
the fork-clone/grow helpers ~80. The layout computation the census planned to
share away was **207 lines**. 1,337 − 207 is 1,130, not 400. **A 400-line
`process-memory.ts` requires deleting the allocator the census said stays.**

**`kernel-scratch.ts`: census says 2,491 → ~1,400, "capacity mechanics stay",
and estimates the capacity mechanics at ~600 lines under the heading
`OwnedKernelScratchRegion`.**

`OwnedKernelScratchRegion` is 326 lines. But it is not the capacity system; it
is a third of it. The same invariant is also carried by
`ActiveKernelScratchLease` (**877 lines**) and `ActiveKernelScratchDataView`
(**389 lines**), which are what hold "capacity beside pointer" across an
escaped view and across a kernel export that may re-enter. Measured, the
capacity machinery is **1,710 lines**, not 600. The estimate named one class
and counted one class.

## The attribution

**Read the last column as "can lane L's own increments move it", not as
"is this irreducible".** Attributing a line to a declaration says nothing about
whether the declaration needs to be that long or needs to be TypeScript at
all — see "What the attribution does NOT license" below, which is the more
important half of this document.

| Unit | Lines | What it is | Can lane L move it |
|---|---|---|---|
| `process-memory.ts` constants + layout types | 72 | The shape this host's callers consume | No |
| `computeProcessMemoryLayout` + empty-program note | 50 | A call into the shared Rust function | No — this IS the L3 result |
| `createProcessMemory` | 19 | `new WebAssembly.Memory` | No — JS-only |
| `process-memory.ts` allocator/lease/retirement | 1,030 | Admission, aliasing, retirement backpressure | Not by lane L's increments — **and the census's "stays" is unaudited; see below** |
| `kernel-scratch.ts` intrinsic capture | 135 | 46 `intrinsic*` bindings | No — JS-only overhead (census's fourth category) |
| `kernel-scratch.ts` export-name + pointer tables | 312 | `KERNEL_SCRATCH_EXPORT_NAMES` and friends | No — guarded by a test, and generating it is declined; see below |
| `kernel-scratch.ts` error + buffer intrinsics | 139 | Reading a live `WebAssembly.Memory` safely | No — JS-only |
| `kernel-scratch.ts` DataView ownership | 389 | Capacity invariant, across an escaped view | No — per-syscall-argument, so the hot-path objection is real |
| `kernel-scratch.ts` bounds checks | 195 | The rule, plus i32→u32 and bigint normalization | No — see L4 below |
| `kernel-scratch.ts` lease | 877 | Capacity invariant, across a kernel export | No — same |
| `kernel-scratch.ts` region ownership | 444 | Capacity invariant, at the allocation | No — same |
| `kernel-entry-gate.ts` | 1,596 | The re-entrancy gate | Not lane L work — **and its size is unaudited; see below** |
| `worker-protocol.ts` | 429 | The worker wire | Not by lane L's increments — **and "JS-host structural" is unaudited; see below** |

## What the attribution does NOT license: a new target

The "No" column sums to **5,376**. **That is not a floor, and this document
does not propose it as the lane's target.**

It is the sum of the lines the L1 census said stay. Three of those "stays" are
unchecked sentences of exactly the kind this campaign keeps overturning, and
attributing a line to a declaration says nothing about whether the declaration
needs to be that long or needs to be TypeScript:

- **`process-memory.ts`'s allocator, 1,030 lines.** The census said
  "allocation and lease mechanics stay". What the code does is admission
  thresholds, live-memory and byte accounting, retirement backpressure and
  finalization telemetry — bookkeeping over numbers. Only *holding* a
  `WebAssembly.Memory` and reading its `byteLength` is engine-bound. It runs
  once per process launch and retire, so the hot-path objection that protects
  the scratch accessors does not apply here.
- **`worker-protocol.ts`, 429 lines.** The census said `host-native` uses
  native threads and needs no worker wire. True, and not the same claim: "the
  other host does not need it" is not "it must be hand-written TypeScript". It
  is 429 lines of `interface` declarations, which is what lane E generated
  from Rust for the browser/node protocol pair.
- **`kernel-entry-gate.ts`, 1,596 lines.** The gate must be JavaScript — Rust
  gets the invariant from the borrow checker and JavaScript has no equivalent.
  Whether it needs 1,596 lines to hold it is unaudited, and the census said so.

**Where the hot-path objection is real** is `kernel-scratch.ts`'s 1,710-line
capacity machinery. Those accessors run per syscall argument; moving the
decisions into a wasm module means a module call per field read, which is the
same cost that stopped L4 deleting the TypeScript bounds checks.

So the honest position is: **the lane's target is not derived, by either
number.** 1,500 was a guess, 3,600 did not follow from the census that claimed
to derive it, and 5,376 would launder an attribution into a derivation.
Deriving it needs three audits — the process-memory allocator, the worker
protocol's generatability, and the entry gate's size — none of which is lane
L's remaining increments and none of which anyone has done.

The lane measures **5,853 on its branch**, and 5,689 with the held TypeScript
commit applied. The 165-line reduction is the whole of the duplicated layout
computation — a hand-rolled LEB128 walk over the import section, the placement
arithmetic, and the pthread-declaration rule — and it does not land until the
projection deadlock below is decided. The Rust authority IS landed and
`crates/host-native` uses it, so the two hosts no longer disagree about
`__heap_base` even while the TypeScript still does its own arithmetic.

## L2 is declined, not blocked — and its recorded reason is wrong too

The plan says a generator is impossible because kernel exports mark pointers
three ways and "a type-based extraction agrees with the hand-written TypeScript
table on 40 of 52 entries and cannot see the other 12".

**`host/test/kernel-scratch-contract.test.ts` already extracts all of them.**
Line 1727 iterates every one of the 55 names in `KERNEL_SCRATCH_EXPORT_NAMES`,
derives each export's pointer positions from `crates/kernel/src/wasm_api.rs`,
and fails if they disagree with the TypeScript. Its rule is not type-based: a
parameter is a pointer iff its name ends `_ptr`, and the contract **enforces
that convention in both directions** rather than assuming it —

- a raw `*const`/`*mut` parameter without the `_ptr` suffix throws;
- a `_ptr` parameter whose type is not `*const`/`*mut`/`usize` throws;
- a pointer not followed by a `u32`/`usize` `len`/`capacity` throws.

The "40 of 52" measurement used a weaker rule than the one the repository
actually runs, so the premise recorded for blocking L2 is false.

**That does not make the whole table generatable, and the first draft of this
section overclaimed it.** Only the *required pointer indexes* — the 76-line
switch — follow from `wasm_api.rs`. Three facts in that block do not, because
they are host facts rather than kernel facts:

- **which 55 exports belong in the table at all.** It is not "every export with
  a pointer": `kernel_select`, `kernel_transfer_channel_execute` and
  `kernel_transfer_io_execute` are members with no required pointer. It is the
  set of exports this host calls through the scratch-lease path.
- **the required/nullable split.** The contract test checks
  `required ∪ nullable` against the Rust, so which of `kernel_select`'s
  pointers may be null is not visible to it.
- **the alignments.** `kernel_pipe2`'s buffer needs 4-byte alignment because it
  holds two `i32`s, which `buf_ptr: *mut u8` does not say.

So generating the table still means declaring those three in Rust — the plan's
option 1 — and what has actually changed is that **option 1's stated cost is
already paid**: the "second thing to keep in step with the signatures" exists,
and the contract test keeps it in step on every run.

**This is nonetheless not lane L work, and not because of the decision.** The
brief this lane was worked under says plainly: do not build a generator for
this, the table is guarded, and the 40-of-52 result is the convention working
rather than a gap. Generating it would buy line count and no safety, against an
explicit instruction. **The 312 lines stay, and L2's entry should record "the
table is guarded; generating it is declined" rather than "blocked on a
decision" — those are different states and only one of them is waiting on
anybody.**

## What L4 could and could not be

`crates/host-native`'s `checked_shared_range` and `kernel-scratch.ts`'s
`checkedRange`/`checkedMemoryRange`/`checkedWasmImportMemoryRange` are one
rule written twice. The rule now lives once, in
`wasm_posix_shared::host_memory::checked_range`, and the native host calls it.

**The TypeScript copy is not deleted, and the reason is the performance
contract.** A bounds check runs on the syscall hot path; reaching it through
the artifact module would put a wasm module call, an input copy and an output
decode on every syscall argument. `docs/agent-guidance/performance.md` treats
that as a cost, not a refactor. So the TypeScript keeps its own arithmetic and
is instead failed against the same corpus the Rust is failed against —
`crates/shared/tests/host-memory-ranges.json`. The rule is stated once; both
hosts are checked against that statement.

This is a real difference from L3, where the shared function is called once
per process launch and a module call costs nothing measurable.

## A build-graph deadlock this lane walked into, and a candidate standing hazard

Adding `wa_process_memory_layout` to the artifact-reader module also added it
to the surface `installWasmArtifactModule` requires, so a stale module would
fail loudly. That is the ABI-staleness rule working — and it **wedged
`./run.sh local-build` completely.**

`packages/registry/kandelo-sdk`'s build runs `images/vfs/scripts/
build-kandelo-sdk-vfs-image.ts`, which inspects every artifact it packs through
this same module, resolved through `binaryTierRoots` — and the tier's copy is
`local-binaries/source-only-v1/`, which local-build refreshes **after every
package has been built.** So:

- the tier cannot be refreshed until the packages build, and
- the packages cannot build until the tier is refreshed.

The run reported `Products: 0/7` and the tier's module was still the old one,
so a second run could not break the cycle either. The freshly built module was
sitting in `local-binaries/` and `host/wasm/` the whole time; nothing that runs
during a package build looks there first.

**Two things are worth separating.** The deadlock is a real ordering defect in
the build graph: a side module is rebuilt as a graph node, but the projection
that makes it visible to package builds happens at finalization. It has been
invisible until now only because every previous rebuild of that module left its
surface unchanged, so a package reading the previous bytes got the same
answers.

The in-lane fix is narrower and does not touch the graph: **the install check
now asserts only the surface every caller needs, and the new entry point is
checked where it is called.** Staleness still fails loudly, with a message
naming both the module rebuild and the tier re-projection — it just fails at
the caller that needs the entry rather than at every caller that does not. The
SDK image build never asks where a process's memory goes.

**Candidate standing hazard, for the maintainer to promote or discard:** *a
loud-staleness check placed at load time can deadlock the build that would
clear it.* The check has to be reachable by something that runs after the
artifact it guards is refreshed. This will bite the next person who adds a
`wa_*` export, and the failure does not look like an ordering problem — it
looks like a stale artifact, which is exactly what the message says.

## A lane-worktree setup step that cannot work as written

The plan tells a lane worktree to "set the cache roots worktree-local", and the
brief this lane was worked under spelled that as
`KANDELO_SOURCE_CACHE_ROOT=<worktree>/.cache/source-only`. **That path is
inside the source checkout, and `packages/registry/rootfs/
build-rootfs-package.sh` refuses it:**

```
ERROR: resolver output root must be outside the source checkout
```

xtask derives `WASM_POSIX_DEP_OUT_DIR` and `WASM_POSIX_DEP_WORK_DIR` from the
cache base, and that script checks both against the repo root. So `rootfs`
fails, and with it every product that depends on it — this worktree's run
reported seven products unreachable while 45 package nodes had succeeded.

**Worktree-local and inside-the-worktree are different things**, and only the
first is what the plan wants: the point is that two lanes must not share one
cache, not that the cache must live under the checkout. A sibling directory
keyed to the lane satisfies it —
`/Users/brandon/kandelo-lane-l-cache/source-only` here.

Recorded because the instruction is given to every lane agent, and the failure
surfaces four hours into a provisioning build, in a package with no obvious
connection to the setting.

## What this did not establish

- **Whether the 1,710-line capacity system is right-sized.** It was attributed,
  not audited. The census left the same question open about
  `kernel-entry-gate.ts`'s 1,596 lines and it is still open; this document adds
  a second one of the same kind. Both are "these lines hold an invariant", not
  "these lines are the smallest way to hold it".
- **Anything about the browser.** Every measurement here is Node-side and
  Rust-side, as the L1 census's was.
- **Whether L2's 312 lines would actually fall.** Nobody has built the
  generator, and this document argues it should not be built. What is
  established is that the extraction for one of its three inputs already
  exists and is exercised over every entry — not that a replacement would be
  line-for-line, and not that it would be worth doing.
- **Whether the three unaudited "stays" would actually shrink.** Naming them as
  unchecked claims is not the same as showing they are wrong. Each needs
  reading the code against a smaller design, which is what the census meant by
  "nobody has audited it".
