# Rust-first ABI-44 campaign — MASTER PLAN

**This is the single authoritative plan.** It supersedes the documents listed
in "Superseded" below, which are deleted in the same change that adds this one.
If this file and another disagree, this file is wrong or the other is stale —
resolve it here, do not fork the plan again.

## Why this exists

The campaign accumulated 132 plan documents, 21 of them about fork alone. Three
of those defined the fork end state precisely and were not read before work was
dispatched against it; a census was commissioned that re-derived one of their
sections. That is not a worker failure. It is what happens when the plan is
distributed across a hundred files and briefs are written from memory.

The maintainer's instruction, verbatim: *"We need to deeply characterize and
plan each lane, not leave it up to worker judgment. We keep getting into
messes and off track."*

So the rule for this file is:

> **A lane is not dispatchable until its section here states the end state, the
> floor, the increments, the acceptance evidence, and the known hazards.**
> "Investigate and report" is characterization work, not a lane, and its output
> belongs in this file before anyone builds from it.

## The four goals, in the maintainer's framing

1. **V1** — share code across hosts.
2. **V2** — deeper Rust type checking.
3. **V3** — bundle the kernel with the VFS so an ABI change cannot break images.
4. **V4 — minimize the host API surface so a new host is cheap to write.**
   *This is the primary goal.* Every lane is measured against it first.

**The V4 measure is a number nobody has stated and everyone should:** how many
functions must a new host implement to run Kandelo? Today the kernel floor is
**72 host functions plus `env.memory`** (a raw import-*entry* count reads 73 —
that trap has caught four agents; say which you counted). The fork module's own
import object is **9 entries, exactly one function** (`resolve_externref`).

## What "done" means for PR #1350

Not "every lane finished". #1350 ships when:

- every lane below is either **landed**, or **explicitly deferred in this file
  with its handoff written**;
- no lane has landed a mechanism with no production caller (see Hazard H-1);
- the host suite's failures are each attributed to a named cause;
- conformance has no campaign-caused regression, stated with evidence.

## Lane worktrees — where the work happens

**This file lives in exactly one place**, which is what lets the top of this
document claim to be the single authority. Verified 2026-09-12 across the
campaign's worktrees: `/Users/brandon/kandelo-abi44-reconcile` (branch
`brandonpayton/rust-first-abi44-reconcile`) carries it, and
`/Users/brandon/kandelo-epoll`, which holds PR #1350's head
`brandonpayton/epoll-kernel-route`, does not. **Plan edits land in the plan
worktree. Nothing else does.**

**Lane implementation happens in a dedicated worktree per lane**, on its own
branch, never in the plan worktree and never on
`brandonpayton/epoll-kernel-route`. Two reasons, both already paid for: parallel
lanes pushing forward-only to one branch collide, and a lane that changes cached
artifact bytes poisons a shared cache every other worktree reads — which is the
exact hazard `run.sh`'s `KANDELO_SOURCE_CACHE_ROOT` documentation describes.

| Lane | Worktree | Branch | Started |
|---|---|---|---|
| **Y** image builders | `/Users/brandon/kandelo-lane-y` | `brandonpayton/lane-y-image-writer` | 2026-09-12, from `1d9dad8b2` |
| **S** setuid integrity *(deferred)* | `/Users/brandon/kandelo-lane-s` | `brandonpayton/lane-s-setuid-integrity` | 2026-09-12, from `002149196` |

**The lane S worktree holds one commit and it is not lane S's.** The lane was
deferred mid-flight; what survives on that branch is the code-line budget
change below, which is campaign-wide rather than lane work.
| **F** fork inversion | `/Users/brandon/kandelo-lane-f` | `brandonpayton/lane-f-fork-inversion` | 2026-09-12, from `052e7e9e6` |

**Provisioning a lane worktree is not the same as rebuilding one.** A fresh
worktree inherits no sysroots, no `local-binaries/` and no `node_modules` —
hours before the first line of lane work, as `CLAUDE.md` says outright. The
lane Y worktree was instead seeded from the plan worktree with `/bin/cp -c -R`
(APFS clonefile — copy-on-write, so the bytes are shared until something writes
them; note that GNU `cp` from the dev shell is first on `PATH` and does **not**
support `-c`, so the system binary must be named explicitly). The eight built
production images came across with **identical SHA-256 digests, verified**.

That last point is not convenience, it is correctness for this lane: those
images are lane Y's before-picture, and rebuilding from scratch the baseline you
are about to compare against is circular.

**A CLONED TIER GOES STALE WHEN THE ABI MOVES, and the platform is right to
say so. Measured 2026-09-12.** Seeding gives a lane worktree yesterday's
binaries, faithfully — and a faithful copy of yesterday's binaries is still
yesterday's. After lane G landed `a745f262c`, a full host-suite run in the
lane Y worktree reported **56 failing files against the 35-file baseline**, and
the dominant cause was not a defect:

```
artifact lacks a kandelo.abi.contract stamp — legacy binary predates the
ABI-contract-digest rollout. Rebuild it through the local-build engine.   (x20)
artifact lacks an __abi_version export — legacy binary predates the ABI
marker rollout.                                                            (x7)
```

That is the ABI contract working exactly as `docs/agent-guidance/abi.md`
requires: a stale artifact fails loudly and is rebuilt, rather than being
shimmed. **It is provisioning, not a regression** — and note that the two
worktrees' `local-binaries` were byte-identical (311 tier files, 184 programs,
zero differences), so divergence was ruled out before staleness was blamed.

**Consequence for anyone comparing a lane worktree against the suite baseline:**
run `./run.sh setup` in the lane worktree first, or the comparison measures
artifact age rather than the branch. Comparing against another SEEDED worktree
does not help — it carries the same stale copies.

**Set the cache roots worktree-local in a lane worktree.** Two are
user-settable and both are on `scripts/dev-shell.sh`'s `--keep` list precisely
because stripping them once made the override *silently ineffective*:
`KANDELO_SOURCE_CACHE_ROOT` and `WASM_POSIX_BINARY_CACHE_ROOT`. A third name,
`WASM_POSIX_SOURCE_ONLY_CACHE_ROOT`, appears in `tools/xtask/src/build_deps.rs`
but is **derived by xtask from the cache base and exported to build scripts**,
not set by hand — recorded here so the next reader does not set it and believe
it did something.

## Sequencing decision — 2026-09-12

**PR #1350 sits unmerged. Lanes are worked one at a time until the campaign is
through.** The maintainer's reasoning: nothing is currently broken that needs
the PR.

**Measured, not assumed:** at the time of the decision the branch was **1,133
commits ahead of `main` and 0 behind**, with **0 files touched by both** —
`main` had not moved in the 8 days since the fork. The usual cost of a
long-lived branch is accumulating merge risk, and here there was nothing to
accumulate against.

**The condition on that, which must be re-checked rather than assumed:** the
cost stays near zero only while `main` stays still. The branch changes **825
files**; if anyone starts landing to `main`, that surface becomes the dominant
risk and shipping moves back up the priority list.

A second benefit of not shipping yet: the curation commits do not have to
narrate progress toward a goal the censuses just measured at **160–315
agent-days**. Writing that story now would be the overselling the maintainer
warned against.

### Priority order — cheap × leverage, not cheap alone

1. **T6** — lane **T (test hygiene)** timeout stopgap. One hour. Every lane runs
   the suite and T5 showed it is a coin flip under load.
2. **Lane G (ABI binding drift)** — 3–6 d, and **the highest-leverage cheap
   lane**. Three censuses found the same defect shape — hand-written ABI
   knowledge beside a generator: **L-D2** (scratch pointer table), **W-D1**
   (syscall names), **V-D1** (no errno table). G owns the generator, so doing it
   converts L2, W2 and V7 from work into consumption.
3. **Lane R (binary and artifact resolution)** — 2–4 d, cheapest lane, and its
   defect already cost 39 of 53 `host-native` tests.
4. **The generator's customers, now cheap:** W2 (lane **W**, web-libs session
   contracts), V7+V8 (lane **V**, one implementation of SFFS — V6 proved they do
   not need lane Y), L2 (lane **L**, host↔kernel plumbing).
5. **E2** — lane **E (Node/browser peer divergence)**: unify the 43 duplicated
   protocol message types. Type-level and mechanical, so it cannot change
   runtime behaviour.

**Not taken early despite being cheap:** lane **D (dead Rust floors)** — cheap
but its hazard is deleting something with a caller nobody found, so cheap is not
safe. Lane **X (process and exec)** — "2–5 d blocked on one panic" is cheap only
if the bisect lands. Lane **H (browser + curation)** — deprioritized, and
curation should wait until there is something worth narrating.

**Explicitly last:** lanes **K (kernel-worker.ts god class)**, **F (fork
control-flow inversion)**, **I (host import surface)**, **M (shared mapping,
deferred)** — 80–160 days between them, and nothing about doing them sooner
makes them cheaper.

### Decided: do NOT split `kernel-worker.ts` as a prelude

The question was whether to factor the god class apart first so lanes could be
worked separately. **No**, on measured grounds:

**None of the seven near-term items touches `kernel-worker.ts`.** T6, G, R, W2,
V7, L2 and E2 have **zero references** to it between them. The contention
argument K1 raised applies to *parallel* work; serial work has none by
definition.

Three further reasons:

- **K1 named its own blocker.** 436 of the 522 methods — 17,958 lines — were
  never read. Splitting first means doing the least-understood work first.
- **The only detector is currently a coin flip.** T5 measured an 8.5 s job
  against a 10 s budget, so a refactor with no functional change would be
  validated by a suite that goes red under load anyway. **T6 must precede any
  lane K work in any ordering.**
- **Moving code inside that file shifts V8 parse and compile for unrelated
  functions** (the select A/B). A split would contaminate any performance claim
  made during it.

**The split is the entry cost of the F/I/K tier, not a global prelude**, and it
is paid when those lanes are reached — by which point the 436 methods will have
been read. Their dependence on the file is real and measured: lane **F (fork
control-flow inversion)** has **115** fork references in it, lane **X (process
and exec)** 45, lane **I (host import surface)** 16, **V9** 9.

**A happier reading of the same data:** the cheap lanes are cheap partly
*because* they sit outside the god class. They are leaf and generator work, so
real lanes close without ever entering the hard file.

## Release readiness for #1350 — a known, unclosed gap

Recorded so it is not rediscovered. **`What "done" means for PR #1350` above
states four criteria and measures none of them**, while every lane in this file
carries a gate that fails out loud. That asymmetry exists because the surface
budget was pointed at lanes rather than at the release.

Worse: **the only two lanes exempt from characterization are H and M** — and
lane **H (browser + curation)** *is* the remaining #1350 work. The exemption is
right for the browser half, which the maintainer deprioritized. **It is wrong
for curation**, which the maintainer explicitly required to precede shipping and
to avoid overselling. The most specific instruction given about #1350 currently
shelters under a deprioritization that was about something else.

**This is deliberately not a 21st lane.** Lanes are shaped around a subject that
shrinks; release readiness cuts across all 20, closes once, and has no surface.
The right shape when it is built:

1. **Split lane H** — browser (exemption stands) from curation (full
   characterization, including how "do not oversell" is checked rather than
   hoped).
2. **Make the four release criteria measured** in `host/test/surface-budget.test.ts`.
3. **Add a per-lane "what of this lane is in #1350" fact**, so readiness is
   *derived* from 20 lane facts instead of asserted in prose.

Deferred by the sequencing decision above: with #1350 sitting, this is not on
the critical path. It becomes urgent the moment shipping does.

## Estimates — and the bias they must be read against

**Unit: agent-days.** One agent-day is one focused agent working one day on a
provisioned machine. Wall-clock depends on how many lanes run in parallel and
on machine contention, which has been significant — a package build takes the
machine to load 100 and makes every timing-sensitive check invalid.

**The systematic bias, stated first because it is the most reliable thing here:
every item this campaign has estimated has been larger than filed.** Lane M was
"half done" and was **15%**. Lane X was "retire a parser" and became a kernel
export, a new authority boundary and a trap that is still unexplained. The fork
census was "classify some files" and found a superseded engine. **Treat every
number below as a floor, not a midpoint.** Where a lane's first increment is a
census or a diagnosis, the estimate after it is honestly unknown until that
lands — those are marked.

| lane | estimate | confidence | what dominates it |
|---|---|---|---|
| **F** fork inversion | **12–25 d** | low *(F1 done)* | Revised down after the census, for one reason: the four coarse entries were already built. What dominates is now the 17-entry `fm_capture_*` family — the module owning the capture walk, not just its intern leaves — plus 8 seeding entries. The `ABORT_UNWINDING` discipline still bounds one collapse (it has trapped or hung two attempts), and the `kernel_exit` prerequisite is **now scoped** (census §7) and is small, but it uncovered a correctness defect (F-D2) that has to land with it. |
| **M** shared mapping *(deferred)* | **20–40 d** | low | ~15% done. A production resolver, ~15 exports, the range policy, then 2,776 host lines across ~50 call sites — and `MAP_SHARED` coherence fails silently, so the coverage has to precede the cutover. |
| **I** host imports (V4) | **15–30 d** | low | I1–I2 are 2–3 d. I3 is the rest: moving POSIX filesystem semantics for host-backed mounts into a kernel that already implements them for its own. |
| **V** VFS / one SFFS | **8–16 d** | medium *(V6 done)* | Five of six consumers need only constants; V7–V8 are 1–3 d. V9 — `memory-fs.ts` dropping `SharedFS` — is the remainder and is genuinely large at 8,501 lines. |
| **P** platform honesty | **10–15 d** | medium | Five independent instances. `st_rdev` is ABI-adjacent on the stat wire; the UI trio is smaller but one item is a product decision, not an engineering one. |
| **T** test hygiene | **3–6 d** | medium *(T5 done)* | Neither one defect nor forty: a 10 s budget on an 8.5 s job. All 41 pass at 20 s. The lane is now "why does a fork fixture cost 8.5 s", not "debug 40 tests". |
| **S** setuid integrity | **3–6 d** *(DEFERRED)* | medium | Re-estimated after building the fix and reverting it. The producer half is hours. The consumer half is ~46 lines of logic wherever it lives, and the maintainer deferred it to the Rust filesystem, so it is now **blocked behind V5, which is blocked behind lane Y** — its cost is small but it cannot start. |
| **C** conformance | **4–7 d** | medium | C1 is a runner-contract change; C2 is following through on two XFAIL'd gaps. The 8 remaining failures are all harness. |
| **B** build truthfulness | **4–7 d** | medium | Reconciling the cheap path with the freshness gate is a decision plus a day; stamping the fixtures is the larger half. |
| **X** process and exec | **2–5 d** | medium | Blocked on one panic with a precise bisect. Once found, the repoint is a one-commit reapply. |
| **H** browser + curation | **3–6 d** | medium | The browser pass is short if provisioning holds; curation of ~370 commits into ~14 is a day or two with `commit-tree`. |
| **K** `kernel-worker.ts` | **30–60 d** | low *(K1 done)* | One class holds 29,975 lines across 522 methods. Decomposition, not migration — `host-native` dispatches the same 85 syscalls. The census clarified the shape but found nothing making it smaller. |
| **L** host↔kernel plumbing | **6–12 d** | medium *(L1 done)* | Not 5,853 lines a host must reproduce — `host-native` wrote a layout struct and one helper. The work is unifying duplicated knowledge: one layout, one bounds rule, a generated pointer table. |
| **E** Node/browser peers | **0–0 d** | CLOSED 2026-09-12 | Landed in five increments. 65 → 29 duplicate declarations, the floor E3 derived by reading every candidate. |
| **Y** image builders (V3) | **8–15 d** | medium *(Y1 done)* | Six image-level gaps, one bridge, and a repoint of 36 files that is **half one-line type changes and half V5's production cutover** — not mechanical. The bar is decoded equivalence across the built image corpus, not byte equality; see the lane. **Blocks lane V, and is what gives V5 a production caller.** |
| **U** build automation | **12–25 d** | low *(U1 done)* | Ranked last: none of it is host API surface. But the tier-1 subset (U2+U3) is **3–6 d** and carries nearly all the risk reduction; the census recommends not doing the rest. |
| **W** `web-libs` contracts | **4–8 d** | medium *(W1 done)* | Unchanged in total but redistributed: W2 is hours, and W3 — the kernel serving structured data instead of the UI parsing `/proc` — is most of the lane and is a kernel change. |
| **R** binary resolution | **0–0 d** | CLOSED 2026-09-12 | Landed 2026-09-12 in four increments. One shared constant; the writer and both readers derive from it. |
| **G** ABI binding drift | **0–0 d** | CLOSED 2026-09-12 | All 15 modules anchored, snapshot records all 15. 109 constants, 71 asserts, every batch perturbation-tested. |
| **D** dead Rust floors | **2–5 d** | medium | A checklist, not a surface. Size is known; the risk is deleting something with a caller nobody found. |

**Serial total is not the useful number** — these run in parallel lanes. The
**critical path is K, F and M** — K at 30–60 d is now the largest single lane
in the campaign and has had no census at all, and F and M are 12–40 d apiece at
low confidence. None of the three is in #1350: M is deferred, K is planned
only, and F is at F1 plus the first three reductions (69 -> 63 module entry
points), with the capture family and the seeding descriptor still ahead of it.

**One ordering constraint is now explicit and was not before: lane Y blocks
lane V.** `memoryFsTypeScript` cannot reach 0 while `images/vfs/scripts`
imports `memory-fs.ts`, so any schedule that runs V to completion before Y is
wrong on its face.

**The whole campaign stands at 151–298 agent-days across 20 lanes**, with lane R closed, lane G at 14/15, lane S deferred behind V5, and lane F revised down by 3–5 days after its census found the coarse entries already built. The
nine lanes added on 2026-09-11 were first scoped at 88–177; after their censuses
they are **71–143**, because five of them shrank and none grew. The censuses
cost roughly a day in total. That is the honest scale of what the plan
was previously not counting, and it is a floor like every other number here.

**For PR #1350 specifically**, what remains is **H** (browser plus curation,
3–6 d) and whatever of **T**, **X**, **C** and **B** the maintainer wants
inside it rather than after — a further **5–14 d** if all four go in,
**3–6 d** if only H does. **S is no longer a candidate**: it was deferred to
the Rust filesystem on 2026-09-12 and cannot land before V5.

**What would make these wrong in the optimistic direction**, since that is the
direction they have always been wrong: a census turning up a second
implementation nobody knew about (this has happened twice — the SFFS duplicate
and the superseded fork reference engine); a "floor" turning out to be real
after all; or a defect found while working that has to be fixed before the lane
can continue, which has happened in every lane that has run so far.

## Suite baseline — what "tests pass" is worth, measured 2026-09-12

**The full host suite is at 35 failing files / 69 failing tests** after
`./run.sh setup` rebuilt a coherent `source-only-v1` tier. Before that rebuild
it was 65 files / 50 tests.

**Read those two numbers together or they mislead.** Files fell 65 → 35 because
31 files stopped failing at *collection*; tests rose 50 → 69 because those files
now actually run, and some of their individual tests fail. Fewer broken files,
more visible failures — the suite got more honest, not worse.

**39 of the original 65 failed at collection with one identical cause:**
`Package artifact closure is incomplete: no single provenance tier contains
every accepted artifact, and tiers will not be mixed`. That is the resolver
working correctly — refusing to serve a mixture — against an incoherent
`source-only-v1` tier.

**Provisioning, not lane defects, and confirmed by fixing it.**
`scripts/build-programs.sh` does *not* clear it (measured: identical 65/50
before and after a full program rebuild). `./run.sh setup`, which drives the
local-build engine, cleared **31 files**.

The remaining 35 files carry 69 failures in the classes the plan already names:
`vi.fn()` spawn call-count mismatches, kernel-worker ingress initialisation,
PHP startup warnings, and timing assertions.

### One "new" failure that is measurement noise, not a regression

The post-setup run flagged `test/wasm64.test.ts` as newly failing, with
vitest's generic `STACK_TRACE_ERROR`. **It passes in isolation** — 3 tests,
~8.2–8.7 s each.

That run overlapped with `./run.sh setup` finishing. **H-7 applies to the
campaign's own measurements, not just to performance claims:** a suite number
taken while a package build is saturating the machine is not a clean reading,
and this one was not. The honest statement is that 35/69 is an approximate
baseline taken under unknown load, not a precise figure.

### Why this is recorded as a hazard

**Every "tests pass" claim in this campaign so far has been a narrow-suite
claim.** `host/test/surface-budget.test.ts` at 89 passing, or 296 tests across
11 VFS files, says nothing about the other 390 files. That is not wrong — a
narrow claim for a narrow change is correct practice — but a reader
accumulating those green lines could reasonably infer a green suite, and the
suite is not green.

**Before attributing any failure to a lane, check it against this baseline.**
The 2026-09-12 measurement is: **35 files, 69 tests**, after a coherent tier
rebuild — and taken under load, so treat it as approximate. A lane that lands and leaves those numbers unchanged has introduced
nothing; a lane that moves them has done something, in one direction or the
other.

**What has NOT been established:** the baseline before this session's work. The
suite was recorded at 46 failing files earlier in the campaign, and the
difference between 46 and 65 has not been attributed. The two runs on
2026-09-12 differ only in whether programs had been rebuilt, and produced
**identical** failure sets with **no newly failing files**, which is evidence
against this session's changes being the cause — but it is not the same as
having measured the earlier commit.

## The surface budget counts CODE lines — changed 2026-09-12

**Every line-count ceiling in `docs/surface-budget.json` is now code lines, not
`wc -l`.** Blank lines and comment lines do not count; a line carrying code and
a trailing comment does. Landed on `brandonpayton/lane-s-setuid-integrity` as
`Build: Budget code lines, not comment lines`.

**Why, in the maintainer's words:** *"All we care about is code lines not
comment lines."* The old measure put the budget in direct conflict with
`CLAUDE.md`, which says documentation is part of the platform contract: a
change that explained itself cost the same budget as one that did not, so the
cheapest way past a ceiling was to explain less. The budget exists to measure
how much host behaviour a second host would have to reproduce, and nobody
reimplementing `memory-fs.ts` in Rust has to reproduce its doc comments.

**This is not a relaxation, and the difference matters to every lane.** Each
ceiling was rebaselined to the code-line count of its file exactly as it stood,
so the ratchet holds at the same point in the new unit. `slack` and `target`
were scaled by each surface's own comment ratio, so neither the banking
threshold nor the campaign's goal moves in real terms — the non-zero targets
are **unit conversions** of the figures lanes F, K and L derived, not
re-derivations of them.

| surface | was (`wc -l`) | now (code) | target was → now |
|---|---|---|---|
| `forkTypeScript` | 24,726 | 19,804 | 2,500 → 2,000 |
| `workerMainTypeScript` | 7,499 | 5,958 | 3,000 → 2,400 |
| `sffsTypeScript` | 3,716 | 3,047 | 0 → 0 |
| `memoryFsTypeScript` | 8,501 | 7,473 | 0 → 0 |
| `kernelWorkerTypeScript` | 32,718 | 26,495 | 12,000 → 9,700 |
| `kernelHostImportTypeScript` | 4,774 | 3,822 | 2,650 → 2,100 |
| `hostKernelPlumbingTypeScript` | 5,853 | 4,734 | 3,600 → 2,900 |

**Prose figures elsewhere in this file are still `wc -l`** — "8,501 in
`memory-fs.ts`", "12,253 lines", "29,975 lines across 522 methods" — because
they describe file sizes, which have not changed. Only the *budget* changed
unit. Do not compare one against the other.

**The counter is not a regex, and that was necessary.** A naive scanner reading
`const s = "/*";` opens a block comment that never closes and silently stops
counting the rest of the file — a measurement failure shaped exactly like a
reduction. It tracks strings, refuses to return a count for text ending inside
a block comment (silent across all of `host/src`), and ends a string at end of
line: carrying a template literal across lines instead dropped 25 lines of real
code, the expressions inside `${...}` interpolations.

**Perturbed seven ways, each run and each failing (H-2):** string awareness
removed (kills the string test, *via* the unterminated-block guard firing —
the exact catastrophic mode); blank lines counted (11 tests, `forkTypeScript`
reads 24,764); line comments counted (8 tests, `kernelWorkerTypeScript` reads
28,696); block comments counted (10 tests, and the unterminated-block guard
goes quiet); the unterminated-block guard removed; the template reset reverted
(the interpolation test, 4 against 5); and any ceiling lowered by 1, which the
ratchet catches.

## Open decisions — blocked on a judgement, not on effort

**This category came back on 2026-09-12.** The 2026-09-11 restructure replaced
it with "Authorised but NOT YET BUILT" and "Resolved", which between them cover
decisions already made. A decision that is neither made nor resolved then had
nowhere to live, and lane Y immediately produced one. The heading is not
decoration: an open decision filed under "authorised" reads as permission.

**1. Lane Y — the builder's filesystem substrate. DECIDED 2026-09-12: reuse
Phase 5's filesystems.** Left here rather than moved, because the question was
asked in a wrong shape first and the correction is the useful part.

**What the question got wrong.** It offered "give `SffsWriter` read-back and
`unlink`" as a candidate. **That option is withdrawn: `SffsWriter` is
append-only for a load-bearing reason.** Its own header states it —
`lamp.vfs` is 249 MiB and "the kernel cannot hold an image in linear memory",
so the writer never materializes file content; a data block carrying file bytes
is recorded as a *reference* into a `ContentSource` and resolved only when
`SffsImage::read_at` reaches it. It is a streaming one-pass layout emitter, and
that shape is what lets W-3's streaming emission layer on top without
redesigning the layout pass. Making it mutable fights the reason it exists.
**`SffsWriter` is the serializer, not the working tree.**

**What the question missed: the substrate already exists, and is dormant.**
Nothing in Rust mutates an SFFS image in place — `sffs.rs` has no write path at
all. The kernel's model is an immutable SFFS base plus a mutable overlay, and
**Phase 5 already built both halves**:

* `crates/runtime-core/src/tmpfs.rs` (1,724 lines) — mutable, empty-start.
* `crates/runtime-core/src/rootfs.rs` (5,813 lines) — "in-kernel overlay for
  the image-backed root filesystem `/`": immutable base layer, mutable overlay
  with copy-on-write on first write, whiteouts, POSIX unlink-while-open. Its
  header still says directory mutation "lands in Increment 2b-ii"; **the header
  is stale.** Verified present: `unlink`, `rmdir`, `mkdir`, `chmod`, `chown`,
  `rename`, `symlink`, `link`, `utimensat`, `truncate`, `write`, `statfs`,
  `readdir`.

**CORRECTION 2026-09-12, before any code was written.** The decision was
presented with the mapping "`MemoryFileSystem.create` (fresh tree) → `tmpfs.rs`;
`MemoryFileSystem.fromImage` → `rootfs.rs`". **The `tmpfs.rs` half was wrong.**

`tmpfs.rs` is not a general filesystem. It is the SCRATCH-MOUNT filesystem,
with its mount table compiled in: `SCRATCH_MOUNTS` lists seven prefixes
(`/tmp`, `/var/tmp`, `/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`),
and `owns_path` is a prefix predicate over exactly those. A builder writing
`/usr/bin/ls` is simply not a path it serves.

**`rootfs.rs` serves both modes**, and the checks that matter are:

* it owns any absolute path — `owns_path(b"/usr/bin/ls")`, `owns_path(b"/")`
  and `owns_path(b"/etc/passwd")` are all true, asserted by its own tests;
* it needs no image — `root: None` at construction, created on first use, and
  `image: Option<ImageGeometry>` is `None` until one is loaded. A fresh tree is
  the empty-base case of the same overlay;
* mutations do not gate on path ownership. `owns_path` appears at exactly one
  internal site, `statfs`, which is read-only. So a `RootfsState` driven
  directly can create `/tmp` and `/srv` — **which it must**, because all seven
  tmpfs-owned prefixes are present in the shipped shell image, measured with
  `xtask vfs-image describe`.

**Consequences:** the substrate is `rootfs.rs` alone, `tmpfs.rs` is untouched by
lane Y, and the refactor is **64 sites rather than 93**. The `statfs` gate is
the one op a builder cannot reuse as-is — it returns a placeholder
`RAMFS_MAGIC` "reconciled at cutover", so the census's geometry-derived
`statfs` is still owed.

**The decision, and what it costs.** Lane Y's bridge sits on those two.
No fourth filesystem is written — the campaign's stated defect is that SFFS
exists twice, and a builder-only filesystem would make it four. The bonus is
that **lane Y becomes Phase 5's first production caller**: 7,537 lines of
mutable-filesystem Rust currently ship behind `TMPFS_ENABLED` / `ROOTFS_ENABLED`
defaulting to false, which is hazard H-1's shape at scale.

The costs are real and accepted: both are `static` singletons, so they need an
instance handle before one process can hold two filesystems — and a derived
build holds two, a base and a target. And lane Y is now coupled to the Phase 5
cutover's timing.

**2. Lane F — the `forkModuleEntryPoints` ceiling. DECIDED 2026-09-12: split
it per population.** Implemented on the lane branch as
`forkModuleHostDriveEntries` (24, target 5 — lane F's closure condition
moved here), `forkModuleInjectorHelpers` (3, envelope 15) and
`forkModuleEntriesWithoutProductionCaller` (27, target 0). Implementing it
corrected the figures below: they counted MENTIONS, and a doc comment
naming an entry read as a caller. The measure now strips comments while
keeping string literals, since host-native binds its drive surface by name
inside one. Left here rather than moved, because the reasoning is what the
next person needs.

The measure counts `pub extern "C" fn fm_*` in `crates/fork-module/src/lib.rs`.
Definitions, not calls. Its own `why` field says it counts **host-called**
entries only; the regex cannot see callers, so it cannot enforce that.

**Decomposed by who actually calls the 54, measured 2026-09-12:**

| | count |
|---|---|
| called by a host (`crates/host-native` or `host/src`) | **27** |
| called only by the injector's own shims | **4** |
| called by neither | **23** |

The entry's purpose is "how many fine-grained calls force the host-side driver
loops that make the TypeScript grow". Against that purpose only the 27 count.
The four injector-only entries — `fm_drive_bump`, `fm_capture_claim_gc`,
`fm_gc_identity_find`, `fm_gc_identity_claim` — grow the host contract by
**zero**; they are spelled as wasm exports only because the injector resolves
its helpers by name.

**This corrects an earlier framing in this same entry.** It previously said the
ten remaining shim-backed imports were "+11 against a ceiling of 54", and put
the host-called figure at 52. Both were wrong. Those eleven would all be the
FOURTH kind — internal helpers a shim calls because the shim is the only thing
that can hold a reference and Rust is the only thing that can hold a map. They
add **nothing** to the 27. There is no real collision here: an
internal-implementation counter was being read as though it were the host API
contract.

