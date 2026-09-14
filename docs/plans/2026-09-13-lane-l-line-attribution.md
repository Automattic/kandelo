# Lane L — the attribution, and what auditing the checkers turned up

**Date: 2026-09-13. Status: complete.** It began as the line measurement the
L1 census said it had not made, and that is the first half. The second half is
what a night of held builds produced instead: an audit of the
things that CHECK this lane, rather than the things they check.

**If you read one section, read one of these:**

- **L-D3, with a SIGBUS under it** — a transcribed launch-path copy kept every
  errno of the TypeScript it cites and dropped the range proof, so a legal
  wasm32 pointer past the end of memory reached `copy_nonoverlapping`.
  Reverting the fix does not give a wrong errno; it kills the process. Sixteen
  sites, all now proven. **The strongest evidence this lane has, and it is not
  a line count.**
- **The closure target, re-derived** — `crates/host-native` writes the whole of
  lane L in **166 lines**, and 3,284 of the TypeScript's 5,689 are things a new
  host never writes. A single line count cannot express that, which is why
  neither 3,600 nor 2,900 was ever reachable.
- **A hole in the ratchet itself** — four measures in the surface budget
  reported a better number when their input disappears. `lineCount` was fixed
  here on the maintainer's decision; the other three are campaign-wide and sit
  on other lanes' surfaces. Latent, not live, in every case.
- **Green is not evidence** — three findings that are one fault: a guard whose
  removal cannot be detected, corpora every wrong rule satisfies, a check that
  validated the wrong tree. None of them fails anything.
- **The citations have measurably rotted** — the lane's transcription argument,
  with a number under it.
- **The figures this lane got wrong, re-measured** — most of them its own, one
  introduced by this document while recording the others. The section carries
  the count; this line deliberately does not, because two copies of one number
  is what drifted here before.

The rest is the attribution, the L2 decline and its guard, the two candidate
standing hazards, and what none of it establishes.

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