**What is actually open** is therefore narrower: should
`forkModuleEntryPoints` keep conflating three unlike populations? The lane's
recommendation is to split it so each is ratcheted on its own — host-called
entries (the campaign's actual target), injector-only helpers, and the
uncalled. The injector's set is enumerable from
`crates/fork-module-inject/src/main.rs`, the same file
`forkGuestImportsUnserved` already reads.

**The finding that deserves more attention than the ceiling: 23 of 54 have no
caller anywhere** — not host-native, not `host/src`, not the injector. That is
H-1 at more than twice the scale previously flagged (recorded as "11
`fm_capture_*` exports with no production caller"). Not all of it is dead:
`fm_frame_{reserve,commit,peek,next}` and `fm_resume_peek` call the IDENTICAL
`*_impl` functions as their `__wpk_fork_frame_*` counterparts, differing only
in taking an explicit activation id where the guest export uses
`primary_activation()` — a multi-activation variant nothing has wired up yet.
**Which of the 23 are pending versus dead is NOT established.** That is a
census, and it should happen before anyone sets a new ceiling, because the
number a ceiling should hold depends on the answer.

**3. Lane F — the table-mutation journal has no defined format. OPEN, raised
2026-09-12.**

`__wpk_fork_module_state_table_mutation_commit(owner, start, count)` carries no
values, yet `reconcile()` must bring pthread table replicas coherent. The ABI
defines no journal format, so the five `module_state_table_*` imports cannot be
served without one being chosen. This blocks the mutation group specifically;
it is independent of decision 2.

## Authorised but NOT YET BUILT — do not lose these

**1. Lane G — the `itimerval` guard. AUTHORISED 2026-09-12, not written.**

The question I put to the maintainer was wrong. I described `itimerval` as a
"deviation from musl". **It is not a deviation.**
`libc/musl/src/signal/setitimer.c` is upstream musl, unmodified:

```c
if (sizeof(time_t) > sizeof(long)) {
    long old32[4];
    int r = __syscall(SYS_setitimer, which, ((long[]){is, ius, vs, vus}), old32);
}
return syscall(SYS_setitimer, which, new, old);
```

That is musl's standard time32/time64 compatibility path for **any** platform
whose `time_t` is wider than its `long`. wasm32 has 4-byte `long` and 8-byte
`time_t`, so musl sends `long[4]`; wasm64 has both at 8 and sends its native
struct. Kandelo's kernel accepts exactly what upstream musl sends — the Linux
`SYS_setitimer` ABI for 32-bit-`long` platforms. The layout module documents
**musl's** behaviour, not a Kandelo choice, and "historical" refers to the
Linux syscall's own time32 heritage.

**So neither "guard at the translation site" nor "exempt" was the right
framing.** The honest guard is an ordinary assert:
`ITIMERVAL_WASM32_SIZE == 4 * sizeof(long)`, with the `*_INDEX` constants as
the `long[4]` positions. 16 = 4x4 on wasm32 and 32 = 4x8 on wasm64 are both
consistent with that. **Lane G reaches 0 and closes.**

## Resolved, recorded so the earlier claims are not believed

**2. Lane L — L-D2 is REFUTED. My L1 census was wrong.**

L1 filed L-D2 as "the scratch pointer table is hand-maintained and nothing
checks it". **Something does.**
`host/test/kernel-scratch-contract.test.ts` parses `crates/kernel/src/wasm_api.rs`,
extracts each export's pointer positions, and compares them against the
TypeScript table, failing on disagreement. It additionally enforces that a raw
pointer parameter carries the `_ptr` suffix and that every pointer is followed
by an explicit length or capacity.

That also explains why my naive type-only extraction saw 40 of 52: the real
contract recognises `_ptr`-suffixed `usize`/`u32` parameters as pointers. The
convention **is** enforced — by that test.

**L2 therefore needs no maintainer decision and no new authority**, and the
three options I presented were answering a question that did not exist.

**A real defect remains, and it is a different one.** Two of that file's eight
tests fail, and they are not the pointer-role assertions: `publishes only gated
exports and package-private raw authority` (4 items) and `admits only reviewed
kernel-memory views, writes, and allocator calls` (12 items). Those are
allowlist assertions about unreviewed kernel-memory access. Already on the
filed-defects list; **not** L-D2.

**3. Lane G — G7. DONE**, and the relaxation was smaller than the question
implied: `classify_additive_object_by_key` already existed and served
`marshalled_structs`, `syscall_arg_descriptors` and `vfs_metadata`.
`process_native_layouts` was simply falling through to the catch-all.

## Standing hazards — these are not lane-specific

- **H-1 — a dead floor reads as complete.** Rust that has never executed, with
  green tests and careful doc comments, is *harder* to remove than an
  undocumented orphan: the docs and tests are what make it look finished. Six
  found this week. **Every lane's acceptance evidence must include a caller
  census for anything it adds.**
- **H-2 — a guard that cannot fail is not a guard.** Mutate every new guard
  until it fails and report what it said. One was found *silently skipped*
  because its anchor matched three places, which reads identically to being
  killed.
- **H-3 — native tests cannot see wasm-only breakage.** Three defects landed
  this week that `cargo test` could not observe: a `cfg`-gated deletion, a
  tree-shaken side-effect import, and a kernel trap whose native twin passes.
  Build for `wasm32-unknown-unknown` in the loop, not at the end.
- **H-4 — read the first line of a failure, never the tally.** Twice in one day
  a tally matched the hypothesis under investigation and was something else.
- **H-5 — a check that answers a different question.** `git branch -r
  --contains` on a pre-cherry-pick SHA can only answer "no". Compare content or
  subjects, not identifiers.
- **H-6 — repetition is a power calculation, not a quantity.** Twelve runs
  cannot distinguish a 0% failure rate from 5%. State the rate your sample
  excludes, or your "N repetitions" is a ritual.
- **H-7 — measure on a quiet machine and say the load.** One performance number
  has already been withdrawn; a real 3.5 µs regression read as zero for a day.
- **H-9 — a rebuilt wasm module is not the module your tests load.** The
  resolver serves `local-binaries/source-only-v1/`, the provenance tier, ahead
  of the `local-binaries/` copy `crates/*/build-wasm.sh` stages. So a side
  module can be rebuilt, its own harness can pass against the new bytes, and the
  Vitest suites can still be exercising the **previous** module — silently, with
  no staleness error, because the resolver is doing exactly its job. Lane F hit
  this: two commits' fork suites went green against a module that predated the
  change, and only a *deleted* export made it visible (the stale artifact had a
  superset of exports, so nothing failed until a newly *added* one was missing).
  **`./run.sh local-build` re-projects the tier; run it after a side-module
  rebuild and before believing any suite.** The scope document called this "the
  `build-wasm.sh` footgun" in a parenthesis; it belongs here, because the failure
  mode is a green suite.
- **H-14 — a test can pass because its FIXTURE could not express the condition
  under test.** Measured 2026-09-13. A test asserted that an extracted archive
  member never comes out setuid, built its fixture by asking the `zip` crate for
  mode `0o104755`, and passed. It passed because that crate masks
  `unix_permissions` to `0o777` on write: the archive carried `0o755`, the
  condition never existed, and the assertion was true for a reason that had
  nothing to do with the code.

  **A mutation found it.** Removing the `& 0o777` narrowing left every test
  green. Against a real archive — a zip's external attributes hold a full mode
  word, and one crafted outside that crate can carry `0o4755`, which `chmod`
  honours — the mutant produces a setuid file. The fix was to test the narrowing
  where it is reachable, against the function that performs it, and to say in a
  comment why that unit test is NOT duplicative of the end-to-end one, so nobody
  removes it as redundant with a test that structurally cannot reach the case.

  **Distinct from H-5 and H-13, and the difference is where the lie lives.** In
  H-5 the check asks a different question; in H-13 it asks a weaker one. Here
  the CHECK is right and the INPUT is wrong — quietly rewritten by a library
  between the test's intent and the code under test. No amount of reading the
  assertion reveals it.

  **For every lane: when a test builds a fixture through a library, confirm the
  library preserved the property being tested.** A fixture is an input, and an
  input a helper may normalise is an input that may no longer be the case you
  meant. The cheap check is to assert the fixture itself before asserting the
  behaviour.

- **H-13 — a checker can answer a weaker question than its name implies, and
  the weaker answer looks exactly like the strong one.** Measured 2026-09-12.
  `xtask vfs-image roundtrip` reads "does this image survive a round trip"; what
  it actually does is load the image and compare the export's DECODED
  DESCRIPTION against the loaded tree. That proves the decoder understands what
  the export writes. It does not prove **the kernel can load back what the
  kernel wrote** — and those came apart: every image with no deferred files was
  refused by `load_image` as a stale artifact (gap 15), through a tool whose
  whole job was round-tripping, reporting EQUIVALENT on the corpus the entire
  time.

  The tell was available and unread: the verb never fed its own output back in.
  A round-trip checker that does not re-enter its output at the same door it
  entered the first time is checking a transform, not a round trip.

  **Distinct from H-5** (a check that answers a different question): there the
  check is about the wrong subject; here it is about the right subject at the
  wrong strength, which is harder to see because the name, the subject and the
  output are all correct. **For every lane: for any checker phrased as "X
  survives Y", write down which door the output re-enters, and if it re-enters
  none, say what the check actually covers in its own help text.**

- **H-12 — a perturbation trial stops anchoring when the code it quotes moves,
  and nothing notices.** A trial names the code it mutates by quoting it, so any
  edit to that code can leave the quote matching nothing — and a trial that
  matches nothing does not report a weaker result, it stops the whole spec at
  that point. Rot is invisible between runs, because a spec is only exercised
  when someone runs it and a full run costs minutes.

  **Seven trials across two specs had rotted before anyone looked**, measured
  2026-09-12: five when SDEF's archive table gained a payload, two when a
  reverted refactor moved `chmod`/`symlink` back to where they had started. One
  of the two specs had therefore been proving nothing since the revert.

  `xtask perturb --validate` walks every spec and reports which trials no longer
  anchor, without mutating or building anything — milliseconds against minutes,
  so it can be run after any change. The validator and the applier share one
  `anchor_of`, so the cheap check cannot disagree with the expensive one about
  what "anchors" means.

  **For every lane: run it after touching code any spec quotes.** A green
  perturbation run on a rotted spec is the same false comfort as a suite that
  skips — and "0 survived" from a spec whose trials no longer apply is a number
  that looks like information and is not.

- **H-11 — a mutant can be detected by HANGING, and an unbounded harness waits
  forever.** Measured 2026-09-12: a trial making the image export ignore its
  offset and always restart left a test's drain loop with no end condition. The
  test span growing a buffer, `xtask perturb` waited on it for **eighteen
  minutes** and would have waited indefinitely, and the run's remaining trials
  never started.

  Two things made it hard to see. Spec commands end in `>/dev/null 2>&1` so a
  green run stays quiet — the same redirection swallows whatever a hung command
  is saying about itself. And killing the wrapper shell is not enough: when this
  was diagnosed by hand, the shell's `cargo` and the test binary under it were
  still running and still allocating after the shell was gone.

  **Fixed on both sides**, because either alone leaves half the defect. The
  harness bounds every command and kills the whole PROCESS GROUP on timeout; a
  verifier that does not answer is a kill, reported separately as "detected by
  HANGING rather than failing" and **failing the run**, because a test that
  hangs costs the whole run's wall clock and says nothing about what broke.
  And the tests terminate on their own: the drain loops are bounded far above
  any image they build, so the bound can only be hit by non-termination.

  The same mutation went from eighteen minutes to **failing in 7 seconds**.

  **What this means for every lane:** "0 survived" is only trustworthy if the
  run FINISHED. A perturbation run that is still going is not a weaker result
  than a green one, it is no result — and before this fix it could be neither
  for an unbounded time.

- **H-10 — `npx vitest` from the repo root does NOT run the repo's vitest.**
  There is no root `node_modules/vitest`, so npx fetches an unpinned version
  from the registry: measured 2026-09-12, the root form ran **5.0.0** while
  `cd host && npx vitest` ran the project's pinned **4.1.11**. Both worktrees
  carry 4.1.11 in `host/node_modules`.

  This is the same shape as `dev-shell.sh` stripping `RUSTFLAGS` (recorded in
  `crates/sffs-module/build-wasm.sh`): a command that looks like it uses
  project state and quietly does not. It produced no wrong answer here — lane Y
  ran surface-budget checks both ways and both reported 79 passing — but a
  version-dependent difference would have been invisible, and "the gate passes"
  would have been a claim about a harness the repo does not pin.

  **Run suite checks as `cd host && npx vitest …`.** The root form reaches past
  the repository's own dependency and over the network.

- **H-9 — a mutation that survives is usually a missing test, and occasionally
  a property the technique cannot reach. Say which.** Lane Y ran ~40 mutation
  trials through `xtask perturb` and found three genuine categories of
  survivor: undefined behaviour that produces no observable wrong value; an
  unreachable branch defending a CONTRACT rather than an input; and a mutation
  behaviourally identical under the calling convention (JavaScript coerces `-1`
  to a wasm `u32` as `0xffff_ffff` on its own, so an explicit mapping is
  provably redundant). **Each was documented beside the code rather than
  encoded as an always-red trial**, because a permanently failing gate teaches
  people to ignore the gate, and deleting the trial loses the knowledge. The
  committed specs in `perturb/` therefore contain only trials that must be
  killed, and a green run is the contract.

  **The same run repeatedly found the TEST wrong rather than the code** — five
  times in one lane: a symlink's mode asserted nowhere, ceiling expectations
  derived from the function under test, an artifact walk whose fixtures were
  all at the tree root, an ABI claim about a "loud" boundary that was
  unreachable by construction, and a base-file export believed to fail that
  silently succeeds. A green suite said nothing about any of them.

- **H-8 — low coupling is not evidence of migratability, and may be evidence of
  the opposite.** The 2026-09-11 survey screened `host/src` for references to
  `WebAssembly.`, `SharedArrayBuffer`/`Atomics.` and `postMessage`, and read the
  near-zero scores of `dylink-planner.ts` and `wasm-artifact-driver.ts` as
  "migration candidates". **Both are the opposite: deliberately built floors
  left behind by migrations that already succeeded.** `host/src/dylink.ts` —
  4,188 lines — was deleted and replaced by 14,543 lines of Rust in
  `crates/dylink`; the low score is what success looks like, because the
  decisions left and only the engine acts stayed. Two files also score low
  because their coupling runs through what they *import*
  (`binary-resolver.ts` → `memory-fs.ts`), and `web-libs` scores low because
  its browser coupling is product concepts rather than API calls. **A coupling
  score selects files to open. It never classifies one.** Open the file, read
  its header, and check for an existing Rust crate before calling anything a
  lane.

---

# LANE F — fork control flow: invert it, do not port it

**Status: IN PROGRESS in `/Users/brandon/kandelo-lane-f`. F1 (census) landed
2026-09-12, with F0-residual and part of F2. Still the largest lane by line
count, and the one the campaign most lost track of — §"What the census
corrected" below replaces three statements this section used to make.**

## End state

The fork module drives each sub-sequence itself. The host calls **3–5 coarse
entries** — `fm_parent_seal_capture`, `fm_parent_replay`,
`fm_child_reconstruct`, `fm_abort` (the middle two may collapse into one
dispatched entry, giving 3) — and does nothing between them except the floor
below. **0–1 new host imports.**

**F1 answered the 71-vs-95 question and neither number was the surface.** The
module declares **69** `fm_*` exports (**63** after this lane's first three
commits); the host asserts 76 names at instantiation; 65 of the 69 had a caller.
The "95" counted TypeScript *tokens*, 38 of which resolve to no export at all —
they are tombstone comments documenting their own deletion. The surface has been
shrinking, and was reported as growing twice. Full reconciliation, with the
command that reproduces each figure, is
`docs/plans/2026-09-12-lane-f-census.md` §1 (in the lane worktree).

## Why porting made it worse, measured

Fork TypeScript across the campaign: **23,246 → 26,113 lines** in the dedicated
files, plus **6,083 → 7,536** in `worker-main.ts`. Against a contract that says
this "shrinks toward the floor over time; it does not grow."

The mechanism is not carelessness. **Every fine-grained `fm_*` call leaves a
host-side seeding and base-arithmetic loop behind by construction.** One commit
that "moved the gate into `fm_attach_child`" was **+73/−69 in `worker-main.ts`
— net +4**. Porting a function moves an algorithm and leaves its driver.
Inversion removes the driver. **This is why the lane is inversion and not
migration, and it is the single most important sentence in this section.**

One correction to the growth figure: `process-lifecycle.ts` is **not** part of
it. It did not exist at the merge-base; it was created by de-duplicating the two
kernel-worker entries, which fell 8,477 → 3,206. Across those three files the
campaign is **−454**.

## The floor — what must not move, with the reason it cannot

Taken from `2026-09-08-fork-controlflow-inversion-scope.md` §2, which derived
each from a Wasm capability limit rather than from convention:

| Floor item | Why it cannot move into the module |
|---|---|
| Child worker spawn + COW instantiate | No Wasm capability creates a Worker or an instance, **and the fork spans two workers** — the child reconstruct runs in a different instance, so no single module call can span parent and child. |
| The real `fork()`/`vfork()` syscall + channel | Process-creation authority over the shared channel; the child worker is spawned by the host in response. |
| Guest top-level entry + fork-unwind catch + phase re-enter loop | The entry can end via a **tagged `WebAssembly.Exception`** *or* a `kernel_exit` **`unreachable` trap**, and the two must be discriminated. Wasm-EH `catch` catches the tagged throw but **cannot catch the trap**. Only the JS boundary sees a `RuntimeError`. |
| `resolve_externref(handle) -> externref` | A Wasm module cannot hold a live `externref` in Rust or mint one from a handle. The proven floor seam. |
| Anyref-transit `Table.grow` sizing | Rust/LLVM does not emit `table.grow` for the host-owned transit table; the host must grow before the drive. |
| PIC placement globals | Host-chosen at instantiation; the module cannot place itself. |
| Ref-typed catalogs and the resume table | Host-built from live funcref/anyref values; the module only ever sees resolved i32/i64 coordinates. |
| Node/browser worker-message bridge | Host transport. |

**Candidate ninth item, not yet in the contract:** Wasm has no funcref equality
instruction, so `ForkFunctionCatalog.encode` may be as irreducible as
`resolve_externref`. **Decide this explicitly** — if it is floor, add it to
`CLAUDE.md`'s floor list, because an unnamed floor item is one a future agent
must re-derive, and re-derivation is how this lane regrew.

## The floor audit — several claimed floors are not floors

`2026-09-08-fork-controlflow-inversion-scope.md` §2 lists eight floor items.
Audited against what Wasm can actually express, **three are genuine capability
limits, one is a real limit the list does not name, and four are something
else.** This matters because a false floor is a permanent excuse: nobody
re-examines a line that says "Wasm cannot do this".

**Genuine capability limits — keep:**

- **Worker spawn and instantiate.** No Wasm API creates a worker or an
  instance. Note the *primitive* is floor; the *decision* of when and what
  could still move, with the host as executor.
- **PIC placement globals.** The module cannot place itself before it exists.
- **Worker-message bridge.** Host transport with no Wasm equivalent.

**A real limit the list omits, and should name:** Wasm has **no funcref
equality instruction** — `ref.eq` operates on `eqref`, not `funcref`. So
mapping a live funcref to an ordinal (`ForkFunctionCatalog.encode`) genuinely
cannot happen inside the module. The §2 catalogs row justifies the host-built
*table* and names externref provenance, but not the funcref value→ordinal
direction, whose reason is different and stronger. **An unnamed floor item is
one a future agent must re-derive, and re-derivation is how this surface
regrew.**

**Not floors:**

- **The guest entry and unwind-catch loop — this one is self-inflicted, and it
  is the linchpin.** The claim is that discriminating "ended via tagged throw"
  from "ended via trap" needs JS, because Wasm-EH catches exceptions and not
  traps. The second half is true. But the trap exists because **we chose it**:
  `worker-main.ts` carries `// Normal exit via kernel_exit -> unreachable
  trap`. The fork-unwind tag is a real `WebAssembly.Tag` and is importable. If
  `kernel_exit` threw a tagged exception instead of trapping, both paths become
  catchable inside Wasm and the floor dissolves. §3 says this item *"bounds the
  inversion: the module owns everything AFTER the catch and BEFORE the next
  entry, never the entry/catch itself."* **The bound is ours, not Wasm's.**
- **`resolve_externref` is overstated.** Wasm *can* hold an externref — it is a
  value type and `(table externref)` is shipped everywhere. What cannot express
  it is **Rust/LLVM**, a toolchain limit, and this module already uses
  hand-written shims. The true floor is "**the host must insert into the
  table**", not "the host owns the identity cache and materializes per lookup"
  — which converts a per-lookup crossing into a bulk seed.
- **Anyref-transit `Table.grow` sizing** — same shape. `table.grow` is a real
  instruction; Rust will not emit it for an imported table, a wat shim will.
- **The `fork()` syscall** — §2 itself says it *could* be an import the module
  calls, and declines on entanglement grounds. That is a judgement, not a
  limit, and should be labelled as one.

Two further candidates are unnamed in §2 and need a ruling:
`fork-module-trampoline.ts` (per-activation `WebAssembly.Module` minting), and
`fork-replay-gate.ts` — **the latter is challengeable**, since Wasm has
`memory.atomic.wait`.

## Why the target is ~2,500 and deletion cannot reach it

Deleting everything callerless is worth roughly 1,400 lines, which is what F0
delivered. The order of magnitude is elsewhere.

**TRANSPORT is ~7,000 lines, and that is the anomaly.** Marshalling for a
module contract should be thin. It is seven thousand because there are ~69
fine-grained `fm_*` entry points, each needing argument marshalling, buffer
alloc/read/free and error decoding on the TypeScript side — **multiplied by
per-type variants** (`..._externref` / `..._funcref`). Collapse 69 entries to 4
and transport collapses with them. **That is the mechanism, and it is why
inversion is not a tidier migration but the only thing that touches transport
at all.**

**And the FLOOR figure is suspect.** ~3,700 lines were classified floor, but
the floor is eight primitives: spawn a worker, send a syscall, catch an
exception, resolve a handle, grow a table, pass placement globals, build a
ref-typed table, post a message. That is hundreds of lines of work. A number
that large says the classification is generous — floor-adjacent orchestration
wearing floor clothes. The sharpest evidence: **`fork-module-state.ts` is 3,825
lines and its Rust twin `module_state_records.rs` is 483 lines that have never
executed.** One TypeScript file is larger than the entire claimed floor, and
its replacement already exists.

**A correction to this file's own earlier figure:** the `fm_*` surface is
**69 Rust-declared plus one injected**, down from 71 — it has been *shrinking*.
The "95" reported earlier counted TypeScript tokens including 13 tombstone
comments that document their own deletion. The direction was reported backwards.

## What the census corrected — read this before planning the rest

F1 landed as `docs/plans/2026-09-12-lane-f-census.md` (lane worktree). Three
statements this section used to make are wrong, and two new defects are filed.

**1. F3 is substantially landed, not future work.** This section lists "the four
coarse entries" as work to do. **Thirteen coarse entries already exist and are
the production path**: `fm_parent_begin_capture`, `fm_parent_seal_capture`,
`fm_parent_abort_seal`, `fm_parent_replay`, `fm_parent_abort`,
`fm_parent_finish`, `fm_child_seed`, `fm_child_seed_borrowed`,
`fm_child_reconstruct`, `fm_attach_child`, `fm_restore_from_arena`, `fm_abort`.
The fine-grained drivers they replaced — `fm_begin_unwind`, `fm_finish_unwind`,
`fm_serialize_journal_alloc`, `fm_begin_replay`, `fm_begin_abort`,
`fm_finish_replay`, `fm_finish_abort`, `fm_begin_child_replay` and their
siblings — are **gone from the module**, and their host driving loops went with
them.

**2. The remaining count is not remaining host sequencing.** Of the 69: 7 are
called by the *guest* (the host only binds them at the
`WPK_FORK_REFERENCE_IMPORT_*` names — collapsing them is a guest-ABI change and
a re-instrument, so **do not**), 5 are the frozen ABI-44 frame contract, 8 are
once-per-worker seeding, 2 are diagnostics. The genuinely un-inverted cluster is
the **17-entry `fm_capture_*` family**, and that is where the rest of the
reduction is.

**3. F-D1 — there are two hosts and their surfaces diverge.** `crates/host-native`
drives the same module over wasmtime and uses **33** entries to TypeScript's
**60**. TypeScript calls the coarse `fm_restore_from_arena`; native still calls
the two fine-grained entries it folds (`fm_begin_reference_replay`,
`fm_build_gc_plan`). Neither can be deleted while native drives them, so **the
un-inverted host pins two entries of the inverted host's surface in place.**
`forkModuleEntryPoints` counts Rust declarations, so it cannot see this. **Any
further collapse must land on both hosts in the same commit**, or the surface
does not fall, it forks. (The capture asymmetry is NOT this defect: native's
capture bodies call `fork_codec` in-process because native is one address space,
which is a real capability boundary.)

**4. F-D2 — `kernel_exit` does not trap, and a guest crash can read as a clean
exit.** This is the prerequisite the estimates table calls unscoped, and scoping
it found a correctness defect. `kernel_exit` is a **JavaScript host import** that
throws `new WebAssembly.RuntimeError("unreachable")` (`worker-main.ts:543`) —
no Wasm `unreachable` executes anywhere. The host separates an orderly exit from
a genuine guest trap with a **regex over the error message** plus a side-channel
variable (`isWasmUnreachableTrap(e) && kernelExitStatus !== null`, six sites). A
guest that really traps after a status was recorded is reported as a clean exit
with that status. `host-native` does not even share the convention — it returns
`Err("kernel_exit(N)")`, which the TypeScript predicate would not match.

**The change itself is small**, and is scoped in census §7: mint a process-exit
`WebAssembly.Tag` the way `fork-unwind-transport.ts` already mints the
fork-unwind tag, throw a tagged `Exception` carrying the status, convert the six
sites, delete the `onKernelExit` side channel, mirror it in `guest.rs`. **No
`ABI_VERSION` bump and no guest re-instrument** provided the tag stays
host-internal or becomes a fork-module import; it is guest ABI only if the guest
imports it, which the design does not require. **Expect it to surface guest
crashes that read as exits today — that is the fix working, not a regression.**
It buys the inversion the entry/catch half of its floor; it does **not** buy the
two-worker span, which is a genuine capability limit.

**5. One collapse was declined, with the argument, rather than skipped.**
`fm_parent_seal_capture` / `fm_parent_abort_seal` look like a per-type pair and
are not collapsed. Two names make the `ABORT_UNWINDING` discipline
**structural**: the abort entry contains no guest drive, so a host cannot drive
`wpk_fork_unwind_end` mid-unwind by mistake. One discriminated entry converts
that into a runtime bit whose failure mode is silent guest-state corruption —
the exact landmine that trapped or hung two prior attempts. **Minus one entry is
not worth that trade.** If the maintainer disagrees it is a one-commit collapse.

## Increments

- **F0 — delete what has no caller. ~4,400 lines, free.** `fork-reference-recipes.ts`
  (1,316 lines of which *two type declarations* are live), a 555-line dead
  encoder in `fork-reference-segments.ts`, a 270-line data feed in
  `fork-early-reference-provider.ts` made unreachable by the `fm_ref_*` import
  flip, and — maintainer-authorised — the generic owner-import registration path
  (~170) plus the ~850-line typed-signature mailbox layer that exists only to
  serve it. **No dependencies. Start here.**
- **F1 — reconcile 71 vs 95** and publish the categorized surface. **DONE
  2026-09-12** — `docs/plans/2026-09-12-lane-f-census.md`, commit `4a7f02a3d`.
- **F0-r — delete what no host calls.** **DONE**, commit `2839b1810`:
  `fm_add_activation_child_replay` and
  `fm_add_activation_borrowed_child_replay`, both superseded by the coarse
  `fm_child_seed` pair, both carrying doc comments claiming callers ("the module
  unit tests + host-native") that do not exist — H-1 exactly. 69 -> 67.
- **F2 — collapse per-type `fm_*` variants** into kind-discriminated entries,
  the same move that took `host_blob_read` + `host_fetch_archive` to one
  `host_fetch_deferred`. **PARTLY DONE:**
  - `fm_attach_borrowed_child` folded into `fm_attach_child` — their Rust bodies
    were identical character for character. 67 -> 66, commit `4e7e7e867`.
  - `fm_capture_intern_{funcref,externref,i31,static_root}` folded into one
    kind-discriminated `fm_capture_intern(kind, a, b)`. 66 -> 63.
  - **Remaining:** `fm_parent_abort` into `fm_parent_replay(abort)` (safe — the
    flag already exists inside `parent_replay_impl`, both paths drive the guest,
    and `finish_transaction_impl`'s `in_abort` pairing assert makes a mismatched
    flag a loud `EINVAL`; `fm_parent_finish(abort: u32)` is the shipped
    precedent). `fm_child_seed` / `fm_child_seed_borrowed` needs a 16-vs-24-byte
    side-record unification and is a wire change, not a signature change.
  - **NOT** `fm_parent_seal_capture` / `fm_parent_abort_seal` — see §5 above.
- **F3 — the coarse entries.** **Substantially landed already** (13 of them, see
  §1 above). What is left of F3 is the `fm_capture_*` family: the module owning
  the capture WALK, not just the intern leaves, and one seeding descriptor in
  place of the 8 `fm_set_*`. That is the bulk of the 15-30 day estimate.
- **F4 — delete the host-side drivers each coarse entry replaces.** *A coarse
  entry that does not delete its driver has not landed.* Largely done alongside
  F3; the census records which drivers went.
- **F5 (new) — `kernel_exit` as a tagged exception.** Scoped in census §7,
  not built. Closes F-D2 and dissolves the entry/catch half of the floor. See
  the open decision below: it may belong to lane P, not here.
- **F6 (new) — the inversion, worked from the guest's import list.** The lane
  was re-scoped 2026-09-12: set the fork TypeScript aside
  (`attic/fork-typescript-do-not-use/`, which is **not** a specification) and
  implement everything in the module, serving the guest's own imports. The
  measure is `forkGuestImportsUnserved` — canonical fork imports the module
  does not export under the same name — now **18 of 46**, with
  `forkGuestObjectImportsUnserved` at 3 of 5.

  **Landed on `brandonpayton/lane-f-fork-inversion`** (worktree
  `/Users/brandon/kandelo-lane-f`):

  * GC-reference identity. The module imports one new host function,
    `env.__wpk_fork_host_ref_identity(anyref) -> i32`, taking module imports
    9 -> 10 — maintainer-approved, and the only host-contract growth in the
    lane so far. `gc_lookup`/`gc_claim` moved off an O(n) scan onto it.
    **Why a host import at all:** `ref.eq` validates only on `eqref`, there is
    no `ref.hash`, and no cast rescues a host reference into the eq hierarchy,
    so deciding whether two references are the same object is the one question
    Wasm cannot answer for itself. Proven by hand-encoded modules on V8 with a
    passing `eqref` control — an earlier wat2wasm attempt had a control that
    also failed, and was discarded.
  * `__wpk_fork_ref_exn_define` served. The one `define` in the family needing
    nothing but guest linear memory, because the exception codec stages scalars
    and payload recipe ids into a single scratch span before the call. 19 -> 18.
  * The unguarded `fm_capture_*_vector` twin **deleted** — no production caller,
    and it would intern a SHORT vector where the guest-facing trio refuses to.
    `forkModuleEntryPoints` 55 -> 54, banked.
  * **A capture-correctness defect fixed in `ReferenceGraphBuilder::define_gc`.**
    It removed the pending-placeholder marker on ENTRY, then ran four checks
    that can each reject. `claim_gc` publishes the id early by pushing a
    ZEROED `Struct`, so a rejected define left that empty struct behind with
    nothing marking it: `validate()` sealed clean and **the child rebuilt an
    empty object where the parent had a populated one**, with no error on the
    path. This reached the long-standing `fm_capture_define_gc` GC path too.

  **Blocked on open decisions 2 and 3 above.** Every one of the remaining 18
  imports needs one of them. The breakdown in `docs/surface-budget.json` is
  grounded — read at each emission site in `crates/fork-instrument`, not
  inferred from signatures — and records which need a shim, which must THROW
  (the emitter puts `unreachable` after the call, so returning normally is a
  bug), and that `encode_funcref` is the one remaining import that grows the
  host contract, because funcref is not a subtype of anyref and the approved
  identity import cannot serve it.

## Acceptance evidence

- **Per commit: the production TypeScript delta.** A migration commit that is
  net-positive in TypeScript needs an explicit justification in its body or it
  is not finished. This is the lane's headline number.
- Host import count measured **from the built artifact**, expected unchanged at
  72 + `env.memory` — this lane is import-neutral, and anyone claiming
  otherwise should measure.
- For F0: a transitive caller census per deletion. A direct grep produced 13
  false alarms in one afternoon because most call sites reach their target
  indirectly. **Census both hosts** — `host/src` *and*
  `crates/host-native/src/guest.rs` — or F-D1 will make a deletion look safe
  that is not.
- `wasm32-unknown-unknown` build in the loop (H-3). `crates/fork-module/build-wasm.sh --run`
  does wasm32 **and** wasm64 plus both V8 harnesses in about 25 seconds, so
  there is no excuse for batching it to the end.
- **Re-project the tier before believing a Vitest result (H-9).** `build-wasm.sh`
  stages into `local-binaries/`, but the resolver serves
  `local-binaries/source-only-v1/`. Two of this lane's commits went green
  against the previous module before that was noticed.

## Known hazards

- **The `ABORT_UNWINDING` discipline.** `fm_parent_seal_capture` must not drive
  the guest's `wpk_fork_unwind_end` when a reserve failed mid-unwind — it
  corrupts the state machine. **Two naive attempts trapped or hung.** Inherit
  the discipline; do not rediscover it.
- **Two resume-slot numberings run concurrently.** `replay_journal.rs:15` says
  "validated-but-unused. TypeScript still drives every fork" — **stale**. The
  module uses `ReplayEventJournal` and `ResumeSlotTable` while the JS
  `ForkResumeTable` is live, and divergence means `call_indirect` reaches the
  wrong thunk: **silent corruption, not a loud error.** Verify, then either
  finish the cutover or guard the two numberings.
- `module_state_records.rs` is **483 dead Rust lines whose live twin is 3,860
  TypeScript lines**. The fork TS growing and the fork Rust never running are
  plausibly one phenomenon.
- **A collapsed entry can delete a guarantee, not just a wrapper.** Two of this
  lane's per-type pairs were safe to fold because one had an identical body and
  the other already carried the flag internally behind a pairing assert that
  fails loud. The seal pair is not, because its two names are what make the
  `ABORT_UNWINDING` discipline unrepresentable-in-error. **Before folding a
  pair, ask what the second name was preventing.**
- **Deleting an export leaves comments behind, and they become the next
  miscount.** The "95 `fm_*` entry points" this section used to assert was 38
  tombstone comments plus real exports. Every deletion in this lane must sweep
  the comments that name it, or the surface becomes unmeasurable again by the
  same mechanism.

---

# LANE V — the VFS image, and the filesystem we implement twice

**Status: V1–V4 landed. V4 was DECIDED AND CLOSED 2026-09-12 — an image the
Rust export writes is now one the kernel can load back, which is what the lane
existed to make possible. V6, V7, V8 done and V-D1 closed. Remaining: V5's
producer side, then V9 (after lane Y) and V10. The 12,000-line finding below is NOT yet
characterized and must not be dispatched until it is.**

## End state

The kernel writes the image body. The host supplies only what it has authority
over — which, after V5, is nothing inside the body at all. `entries[]` and the
lazy JSON sections are gone. **One implementation of SFFS, in Rust.**

## What has landed

- **V1** — the kernel serves image-backed bytes from the image. Import floor
  75 → 74 on its own; composed to 73 with an independent deletion.
- **V2** — a Rust SFFS writer, 2,103 lines, pinned to the TypeScript one by
  four byte-level cross-language fixtures.
- **V3** — streamed emission. `export_image_read(offset, out, source)` is
  offset-addressable and never buffers content; a 2 MiB deferred file
  materialises exactly two blocks.
- **V5 (in progress)** — deferred-file metadata moves **into the body** as an
  SDEF section addressed by a hidden inode, named from one superblock `u32`,
  costing zero bytes when absent. Parser is total, bounded and canonical.

## Why V5 exists and why xattrs lost

The maintainer asked why the metadata lived in JSON rather than the filesystem
format. The answer dissolved a boundary this plan had overstated: `klzy.rs`
governs **who decides** a URL may be fetched, not **who stores** the string, and
the format already stores symlink targets without that conferring authority over
what they resolve to.

**Extended attributes were disqualified, not merely costed:** they are
guest-visible by definition, so a guest could `setxattr` the URL its own files
are fetched from — an authority leak *created by the storage choice*. With
`sudo` and `sudo-lite` shipping setuid-root (below), that is not theoretical.
No follow-up item: if something calls for xattrs later it gets considered fresh.

## The finding that is not yet a lane

**SFFS exists twice.** `sffs_write.rs`'s own doc says it "reproduce[s]
`host/src/vfs/sharedfs-vendor.ts`" — same superblock geometry, same allocators,
same magic. **The TypeScript half is 12,253 lines: 3,752 in
`sharedfs-vendor.ts` and 8,501 in `memory-fs.ts`. V4's stated deliverable
deletes 318 of them.** The Rust writer is already live via
`kernel_rootfs_export_tree`.

`memory-fs.ts` is the larger half and was the one no register named. It is not
a helper: `MemoryFileSystem` backs `/` on every machine, and it implements
`stat`, `statfs`, `pathconf`, dirents, open flags and `ST_NOSUID` setuid
handling in TypeScript, against 1,724 lines of `tmpfs.rs` in the kernel. A
second host reimplements all of it. Both halves are now budgeted
(`sffsTypeScript`, `memoryFsTypeScript`) and both are in lane V's closure, so
the lane can no longer reach green with the larger half still standing.

**The increments below are still not characterized to the standard this file
requires** — V6's census is what turns them from direction into steps, and it
is also what decides whether any of `memory-fs.ts` is genuine floor. Until that
census runs, the 0 target on `memoryFsTypeScript` restates this lane's end
state rather than reporting a measured floor. This lane is plausibly larger
than the fork lane.

## The floor — what stays in TypeScript

**Two things, and neither is the filesystem.** The host must *fetch* deferred
bytes, because the network lives there — CORS, CSP, a service worker, or no
network at all are host facts the kernel cannot know. And the host must read
bytes from host-backed mounts (Node `fs`, OPFS), because those filesystems are
its own.

**Neither requires a filesystem implementation.** `sharedfs-vendor.ts` is not
the floor; it is a second implementation of a format the kernel owns.

## V4 — the identity contract. DECIDED AND PARTLY LANDED 2026-09-12.

**Worked in the lane-Y worktree** (`/Users/brandon/kandelo-lane-y`, branch
`brandonpayton/lane-y-image-writer`) at the maintainer's direction, because the
two lanes meet exactly here: lane Y holds the failing tests that define done.

**The decision, and the argument for it.** A deferred file in an exported image
has to say where its bytes are. SDEF — the in-body section built to be an
image's one description of its deferred files — carried strictly LESS than the
section it replaces: `klzy` records which lazy archive backs a file and which
member within it; SDEF recorded only inode, real size and an opaque payload. A
section that cannot say *archive 7, member `usr/bin/php`* cannot replace KLZY,
and the image keeps two descriptions — the exact defect SDEF exists to kill.

So the payload question the handoff posed (`docs/plans/2026-09-12-v4-identity-contract-handoff.md`)
is answered **neither** by sharing KLZY's producer format **nor** by inventing a
fresh payload encoding. It is answered by moving the line:

> **A field is first-class when the kernel ACTS on it, and payload when the
> kernel only CARRIES it.**

The kernel acts on the archive id and the member path — it needs both to fetch
the right archive and extract the right member — exactly as it acts on the
inode and the size. So SDEF v2 carries them as typed, checked fields. The fetch
URL, transport, integrity digest, activation mode and atomic-group seal stay in
the payload and are still never inspected. **Burying the linkage in the payload
would not have preserved the courier property, it would have destroyed it**,
because the kernel would then have had to parse the payload to fetch anything.

The linkage is all-or-nothing in both directions, refused by the encoder, by
the decoder independently (an image can arrive from a shared link), and by
`create_deferred_file` at the call.

**`VERSION` 1 → 2**, and not for a deployed artifact: nothing has ever emitted
this section outside its own tests, no fixture carries it, and `SDEF` appears
zero times in `abi/snapshot.json` — **so this is not an ABI snapshot change and
needs no `dump-abi`.** The bump makes a kernel built before the change reject
the section instead of misreading it, and the misreading is demonstrated rather
than asserted: the test builds one byte string that is valid under both layouts
and means different things under each.

**Landed on the lane branch, in order:**

* **The record shape** (`0ee47010d`, "SDEF carries the archive linkage, so it
  can replace KLZY") — SDEF v2, eleven perturbation trials all killing,
  `xtask vfs-image describe` now genuinely carrier-blind. Mutation testing
  found four of the tests written for it wrong before the claim was made.
* **The archive-member export arm** (`af6bf8207`, "The export describes archive
  members instead of emptying them") — `build_export_image` now calls
  `create_deferred_file` with the linkage it already held, so a 99,999-byte
  member exports as a stub plus a record carrying its real size, archive and
  member path instead of as an empty file. Four further trials, 0 survived.
  **This is the arm that blocked publishing ANY image**, fresh or derived.

  Lane Y's test that pinned the damage was inverted rather than deleted, so a
  regression reads as "the damage is back".

  **The two trials held out in `perturb/deferred-until-v4.json` were re-run and
  BOTH STILL SURVIVE — correctly.** They are about the export's byte SOURCE,
  and a deferred member is described rather than read, so this arm never
  reaches it. Do not read "V4 is landing" as "the held-out trials should now
  kill": they become killable at item 2 below, and the spec says so.

* **The host-backed base arm** (`88a56b838`, "The loader keeps a deferred
  file's description, so an export can re-emit it") — `load_image_inner` reads
  the image's own deferred section alongside KLZY and keeps each payload
  verbatim ON THE INODE, so it dies with the inode rather than letting a reused
  index hand a stale fetch descriptor to the next file allocated there. The
  export re-emits it under the number it assigns. Ten trials, 0 survived.

  **Reconstruction was never available for this arm**, which is why it needed a
  different shape from the first: the kernel has no URL, and the only other
  identity is the source image's inode number, which the export renumbers.

  **An empty description does not become a deferred record.** A base tree the
  host walked (`load_manifest`) carries no deferred description — its bytes are
  ordinary host files — so it still exports as a stub, left visible as a file
  this export cannot serialize rather than dressed up as a deferred file
  pointing nowhere. `ExportNode` states the two cases as separate variants.

**Still open in V4:**

1. ~~The archive-member arm.~~ **DONE**, above.
2. ~~The `BaseSource::Host` arm.~~ **DONE**, above — with one limit worth
   stating: an image that carries NO SDEF section still loses its URL-backed
   files on export, because there is nothing to retain from one. That closes
   when the producers emit SDEF, which is V5.
* **The SDEF archive table** (`914f14c37`, "SDEF declares the archives its
  records point into") — prerequisite for item 3 that this plan had not named:
  a record saying *archive 7, member `usr/bin/php`* is useless without archive
  7's LENGTH, because materialising one member means fetching the archive and
  the kernel bounds that read. KLZY has an archive table; SDEF had none, so it
  could not replace it. SDEF v3 declares every archive it references and
  refuses a dangling reference in encoder and decoder independently.

  **It drops `mount_prefix`, which KLZY carries — measured, not assumed.** The
  only thing in the tree that touches that field is a test fixture BUILDING a
  KLZY section; the kernel never reads it.

  **The bridge gained no entry point.** An archive's length goes in through
  `sm_register_lazy_file` alongside the member rather than through a nineteenth
  export, because a member is useless without it and the campaign's goal is to
  shrink what a new host must implement. Host surface still 18.

  Mutation testing found five tests wrong, **three of them regressions this
  change caused**: two poked record fields at `HEADER_SIZE + offset` and the
  archive table moved where records begin, so they passed while corrupting the
  table instead. Recorded because it is the recurring shape — a format change
  silently repoints every test that hardcodes an offset, and they keep passing.

3. ~~`load_image_inner` accepts SDEF in KLZY's place.~~ **DONE** —
   `4d0395357`, "An image the kernel exports is one the kernel can load".

   **The refusal was not weakened.** The loader refused an image with no
   description of its deferred files for a good reason, and that reason still
   holds exactly; what changed is that SDEF is now ALSO a description, so
   "declares no KLZY" and "describes its deferred files nowhere" stopped being
   the same statement. An image with neither is still refused, proven by
   loading the same body with an empty KLZY attached.

   An image carrying both is read from **KLZY**. Nothing emits both, but the
   rule is tested against a deliberately disagreeing pair, because "whichever
   we read first" is how two descriptions of one thing start diverging — and
   preferring the older one means this cannot alter how any existing image
   loads.

   `ContainerSections::kernel_lazy` became an `Option`. It was deliberately not
   one and the module said why; that justification is now obsolete and the doc
   records the change rather than quietly dropping it.

**V4 IS CLOSED.** The headline test is
`an_image_the_kernel_exported_is_one_the_kernel_can_load` — the one thing none
of the increments could assert alone, because each closed a hole and any one
still open breaks it.

**Gap 9, found while doing this: there is no Rust KLZY encoder.** `klzy.rs`
decodes only. **RESOLVED WITHOUT WRITING ONE** — item 3 made SDEF the linkage
source instead, so no encoder is needed for a format the campaign is retiring.

**Gap 10 — an archive's own fetch descriptor has nowhere to live in a
Rust-written image. Found 2026-09-12 while wiring the container export.**

A deferred FILE record carries an opaque payload — its URL, transport, digest.
A deferred ARCHIVE declaration carries only `archive_id -> bytes`. And the Rust
container export emits `archive_json: None`, because the archive JSON is
host-side producer metadata the kernel has no business assembling.

So an image the Rust path writes today declares its archives' LENGTHS and
nothing else about them. **That silently drops the one integrity property lane
S measured as universally present**: "Every lazy archive group in all nine
production images carries a digest ... not one of their 7,467 members is
set-ID." Lane S's defect is about URL-backed single files precisely BECAUSE the
archive path already had digests. A Rust-written image would lose them.

**Not a live regression** — no production builder goes through the Rust export
yet — which is exactly why it is recorded now rather than after Y5 repoints
them. **It must be closed before Y5**, or the cutover trades a measured
integrity property for a format improvement and nobody notices until something
is fetched.

**HALF CLOSED, 2026-09-12** — `10b744a2a`, "An archive's fetch description has
somewhere to live". SDEF v4 gives each archive declaration an opaque payload,
carried through load and export exactly as a deferred file's is, and it reaches
the kernel through `sm_register_lazy_file` alongside the archive's length (no
new entry point; host surface still 19).

**The half deliberately left open is lane S's.** Giving the declaration a
payload is a format capability and lane V's to decide. Whether a producer MUST
supply a digest is policy, and the maintainer deferred that. So an archive with
an empty descriptor is a representable state and a test says so: **the
capability exists, the requirement does not.** Lane S can now make the
requirement without first inventing somewhere to put the answer — which was the
thing its deferral handoff said it lacked.

**Y5 is no longer blocked by this.** A builder repointed onto the Rust writer
can carry its archives' digests through.

**One thing for lane S to know:** an image described by `KLZY` yields an EMPTY
descriptor, because KLZY has no field for one. So a derived build whose base
came from a KLZY image cannot re-emit what it never received. That is honest
rather than invented, and it is another reason the producer side (V5/Y5) has to
land before any mandatory-digest rule would be satisfiable.

**Gap 11 — the VFSI container header is hand-carried into TypeScript.** Found
2026-09-12 while testing the container export. `VFSI_CONTAINER_MAGIC`,
`VFSI_CONTAINER_VERSION`, `VFSI_HEADER_SIZE` and the flag words are Rust
constants that `host/src/generated/abi.ts` does not carry, so a TypeScript
reader of a `.vfs` container spells them by hand. **Same class as L-D2 (the
scratch pointer table), W-D1 (syscall names) and V-D1 (the errno table)** — ABI
knowledge reaching TypeScript by hand while a generator exists for its
neighbours. Recorded rather than fixed because fixing it means regenerating the
ABI, which no lane in this campaign may do concurrently.

Cost of leaving it: the bridge's own test asserted the magic reads `"VFSI"` and
it reads `"ISFV"` — the magic is a little-endian `u32`, so it lands
byte-reversed. That was caught by running the test, which is luck rather than a
gate.

**Gap 12 — a production build script imports a test helper.** Found the same
way. `images/vfs/scripts/generate-coreutils-man.ts` imports
`runCentralizedProgram` from `host/test/centralized-test-helper`. It is why the
new `images/tsconfig.typecheck.json` pulls `host/test/` into its graph and
inherits four errors the host's own gate deliberately excludes — which is the
concrete reason the images gate cannot simply require zero. Small, and it is
the kind of coupling that becomes load-bearing if left.

### V4 measured on a real image: 309 of 374 entries survive, and 25.1 MiB does not

**2026-09-12, `xtask vfs-image roundtrip`.** V4's round trip had only been
tested against trees built inside a unit test — a handful of files, one archive,
nothing at scale. Run against the shipped 16 MB rootfs instead:

| | result |
|---|---|
| entries | 374 loaded, **309 round-trip identically** |
| hard-link grouping | **preserved exactly** (compared as sets of paths, since an export renumbers) |
| deferred files | **65 in, 0 out** — and the 65 differing entries are the SAME SET as the 65 deferred, not merely the same count |
| content those 65 describe | **25,277,328 bytes — 25.1 MiB** |
| among them | **`/usr/bin/sudo`**, `/usr/bin/bash`, `/usr/bin/coreutils` |

**This is the limit already recorded, not a new defect.** A `KLZY`-described
image carries no payloads to retain, so the export has nothing to re-emit and
the files come back as zero-byte ordinary files. What changed is that it is now
a number on production data instead of a note — and the number names the file
lane S's defect is about.

**It also sharpens why V5/Y5 matters.** The producer cutover is not tidiness: it
is what stops 25 MiB of a 16 MB image going missing through a path the kernel
already supports on both ends. Until the producers emit `SDEF`, the Rust export
is correct only for images it produced itself.

**Two corrections the run forced on the comparison, both worth keeping:**

* **Inode NUMBERS are not part of equivalence.** Comparing them reported all 374
  entries as differing — measuring the renumbering rather than the tree, and
  renumbering is exactly why a deferred file's identity cannot ride on an inode
  across a rewrite. An equivalence bar that flags every entry is H-5 in its
  purest form: it answers a different question and looks thorough doing it.
* The export's byte source must serve image-backed content. Refusing it is not a
  stricter test; it fails at the first content byte.

## What is left in lane V

* **V5 — the producer side.** The format is done; the TypeScript writers must
  emit SDEF and the JSON sections must retire. This closes the one limit V4
  left: an image carrying no SDEF still loses its URL-backed files on export,
  because there is nothing to retain from one.
* **V9 — `memory-fs.ts` stops using `SharedFS`.** After lane Y, per the
  maintainer. The lane's only genuine unknown.
* **V10 — delete `sharedfs-vendor.ts`**, at which point `sffsTypeScript`
  reaches 0.

V6, V7, V8 and V-D1 are done or closed.

## Increments

- **V6 — census the six consumers. DONE** —
  `docs/plans/2026-09-11-lane-v6-census.md`. **Five of the six import only
  errno/mode constants and `SFSError`; exactly one imports `SharedFS`, and it is
  `memory-fs.ts`** — the file this lane already deletes. The census that was
  going to decide "weeks or days" answers days for five of six.
- **V7 — add a generated `ERRNO` table** (V-D1 below), then repoint the five
  constant-only consumers at `generated/abi.ts`. Open flags and mode bits are
  **already** generated (`OPEN_FLAGS`, `FILE_MODES`); only errno is missing.
  **This removes five of six imports without touching a filesystem.**
- **V8 — `SFSError` gets a home** outside the implementation being deleted.
- **V9 — the real work: `memory-fs.ts` stops using `SharedFS`.** The lane's
  only genuine unknown.
- **V10 — delete `sharedfs-vendor.ts`.** The lane closes here.

**Ordering the census made visible: lane Y blocks deleting `memory-fs.ts`, but
it does NOT block deleting `sharedfs-vendor.ts`.** V7–V10 can run in parallel
with lane Y.

**V-D1 — CLOSED. Verified 2026-09-12: `host/src/generated/abi.ts` exports an
`ERRNO` table.** The census recorded there was none and that adding one to
`dump_abi.rs` would unblock V7; it exists, so V7 needed no ABI regeneration.
**V7 and V8 are also done** — only `memory-fs.ts` still imports
`sharedfs-vendor.ts` from `host/src/`, the other five consumers are repointed,
and `SFSError` has a home in `host/src/vfs/vfs-errors.ts`. That leaves V9
(after lane Y, per the maintainer) and V10 as this lane's TypeScript-side work,
and V4 as the part that can move now.

**Already-present drift:** `memory-fs.ts` imports `OPEN_FLAGS` from
`generated/abi` at line 20 **and** `O_CREAT` from `sharedfs-vendor` at line 31,
then aliases `OPEN_FLAGS.O_CREAT` at line 501. Two sources for one constant in
one file.

## Acceptance evidence

`sffsTypeScript` reaches **0** in the budget. Nothing short of deletion counts:
a TypeScript filesystem that is merely unused is the dead-floor pattern (H-1)
with 3,752 lines in it.

Per increment: the four byte-level cross-language fixtures keep passing
unmodified, and the mutation campaign is re-run reporting which fixture kills
which mutation — `sffs-slots` and `sffs-tail` exist to reach paths that
mutation proved were otherwise dead, and they reach them by construction.

## Known hazards

- **V4 would silently destroy every lazy file** if routed through
  `export_image_read` without the identity contract: 65 files in the base
  image, 79 in a derived one, each surviving as a zero-byte regular file with
  no URL. Measured, not reasoned — both images were built.

  **REPRODUCED 2026-09-12, from lane Y, with a second failure mode the hazard
  did not name.** Lane Y's builder module drove `export_image_read` the way a
  builder would and hit this exactly. Two distinct cases, one cause:

  * a **base** file (inherited from a loaded image) exports as a zero-length
    regular file with no deferred record — the hazard as written;
  * a **registered lazy member** exports as an EMPTY FILE too.
    `build_export_image` maps `InodeKind::LazyMember` to
    `ExportNode::LazyStub` and writes `create_file(.., Content::Bytes(b""))`.
    Deferred records are emitted only for entries created through
    `create_deferred_file`, which the export never calls, so no SDEF section is
    produced at all.

  **The second case matters more than the first**, because it is not
  derived-build-only. Fresh builds REGISTER lazy files — the shipped shell
  image carries 7,546 deferred entries — so `export_image_read` cannot publish
  any production image, not merely a derived one.

  **The fix is local and the machinery exists:** where the export stubs a
  `LazyMember`, call `create_deferred_file`, which already pushes the record
  `emit_deferred_section` writes. Lane Y has tests pinning both failures
  (`crates/sffs-module/src/lib.rs`), so V4 has a measured definition of done
  rather than a hazard to reason about.

  **Ownership: LANE V. Decided by the maintainer, 2026-09-12.** Lane Y supplies
  the tests and stays blocked until it lands. The two trials that will prove it
  finished are held out of lane Y's green contract in
  `perturb/deferred-until-v4.json` — they cannot be killed while the export
  stubs deferred content, and become killable the moment the identity contract
  makes the byte source reachable.
- **The existing `KLZY`-versus-JSON gate cannot catch it**, because it compares
  the image's two *descriptions* of itself against each other; both can agree
  perfectly and both disagree with the body. Under V5 that gate becomes
  **unrepresentable by construction**, which is the best possible outcome for it
  and must be recorded as retirement rather than removal.
- **Build the gate before the contract.** A gate written after the thing it
  checks gets shaped to pass; one of this lane's own tests demonstrated that
  within a single commit by perturbing two axes at once.
- **Fixture regeneration can silently lose coverage.** `sffs-slots` and
  `sffs-tail` exist to reach two paths that mutation proved were entirely dead,
  and they reach them by construction. Any change that moves bytes must re-run
  the full mutation campaign and report which fixture kills which mutation —
  not "the fixtures still pass".

---

# LANE S — setuid lazy references are fetched without integrity

**Status: DEFERRED by the maintainer 2026-09-12, handoff written at
`docs/plans/2026-09-12-lane-s-deferral-handoff.md`. Nothing landed. The defect
is unfixed and still real.**

**The decision:** *"I only want the problem fixed for the new Rust-based FS
which is not completed yet."* The fix was built and worked, and it was ~46 code
lines in `host/src/vfs/memory-fs.ts` — the TypeScript filesystem lane V exists
to delete, budgeted at `memoryFsTypeScript` with a target of 0. Hardening a
file scheduled for deletion buys the property for as long as that file lives
and buys a second implementation to throw away. **This is a scheduling call,
not a downgrade of the defect.**

**Read the handoff before touching this lane.** It carries the measured
corpus, the design that was built and reverted, and two findings this section
does not repeat — including that **the lane's own gate can be driven to 0
without verifying anything**, so "close lane S" is currently reachable by
editing the emitter alone.

**The archive path is measured and clean.** Every lazy archive group in all
nine production images carries a digest, and **not one of their 7,467 members
is set-ID** — so the defect is confined to URL-backed deferred files and there
is no second instance of it hiding behind `assertLazyIntegrity`'s early return
for absent integrity. That early return is still a latent shape the Rust
filesystem should close by requiring the digest rather than accepting its
absence, which costs nothing today because every producer already supplies one.

## The defect, fully verified

`images/rootfs/PACKAGES.toml` sets `default_install = "lazy"`. Three packages
are `mode = "4755", uid = 0` — setuid root. `login` opts out with
`install = "eager"`; **`sudo` and `sudo-lite` do not.**
`scripts/generate-rootfs-package-manifest.mjs` resolves install as
`pkg.install ?? defaultInstall ?? config.default_install ?? "lazy"` and its lazy
branch emits `<path> f <mode> <uid> <gid> lazy_url=… lazy_size=…` — **mode
preserved, URL and size the only attributes, no digest anywhere.**

`LazyFileEntry` carries no integrity field. The lazy *archive* types do.

So two setuid-root binaries are fetched at runtime by URL with **length as the
only check**. Bytes of the same length from a substituting host, a poisoned
cache or a network position execute as root inside the guest. HTTPS is
transport security, not artifact integrity, and a third-party host is under no
obligation to use it.

## Measured 2026-09-12, against all nine production images

**9 of 9 restore; 0 refused** — lane C's lazy-identity property, preserved by a
fix that demotes rather than refuses. Seven of the nine carry deferred files
(65 in the base image, 79 in each derived one) and **not one of the 619 carries
a digest**. The set-ID ones are the same two everywhere: `/usr/bin/sudo` and
`/usr/bin/sudo-lite`, both `4755`. Two images carry no deferred files at all.

**The blast radius of any fix is exactly those two paths.** That is smaller
than the lane's framing implied and is worth knowing before scheduling it.

## The floor

The host performs the fetch — the network is its own. **Verification is not
the host's**: a kernel that trusts returned bytes cannot detect a substituting
host, and "a new host might not take precautions" is exactly the threat model
V4 creates by making new hosts cheap to write.

## End state

Deferred bytes are verified against a digest recorded with the reference, and
the setuid bit is not honoured on unverified bytes.

## Increments, as they stand after the deferral

- **S1 — producer half. Built, reverted, NOT landed.** The emitter records
  `lazy_sha256=`, the mkrootfs grammar carries it. This half is
  host-independent and survives into the Rust world unchanged, so it lands
  *with* the Rust consumer rather than before it — landing it alone drives the
  gate to 0 while nothing checks the digest, which is H-2 exactly.
- **S2 — the whole fix, in Rust.** Verification and set-ID demotion belong to
  the new filesystem. **Blocked on a production caller for SDEF**, verified
  rather than assumed:
  - the kernel already *receives* the bytes —
    `host_fetch_deferred(kind, id, offset, dest)` serves a URL-backed deferred
    file by inode, so the seam exists;
  - it cannot learn the expected digest, because `KLZY` deliberately excludes
    integrity (`crates/runtime-core/src/klzy.rs` says so outright) and adding
    it means changing `VFS_IMAGE_KERNEL_LAZY_*` in `crates/shared` — ABI
    surface, snapshot regeneration — **for a section V5 retires anyway**;
  - `crates/runtime-core/src/sffs_deferred.rs` is the intended home and already
    names *"integrity digest"* as part of the opaque payload it carries. **It
    has no production caller.** Giving it one is V5, which lane Y gates.

  **So lane S resumes behind V5, which resumes behind lane Y.**

## Acceptance evidence

`setuidLazyWithoutDigest` reaches **0**, plus a test that a *tampered* byte
stream of the correct length is refused. The second half matters: a digest
that is recorded and never checked is a guard that cannot fail (H-2), and
length already passes today.

**And the gate itself has to move.** As written it greps the emitter for
`lazy_sha256=`, which measures emission rather than verification — see the
handoff. A lane cannot be closed by a measurement its fix does not have to
satisfy.

## Known hazards

- **Verify where the bytes land, not where they are requested.** A digest
  checked before the transport returns proves nothing about what arrived.
- **`EAGAIN` must not be the refusal.** The kernel parks and retries on it, so
  a file failing verification would hang its reader forever instead of failing.
  `EIO` is the platform's settled answer for deferred bytes that will never
  arrive.

**Forbidding setuid + deferred is not available** — production depends on the
combination.

---

# LANE M — shared-mapping cutover: DEFERRED

**Status: deferred by the maintainer, handoff written, dead floor removed.**

Not cancelled. If more of it is wanted in #1350, it arrives as a **separate PR
targeting #1350's branch**, landing there before #1350 merges.

The full handoff is `docs/plans/2026-09-11-lane-a-state-of-the-lane.md` and is
**not** superseded by this file — it is the lane's characterization, written by
the agent that did the diagnosis, and a future owner should read it whole.

**What shipped and stays:** handle retention and its three consult sites, the
`statx` two-bug fix with a round-trip guard over `u64::MAX`, `file_identity_key`
with the aligned `ino == 0` refusal, the live-process seeding fix, and the
`unlinkat` regression fix with its transitive census of all 40 path-taking
syscalls.

**What was removed on deferral, and why it matters:** `track_file_mapping`,
`track_fd_writeback_mapping` and `backing_key_for_fd_facts` — 368 lines with no
caller. They were well-tested and carefully documented, **which is what made
them dangerous rather than harmless** (H-1). Shipping them would have added a
dead floor in the lane opened to delete dead floors.

**The item is ~15% done, not half.** `shared_mapping_policy.rs` is 1,108 lines
with zero production callers; `SharedMappingResolver`'s only impl is its own
test double; the per-syscall range policy was never ported. Anyone resuming
should take the handoff's A1–A5 decomposition and its **nine** coverage gaps,
resolver/identity agreement first.

**Two findings to carry:** the writable-upgrade path of
`get_or_create_file_backing` was reached by **zero of 2,037 tests** — a
`panic!` at its head failed nothing — and the host and kernel device-number
spaces are disjoint **by accident of two independently chosen constants**,
neither documenting the other, with ~1.93 billion pairs of margin.

---

# LANE X — process and exec

**Status: partly characterized. B10's direction is settled; its blocker is not.**

## End state

The kernel decides what a spawn would run — script or binary, and which
interpreter — and `parseShebang` no longer exists in the host. `posix_spawn`
and `execve` give the same answer for the same file, which they do not today.

## The floor

The host still launches the worker and carries the syscall channel; that is
lane F's floor and is shared, not duplicated. **Nothing about interpreting an
executable's format is host work** — the kernel already owns `execve`.

## Where shebang belongs — settled

`#!` is a **kernel** feature on Linux, the BSDs and macOS: `execve(2)` itself
substitutes the interpreter. **POSIX does not specify `#!` at all**; what it
requires is that the libc `execlp`/`execvp` family fall back to `sh` when
`execve` returns `[ENOEXEC]`.

So a libc-only implementation is not a simplification, it is a divergence:
`#!` scripts would fail under direct `execve` and work only through a shell or
a `p`-variant. `make`, `dinit` and anything using `posix_spawn` would break.
**The kernel is the right home.**

## What landed, and what reverted

Landed and staying: the directory-exec errno fix (`EISDIR` → `EACCES` on the
exec path only, `open(2)` untouched), and the correction of a test that pinned
`MockHostIO`'s behaviour rather than production's — it asserted `EACCES` only
because the mock opens directories successfully.

Reverted: the preflight repoint. `kernel_exec_target_probe` **traps** —
`RuntimeError: unreachable`, a Rust panic under `panic=immediate-abort` — in
`resolve_shebang`'s header read for an overlay-backed target, a path that had
**never executed in the TypeScript kernel**; only `crates/host-native` called
it. The probe, its export, its ABI entry and six tests remain in place but
inert, so the repoint is a one-commit reapply once the panic is understood.

`parseShebang` is therefore back and **B10's deletion is not banked.**

## Increments

- **X1 — find the panic.** Needs a kernel built *without*
  `panic=immediate-abort` to get a message. The bisect is already precise: a
  sentinel before the `probe` call clears the fault, after it reproduces.
- **X2 — reapply the repoint** and bank the deletion.
- **X3 — decide the nested-`#!` limit.** Kandelo allows one level; Linux allows
  ~4 then `ELOOP`; POSIX is silent. Currently documented as a visible gap in
  `docs/posix-status.md`, which is contract-compliant. Raising it is platform
  scope with no reported need.

## Acceptance evidence

`parseShebangReferences` reaches **0** in the budget, and the sortix exec
expectations stay green across repetitions rather than one run. Additionally,
`posix_spawn` and `execve` must agree on a directory interpreter — today they
give `ENOENT` and `EISDIR` respectively, against POSIX's `EACCES`.

**Every fix here needs wasm evidence**, not native: the probe's own native test
covers the failing shape and passes.

## Known hazards

- **The native harness is structurally blind here.**
  `probe_resolves_an_overlay_target_without_trapping` covers exactly the failing
  shape **and passes natively**, because `MockHostIO` has no blob/image byte
  source. Any fix must be validated on wasm (H-3).
- Three spawn test files fail with `kernel_exec_target_artifact_policy failed`
  and are **unrelated** to this lane — verified by reverting and observing
  identical counts. They are unattributed work and belong to whoever takes
  lane X or a successor.

---

# LANE C — conformance

**Status: characterized, near done.**

## End state

PR #1350 can state, with evidence, that it causes no conformance regression —
and the statement rests on a **failing-file-set comparison**, never on totals.

## The floor

Tests that require a browser cannot run here; they belong to lane H. Everything
else in the suite is expected to run, and a test that cannot run is a defect in
provisioning rather than an exemption.

## Where it stands

**51 failures → 8, and none of the 8 are platform defects.** Two dispatch-table
bugs accounted for 42 of them, both **pre-existing** and both invisible until
the suite could execute a guest at all:

- `setsockopt` took the sixth channel word — always 0 for a five-argument
  syscall — as the process pointer width, which the guard rejects unless it is
  4 or 8. Every `SOL_SOCKET` set failed `EINVAL` before the fd was read.
- `ioctl` had the identical defect. It read as a *networking* fault because
  requests absent from the contract table skip the guard and correctly answer
  `ENOTTY`, so only requests with handlers failed — and `net_if` enumerates
  through `SIOCGIFCONF`.

**K6 is exonerated**: both arms are byte-identical at the merge-base.

## The remaining 8

All harness collateral: `BUILTINS=explicit` gives the guest no `/bin/sh` and no
`gencat`, so `popen`, `pclose`, `system`, `wordexp`, `wordfree` and three
`nl_types` cases cannot run. That flag is what took the suite from 1,352
timeouts to 5. **An explicit minimal program set — `sh` and `gencat` — would
likely recover all eight** without reintroducing per-test closure resolution.
Untried; it is a runner-contract decision.

## Known hazards

- **The merge-base cannot produce a comparable failing set.** Its runner lacks
  `KANDELO_RUNNER_BUILTINS=explicit`, so every guest-executing test times out
  and FAIL reads 0 **because nothing ran**. "It passed before" is not evidence
  when "before" could not execute. Mechanism attribution plus repetition is the
  substitute.
- **`BUILTINS=explicit` is a trade, not a free win.** It took the suite from
  1,352 timeouts to 5, and its cost is that five POSIX APIs needing `/bin/sh`
  cannot be tested at all.
- **A tally that matches the hypothesis is the most dangerous number here**
  (H-4). Twice in one day a conformance tally matched what was being
  investigated and was something else — a tree-shaken artifact reader, and a
  missing `dylink_module32.wasm` whose first line said `fork: ENOMEM`.

## Increments

- **C1 — the minimal builtin set**, recovering the 8.
- **C2 — B14 follow-through.** Two genuine pre-existing gaps are XFAIL'd with
  the boundary named: two `shmat` in one process do not alias, and a blocking
  `msgrcv` is never woken by a later `msgsnd` (3/3 deterministic, while a
  blocking `semop` *is* woken).

## Acceptance evidence

The campaign's conformance-neutrality claim needs the failing **file sets**
compared, not the totals. Note the merge-base cannot produce a comparable set —
its runner lacks `KANDELO_RUNNER_BUILTINS=explicit`, so every guest-executing
test times out and FAIL reads 0 because nothing ran. Mechanism attribution plus
repetition is the substitute, and it is what produced the numbers above.

---

# LANE B — build and provisioning truthfulness

**Status: partly landed, remainder characterized and dispatched.**

## End state

A build that cannot produce a usable artifact says so, in terms that name the
cause rather than the symptom — and the documented provisioning path and the
documented freshness gate agree with each other.

## The floor

None. Every defect in this lane is ours: our cache keys, our authority
publication, our installer, our documentation. There is no host or Wasm limit
anywhere in it.

## Increments

- **B1 — reconcile the cheap path with `verify-fresh`.** They are mutually
  incompatible today: `install_local_binary` stages a kernel with no custom
  sections, so the gate then refuses it and points the reader at the expensive
  path they were told not to run. Either the installer stamps, or the cheap
  path stops being documented. **Stamping was considered and rejected** — the
  installer is handed a caller-supplied file and cannot know its provenance, so
  a stamp there turns "cannot be verified" into "claims to have been verified".
- **B2 — the fixtures are unstamped.** `build-programs.sh` builds through the
  SDK, and only the local-build engine stamps, so every test fixture carries no
  `kandelo.abi.contract`. Lane X's probe surfaced this by treating it as fatal.

## Acceptance evidence

`cargo xtask verify-fresh` exits 0 after following the documented provisioning
path, whichever path that ends up being — today it does not, and that
contradiction is the lane.

## Landed

- **B29** — a stale kernel now says it is stale. `host-native` failures used to
  read `failed to find function export …`, naming the symptom and hiding the
  cause; the artifact's provenance — path, tier, which other tiers shadow it,
  declared ABI, both freshness stamps — is now attached to bring-up failures.
  It caught its own coordinator within hours.
- **B30** — a build killed mid-flight no longer publishes an authority for a
  build that never finished. Retract-first/publish-last, because nothing
  in-process runs on `SIGKILL`. Demonstrated with real kills in both
  directions; recovery republishes from receipts rather than rebuilding.
- **The installer tells the truth** rather than stamping: a hand-staged kernel
  says it cannot be freshness-checked. Stamping there would let a stale
  artifact, a debug build or another worktree's copy acquire a claim of engine
  provenance — *turning "cannot be verified" into "claims to have been
  verified" is the same defect pointed the other way, and worse because it is
  silent.*

## In flight

- **Source fallbacks.** `[source] url` is a single `String`; `m4` points at
  `ftpmirror.gnu.org`, a redirector, and when its target is down the build fails
  eight retries deep on the same dead host — cascading through `coreutils-docs`
  to every image product. **The sha256 is already pinned, which is what makes
  fallbacks safe**: integrity does not depend on which host answered.
- **B37 — DISPROVED, and the correction matters more than the item.** I filed
  this as "the SDK build mutates an input of its own cache key" on the strength
  of one failure message. It **did not reproduce**: a full `local-build` ran
  98/98 nodes, Products 7/7, exit 0, with zero "cache key changed". A
  before/after snapshot of every declared kandelo-sdk input *and* every global
  toolchain input came back empty — not one moved. `npm` does run in the tree,
  but nothing it writes is a cache-key input of that package.

  What landed instead is the part that was real: the refusal printed two opaque
  shas and now names the inputs that moved. Same shape as B29 and B30 — the
  state was correct and the explanation was missing.

## Known hazards

**RETRACTED — the `libc/musl` cache-key defect does not exist.** This file
recorded it as measured fact and the maintainer decided on it. Both were wrong.
`hash_global_package_build_input` already special-cases `libc/musl` to
`hash_gitlink_input`, which reads the gitlink object id from the git index and
hashes only that — deliberately, since PR #619, with the reasoning written in
the code. The "three digests" measurement was a probe hashing the directory,
never what xtask computes: a property of the directory reported as a property
of the cache key. A counterfactual settles it — adding and removing object
files under `libc/musl` does not move a package key, and does not move it even
when the walk is forced. **A census of every other global toolchain input found
no entry with the defect shape**: `libc/musl` is the only tree that accumulates
build output and it is precisely the one exempted from the walk.

**The drift report understates drift.** `global_package_toolchain_digests`
memoizes per process, so the pre- and post-build keys *necessarily* agree about
global inputs even when the tree moved underneath. The report now re-reads them
uncached and says so.

**The documented cheap provisioning path and the documented freshness gate are
mutually incompatible.** `install_local_binary` stages a kernel with no custom
sections, so `verify-fresh` then fails and points the reader at the expensive
path they were told not to run. Only the local-build engine stamps.

---

# LANE P — platform honesty: does the platform do what it claims?

**Status: CHARACTERIZED.**

## What this lane is

Not a subsystem — a **class of defect**, which is why it never became a lane.
It is the platform-values contract's own prohibition: *do not present
capability, state, or conformance that does not exist.* Instances live in the
UI, in mount configuration, in the POSIX surface and in the documentation, and
each looked like someone else's problem.

## End state

Every capability the platform offers is implemented, every state it displays is
read from the system rather than from the request that created it, and every
POSIX surface it declares either works or reports the correct failure. Where a
gap remains it is **visible as a gap** — which the contract permits and
silence does not.

## The instances, each already evidenced

| instance | why it is this lane |
|---|---|
| **Six of twelve `MountSource` kinds have no implementation** — yet are offered in a config dropdown, allow-listed as untrusted input, and displayed as `gitfs` / `casfs` / `cryptfs` | offering capability that does not exist |
| **`web-libs/kandelo-session` reports the requested boot descriptor as machine state** in the production Inspector UI, while the kernel has a real `/proc/mounts` | displaying the request as the reality |
| **`MountConfig.readonly` renders as `ro` and gates nothing** | displaying an enforcement that is not enforced |
| **16 declared-but-unimplemented surfaces, four contradicting `docs/posix-status.md`** | documentation promising what the implementation does not do |
| **`st_rdev` is zero for every device node** through `stat`, `fstat`, `lstat` and `statx` | a declared field that is never written; `process_wire.rs` calls it "unsupported" and requires it zero-filled, so this is a declared gap rather than an oversight |

## Increments

- **P1 — the UI trio**: read mount state from `/proc/mounts`, make `readonly`
  either gate or stop rendering, and remove the unimplemented `MountSource`
  kinds from the dropdown *or* implement them. Removing an option is a product
  change; say so and get a ruling rather than deciding it inside the lane.
- **P2 — reconcile `docs/posix-status.md`** against the four contradictions.
  Documentation that overstates is worse than none, because it is trusted.
- **P3 — `st_rdev`**, which is ABI-adjacent work on the stat wire.

## Acceptance evidence

For each instance: a test that fails against the current behaviour before the
fix, demonstrated failing. **This lane is especially exposed to guards that
assert nothing** — "the UI shows mount state" passes trivially if the assertion
is weak, and the existing defect is precisely that the UI shows *something*
plausible.

## Known hazard

**Removing an offered capability is user-visible.** `gitfs` / `casfs` /
`cryptfs` appearing in a dropdown may be somebody's expectation even though
nothing implements them. Deleting the option and implementing the mount are
both defensible; quietly leaving it is not.

---

# LANE I — host import surface

**Status: CHARACTERIZED. This lane is V4 itself.**

## The surface, grouped by what a new host would actually have to write

72 functions plus `env.memory`, counted from the built artifact:

| group | count | what it is |
|---|---|---|
| **Filesystem** | **28** | `openat`, `read`, `write`, `pread`, `pwrite`, `seek`, `close`, `fstat`, `fstatat`, `fstatfs`, `fsync`, `ftruncate`, `readdir`, `mkdirat`, `unlinkat`, `renameat`, `linkat`, `symlinkat`, `readlinkat`, `fchmod`, `fchmodat`, `fchown`, `fchownat`, `utimensat`, `fpathconf`, `append`, `append_position` |
| **Graphics** | **~22** | 10 `gl_*`, 6 `kms_*`, 4 `gbm_*`, plus framebuffer bind/unbind and `fb_write` |
| **Network** | **~12** | 7 `net_*`, 3 `udp_*`, `getaddrinfo`, `network_local_address` |
| **Everything else** | **10** | `clock_gettime`, `getrandom`, `waitpid`, `futex_wake`, `set_alarm`, `set_posix_timer`, `proc_read_bytes`, `proc_write_bytes`, `image_read`, `fetch_deferred` |

## End state, and the observation that defines it

**A new host should implement bytes and capabilities, never POSIX semantics.**

That is not a slogan; it is what the grouping shows. **28 of 72 imports are
POSIX filesystem operations** — and the kernel already implements POSIX
filesystem semantics in Rust for tmpfs, rootfs and SFFS. Those 28 exist so the
*host* can serve the same semantics for host-backed mounts (Node `fs`, OPFS).
So a wasmtime author today must implement `fchownat` and `utimensat` and
`fpathconf` correctly, in the right order, with the right errnos — for a
filesystem the kernel could drive itself if the host handed it bytes.

A host-backed mount needs roughly **six**: open, read, write, close, stat,
readdir. The kernel owns path resolution, permissions, link semantics,
timestamps and errno choice — it already does, for every other mount.
**That is ~22 imports removed and a materially easier new host.**

The same shape is visible in graphics: `host_gl_submit` already exists, which
means batching is already the model. A command-buffer submit collapses much of
the 10 `gl_*` calls; the `kms_*` and `gbm_*` groups are worth the same question.

**Target: 72 → ~40 conservatively, ~25 if both collapses land.** The budget
records 40; treat that as the ceiling to beat, not the goal.

## The floor — imports that must exist

Anything the kernel physically cannot do inside Wasm: reading real bytes from a
host filesystem or network, the clock, randomness, presenting pixels, waking a
worker. **The floor is a capability, never a decision.** An import that decides
is policy in the host, and every new host must then re-implement that policy
correctly or silently not — which is the defect below.

## Known defects, each already evidenced

- **27 of 72 imports decide or are mis-shaped.** An import that decides is the
  V4 anti-pattern in its purest form.
- **`host_waitpid` is implemented four times**, and the JS copy is dead.
- **17 duplicated authorities, three already drifting** — including
  `host-native` discarding `clock_id`, which makes `CLOCK_MONOTONIC`
  **non-monotonic on the conformance host**. That one is a correctness defect
  in the instrument we measure conformance with, and should be fixed ahead of
  the lane's structural work.

## Increments

- **I1 — fix the drifted authorities**, `clock_id` first. Correctness, not
  structure; do not wait for the rest.
- **I2 — retire the dead duplicates**, `host_waitpid`'s JS copy first.
- **I3 — collapse the filesystem group** from POSIX operations to a byte
  interface, moving semantics into the kernel that already implements them
  elsewhere. The largest single reduction available anywhere in the campaign.
- **I4 — the same question for graphics**, starting from the fact that
  `host_gl_submit` shows batching is already accepted.

## Acceptance evidence

The import count measured **from the built artifact**, never the pin — and the
budget ceiling lowered in the same commit. Two independent reductions composed
correctly earlier in this campaign *only* because both measured; had either
reported `EXPECTED_HOST_IMPORT_COUNT`, the merge would have shipped a pin
disagreeing with the kernel.

## Known hazards

- **The entry-versus-function trap has caught four agents.** 72 functions reads
  as 73 entries because `env.memory` is an entry. Say which you counted.
- **A collapse must not become a dispatcher.** `host_fetch_deferred(kind, …)`
  worked because two capabilities genuinely overlapped. Merging unrelated calls
  behind one entry with a switch is the same surface wearing a smaller number,
  and the budget would not notice.

---

# LANE K — `kernel-worker.ts`, one god class every lane contends for

**Status: K1 census COMPLETE — `docs/plans/2026-09-11-lane-k1-census.md`.
The lane's framing was wrong; its target survived.**

## What this lane is — as corrected by the census

**Not "the host's second syscall table."** 85 distinct `SYS_` constants are
dispatched at 86 sites, out of 233 in the ABI — and reading the handlers shows
why: `handleFork`, `handleClone`, `handleSpawn`, `handleExecveat`,
`handleSelect`, `handlePselect6`, `handleFutex`, `handleIpcShmat`,
`handleBlockingRetry`. **These are exactly the syscalls needing a host
service** — creating a worker, blocking on `Atomics.wait`, sharing memory. The
kernel cannot create its own workers, and **`crates/host-native` dispatches the
same set** through the same exports. Both hosts must do this.

**The defect is shape, not duplication.** 91.6% of the file is one class:

| | Lines |
|---|---|
| `class CentralizedKernelWorker` | **29,975** (522 methods) |
| 37 other top-level functions | 2,743 |

`#handleSyscallInner` alone is **2,149 lines**. Every lane that touches the host
contends for this one file, and no boundary inside it can be enforced.

## End state

The responsibilities the census found — syscall dispatch, process/worker
lifecycle, blocking and wakeup, channel and memory IO, virtual networking — are
separate modules with enforceable boundaries, and the host does the same job in
something like the space the native host needs for it.

## The floor — and the number that makes the lane

Dispatching the 85 host-service syscalls is floor. Both hosts do it.

**What is not floor is the cost.** `host-native`'s `guest.rs` does the same
job — fork, exec, clone, the blocking-retry pump — in **13,577 lines**, against
29,975. **That ratio is the lane's whole argument.**

It also validates the target: 12,000 was guessed as "roughly a third", and the
native host independently lands at 13,577. **This is the only lane whose
provisional target survived its census.**

## Increments

- **K1 — census.** Done.
- **K2 — split the class** along the boundaries the census found; they are
  already visible in the method names.
- **K3 — decide the test-authority question.** `#createTestAuthority` is 1,459
  lines and the three test-scaffolding methods total 1,577, shipping in the
  production class. It is a deliberate pattern, not debris, and `kernel.ts`
  carries the same one — so this is a trade to decide deliberately, not a defect
  to fix silently.
- **K4 — `#handleSyscallInner` is the single densest unit** and should be
  table-driven, with the table generated from the same ABI source lane G and
  L-D2 point at.
- **K5 — measure against `guest.rs`** as each piece lands; it is the only
  evidence for what the job actually costs.

## Acceptance evidence

`kernelWorkerTypeScript` reaches **12,000** — census-validated against
`guest.rs`, no longer provisional. `kernelWorkerClassMethods` reaches **150**
from 522: **a line gate alone permits shuffling code between methods of the same
god class while nothing improves.**

## Known hazards

- **The 436 methods the census could not classify — 17,958 lines — are the
  majority of the class and the largest unknown in the whole plan.** They fell
  into no name-based bucket and were not read. Any K2 schedule built without
  reading them is built on sand.
- **Moving code inside this file shifts V8 parse and compile for unrelated
  functions**, which was visible in the select A/B. Performance claims about
  this lane need the whole-suite treatment (H-7).
- **None of the 85 dispatched syscalls was proven to need a host service.** They
  were classified by handler name and the blocking protocol. A K2 that deletes a
  handler on this census's authority would be over-reading it.
- **`guest.rs` is not a port.** It is the same responsibility in another
  language and may omit behavior the browser host needs, so the ratio is an
  argument, not a specification.

---

# LANE G — ABI binding drift

**Status: CLOSED 2026-09-12. All 15 layout modules anchored;
`unguardedLayoutModules` 14 → 0.**

## What this lane is — as corrected while doing it

The lane was written as "extend `render_process_layouts_header` from 6 modules
to 15", with a gate counting modules the header *delivers*. **That gate could
have gone to 0 while guarding nothing**, because a `#define` hands C a number
and does not check that C's own struct agrees.

The real defect was subtler: `bits/stat.h` already had 8 asserts, but they
compared musl against **hand-written literals** (`== 112`, `== 32`) while the
same file said in prose "The complete layout MUST match
`crates/shared/src/process_layout.rs`". Two sources agreeing by convention —
the campaign's recurring shape.

## End state

Every layout module's C-side facts are asserted against the **generated**
constants, so changing the Rust authority fails the C build. The pattern is the
one `libc/glue/channel_syscall.c` already used for `siginfo_t`.

## The floor

None. The generator, the layouts and the headers are all ours.

**But not every module is a musl-struct mirror**, which the lane did not
anticipate — see `itimerval` below.

## Increments

**Landed:**

- **G1 — `stat`**, re-anchored from literals to macros; coverage 8 → 14 facts.
- **G2 — `iovec`, `msghdr`, `cmsghdr`, `sigevent`** in `channel_syscall.c`.
- **G3 — `statx`, `statfs`, `sysinfo`, `mq_attr`, `sigaltstack`,
  `sched_param`** in a new `libc/musl-overlay/src/stat/kandelo_layout_asserts.c`,
  which lands in `libc.a` so `build-musl.sh` verifies it.
- **G4 — `multicast_group_request` and `dev`**, the latter via a round-trip
  vector since it is three `const fn`s, not offsets.

103 constants emitted; 68 asserts.

**Remaining:**

- **G5 — `itimerval`**, blocked on the decision below.
- **G6 — `sched_param`'s six `__reserved2` offsets**, which no portable member
  name can reach; needs either a Kandelo-side struct to take `offsetof` against
  or a documented exemption.
- **G7 — DONE 2026-09-12**, after the maintainer chose to classify additive
  keys as compatible. The snapshot now records **all fifteen** layout modules.

  The fix turned out not to be a new relaxation at all: the classifier already
  had an additive-object mode used by `marshalled_structs`,
  `syscall_arg_descriptors` and `vfs_metadata`. `process_native_layouts` is
  keyed by struct name exactly like those three and was simply falling through
  to the catch-all. It now dispatches to the same helper.

  **The guard is not weakened.** `classify_additive_object_by_key` reports
  changed and removed entries as breaking and forgives only additions.
  Verified: adding modules reports `snapshot changes are backward-compatible
  additions`, while perturbing `iovec`'s recorded size still reports
  `breaking/incompatible snapshot change: changed process_native_layouts entry
  "iovec"` and demands a bump.

## Acceptance evidence

`unguardedLayoutModules` reaches **0**. Every module asserts musl's own
definition against the generated constant, and the snapshot records all
fifteen.

Every batch was shown to fail before being trusted (H-2), including on the
field that motivated the lane: changing `statx::DEV_MINOR_OFFSET` produces
`static assertion failed … stx_dev_minor … drifted from
crates/shared/src/process_layout.rs`.

## Known hazards

- **Three measurement errors in this lane were found by exercising guards, not
  reading them**: the gate counted delivery; a retracted claim that no asserts
  existed (`bits/stat.h` had 8, missed because they use `__builtin_offsetof`);
  and a `dev` test vector so sparse that the mask perturbation it was meant to
  catch produced an identical value.
- **`sched_param` is only partially covered.** Six sporadic-server offsets live
  inside musl's `__reserved2` with no portable member name. The module counts as
  anchored while those six are unchecked, and the assert file says so.
- **`channel_syscall.c` is not in `libc.a`.** It is compiled per-program, so a
  clean `build-musl.sh` does not exercise its asserts — including the
  pre-existing `siginfo_t` ones.
- **The compile reads the SYSROOT header, not the overlay.** After `dump-abi`,
  `scripts/build-musl.sh` must run before any assert test means anything. One
  perturbation test was invalid for exactly this reason.
- **`itimerval` is guarded differently from the rest, and the difference
  matters.** It is not a mirror of musl's public `struct itimerval`, so the
  assert is on the shape of the kernel-facing record — four native `long`s —
  rather than on a struct. Anyone "fixing" it later to assert
  `sizeof(struct itimerval)` would be reintroducing the error the plan spent a
  decision on.

---

# LANE D — dead Rust floors

**Status: characterized as a class. Five modules found and never followed up.**

## End state

No Rust module in the tree looks finished while never having executed. Each of
the five is either wired to a production caller or deleted.

## Increments

- **D1 — census the five**, transitively. A direct grep produced 13 false
  alarms in one afternoon because most call sites reach their target
  indirectly, and a module's only references being a `pub mod` line and a doc
  comment is the signature.
- **D2 — per module, wire or delete.** Both answers are correct; leaving it is
  not.

## Acceptance evidence

Per module, either a production call site or its absence from the tree. **Not
a line count** — "give it a caller" and "delete it" move the number in opposite
directions and both close the item.

## Known hazards

- **This is H-1 in its pure form.** A dead floor with green tests and careful
  documentation is *harder* to remove than an undocumented orphan, because the
  tests and docs are what make it read as complete. Lane M shipped 368 such
  lines before they were caught, and they were well-tested and well-documented.
- **`module_state_records.rs` is the sharpest case**: 483 dead Rust lines whose
  live twin is 3,860 TypeScript lines. It belongs to lane F, not here, but it
  is the same phenomenon — the Rust never running is why the TypeScript never
  left.

---

# LANE T — test hygiene

**Status: characterized, blocked on a clean suite read.**

## T5 diagnosis — COMPLETE (`docs/plans/2026-09-11-lane-t5-census.md`)

**41 of 49 suite timeouts live in `fork-instrument-coverage.test.ts`, and the
answer is one cause, not forty: Vitest's default `testTimeout` of 5,000 ms
against an 8.4–9.6 s job.**

**T6 is DONE** — `host/vitest.config.ts` now sets `testTimeout: 30_000` as an
explicit stopgap.

**The T5 census got the root cause wrong and the correction is recorded in it.**
It blamed the harness's 10,000 ms `runCentralizedProgram` budget and called the
file "marginal, sinks under load". The binding limit was Vitest's 5 s default,
which `host/vitest.config.ts` never set — so the failures were **deterministic**,
not load-dependent. The two clocks differ: the harness's bounds the *guest
program's run*, Vitest's bounds the *test's wall clock*, which includes the
per-test kernel instantiation that dominates. **A number in the file you are
reading is not automatically the number that binds.**

At `--testTimeout=20000` on a quiet machine: **41 passed, 2 expected fail, 8
skipped, exit 0.** Nothing in the file is broken.

Per-test duration across the 34 timed tests: minimum **8,409 ms**, median
**8,506 ms**, maximum **9,573 ms** — **100% over 8,000 ms**. The harness default
is **10,000 ms**, commented "fork tests are short".

So every test sits just under the line *together*, because they all run the same
`runFixture` → `runCentralizedProgram` work. Any load sinks all 41 at once —
and the plan already records that a package build takes the machine to load 100
(H-7).

This also corrects an earlier reading: "40 failed, 1 passed, reproduces in
isolation, therefore not contention." Both halves true, conclusion wrong. **The
file barely passes on a quiet machine**, so isolation cannot rescue it.

**The real finding is 8.5 seconds per test.** The 14% spread between fastest and
slowest is the signature of fixed per-test setup dominating — `runCentralizedProgram`
stands up a kernel per test — not of fixtures doing different work. 371 s of
test time plus 49.55 s of import, for one file.

## End state

Every host-suite failure is attributed to a named cause. Not zero failures —
attributed ones. A suite with 40 unexplained failures and a suite with 40
explained ones are different artifacts, and only the second can gate a release.

## The floor

Browser-dependent tests cannot run here and belong to lane H. Everything else
is expected to run.

## Increments

- **T5 — diagnosis. Done.**
- **T6 — raise the budget as an explicit stopgap.** A 10 s guard on an 8.5 s job
  is a coin flip, not a guard. Say "stopgap" in the commit.
- **T7 — measure where the 8.5 s goes.** If it is per-test kernel instantiation,
  amortising it is worth more than the timeout change and cuts ~6 minutes from
  one file. **This is the lane.**
- **T8 — the other 8 timeouts** outside this file have never been diagnosed.

## Original increments

- **T5 — `fork-instrument-coverage.test.ts`.** 40 of its 51 cases time out at
  5 s, reproduced **in isolation on a quiet machine**, so it is not contention.
  One file carries 28% of the suite's failures. Establish whether the budget is
  wrong or the instrumentation is broken before treating it as 40 defects.
- **T6 — the remaining attributed groups**: 13 `vi.fn` spawn assertions (not
  lane X's — verified by revert), 8 `Invalid source-only projection authority`,
  6 PHP startup-warning mismatches, 4 kernel-init completions.
- **T4 — the residue**, ~20 items, explicitly after T1–T3 because most should
  vanish with them.

## Acceptance evidence

Unattributed failures reach **0**, with the attribution written down rather
than held in a coordinator's head. The count itself is not the measure — a
green suite that cannot run is worse than a red one that can (H-4).

## Known hazards

- **A suite that cannot run hides defects rather than reporting them.** Two
  pre-existing dispatch-table bugs — `setsockopt` and `ioctl` both taking the
  sixth channel word as a pointer width — were invisible at the merge-base
  purely because every guest-executing test timed out there.
- **Provisioning failures dominate and look like code failures.** Three
  separate suite readings this session were invalid for provisioning reasons,
  and each produced a plausible number that had to be withdrawn.

T1 and T3 closed with B19/B23 and B21. T4 is ~20 residual items — 7 `vi.fn`
stubs never called, 5 unreachable branches, assorted — explicitly sequenced
**after** T1–T3 because most should vanish with them. Dispatching it before a
clean suite read would be tidying a list rather than fixing a suite.

Current suite state on a correctly staged kernel: **83 failing files, 139
failing tests, 3,788 passing.** Attribution: ~39 `Package artifact closure is
incomplete` and 32 package-test files (lane B), 17 the exec-target probe (lane
X, now reverted), 45 five-second timeouts across 6 files not yet separated from
load, 8 `Invalid source-only projection authority`, ~11 spawn assertions (lane
X's neighbours, unattributed), ~19 unclassified.

---

# LANE H — browser

**Status: DEPRIORITIZED by the maintainer.** *"I don't care about browser
coverage yet — I'd rather push implementation further before we pay the heavy
cost of checking in the browser."*

Recorded so it is not mistaken for an oversight: there is **zero browser
evidence on this branch**. Fourteen Playwright specs call `resolveBinary`
directly with no artifact reader installed; no `./run.sh browser` has completed;
no demo has been verified by hand. Everything else rests on Rust and Node.
Curation of ~369 commits into ~14 narrative commits also lives here, and the
maintainer has held it pending a running web app.

---

# LANE L — host↔kernel plumbing

**Status: L1 census COMPLETE — `docs/plans/2026-09-11-lane-l1-census.md`.
Target derived, not provisional. The census changed what this lane is.**

`kernel-scratch.ts` (2,491), `kernel-entry-gate.ts` (1,596), `process-memory.ts`
(1,337), `worker-protocol.ts` (429) — **5,853 lines**.

## What this lane is — as corrected by the census

The lane was written as "5,853 lines a wasmtime host must reproduce." **That was
wrong, and `crates/host-native` disproves it**: 17,757 lines of Rust run the
same kernel, and for this entire lane they wrote a small layout struct, one
bounds-check helper, and nothing else. A new host's burden here is already near
zero.

What the lane actually is: **the same knowledge exists twice, and the second copy
was made by transcription.** `host-native` cites `host/src/*.ts` in **47
comments**. Its `ProcessLayout` carries the same fields as `ProcessMemoryLayout`
and says the pointer width is derived "the same moment `host/src/kernel-worker.ts`
calls `detectPtrWidth`". Its `checked_shared_range` doc names the TypeScript
function it mirrors, down to `allowAddressZero: false`.

**Two transcribed copies drift, and host #3 transcribes a third.** This is a V1
cost — share code across hosts — more than the V4 cost the lane originally
claimed.

## End state

The knowledge that is duplicated exists once: one process-memory layout, one
bounds-check rule, one scratch pointer table generated from the kernel's own
export signatures. The two genuinely JavaScript-shaped things — the re-entrancy
gate and the worker protocol — stay, and are named as such so they are not
mistaken for residue later.

## The floor — and the fourth category the lane missed

The lane assumed every line is floor or migratable. **About 428 are neither.**
`kernel-scratch.ts` captures 46 `intrinsic*` bindings and `kernel-entry-gate.ts`
27 more, because in JavaScript `DataView.prototype.getInt32` can be replaced at
runtime. Rust has no such hazard and `host-native` captures nothing.

**These lines cost a new host nothing.** Counting them in a "minimize the host
API surface" budget overstates the surface a wasmtime host faces. They are a tax
JavaScript pays for being JavaScript.

Genuine floor, confirmed against `host-native`:

- **The re-entrancy gate stays.** Rust gets this from the borrow checker — you
  cannot hold `&mut Store` twice, which is why `host-native` reaches exports
  through `caller_export_typed`. JavaScript has no such mechanism, so the gate
  must be written. **Goal V2 delivering exactly what it promises.**
- **`worker-protocol.ts` (429) stays.** `host-native` uses native threads and
  has no worker wire at all.

## Increments — rewritten by the census

- **L2 — BLOCKED. Its premise is false, found 2026-09-12 while starting it.**

  The increment said "generate the scratch pointer table from the kernel's own
  export signatures". **The signatures do not carry that information.** Kernel
  exports mark pointers three different ways: `*mut u8`
  (`kernel_get_cwd(pid: u32, buf_ptr: *mut u8, ...)`), bare `usize`
  (`kernel_handle_channel(scratch_ptr: usize, ...)`), and plain `u32`
  (`kernel_exec_target_read`). A type-based extraction agrees with the
  hand-written TypeScript table on **40 of 52 entries and cannot see the other
  12** — it reports no pointers where the table declares them.

  The 12 are not evidence the TypeScript is wrong; they are evidence the
  *signatures* are not an authority. `*_ptr` naming is a convention, not a type.

  **Three ways forward, and the choice is the maintainer's:**

  1. **An explicit Rust declaration** — a const table in `crates/shared` naming
     pointer positions per export, generated into TypeScript and assertable from
     Rust. Campaign-consistent, but it is a second thing to keep in step with the
     signatures.
  2. **Make the type the authority** — change every kernel export to take
     pointers as `*mut u8`/`*const u8`. Then extraction is exact and the
     compiler enforces it. Invasive: it touches the whole kernel export surface.
  3. **Name-based heuristic** (`*_ptr`, `*_buf`). **Not recommended** — a gate
     that is wrong is worse than no gate, and this would encode a convention as
     if it were a fact.

  Until then `KERNEL_SCRATCH_EXPORT_NAMES` stays hand-maintained and L-D2 stays
  open.
- **L3 — one process-memory layout** in `crates/shared`, consumed by both hosts.
- **L4 — one bounds-check rule.** `checked_shared_range` already documents
  itself as a copy of the TypeScript.
- **L5 — fix L-D1** by giving the native host the capacity invariant, rather
  than deleting the JavaScript host's version of it.
- **The re-entrancy gate and worker protocol are not lane L work.** Saying so is
  part of the deliverable.

## Acceptance evidence

`hostKernelPlumbingTypeScript` reaches **3,600** — derived per unit by the L1
census, not provisional. **The census raised this from a guessed 1,500**; a
ratchet behind the guess would have judged a correct landing at 3,600 a failure.

Per increment: the layout and bounds rules must be shown to produce identical
results in both hosts before either copy is deleted, and the generated pointer
table must reproduce the current hand-written one exactly before it replaces it.

## Known hazards

- **L-D1 — the native host does not enforce the capacity invariant.** It writes
  scratch through a bare `copy_nonoverlapping` after a `ptr > 0` check. The
  call site is sound by construction; nothing enforces that. Census outcome 3:
  not floor, and not permission to keep the gap.
- **L-D2 — the scratch pointer table is 35 exports wider than the generated ABI
  list.** `KERNEL_SCRATCH_EXPORT_NAMES` names 55 exports by hand; the generated
  lists cover 78 + 8 and **overlap it on only 20**. `kernel_ioctl`,
  `kernel_select`, `kernel_poll`, `kernel_recv`, `kernel_send` and
  `kernel_rootfs_write_file` are among the 35 in neither. Lane G's failure mode
  in a different file.
- **Deleting an invariant while deleting its verbosity.** Still the way this
  lane does damage: the rules are about what must *not* happen, so a rewrite
  that loses one passes every existing test.
- **`process-memory.ts` and `kernel-entry-gate.ts` are also named by lane X's
  cluster.** Ownership is settled here; a dispatch that ignores it will have two
  lanes editing one file.

---

# LANE E — Node and browser peers that drifted

**Status: CLOSED 2026-09-12** at the floor the E3 audit derived — `hostPeerDuplicateDeclarations` 65 → **29**.

**E1 census COMPLETE — `docs/plans/2026-09-11-lane-e1-census.md`.
Much smaller than the lane claimed. Gate replaced.**

## What this lane is — as corrected by the census

The lane said "three pairs, 7,513 lines, ~70% divergent, 10–20 days". **The 70%
came from line-diffing, which conflates two different things**: the same job
written twice and drifted, versus two different jobs that were never the same.
Symbol comparison separates them.

- **`*-kernel-host.ts` (3,156 lines) is not drift.** The two files share exactly
  one name, `DESTROY_REQUEST_TIMEOUT_MS`. One loads artifacts from disk and
  spawns a worker thread; the other fetches over HTTP and starts a Web Worker.
  Different jobs. **Essentially all floor.**
- **`*-kernel-worker-entry.ts` (3,208 lines) is already consolidated.** The
  survey's "10 symbols each" was wrong — it counted the import statement. The
  real mechanism is `createProcessLifecycle<T>()`, a generic factory: the
  browser destructures **73** members and Node **72**, sharing 72. The whole
  fork/vfork/clone/exec/spawn/exit/thread lifecycle is already one
  implementation.
- **`*-kernel-protocol.ts` (1,153 lines) is the real duplication**: **43
  identically-named message types declared twice**, structural types with no
  platform content.

## End state

One declaration of every shared message type and of every genuinely shared
worker-entry helper. The per-host files keep what is genuinely per-host, and
`*-kernel-host.ts` is left alone with a note saying why.

## The floor

**`*-kernel-host.ts` in its entirety.** Also the 57 browser-only worker-entry
declarations (framebuffer release/rebind, service-worker bridge, mouse
injection, audio drain, lazy registration) and the 30 Node-only ones (session
directories, crash safety net, local exec resolution), plus 18 browser-only and
2 Node-only message types.

## Increments

- **E1 — census.** Done.
- **E2 — unify the 43 protocol message types.** Type-level and mechanical, so
  it cannot change runtime behaviour. Start here.
- **E3 — audit of the 21 same-named worker-entry declarations. DONE
  2026-09-12. None is duplication to remove.**

  **4 are `let` module state** initialised from shared constants —
  `maxPages`, `initReady`, `defaultThreadSlots`, `processMemoryAllocator`.
  Sharing a `let` across modules would make them one variable; each host needs
  its own instance.

  **17 differ for platform reasons.** `vforkMechanismTraceEnabled` is the clean
  illustration: Node reads `process.env.KERNEL_SYSCALL_LOG`, the browser has no
  environment and sets it from a runtime message. `handleInit` is 14,191
  characters in the browser against 3,437 in Node.

  **A caution about how this was nearly mis-read:** a character-count comparison
  made `vforkMechanismTraceEnabled` look like an 8-vs-691 asymmetry — a
  candidate for E1's missing category three. The 691 was the declaration plus a
  trailing doc comment. **Size deltas are not evidence of divergence**; reading
  the declarations is.

- **E5 — DONE 2026-09-12. 16 more interfaces shared; 48 → 32.**

  **E2 under-captured.** Its extraction regex had an optional leading
  doc-comment group that could swallow the *previous* declaration's comment,
  so blocks that were byte-identical compared as different. `PipeReadMessage`
  is the plainest case: identical in both files, missed by E2.

  Re-extracted by brace-matching the declaration itself rather than
  regex-matching a block: **17 byte-identical declarations**, of which 16 moved.
  `ExportRootfsImageMessage`'s two doc comments say the same thing and the
  browser's is strictly more informative, so that one survived.

- **E6 — the last three. DONE 2026-09-12; the lane closes here at 29.**

  `ProcEventMessage` needed a union-aware capture: a type alias terminates at a
  `;` at **brace depth 0**, and its members contain their own. Two earlier
  attempts cut at the first inner semicolon and orphaned half the union; `tsc`
  caught both.

  `HttpRequestMessage` took Node's version whole — it is strictly richer, adding
  "or with `error` set if no listener was found" plus three field comments.
  `WriteVfsFileMessage` **merged** the two: Node's leading doc describes the
  message, the browser's inline comment describes the `path` field, and they are
  complementary rather than competing.
- **E4 — leave `*-kernel-host.ts` alone and record why**, so a later pass does
  not "discover" the divergence and try to merge it.

## Acceptance evidence

`hostPeerDuplicateDeclarations` reaches **29**, currently 48.

**The target was 12 and that was a guess.** E3 derived the real floor by reading
every candidate: **21 worker-entry declarations are legitimately per-host**
(4 module-state `let`s, 17 platform differences), **6 protocol types genuinely
differ**, and **2 are message unions** whose members differ by construction.
21 + 6 + 2 = 29.

What remains between 48 and 29 is **18 protocol types with identical bodies and
divergent comments** (E5) and one shared constant in the kernel-host pair.

## Known hazards

- **Merging peers into one file with host conditionals**, which converts visible
  divergence into invisible divergence. E4 exists to prevent this being applied
  to `*-kernel-host.ts`.
- **E1 found no category-three divergence** — no bug one host fixed and the
  other did not. That was the finding that would have justified the lane most
  strongly, and its absence lowers the lane's urgency. Do not re-argue the lane
  on a premise the census disproved.
- **Browser behavior cannot be validated from Node** (lane H). E2 is type-level
  and safe; E3 is not.
- **The 21 shared worker-entry names are only known to share names**, not to
  have drifted. Reading them is E3's job, not E1's.

---

# LANE R — binary and artifact resolution

**Status: CLOSED (2026-09-12). `artifactTierPathSpellings` 8 → 1.**

## What this lane was — as corrected by the R1 census

Not a resolver migration. `host-native`'s equivalent of the 4,020-line
TypeScript resolver was **ten lines**; the other 4,010 are policy the native
host does not use and nobody duplicates. **What duplicated was the tier list
and its order**, spelled eight times across the writer and both readers.

**The drift was not hypothetical.** After a `./run.sh setup` that exited 0,
`local-binaries/source-only-v1/kernel.wasm` was built that afternoon and
exported `kernel_thread_parent_tid_target`; `local-binaries/kernel.wasm` was a
seven-hour-old symlink that did not. `cargo test -p host-native` failed **39 of
53** against a tree where the build had just succeeded.

And the right fix had already been applied once *within* TypeScript —
`host/src/binary-tiers.ts` exists because a hand-maintained second copy "drifted
in both directions" — then stopped at the language boundary.

## End state — reached

`crates/shared/src/artifact_tiers.rs` is the single authority. The writer
(`xtask local-build`) and both readers derive from it; the TypeScript side via
generated `ARTIFACT_TIERS` in `host/src/generated/abi.ts`.

## The floor

Reading bytes from the host's own filesystem — Node `fs` in one host,
fetch/OPFS in the other. `binary-resolver.ts`'s 4,010 lines of policy are not
floor and were **not** lane R work: they are not duplicated, and the census said
so explicitly.

## Increments

- **R1 — census.** Done; overturned the lane's scope.
- **R2 — one declaration** in `crates/shared`, generated into TypeScript;
  `binary-tiers.ts` consumes it. Done.
- **R4 — `host-native` consumes it**; its four-literal `ARTIFACT_TIERS` and the
  comment asking editors to "change `binaryCandidateTiers()` in the same commit"
  are gone. Done.
- **R3 — `xtask` writes to the shared constant.** Done, and this was the half
  that mattered: the writer disagreeing with the readers is what produced the
  incident.

## Acceptance evidence

`artifactTierPathSpellings` reaches **1** — the authority itself.

The decisive evidence is `cargo test -p host-native`: **60 passed, 0 failed**.
That is the suite that failed 39 of 53 when the lists disagreed. Plus `cargo
test -p xtask local_build` — 61 passed — and the host suite's binary-resolver
tests.

Tests changed shape as well as target: `host-native` used to assert its tier
list equalled a literal copy of itself. It now asserts **the property the
incident violated** — the tier a completed build writes is searched before the
one that may hold a stale symlink.

## Known hazards

- **Generated output is not an independent spelling.** Adding the authority
  pushed the measure *up* to 9 until `host/src/generated/` was excluded;
  counting generated files penalises the fix.
- **R2 alone was not a reduction** (8 → 8). It changed which file is allowed to
  spell the path. Saying so mattered: the number would otherwise have implied
  progress that had not happened.
- **Only the source-only tier was counted.** The other three tiers were not
  measured for independent spellings, and the census said so.
- **`binary-resolver.ts` is untouched and still 4,020 lines.** Whether that
  policy is right-sized is a real question this lane deliberately did not ask.

---

# LANE Y — VFS image builders write the image format in TypeScript

**Status 2026-09-13: Y1, Y2, Y3, Y4 and Y6 DONE. Y5 is the lane's remaining
work, and its acceptance number has moved twice: importers 36 -> 20 -> 11 -> 10,
banked at every step. Ten files remain, and they do NOT divide by difficulty —
they divide by what blocks them. Five wait on the atomic-seal check, one waits
behind those, two are the supply-chain Rust port, one wants deferred-entry
enumeration, and the funnel is last by construction.**

**Read these before picking work**, because they are where this lane's
remaining shape actually lives:

* *"The remaining twenty, measured"* and *"Y5 MOVED AGAIN"* — what each
  remaining file needs.
* *"Every remaining Y5 blocker is the same decision wearing different clothes"*
  — why the REPOINTS all wait on one product call, and *"CORRECTION: the seal
  work is NOT blocked"* — why the CAPABILITY they wait for does not.
* *"Who SEALS is a harder question than who verifies"* — the open design
  decision, with its three candidates costed.

**The bridge is no longer the bottleneck.** It loads an image, reports what the
image declares, registers a whole lazy archive, follows symlinks, writes through
a handle, and answers both halves of "are these bytes here?". Gaps 14 through 17
are closed. The module is at twenty entry points, unchanged across three
capability additions, because each was paid for by retiring a door rather than
by raising the ceiling.

The Y1 census is `docs/plans/2026-09-11-lane-y1-census.md`; the merge handoff
for what has landed is `docs/plans/2026-09-12-lane-y-merge-handoff.md`. **Two
of this lane's premises have since been corrected by measurement** — that the
builders are overwhelmingly recipes, and that the type-only importers repoint
one line each. Both corrections are below, and both matter more than the
increments they sit next to.

`images/vfs/scripts/*.ts` — 13,502 lines, and **36 files under `images/`
imported the TypeScript filesystem when this lane opened. Ten do now**
(2026-09-13), and `docs/surface-budget.json` holds the banked ceiling.

## What this lane is — as corrected by the census

> **CORRECTION 2026-09-12 — "overwhelmingly recipes" is right about most of
> these files and wrong about the two biggest.** The census reached that
> conclusion by measuring IMPORTERS, not by measuring what the files do.
> Measured by parse/verify density:
>
> | File | Lines | `digest`/`sha256`/`validate`/`Tar`/`Zip`/path-normalise sites |
> |---|---|---|
> | `staged-product-inputs.ts` | 1,975 | **50** |
> | `vfs-product-builder-contract.ts` | 952 | **55** |
> | `wordpress-preinstall.ts` | 921 | **0** |
> | `shell-vfs-build.ts` | 870 | 9 |
> | `build-lamp-vfs-image.ts` | 591 | 1 |
>
> `wordpress-preinstall.ts` proves the recipe claim exactly — 921 lines of
> product logic with no parsing in it. **`staged-product-inputs.ts` disproves it
> for the largest file under `images/`**, and it is LARGER than the recipe this
> lane holds up as its example. Its functions are `materializeTarEntries`,
> `materializeZipSource`, `commonArchiveRoot`, `stripArchiveRoot`,
> `normalizedArchiveComponents`, `readRepositoryPathBundle`,
> `assertExactInputInventory` — archive extraction, path-traversal defence and
> integrity verification **of untrusted input**. That is mechanism, not product
> configuration, and the kernel already has `crates/runtime-core/src/zip.rs`.
>
> **This is lane W's defect in a different directory.** `sessionKernelFormatParsers`
> targets 0 for "hand-written parsers of kernel-emitted formats... the kernel
> holds this data structured and the UI re-derives it with nothing binding the
> two". Here a TypeScript builder re-derives archive structure and integrity
> that a Rust reader already knows how to compute.
>
> **It also disposes of an open scope question rather than answering it.** Three
> pre-existing type errors were found by the new `images/` typecheck config, and
> the question raised was whether fixing them is in lane Y's scope. Two of the
> three are in this file, and one of them is `kind` staying `unknown` while a
> repository bundle entry is validated — **an unvalidated-input hole in
> integrity-checking code**. The answer is not to fix them in place. It is that
> the code they are in is a port target.
>
> **DECIDED BY THE MAINTAINER 2026-09-12: they become Rust tools.** *"If they
> require an ability to parse the VFS images, they will have to use rust now, so
> maybe they should just be rust-based tools."*
>
> **What they actually are**, since "parse/verify density" said how they behave
> and not what they are for:
>
> * **`vfs-product-builder-contract.ts`** (952 lines) — the contract for a
>   REPRODUCIBLE product build. Product identity, target ABI, exact source
>   pinning by git SHA and sha256, input descriptors, and the canonical
>   published URL form
>   (`.../products/<id>/sha256-<hash>/<name>-<n>.vfs.zst?sha256=…&bytes=…`).
> * **`staged-product-inputs.ts`** (1,975 lines) — the executor.
>   `buildStagedPlatformRootfs`, `buildStagedBrowserMainShell`,
>   `buildStagedSdkOrTestProduct` and siblings resolve declared inputs, verify
>   each against its digest, extract tar/zip archives into the image, and assert
>   an exact input inventory. Eight `build-*.sh` scripts call them.
>
> Together they are **the supply-chain layer of VFS image production**: pin by
> digest, verify, extract, publish content-addressed. That is a stronger reason
> to move them than "they parse images" — **they are the integrity boundary for
> image production**, the same family as lane S's unverified setuid bytes, and
> integrity checks written in the layer being deleted are checks with a
> shelf life.
>
> **It also moves lane Y's own gate.** Both files import `MemoryFileSystem` as a
> VALUE, and `staged-product-inputs.ts` is one of the seven middle-of-graph
> files that made the type-only repoint fail as a connected component. Porting
> them removes importers directly AND unblocks the repoint, rather than trading
> one for the other.
>
> **Shape:** an `xtask` verb, per the standing preference that new tools default
> to Rust with a thin shell wrapper. The `build-*.sh` scripts keep invoking it;
> what moves is the parsing, verification and extraction, not the decision about
> which products exist.

**Not a line-reduction lane.** The 13,502 lines are overwhelmingly *recipes*:
which packages go in the LAMP image, how WordPress is preinstalled, what dinit
services MariaDB declares. That is product configuration and it stays. The old
`imageBuilderTypeScript` target of 2,000 invited deleting exactly the wrong
lines — `wordpress-preinstall.ts` is 921 lines of product logic with nothing to
do with the format.

The lane is **decoupling**: goal V3 (one implementation of the format) and
unblocking lane V, which cannot delete `memory-fs.ts` while 36 files import it.

The builders need a real filesystem, not a tree-builder — **24 distinct
`MemoryFileSystem` methods**, led by `chmod` (31 calls), `stat` (17), `chown`
(17), `getLazyEntry` (10). But they touch the SFFS format at exactly **one
point**: every builder funnels through `saveImage` → `serializeImage` →
`fs.saveImage()`.

## End state

Images are produced by the Rust writer. Goal V3 is achieved by construction,
because the kernel and the builder share one implementation of the format
rather than agreeing to match. The recipes are untouched.

## The floor

Deciding *what goes in* an image is product configuration and stays.

**Writing the format is not floor, and the Rust side is nearly there already.**
`sffs_write.rs`, `sffs.rs` and `sffs_deferred.rs` between them already cover
`chmod`→`set_mode`, `chown`→`set_owner`, `symlink`, `mkdir`, `create_file`,
`create_deferred_file`, `link`, `set_times`, `stat`→`stat_ino`,
`readdir`→`read_dir`, `readlink`→`read_link`, `read`→`read_at`, and deferred
inspection.

**The genuine gaps are image-level, not filesystem-level**: `statfs` (derivable
from `Sffs::geometry`), image metadata get/set, lazy-archive import/export,
`rebaseToNewFileSystem`, `unlink`, plus three policy assertions
(`assertNoStaleWasmArtifacts`, headroom, capacity) and zstd compression. **Six
operations and three assertions**, against a lane scoped as though the whole
filesystem needed rebuilding.

**STATUS 2026-09-12: all six census gaps are closed or retired, and four of
them were retired rather than built.** That is the headline result of working
them, and it is worth stating before the list, because the lane was scoped as
six operations to implement:

| Gap | Outcome |
|---|---|
| `statfs` | **CLOSED** — `Sffs::statfs` reads the free counts from the superblock, which `geometry` deliberately does not carry (`b8d6c1c74`). |
| image metadata get/set | **CLOSED** — read as opaque bytes (`3b8bfc9f9`); the write side was already in the container writer. |
| `unlink` | **ALREADY PRESENT** in `rootfs.rs`; the census looked at `SffsWriter`, which is the serializer. |
| deferred inspection | **ALREADY PRESENT** — `Sffs::deferred_section`. |
| `rebaseToNewFileSystem` | **RETIRED** — a workaround for `SharedArrayBuffer`'s fixed `maxByteLength`; the Rust path picks capacity at serialization time (`fc88dec82`). |
| lazy-archive import/export | **RETIRED** — see immediately below. |

**Lazy-archive import/export is not a port, and lane S says why.** The archive
JSON is host-side PRODUCER metadata: the kernel reads the kernel-facing subset
from KLZY (and, under V5, from SDEF), never this section. Three facts settle
the ownership:

* **Integrity already exists here.** Lane S states it directly — "`LazyFileEntry`
  carries no integrity field. **The lazy archive types do**" — and
  `assertLazyIntegrity` is already called in three places. Lane S's defect is
  about lazy *files*, not archives.
* **Verification ownership is lane S's, not lane Y's.** Lane S's floor is
  explicit: the host performs the fetch because the network is its own, and
  "verification is not the host's".
* **S1 says the digest "belongs in lane V's SDEF record, not in JSON we are
  about to delete."** Porting `exportLazyArchiveEntries` and
  `registerLazyArchiveFromEntries` into Rust would be building on a section the
  campaign is removing.

So the Rust path carries the archive JSON **opaquely**, which the container
writer already does, exactly as it treats image metadata. The producer-side
manipulation of those entries is recipe logic and stays in TypeScript — which
is lane Y's whole premise about recipes.

**What this does NOT claim.** "Retired" means the Rust path does not need the
operation, not that the TypeScript is deletable today. The opaque-carry design
has to hold through Y5, and a builder that turns out to need to READ archive
entries through the bridge would reopen this.

**Two further gaps, found by Y2a on 2026-09-12 and NOT in the census's six**
(`docs/plans/2026-09-12-lane-y2a-grounding.md`):

* **Gap 7 — Rust can read the VFSI container but cannot write it.**
  `VFSI_MAGIC` occurs only in the reader (`sffs.rs`); `SffsWriter::finish`
  yields the raw SFFS body, not what a `.vfs.zst` holds. This sits *upstream*
  of the other six: no container writer means no production image, however
  complete the body writer is. Note V5 does not dissolve it — deferred metadata
  moves in-body as SDEF, but the image-metadata section
  (`VFS_IMAGE_FLAG_HAS_METADATA`) still needs a home.
* **Gap 8 — `SffsWriter` is append-only, and the builders read back
  mid-build.** Its whole mutator set is `mkdir`, `create_file`,
  `create_deferred_file`, `symlink`, `link`, `set_owner`, `set_mode`,
  `set_times`, `finish`: no `unlink`, no lookup, no read. But `readVfsBytes`
  does `stat`/`open`/`read` on the filesystem under construction, and
  `assertNoStaleWasmArtifacts` — the assertion Y3 must preserve — walks the
  whole image and reads every `.wasm` back out. **Roughly ten of the census's
  24 methods are read-back-during-build.** The gap is not six operations; the
  Rust side has a *builder* where the lane needs a *filesystem* — and
  `SffsWriter` must STAY a builder, because its append-only shape is what lets
  it emit a 249 MiB image the kernel cannot hold. **Answered 2026-09-12:** the
  filesystem already exists, dormant, in Phase 5's `tmpfs.rs` and `rootfs.rs`.
  See the decided entry above.

**`rebaseToNewFileSystem` is RETIRED, not ported — and the claim that it has
only test callers is wrong. 2026-09-12.**

Commit `1cb5008ad` states that `rebaseToNewFileSystem` "has **only test
callers**". It has **three production call sites**, all in the image builders:

* `images/vfs/scripts/shell-vfs-build.ts:399`
* `images/vfs/scripts/package-shell-vfs-build.ts:154`
* `images/vfs/scripts/build-php-test-vfs-image.ts:344`

All three do the same thing — restore a filesystem from a base image, compare
its capacity against the product profile, and rebase when they differ. Each is
guarded by that comparison, so it fires only on a mismatch, which is probably
why a search for live callers read as empty.

**The conclusion that rested on it still holds, for a better reason.** Rebase
exists because a `SharedArrayBuffer`'s `maxByteLength` is fixed at
construction: the TypeScript path restores an image, discovers the capacity is
wrong, and copies the entire tree into a new buffer. It is a workaround for a
property of the backing store, not an image-format operation.

The Rust path has no such constraint. Capacity is `SffsConfig.max_size_bytes`,
chosen when the writer is constructed at SERIALIZATION time — after all content
is known and with the product profile in hand. There is nothing to rebase
because the image is written with the right ceiling from the start.

**So the census's fourth gap is retired rather than implemented**, and the
instance-handle question is unaffected: rebase is the one API that holds two
filesystems at once, and the Rust path never performs it.

**Recorded rather than silently corrected** because a future reader checking
`1cb5008ad`'s reasoning will find the premise does not hold, and needs to know
the conclusion was re-derived instead of inherited.

**`rebaseToNewFileSystem` was a census open question and is now answered by
reading it** (`host/src/vfs/memory-fs.ts:4319`): it changes an image's
**capacity**, by snapshotting to a quiescent source and full-tree-copying into
a freshly created filesystem with a new `maxByteLength`, re-importing lazy
entries and lazy archives on the way. It is a capacity operation, not a format
one.

The lane text previously said three builders "write the format directly". **That
was wrong.** Only two files reach past `MemoryFileSystem` into
`sharedfs-vendor.ts`, and only for the constants `ENOENT`, `SFSError`, `S_IFMT`
and `S_IFREG`.

**And as of 2026-09-12 even that is stale, in the good direction:** no file
under `images/` imports `sharedfs-vendor` at all. Commit `c39d9d150` repointed
the last two at the `vfs-errors.ts` leaf and generated `FILE_MODES`, which
closes Y6 before the lane started. Every one of the 36 the gate counts is a
`memory-fs` import.

## Y4 status — the bridge exists and is blocked on V4, 2026-09-12

**Built and landed on `brandonpayton/lane-y-image-writer`:** a standalone
`crates/sffs-module`, **93,017 bytes with ZERO imports** — no import section at
all, not even `env.memory`. It links the real substrate (`rootfs.rs`,
`SffsWriter`, `sffs_container`) and exposes **18** `sm_*` entry points covering
the tree-construction and read-back halves of the builders' vocabulary, plus a
build script that verifies the zero-import contract and stamps a
closure-derived freshness key. A TypeScript bridge
(`images/vfs/lib/sffs-image-fs.ts`) presents them as a filesystem a recipe
recognises, and each `create()` yields an independent tree because each
`WebAssembly.Instance` owns its own memory and statics.

*(Counts and sizes above are measured, not estimated: an earlier revision of
this paragraph said 17 entry points and 93,326 bytes, both written from memory
rather than read.)*

**A V4 clarification worth keeping:** that export surface is wide — the
builders make 175 direct filesystem calls across 25 methods, so the bridge
meets the recipes where they are — and it costs the host floor NOTHING. Goal V4
counts what a new host must IMPLEMENT; this module implements zero and imports
zero. A wide surface no host ever sees is not host API surface.

**Validation state of the lane branch, 2026-09-12.** Recorded so the next
reader does not re-run a four-hour question.

*Green and verified:* `runtime-core` 2,130 + 6; `sffs-module` 21; the bridge 10;
the surface budget 79 (via the PINNED vitest — see H-10); all five committed
mutation specs in `perturb/`, 0 survived and 0 invalid.

*Not established:* that the branch leaves the suite baseline (35 files / 69
tests) unchanged. A full host-suite run in the lane worktree reached **77
failing files with ZERO lane-Y-adjacent**, and was stopped rather than
finished, because its dominant signal was **4,634 stale-artifact messages** —
the seeded tier predating lane G's `a745f262c`. The `kernel-*` failures were
separately verified to fail IDENTICALLY on a worktree carrying none of lane Y's
changes, so they are pre-existing.

*What a clean comparison costs:* `./run.sh setup` in the lane worktree, which
with worktree-local cache roots builds from source. That is hours of machine
time to confirm a number whose main confound is already identified, and it is a
maintainer call rather than a worker's.

**Blocked on:** lane V's V4 identity contract, above. The module can build a
tree and export a mountable image, but any image containing deferred content —
which is every production image — loses it at serialization. Tests pin both
failure modes.

**The bridge is built** (`images/vfs/lib/sffs-image-fs.ts`), and measuring what
it must actually present produced the most useful correction of the increment.

**The helper funnel needs THREE methods, not thirteen.** Every filesystem call
in `vfs-image-helpers.ts` sits in one of six functions, and four of them are
the assertions Y3 already moved to Rust, plus their two private helpers:

| function | methods | status |
|---|---|---|
| `readVfsBytes` | `stat` `open` `read` `close` | helper for the artifact assertion — **now Rust** |
| `walkVfsFiles` | `opendir` `readdir` `lstat` `closedir` | same — **now Rust** |
| `assertVfsImageHeadroom` | `statfs` | **now Rust** |
| `assertNoStaleWasmArtifacts` | `isPathDeferred` | **now Rust** |
| `walkAndWrite` | `symlink` `chmod` | genuinely needed, **both present** |
| `serializeImage` | `saveImage` | genuinely needed, ~~blocked on V4~~ **UNBLOCKED 2026-09-12 — V4 is closed** |

So ten of the thirteen exist only to serve TypeScript the Rust assertions
replace. **This stopped three unnecessary module entry points from being
built** — `stat`, `statfs` and `isPathDeferred` were queued as "the unblocked
remainder" and are not needed at all. That is the same mistake as porting
lazy-archive import/export into JSON the campaign is deleting, which lane Y
declined earlier and nearly repeated here.

**Consequence for the lane:** the independent work remaining is smaller than it
looked, and so is the unblocked portion. `chmod` and `symlink` exist; the rest
routes through `saveImage`, which waited on lane V. ~~Y5 cannot start before
V4.~~ **V4 CLOSED 2026-09-12, so Y5's blocker is gone** — an image the Rust
writer produces is now one the kernel loads back, deferred files intact.

~~What `saveImage` still needs is the container write itself.~~ **DONE the same
day** — `2ccb80699`, "The export emits a whole image, not a filesystem with no
wrapper". `sm_export_image_read` streams the whole VFSI container rather than a
bare SFFS body, and `SffsImageFs.exportImage()` drains it. Building the
container host-side would have made the host a second author of the format,
which is the defect V4 just spent four increments collapsing, in a new place.

**`sffsModuleEntryPoints` is now a banked surface at 19.** Its target is
deliberately NOT 0, unlike `forkModuleHostDriveEntries` (which lane F split
out of `forkModuleEntryPoints` on 2026-09-12): these are distinct
filesystem operations a builder performs, not fine-grained steps of one
operation a coarse entry could replace. The target is "does not grow without an
argument", and two entries were declined while building this — the archive
length rides in `sm_register_lazy_file` and the container in
`sm_export_image_read`.

~~What Y5 now needs before it can repoint anything: gap 10.~~ **Gap 10's format
half closed the same day** (`10b744a2a`), so an archive's digest has somewhere
to live and Y5 is not blocked by it. What remains of gap 10 is lane S's policy
call, which does not block the cutover — it depends on it.

**A caveat recorded rather than tidied:** the bridge's POSIX-shaped handle APIs
(`open`/`read`/`close`/`opendir`/`closedir`/`readdir`) serve only the two
helpers above, so they were justified by a measurement that counted
soon-to-be-deleted callers. They are cheap, tested and mutation-checked, and
`saveImage`'s eventual shape may want them — so they stay, but they are not
load-bearing for the funnel.

## Increments

- **Y1 — census.** Done.
- **Y2 — close the six image-level gaps. DONE 2026-09-12**, and four of the six
  were retired rather than built — see the status table above. Gap 7 (the VFSI
  container writer, which the census missed and which sits upstream of the
  others) was built.
- **Y3 — move the three policy assertions. DONE 2026-09-12.** All three sit
  with the writer in `crates/runtime-core/src/image_policy.rs`, each perturbed
  until it failed. `check_capacity` is cross-verified against the TypeScript
  reader on three shipped images.
- **Y4 — one bridge. BUILT, and no longer blocked. 2026-09-12.** A zero-import
  `crates/sffs-module` plus `images/vfs/lib/sffs-image-fs.ts`. Note the
  measured correction: the funnel needs **three** methods, not the 24 the
  census counted — see above.

  ~~`saveImage` is the only one missing, and it waits on V4.~~ **V4 closed and
  `saveImage`'s missing piece landed the same day**: `SffsImageFs.exportImage()`
  drains a whole VFSI container from the module, and
  `setImageMetadata`/`isDeferred` answer the other two things recipes ask. The
  module exports 19 entry points, banked as `sffsModuleEntryPoints`.

  **Two entry points were declined while building this, and the reasoning is
  the lane's, not incidental:** the archive's length rides in
  `sm_register_lazy_file` beside the member because a member is useless without
  it, and deferred-ness went into the `sm_lstat` record because whether a
  file's bytes are present is metadata about the file. The second mattered
  twice over — adding `sm_lazy_info` would have raised a ceiling banked one
  increment earlier, which is the shape the budget exists to catch.
- **Y5 — repoint the 36 files. NOT mechanical, and not a like-for-like
  repoint** — see "Y5 is V5's production cutover" below.
- **Y6 — replace the four `sharedfs-vendor` constants. ALREADY DONE**, by
  commit `c39d9d150` ("VFS: Generate errno and give the five constant-only
  consumers a leaf to import") — lane V's V7 landing. Verified 2026-09-12:
  **no file under `images/` imports `sharedfs-vendor` at all** any more.
  `dinit-image-helpers.ts` and `staged-product-inputs.ts` take `ENOENT` and
  `SFSError` from the `host/src/vfs/vfs-errors.ts` leaf, and `S_IFMT`/`S_IFREG`
  from generated `FILE_MODES`. **Lane Y therefore needs no `dump-abi` run and no
  ABI regeneration**: those constants are already in `host/src/generated/abi.ts`
  at lines 569, 572 and 1415.
- **The recipes are not touched**, and that is the point.

### Y5 is V5's production cutover, not a repoint — 2026-09-12

**The two writers already disagree about the image format, deliberately, and
lane Y is what resolves it.** Lane V's **V5** moves deferred-file metadata out
of the trailing JSON sections and into the body, as an SDEF section addressed by
a hidden inode. Verified in the tree:

* the **Rust** writer has it — `crates/runtime-core/src/sffs_deferred.rs`, the
  superblock field at `sffs_write.rs:69`, the section stored as an ordinary
  unlinked inode's data so no path lookup can see it;
* the **TypeScript** writer does not know the section exists — zero occurrences
  of `SDEF` anywhere under `host/src/vfs/` — and still emits the JSON trailer
  (`VFS_IMAGE_FLAG_HAS_LAZY`, `lazyLen`, `serializeLazyEntries` at
  `memory-fs.ts:4336`).

So **repointing the builders onto the Rust writer is what gives V5 a production
caller.** Until that happens V5 is Rust that ships no image — hazard H-1's exact
shape, in a campaign that has already found six dead floors. Y and V5 are one
piece of work; a schedule treating them as independent either ships a dead V5 or
migrates the builders twice.

The discarded alternative, recorded so it is not re-proposed: teach the
TypeScript writer SDEF first so both sides match, then repoint. That builds a
new feature into the file the campaign is deleting.

**CORRECTION 2026-09-12, same day, by measurement.** An earlier version of
this section said "a half-migrated corpus still boots … both readers are live",
citing `sffs_deferred::decode` via `sffs.rs:528`. **That was wrong, and wrong in
the way H-1 warns about.** `sffs.rs:528` is the *definition* site of
`Sffs::deferred_section`; a caller census finds its only callers are
`sffs_write.rs`'s own tests. Nothing in the boot path consults SDEF.

**So V5 has no production reader either, not just no production writer.** The
boot path in `rootfs.rs:1595` reads KLZY and *requires* it —
`None => return Err(Errno::EINVAL)`, with a comment that is explicit about why:
an image without the section cannot be distinguished from one whose lazy files
are recorded only in host-side JSON, so accepting it "would silently build a
tree where every deferred file reports size 0 — a wrong tree that looks like a
right one."

Two consequences were drawn from that, and **BOTH ARE NOW OBSOLETE — V4 closed
them the same day, 2026-09-12.** Left in place with their retraction rather than
deleted, because the first of them is a constraint a reader would otherwise
carefully preserve:

* ~~A Rust-written image must still emit KLZY to boot at all. The container
  writer (gap 7) therefore cannot treat KLZY as V5 residue to drop; emitting
  SDEF *instead* produces an image the kernel rejects.~~ **FALSE SINCE
  `4d0395357`.** `load_image_inner` reads SDEF as a linkage source when an image
  declares no KLZY, and `ContainerSections::kernel_lazy` is now an `Option`. A
  Rust-written image emitting SDEF alone boots. **Do not add KLZY emission to
  the container writer to satisfy this.**
* ~~Per-image landing is safe because the Rust writer keeps emitting KLZY.~~
  It is safe for a better reason now: an image may carry either description, and
  one carrying both is read from KLZY, so nothing about how an existing image
  loads changes.

~~V5 is therefore incomplete on both sides, and lane Y only closes the writer
half. Wiring the SDEF read path is lane V's.~~ **The read path landed** —
`load_image_inner` consults SDEF, `Sffs::deferred_section` has production
callers, and the round trip is tested end to end
(`an_image_the_kernel_exported_is_one_the_kernel_can_load`). SDEF is no longer
"carried but not consulted".

**What remains true, and is the point of this section:** V5 still has no
production WRITER. The TypeScript builders still emit the JSON trailer, and
repointing them onto the Rust writer is what gives V5 a production caller. Y5
is still V5's production cutover. What changed is that the cutover got simpler —
the Rust side no longer has to keep emitting a section it is trying to retire.

### What Y5 actually costs — half of it is one line each

**18 of the 36 importers use `import type` and never call the class.** Measured
2026-09-12. For those the coupling is the **interface type**, not the
implementation. The other ~18 carry the real call sites, and
`vfs-image-helpers.ts` is the funnel through which all of them reach the format.

**CORRECTION 2026-09-12, by measuring each file rather than the set.** The claim
above continued "and each repoints by changing one import once the bridge
exposes an equivalent type". That is true for most of them and **false for
five**, which matters because it is the difference between a mechanical pass and
a blocked one. Measured per file, the type-only importers are three tiers:

| Tier | Files | What they call on the filesystem |
|---|---|---|
| **Uses nothing** | 6 | Nothing at all — the type appears in a signature and is never dereferenced. `wordpress-source-layout`, `kandelo-demo-config`, `smtp-capture-helpers`, `main-shell-demo-config`, `derived-vfs-symlink`, `build-node-vfs-image`. |
| **POSIX subset** | 7 | `chmod`, `chown`, `stat`, `open`, `close`, `read`, `write` — all of which the Rust bridge already has or trivially can. Includes `wordpress-preinstall` (the 921-line recipe) and `build-lamp`, `build-wp`, `build-python`, `shell-runtime-layout`, `mariadb-image-helpers`, `spidermonkey-npm-runtime`. |
| **Needs surface that does not exist** | 5 | `saveImage` (`opcache-prewarm`), `getLazyEntry`/`isPathDeferred` (`dinit-image-helpers`, `demo-login`), `registerLazyArchiveFromEntries` (`shell-lazy-archives`), `exportLazyArchiveEntries` (`source-rootfs-shell-overlay`). |

**So 13 of the 18 repoint against one narrow interface and 5 do not**, and the
five are exactly the lazy-archive and save paths — which is the same boundary
every other measurement in this lane has landed on. That is a better result than
the original claim, not a worse one: it says which files are blocked and on
what, instead of promising a uniform pass that would have stalled five files in.

**Watch H-8 here.** Repointing a type-only importer at a neutral interface drops
the import count, which is what unblocks deleting `memory-fs.ts`. It does NOT
mean those files work against the Rust writer — the object passed to them is
still a `MemoryFileSystem` until the value-side call sites move. Low coupling is
not migratability, and the budget number must not be read as though it were.

### Taking option (b): the bridge gets the capability, the interface stays honest

**Decided in-lane 2026-09-12.** Of the two options below, (b) is not a scope
change — it is the lane's stated end state, and (a) is the shortcut that would
move the budget number without making anything migratable. Doing (b) is doing
the lane. The maintainer question that remains open is a different one: the
three pre-existing type errors in builder scripts (see the typecheck config).

**First capability: deferred-ness.** Two of the four recipes calling
`getLazyEntry`/`isPathDeferred` use the result only as a boolean, one reads
`size`, one reads inode identity. Those are real product assertions — *dinit
must be resident before service boot*, *the login program must be eager* — and
they were the only reason those recipes needed the IMPLEMENTATION rather than
an interface.

**It went into the stat record, not a new entry point, and that choice is the
point.** Adding `sm_lazy_info` would have made it the module's twentieth entry
point one increment after `sffsModuleEntryPoints` was banked at nineteen.
Raising a ceiling you set yourself, immediately, is exactly the shape the budget
exists to catch. The better design was available and is also more honest:
whether a file's bytes are present is METADATA ABOUT THE FILE, which is what
`lstat` reports — and `size` there was already the real length of a deferred
file rather than its stub, so the record was half-answering the question.
`sm_stat_size()` makes the record's length discoverable, so widening it costs
the bridge nothing. **Surface stays at 19.**

The fetch URL is deliberately not exposed. Nothing reads one through this path —
measured across all four call sites — and it lives in the deferred payload the
kernel carries without reading. Building an accessor for it would be a floor
nobody stands on (H-1).

### The funnel's last method: a headroom VERDICT, and a ceiling raised on purpose

**Decided in-lane 2026-09-12.** `vfs-image-helpers.ts` — the funnel every
builder reaches the format through — was blocked on one method, and which method
it got mattered more than that it got one.

`assertVfsImageHeadroom` reads `statfs`, multiplies free blocks by block size,
compares two numbers and formats a message. **Exposing `statfs` would have been
one line and would have moved a syscall rather than a decision**: the arithmetic
and the judgement would have stayed in TypeScript while the surface count looked
better. `image_policy::check_headroom` already performs that computation, so
what crosses the boundary is the verdict plus the numbers behind it. The caller
still formats, because a `no_std` policy owning its prose would force one
wording on every host.

The numbers come back whether or not the profile is met. `PolicyViolation`
carries them only on failure — right for a gate, wrong for a build script
printing "3.2 MiB free against 1 MiB required", and recomputing them across the
boundary would be a second implementation of the same arithmetic.

**`sffsModuleEntryPoints` raised 19 -> 20, deliberately**, with the argument in
the budget record rather than only in a commit message. The budget's rule is
that the surface does not grow WITHOUT AN ARGUMENT and its failure message
prescribes exactly this procedure. The argument: the host does strictly LESS,
and this was the last method between the funnel and an interface.

**Recorded because the process was wrong before the decision was right.** This
was deferred to the maintainer once, on the grounds that the ceiling had been
set by this lane eight increments earlier and raising your own ceiling deserves
a second opinion. That was over-cautious: the campaign's host-surface metric is
`hostImportFunctions` — what a new host must IMPLEMENT — and a module export the
host CALLS does not touch it. `sffsModuleEntryPoints` is a lane-local guard
against unwatched sprawl, and "grew with a recorded argument" is what it was
built to permit, not to prevent. **A gate that makes you stop and justify has
worked when you justify it; treating it as a veto is a different failure from
ignoring it, and no better.**

### How the funnel gets typed without growing the file being deleted

**Decided in-lane 2026-09-12, and the shape generalises to the rest of the
cutover.** Giving the bridge `checkHeadroom` is not enough on its own:
`assertVfsImageHeadroom` still CALLS `fs.statfs("/")`, and `MemoryFileSystem`
has no `checkHeadroom`. Declaring it required on `VfsImageFilesystem` would
break the implementation recipes are handed today.

The two obvious answers are both wrong, and one of them the budget already
rejected:

* **Give `MemoryFileSystem` a `checkHeadroom`.** That grows a file whose target
  is 0, and the surface budget refused exactly this move for `isDeferred`
  (8501 -> 8522). Adding capability to the thing being deleted is the shape this
  campaign exists to stop.
* **Put `statfs` on the bridge after all.** That reinstates the primitive the
  verdict replaced, and leaves the arithmetic on the host.

So the interface declares **both as OPTIONAL** — `checkHeadroom?` and `statfs?`
— and the helper prefers the verdict, falling back to computing it from `statfs`
for the implementation that cannot judge for itself, and failing loudly when
neither is present. Three properties make that the right trade for a cutover
rather than a fudge:

* it grows nothing in `memory-fs.ts`;
* the primitive stays off the bridge, so the Rust side never learns to answer a
  question it should be deciding;
* **the fallback branch is deleted WITH `memory-fs.ts`** rather than becoming
  permanent — and there is exactly ONE `fs.statfs(` call in the funnel, so that
  deletion is one site.

**The general rule for the rest of the repoint:** where the two implementations
genuinely differ in what they can answer, the interface carries both shapes as
optional and the caller prefers the better one. An interface that demands the
union forces capability into the doomed file; one that demands the intersection
forces the primitive onto the bridge. Optionality is what lets the two coexist
for exactly as long as both exist.

### Gap 13 — the bridge could not register the commonest kind of deferred file. CLOSED 2026-09-12.

Found while checking whether `registerLazyFile` could go on the builder
interface: `MemoryFileSystem.registerLazyFile(path, url, size, mode)` registers
a file fetched STANDALONE, and the bridge's registers an ARCHIVE MEMBER. They
are different operations, and the bridge had only the second.

**That is not the rarer case.** 79 files in the shipped shell image are
URL-backed singles, and it is exactly the shape lane S's setuid defect has —
`sudo` and `sudo-lite` are URL-backed, not archive members.

Two things made it unreachable, and both are the same mistake in different
places: **treating "deferred" as implying "from an archive".**
`sm_register_lazy_file` declared an archive unconditionally and
`declare_archive` refuses id 0 (correctly — 0 is the no-archive sentinel), so
every registration asserted an archive existed. The export then looked one up
for every deferred member and returned `EIO` when it found none.

Now `archive_id == 0` means through the bridge what it means everywhere else in
this format: no archive, no member path, and the payload is the whole of what
says where the bytes are. The linkage rule is enforced at registration, so a
half-specified one is refused where the caller can see it.

**This completes what lane S needs from the format side.** A digest for a
URL-backed setuid binary now has a home that survives load and export, through
the path a builder actually uses rather than only through the kernel's own
writer. Whether the digest is REQUIRED is still lane S's call.

**A method-name match is not an operation match.** The interface work found
this by comparing signatures rather than names — `registerLazyFile` on both
sides, doing different things. Worth remembering for the rest of the repoint:
the census counts what a file CALLS, and two implementations can answer the
same call differently enough that one of them cannot answer it at all.

**And the conflation is on OUR side, which makes it cheap to fix.** Measured
2026-09-12: both recipes that call `registerLazyFile` use the POSITIONAL form
`(path, url, size, mode)` — `build-perl-vfs-image.ts` and
`source-rootfs-shell-overlay.ts` — which is the standalone-fetch shape gap 13
just made reachable. The bridge's method of that name takes an object and
registers an ARCHIVE MEMBER, a different operation.

So the next increment is a naming correction rather than a capability: give the
bridge `registerLazyFile(path, url, size, mode)` matching what recipes call, and
name the object form for what it does — registering an archive member. **No new
module entry point**: both go through `sm_register_lazy_file`, which now handles
either case. That unblocks two of the nine remaining files **without the
headroom decision**, which is worth knowing because it means the funnel's
`statfs` is not the only thing left to do while that call is pending.

### What "importers to 0" actually costs: the bridge cannot load a base image

> **SUPERSEDED 2026-09-13.** All three blockers named below are now gone. The
> bridge loads an image (`sm_load_image`, `41ce154c2`); `getImageMetadata` reads
> what the image declared (`601a53169`); and `rebaseToNewFileSystem` dissolved
> into `setImageCapacity` rather than being ported, because it existed only to
> change a ceiling `MemoryFileSystem` bakes in at construction. **The one
> remaining blocker of the three is `verifyImportedLazyAtomicGroupSeals`**, and
> its obstacle is not a missing method but a carrier: the seal lives in the
> host-side lazy JSON the Rust loader walks past. The measurement below is kept
> because its reasoning about what "importers to 0" costs is still how the
> remaining eleven were sized.

**Measured 2026-09-12, and it bounds the whole repoint.** Three of the remaining
blocked files are DERIVED builders — `shell-vfs-build.ts`,
`package-shell-vfs-build.ts`, `build-php-test-vfs-image.ts`. They call
`getImageMetadata`, `rebaseToNewFileSystem` and
`verifyImportedLazyAtomicGroupSeals`, and the first of those reads what
`shell-vfs-build.ts` itself calls *"inherited shell image metadata"* — it comes
from a base image the builder LOADED, not from anything it set.

**`SffsImageFs` has no way to load an image.** `create()` makes an empty tree
and that is all; there is no `fromImage`. So a bridge `getImageMetadata` that
returned what `setImageMetadata` was given would be quietly wrong for exactly
the builders that need it — it would answer a different question and look
right.

The kernel HAS the capability: `rootfs::load_image` is what boots a machine. But
it takes a host byte-source callback, and a zero-import module cannot call the
host — so exposing it means a push-shaped path (write the image in, then
finish), which is at least two more entry points plus the streaming protocol
around them.

**So the reachable floor for `imageBuilderFilesystemImporters` is not 0 today,
and the gap is not the interface.** The repointable set is 29 of 37; of the
eight blocked, one is the funnel (`statfs`, one decision away), three are
derived builders needing image loading, one is a port target
(`staged-product-inputs.ts`), and three use lazy-archive APIs this campaign has
already retired.

Recorded so the budget's 0 target is read as what it is: the END of this lane,
reached through a capability increment nobody has scheduled, not through more
repointing.

**CORRECTION, same day, to something written two paragraphs up.** An earlier
version of this section lumped `verifyImportedLazyAtomicGroupSeals` in with "APIs
this campaign has already retired". **It is not retired anywhere**, and the
mistake is the kind that gets a check deleted. What the plan actually says is
that the atomic-group SEAL — the datum — travels opaquely in the deferred
payload alongside the URL, transport, digest and activation mode. The OPERATION
is sha256 cohort authentication of imported lazy groups
(`docs/plans/2026-09-09-k1-sffs-wiring-grounding.md`), and it is live.

So the retired set is `rebaseToNewFileSystem` (a `SharedArrayBuffer`
`maxByteLength` workaround the Rust path does not need) and the archive-entry
import/export pair (producer-side recipe manipulation of a section the kernel
carries opaquely). **`verifyImportedLazyAtomicGroupSeals` belongs with lane S
instead**: an integrity verification that currently lives in the TypeScript
filesystem, over data the Rust format now carries. Where it should run is that
lane's question, not a thing to drop on the way past.

### What the repoint actually costs, measured per file — 2026-09-12

**The importer count can reach 12 of 36.** Repointing the 24 files whose
measured method usage fits `VfsImageFilesystem` takes
`imageBuilderFilesystemImporters` from **36 to 12**. It does not COMPILE at that
point — the repointed files pass the interface into helpers still typed
concretely — but the reachable floor is now a number rather than a guess.

**The twelve that block it, and exactly what each needs.** Everything not in the
interface, by file:

| File | Needs |
|---|---|
| `vfs-image-helpers.ts` | `saveImage`, `statfs`, `symlink`, `opendir`/`readdir`/`closedir` |
| `shell-vfs-build.ts` | `saveImage`, `setImageMetadata`, `getImageMetadata`, `statfs`, `registerLazyFile`, `rebaseToNewFileSystem`, `verifyImportedLazyAtomicGroupSeals` |
| `package-shell-vfs-build.ts` | the same set |
| `build-php-test-vfs-image.ts` | `getImageMetadata`, `rebaseToNewFileSystem`, `statfs`, `symlink`, `verifyImportedLazyAtomicGroupSeals` |
| `build-source-rootfs-shell-image.ts` | `exportLazyArchiveEntries`, `readlink`, `verifyImportedLazyAtomicGroupSeals` |
| `source-rootfs-shell-overlay.ts` | `exportLazyArchiveEntries`, `registerLazyFile` |
| `shell-lazy-archives.ts` | `registerLazyArchiveFromEntries` |
| `shell-rootfs-restore.ts` | `verifyImportedLazyAtomicGroupSeals` |
| `opcache-prewarm.ts` | `saveImage` |
| `build-perl-vfs-image.ts` | `registerLazyFile` |
| `build-node-zip.ts` | `readlink`, `opendir`/`readdir`/`closedir` |
| `staged-product-inputs.ts` | (the port target) |

**Read by what it would take, that list is three groups, not twelve problems:**

* **The bridge ALREADY has them** — `symlink`, `readlink`,
  `opendir`/`readdir`/`closedir`, `registerLazyFile`, `setImageMetadata`. The
  interface can declare these today and stay honest. This alone unblocks
  `build-node-zip` and `build-perl-vfs-image`.
* **The bridge is missing them and they are small** — `statfs`
  (`Sffs::statfs` exists in Rust and is not exposed), `getImageMetadata`
  (`sffs::metadata_section` exists), and `saveImage`, whose BYTES come from
  `exportImage()` while the zstd and the file write stay host floor.
* **Already retired by this campaign** — `rebaseToNewFileSystem`,
  `exportLazyArchiveEntries`, `registerLazyArchiveFromEntries`,
  `verifyImportedLazyAtomicGroupSeals`. These are host-side lazy-archive
  producer metadata that the Rust path carries opaquely. The files using them
  keep the concrete type until their own disposition is settled — and one of
  them, `staged-product-inputs.ts`, is already a port target.

**So the next increment is not another repoint attempt.** It is growing the
interface to what the bridge already implements, then adding `statfs`,
`getImageMetadata` and a `saveImage` shape to the bridge. The repoint becomes
mechanical once the interface can honestly describe what a builder does.

### Gap 14 — a Rust-exported image cannot meet a product's declared capacity

**Found 2026-09-12 by a surviving mutant**, and larger than the defect that
exposed it. `build_export_image` derives `max_blocks` FROM the tree — the
ceiling and the size move together, plus a fixed 64-block slack — so:

* every exported image reports **exactly 262,144 bytes free**, however full it
  is, and
* a builder's declared `expectedMaxByteLength` **never reaches the export**.

The second is the gap. Builders declare a capacity per product, and
`assertVfsImageCapacity` checks the artifact against it; a Rust-exported image
would fail that check for every product, because the export chose its own
number. **The image also has no runtime growth room at all** — it is sized to
hold its contents and nothing more, where the TypeScript path builds into a
buffer of the declared `maxByteLength`.

**How it surfaced is the useful part.** A mutation replaced the headroom
measurement with `u64::MAX` and changed no outcome, because the figure was
decorative — the verdict came from a separate comparison. Fixing the measurement
to "ceiling minus occupancy" did not move the number either, and THAT is what
exposed the ceiling as tree-derived. Two layers of H-5, each hiding the next.

**The fix is a requested capacity on the export**, which is where
`expectedMaxByteLength` should arrive. It is not merely a parameter: the export
currently converges `max_blocks` and `data_start` in a loop against the tree, so
a requested capacity has to enter that computation as a floor rather than
replace it. ~~Not attempted here.~~ **Done in `05e07cc98`; see "CLOSED
2026-09-12" below.**

**It is a prerequisite for `assertVfsImageCapacity` against the Rust writer**,
and therefore for the sixteen builders that will construct `SffsImageFs` — which
puts it alongside image loading as what the export still owes. The module test
asserts the constant explicitly and names this gap, so the day capacity becomes
requestable the assertion fails and points at itself rather than silently
passing.

**CLOSED 2026-09-12** — `05e07cc98` "Let a builder declare the image it is about
to fill", and `7927abb0a` for the test that was wrong.

`set_image_capacity(bytes)` enters the convergence as a FLOOR:
`max(inode_requirement, 64, requested_blocks)`. A request below what the tree
already needs changes nothing, because an image that cannot hold its contents is
not a smaller image but a broken one. Zero clears it. It reaches the kernel on
`sm_set_image_options(capacity_bytes, ptr, len)` — renamed from
`sm_set_image_metadata` — so the surface stays at 20 rather than 21. **The
budget refused the 21st entry point and was right to**: capacity and metadata
are the same question, "what shape is this image".

**The floor/replacement distinction took a second surviving mutant to test
properly, and the reason is worth keeping.** A trial that replaced the tree's
requirement with the request outright stayed green against a one-file tree —
because the convergence loop directly below the max *already* re-raises the
ceiling to whatever the DATA needs. A floor and a replacement converge on the
same number there, and no assertion on that tree can separate them. The half the
loop does not recompute is the INODE requirement, which the comment four lines
above the mutation site already named. A hundred empty files need 408 blocks for
inodes and almost none for bytes; under the replacement the writer runs out of
inodes and the export returns ENOSPC.

**The general lesson: a guard placed next to a self-correcting loop is testable
only on the input the loop does not correct.** Picking the smallest tree that
exercises a code path is the usual instinct and it was exactly wrong here.

Evidence: `perturb/runtime-core-rootfs-export.json` — 31 trials, 0 survived, 0
timed out. runtime-core 2162 passed, sffs-module 29 passed, wasm32 build clean,
host surface budget 81 passed, entry points 20.

**`assertVfsImageCapacity` against the Rust writer is now unblocked.** What the
sixteen builders still lack is image loading, below.

### Next: bridge image loading, at no cost to the surface

**Scoped 2026-09-12.** Sixteen of the remaining twenty importers CONSTRUCT a
filesystem; they stop importing `memory-fs` when they construct `SffsImageFs`
instead. For the derived ones that needs the bridge to load a base image, which
it cannot do at all.

**Shape: one entry point, not three.** A zero-import module cannot call back
into the host for bytes, so the obvious design is a push protocol —
begin/write/finish — and that is three exports. It is unnecessary: the host
already has `sm_alloc`, so it allocates, copies the image in, and calls
`sm_load_image(ptr, len)`. One export. The loader needs the image randomly
addressable (it walks directories and inodes), so streaming would not help
anyway.

**And it costs nothing, because one export can go.** `sm_stat_size()` exists
only to report the `sm_lstat` record's length — a whole export for a constant.
`sm_read_dir` already answers its own size question by being called with
`out_len == 0`, and `sm_check_headroom` copies that convention. Making `sm_lstat`
do the same deletes `sm_stat_size` and makes the ABI carry ONE size-probe
convention instead of two.

So: `sm_load_image` in, `sm_stat_size` out, surface stays at 20. **That is a
better trade than a ceiling raise even if a raise would be defensible** — the
argument for growth is strongest when you have first looked for what can shrink,
and an export that returns a constant is exactly what to look for.

**LANDED 2026-09-12** — `41ce154c2` "The kernel can load an image, including one
it wrote itself", with the trade exactly as scoped: `sm_load_image` in,
`sm_stat_size` out, surface 20 either side.

**Both halves had to be one commit**, and the reason is worth keeping: landing
the deletion alone would drop the count to 19, and the budget would then require
banking 19 and raising the ceiling back to 20 — the move nobody is allowed to
make. A net-zero trade has to arrive net-zero.

**Ownership transfers on success and only on success.** A loaded image hands out
`BaseSource::Image` nodes, each a promise the kernel can come back for those
bytes later, so the module keeps the buffer rather than copying it — `lamp.vfs`
is 249 MiB and a copy means both resident at once in a 32-bit address space. On
failure the module has not adopted it and the host still owns what it allocated,
because **a caller that must read a return code to know whether it still owns
memory will eventually get it wrong, and the safe direction to be wrong in is
"the host frees what it allocated"**.

**Two byte sources stopped being hardcoded `EIO`.** `sm_read_file` reads a base
file out of the image it came from, and `sm_export_image_read` carries base
content into a derived export. That is what made the two trials held out since
V4 killable — `perturb/deferred-until-v4.json` is retired and its trials are in
`sffs-module-abi.json`, which is the green contract its handoff named as the
definition of done.

### Y5 MOVED AGAIN: importers 20 -> 11, banked. 2026-09-13.

`4e4948506`. The nine that needed nothing new now construct `SffsImageFs` and
declare their capacity. **The `SharedArrayBuffer` disappeared with the concrete
class** — it was never anything but the old constructor's first argument, which
is what a repoint is supposed to reveal.

**The method was: repoint ONE recipe and read the type errors.** Three earlier
attempts repointed many and drowned. One recipe named three missing things in
order, each a small decision rather than a guess:

* **`stat`** — the bridge had only `lstat`. It follows symlinks IN THE BRIDGE
  rather than through a new module entry point, because a builder wanting the
  link itself already has `lstat` and an entry point differing only by a boolean
  is a second spelling of one question.
* **`write`** — read-modify-write, since the module addresses whole files. Not
  the quadratic cost it looks like: `writeVfsBinary` hands over the entire
  remaining buffer in one call. **Adding it exposed that `open` had been
  ignoring its flags**, which was not harmless — every recipe opens
  `O_WRONLY|O_CREAT|O_TRUNC`, so a second build writing a shorter file over a
  longer one would have kept the old file's tail, and the image would build,
  mount and boot containing bytes nobody wrote.
* **The stat TYPE narrowed.** `StatResult` obliges an implementation to supply
  `dev`, three timestamps, `generation`, `linkCount` and `dataSequence`. A
  census of every builder found `mode` read 24 times, `size` 13, `ino` 4, `uid`
  and `gid` twice, and **not one read of a timestamp or a device number**. The
  way to supply a time the image does not record is to invent one. Same
  judgement as `readdir` returning `{ name }`.

**`ino` stays `number | bigint`.** Narrowing it to `number` typechecked the
bridge and broke the incumbent in **three hundred** places — the interface being
told which of its two implementations it is allowed to describe. Recorded
because the instinct to tighten a type is usually right and was wrong here.

**Typechecking proves the methods exist, not that they work.** Seven tests drive
them the way a recipe does, through `writeVfsBinary` itself, plus the
position-past-EOF zero fill, the cursor, symlink following, relative resolution,
and a cycle refused rather than followed forever. The images typecheck is back
to its 9 pre-existing errors, none in a file this touched, two of them in the
supply-chain port targets.

### One of the five methods dissolves, and two collide with the entry-point budget

**Studied 2026-09-13, before writing any of them.**

**`rebaseToNewFileSystem` should not be ported. It should disappear.** Its own
doc says what it is: *"Copy this filesystem into a freshly formatted SharedFS
whose superblock records `maxByteLength` as its growth ceiling."* It exists
because `MemoryFileSystem` bakes its ceiling in at construction, so the only way
to change a declared capacity is to copy the whole filesystem. All three callers
do the identical dance — read `statfs`, compute `blocks * bsize`, compare,
rebase — and `build-php-test` rebases only when the base is SMALLER than wanted.

**That is exactly `setImageCapacity`'s floor semantics**, which raise a ceiling
and never shrink one. The Rust export computes its ceiling at export time rather
than at construction, so there is nothing to rebase: the three call sites become
one call and no copy. Gap 14 did not merely unblock the capacity assertion — it
removed a whole-filesystem copy from three product builds.

**Two of the remaining four want a read-back path the module does not have**,
and that is where the next real decision sits:

* **`getImageMetadata`** (6 call sites) reads back what `setImageMetadata`
  stored. For a LOADED image that metadata comes from the image, so the bridge
  cannot answer it from anything it kept — it needs the module to say.
* **`exportLazyArchiveEntries`** (4 call sites) enumerates deferred entries and
  their URLs. In SDEF terms those URLs are the PAYLOADS, which the kernel holds
  and no entry point exposes.

**The budget refused a 21st entry point once already** (capacity, which became
the fifth field of the headroom record). The same answer may not fit twice, and
inventing a get-or-set entry point to dodge the count would be the count
gaming the design rather than constraining it. **Named here as a decision to
make deliberately when reached, not to slide past.**

`registerLazyArchiveFromEntries` (1 call site) is the bulk form of the bridge's
existing `registerArchiveMember` and needs no new capability.

### Gap 17 — setting a capacity after a load wipes the metadata the load restored

**Found 2026-09-13 while designing the read-back, and it is created by the
interaction of two things that are each individually right.**

`sm_set_image_options(capacity, ptr, len)` carries BOTH settings, because
capacity and metadata are the same question — "what shape is this image" — and
folding them kept the module at twenty entry points. The consequence is that
setting one means re-sending the other, so the bridge keeps a `lastMetadata`
replay buffer and `setImageCapacity` re-sends it.

That is sound while the bridge is the only author of the metadata. **Gap 16
made it false**: after a load, the KERNEL holds the base image's metadata and
the bridge's replay buffer still holds `null`. So:

1. `loadImage(base)` — the kernel now has the base's `kernelAbi`
2. `setImageCapacity(X)` — the bridge replays `null`, and the kernel clears it

**The recipes do exactly this pair.** `build-php-test` and the shell builders
load a base and then size the derived image, which is the sequence that loses
the declaration the very same session restored.

**The fix belongs with the read-back**: after a load, refresh `lastMetadata`
from the module, so the replay buffer means "what the module currently holds"
rather than "what this bridge last sent". That is the only moment it can change
behind the bridge's back, so it is the only moment it needs refreshing.

**The alternative — a "leave it alone" signal distinct from "clear it" —** was
rejected: clearing metadata is legitimate and must stay expressible, and a
sentinel that makes one argument mean three things is the semantic-surface
increase this campaign keeps warning about.

**Worth noting how it was found.** Not by a test — by reading `lastMetadata`'s
definition while designing something else and asking what it would answer after
a load. A cache with one writer is safe until a second writer appears, and gap
16 made the kernel that second writer.

### The metadata read-back pays for itself by retiring a door that was never used alone

**Decided 2026-09-13.** The maintainer approved a 21st entry point with the
ceiling raised (*"1 is fine… try hard not to need 2 or 3 but take them if you
need them"*). Trying hard first found something better, and the honest test for
whether it is better — *would I do this if the budget did not exist?* — says yes.

**What the builders actually need.** All six `getImageMetadata` call sites are
VALIDATIONS, not inheritance: each reads `kernelAbi` (one also reads
`abiSnapshotSha256`) to refuse a base whose ABI is not the one expected. So gap
16's automatic carry-forward does not remove them — the builder genuinely needs
the bytes back.

**It hands back BYTES, and TypeScript parses them.** The kernel deliberately does
not parse this JSON: `sffs.rs` says teaching the kernel crate to parse JSON for
three fields it does not act on "would buy a parser's attack surface for
nothing", and a Rust reader that parsed and re-serialized would silently drop
every field it did not know. **This is not option 3.** TypeScript parsing a JSON
document TypeScript authored is not TypeScript decoding the container layout —
the latter is gap 11's hazard, the former is the metadata section working as
designed.

**And the 21st slot is paid for by folding `sm_init_root` into `sm_reset`.**
Both bridge call sites of `sm_reset` are immediately followed by
`sm_init_root`, and nothing anywhere resets without initialising a root — the
module has no usable state between them, because a filesystem with no root fails
every path operation. **Two doors for one transition**, which is exactly the
redundancy that retired `sm_stat_size`.

So: `sm_image_metadata` in, `sm_init_root` folded away, surface stays at 20 and
the approved ceiling raise goes unused. **Recorded with its reasoning rather
than only its result**, because "the budget prompted the look" and "the
redundancy was real" are different claims, and only the second justifies the
change.

### Capacity is a declared ceiling, never an allocation — maintainer, 2026-09-13

> *"An image of capacity X should only take the size of its contents in memory
> when loaded. It should not take X in memory right away unless it is filled to
> capacity X already."*

**This is the invariant gap 14 has to keep, and gap 16's capacity restore must
not break.** The export already separates the two numbers: `total_blocks` is
`min(max_blocks, data_start + data_blocks + 64)` — sized to the CONTENT — while
`max_blocks` carries the declared ceiling into `max_size_bytes` and
`growable_to_bytes`. A declared capacity moves the second and not the first.

**The property held and was not asserted**, which is how it would have been lost.
The capacity test declares 64 MiB and passes only because `drain_export` gives
up past 4 MiB — so a regression would have shown as a confusing drain failure
rather than as the statement "declaring room is not occupying it". It is now
said out loud.

**The one cost that IS proportional** is the metadata region: a larger
`max_blocks` means a larger block bitmap and inode table, because
`total_inodes = max_blocks / 4`. For a 256 MiB declaration that is about 2 MiB
of inode table — under one percent, real, and the honest answer to "only the
size of its contents" rather than a claim of exactly zero.

**It constrains the gap 16 fix too.** Restoring a loaded image's declared
capacity must restore the CEILING, not preallocate the room: an image declaring
256 MiB whose tree is 3 MiB must load, and re-export, at roughly 3 MiB.

### Gap 16 — loading an image drops the metadata it was carrying

**Found 2026-09-13 while designing `getImageMetadata`, and it is the same family
as gap 15.** `rootfs::image_metadata` is written ONLY by `set_image_metadata`
and read ONLY by the export. `load_image_inner` does not mention metadata once.

The container carries a `metadataJson` section — `version`, `kernelAbi`,
`createdBy`, flagged `1<<2` — and the loader walks straight past it on its way
to `KLZY`. So a derived build that loads a base image and re-exports emits
whatever the builder happened to set and nothing the base declared. **The base's
stated kernel ABI does not survive being loaded.**

**A caller already depends on exactly that value.**
`build-php-test-vfs-image.ts` reads `fs.getImageMetadata()` to raise *"PHP test
base product ABI differs from its target"*. Ported onto the Rust writer as
things stand, that guard would be asking a question the filesystem could no
longer answer — an ABI check reading an empty answer, which is worse than no
check because it looks like one.

**The fix is a `metadata_span` beside `kernel_lazy_span`,** which already walks
these sections; the metadata span is the same walk stopping one section earlier.
The loader then keeps what it found, exactly as it now keeps deferred payloads.

**Ordering matters here.** `getImageMetadata` cannot be a truthful bridge method
until the kernel HAS the metadata to report, so gap 16 comes before the
read-back decision rather than after it — otherwise the first thing the new
entry point would do is return nothing, correctly, for every loaded image.

**It is not only the metadata. The declared CAPACITY is dropped the same way.**
`image_capacity_bytes` is written only by `set_image_capacity` and read only by
the export; `load_image_inner` never sets it. So an image that declares 256 MiB
of room, loaded and re-exported, comes back sized to its own tree.

**The TypeScript side already has a method named for this problem.**
`MemoryFileSystem.fromImagePreservingCapacity` exists, reads the SFFS
superblock's capacity, and restores with it — a name that is evidence somebody
needed exactly this and solved it on the host side. The Rust loader should not
need a second "preserving" variant: **a load preserves what the image says about
itself, or it is not a load.**

The capacity fix is smaller than the metadata one, because `Sffs::mount`
already gives `growth_ceiling_bytes()`. The loader has the number in hand at the
moment it records the image geometry; it simply does not keep it.

**Together these turn three static TypeScript entry points into ordinary
loading:** `fromImage`, `fromImagePreservingCapacity` and `readImageCapacity`
all become `loadImage` plus the readers the bridge already has. `readImageMetadata`
is the one that still needs the read-back decision.

### The seal verifier is built and verified, and five survivors taught it

**Landed 2026-09-13**: `63c43c028` (codec and verifier), `8731ad369` (the five
tests that were missing), `dee51ba4b` (its own perturbation spec). **Ten trials,
zero survivors.** `sha2` is linked and **the zero-import contract still holds** —
verified by the build's own `wasm-objdump` check, not asserted.

**The five survivors are the part worth keeping.** Half the trials survived the
first run, and not one of them was a bug in the verifier: each was a TEST
passing on a different check than the one it named. In a verifier that is the
most dangerous shade of green — the suite reports coverage while four of six
refusals are load-bearing nowhere.

Each survivor named the attack its check is the only defence against:

* **Re-sealing.** Dropping a member is caught by the cohort digest, because the
  digest covers the member list. Dropping a member *and re-sealing the
  remainder* is not — the result is internally perfect. What still says a member
  is missing is the count the ORIGINAL seal declared. The count check is not
  belt-and-braces; it is the only thing standing there.
* **Two archives never sealed together**, each individually valid, which only
  the cohort digest refuses.
* **One archive listed twice under one name**, with the identity recomputed over
  that list: it satisfies its own count while the second archive does not exist.
* **Length prefixes.** Without them the identity's fields run together and two
  different cohorts serialise identically — `"a"+X+"bc"+Y` versus
  `"ab"+P+"c"+Y`, same id, same count, nothing else to separate them. The test
  constructs that collision rather than asserting a prefix exists.
* **Domain separation**, which is structural, so its test is structural.

**The general lesson, and it generalises past this lane:** when several checks
can refuse the same input, a test that merely asserts refusal proves nothing
about WHICH check refused. Mutation testing is what tells them apart, and until
it does, redundant-looking checks and load-bearing ones are indistinguishable
from the suite.

### Three path rules disagree about a backslash, and the port must decide rather than transliterate

**Measured 2026-09-13, before touching the second port target.** "Is this path
safe" is answered three times in this repository, and the three answers are not
the same:

| rule | where | backslash | NUL | length cap | trailing `/` |
|---|---|---|---|---|---|
| archive entries | `xtask archive_paths` (Rust, ported) | **refused** | refused | none | stripped |
| manifest paths | `vfs-product-builder-contract.ts` (port target) | **a separator** | not checked | 4,096 | not stripped |
| lazy archive members | `host/src/vfs/lazy-archive-paths.ts` (shared) | **refused** | refused | `maxPathBytes` | not stripped |

Some of the differences are legitimate context: an archive entry spells a
directory with a trailing slash and a mount prefix is absolute where the others
are relative. **The backslash is not.** Two rules refuse `a\b` outright; the
third SPLITS on it, so `a\b` becomes two components and is accepted. On POSIX
that string is one legal filename containing a backslash — so the two treatments
do not merely differ in strictness, they disagree about what the path IS.

**Neither is obviously wrong**, which is exactly why it must be decided rather
than transliterated. Refusing is safer and may reject a legitimate filename;
splitting is Windows-compatible and turns one name into two components. A port
that copies the existing behaviour faithfully would carry the disagreement into
Rust and make it permanent.

**NUL is not checked at all by the manifest rule.** That one is not a judgement
call: a path is eventually handed to a C API, where NUL truncates it, so a
manifest naming `a b` would validate here and mean `a` there. Whatever is
decided about backslashes, this is a gap to close in the port.

**Recorded before starting rather than discovered during**, because the moment
to notice that three implementations disagree is before a fourth is written.

### The cutover landed, and I was wrong to defer it

**2026-09-13, `1cf5aaec7`.** I had written that the cutover "wants a session
that can exercise a real product build". That was an assumption, and checking
beat it: `host/test/staged-product-inputs.test.ts` imports the module directly
under vitest, so the seam is testable here. **The contract says a missing
artifact is a step away rather than a boundary; the same applies to a missing
test path.**

`materializeExactArchive` now spawns `xtask archive-extract-tree` and the
TypeScript tar reader, zip reader, zstd path, traversal rules and writes are
deleted: **1,975 lines to 1,816**. Piped rather than written to a temporary
file, because the caller sometimes holds its archive as bytes read out of a VFS
image.

**I almost shipped it covered by tests that never run it.** The four existing
tests passed immediately — and every production caller of the changed function
lives inside a `buildStaged*` product function no unit test reaches. That is the
same trap this lane has been naming all session, arriving on my own change. Two
tests now drive the seam, and two more trials were only killable after a third
test exercised the `--strip-root` / `--expect-root` plumbing that nothing else
reaches.

**Writing them found a defect in the cutover.** `cargo run` writes its own build
warnings to stderr, so reporting the FIRST line reported somebody else's warning
about an unrelated crate as the reason this archive was refused. The last
non-empty line is the extractor's own sentence, which names which rule fired and
for which member.

**One parity detail, preserved deliberately.** `tar -C dir .` writes entries as
`./bin/tool`, and a `.` component is refused — by the Rust extractor and by the
TypeScript it replaced, identically. The fixture names its entries explicitly
rather than papering over behaviour both implementations share.

**Seam trials: 4 of 5 killed, the fifth removed after measurement.** A spawn
that never ran reports `status: null`, and `null !== 0`, so the status check
throws with or without the `result.error` branch — it changes the SENTENCE, not
the outcome. The branch stays because "spawn cargo ENOENT" and "exit null" send
an operator to different places; the trial goes because no test can tell them
apart.

### The port's Rust half is done and defended: `xtask archive-extract-tree`

**2026-09-13.** Three formats dispatched by MAGIC (gzip tar, zstd tar, zip),
stdin via `--archive -`, traversal and links refused, bounds enforced on both
paths, staging directory at `0o700`. **Path rules 10 of 11 trials killed** (the
eleventh removed as provably subsumed); **extractor 13 of 13**.

**Two parity gaps came from reading the TypeScript, not from a failing test** —
which is the only way either could have been found. Mine dispatched on nothing
and assumed zip, so a `.tar.gz` would have been read as a zip and failed
confusingly rather than truly. And mine took the umask's permissions for the
staging directory where the TypeScript takes `0o700`, leaving the tree
world-readable for the whole time it is being populated.

**Three survivors, three lessons that generalise past this lane.**

**A test can pass because its FIXTURE could not express the case.** The setuid
narrowing was "tested" by asking the `zip` crate for mode `0o104755`; that crate
masks to `0o777` on write, so the archive carried `0o755` and the assertion was
true for a reason unrelated to the code. Recorded as **H-14**.

**Duplicated logic needs duplicated tests.** The tar path carries its own
entry-count and expanded-size checks, because it streams where the zip path
reads a central directory. The bounds test used a zip and therefore defended
half the code while the suite reported coverage.

**A memory bound cannot be tested with a finite fixture.** `.take(limit + 1)`
looked redundant beside the length check — five bytes exceed a four-byte limit
whether or not the read was bounded — but it is not deciding whether the archive
is too big. It is stopping the process reading a hostile stream INTO MEMORY
before finding out. Only a stream that never ends can observe that, so the test
uses one that notices being over-read and fails in milliseconds rather than at
the harness's fifteen-minute timeout.

**And one trial was nearly shipped knowing it would survive**, because no unit
test can hand the process a stdin. The read moved into `read_bounded` instead.
The precedent for documenting an unkillable mutant applies when code genuinely
cannot be reached — **not when it can be made reachable by putting it somewhere
a test can call.**

**Next: the cutover.** `materializeExactArchive` calls the verb and the
TypeScript extraction is deleted. The seam is settled — `shell-vfs-build.ts`
already spawns `cargo run -p xtask`, so the precedent exists, and `--archive -`
means the caller that holds its archive as bytes from a VFS image needs no
temporary file. **It changes a production build path**, so it wants a session
that can exercise a real product build rather than the tail of one that cannot.

### The supply-chain port: `staged-product-inputs.ts` is two files in a trench coat

**Started 2026-09-13** on the maintainer's reorder, `32bf6535e`.

**The census framing needed one more cut.** This file is not "mechanism" — it is
a PRODUCT half (`buildStagedPlatformRootfs` and its five siblings, which wire
products together) and a MECHANISM half (archive extraction and path-traversal
defence over untrusted input). Only the second ports; the first is recipe and
stays. Reading it as one unit would have ported product configuration into Rust
for no reason.

**The rules landed first because they are pure and they are the dangerous part.**
An archive entry names where its bytes will land, and these refuse any name that
could land them elsewhere. `..` is REFUSED rather than normalised away —
rewriting it silently relocates an entry, and a build cannot notice that.

**Not yet called, and the file says so.** The half that calls them — an `xtask`
verb extracting a whole tree, with the atomicity and bounds
`archive-extract-member` already models for one member — is the next increment.
The `allow(dead_code)` names it, so it is removed by the change that makes it
false rather than by someone tidying.

### MAINTAINER DECISIONS, 2026-09-13: rebuild the bases; start the port now

**1. No legacy seal verification. The shipped bases are rebuilt through the new
producer.** This settles the question that gated five of the ten remaining
importers, and it settles it the way `docs/agent-guidance/abi.md` argues: a
stale artifact fails loudly and is rebuilt rather than shimmed.

What it means concretely:

* **Nobody reproduces JavaScript's `JSON.stringify` in a `no_std` crate.** The
  cohort identity is a byte layout defined once, in Rust, and there is no second
  canonical form to keep in step.
* **The seal verifier only ever authenticates images the new producer wrote**,
  which is the honest scope and no longer a limitation to apologise for.
* **The five blocked builders are unblocked by a REBUILD, not by more code.**
  Their base images must be produced through the repointed path before they can
  repoint themselves — so the ordering is: seal capability, then bases rebuilt,
  then those five.
* An image sealed the old way is not "unsupported" so much as **superseded**:
  the kernel could never read those seals, so nothing is lost that the Rust path
  ever had.

**2. The supply-chain port starts NOW, ahead of the constructor repoints.** The
original ordering put it after them; those repoints are exactly what is waiting
on the rebuild, so holding the port behind them would idle the lane for no
benefit.

`staged-product-inputs.ts` (1,975 lines, 50 parse/verify sites) and
`vfs-product-builder-contract.ts` (952, 55) are archive extraction,
path-traversal defence and integrity verification **of untrusted input** —
mechanism rather than product configuration, which is what the census
correction established and what makes them a port rather than a repoint.
`crates/runtime-core/src/zip.rs` already exists.

### CORRECTION: the seal work is NOT blocked, and I treated a question as a veto

**2026-09-13.** I flagged `needs-maintainer` claiming everything reachable was
blocked on the legacy-seal product call. That was wrong, and the loop prompt
names the failure exactly: *a gate that makes you stop and justify has worked
when you justify it; treating it as a veto is a different failure from ignoring
it.*

**The new-path seal is required under BOTH answers.** If the shipped bases are
rebuilt through the new producer, an `SDEF`-carried seal verified in Rust is the
whole job. If legacy images must also verify, it is still the whole job plus a
compatibility path. **Nothing about it waits on the decision.** What waits is
only whether a SECOND, legacy path is also needed — and that question is
answered better once the first one exists.

The entry below (*"every remaining blocker is the same decision"*) is correct
about the REPOINTS and wrong as a description of the lane's reachable work. The
repoints wait; the capability they wait for does not.

### The seal's payload layout, and why the descriptor and the seal are separate

**Designed 2026-09-13. Lane V's call, recorded with its reasoning.**

What the incumbent seals, measured rather than assumed: a `LazyAtomicGroupMembership`
is `{ id, member, descriptorSha256, expectedCount, cohortSha256 }` and hangs off
each lazy ARCHIVE group — so a cohort "member" is an archive, not a file, and a
cohort is a set of archives that must activate together or not at all.

Verification is three checks and no more:

1. every archive in a cohort digests to its declared `descriptorSha256`;
2. the cohort's archive count equals `expectedCount`;
3. the cohort identity digests to `cohortSha256`.

**The payload therefore has two halves, and they must not be one.** The
descriptor is what gets digested; the seal carries the digest. A payload that
mixed them would be self-referential — a digest over bytes containing itself —
so the layout separates them explicitly:

```
u32 version | u32 descriptor_len | descriptor bytes | u8 has_seal | [seal]
seal: u32 id_len | id | u32 member_len | member
      | u32 expected_count | 32-byte cohort_digest | 32-byte descriptor_digest
```

The descriptor half stays whatever the producer writes — today a small JSON
object naming the URL and the archive's content digest — and **the kernel still
never parses it.** The seal half is parsed by the VERIFIER, which is
consumer-side, exactly as `sffs_deferred`'s doc requires: *whoever fetches
decides whether a URL may be fetched, validates the digest, and honours the
activation mode.*

**A defined byte layout rather than `JSON.stringify`.** The incumbent's cohort
identity is literally `JSON.stringify({schema:1,id,members:[…sorted]})`, which a
Rust verifier of EXISTING images would have to reproduce byte-for-byte. Writing
the canonical form as a LAYOUT removes that hazard at the root: there is no
serialiser to imitate and no escaping rule to get subtly wrong, because the
canonical form is the format.

**Where the verifier runs: inside the load, not beside it.** The obvious design
is a `sm_verify_seals` entry point the builder calls. Better is to verify as
part of `sm_load_image`, and the reason is not the entry-point budget:

* the incumbent's whole "await this before synchronous metadata inspection or
  filesystem rebasing" contract exists because `SubtleCrypto` is a promise. A
  synchronous Rust digest has no such contract to preserve;
* a separate verify call is a call a builder can FORGET. Verifying during the
  load makes an unverified loaded image **unrepresentable**, which is stronger
  than any amount of remembering;
* it costs no entry point, so the maintainer's approved ceiling raise stays
  unspent for a third time.

**What it costs:** a `no_std` sha2 in a module that has none, and a load that
refuses an image whose seals do not authenticate. The second is the point.

### Who SEALS is a harder question than who verifies, and it is scoped separately

**Reached 2026-09-13 while staging the integration.** Verification is settled:
consumer-side, inside the load, synchronous. Production is not, and the
difference matters because a seal written in the wrong place gives two
implementations of one canonical form — the exact hazard the byte layout was
chosen to remove.

Three candidates, with what each costs:

* **The TypeScript bridge computes the digests.** Node has crypto, so it works
  today. But then TS implements the canonical form the module also implements,
  and the two can drift — which is the `JSON.stringify` problem reintroduced
  from the other end, and against the standing preference that TS parsing or
  writing a platform format is a PORT TARGET rather than a thing to extend.
* **A `sm_seal_cohort` entry point** the builder calls after registering. Honest
  and explicit, costs the 21st entry point, and is a call a builder can forget —
  the same weakness the incumbent's separate `verify` has.
* **The module seals at EXPORT**, with the builder only declaring which cohort
  each archive belongs to. Nothing can be forgotten, there is one implementation
  of the canonical form, and no entry point is added. The cost is that sealing
  then happens inside the export path, which currently lives in `runtime-core`
  while the payload is opaque THERE — so the seal would have to be composed
  before the export, not during it.

**The third is almost certainly right and is not obvious enough to land at the
tail of a long session.** Recorded now so the next tick starts from the question
rather than rediscovering it.

**What IS self-contained, and lands first:** the payload codec and the cohort
verifier, in the module, with tests. Both are needed by every candidate above,
neither depends on choosing between them, and having the codec in hand makes the
production decision concrete rather than speculative.

### Every remaining Y5 blocker is the same decision wearing different clothes

**Concluded 2026-09-13, after checking what the next capability would actually
return.** The remaining ten looked like they needed five different things. They
need one.

`source-rootfs-shell-overlay` appeared unblocked: it wants
`exportLazyArchiveEntries`, which is an enumeration, which is one entry point
the maintainer already approved. **But look at what it does with it.** It builds
`new Set(entries.map(e => e.url))` and registers any declared archive whose URL
is absent — a membership test against the archives the BASE image already
declared.

**A KLZY-described base yields archives with EMPTY descriptors**, stated in the
loader itself: *"KLZY has no field for an archive's fetch description, so an
image described that way carries none. Exporting it would therefore emit an
archive with no descriptor — honest, and visible, rather than invented."* The
shipped rootfs this overlay is applied to is exactly such an image — measured:
`carriers: klzy -> sdef`.

So the enumeration would return archives with no URLs, the membership set would
be empty, and the overlay would re-register every archive the base already has.
**Spending the approved entry point on it would buy a method that cannot answer
correctly for the images it is used against.**

**Therefore the honest list of remaining blockers is one item long:** are the
shipped base images rebuilt through the new producer, or is a legacy path
written? Five files need the seal, which lives in the lazy JSON; one needs
archive URLs, which live in the lazy JSON; one sits behind those; the two
supply-chain files are their own port; and the funnel is last by construction.

**`docs/agent-guidance/abi.md` argues for the rebuild** — a stale artifact
should fail loudly and be rebuilt rather than shimmed — and the rebuild is
already partly done, since the nine recipes repointed on 2026-09-13 emit `SDEF`.
But which artifacts must keep working is a product call, so it is the
maintainer's.

**What this lane should NOT do meanwhile** is spend the approved entry point, or
repoint a file onto a capability that cannot yet answer. Both would look like
progress and would have to be undone.

### Y5: importers 11 -> 10, and a stub that would have halved a security check

**2026-09-13, four increments.**

**The lazy-archive path validator moved to `host/src/vfs/lazy-archive-paths.ts`**
(`4b02b3c55`). Bulk registration means joining a mount prefix to each member's
name, and that join is where a member escapes: a path is resolved AFTER it is
joined, so `../../etc/passwd` lands wherever resolution takes it. The validator
refuses far more than containment — NUL bytes, backslashes, absolute paths,
Windows drive letters, conflicting directory/symlink metadata, non-canonical
segments, colliding members, a symlink with no target, and a member descending
through a non-directory ancestor. **Reimplementing that in the bridge would be
two chances to get it subtly different**, and the difference would stay
invisible until an archive exploited it. It is pure path logic, so it can be
shared rather than copied. `memoryFsTypeScript` 8491 -> 8387, banked — it was
inside the 200-line slack and passed UNBANKED, which is exactly how a reduction
gets quietly given back.

**The bridge registers a whole archive** (`8a5ab95e7`) at no module surface cost:
the existing `registerArchiveMember` driven by that validator. Every member is
planned before any is created, because a member rejected halfway leaves a
partial tree — **an image that builds and is missing exactly the files nobody
checked for.**

**`shell-lazy-archives` types against the interface** (`4c57453ae`), 11 -> 10
banked. The two implementations genuinely differ in SHAPE — the bridge takes an
object, `MemoryFileSystem` takes positional arguments — so the caller prefers
and falls back, as `assertVfsImageHeadroom` does for `checkHeadroom` against
`statfs`. The third branch THROWS: a filesystem that can register neither would
otherwise register nothing and let the image build without its utilities.

### `getLazyEntry` returned null unconditionally, and that is an answer

**Found 2026-09-13 while reading the next file to repoint.** Not
"unimplemented" — an ANSWER, and the one recipes build on.

The pair is documented elsewhere in this plan: `getLazyEntry(p) !== null`
covers a URL-backed SINGLE, `isPathDeferred(p)` covers an archive or tree
backing, every caller re-joins them by hand, and **collapsing them silently
weakens the check** because it drops the URL-backed case — lane S's case. A
half that always says "no registration" collapses the pair just as surely as
deleting it would.

**Nothing shipped weakened**: all ten repointed recipes were checked and none
call it. It was implemented immediately anyway, because the next file to repoint
DOES call it and the degradation would have arrived silently with that repoint.

It needed no module surface — a URL-backed single is `deferred` with no archive,
and `sm_lstat` reports both fields already. **The test asserts the DISTINCTION
rather than the values**: a single says yes to both halves, an archive member
only to the second, a resident file to neither. The stub gave the same answer to
all three, which is precisely why it was invisible.

**The general shape, worth carrying to other lanes:** a stub that returns a
plausible value is worse than one that throws, because the caller cannot tell
the difference between "no" and "not implemented" — and a security check made of
two halves fails open when one half is a stub.

### CORRECTED: the seal stays payload, because the verifier is not the kernel

**Written and then corrected within the hour, 2026-09-13, by reading the
format's own documentation instead of reasoning from the rule in the
abstract.** The corrected conclusion is below; the original argument is kept
after it because the mistake is instructive.

`sffs_deferred`'s module doc names the seal explicitly, and puts it on the
other side of the line:

> *Everything the kernel merely carries stays in the payload — fetch URL,
> transport, **integrity digest, activation mode, atomic-group seal** — and is
> never inspected here. The kernel is a courier for those. **Whoever fetches
> still decides whether a URL may be fetched, validates the digest, and honours
> the activation mode**; carrying the bytes authorises nothing.*

**The premise I got wrong was "the kernel verifies it".** It does not, and
should not. `verifyImportedLazyAtomicGroupSeals` is called by the BUILDER before
it trusts an imported base — a CONSUMER authenticating input, not a kernel
acting on a field during a fetch. The kernel never verifies a seal today and
nothing here proposes it should.

**So the seal stays payload, and the verifier is a consumer-side component.**
`sffs_deferred` still never inspects a payload; something above it does, exactly
as "whoever fetches validates the digest" already describes. That distinction —
the FORMAT does not inspect, a CONSUMER may — is what the doc means by "never
inspected here", and collapsing it would have made the courier property a
comment rather than a fact, which is the very thing the archive-linkage section
warns about.

**The JSON hazard still goes away, by a different route.** The payload's schema
is the PRODUCER's, and once the producer is the Rust bridge that schema is ours
to define as a byte layout. No JavaScript serialiser to reproduce, no escaping
rule to get subtly wrong — not because the seal was promoted, but because the
producer changed.

**Why the mistake was easy, and worth recording.** The rule "first-class when
the kernel acts on it" is correct and I applied it to a premise I had not
checked. The format had already answered the question in prose, three paragraphs
above the one I was quoting. **A rule derived from a document is not a
substitute for the rest of the document.**

<details>
<summary>The original, incorrect argument, kept for the record</summary>

### The seal is a FIELD, not a payload — and the lane's own rule says so

**Designed 2026-09-13.** The obvious place to put a seal is the `SDEF` payload:
it is already opaque, already carried through load and export, and already the
answer for a URL-backed file's identity. That is wrong, and the lane has already
written down why.

**The rule, from V4:** *a field is first-class when the kernel ACTS on it, and
payload when the kernel only CARRIES it.* The payload is opaque precisely
because the kernel is a courier for it — `sffs_deferred` never looks inside.

**A seal the kernel VERIFIES is something the kernel acts on.** Putting it in
the payload would force the kernel to parse the bytes it promises not to read,
which is not a small inconsistency: it would make "opaque" a claim the format
makes and the verifier breaks, and the next person to add a payload field would
have no way to know which parts are truly opaque.

So the seal becomes **first-class `SDEF` fields** — a descriptor digest on the
record, and the cohort seal (`id`, `expected_count`, `cohort_digest`) on the
archive declaration. That is an `SDEF` v4 → v5 format change, which is lane V's
to make and is why the seal port is lane V work rather than a bridge method.

**And it removes the JSON problem entirely.** With the digest a fixed 32-byte
field and the cohort identity a defined byte layout rather than
`JSON.stringify` output, there is no JavaScript serialiser to reproduce and no
escaping rule to get subtly wrong. The canonical form is the format, which is
the only place a canonical form is safe to live.

**What stays payload:** the fetch description — the URL and whatever else
locates the bytes. The kernel still only carries that, and the rule still
holds for it.

</details>

### Y5 and V5 are the same work seen from two ends

**Realised 2026-09-13.** Repointing a recipe onto `SffsImageFs` IS the producer
cutover for that recipe: the image it writes carries `SDEF` rather than
host-side lazy JSON. So the nine recipes repointed today are nine producers
cut over, and V5 is not a separate task waiting behind Y5 — it is Y5's other
face.

**Which makes the remaining eleven readable.** They divide by what blocks them,
and only two are blocked on a capability:

| blocked on | files |
|---|---|
| the seal check | `shell-vfs-build`, `package-shell-vfs-build`, `build-php-test`, `shell-rootfs-restore`, `build-source-rootfs-shell-image` |
| one of those | `wordpress-preinstall`, which hands its filesystem to `shell-vfs-build` |
| a Rust port | `staged-product-inputs`, `vfs-product-builder-contract` |
| deferred-entry enumeration | `source-rootfs-shell-overlay` |
| bulk archive registration | `shell-lazy-archives` |
| nothing — it is last by construction | `vfs-image-helpers`, the funnel |

**The funnel goes last and cannot go sooner.** Its two remaining
`MemoryFileSystem` uses are the fallbacks it keeps FOR the files above —
`statfs` where there is no headroom verdict, `readImageCapacity` where there is
no `exportCapacityBytes`. Both are commented "deleted along with that class".
It is the last importer precisely because it is the one everything passes
through.

**So the seal is the gate on five of eleven**, and the seal's own gate is a
carrier. The path is: define the seal's place in an `SDEF` payload, have the
bridge's register calls carry it, verify synchronously in Rust. New images get
new seals; nothing needs JavaScript's `JSON.stringify` reproduced in Rust.

**What that leaves open for the maintainer** is whether a derived build from an
EXISTING, JSON-sealed base must still verify. `docs/agent-guidance/abi.md` says
a stale artifact should fail loudly and be rebuilt rather than shimmed, which
argues for rebuilding the shipped bases through the new producer — but it is a
product call about what has to keep working, not a format call, so it is named
here rather than assumed.

### The seal check cannot move before the producer does, and the reason is a carrier

**Measured 2026-09-13, and it revises the plan I gave the maintainer.** I said I
would port `verifyImportedLazyAtomicGroupSeals` into the Rust filesystem. That
is still the right destination. **Doing it now would be building on the carrier
this lane is retiring.**

**Where the seal lives.** It is serialised into each lazy archive entry as
`activation.atomicGroup` — `{id, expectedCount, cohortSha256, member,
descriptorSha256}` — and those entries live in the image's **host-side lazy
JSON**. That is the same section the describe tool names as holding "the URL and
integrity fields", and it is the section `load_image` walks straight past. **So
the kernel cannot see these seals at all**, and a Rust verifier would have
nothing to verify.

**What the check actually does**, once the async scaffolding is set aside:

1. each member's `sha256(descriptorBytes)` must equal its sealed
   `descriptorSha256` — "changed after sealing";
2. `sha256(cohortIdentityBytes(id, members))` must equal the group's
   `cohortSha256`.

**And the cohort identity is `JSON.stringify`.** Literally: `JSON.stringify({
schema: 1, id, members: [...sorted by member] })`, UTF-8 encoded. A Rust
verifier of EXISTING images would have to reproduce JavaScript's
`JSON.stringify` byte for byte — key order, escaping rules, non-ASCII handling —
over member names that are archive paths and may contain anything. Get it
subtly wrong and every sealed image fails to verify; get it wrong in the other
direction and two different cohorts could agree.

**That is a real hazard taken on for a format both sides are leaving.** When the
producer emits `SDEF`, the seal travels as a deferred payload — the "somewhere
to record a digest" that SDEF v4 created and that lane S's handoff points at —
and the canonical form can be defined ONCE, in Rust, with no legacy encoding to
match.

**So the ordering is: seal port rides with V5, the producer cutover.** Not
because it is hard, but because doing it first means writing a JavaScript JSON
canonicaliser in a `no_std` kernel crate to verify seals the kernel will stop
receiving.

**One more thing the async scaffolding was hiding.** The verifier re-asserts its
private snapshots against public state AFTER hashing, with the comment "hashing
yields to host code". That whole defence is against `await`. A synchronous Rust
digest removes not just the flight dedup and the state machine but the
snapshot-versus-public reconciliation — which is the majority of the remaining
complexity.

### The seal check is ten methods, and nine of them exist because the digest was async

**Measured 2026-09-12, after the maintainer assigned the port to this lane, and
it corrects an estimate I gave before reading it.** I said there was "no big
downside". There is a real one: `verifyImportedLazyAtomicGroupSeals` is not a
function but a subsystem — **ten methods and 159 references** in `memory-fs.ts`,
covering atomic activation groups, cohort digests, per-group in-flight
deduplication, a pending/verified state machine, and linearization assertions
that re-check the proof after awaiting it.

**But the code says why it is that shape, and the reason does not survive the
port.** From `memory-fs.ts` at the entry point itself:

> *"synchronous export and rebase cannot invoke browser SubtleCrypto. Keep their
> fail-closed guard while giving image consumers a cheap, explicit trust
> boundary that does not serialize the whole VFS."*

Every asynchronous element — the flight dedup, the settled-flight clearing, the
re-assertion after the await, the whole "await this before synchronous metadata
inspection or filesystem rebasing" contract, and the public
`verifyImportedLazyAtomicGroupSeals` entry point itself — exists because the
digest is `SubtleCrypto` and `SubtleCrypto` is a promise. **In the module,
sha256 is a synchronous Rust call**, so the import can authenticate as it
imports and there is nothing left to await, dedup, or re-assert.

So the port is not ten methods. It is one verification performed eagerly, plus a
`no_std` sha2 in a module that currently has none. The module is zero-import, so
the digest cannot be a host call — which is the constraint that forces the
simplification rather than merely permitting it.

**Sequencing: after the nine repoints.** Those are unblocked and bankable now;
this is the item where a subtle error is a silent security regression rather
than a visible failure, and it should not ride in on a commit about import
paths.

### The remaining twenty, measured: nine are ready and six need five methods

**Census 2026-09-12, on the lane branch after image loading landed.** The
twenty are not one problem, and the split is sharper than "sixteen construct a
filesystem".

**Nine can repoint today, needing nothing new:** `build-erlang`,
`build-kandelo-sdk`, `build-mariadb`, `build-mariadb-test`, `build-node-zip`,
`build-perl`, `build-python`, `build-redis`, `build-sqlite-test`. Each calls only
methods `VfsImageFilesystem` already carries, and each constructs in the same two
lines:

```ts
const sab = new SharedArrayBuffer(32 * 1024 * 1024, { maxByteLength: CAP });
const fs = MemoryFileSystem.create(sab, CAP);
```

becoming `SffsImageFs.create()` plus `fs.setImageCapacity(CAP)` — **which is
what gap 14 was a prerequisite for**. The `SharedArrayBuffer` disappears with
the concrete class; it was never anything but that constructor's first argument.

**Six are blocked, and between them they need five methods:**

| method | wanted by |
|---|---|
| `getImageMetadata` / `setImageMetadata` | `shell-vfs-build`, `package-shell-vfs-build`, `build-php-test` |
| `rebaseToNewFileSystem` | the same three |
| `exportLazyArchiveEntries` | `source-rootfs-shell-overlay`, `build-source-rootfs-shell-image` |
| `registerLazyArchiveFromEntries` | `shell-lazy-archives` |
| `verifyImportedLazyAtomicGroupSeals` | five of the six |

`setImageMetadata` is the cheap one — the bridge HAS it and the interface does
not declare it. The seal check is the one with teeth: it is live sha256 cohort
authentication and **the maintainer assigned it to this lane** (2026-09-12,
"I don't care which lane owns it on paper — if there's no big downside, do it").
It lands as its own increment with its own trials, because a subtle error there
is a silent security regression rather than a visible failure.

**The two supply-chain files stay last**, per the maintainer: they become Rust
tools in this lane after the constructor repoints.

### The base-file identity gap is not a missing key — it is a source that never had one

**Measured 2026-09-12, and it corrects how items 2 and 3 were framed.** The
maintainer asked the right question: *"The VFS should own the key entirely. The
host is just responsible for taking some kind of address and resolving to bytes.
If the VFS owned the key, wouldn't it be a lot harder to lose the deferred
reference."* Yes — and the measurement says the VFS does **not** own it today.

What the shipped rootfs actually contains: 65 deferred entries, **every one of
them `archive_id == 0`** — a URL-backed single whose only identity is its
payload — and the carrier is `klzy -> sdef`. `KLZY` is the kernel-facing subset
and **carries no fetch description at all**: the URL and the integrity fields
live in the trailing lazy JSON beside it, which only the host parses
(`tools/xtask/src/vfs_image_describe.rs`, the comment at the KLZY branch says so
in as many words).

**So the export is not losing something it was given.** It is re-emitting
everything it was told, and it was never told the URL. Today the HOST-side JSON
owns the key; the kernel is handed an inode number and a size. A host-backed
deferred file is *"addressed by its inode number"*
(`host/src/vfs/rootfs-lazy-archives.ts`), and re-export renumbers inodes — which
is why the reference cannot survive.

**The design the maintainer describes already exists: it is SDEF.** A record
carries an opaque payload that the kernel stores, carries through a load, and
re-emits on export, never reading it. The kernel owns the key and the host is a
resolver. It is proven lossless today on kernel-written images —
`roundtrip` on a 1.5 MB SDEF image is EQUIVALENT.

**What is missing is therefore not a format capability but a producer.** Four
ways to close it, and only one is worth doing:

* **(a) the producer cutover (V5/Y5) — the answer.** Builders emit SDEF with
  payloads, and every image written afterwards round-trips losslessly. Already
  the plan; already in flight.
* **(b) teach the kernel to read the lazy JSON.** Rejected: JSON parsing in the
  kernel, and it re-enshrines the host's format as the authority this lane
  exists to remove.
* **(c) add a payload field to KLZY.** A kernel-facing format change to a
  section being replaced.
* **(d) let the host push payloads in after a KLZY load.** The host already
  parses the lazy JSON, so it could hand each payload to the kernel and the
  kernel would own the key from that point. **Worth recording as the transition
  bridge** if derived builds from today's KLZY images must be lossless before
  the cutover finishes — it needs a way to attach a payload post-load, which is
  an entry point the module does not have.

**Nothing here needs a maintainer decision.** The measurement removed the
decision: there is no key to choose, only a producer to cut over.

### Next in lane V: make the round-trip verb re-enter its own output

**Scoped 2026-09-12, straight out of H-13.** `xtask vfs-image roundtrip` loads
an image, exports it, and compares decoded descriptions. It never feeds the
export back through the loader, which is why gap 15 — the kernel refusing images
it had just written — survived a green corpus run.

**The fix is one more pass, not a new tool**: load the export. It is cheap
(the export is already in hand), it is the door the first load came through, and
it would have failed loudly on every image with no deferred files. Worth doing
before the sixteen constructor repoints, because those builds are exactly the
artifacts this verb is the corpus check for.

### Gap 15 — the kernel refused an image it had just written

**Found 2026-09-12 by the first round-trip test, and it had been invisible.**
`xtask vfs-image roundtrip` compares DECODED DESCRIPTIONS, so "the export writes
a format the decoder understands" was proven and "the kernel can load back what
it wrote" was not. The first test to try it got `EINVAL` on a 290 KB image the
module had produced seconds earlier.

`load_image` refuses an image declaring neither `KLZY` nor `SDEF`, and the
reasoning is sound: it cannot tell "this image has no lazy files" from "this
image records its lazy files only in the host-side JSON I cannot read", and
accepting the second builds a tree where every deferred file reports size 0 — a
wrong tree that looks like a right one. But `emit_deferred_section` returned
early when nothing was deferred, so the image came out byte-identical to one
built before the section existed. **That backward-compatibility property was
exactly what made the artifact unloadable.**

**The fix is opt-in, and the first attempt is why.** Emitting the empty section
unconditionally broke four `matches_the_typescript_writer` byte-for-byte tests —
the migration safety property saying the change was one layer too low. Only a
producer that really would have written the records may make the statement:
`SffsWriter::declare_deferred_section` is called by the kernel's export and by
nothing else. The TypeScript writer cannot make it, and for its images "no
section" is the truth the loader is right to refuse.

**An empty section is not a formality.** It is the statement "this image was
written by something that would have told you", and it is the difference between
silence and an answer. It costs one inode and one block — visible as the fixed
export slack moving from 64 blocks to 63.

Evidence: `xtask vfs-image roundtrip` on a real 1.5 MB kernel-written image —
loaded 375 entries, re-exported, EQUIVALENT, carriers `sdef -> sdef`. The
shipped 16 MB rootfs is unchanged at 65 deferred lost, which is the base-file
identity gap (items 2 and 3), not a regression.

**What this did NOT close.** A blob-backed base file still exports as an empty
stub, because the kernel holds no identity for it that survives renumbering.
That is still items 2 and 3, and the module test asserting the damage now
asserts it against a section that exists and does not mention the inode, rather
than against no section at all.

### Y5 MOVED: importers 36 -> 20, banked. 2026-09-12.

**The acceptance number moved for the first time**, and what unlocked it was not
another repoint attempt: it was typing the FUNNEL against the interface. Every
recipe passes its filesystem into `vfs-image-helpers.ts`, so nothing downstream
could move while that file took the concrete class. Three earlier attempts
diverged (79, 121, 240 errors) for want of that one change.

Getting the funnel there took three moves, in this order:

1. **`host/src/vfs/image-helpers.ts` first**, because the funnel passes its
   filesystem into it. Ninety-nine lines, and only `mkdir` was missing from the
   interface — the bridge had it all along.
2. **The interface moved to `host/src/vfs/`.** It had been under `images/`, and
   a host module importing from `images/` inverts the dependency. Same home and
   reason as `vfs-errors.ts`.
3. **`VfsImageMetadata` moved with it**, `memory-fs.ts` re-exporting it. It is a
   contract, not part of the implementation: thirteen recipes import it and each
   was counted as coupled to a filesystem it never touches.
   `memoryFsTypeScript` 8501 -> 8491, banked.

**Membership in the repointable set is decided by three tests, and two of them
were learned by getting it wrong:**

* what the file CALLS on the filesystem — the obvious one;
* whether it CONSTRUCTS one. `MemoryFileSystem.create` is a VALUE; no interface
  provides it, and a pass that renamed it produced sixteen "only refers to a
  type, but is being used as a value" errors;
* **what it PASSES ITS FILESYSTEM TO.** `wordpress-preinstall.ts` passes usage
  analysis and still cannot move: it calls `saveShellDerivedBuildGuestSnapshot`
  in `shell-vfs-build.ts`, which needs capabilities the bridge lacks.

**The remaining 20 are not one problem.** Sixteen CONSTRUCT a filesystem — they
stop importing `memory-fs` when they start constructing `SffsImageFs`, which is
the cutover itself and needs image loading for the derived ones. The rest are
the derived builders and the two supply-chain port targets.

**Two ceilings lowered, and the budget insisted on one of them.**
`imageBuilderFilesystemImporters` at 20 against a ceiling of 36 FAILED the gate
— "more than 0 below its ceiling" — because an unbanked reduction is a reduction
that can be silently given back. Worth recording as the direction people forget
a budget works in.

### The predicate the recipes need is one, not two — and it cannot live in `memory-fs.ts`

**Measured 2026-09-12, second repoint attempt.** The recipes that ask "are these
bytes here?" ask it in two halves, because `MemoryFileSystem` answers it in two:
`getLazyEntry(p) !== null` covers a URL-backed single lazy file (the per-inode
registry), `isPathDeferred(p)` covers a lazy archive or tree backing. Every
caller re-joins them by hand. **That is a security-relevant check one edit away
from being half a check** — the assertions are "dinit must be resident before
service boot" and "the login program must be eager".

**Collapsing them to `isPathDeferred` alone would silently weaken it**, which is
why the obvious simplification is wrong: it drops the URL-backed case, which is
exactly lane S's case.

The kernel already models this as ONE concept — `rootfs::lazy_info` reports
`deferred` for an archive member and for a host-backed file alike — so the
bridge answers it with one predicate honestly. Giving `MemoryFileSystem` the
matching union method made the whole component typecheck: **the blocking set
fell from 7 files to 4** (`build-kandelo-sdk-vfs-image`, `staged-product-inputs`,
`mariadb-test-source-copy`, `build-source-rootfs-shell-image`).

**And the surface budget refused it, correctly.** The method plus its doc
comment grew `memoryFsTypeScript` 8501 → 8522, and that file's target is **0**.
Raising the ceiling to admit twenty-one lines into a file the campaign is
deleting is the exact move the gate exists to stop, so the change was reverted
rather than argued with.

**So the union predicate needs a home that is not `memory-fs.ts`.** The shape
that works is an ADAPTER at the funnel: `vfs-image-helpers.ts` already
constructs the filesystem every builder uses, so it can wrap it once into a
`VfsImageFilesystem`, and the recipes take the interface. That converts N
importers into one adapter instead of adding lines to the doomed file — which is
the same trade this lane is making everywhere else.

**Two measurement lessons worth keeping**, both of which cost a cycle here:

* **A syntax error suppresses type errors.** An import inserted inside a
  multi-line `import { … }` broke four files, and the count read 25 — lower than
  the 45 it replaced — because unparseable files stop TypeScript analysing
  everything that imports them. Repairing the syntax revealed 229. A count that
  falls after a broken edit is not progress.
* **Repointing more files is not more progress.** A grep-driven pass repointed
  18 type-only importers rather than the 13 whose measured usage fits the
  interface, and the extra five use methods it deliberately omits.

### The repoint is one connected component, not a file-at-a-time pass. ATTEMPTED AND REVERTED 2026-09-12.

The tier table above is right about what each file NEEDS and wrong about what
that implies, and the difference was only visible by doing it. Measured with the
new `images/tsconfig.typecheck.json`:

| What was tried | Errors under `images/` |
|---|---|
| baseline, nothing changed | **3** (all pre-existing, named in the config) |
| repoint the 13 type-only files | **79** |
| ...also repoint all 14 files declaring `MemoryFileSystem` in a signature | **45** |
| ...then revert the 7 whose bodies need the omitted methods | **191** |

A repointed file passes its `VfsImageFilesystem` to a helper still declaring
`MemoryFileSystem`, and that does not compile. Widening the pass to every file
with such a signature improves it, and the residue is 7 files whose BODIES call
`saveImage`, `getLazyEntry`, `isPathDeferred` or the archive-entry helpers.
**Cutting the component at those 7 makes it worse, not better** — they sit in
the middle of the call graph, not at its edge, so the files that call them break
instead.

So there is no ordering that lands this incrementally at file granularity. The
choice is:

* **(a) Widen the interface** to include `saveImage`, `getLazyEntry`,
  `isPathDeferred` and the archive-entry helpers. Everything compiles at once
  and the budget number falls — but the interface is then a second NAME for
  `MemoryFileSystem` rather than a description of what a recipe needs, which is
  H-8 exactly: the count moves and nothing is migratable.
* **(b) Give the bridge those capabilities first**, so the interface is honest,
  then repoint the whole component in one change.

**(b) is the lane's stated end state and (a) is the shortcut that would satisfy
the gate without satisfying the goal.** It is recorded as a maintainer decision
rather than taken, because "make the number move now" versus "keep the number
honest and land later" is a scope call, and the gate it affects is this lane's
acceptance evidence.

What landed from the attempt: the typecheck config, the
`VfsImageFilesystem` interface, and one real type error it caught in the bridge.
The repoint itself was reverted — `images/` is back to its 3 pre-existing
errors.

## Acceptance evidence

`imageBuilderFilesystemImporters` reaches **0** — the fact lane V is blocked
on. Set by the census, and the census's own ceiling was corrected by the gate
on its first run (it reported 36 against a hand-counted 34).

**The format evidence is decoded EQUIVALENCE, not byte equality. This replaces
the previous bar, and the replacement is the point — 2026-09-12.**

The previous bar, stated twice in this section, was "nine production images must
build byte-identically" and "byte equality is the only acceptable bar". **It is
unachievable by construction, and it was never reconciled against V5 two lanes
up in this same file.** A V5 image carries its deferred metadata in the body;
a TypeScript image carries it in a JSON trailer. Byte equality between them
cannot hold for any image containing deferred files — and lane V measured that
at 65 deferred files in the base image, 79 in a derived one, which is
effectively the whole corpus. Worse, enforcing it would pin the new writer to
the format V5 exists to replace: a gate that locks in the defect.

**The bar is instead that the two images decode to the same thing:**

- **namespace** — every path, file type, mode, uid/gid, hardlink graph, symlink
  target and normalized mtime identical;
- **resident content** — byte-identical per file;
- **deferred set** — the same paths, the same real sizes, the same opaque
  payloads (fetch URL, transport, integrity digest, activation mode,
  atomic-group seal), read from the JSON trailer on one side and SDEF on the
  other;
- **image metadata** — same `version`, `kernelAbi`, `createdBy`;
- **and the image boots.**

That is *stronger* than byte equality in the dimension that matters. It names
the failure lane V actually measured — deferred files surviving as zero-byte
regular files with no URL — which a byte comparison catches only by accident.

**Byte equality survives where it is still real**, and must not be relaxed
there: the four cross-language fixtures in `crates/runtime-core/src/testdata/`,
and any image with zero deferred files.

**Build the differ before the cutover.** That is lane V's own hazard about gates
shaped to pass, and it binds harder here because the format moves underneath.

**The corpus is eight images, not nine, until someone names the ninth.** Built
and present at `local-binaries/source-only-v1/programs/wasm32/`: shell,
kandelo-sdk, nginx, nginx-php, mariadb-test, node-vfs, wordpress, lamp. The
"nine" was inherited from the census, not counted.

## Known hazards

- **Lane V cannot close without this lane.** Any schedule putting V before Y is
  wrong.
- **A builder that silently produces a different image** is the worst outcome,
  because images are validated by running them and a subtly wrong image fails
  somewhere unrelated. The bar for "different" is the equivalence decode above.
- **The three policy assertions are covered. REFUTED 2026-09-12 by
  measurement**, `docs/plans/2026-09-12-lane-y2a-grounding.md`. Each call site
  inside `serializeImage` was disabled in turn, against a green baseline of 6
  files / 126 tests: headroom **1 failed**, `assertNoStaleWasmArtifacts`
  **23 failed**, capacity **1 failed**. The perturbation targets the CALL SITE,
  not the function body, because a unit test on the function cannot notice it
  being unwired — and unwiring is what a migration does. Two residuals:
  `assertNoStaleWasmArtifacts` has no direct unit test and is not exported, so
  all 23 detectors are pipeline-level and a symbol-level reading concludes the
  opposite of the truth; and headroom and capacity have **exactly one detector
  each**, which Y3 should widen before it moves them, not after.
- **Do not re-derive the retired byte-equality bar.** It reads like rigour, and
  it is the one bar this lane cannot meet. Anyone reaching for it has not read
  V5.
---

# LANE W — `web-libs` session contracts

**Status: W1 census COMPLETE — `docs/plans/2026-09-11-lane-w1-census.md`.
Found a third population the lane missed, and one measured defect.**

## What this lane is — as corrected by the census

`kernel-host.ts` (2,776 of 5,360 lines) holds **three** populations, not two:

1. **The host contract** — `KernelHost`, `KernelLike`, `FileSystemLike`,
   `PtyHandle`, `KmsDisplayHandle`, `AudioOutputHandle`, `Snapshot`. What a
   native host would want and cannot use today.
2. **Browser product surface** — gallery, boot descriptors, sharing, terminal
   policy. **Stays**, and descriptor validation is a security boundary.
3. **Hand-written parsers of kernel-emitted formats** — the population the lane
   missed, and the interesting one.

## The finding: the kernel writes `/proc`, the UI parses it back

`parseMaps`, `parseMounts`, `parseProcEntry`, `parseStatusBytes` and
`parseRangeSize` re-derive structured data from text the kernel serialised,
using hand-written regexes — `"00400000-005c2000 r-xp 00000000 fe:00 14222
/bin/bash"`, `/proc/mounts format: source target fs opts dump pass`, `/(\d+)\s*kB/`.

**Nothing binds them to what the kernel writes.** A kernel change produces
silently wrong rows rather than a failure. Lane G's failure mode in the UI
layer.

## W-D1 — a hand-maintained syscall table beside a generated one

`SYSCALL_NAMES_LOCAL` exists because, per its comment, importing
`kernel-worker.ts` would drag in Node-only transitive imports. **But
`kernel-worker.ts:SYSCALL_NAMES` is just `= ABI_SYSCALL_NAMES`** — an alias of
the generated table, which lives in `host/src/generated/abi.ts`, **a leaf module
with no Node-only imports**. The stated blocker does not apply to the table that
should have been imported.

And the copy is measurably wrong: generated **233** entries against **137**
local. **96 syscalls render in the UI as `syscall_NNN`**, and **2 names actively
disagree** — 129 is `statfs` locally and `statfs64` generated; 130 is `fstatfs`
versus `fstatfs64`. **The cheapest fix found in any census so far.**

## End state

The contracts a host implements are defined once, in a form both the browser
host and a native host can consume. The UI reads structured data from the
kernel rather than re-parsing text. The product surface stays and is named as
such.

## The floor

Boot descriptors, sharing, gallery metadata and terminal policy are browser
product surface with no kernel meaning. Their untrusted-input validation —
versioning, size caps, path validation — is a security boundary and must not be
migrated into something weaker.

## Increments

- **W1 — census.** Done.
- **W2 — delete `SYSCALL_NAMES_LOCAL`, import `ABI_SYSCALL_NAMES`.** Hours, not
  days; the stated blocker does not exist.
- **W3 — the kernel serves structured process/mount/map data** instead of the
  UI parsing `/proc` text. Most of the lane, and a kernel change rather than a
  `web-libs` one.
- **W4 — separate the host contract from the product surface.**
- **W5 — express the host contract where both hosts can consume it**, generated
  from Rust the way `generated/abi.ts` already is.

## Acceptance evidence

`sessionHandMaintainedSyscallNames` reaches **0** and
`sessionKernelFormatParsers` reaches **0**.

For W3 the decisive evidence is that the UI's process, mount and map views are
driven by a structured kernel response, demonstrated by changing what the kernel
writes to `/proc` and showing the UI is unaffected.

## Known hazards

- **The `/proc` parsers were read, not tested against live kernel output.** The
  finding is that nothing binds them, not that they are wrong today.
- **Untrusted-input validation must not be weakened.** Descriptors and shared
  URLs are a security boundary.
- **The coupling score understates browser coupling** — boot descriptors and
  sharing are browser *product* concepts, not browser *API* calls (H-8).
- **The other 2,584 lines of `kandelo-session` were not classified.**

---

# LANE U — build automation in shell and MJS

**Status: U1 census COMPLETE — `docs/plans/2026-09-11-lane-u1-census.md`.
Ranked by blast radius. Gates replaced. Still ranked last.**

## What this lane is — as corrected by the census

The lane's own rule was rank by blast radius, not size. U1 applies it.
**14 non-Rust scripts compute a build-freshness digest**; the tier that can
silently produce a wrong artifact is:

`build-step-input-hash.sh` (108), `fork-instrument-tool-input-hash.sh` (29),
`generate-rootfs-package-manifest.mjs` (689), `package-build-roots.sh` (870),
`browser-binary-package-roots.mjs` (770), `build-local-vfs-asset-group.ts`
(764), `vfs-product-deployment.ts` (764), `install-local-binary.sh` (618),
`vfs-product-catalog.mjs` (327).

The rest — release verification, CI deployment checks, workspace packing —
**fail loudly** and are tier 2.

## The finding: a cache-key primitive in shell that Rust consumes

`build-step-input-hash.sh` is a **content-identity digest primitive**, folding
each input's `git hash-object` blob hash into one value precisely so mtimes
cannot make a stale tree look fresh. It is consumed by `build-host.sh`,
`build-rootfs.sh` **and `tools/xtask/src/local_build.rs`**.

The build's freshness decision is computed by a shell script nothing
type-checks, and a Rust program depends on its output. **This repo has already
served a stale kernel from a cache key that omitted an input**, and the fix that
came out of it — closure-derived keys, `cargo_closure_paths` in
`build_deps.rs` — already exists in Rust beside the shell that does not use it.

And there are **two** shell copies: `build-step-input-hash.sh`'s own comment
says it "mirrors `fork-instrument-tool-input-hash.sh`'s content-identity
approach … but generalizes it".

## End state

Automation that participates in the build's correctness is Rust with tests.
Thin shell wrappers that invoke it remain, because a shell entry point is a
convenience, not a place decisions live.

## The floor

Shell is genuinely right for process orchestration — invoking a compiler,
wiring stdio, setting up the dev shell. **The floor is the wrapper, not the
logic.** Release verification and CI deployment checks also stay: they compute
digests, but they fail loudly when wrong.

## Increments

- **U1 — census.** Done.
- **U2 — one content-identity digest implementation in Rust**, replacing both
  shell copies, on the `cargo_closure` pattern that already exists.
- **U3 — `generate-rootfs-package-manifest.mjs`.** Tier 1 on its own merits and
  lane S needs it for the setuid integrity digest. **Land these together.**
- **U4 — the package-root and asset-group emitters.**
- **U5 — leave test runners, CI checks and dev conveniences in shell**, and say
  so, so a later pass does not migrate them for tidiness.

## Acceptance evidence

`buildFreshnessDigestsOutsideRust` reaches **6**. Not 0, because tier-2 scripts
legitimately compute digests in shell.

Per increment, a migrated script must have a test that fails when the logic is
wrong — which is the entire point, since the current failure mode is silence.
For U2 specifically: the digest must be shown to change when an input changes
that the old shell folding missed.

## Known hazards

- **This lane does not serve goal V4 at all**, and the census does not change
  that. No part of build automation is host API surface. **Working it while V4
  is the stated primary goal would be motion, not progress.** U2 and U3 are the
  exception worth arguing about: they are cheap and their failure mode has
  already been realised.
- **Rewriting working automation is how build systems break.** Every migration
  must be provable against the existing script's output before it replaces it.
- **The 25,658 lines of shell were not read**, only classified by pattern.
  Tier 2 was assumed loud rather than demonstrated loud.
- **The 14 scripts' digests were not audited for correctness**, only classified
  by what they compute.

---

# Unclaimed surface — the survey this plan was missing

**`docs/plans/2026-09-11-repo-survey-unclaimed-surface.md` holds the complete
repo scan.** Read it before adding or closing a lane.

The short version, because it changes how this plan should be read: of
`host/src`'s 134,776 production TypeScript lines, lanes K, F and V claim 86,970.
**47,806 lines across 106 files are claimed by no lane at all — more than the
fork lane.** Outside `host/src` there are a further 14,091 TypeScript lines of
VFS image builders, 25,658 lines of shell plus 9,729 of TS/MJS build automation,
and 5,360 lines of `web-libs` session contracts, none of it claimed either.

**Every outstanding census has now run** — L1, Y1, E1, R1, W1, U1, K1, plus
V6 and T5 — and their results are folded into the lanes above. **No lane
estimate now reads "unknown until".** Six of the
eight **overturned the lane they were meant to confirm**, which is the single
strongest argument in this file for censusing before dispatching:

| Census | What it overturned |
|---|---|
| **L1** | Target was 1,500; derived **3,600**. The premise — "lines a wasmtime host must reproduce" — was wrong; `host-native` wrote a layout struct and one helper. |
| **Y1** | Gate measured lines; the 13,502 are **recipes that stay**. Replaced with an importer count. Rust side already nearly sufficient. |
| **E1** | "70% divergent" conflated *different jobs* with *drifted copies*. The consolidation had **already happened** via a `createProcessLifecycle` factory (72 shared members, not the 10 reported). |
| **R1** | Not a 4,020-line resolver migration: `host-native`'s equivalent is **ten lines**. The duplication is **eight path literals**. |
| **W1** | Found a **third population** the lane missed — hand-written `/proc` parsers — plus a syscall table 96 entries short of the generated one. |
| **U1** | Gate measured size, the axis the lane's own text calls wrong. Tier-1 subset is **3–6 d** of the 12–25. |
| **K1** | Framing wrong — not "a second syscall table"; the 85 dispatched syscalls need host services and `host-native` dispatches them too. **But the 12,000 target survived**, validated against `guest.rs`'s 13,577. |
| **V6** | Five of six consumers need only **constants**; one needs the filesystem. Days, not weeks, for five of six. |
| **T5** | Not one defect nor forty: a **10 s budget on an 8.5 s job**. All 41 tests pass at 20 s; the lane becomes "why does a fork fixture cost 8.5 s". |
| **I/X** | Both gates I added without evidence were wrong: lane I's target 1,200 → **2,650**, and lane X's surface **withdrawn** — it counted the shared implementation the campaign wanted. |

**One pattern recurred across three censuses and is now the campaign's most
common defect shape:** ABI knowledge reaching TypeScript by hand while a
generator already exists for its neighbours — **L-D2** (scratch pointer table,
35 exports wider than the generated list), **W-D1** (syscall names, 137 hand
entries against 233 generated), **V-D1** (no generated errno table at all).
Lane G owns the generator; these are its customers.

---

The survey named seven clusters. **Six became the lanes above and one turned
out not to be a lane at all**, which is the survey's most useful result:

| Cluster | Outcome |
|---|---|
| Dynamic linking, 3,263 | **Not a lane.** Already migrated; this is the floor it left behind. See H-8. |
| Host↔kernel plumbing | **Lane L**, less `kernel.ts` (lane I's body) and `wasm-artifact-driver.ts` (another finished floor) — 5,853 |
| Node/browser host pairs | **Lane E** — 7,513, and the fix is already partly built |
| Binary resolution | **Lane R** — 4,020 |
| Image builders | **Lane Y** — 13,502, and lane V is blocked on it |
| Build automation | **Lane U** — ranked last; it does not serve V4 |
| `web-libs` contracts | **Lane W** — 5,360 |

Two existing lanes were judged to have the same gate hole lane V had — a small
gate on a large body — and each gained a line surface. **A follow-up census
(`docs/plans/2026-09-11-lane-i-x-surface-census.md`) found both guesses wrong,
in opposite directions:**

- **Lane I** keeps `kernelHostImportTypeScript`, but its target moved from a
  guessed **1,200 to 2,650**. `host-native` supplies the same import surface
  through 71 `linker.func_wrap` calls spanning 7,646 lines, so there is no
  evidence the implementations shrink to 1,200. The new number is arithmetic on
  the import reduction (72 → 40) the lane is already gated on, and is labelled
  as a consequence rather than a measurement.
- **Lane X's `processExecTypeScript` is WITHDRAWN.** It counted
  `process-lifecycle.ts`, which is the shared `createProcessLifecycle`
  implementation both worker entries call — the consolidation the E1 census
  credits. **Shrinking it is not a goal.** The exec-target authority has also
  already largely moved to the kernel (8 `kernel_exec_target_*` exports), so a
  12-reference gate on this body is appropriate: the body is what the campaign
  wants.

**The lesson, recorded because it cost two wrong gates:** "a small gate on a
large body is a hole" caught lane V correctly and then produced two false
positives. A large body is only a hole if the body is *wrong*. **Adding a gate
is a claim about what should shrink and needs the same evidence as any other
claim.**

**Every target on the new lanes is provisional**, and each lane's first
increment is the census that sets the real one. That is stated in each lane and
in each surface's `why`, because a provisional number presented as a commitment
is how a budget stops being honest.

## What "complete" means for this plan now

The roster is complete: twenty lanes, every one carrying the five required
sections, every one gated by a measurement that has been shown to fail. **The
characterization is not uniformly deep.** Lanes F, V, I and C have been worked
and their increments are grounded in what was found; lanes L, E, R, Y, W and U
are characterized from a survey and a reading, and their first increment is in
every case a census precisely because that grounding does not exist yet.

**No work has been done on any of the six new lanes.** They are planned, not
started.

---

# Filed defects that are not lanes

Real, characterized enough to act on, too small to be lanes — recorded here so
they are not lost the way five dead Rust floors were.

- **B36 — a signal-safe wake can complete before a signal the writer has not
  yet sent.** A parked `ppoll`/`pselect` is woken by a host-scheduled task, not
  by anything ordered against the writing process's next channel message. The
  obvious fix was **refuted, not deferred**: after `write()` returns the child
  is running guest code, so "wait for its next message" has no bound and any
  bound is the mitigating constant in another hat. POSIX does not require the
  ordering — the descriptor was ready first — so this is a robustness gap
  rather than a conformance one, which is why removing the mitigation is a
  judgement call.
- **The three spawn `vi.fn` failures.** `spawn-blob-transport`,
  `spawn-credential-order` and `spawn-pid-authority` fail with
  `kernel_exec_target_artifact_policy failed`. **Verified unrelated to lane X**
  by reverting its commits and observing identical counts. Unowned.
- **`fork-host-import-runtime.test.ts`** fails on `wa_read_facts: malformed
  type section` against an artifact module built from its canonical recipe.
  Could not be distinguished from "other worktrees run a newer fetched binary".
- **`kernel-scratch-contract.test.ts`** reports 4 kernel-entry and 12
  memory-audit findings, including stale allowances.

---

# Superseded

Deleted by the change that adds this file, their content carried above:

- `2026-09-10-rust-first-campaign-status.md` — the owed-work register and trap
  catalogue. **Its hazards are Hazards H-1 to H-7 above; its per-item history
  is in git.**
- `2026-09-11-fork-typescript-census.md`, `2026-09-11-unscoped-lane-survey.md` —
  evidence, folded into lanes F, V, P and I.
- `2026-09-07-fork-orchestration-migration.md`,
  `2026-09-08-fork-controlflow-into-module-scope.md`,
  `2026-09-09-rust-first-fork-inversion-completion.md` — folded into lane F.

**Explicitly NOT superseded**, because they are characterizations a future owner
needs whole:

- `2026-09-08-fork-controlflow-inversion-scope.md` — §2 and §3 are lane F's
  floor and target, derived from Wasm capability limits. Lane F's section here
  summarises it; it does not replace it.
- `2026-09-11-lane-a-state-of-the-lane.md` — lane M's handoff.