Measured, the allocation and lease mechanics are **1,038 lines** —
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
capacity machinery is **1,711 lines**, not 600. The estimate named one class
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
| `process-memory.ts` allocator/lease/retirement | 1,038 | Admission, aliasing, retirement backpressure | Not by lane L's increments — **and the census's "stays" is unaudited; see below** |
| `kernel-scratch.ts` intrinsic capture | 135 | 46 `intrinsic*` bindings | No — JS-only overhead (census's fourth category) |
| `kernel-scratch.ts` export-name + pointer tables | 312 | `KERNEL_SCRATCH_EXPORT_NAMES` and friends | No — guarded by a test, and generating it is declined; see below |
| `kernel-scratch.ts` error + buffer intrinsics | 139 | Reading a live `WebAssembly.Memory` safely | No — JS-only |
| `kernel-scratch.ts` DataView ownership | 389 | Capacity invariant, across an escaped view | No — per-syscall-argument, so the hot-path objection is real |
| `kernel-scratch.ts` bounds checks | 195 | The rule, plus i32→u32 and bigint normalization | No — see L4 below |
| `kernel-scratch.ts` lease | 877 | Capacity invariant, across a kernel export | No — same |
| `kernel-scratch.ts` region ownership | 445 | Capacity invariant, at the allocation | No — same |
| `kernel-entry-gate.ts` | 1,596 | The re-entrancy gate | Not lane L work — **and its size is unaudited; see below** |
| `worker-protocol.ts` | 429 | The worker wire | Not by lane L's increments — **and "JS-host structural" is unaudited; see below** |

## What the attribution does NOT license: a new target

The "No" column sums to **5,376**. **That is not a floor, and this document
does not propose it as the lane's target.**

It is the sum of the lines the L1 census said stay. Three of those "stays" are
unchecked sentences of exactly the kind this campaign keeps overturning, and
attributing a line to a declaration says nothing about whether the declaration
needs to be that long or needs to be TypeScript:

- **`process-memory.ts`'s allocator, 1,038 lines.** The census said
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

**Where the hot-path objection is real** is `kernel-scratch.ts`'s 1,711-line
capacity machinery. Those accessors run per syscall argument; moving the
decisions into a wasm module means a module call per field read, which is the
same cost that stopped L4 deleting the TypeScript bounds checks.

So the honest position is: **the lane's target is not derived, by either
number.** 1,500 was a guess, 3,600 did not follow from the census that claimed
to derive it, and 5,376 would launder an attribution into a derivation.
Deriving it needs three audits — the process-memory allocator, the worker
protocol's generatability, and the entry gate's size — none of which is lane
L's remaining increments and none of which anyone has done.

The lane landed at **5,689** from 5,853. The 164-line reduction is the whole of
the duplicated layout computation — a hand-rolled LEB128 walk over the import
section, the placement arithmetic, and the pthread-declaration rule — all of
which now exist once, in Rust, called by both hosts. It landed only after the
maintainer took the projection-ordering fix below; until then it was held,
because landing it wedged `./run.sh local-build`.

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

**The guard L2's decline rests on was examined, 2026-09-13, and it holds.**
Declining L2 because "the table is guarded" is only as good as the guard, and
this document had not looked. `host/test/kernel-scratch-contract.test.ts`
exercises `assertKernelScratchPointerRoleContract` in both directions: a
positive loop over every name in `KERNEL_SCRATCH_EXPORT_NAMES`, and a negative
case that reorders `kernel_send`'s parameters into a WRONG order with an
identical Wasm signature — the drift a type checker cannot see — and asserts
the contract throws. It first asserts the original text is present, so the
mutation cannot silently no-op against a stale needle, which is the failure
that produced "found 4" in this lane's own scratch contract test and the one
behind ten of thirteen rotted citations elsewhere in this document.

The negative direction is tested for one export rather than all 55. The
mechanism is shared across exports and the positive loop covers every name, so
this is noted rather than filed as a gap.

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

Two fixes, and only the second closes it.

**The in-lane one narrowed the blast radius:** the install check now asserts
only the surface every caller needs, and the new entry point is checked where
it is called. Staleness still fails loudly, naming both the module rebuild and
the tier re-projection — it just fails at the caller that needs the entry
rather than at every caller that does not. The SDK image build never asks where
a process's memory goes.

**It did not escape the cycle.** `coreutils-docs` BOOTS A KERNEL during its
build, and every process launch asks where its memory goes, so that package
genuinely needs the entry point. It failed, taking twelve dependent nodes with
it.

**The ordering fix was the maintainer's call and was taken (2026-09-13):
`local_build.rs` now stages the co-resident side modules before the scheduler
runs.** It needs no new argument about atomicity, because the code already
establishes it — `run_writes_to_tier`, the predicate gating the retraction
immediately above, already includes
`|| !coresident_side_module_projection_is_current(...)`. So whenever the side
modules are stale the published authority has just been withdrawn, and there is
no live manifest for the staged bytes to contradict, which is exactly the
invariant the finalizer's staging comment protects. **The cost quoted when the
decision was put to the maintainer — trading away that atomicity — was wrong in
the safe direction: the option is cheaper than it was described.**

**Verified end to end on 2026-09-13, once the disk hold lifted.** The test
named for this fix passed: `./run.sh local-build` ran, `coreutils-docs/wasm32`
SUCCEEDED, `rootfs/wasm32` SUCCEEDED, and `product/platform-rootfs` was
CACHED. The package that could not escape the cycle builds again, so this is
now an observation rather than a claim about code.

**The run as a whole still failed, and saying only the first half would be the
narrow-check-for-broad-claim error.** `php`, `vim` and `wget` each fail on a
missing C dependency, at three different stages; thirteen nodes went unbuilt
behind them and products finished at 1/7. They are a provisioning gap, recorded
under the setup section below, not a deadlock — and no attempt was made here to
trace each blocked node to which of the three stopped it.

**Candidate standing hazard, for the maintainer to promote or discard:** *a
loud-staleness check placed at load time can deadlock the build that would
clear it.* The check has to be reachable by something that runs after the
artifact it guards is refreshed. The ordering fix removes this instance; the
shape is worth keeping, because the failure does not look like an ordering
problem — it looks like a stale artifact, which is exactly what the message
says, and it sends its reader to rebuild something already fresh.

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

**The same instruction names a variable that cannot reach a build.** Lanes are
told to set `KANDELO_SOURCE_CACHE_ROOT`, `WASM_POSIX_CACHE_DIR` and
`KANDELO_CASE_IMAGE_DIR` before building. The first and third are on
`scripts/dev-shell.sh`'s `--keep` list; **`WASM_POSIX_CACHE_DIR` is not**, and
dev-shell runs `nix develop --ignore-environment`, so it is stripped before any
cargo or xtask step sees it. Its only consumer in the tree is
`scripts/test-allow-stale.sh:82`, a script nothing in the tree invokes.

The variable that actually keys a lane's binary cache is
`WASM_POSIX_BINARY_CACHE_ROOT`: it is on the keep list, callers set it
(`scripts/activate-ci-test-workspace.sh:34`, and an xtask test sets it through
`.env()`), and xtask describes it as "the exact cache root selected for this
resolution". In this lane it is `/Users/brandon/kandelo-lane-l-cache/binaries`,
the directory holding the resolved `libs/` and `programs/` trees.

**What that instruction may already have cost, observed 2026-09-13.** Another
agent's session scratchpad on this machine holds **five identical copies of the
same 608 MB source archive** — same SHA-256, under five different cache roots
it evidently tried in turn: `cache-b6`, `kandelo/source-cache`,
`src-cache/kandelo`, `srccache`, and `lane-d2/kandelo/src-cache`. That session
directory is 43 GB, nothing has been written in it for over two hours, and
three waiter loops are still polling for completion markers that will never
appear.

**Stated as observation, not proof.** Nothing was read from that session beyond
file sizes and paths, no cause was established, and an agent can guess at cache
roots for reasons unrelated to the instruction. But an agent paying 608 MB per
guess at where its cache should live is what "the setup step names variables
that do not do what they say" looks like from outside, and 43 GB is roughly the
margin this lane has spent a night unable to reach.

Setting the inert variable costs nothing by itself. What it costs is the
belief that the caches were separated, when the separation rests on the two
variables that are kept — and a lane that set only the named three would
resolve against the shared default. Bounded claim: this is what the tree says.
A consumer outside the repository could still read `WASM_POSIX_CACHE_DIR`.

## Three packages cannot build here, each on a missing C dependency

Recorded because they are what `./run.sh local-build` fails on in a lane
worktree today, and a lane that reads "Local build failed" without this list
will go looking in its own changeset.

| Package | Stage it fails at | What is missing |
|---|---|---|
| `wget` | compile | `openssl/ssl.h` not found (`openssl.c:40`, wget's own source, not a path in this tree) |
| `vim` | link | `wasm-ld: unable to find library -lncursesw`, `-ltinfow` |
| `php` | configure | `icu-uc >= 50.1 icu-io icu-i18n` not met |

Thirteen nodes went unbuilt behind them and products finished at **1/7**. These
are unrelated to lane L's surface and were not investigated further: whether
each is a missing dependency declaration, an unbuilt dep, or a resolver miss
is a question for whoever owns those recipes. What this lane can say is the
exact stage and the exact message, which is more than "the build failed".

## Which deletions actually reclaim space, on a clonefile-seeded machine

Two measurements this lane made, hours apart, disagree by two orders of
magnitude and the difference is not noise:

- A 99 GB `target` directory was deleted earlier in the campaign and the
  volume gained **1.5 GB**.
- This lane's own 4.06 GB `target` was deleted at 08:30 and the volume gained
  **3.95 GB** — 97% of its apparent size.

The rule underneath: **these worktrees are seeded with APFS clonefile
(`cp -c -R`), so content that came WITH the seed is shared and deleting a copy
frees almost nothing, while content BUILT after seeding is unique and deletes
for its full size.** `du` cannot tell the two apart — it reports apparent size
for both — so a size listing is not a reclaim estimate.

Practical consequence on a machine carrying fifteen `kandelo*` trees: deleting
a lane's post-seed build output (`target/`, a lane-local package cache) is
worth roughly what it measures; deleting a seeded checkout is worth nearly
nothing until the last clone of that content goes. The 43 GB of duplicated
source archives found in a stalled session's scratchpad is the first kind —
five separate 608 MB downloads, not five references to one.

## Ten figures, re-measured — and where they came from

**The count in this heading was wrong until the list was counted.** It read
"nine" while the summary at the top of the document read "six" and the body
below narrated a tenth: each session appended an entry and left both counts
alone. That is this section's own subject happening to this section, which is
the third time the document has demonstrated its thesis on itself and the
first time the demonstration was in a heading. The list has **ten** entries,
and the summary at the top of the document no longer restates the number —
two copies of one count is the thing that drifted, so there is now one.

Two come from the L1 census and were repeated in this lane's commit messages
before being checked. **The other eight are this lane's own**, and the sixth
was introduced by this document while it was recording the other five. None
changes a conclusion. All are recorded because a number nobody re-derives is
how this lane's target went wrong. **The seventh, and the pattern it shares
with the six above it.** Deleting this lane's
`target` was justified in writing by "the binary cache is intact, so package
resolution is still warm" — that cache is 17 MB. The bulk is elsewhere (24 GB
under source-only). The conclusion happened to be right and the stated reason
pointed at the wrong directory, which would mislead anyone using it to judge
what else is safe to delete. It went into a script written to prevent exactly
this.

Looking at all seven: not one was a figure the author was uncertain about.
Every one was stated in passing, as support for something else that held the
attention — a count quoted while arguing a conclusion, a cache named while
justifying a deletion, a measurement point mixed in while cataloguing other
people's measurement errors. **The unverified claim is not the hard one; it is
the incidental one.** That is worth more than any individual correction here,
because it says where to look: not at the numbers a document is about, but at
the ones it uses to get somewhere else.

**Eight and nine, both scaffolding for the ratchet finding.** "Five measures
run shell pipelines with stderr suppressed" counted LINES containing
`2>/dev/null`, not measures — one measure suppresses twice, so it is four
measures across five sites (three and four after `lineCount` was fixed). And
"all thirteen counted paths exist" is fourteen; the earlier count folded a
`.json` reference into a total of source paths. Both had reached this
document, the master plan, a commit message and an escalation to the
maintainer before a claim-checker extended to read a third commit draft forced
the comparison.

**A tenth error of a different kind, and the maintainer caught it.** This
document repeatedly said the night's work was done "with no compiler" and that
four items "need a compiler". No compiler was ever missing: cargo works, and
other lanes built Rust throughout. What was withheld was PERMISSION — a
standing instruction not to build until the volume had 50 GB of margin.
Writing it as an absent tool implied a broken toolchain rather than a hold
being respected, and it spread to both commit drafts and the window script
before anyone read it closely. The lesson is the same as every entry above it:
it was never the sentence under examination. (This paragraph said "the nine
figures" until the list was counted — a fourth copy of a number that belonged
in one place, found by grepping for the other three.)

**Two sit in landed commit messages**, which are immutable: the
correction lives here rather than in a rewritten history.

- **"`host-native` cites `host/src/*.ts` in 47 comments."** Measured at the
  campaign base: **43 doc-comment blocks, 62 comment blocks in total, across 66
  lines.** 47 sits between the two groupings, so the census is imprecise rather
  than wrong — and the transcription argument is stronger, not weaker, at 62.
- **"Six allocation sites move to `KernelScratch`."** Eight had, and three more
  were still calling the allocator directly. **All eleven** now go through the
  type, and a contract test enforces it — see the commit "Nothing reaches the
  scratch allocator except through its capacity".
- **"64 `host-native` tests."** Reported as this lane's evidence; the tree
  holds **69** `#[test]` functions (49 in
  `crates/host-native/src/lib.rs`, 19 in `crates/host-native/src/guest.rs`,
  1 integration) — not to be read as the 35-file/69-test host-suite baseline
  quoted elsewhere in the plan, which counts a different suite and collides
  with this figure by coincidence. 64 was true when measured and later commits added tests
  after that run, which is the same failure the two figures above record. The
  module wire count (15) and shared corpus count (5) both reproduce exactly.
  **A count of test functions is not a pass count**, and no suite has run
  since the disk outage, so the host-native suite is to be re-run in full
  rather than treated as already green.
- **"That removes 207 lines from `host/src/process-memory.ts`."** From
  `5c90e6a`, the commit that landed the TypeScript half. The commit deletes
  **205** lines from that file and adds 41, for a net **164** — which is the
  figure the surface budget banked and the one the lane's headline uses. 207
  is neither the deletion count nor the net.
- **"Six existing tests place a layout from a heap base with no program at
  all."** From the same message, as the reason `heapBase` had to stay the
  caller's to supply. **Five** tests in `host/test/process-memory.test.ts` do
  this. The claim named no file, and I did not establish whether a sixth lives
  elsewhere: seven other test files mention `heapBase`, mostly through helpers
  rather than by placing a layout. The argument the figure supports is
  unaffected — the authority would have moved under those tests either way.
- **"62 comments cite `host/src/*.ts`", set beside "thirteen carry a line
  number".** Written into the citation section below during this audit. The 62
  is a campaign-base measurement and the thirteen is a lane-tip one, so the
  pair reads as a single consistent count and is not. At the tip the figures
  are **59 and thirteen**. The conclusion is unchanged — ten of the thirteen
  anchors are dead either way — but the arithmetic a reader would do from the
  pair (62 - 13 = 49 unanchored) was wrong by three, and mixing measurement
  points is the exact error the first two entries in this list record.

## What an audit without running anything found, 2026-09-13

Every corpus case re-derived from the documented rule rather than from the
function under test, while builds were held pending disk. Nothing
below changes a landed conclusion. **It was written without running anything,
and has since been run**: when the hold lifted, every claim in this section
went through cargo and vitest, and each commit carries the result. The findings
stand on the reading. The run is what made them observations — and it is what
caught the oracle defect, described at the end of this document, that reading
had not.

### Both corpora were correct, and neither could fail

Four plausible wrong rules passed every case in the two files. Each is now
answered by one case, and each case fails under exactly the rule it was
written for and passes under the others; every pre-existing case is unchanged.

- **The layout corpus could not see `DEFAULT_INITIAL_PAGES`.** The rule floors
  `min_pages` at 17 pages, but every case sat at 2 MiB or above, so the floor
  never bound — and a derivation that omits that constant entirely reproduced
  all seven cases exactly. Added a heap base of 65536 (page 1, below the
  floor), which answers 17/18/20 under the real rule and 1/2/4 under the rule
  that ignores it. With the floor removed the new case fails and the other
  seven still pass, which is what "the corpus was blind here" means concretely.
- **Nothing pinned the layout's accept/reject boundary.** The late refusal is
  `initial_pages > maximum_pages`, and no case had the two equal, so `>=`
  passed the whole corpus while rejecting every address space that exactly
  fits. Added the smallest layout the rule can place — the 17-page floor puts
  control memory at pages 17..19, so a ceiling of 20 fits exactly — paired
  with a refusal at 19, fixing the boundary at 20 rather than near it.
  Writing that case surfaced a question, which then had an answer: at the
  boundary `brk_base == max_addr`, so the smallest layout `compute_layout`
  ACCEPTS is one with no allocatable heap at all. Traced rather than left
  open — `MemoryLayout::set_brk` returns the break unchanged for any growth
  past `max_addr` (`crates/runtime-core/src/memory.rs`), which libc reads as
  failure, and `mmap` refuses any region ending past it at the same ceiling.
  So the process fails its first allocation and says so, which is the
  platform-values contract's truthful failure rather than a crash or a
  silently wrong address space. Placement and viability are different jobs
  and the rule only claims the first. **The judgment left for the maintainer
  is narrow**: whether placement should refuse earlier than the first
  allocation does. If it should, this boundary moves and the case moves with
  it.
- **Nothing fixed the order of the range corpus's null and bounds checks.** No
  case had an address that was both null and past the limit, so a host
  checking bounds first passed the whole file. The order is the point: `0` is
  what a kernel allocator returns when it gave nothing, and reporting the
  memory's extent for a failed allocation diagnoses the wrong fact. Added addr
  0, len 1000000 against a one-page memory, which is both.
- **Nothing stopped `allowAddressZero` from waiving the bounds check.** The
  flag says the caller means offset zero, not that the range fits, but every
  case with the flag set was in bounds — so a rule returning ok for any zero
  address once the flag is set passed the file. Added the flag set with a
  range past the end.

### Every case earns its place, and a weak mutation set said otherwise

Having added four cases, the obvious question is whether the OLD ones still
pay for themselves. Tested by mutation: write the plausible wrong rules and
ask which cases reject each.

A first set of seven mutations left three range cases catching nothing, which
read as "these are regression baseline, not guards". That conclusion was wrong,
and the error is worth recording because it is the same one this lane keeps
finding in itself: **a case looks redundant exactly when the mutation set is
too weak to need it.** Three more mutations — no null check at all, the limit
misread as pages rather than bytes, an address read as a signed `i32` — claimed
two of the three. The last, "the largest wasm32 address with a positive length
is refused", needed a tenth: 32-bit end arithmetic, where `0xffffffff + 1`
wraps to 0 and a range that leaves every real memory reads as a legal empty
one. That is precisely the rule that case exists to exclude.

**All twelve range cases discriminate at least one wrong rule**, and four do so
alone: the failed-allocation case (bounds checked before null), the
allow-zero-with-bad-bounds case (the flag waiving the check), the zero-length
null case (a null check that ignores length), and the u64 case (silent overflow
wrap).

The layout corpus got the same treatment: thirteen mutations against nine
cases and five refusals. Every case rejects three to five of them, and five
mutations are caught by exactly one entry each — the `>=` boundary by the
exact-fit case, aligning down by the unaligned heap base, the two minimums by
their own cases, and early-path truncation by the 2^63 heap base.

**One entry no mutation catches, and the reason is a property worth naming.**
"Control memory alone past the ceiling" exercises the EARLY refusal, the one
taken before the page arithmetic when `first_free_byte > max_addr`. Deleting
that branch entirely changes no answer in the file: the late refusal catches
the same request and reports the same message, because the early one was
deliberately written to report "the SAME number the full path below would
report". **So the corpus cannot observe whether that branch exists.** It is
not a guard that cannot fail (hazard H-2); it is a guard whose REMOVAL cannot
be detected, which is the same hazard read backwards. It is defensive rather
than load-bearing — with `first_free_byte` bounded by `u64::MAX`, the page
count it guards against reaches at most 2^48, so the late path would not
overflow either. That is worth knowing before someone deletes it as dead code
and every test still passes.

The layout corpus's one unexplained refusal was explained the same way rather
than with filler. `maximumPages: 2` pins the `<=` in
`maximum_pages <= CHANNEL_PAGES`: were it `<`, that ceiling would fall through
to the later refusal and report "initial pages 259 exceed process maximum 2" —
true, and naming the wrong problem. All five refusals now say what they hold.

### "One file, both hosts" was true in name more than in fact

**The TypeScript half checked three of seven layout cases and skipped the rest
silently.** Its filter took only cases naming neither a heap base nor an
imported minimum, so both cases added above would have been Rust-only, as
would the two heap-base placement cases that pin the divergence this lane
closed. The filter's stated reason was wrong: `heapBase` is an option
`computeProcessMemoryLayout` takes and honours — that is how a caller places a
layout for a program it has not read — and only an imported memory's minimum
needs a real binary, which the Rust side confirms by reading that one fact
from the artifact bytes rather than from the wire. The filter now keys off a
`programBytesOnly` marking the corpus declares (one case), checks each
declared skip is declared for the reason true of it, and asserts
declared-plus-checked accounts for every case. **Eight of nine cases are now
checked in both hosts.** The range corpus already worked this way, with an
explicit `rustOnly` marking; its floor was raised to track its size.

**The range corpus was then asked the same question, and was missing the same
half.** It declared its one skip, and a floor caught the corpus shrinking, but
nothing checked that the marker was true — a case marked `rustOnly` for a
reason this host does not actually have would have been skipped in silence,
which is the exact defect the layout half had. The one reason a JavaScript
host cannot present a range case is an address it cannot name exactly:
`checkedWasmGuestPointerOffset` refuses anything above
`Number.MAX_SAFE_INTEGER` before a range is considered, a limit
`crates/host-native` does not have because it takes a u64 from a memory64
guest. The check now asserts that of every skipped case, and **12 of 12 range
cases are accounted for** — eleven run here, one skipped for a stated and
verified reason.

Perturbed three ways. Marking either of two presentable cases `rustOnly` fails
— but both also tripped the floor, so neither showed the new check doing
anything the old one did not. The third does: an EXTRA case marked `rustOnly`
leaves eleven presentable, the floor is satisfied, and only the new assertion
catches it, by name. A guard is worth its lines when something gets past
everything else.

**Nothing could see the pairing stop being true, and now something can.**
"One corpus, both hosts" is a claim about two files, and every check either
side ran was a check on its own half. Delete the TypeScript consumer — which
is the direction this campaign actually pushes, since removing TypeScript is
its purpose — and the Rust half goes on passing while the corpus keeps
describing itself as shared. Green, and the claim false.

Each Rust corpus test now asserts that its TypeScript counterpart exists and
still names the corpus file. It forbids nothing: it makes single-hosting a
corpus a deliberate act, taken in one change, by whoever wants it. Perturbed
both ways — renaming the corpus inside the TypeScript file fails with *"no
longer reads this corpus, so 'one corpus, both hosts' is false while
everything is green"*, and deleting the TypeScript file outright fails with
the path and *"if it was deleted on purpose, this corpus is single-host now
and both this test and the corpus header must say so."*

The first attempt at it passed for the wrong reason and then failed for a
better one: `CARGO_MANIFEST_DIR` is `crates/shared`, so joining `tests` before
the relative path looked in `crates/host/test`, which does not exist. It
failed loudly rather than silently, which is the only reason it took one run
to find rather than a reader.

**The mirror exists too, and it exists so the pairing needs no argument.**
The first version guarded one direction, justified by which way the campaign
pushes — TypeScript is what gets deleted, so the Rust side is what must
notice. That reasoning is sound and it is also a thing to be wrong about. Each
TypeScript corpus test now asserts the Rust half still reads the corpus, so a
crate restructure that moves or drops the Rust consumer fails on the
TypeScript side. Perturbed the same two ways, and the second perturbation
improved the check: deleting the Rust file first produced a bare `ENOENT`,
which tells a reader which syscall failed and nothing about what it means. It
now says what the Rust side says — that the corpus is single-host now, and
both the test and the corpus header have to admit it.

**The refusals were checked in one host only; they are not now.** The
TypeScript half wrote two of them out by hand rather than reading the corpus,
so the two saturating refusals and the new exact-fit boundary were Rust-only —
and the two it restated were the same knowledge written twice, which is the
thing this lane exists to stop. All five are now driven from the corpus, and
the two hand-written ones are gone. See "the last open item" below for what
made that harder than it looks.

### The held branch left nothing behind

The TypeScript half sat on `brandonpayton/lane-l-typescript-layout-held` while
landing it wedged `./run.sh local-build`, and was cherry-picked once the
maintainer took the xtask ordering fix. "It landed" was being asserted from the
weaker evidence that `host/src/process-memory.ts` calls the shared function.

Checked properly: **all eight files that branch held are byte-identical to the
lane branch.** `crates/wasm-artifact/src/facts.rs`, the three
`wasm-artifact-module` files, `host/src/process-memory.ts`,
`host/src/wasm-artifact-driver.ts`, `host/src/index.ts` and
`host/test/process-memory-layout.test.ts` all diff empty. The only differences
between the two branches are commits that landed afterwards. The held branch is
fully subsumed and can be deleted whenever the maintainer wants; it is left in
place because it costs nothing and is the provenance of the cherry-pick.

### Why the `__heap_base` divergence went unnoticed

The corpus asserts that `crates/host-native` answered 256/257/259 for a
program whose heap base is 2 MiB. Checked against `cc2bfe7^`: it did.
`first_free_byte` was `FALLBACK_BRK_BASE.max(min_pages * WASM_PAGE_SIZE)`,
the 16 MiB fallback unconditionally, and the string `__heap_base` appears
**zero** times in that file.

What sat above that constant is the interesting part:

> When a guest exports no `__heap_base`, the control/channel region is placed
> at this fixed byte offset, matching `PROCESS_MEMORY_FALLBACK_BRK_BASE`.

The comment describes a host that consults `__heap_base` and falls back only
when there is none. No such code existed. It is an accurate description of the
TypeScript host, transcribed onto a Rust constant that implemented half of it
— so a reader checking this host against that comment would find them
agreeing, and a reader checking the two hosts against each other would have to
read both implementations to see the gap.

**That is the lane's thesis with a mechanism attached.** "Two transcribed
copies drift" understates it: the comment did not drift from the code, it was
never true of this code, and being false is what kept it quiet. A program
linked with a heap base above 16 MiB had its own static data underneath the
syscall channel for as long as that comment stood.

### The citations themselves have measurably rotted: ten of thirteen

The lane argues that `host-native` was written by reading `host/src/*.ts` and
that two transcribed copies drift. The citations are line-anchored, so the
drift is measurable rather than rhetorical. At the lane tip, **59 comment
blocks cite a `host/src` file and thirteen of them carry a line number** —
those thirteen are the testable ones; the other 46 name a file or a symbol,
with no anchor to rot. (Both figures are measured at the tip. The 62 in the
errata above is the same count at the campaign base, before this lane's
deletions; mixing the two would be the error this document exists to catch.)
Every one of the thirteen was followed.

**Ten do not resolve.**

| Citation | What it claims | What is there |
|---|---|---|
| `fork-reference-transaction.ts:196-201`, `:301-331`, `:536-537` | a capture/retention contract | the file was deleted by `ace9756b1` |
| `kernel-worker.ts:23747-23829` | `readExecPathFromProcess` | that function is at 22285 |
| `fork-module-instance.ts:372-399` | `readForkModuleMemInfo` | that identifier is nowhere under `host/src/` |
| `worker-main.ts:4545-4557` | `__wpk_fork_frame_reserve` import wiring | that identifier is at 4662 |
| `worker-main.ts:4593-4607` | the guest import-flip block | `continuationMmap` for reference scratch |
| `worker-main.ts:4714` (with `:5036`) | a bootstrap export called before `_start` | a funcref-graph comment; `_start` is at 5236 |
| `fork-module-backend.ts:131-154` | `ForkModuleContinuationBackend::setup()` | `setup(): void` is at 209 |
| `exec-target.ts:453` | Node's `isWasmModuleBytes` -> `ENOEXEC` | set-ID commit state; `isWasmModuleBytes` is absent |

**Three hold up.** `fork-reference-broker.ts:590-632` contains
`ForkExternrefTokenCache.materialize` (597); `fork-module-instance.ts:415-542`
holds the shadow-stack placement design the Rust comment ports from (520); and
`worker-main.ts:4780-4874` is consistent with its claim about reference-carrying
tables — that last on weaker evidence than the other two, the range discussing
tables rather than a named symbol being located in it.

A note on method, because a first pass got this wrong. Grepping for a guessed
symbol and asking whether it falls inside the cited range reported two failures
that were not failures: a method whose signature sits at 117 can have the cited
part of its body at 131-154, and the symbol a range refers to is not always the
one a grep finds first. Both were withdrawn and re-checked by reading the Rust
claim and the cited lines together, which is what the table above rests on.

The broken anchors are mostly off by 100-200 lines — the signature of files
that grew after the comments were written — plus two that name things which no
longer exist at all.

None of this is lane L's code to fix, and none of it is a defect in behaviour.
It is the cost the lane's V1 argument predicts, measured: **ten of thirteen
anchors no longer resolve, and the rot is invisible to anyone who does not
follow them.** A shared corpus or a generated constant cannot rot this way,
because nothing has to be re-stated to stay true.

### Four items: all four now fixed and verified

**The two Rust items were applied and verified on 2026-09-13**, once the disk
hold lifted. They were held as patches for nine hours because editing Rust
without running the compiler is how this lane would earn another entry in the
list of figures above. The compiler has now judged them: `cargo test -p
wasm-posix-shared` and `-p host-native` (both `--target aarch64-apple-darwin`) pass
with the patches applied -- 90 and 69 tests -- including
`the_scratch_allocator_is_reached_only_through_the_capacity_type`, which still
finds exactly two direct `alloc_scratch.call(` sites, both inside
`KernelScratch`'s constructors, now that three call sites have stopped
restating their lengths. The dead branch compiles away without changing any
answer the corpus asks, which is what "provably unreachable" predicted.

**Two of the four were written as patches and verified to apply cleanly.**
They were first written to a session temp directory, which would have made
them disposable, so they are also anchored in this clone's object store at
`refs/lane-l/session-artifacts` — a tree, outside `refs/heads`, holding both
patches, the commit drafts and the window script. **That ref is local to this
machine and is not pushed**, so a reader elsewhere will not have it; the
description below is what travels, and it is enough to redo the work. Naming a
temp path here would have planted a fresh dead reference in a document whose
own finding is that ten of thirteen such references have already rotted. Both are small enough to
state outright, so the fix needs no artifact at all:

```rust
// crates/host-native/src/guest.rs -- three sites, pointer and length from
// the same region rather than the length restated beside it:
//   (manifest.ptr(), manifest_len)              -> (manifest.ptr(), manifest.capacity())
//   (prefix_scratch.ptr(), prefixes.len() as u32) -> (prefix_scratch.ptr(), prefix_scratch.capacity())
//   (root_scratch.ptr(), roots.len() as u32)      -> (root_scratch.ptr(), root_scratch.capacity())

// crates/shared/src/lib.rs -- the comparison whose else no input reaches:
//   let initial_pages = if control_end_page > min_pages as u64 {
//       control_end_page
//   } else {
//       min_pages as u64
//   };
// becomes
//   let initial_pages = control_end_page;
```

Each `.capacity()` returns the `u32` the restated expression produced, and
`KernelScratch` is `Copy`, so the call sites type-check exactly as before —
which is a claim about reading, not about compiling, and is why they are
written here rather than applied. They are deliberately NOT in the tree: the substitutions are
type-identical and the branch is provably unreachable, but neither claim has
met a compiler, and "provably" is a word this lane has learned to distrust in
its own mouth. The window script applies them where cargo can judge them and
restores the exact pre-patch files if either fails — by copying them aside
first, not by `git checkout --`, because both targets carry uncommitted work
and discarding it is the incident this lane already had once. **If they land,
this section and two passages in the commit messages stop being true and must
change in the same commit.**

- **`compute_layout`'s `initial_pages` comparison has a dead branch.**
  `if control_end_page > min_pages { control_end_page } else { min_pages }`
  can never take the else: `first_free_byte` is already at least
  `min_pages * page`, so `control_end_page` is at least `min_pages + 3`.
  Confirmed over 201,973 generated inputs reaching the branch, zero of which
  took the else. Harmless, but it reads as though `min_pages` can raise
  `initial_pages` on its own, when it only ever does so through
  `first_free_byte`.
- **L5 enforces half its invariant.** `KernelScratch` guarantees a WRITE
  cannot exceed the allocation, and the contract test guarantees every
  allocation goes through the type. Neither covers the length handed to a
  kernel export beside the pointer, which is the other place the two can
  disagree. Of eleven `.ptr()` uses, five pair it with `.capacity()`, three
  are base addresses for manual indexing, and **three restated the length**:
  `manifest_len` at the rootfs manifest, and `prefixes.len()`/`roots.len()` at
  the foreign-prefix and root calls. **That census was wrong by one, and
  building the guard is what found it — see below.** They equalled the allocation, which is
  "sound by construction" — the exact property the type's own doc comment says
  is not an invariant. **FIXED 2026-09-13**: all three now ask the region via
  `.capacity()`, so pointer and length come from the same object at every site,
  and `host-native`'s 69 tests pass with the change in.
- **The guard that would hold those three is BUILT, and it found a fourth
  site.** `a_scratch_pointer_never_travels_without_its_own_capacity` scans this
  host's own source: for every scratch pointer that reaches a call, the
  capacity of the **same region** must appear beside it, within that statement
  or the one after (a site may bind the pointer to a local first). Base
  addresses are exempt, and the exemption is a pinned count rather than a
  silent fallthrough.

  **The fourth site had been classified as one of those base addresses.**
  `handle_spawn` writes `let scratch = blob_scratch.ptr() as u32 as usize`,
  which reads like manual indexing — and then passes `scratch` to two kernel
  exports. At `kernel_spawn_blob_decode` it passed `blob_len` where the kernel
  declares `buf_capacity`:

  ```rust
  // kernel: fn kernel_spawn_blob_decode(buf_ptr, buf_capacity, blob_len)
  //   if blob_len == 0 || blob_len > buf_capacity { return -EINVAL }
  spawn_blob_decode.call(.., (scratch as i32, blob_len as i32, blob_len as i32))
  ```

  **The kernel's own refusal was being fed the same number twice, so it could
  never fire.** That is hazard H-2 on the far side of the ABI, manufactured by
  a restated length on this side — the clearest argument yet for why "sound by
  construction" is not the same as enforced. Fixed to ask
  `blob_scratch.capacity()`. The same block also re-staged the raw blob with a
  bare `write_bytes` after the kernel overwrote the region, while the FIRST
  staging four lines above went through the region; it now does too.

  Perturbed until it failed, three ways, each rebuilt and run:
  * Restate `manifest_len` beside `manifest`'s pointer — flagged, by name and
    line.
  * Hand a site a DIFFERENT region's capacity (`root_scratch`'s pointer with
    `prefix_scratch`'s capacity) — flagged. This is the one that matters: a
    check satisfied by any nearby capacity would be answering a weaker
    question than it claims.
  * Introduce a third base-address binding — the pinned exemption count fails.

  A fourth attempt is worth recording because it proved nothing: swapping in a
  region that is not yet in scope at that line did not compile, so the test
  never ran and printed no verdict. A perturbation that does not build is not
  evidence the guard holds, and it looked exactly like a pass.
- **Driving the TypeScript refusals from the corpus is done, and the recorded
  blocker was half right.** All five refusals now come from the shared corpus;
  the two the test used to write out by hand are gone, so the reject half of
  "one rule, both hosts" is a checked fact rather than an intention.

  The trap was real and is now reproduced as a perturbation. The corpus
  carries a heap base of 2^63; handed to the entry point as a NUMBER, the
  host's own `layoutAddressIn` refuses it as an unsafe integer —
  `invalid heap base: ...` — before the shared rule runs at all. A loop that
  asserted only "it threw" would pass on that and report agreement about a
  rule it never reached. Handed a `bigint`, which this entry point has always
  accepted, the request reaches the rule and the corpus message is what comes
  back.

  **The other half of the blocker was wrong, and perturbing it is what
  showed that.** The note said JavaScript's parsing could not hold 2^63.
  It holds it exactly — 2^63 is a power of two, so the double is the true
  value and only its PRINTED form, 9223372036854776000, differs. Removing the
  text-lifting step changes no verdict in this corpus, which the perturbation
  confirmed by passing. It is kept because exactness then rests on structure
  rather than on an argument, and the argument is narrow: the page ceiling is
  a `u32`, so every heap base a layout can ACCEPT is below 2^48 and exactly
  representable, and every one far above saturates to the same refusal.

  Four perturbations, each rebuilt and run:
  * Hand the entry point a number instead of a `bigint` — fails with exactly
    the trap above, naming `invalid heap base` where the rule's message was
    expected.
  * Corrupt one expected message in the corpus — fails.
  * Give a refusal an expected message that IS the host's argument check —
    the second assertion fires on its own terms.
  * Remove the text lifting — **passes**, which is the finding recorded above
    rather than a result quietly dropped.

  One defect was found in the check while perturbing it: the second assertion
  first read `startsWith("invalid heap base")`, and the driver prefixes its
  errors with the export name, so it could never have fired. A guard that
  cannot fail, written into the same commit that argues against them. It
  reads `includes` now, and the third perturbation above exists to prove it.

### The spawn fix is covered, and that was checked rather than assumed

The commit fixing `handle_spawn` claimed validation from `host-native`'s 70
tests, including the `smoke_spawn_*` set. **A suite that passes with a change
in it has not shown that it reaches the change** — the distinction this
document spends its length on — so both edited lines were broken on purpose to
see whether anything noticed.

* **The capacity argument.** Pass `0` where `blob_scratch.capacity()` now
  goes: five tests fail, four of them `smoke_spawn_*`. The new
  pointer/capacity guard fails too, which is the second thing worth knowing —
  it covers this site, not just the three it was written for.
* **The re-staged write.** Delete it outright: five tests fail, including
  `smoke_spawn_waitpid`. 60 passed, 5 failed.

So the line that fed the kernel's refusal the same number twice is exercised
on every run, and the fix is load-bearing rather than merely present.

**The other three call sites were asked the same question, and the answer is
not uniform.** L5 changed four sites in total; "69 tests pass with the
substitutions in" said nothing about which of them any test reaches.

* **The rootfs manifest** (`manifest.capacity()`) is on the boot path of
  effectively every machine-starting test. Give it a wrong capacity and the
  failures run to eight and beyond — the whole `smoke_execve_*` family.
* **The foreign-prefix and root calls** rest on exactly **two** tests:
  `smoke_runs_native_dir_mount` and
  `smoke_runs_native_dir_mount_with_non_canonical_mount_point`. Break both
  sites and leave the manifest correct: 62 passed, 3 failed — those two, and
  the source guard.

**That last column is the argument for the guard existing.** It failed in
every one of these perturbations, at all four sites, including the two whose
runtime coverage is two tests deep. Runtime coverage is what a suite happens
to walk through; the guard is what refuses the shape regardless. Two tests is
not nothing, but it is thin enough that a future edit could quietly restate a
length at those sites without anything red — except the guard.

**The conformance suites cannot cover this, and that is checked, not
asserted.** The platform's validation contract says a process-lifecycle change
must consider them, so `scripts/run-posix-tests.sh` was read: it launches each
case through `node --experimental-wasm-exnref`, which is the TypeScript host.
Nothing in `tests/` drives `crates/host-native`. **The native host's spawn path
has no conformance coverage at all** — its own smoke tests are the whole of
it. That is a gap worth naming rather than a defect to fix here: pointing the
conformance suites at a second host is a piece of work with an owner, and the
owner is not lane L.

### "One rule" was a claim about the corpus; here it is as a claim about the tree

L3 and L4 say one placement rule and one bounds rule, stated once and consumed
by both hosts. The corpora make that checkable for the rule's ANSWERS. They
say nothing about whether some other site in `host/src` still works it out for
itself, which is the half that would make the claim false. Both were searched.

**L3 holds, and there is exactly one producer.** Every `controlBase`,
`channelOffset`, `brkBase` and `mmapBase` in `host/src` outside
`wasm-artifact-driver.ts` is read off a layout and passed along. The driver is
where the values are born, and it is decoding the shared Rust function's
response off the wire. Two sites looked like second producers and are not:
`acquireForkMemoryClone` divides the parent's CURRENT buffer length into pages
to size an allocation, computing no control field, and `placeHostControlSlot`
asks `kernel_reserve_host_region` for an address and only materializes views
at what comes back. Placement authority is the kernel's; the page arithmetic
next to it converts a page number the kernel supplied into a byte address.

**L4 holds too, and checking it corrected what the rule is FOR.** The shared
rule has 23 call sites in `host/src` and 14 more in the tests. Against that,
63 places build a typed-array or `DataView` straight onto a guest buffer — 18
with an explicit offset, 45 over the whole buffer — and none of them can read
out of bounds silently. Verified rather than assumed: a three-argument view
past the end of a `WebAssembly.Memory` throws `RangeError`, and so does a
`DataView` read past the end.

So in the TypeScript host the shared rule is not what stands between a bad
pointer and the memory — **the engine is**. What the rule supplies is the part
the engine has no opinion about: that address zero with a positive length is a
FAILED ALLOCATION rather than an out-of-range address, that
`allowAddressZero` is a policy and not an accident, and that the refusal names
the region it was about.

**In `crates/host-native` there is no engine underneath.** The same rule there
is what memory safety rests on, not a source of better messages. That
asymmetry is the strongest form of the one-rule argument this lane has, and it
was not visible from the corpus: two hosts get different guarantees from the
same sentence, which is exactly why the sentence must exist once rather than
be re-derived by whoever is writing the second host.

### L-D3 — the transcription argument, with a SIGBUS under it

Following L4's one-rule thread into `crates/host-native` found the strongest
evidence this lane has produced, and it is not a line count.

`copy_launch_entry` carries a doc comment naming the TypeScript it was
transcribed from: *"mirroring the TS host's `copyEntry` contract
(`host/src/worker-main.ts`)"*. It reproduced that contract's every errno —
`EINVAL` for a bad index, the zero-capacity length query, `ERANGE` for a
capacity below the entry, `EFAULT` for a null destination. **What it did not
reproduce was the one step that is not an errno.** The TypeScript version calls
`checkedWasmMemoryRange` and converts a refusal into `-EFAULT`; the Rust copy
went straight to `copy_nonoverlapping`.

So a `buf_ptr` that is a legal wasm32 address but past the end of this memory
was a raw write into unmapped pages. **Reverting the fix and running the test
does not produce a wrong errno — it kills the process with SIGBUS, "access to
undefined memory".** The JavaScript host answers `-EFAULT` for the same input.

**This is L-D1's class, one level up.** L-D1 was filed about the scratch
allocator; the same shape was sitting at a launch-path import, in a function
that cites its source and copied everything a reader would think to check. A
transcription preserves the visible contract and silently drops the guarantees
the source host's runtime supplied for free — which is the case for stating a
rule once and consuming it twice, made concrete.

Fixed: the site asks `checked_shared_range` and returns `-EFAULT`, the errno
its own cited contract already specifies. No design decision was needed,
because the answer was written in the comment above the bug.

**FIXED 2026-09-13, on the maintainer's decision.** All sixteen sites now
prove the lent range before writing. `KernelLent` is the inbound mirror of
`KernelScratch` — the Rust counterpart of `#rustLentKernelDestination` — and
`write_lent` is the shape every import needed: the kernel names a buffer and
its capacity, the host writes no more than that, and an address it cannot map
is `-EFAULT`.

**The errno was decided against the maintainer's first instinct, and the
reason is in the tree rather than in taste.** The instinct was to trap: the
kernel is the arbiter of reality, so a broken pointer means reality is broken.
That is sound, and this host already disagrees with it in the only places it
checks: `proc_copy_in` and `proc_copy_out` prove kernel-supplied ranges today
and return `-EFAULT`. Trapping the other sixteen would have made one host
answer the same condition two ways depending on which import you hit — and
would have diverged from the JavaScript host, which returns `-EFAULT` for the
identical kernel bug. Lane L exists to remove that kind of divergence, so
`-EFAULT` it is, everywhere, matching what was already written down twice.

The place trapping is still right is where there is no errno to return, and
after this change there is no such place left in the import layer: every
import returns `i32`, and the two helpers that returned nothing
(`write_wasm_statfs`, `write_wasm_stat_fields`) now return `Result<(), i32>`
so their callers can answer.

**Giving sixteen imports the ability to fail means asking who reads the
answer.** That is the same question that found the blob-decode bug, turned on
this lane's own change. Every converted import was traced to its kernel
caller:

* Nine propagate correctly — `i32_to_result(result)?` in
  `crates/kernel/src/wasm_api.rs`, which is exactly what a new `-EFAULT`
  needs.
* **Two swallow it**, both for `host_clock_gettime`, and both predate this
  change: `wasm_api.rs` reads an absolute timer's clock with
  `.unwrap_or((0, 0))`, so a refusal becomes "now is the epoch" and an
  absolute deadline turns into a far-future one; and
  `crates/runtime-core/src/lib.rs` calls the raw import, ignores the `i32`
  entirely, and returns a `sec` that is still zero.

Neither is lane L's file and neither is newly broken — but this change made
them reachable, which is the honest way to put it. **In practice the refusal
cannot fire there**: both pointers are kernel stack locals, so their addresses
are inside kernel memory by construction. That is the phrase this document
distrusts, and here it is actually true — which is worth saying rather than
leaving the reader to wonder whether the caveat is load-bearing.

**The cost is now measured, and the answer is that frequency settles it.**
The claim to check was "these proofs are on a hot path". They are not, in
anything this suite exercises. A counter in `checked_shared_range`, run over
the whole `host-native` suite — 70 tests that boot machines, spawn, exec,
fork, read directories and run programs to completion — reports **203 proofs
in total**, of which 34 come from this lane's own unit tests. So roughly 169
proofs cover every machine boot and process lifecycle in the suite.

At that frequency the per-call cost of a few integer comparisons cannot
matter, and no micro-benchmark of `checked_range` would add anything: the
question was never how fast one proof is.

**Five of the eleven converted imports are never executed by the suite**, and
that is the caveat this fix carries. The same counter, split per import over
the full run:

| import | calls |
|---|---|
| `host_waitpid` | 801 |
| `host_fetch_deferred` | 45 |
| `host_clock_gettime` | 5 |
| `host_pread` | 4 |
| `host_read` | 2 |
| `host_fstat` | 2 |
| `host_readlinkat` | **0** |
| `host_fpathconf` | **0** |
| `host_readdir` | **0** |
| `host_getrandom` | **0** |
| `host_fstatfs` | **0** |

**One of the five was made drift-proof instead of left alone.** `host-native`
carried three record sizes as hand-written constants — `WASM_STAT_SIZE = 88`,
`WASM_STATFS_SIZE = 72`, and a literal `16` for the dirent record — each with
a comment naming `crates/shared` as where the number comes from. That is the
same size stated twice, with the citation attached, which is this lane's
subject exactly. All three are `core::mem::size_of::<...>()` of the shared
type now, and a test pins them at 88/72/16 so the switch is provably
behaviour-preserving rather than merely plausible. The statfs path is one of
the five nothing executes, so a drift there would have been invisible; it
cannot drift now.

**The same search found four more, and the hunt is the point.** If three
record sizes were transcribed, what else is? Every hardcoded constant in
`guest.rs` was checked against what `crates/shared` declares, and the dirent
TYPE values — `DT_UNKNOWN`, `DT_DIR`, `DT_REG`, `DT_LNK`, written out as 0, 4,
8, 10 under a comment naming `crates/shared` — are the same shape. `shared`
declares all eight in `pub mod dirent`; this host maps four and answers
`DT_UNKNOWN` for everything else, which POSIX allows and which is why only
four are named. They ask `shared` now.

**That claim was wrong about the channel status words, and the error is the
one this document is about.** The first pass said they were "host-side
protocol with no shared declaration to drift from" — having checked
`crates/shared`, found nothing, and reported about ALL sources. They are a
mirror of `WASM_POSIX_CHANNEL_STATUS_*` in `libc/glue/abi_constants.h`, and
the code's own comment says so. Checking one source and concluding about every
source is the narrower-question error, committed while cataloguing it.

**Their comment also claimed a pin that did not exist.** It read "pinned here
against that generated header" — present tense, describing an intention.
Nothing read that header. A reader checking this host against its own comment
would have found them agreeing and learned nothing, which is exactly the
`__heap_base` failure recorded above, in a different file. They cannot be
asked of `wasm_posix_shared`, because it does not declare them — only the host
and the guest glue touch the status word — so the header is the single source
and a test reads it now.

The pin is real and perturbed: drift `STATUS_PENDING` to 7 and it says
*"WASM_POSIX_CHANNEL_STATUS_PENDING is 1 in the header and 7 here"*, naming
the constant and both values.

**Every other comment in that file claiming a check was then surveyed**, since
one of them had just turned out to be describing an intention. Eleven assert a
pin, a guarantee, an enforcement or a verification. Most are accurate — the
handle-liveness and scratch-ownership ones name a TYPE doing the work, which
is the strongest form and needs no test. Two are worth recording:

* **`proc_bytes_tests` says its cases "mirror the JS host's contract tests
  (`host/test/kernel-public-scratch.test.ts`) so both hosts are pinned to the
  same failure modes".** That file exists, so the citation has not rotted —
  but mirroring is the hand-maintained arrangement this lane replaced. All
  four modes it names (out-of-range guest range, out-of-range kernel range, a
  null address with a positive length, the exact end-of-memory boundary) are
  in `host-memory-ranges.json`, which both hosts read and neither can stop
  reading without failing. The comment understates what now holds it.
* One comment in the fork-replay driver asserts an exhaustiveness property
  ("checked after every `fm_*` call in this sequence") and appears to sit
  above a constant rather than the sequence it describes. **That is not this
  lane's code** — it is fork capture/replay, not host↔kernel plumbing — so it
  is named and left rather than chased.

The remaining literals in that file are not transcriptions:
fork-coordination phases are host-side protocol, and
`KERNEL_MEMORY_MIN_PAGES` is this host's own sizing choice. Seven
transcriptions removed, three more constants pinned to the source they mirror,
and one claim of mine corrected.

The dirent capacity was verified against the kernel before it was derived:
`WasmDirent { d_ino: u64, d_type: u32, d_namlen: u32 }` is 16 bytes, the
kernel passes `&mut dirent as *mut WasmDirent as *mut u8`, and the host writes
exactly those three fields — so the hand-written 16 was right, and is now the
shared type's own answer.

So `waitpid` is the hot one, not the clock, and the five zeros are
**compile-checked only**: their conversions type-check and their capacity
arguments were derived by reading the kernel's declared buffer size, but no
test runs them. A wrong capacity there would not be caught by anything in this
repository today. Exercising them needs guest fixtures that call
`readlink`, `pathconf`, `getdents`, `getrandom` and `statfs` — which is a
piece of work with an owner, and the owner is whoever wants those paths
covered rather than a lane that arrived here from a bounds rule.

Two measurement mistakes are recorded with it, both the same shape. The first
count of proofs was read BEFORE the smoke suite ran, because the reporting
test sat in a module that sorts earlier — a number that looked like a total
and was a prefix. The second hid `host_clock_gettime` entirely, because
`grep "^HITS"` cannot match the first line: `--nocapture` prefixes it with the
test's own name. **An anchored grep is a check that answers a narrower
question than it was asked**, which is this document's subject arriving in its
own measurements, twice in one session.

**What this does NOT measure**, because the performance contract is explicit
that a narrow check must not carry a broad claim: it says nothing about a
WordPress boot, a PHP request storm, or any workload with sustained syscall
traffic. It refutes "hot path" for everything the suite covers and no more.
The instrumentation was temporary and is not in the tree; the counter and its
two reporting tests were reverted, and the suite is byte-identical to before
the measurement.

**What the class was, before it was fixed.**
`checked_shared_range` has six call sites covering three functions —
`KernelScratch::write` and both sides of `proc_copy_in`/`proc_copy_out`, the
cross-memory process copies. Against that, `guest.rs` has **73 raw
`write_bytes` call sites** (an earlier count of 75 included the definition and
a line of comment prose describing `host_proc_write_bytes` — a checked path,
which is what made the error worth catching before publishing a list).

Of the 73, **sixteen write through a pointer the kernel handed in** — a count
that was thirteen until `cargo xtask perturb` showed why (see below) — and
they are worth naming rather than counting, because the decision below is
about these and not about the other fifty-seven:

| Import | Site | Address |
|---|---|---|
| `host_clock_gettime` | guest.rs:3110, :3111 | `sec_ptr`, `nsec_ptr` |
| `host_read` | guest.rs:3162, :3178 | `buf_ptr` |
| `host_pread` | guest.rs:3348 | `buf_ptr` |
| `host_readlinkat` | guest.rs:3733 | `buf_ptr` |
| `host_fpathconf` | guest.rs:3916 | `value_ptr` |
| `host_readdir` | four sites | `dp`, `dp + 8`, `dp + 12`, `name_ptr` |
| `host_fetch_deferred` | guest.rs:4070 | `buf_ptr` |
| `host_getrandom` | guest.rs:4088 | `buf_ptr` |
| `host_waitpid` | guest.rs:4185 | `status_ptr` |
| (helper) `write_wasm_statfs` | guest.rs:909 | `ptr`, passed through |
| (helper) `write_wasm_stat_fields` | guest.rs:1003 | `stat_ptr`, passed through |

The remaining fifty-seven write to addresses the host computed itself — channel
offsets derived from a layout the kernel placed, and scratch offsets inside a
region the host allocated. Those are a different question and are not part of
this report.

**The line numbers here will rot**, which this document has said about line
anchors elsewhere and applies to its own table: what does not rot is the
import names, and `grep -n 'write_bytes('` re-derives the rest in a second.

**The count is pinned while the decision is pending, and pinning it correctly
took two goes.** The first version counted addresses whose NAME looked like a
pointer — `_ptr`, `_addr` — which is a thing that is usually true when the
invariant holds rather than the invariant itself, the third instance of that
shape on this branch. `cargo xtask perturb` killed it with a write through
`let dest = value_ptr as u32 as usize`, and the survivor was not hypothetical:
`host_readdir` already does exactly that, writing four times through
`let dp = dirent_ptr as u32 as usize`. Three real sites were missing from the
count and from the table above.

The guard counts arithmetic now: writes in the function, minus proofs in the
function, pinned at **fourteen**. Every proof there belongs to a write there,
so the difference is the number of unproven writes whatever anyone names their
variables. A proven write added later leaves the difference alone; an unproven
one raises it; proving an existing one lowers it, which has to be a deliberate
edit. It does not force the decision; it
stops the class getting larger while the decision is open, and makes fixing a
site move the number on purpose rather than drift past it.

Perturbed both directions, which for a pinned count is the whole point:
* **A twelfth unproven write** — a second `value_ptr` copy added to
  `host_fpathconf` — fails, listing all twelve.
* **One site made proven** — the same write taking an offset a check
  returned — fails at ten, listing the remaining ones by name. A ratchet that
  only caught growth would let a fix land with a stale number beside it.

Two attempts before those proved nothing, and both are the same lesson in
different clothes. The first pair of perturbations never applied: the
replacement strings had the wrong indentation, the `assert` raised, the file
was untouched, and the test that ran afterwards passed on unmodified source.
The third failed to compile, and a `cargo test` that never builds prints no
verdict at all. **A perturbation that does not land looks exactly like a guard
that holds**, and the only defence is reading the run rather than its exit
line.

The cleanup between them did real damage: `git checkout --` on
`crates/host-native/src/guest.rs` reverted the new guard along with the
perturbation, because the guard itself was uncommitted. That is the incident
this document already records under the window script, repeated by the person
who wrote it down, two sections later. It was recovered from a copy taken
before the first perturbation — which is the practice that section recommends,
and the only reason this paragraph is an anecdote rather than lost work.

**A second instance, and it names the shape of the fix.**
`write_wasm_statfs` cites `#writeStatfsToMemory` in `host/src/kernel.ts` and
takes a bare `ptr: usize`, writing 68 bytes at it. The TypeScript it mirrors
takes no pointer at all: it takes a `RustLentKernelDestination`, a frozen
token produced by `#rustLentKernelDestination`, whose own comment is the
clearest statement of this lane's subject anyone has written —

> fitting in the current WebAssembly Memory proves only addressability, not
> ownership. The Rust import arguments name the allocation and its capacity;
> keeping both in an authenticated token prevents a later caller from
> substituting total Memory length for the allocation bound.

That function calls `checkedWasmImportMemoryRange` on the `(ptr, capacity)`
pair the kernel passed, binds the result to the memory generation, and hands
downstream code a token it cannot forge. **`crates/host-native` has exactly
this type for regions it ALLOCATES — `KernelScratch` — and no mirror of it for
regions the kernel LENDS it.** Outbound is guarded by a type and a source
check; inbound is a `usize`.

So the fix has a shape and it is already written, twice: once in TypeScript at
the inbound boundary, once in Rust at the outbound one.

**They were reported before they were changed, and the split held up.**
`copy_launch_entry` had its errno decided for it by the contract it cites, so
it was fixed immediately; the other fifteen turned on one question —
what this host returns when the kernel hands it an unmappable pointer —
which is a decision about the host↔kernel contract rather than a
transcription repair, and so was put to the maintainer rather than taken by a
lane that arrived here following a different thread.

The maintainer took it, and the answer is above: `-EFAULT` everywhere,
against a first instinct to trap, because the tree had already answered the
same question twice. All sixteen are converted. The two helpers that returned
nothing (`write_wasm_statfs`, `write_wasm_stat_fields`) return
`Result<(), i32>` now, so their callers can answer — which is what removed
the last place where trapping would have been the only option.

## A hole in the ratchet itself, found by the same question

Asking "what would a WRONG version do" of the surface budget — the instrument
every lane's target is measured by — finds one.

`lineCount` in `host/test/surface-budget.test.ts` runs
`cat <files> 2>/dev/null | wc -l`. **A file that no longer exists at its named
path contributes zero, silently.** Measured against lane L's own surface: with
`host/src/process-memory.ts` renamed or moved, the measure reads **4,516**
against a ceiling of 5,689 — a reported 1,173-line improvement — and the gate
passes.

So a lane can bank a large reduction by moving code OUT of the counted set
rather than deleting it, and the ratchet will confirm the win. Nothing goes
red. The check is doing exactly what it was written to do, and measuring
something other than what it claims.

**And it was not one helper.** Four measures in that file ran shell pipelines
with stderr suppressed, across five suppression sites (one measure suppresses
twice) — three across four sites after the fix below — and every one of them
reported a BETTER number when its input disappears: `lineCount`'s `cat`, a `find | xargs cat` over headers, a
grep across five source trees, and `grep -ro 'parseShebang' host/src` — rename
`host/src` and that last surface reads zero, a perfect score. The twelve
`readFileSync` sites in the same file throw loudly on a missing path. The split
is exactly shell-pipeline versus in-process read, which is not a decision
anyone made about measurement; it is what each was convenient to write in.

**Eight surfaces share the line counter alone, naming ten files** —
`forkTypeScript`, `workerMainTypeScript`, `sffsTypeScript`, `memoryFsTypeScript`,
`kernelWorkerTypeScript`, `kernelHostImportTypeScript`,
`hostKernelPlumbingTypeScript` and `parseShebangReferences`. **FIXED 2026-09-13, on the maintainer's explicit decision.** It was reported
rather than fixed first, because a ratchet everyone is measured by should not
be quietly edited by one of the lanes it grades; the maintainer chose to take
the fix in lane L's window. `lineCount` now requires every counted path to
exist before counting, and a glob that matches nothing reaches the check as
its own literal pattern and fails the same way. The measure is unchanged at
5,689 — the fix must not move any lane's number, only change what happens
when a path disappears. **Only `lineCount` was fixed**; the other three
suppressed measures have the same failure direction, each needs a different
remedy, and they belong to other lanes' surfaces.

Checked for an existing mitigation before reporting this: there is none. The file's four
`toBeGreaterThan(0)` assertions guard lane METADATA — closure lists, why-text
length — not measured values, and **no surface declares a floor: 0 of 20**. So
nothing anywhere notices a measure that collapses to zero.

**The hole is latent, not live.** All fourteen source paths the budget test
names as string literals exist today (`host/src/kernel-scratch.ts`,
`kernel-entry-gate.ts`, `process-memory.ts`, `worker-protocol.ts`,
`kernel-worker.ts`, `kernel.ts`, `worker-main.ts`, `vfs/memory-fs.ts`,
`vfs/sharedfs-vendor.ts`, and four crate files), so no surface is currently
mis-measuring. The fourteenth match is `surface-budget.json` inside an error
message, not a counted path. Whether any lane has previously banked a
reduction this way was NOT investigated: that would mean auditing other lanes'
histories, which is not this lane's to do. The reason to think
it matters is that the campaign's whole method is lanes reducing counted
surfaces, and this is the one way to satisfy that method without doing the work
— available by accident, not only by intent.

### The same test, turned on this document

The finding above is that ten of thirteen line-anchored citations in
`crates/host-native` no longer resolve. A document that reports that and does
not check itself is making an argument it declines to be measured by, so every
citation here was resolved against the tree.

**34 distinct file paths, all of which exist.** One git ref named in the text
resolves; the only other `refs/...` string is `refs/heads`, a namespace rather
than a ref.

**Fourteen line anchors, and only three are this document speaking.** The
other eleven are the rotted host-native citations, quoted as the evidence for
the finding — resolving is not what they are for, and a checker that flagged
them would be flagging this document for reporting rot accurately. Of the
three: `scripts/test-allow-stale.sh:82` is the `CACHE_DIR=` line that reads
`WASM_POSIX_CACHE_DIR`, and `scripts/activate-ci-test-workspace.sh:34` is the
`export WASM_POSIX_BINARY_CACHE_ROOT=` line — both exactly what they are cited
for. The third, `openssl.c:40`, is wget's own source and not in this tree,
which the table now says.

**The real defence is that this document barely uses anchors at all.** Three,
against thirteen in one Rust file. The first draft of this sentence gave a
ratio — "three in eleven hundred lines" — which was already wrong when written
and would have been wrong again by the next commit, because the denominator
moves every time the document is edited. A self-referential count is the one
number guaranteed to rot. An argument stated in prose, with the identifier
named, does not.

**And the checker that established this answers a weaker question than the
finding needs, which is worth more than its result.** Perturbed three ways: a
path that does not exist is caught, a line past the end of a real file is
caught, and **a real file at a real line whose content is something else
entirely is NOT** — which is the shape five of the thirteen rotted citations
have. Existence is mechanical; correspondence was verified by reading each of
the three. That is only tractable because there are three. It is a one-off
audit and is not shipped as a test: a content check would have to guess which
identifier each anchor means, and a guard that guesses is the next entry in
this list rather than the end of it.

## The oracle's LEB128 walk lost one byte per name

`host/test/process-memory-layout.test.ts` keeps an ORACLE: the placement
arithmetic `host/src/process-memory.ts` used before the shared Rust rule
replaced it, so the new path can be checked against an independent
implementation. When the tier was re-projected and the test could finally run,
it failed on `wasm32/sh.wasm` — the rule floored control memory at 34,930,688,
the oracle at 16,777,216, a 16 MiB gap in the same shape as the `__heap_base`
divergence this lane closed on the native host.

**The first diagnosis was wrong, and worth recording as such.** It said the
oracle was an incomplete transcription that had dropped the imported-memory
minimum because reading it needs a wasm parser. The oracle HAS that parser —
`importedMemoryMinimumPagesOracle`, "read the way the oracle's era read it" —
and calls it. The diagnosis stopped at a plausible story one step before the
evidence.

**The actual defect is one line of JavaScript semantics:**

```js
off += uleb();   // reads `off` BEFORE evaluating uleb()
```

A compound assignment evaluates its left operand first, and `uleb()` advances
`off` past the length prefix as a side effect. The `+=` then overwrites that
advance, **losing one byte per name** — two per import entry. Across
`sh.wasm`'s 68 imports that is 136 bytes of drift, so the walk read `kind 103`
(not a valid import kind) where `env.memory` sits at entry 16, fell through to
`return null`, and the oracle silently used the 16 MiB fallback.

**Three independent parses now agree the answer is 533 pages**: the Rust
reader, a Python parse written to break the tie, and the oracle once its
advance was corrected. `sh.wasm` imports `env.memory` with `flags=3 min=533
max=16384` and exports no `__heap_base` at all.

Two things this makes concrete:

- **A parser that mis-walks fails silently and conservatively.** It did not
  crash or report a malformed module; it returned "no imported memory", which
  is a legal answer that a caller cannot distinguish from the truth. The
  oracle agreed with the rule for every program whose imports it never had to
  walk far into.
- **It had never run.** The test arrived whole in `5c90e6a` and every run since
  failed earlier, on the stale wasm module, so a real defect sat behind another
  defect for a day. Nine of its cases were correct and unverifiable; the tenth
  was wrong and equally unverifiable.

Fixed by capturing each length before advancing. **Nothing about the test was
weakened**: the oracle remains a genuine second implementation with full
imported-minimum coverage.

## Reading found wrong numbers; running found wrong behaviour

The two halves of this lane's validation caught disjoint classes of defect,
and neither substitutes for the other. Worth stating because the first half
took nine hours and felt thorough.

**Reading found ten wrong figures** — counts, ratios, measurement baselines,
a cache directory named while justifying a deletion. Every one was an
incidental claim, none was the claim under examination. They would have
shipped inside commit messages and a plan document, where nothing executes
them.

**The first execution found five wrong behaviours, in twenty minutes**, none
of them in code that had been perturbed:

- The mutation gate blocked in BOTH directions — two variables with opposite
  senses and a default that inverted one. It failed closed, so nine hours of
  perturbation in the refusing direction confirmed it working.
- Every cargo step omitted `--target`. `.cargo/config.toml` sets
  `[build] target = "wasm32-unknown-unknown"`, so all three Rust suites exited
  101 without building a single test. The convention was visible in other
  lanes' `ps` output hours earlier.
- Four vitest invocations re-ran `global-setup` four times, ~90s each.
- The gate printed a pass count and no verdict lines, because vitest's default
  reporter suppresses console output on success — so the standing rule to READ
  them could not be satisfied by the run that claimed to satisfy it.
- Six tests ran against a module that could not satisfy them, because
  `binaryTierRoots()` returns the first existing candidate and the stale copy
  sat in the tier searched first.

**The asymmetry is the point.** Static checking cannot execute a branch, and
every one of those five defects lived in a branch that had never been taken:
the permissive side of a gate, a flag's effect on a build, a reporter's
behaviour on success, a loader's tier precedence. Perturbation tests the paths
you thought of. Running tests the paths that exist.

## What this lane kept finding: green is not evidence

Three of tonight's findings are the same fault wearing different clothes, and
naming the shape is worth more than any one of them. Hazard H-2 says a guard
that cannot fail is not a guard. Each of these passes that test and is still
hollow:

- **A guard whose REMOVAL cannot be detected.** `compute_layout`'s early
  refusal reports the same message the late path would, deliberately. Delete
  the branch and every corpus case still passes.
- **A corpus every wrong rule satisfies.** Both shared corpora were correct in
  every value and could not distinguish the real rule from four plausible
  wrong ones — including one that ignores a constant the file's own header
  names.
- **A check that validates the wrong thing.** The window script ran the
  surface-budget gate before applying patches, so the gate would have passed
  on a tree that was not the tree being committed; and its commit plan omitted
  a modified file, which would have been left behind with every test green and
  both commits reporting success.

- **A checker blind to the claim it was built for.** This lane wrote a script
  to print the tree's counts beside the commit drafts' claims, precisely so a
  number could not go stale again. Its claim extractor matched
  `case|refusal|file|anchor|citation|figure|mutation|comment` — and not
  `measure`. The headline number of the commit it was checking, "five
  measures", was invisible to it, and the script reported success. It had also
  been computing its own directory relatively while changing directories, so
  the half that reads the drafts had been silently failing to find them.

- **A guard that always refuses early shields everything downstream from
scrutiny.** This lane's window script refused below 50 GB, and every test of
it for nine hours stopped at that first check. When the volume finally rose,
the first pass through the rest printed three stale instructions: "six
figures" when it was ten, "two commits" when it was three, "after both
commits" when it was three. The line that had been wrong longest was the one
telling the operator not to let numbers go stale. Nothing failed; the text
simply had never been executed, so nobody had read it.

- **A checker that inherits the author's error and reports it back as
independent confirmation.** The claim-checker printed "suppressed-err measures
5" by counting LINES containing `2>/dev/null` — the same mistake that produced
the wrong "five measures" figure it was built to catch, and one of those lines
was the comment explaining the hole. So the tool agreed with the document, and
the agreement was worth nothing: both counted text about the thing rather than
the thing. This is worse than the omission above, because a check that merely
misses an error leaves doubt, while one that confirms it manufactures
confidence.

None of these fails anything. Nothing goes red, no guard fires, and the
evidence a reader would cite — "the tests passed" — is true and worthless. The last of
these is the sharpest: it was committed BY the tool built to prevent it, by
an author who had spent the night writing about exactly this failure.
**They were all found by reading, and none by running.** The lane's habit of
perturbing guards catches the first kind sometimes; it caught none of these.
The question that did work was consistently *what would a WRONG version do
here*, asked about the checker rather than the code.

Offered alongside the hazard below, and arguably the more useful of the two.

## Which shell guards fail open, precisely

Auditing every guard this lane built found exactly one that fails toward
permission, and the difference between it and the safe ones is mechanical
rather than a matter of care:

| Construct | On a bad or empty value | Direction |
|---|---|---|
| `if [ "$x" -lt N ]; then refuse; fi` | `[` errors, returns non-zero, **else branch runs** | **OPEN** |
| `until [ "$x" -ge N ]; do wait; done` | `[` errors, loop continues waiting | closed |
| `if [ "${x:-0}" != 1 ]; then block; fi` | string compare, no error | closed |
| `[ -x path ] \|\| refuse` | false for a dangling symlink | closed |
| `suite \| grep 'Tests'` then read the line | pipeline status is GREP's; a suite that died before printing shows nothing to read | **OPEN** |
| a mutation harness backgrounded across a laptop sleep | the trial applies, the process dies, the revert never runs — the tree is left MUTATED | **FIXED** |
| `set -- $pair` in zsh, then `[ "$2" -eq 0 ]` | no word split: `$2` is empty, the test errors | **OPEN** |

**The dangerous shape is a NUMERIC comparison inside an `if` whose else branch
is the permissive path.** `[` treats a non-integer operand as an error, and an
error is not `false` — it takes the other branch. Lane L's disk floor was
written that way, and this machine had already produced the triggering
condition once: a GNU `df` on `PATH` made `df -g` invalid earlier in the same
lane, and a waiter silently never fired for hours.

The fix is to validate the parse before trusting it (`case "$x" in ''|*[!0-9]*)
refuse ;; esac`) and to say so in the refusal: *a guard that cannot read the
disk must not assume there is room.* Cheap, and it converts the one failure
mode that matters.

**This is NOT escalated as a campaign finding, unlike the ratchet hole, because
the repository's own guards were checked and do not have it.** The shape needs
two ingredients: a numeric comparison in an `if`, and a value parsed from
something external that can fail. `scripts/check-abi-version.sh` has six such
comparisons and is safe by construction — `drift`, `version_bumped` and
`snapshot_changed` are initialised to literal `0` and only ever set to `1`,
never parsed. The other matches across `scripts/` compare exit codes and
locally computed counts. **The flaw was lane L's own tooling, and the rule is
offered for its transferability, not because the repository has the bug.**

### The last two rows are this lane's own, found after the work was done

**Every validation this lane reported was read out of a pipe.** The shape was
`npx vitest run ... 2>&1 | grep -E "Tests  |FAIL"`, and the verdict lines that
came back were then read and quoted. Those lines are real evidence of the
counts they state, and re-checking has not changed a single number — but the
pipeline's exit status is `grep`'s, not the suite's, so the method cannot see
a suite that exits non-zero while printing passing text, or one that dies
before it prints anything at all. The commit messages say "All exit 0"; when
they were written, nothing had looked at an exit code.

Re-run gating on `$?` rather than on stdout: `budget=0 ts=0 shared=0
host-native=0`. The claims hold. The way they were established did not, and
the difference is exactly what the campaign's own rule is about.

**The checker written to fix this failed open on its first attempt**, which is
the more useful half. It collected four `name status` pairs and did
`set -- $pair; [ "$2" -eq 0 ] || fail=1`. In zsh an unquoted parameter
expansion is NOT word-split, so `$1` was the whole pair and `$2` was empty,
the comparison never happened, and it printed **ALL FOUR EXIT 0** on the
strength of nothing. Written in the same session as the argument against
guards that cannot fail, to fix a guard that could not fail, and shipped in
that state until its own output looked wrong. The second attempt compares each
status by name and was perturbed with a known-failing command before being
believed.

## The harness for this already existed, and it names the mistakes I made

`cargo xtask perturb` is a mutation harness in this repository: apply a source
mutation, run a verifier, revert, report, and fail if a mutant SURVIVES.
Lane L perturbed every guard it built by hand instead, in a fresh shell loop
each time — and hit, in one session, all three hazards that tool's own doc
comment was written to prevent:

* *"On an UNTRACKED file the revert FAILS... two mutations stacked, and the
  second trial's result was attributed to the wrong change."* Two of this
  lane's perturbations never applied at all — the replacement strings had the
  wrong indentation — and the test that ran afterwards passed on unmodified
  source.
* *"On a TRACKED file with UNCOMMITTED changes the revert SUCCEEDS, and
  destroys the work under test."* `git checkout --` on `guest.rs` reverted a
  new guard along with the perturbation.
* *"a mutation that does not COMPILE is indistinguishable from one the tests
  caught."* One trial failed to build and printed no verdict to read.

The tool makes all three unrepresentable: it refuses to start unless the
target is tracked and clean, and a `build` command distinguishes a mutation
the compiler rejected from one a test killed.

**Lane L's guards now have specs, and they are checked in.** No convention
existed for where these live — nothing in the tree carries one — so they are
`docs/perturb/lane-l-host-native.json` and `docs/perturb/lane-l-range-corpus.json`,
to be moved if the campaign settles somewhere else.

  * `lane-l-host-native.json`: restate a length instead of asking the region;
    pass a DIFFERENT region's capacity; remove L-D3's launch-entry range
    proof; restate the blob length as its capacity. **4 trials, 0 survived, 0
    invalid.**
  * `lane-l-range-corpus.json`: mark a case `rustOnly` with no true reason;
    change an expected verdict. **2 trials, 0 survived, 0 invalid.**

One overlap is worth noting because it was not designed: removing the
launch-entry range proof is caught by the pointer/capacity guard as well as by
its own test, because the reverted form creates a third base-address-shaped
site and the pinned exemption count sees it. Two guards, one mutant, neither
written with the other in mind.

**A surviving mutant found both pairing guards asserting the wrong thing.**
They required the other half to MENTION the corpus filename — which a doc
comment satisfies. In `host_memory_range.rs` the name appears five times and
only two are reads, so a half that stopped reading the corpus and kept its
header would have passed, in either direction. All four now require the read
itself: `include_str!("<corpus>")` on the Rust side, the relative path the URL
is built from on the TypeScript side. Neither is satisfiable by prose.

That is the third guard on this branch satisfied by something other than what
it meant, after a `startsWith` that could never fire against a prefixed error
message and a ratchet whose input could vanish. The shape is identical every
time: **the check names something that is TRUE when the invariant holds,
rather than the thing the invariant IS.**

**One direction could not be expressed as a mutation at all, and that is a
limit of the model rather than a gap in the guard.** The harness mutates
content; it cannot delete a file, and it applies one anchor at a time. The
Rust half reads its corpus twice, so mutating one read leaves "the Rust half
reads this corpus" true — the mutant survives because the invariant survives.
The spec for that direction was withdrawn rather than left reporting a
survivor it cannot kill. That direction is verified by moving the file aside
and running the TypeScript suite, which is a perturbation this document
records and the harness has no way to express.

**The evidence is otherwise reproducible rather than asserted.** Every
perturbation claim elsewhere in this document is a transcript of a run
somebody has to take on trust; the specs are a command:

```sh
for spec in docs/perturb/lane-l-*.json; do
  cargo xtask perturb "$spec" || break
done
```

**Six specs, 20 trials, 0 survived, 0 invalid.** The host-native spec's
fourteen completed in a single uninterrupted invocation — which this document
denied for a while, because the run was misdiagnosed as dead while it was
still finishing.

**Runs that were stopped left a mutation in the tree**, which is the fail-open
in the table below: once when a run was killed to make the laptop safe, once
when a backgrounded loop was stopped between applying a trial and reverting
it. Neither cost anything — each diff was read before it was discarded and was
exactly the trial's own line — but "run the whole set in one command" is
advice this lane cannot honestly give until the harness's revert survives its
own process dying.

The loop is not decoration. `xtask perturb` takes ONE spec — it reads
`args.first()` and ignores the rest — so the obvious
`cargo xtask perturb docs/perturb/lane-l-*.json` runs the first file the glob
expands to, reports its 14 trials, and exits 0. A reader would take that for
the whole set. This document carried exactly that command for one commit: a
reproduction instruction that silently measures a fifth of what it claims,
which is the subject of this document appearing in its own reproduction
steps.

**That count was audited rather than assumed.** Claiming "every guard on this
branch has been seen to fail" is the kind of sentence this document exists to
distrust, so every test the branch adds was listed and cross-referenced
against the trials. All were perturbed — but two rested on a transcript where
a command was available, and both are now specs: the LAYOUT corpus's pairing
direction (the range corpus already had one) and the ratchet's counted-path
guard, where renaming `host/src/process-memory.ts` must fail rather than
improve the score.

What remains transcript-only is one direction of the corpus pairing, and that
is a property of the harness rather than a gap: a mutation cannot delete a
file, and the Rust half reads its corpus twice, so no single anchor expresses
"stops reading". It is recorded above with the reason.

### The harness's revert is a third step, and now it leaves a mark

That row is fixed rather than only filed, because a mutation was left in the
tree more than once — **and the honest version of the story is that every one
of those was this lane's own doing, not the machine's.**

The first draft of this section said the harness "kept dying" and blamed
contention with other lanes' builds. The run logs say otherwise: of the runs
that ended early, one was killed by `pkill` to get the laptop to a safe state
and one was stopped deliberately after this lane noticed it had interfered
with it. The long 14-trial run that was left alone **completed**, 14 trials,
0 survived, 0 invalid, under exactly the contention that was blamed. There
were no spontaneous deaths at all.

The instructive one is worse than a crash. This lane read `git status`, saw a
mutation and no `cargo test` process, concluded the harness had died, and
**restored the file by hand while the run was still finishing** — reverting a
mutation mid-verify. The diagnosis was wrong twice over: the process was
between a build and a test, not dead, and the sampling command that "proved"
it (`pgrep -fc 'xtask perturb'`) does not match the harness while a trial's
verifier is the live process.

`tools/xtask/src/perturb.rs` applies a mutation, runs a verifier, then
reverts. It already handles the case it can see: the revert happens BEFORE
reporting, with a comment saying a panic in reporting must not leave the tree
mutated. What it could not handle is its own process dying, and nothing
recorded that it had.

It writes `.perturb-in-progress` at the repo root before the first mutation
now, naming the file and the trial, and removes it after each revert. A
SIGKILL, a sleep, or a killed parent all leave it behind, and the next run
refuses to start — printing the file to check and the command to restore it.

**A sentinel rather than a signal handler**, deliberately: a handler catches
SIGTERM and SIGINT and misses SIGKILL, a panic in a thread, and a laptop that
simply stops. A file written before and removed after cannot fail open — the
next run trips over it. It is also visible in `git status` as an untracked
file, which is itself the alarm.

Perturbed three ways. A stale marker makes the next run exit non-zero with the
file, the trial and the recovery command; removing it lets the run proceed
normally; and a completed run leaves nothing behind. **The first attempt at
that perturbation proved nothing**, and in the most fitting way available: it
read `cargo ... | head -6` and then `$?`, which is `head`'s status, so a guard
written to catch fail-opens was tested by a check that fails open. It is the
third time that exact shape has appeared in this lane's own tooling, and the
second time in a check written the same hour as the row describing it.

**It is deliberately NOT in `.gitignore`, and that was checked rather than
assumed.** One thing in the repository fails on any untracked file:
`.github/actions/package-archive-build/action.yml` refuses when
`git status --porcelain=v1 --untracked-files=all` is non-empty, because
"archive provenance is later trusted across workflows". That never fires in CI
— nothing runs `perturb` there — and locally it can only fire when a perturb
run has already crashed, which is precisely when a loud failure is wanted.
Hiding the marker would trade the alarm for a quieter tree.

**This is shared tooling, not lane L's**, and the same rule applies to it as
to the ratchet: a lane should not quietly change an instrument other lanes
use. It is offered, it is small, and it is one `git revert` away if the
maintainer would rather have the report than the fix.

## A second candidate standing hazard, learned the hard way

*A guard that testing routinely bypasses is not protecting what sits behind
it.*

This lane's disk floor sat at the top of a script and everything below it —
applying patches, running cargo, running vitest — was treated as protected by
it. To test the script's later behaviour, stubbed copies lowered that floor.
Twice, those copies did real work: once applying two Rust patches to the live
worktree, once starting `vitest`, `cargo test -p xtask` and an xtask
`build-deps` run that had to be killed mid-transaction. Both times a `sed`
meant to neuter the dangerous line did not match it — the first because the
line ended in a backslash continuation rather than the word the pattern
expected.

The tempting lesson is "be more careful with `sed`". The real one is
structural: **a single top-level check cannot protect steps that are tested by
removing it.** Each step that mutates a worktree or spawns a build needs its
own opt-in, so that disabling one to exercise the rest cannot enable the
others. The fix here was two more environment gates, one of them inside the
single function every build passes through, rather than at each call site
where a future edit could miss one.

**The strongest evidence for putting guards in structure rather than in
memory** arrived later the same night: a background monitor was marked with an
environment variable, and the liveness check used `pgrep -f`, which searches
command lines and cannot see environment assignments — so a live process was
reported dead. That is the identical mistake this lane had made two hours
earlier with a different monitor, noted at the time, and written down. Knowing
a failure mode, recording it, and repeating it inside one session says the
lesson did not transfer even to its own author. A check whose pattern matches
something intrinsic to the process would not have depended on remembering.

Offered to the maintainer to promote or discard. It is not a finding about
lane L's code; it is a finding about how this lane tested its own tooling, and
it cost a worktree mutation and an interrupted build on a machine with 6 GB
free.

## This branch predates the code-lines conversion, and that governs everything above

**Every figure in this document is `wc -l`, and the campaign has since changed
units.** `19bb692c4` — *Build: Budget code lines, not comment lines*, landed on
`brandonpayton/lane-s-setuid-integrity` — rebaselined every ceiling to
non-blank, non-comment lines. It is **not** an ancestor of this lane's branch,
so this worktree still measures the old way.

| | this branch | after `19bb692c4` |
|---|---|---|
| measure | `wc -l` | code lines |
| ceiling | 5,689 | 4,734 |
| target | 3,600 | 2,900 |
| slack | 150 | 120 |

Three consequences, none of which this lane can settle alone:

- **The closure figure depends on which branch you read.** The section below
  says lane L closes at 3,600 and measures 5,689. That is true here. After the
  conversion the same lane closes at 2,900 against a code-line measure.
- **The ceiling rebaselines to 4,575 on merge, and that is now measured
  rather than computed.** 4,734 was the code-line count BEFORE this lane's
  reduction. Lane S's own test file and budget, checked out over this branch's
  two and run unmodified, report the figure themselves: *"hostKernelPlumbing-
  TypeScript is 4575, which is more than 120 below its ceiling of 4734. Lower
  the ceiling to 4575 in docs/surface-budget.json in this commit."* The
  instrument demands the rebaseline; it does not merely permit it: the banked
  test asserts `actual > ceiling - slack - 1`, which is `4734 - 120 - 1 =
  4613`, and a reduction of 159 code lines drops the measure below it. The
  independently computed figure below was **4,575**, which is the same
  number. The reduction is worth **159 code
  lines** against 164 by `wc -l` — the five-line difference is comment and
  blank lines that the old unit charged for and the new one does not. That
  leaves the lane **1,675 lines above the converted target of 2,900**, against
  2,089 above 3,600 in the old unit; the gap is smaller in the new unit but the
  conclusion is the same.

  **The method was validated before the number was used:** the same
  transcription of `countCodeLines`, run on the files as they stood at
  `19bb692c4`, reproduces lane S's published ceiling of 4,734 exactly. A
  reimplementation that agrees with the original on a known input is worth more
  than the ratio estimate it replaces (~4,600), which is what this section said
  before. The direct run has since confirmed it, so the transcription is now
  corroboration rather than the sole evidence.

  **Two other surfaces fail on that branch and neither is lane L's.** Running
  lane S's gate here leaves three failures: this one, and two for lane G
  (`unguardedLayoutModules` unbanked at 0, and the lane-closure test that
  follows from it). The cause is branch ordering, not a defect on either side:
  that commit's budget carries `unguardedLayoutModules` at **ceiling 1, open**,
  while this branch's carries **ceiling 0**, and the two files even name the
  lane differently — *"14/15 layout modules anchored"* there against *"all 15"*
  here. Lane G finished its last module after lane S branched, so lane S's
  budget is measuring a tree that is further along than it knows. It resolves
  itself when the branches meet. Recorded so whoever merges does not read three
  red tests as lane L's debt.
- **The ratchet fix has two forms, and the second one is now verified.** The
  hole survives the conversion: lane S's `lineCount` reads per file and would
  fail loudly, but `expandGlobs` runs `ls -1d ... 2>/dev/null || true` and
  drops a missing path before the read happens. The fix made here patches a
  `cat` pipeline that commit deleted; the form that survives a rebase guards
  each glob at expansion time.

  It was previously recorded as prepared but unrun, because this branch cannot
  run it. It has since been run, without committing anything: lane S's two
  files were checked out over this worktree's, the prepared patch applied
  cleanly, and the suite was compared before and after.

  * **It moves no number.** 3 failed / 86 passed, identical either way, and
    `hostKernelPlumbingTypeScript` reads 4575 in both. A ratchet fix that
    changed a lane's measure would be a ceiling change wearing a guard's
    clothes.
  * **It fails loudly when a counted literal path moves.** With
    `host/src/process-memory.ts` renamed: *"surface-budget: counted path
    matches nothing: host/src/process-memory.ts."*
  * **It fails loudly when a glob matches nothing**, which is the variant a
    literal-path check misses. With both `host/src/vfork-*.ts` files moved
    aside, the glob itself is named in the error.
  * **It still counts normally otherwise:** `host/src/fork-*.ts` expands to its
    36 files and every measure is unchanged.

  The worktree was restored and the branch's own gate re-run: 81 passed. Two
  guards, two forms, both perturbed until they failed.

  **It is written out here rather than pointed at, for the reason the two
  Rust patches were.** It was first written to a session temp directory, and
  a verified fix that dies with the session is not a deliverable — the
  session-artifacts ref does not hold it either, which was worth finding
  before the claim travelled any further than this branch. Replace
  `expandGlobs` in `host/test/surface-budget.test.ts` as it stands at
  `19bb692c4` with:

  ```ts
  function expandGlobs(globs: string[]): string[] {
    // Each glob must match something. `ls -1d ... 2>/dev/null || true` drops a
    // path that no longer exists and swallows the failure, so a counted file
    // that is renamed or moved contributes zero and the surface reads SMALLER
    // — a reduction the ratchet then confirms. The per-file read below would
    // have failed loudly, but it never sees the file: the expansion dropped it
    // first.
    const files: string[] = [];
    for (const glob of globs) {
      const script = `ls -1d ${glob} 2>/dev/null || true`;
      const matched = execFileSync("/bin/sh", ["-c", script], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line !== "");
      if (matched.length === 0) {
        throw new Error(
          `surface-budget: counted path matches nothing: ${glob}. A counted `
            + "file that moved must fail here, not shrink the surface.",
        );
      }
      files.push(...matched);
    }
    return files;
  }
  ```

  The loop is the whole change: the original joined every glob into one `ls`
  and could not tell which one matched nothing.

## The closure target, re-derived — and it is not a line count

The maintainer asked for the target to be derived rather than asserted. It is
derivable now in a way it was not when L1 ran, because the thing to measure
against exists: **`crates/host-native` now writes the whole of lane L, and it
can be counted.**

| What the native host writes for lane L | lines |
|---|---|
| `ProcessLayout::compute` — the layout seam | 37 |
| `checked_shared_range` — the bounds rule | 9 |
| `KernelScratch` + its impl — outbound capacity | 75 |
| `KernelLent` + its impl — inbound capacity | 35 |
| `write_lent` — the import-boundary helper | 10 |
| **Total** | **166** |

**166 lines is what a second host actually pays for this entire lane.** Not an
estimate: the code is in the tree, it runs the same kernel, and the two
capacity types are there because this lane put them there — which is the
correction to L1's version of this claim. L1 measured ~46 lines and concluded
"a new host's burden here is already near zero"; it was measuring a host that
was MISSING the invariant, which is why L-D1 and L-D3 were filed against it.

**Against that, 3,269 of the TypeScript's 5,689 lines are things a new host
never writes at all:**

| JS-host structural | lines |
|---|---|
| `process-memory.ts`'s allocator, leases, retirement, admission | 1,038 |
| `kernel-entry-gate.ts` — Rust gets this from the borrow checker | 1,596 |
| `worker-protocol.ts` — a native host has no workers | 429 |
| intrinsic/typed-array capture in `kernel-scratch.ts` | 221 |
| **Total** | **3,284** |

The allocator is the addition to L1's list, and it is the largest single item
in the lane. `crates/host-native` has **no** lease, retirement or admission
machinery — it builds a `SharedMemory` in nine lines and drops it. The JS
hosts carry a thousand lines there because a browser must bound and reclaim
`WebAssembly.Memory`/`SharedArrayBuffer` reservations, which is a platform
boundary, not duplicated knowledge.

**So the lane's number splits in two, and that is the finding:**

* **166** — what a host that is not JavaScript pays. This is the number goal V4
  is about, and it is already small.
* **~2,400** — what remains in the TypeScript after the structural block: the
  capacity system, the bounds helpers, the pointer table (57 lines, and L-D2
  refuted, so not generatable), and the layout seam. These carry invariants
  BOTH hosts need, which is why the native host's 166 lines exist at all.
* **3,284** — a tax the JavaScript host pays for being JavaScript and for
  running in a browser. Deleting any of it would not reduce what a new host
  faces by one line.

**A single line-count target cannot express that, and picking one is what went
wrong twice.** L1 replaced a made-up 1,500 with a derived-looking 3,600 whose
per-unit numbers do not follow from its own rule: it said "allocation and lease
mechanics stay" and then projected `process-memory.ts` from 1,337 to ~400,
which is only possible if they go. The conversion's 2,900 inherits the same
shape in a different unit. **Neither number was ever reachable without deleting
something the census itself said must stay.**

**What lane L should close against instead:** the pair. A new host's burden,
measured at 166 and checked by the corpora in both hosts; and the JS host's own
surface, which shrinks only by auditing the three structural items — and where
a reduction is worth reporting as a JS-host improvement, not as progress toward
a host-independent floor. Whether the ~2,400 can be smaller is the audit
nobody has done, and any number for it today would be the third invented one.

## Is lane L finished? No, and the budget says so

Worth stating plainly, because this document spends most of its length on
what was found rather than on where the lane stands. `docs/surface-budget.json`
records lane L as:

    "L": { "status": "open",
           "closure": [ { "surface": "hostKernelPlumbingTypeScript",
                          "atMost": 3600 } ] }

**The lane closes when that surface reaches 3,600 or less. It measures 5,689.**
Nothing landed on 2026-09-13 changes that: the corpora, the documents and the
ratchet fix touch no counted file, by design.

**One subject line reads the wrong way, and curation is where that matters.**
The commit `3f4525d` is titled "Lane L closes at 5,689", meaning the lane's
tally ends there; its body says plainly that "the target stays at 3,600 as an
acknowledged placeholder". Read as a subject alone — which is how a 369-commit
history gets curated into a handful of narrative commits — it says the lane
closed at a number 2,089 above its closure condition. The body is correct and
the history is immutable; this note is for whoever writes the curated subject.

The arithmetic then decides what is left. This document's attribution found
that **the sum of everything the L1 census said STAYS is 5,376** — so even
performing every reduction the census contemplated leaves the lane 1,776 lines
above its closure condition. The only remaining route to 3,600 runs through the
three stays the census never audited: the process-memory allocator (1,038),
`kernel-entry-gate.ts` (1,596) and `worker-protocol.ts` (429) — 3,063 lines
between them.

That reframes "the gate and the worker protocol stay." It is the census's
conclusion, and the census is the same document that missed its target by 2.4x
and filed a defect that was already guarded. **Its stays have exactly the
provenance its target had: read, not attributed.** Whether they survive
attribution is unknown, and it is the only question standing between this lane
and its closure condition.

## What this did not establish

- **Whether the 1,711-line capacity system is right-sized.** It was attributed,
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
- **That L-D3's fix works at five of its sixteen sites.** `readlinkat`,
  `fpathconf`, `readdir`, `getrandom` and `fstatfs` are never executed by any
  test in this repository — measured, not assumed, with a per-import counter.
  Their conversions type-check and their capacities were derived by reading
  the buffer size the kernel declares, and one of them (`fstatfs`) is now
  immune to drift because that size is asked of the shared type. None of that
  is the same as running them.
- **That the range proofs are free in a real workload.** What was measured is
  FREQUENCY, in one suite: 203 proofs across every machine boot and process
  lifecycle `host-native` performs, with `waitpid` the hot import at 801
  calls. That refutes "hot path" for what the suite covers. It says nothing
  about a WordPress boot or a PHP request storm, and the benchmark suites are
  where such a claim would have to come from.
- **That 166 lines is the SMALLEST a second host could write.** It is what
  `crates/host-native` does write, counted rather than estimated — which is a
  floor derived from practice, not from proof. Whether the same invariants
  could be held in fewer lines is the same question left open above about the
  capacity system, asked of the other host.
- **Whether the ~2,400 remaining TypeScript lines can be smaller.** They carry
  invariants both hosts need, so they are not JS-only tax — but nobody has
  read them against a smaller design. Any number offered for them today would
  be the third invented target this lane has been given.
- **Anything the conformance suites would have said.** They cannot reach
  `crates/host-native` at all: `scripts/run-posix-tests.sh` drives each case
  through `node`, so the native host's spawn, exec and stat paths have no
  conformance coverage whatsoever. That is a gap in the repository, not a gap
  this lane created, and it bounds every claim made here about the native
  host.
