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
| **F** fork inversion | **15–30 d** | low | Four coarse entries, each replacing a host driver. The `ABORT_UNWINDING` discipline has already trapped or hung two attempts, and the `kernel_exit` trap change is a prerequisite nobody has scoped. |
| **M** shared mapping *(deferred)* | **20–40 d** | low | ~15% done. A production resolver, ~15 exports, the range policy, then 2,776 host lines across ~50 call sites — and `MAP_SHARED` coherence fails silently, so the coverage has to precede the cutover. |
| **I** host imports (V4) | **15–30 d** | low | I1–I2 are 2–3 d. I3 is the rest: moving POSIX filesystem semantics for host-backed mounts into a kernel that already implements them for its own. |
| **V** VFS / one SFFS | **8–16 d** | medium *(V6 done)* | Five of six consumers need only constants; V7–V8 are 1–3 d. V9 — `memory-fs.ts` dropping `SharedFS` — is the remainder and is genuinely large at 8,501 lines. |
| **P** platform honesty | **10–15 d** | medium | Five independent instances. `st_rdev` is ABI-adjacent on the stat wire; the UI trio is smaller but one item is a product decision, not an engineering one. |
| **T** test hygiene | **3–6 d** | medium *(T5 done)* | Neither one defect nor forty: a 10 s budget on an 8.5 s job. All 41 pass at 20 s. The lane is now "why does a fork fixture cost 8.5 s", not "debug 40 tests". |
| **S** setuid integrity | **5–10 d** | medium | S1 is 1–2 d — the verifier already exists and the emitter already imports `createHash`. S2 needs a sha256 in the kernel and should land with the SDEF record. |
| **C** conformance | **4–7 d** | medium | C1 is a runner-contract change; C2 is following through on two XFAIL'd gaps. The 8 remaining failures are all harness. |
| **B** build truthfulness | **4–7 d** | medium | Reconciling the cheap path with the freshness gate is a decision plus a day; stamping the fixtures is the larger half. |
| **X** process and exec | **2–5 d** | medium | Blocked on one panic with a precise bisect. Once found, the repoint is a one-commit reapply. |
| **H** browser + curation | **3–6 d** | medium | The browser pass is short if provisioning holds; curation of ~370 commits into ~14 is a day or two with `commit-tree`. |
| **K** `kernel-worker.ts` | **30–60 d** | low *(K1 done)* | One class holds 29,975 lines across 522 methods. Decomposition, not migration — `host-native` dispatches the same 85 syscalls. The census clarified the shape but found nothing making it smaller. |
| **L** host↔kernel plumbing | **6–12 d** | medium *(L1 done)* | Not 5,853 lines a host must reproduce — `host-native` wrote a layout struct and one helper. The work is unifying duplicated knowledge: one layout, one bounds rule, a generated pointer table. |
| **E** Node/browser peers | **4–8 d** | medium *(E1 done)* | The consolidation already happened for the pair that mattered: 72 shared lifecycle members via a factory. What is left is unifying 43 duplicated message types and a 21-item audit. |
| **Y** image builders (V3) | **8–15 d** | medium *(Y1 done)* | Six image-level gaps, one bridge, a mechanical repoint of 36 files. Byte-identical output for nine production images is the bar and the expensive part. **Blocks lane V.** |
| **U** build automation | **12–25 d** | low *(U1 done)* | Ranked last: none of it is host API surface. But the tier-1 subset (U2+U3) is **3–6 d** and carries nearly all the risk reduction; the census recommends not doing the rest. |
| **W** `web-libs` contracts | **4–8 d** | medium *(W1 done)* | Unchanged in total but redistributed: W2 is hours, and W3 — the kernel serving structured data instead of the UI parsing `/proc` — is most of the lane and is a kernel change. |
| **R** binary resolution | **2–4 d** | medium-high *(R1 done)* | One shared constant and four consumers, not a resolver migration. The 4,020-line file is policy nobody duplicates. |
| **G** ABI binding drift | **~1 d left** | high *(14/15 done)* | Blocked only on the `itimerval` decision. The rest landed: 103 constants emitted, 68 asserts, every batch perturbation-tested. |
| **D** dead Rust floors | **2–5 d** | medium | A checklist, not a surface. Size is known; the risk is deleting something with a caller nobody found. |

**Serial total is not the useful number** — these run in parallel lanes. The
**critical path is K, F and M** — K at 30–60 d is now the largest single lane
in the campaign and has had no census at all, and F and M are 15–40 d apiece at
low confidence. None of the three is in #1350: M is deferred, F is only as far
as F0, and K is planned only.

**One ordering constraint is now explicit and was not before: lane Y blocks
lane V.** `memoryFsTypeScript` cannot reach 0 while `images/vfs/scripts`
imports `memory-fs.ts`, so any schedule that runs V to completion before Y is
wrong on its face.

**The whole campaign now stands at 160–315 agent-days across 20 lanes.** The
nine lanes added on 2026-09-11 were first scoped at 88–177; after their censuses
they are **71–143**, because five of them shrank and none grew. The censuses
cost roughly a day in total. That is the honest scale of what the plan
was previously not counting, and it is a floor like every other number here.

**For PR #1350 specifically**, what remains is **H** (browser plus curation,
3–6 d) and whatever of **T**, **X**, **C**, **B** and **S** the maintainer
wants inside it rather than after — a further **8–20 d** if all five go in,
**3–6 d** if only H does.

**What would make these wrong in the optimistic direction**, since that is the
direction they have always been wrong: a census turning up a second
implementation nobody knew about (this has happened twice — the SFFS duplicate
and the superseded fork reference engine); a "floor" turning out to be real
after all; or a defect found while working that has to be fixed before the lane
can continue, which has happened in every lane that has run so far.

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

**Status: characterized, dispatchable. The largest lane by line count and the
one the campaign most lost track of.**

## End state

The fork module drives each sub-sequence itself. The host calls **3–5 coarse
entries** — `fm_parent_seal_capture`, `fm_parent_replay`,
`fm_child_reconstruct`, `fm_abort` (the middle two may collapse into one
dispatched entry, giving 3) — and does nothing between them except the floor
below. **0–1 new host imports.**

Today there are **95 `fm_*` entry points**, several of them per-type variants
(`fm_capture_intern_externref` / `fm_capture_intern_funcref`,
`fm_externref_handle` / `fm_funcref_ordinal`). A prior document records a
**reached floor of 71**. Reconciling 71 against 95 is the first task of this
lane: either the surface regrew by 24 or the two counts measure different
things, and if it regrew that is the same species of finding as the TypeScript
growth below.

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

## Increments

- **F0 — delete what has no caller. ~4,400 lines, free.** `fork-reference-recipes.ts`
  (1,316 lines of which *two type declarations* are live), a 555-line dead
  encoder in `fork-reference-segments.ts`, a 270-line data feed in
  `fork-early-reference-provider.ts` made unreachable by the `fm_ref_*` import
  flip, and — maintainer-authorised — the generic owner-import registration path
  (~170) plus the ~850-line typed-signature mailbox layer that exists only to
  serve it. **No dependencies. Start here.**
- **F1 — reconcile 71 vs 95** and publish the categorized surface. Blocks F2.
- **F2 — collapse per-type `fm_*` variants** into kind-discriminated entries,
  the same move that took `host_blob_read` + `host_fetch_archive` to one
  `host_fetch_deferred`. Not in the same change as F0.
- **F3 — the four coarse entries**, in the order §3 gives: `fm_abort` first
  (it is the precondition for the others), then `fm_child_reconstruct`, then
  the parent pair.
- **F4 — delete the host-side drivers each coarse entry replaces.** *A coarse
  entry that does not delete its driver has not landed.*

## Acceptance evidence

- **Per commit: the production TypeScript delta.** A migration commit that is
  net-positive in TypeScript needs an explicit justification in its body or it
  is not finished. This is the lane's headline number.
- Host import count measured **from the built artifact**, expected unchanged at
  72 + `env.memory` — this lane is import-neutral, and anyone claiming
  otherwise should measure.
- For F0: a transitive caller census per deletion. A direct grep produced 13
  false alarms in one afternoon because most call sites reach their target
  indirectly.
- `wasm32-unknown-unknown` build in the loop (H-3).

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

---

# LANE V — the VFS image, and the filesystem we implement twice

**Status: partly characterized. V1–V3 landed; V4 blocked on a decision made;
V5 designed and building. The 12,000-line finding below is NOT yet
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

**V-D1 — there is no generated errno table.** `ENOENT`, `ENOSPC`, `EROFS` and
`EEXIST` are hand-written in `sharedfs-vendor.ts`, and `exec-target.ts` declares
its own `EAGAIN`, `EFBIG`, `EIO`, `ENOEXEC`. Errno numbers are ABI, and unlike
their neighbours they have no generator. Same class as L-D2 and W-D1.

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

**Status: characterized, small, dispatchable. Security-relevant.**

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

## The floor

The host performs the fetch — the network is its own. **Verification is not
the host's**: a kernel that trusts returned bytes cannot detect a substituting
host, and "a new host might not take precautions" is exactly the threat model
V4 creates by making new hosts cheap to write.

## End state

Deferred bytes are verified against a digest recorded with the reference, and
the setuid bit is not honoured on unverified bytes.

## Increments

- **S1 — host-side digest, cheap.** `createHash` is already imported in the
  emitter, and **`assertLazyIntegrity(data, kind, integrity)` already exists**
  and is called in three places for archives and trees. Emit the digest, carry
  it, call the existing verifier. **Belongs in lane V's SDEF record, not in
  JSON we are about to delete.**
- **S2 — kernel-side verification.** The kernel verifies the bytes it is handed,
  which makes a substituting *host* detectable rather than trusted. Needs a
  sha256 in the kernel; lands with V5, where the kernel parses the record
  anyway.

## Acceptance evidence

`setuidLazyWithoutDigest` reaches **0**, plus a test that a *tampered* byte
stream of the correct length is refused. The second half matters: a digest
that is recorded and never checked is a guard that cannot fail (H-2), and
length already passes today.

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

**Status: 14 of 15 modules anchored. `unguardedLayoutModules` 14 → 1.
BLOCKED on one maintainer decision (`itimerval`, below).**

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

## What landed

- **G1 — `stat`**, re-anchored from literals to macros; coverage 8 → 14 facts.
- **G2 — `iovec`, `msghdr`, `cmsghdr`, `sigevent`** in `channel_syscall.c`.
- **G3 — `statx`, `statfs`, `sysinfo`, `mq_attr`, `sigaltstack`,
  `sched_param`** in a new `libc/musl-overlay/src/stat/kandelo_layout_asserts.c`,
  which lands in `libc.a` so `build-musl.sh` verifies it.
- **G4 — `multicast_group_request` and `dev`**, the latter via a round-trip
  vector since it is three `const fn`s, not offsets.

103 constants emitted; 68 asserts.

## Acceptance evidence

`unguardedLayoutModules` reaches **1**, not 0 — see below.

Every batch was shown to fail before being trusted (H-2), including on the
field that motivated the lane: changing `statx::DEV_MINOR_OFFSET` produces
`static assertion failed … stx_dev_minor … drifted from
crates/shared/src/process_layout.rs`.

## BLOCKED — a decision for the maintainer

**`itimerval` cannot be anchored the way the others were, by design.** Its doc:
wasm32 musl "deliberately translates its public 32-byte time64 `struct
itimerval` to the kernel's historical four-`long` time32 record". Its constants
are `*_INDEX` wire slots, not struct offsets, so
`sizeof(struct itimerval) == ..._WASM32_SIZE` is **false on purpose**.

Driving the gate to 0 by writing an assert that happens to pass would be worse
than leaving it at 1. Two honest options:

1. **A different guard** — assert the wire record's shape at the site that
   performs the translation, rather than against musl's public struct.
2. **A recorded exemption** with the reason, and the lane's target becomes 1.

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
- **The ABI snapshot builder (`process_native_layouts`) still records only the
  original six modules**, so the committed drift-detection artifact has the same
  hole the header had. Not addressed here.

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

- **L2 — generate the scratch pointer table** from the kernel's export
  signatures, closing L-D2 below. Cheapest item; removes a hand-maintained ABI
  table.
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

**Status: E1 census COMPLETE — `docs/plans/2026-09-11-lane-e1-census.md`.
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
- **E3 — audit the 21 same-named worker-entry declarations** one at a time:
  shared concept, or genuinely per-host?
- **E4 — leave `*-kernel-host.ts` alone and record why**, so a later pass does
  not "discover" the divergence and try to merge it.

## Acceptance evidence

`hostPeerDuplicateDeclarations` reaches **12** — declaration names appearing in
both halves of a pair, excluding members destructured from the shared lifecycle
factory. Ceiling 65 (43 protocol + 21 worker-entry + 1 kernel-host). **Not 0**,
because `kernelWorker`, `port`, `maxPages` and `lifecycle` are legitimately
per-host instances of a shared concept.

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

**Status: R1 census COMPLETE — `docs/plans/2026-09-11-lane-r1-census.md`.
The lane is real, but it is not the lane that was written. Gate replaced.**

## What this lane is — as corrected by the census

**`host-native`'s equivalent of the 4,020-line TypeScript resolver is ten
lines**: a four-entry `ARTIFACT_TIERS` list and a first-existing-tier lookup.
The other 4,010 lines are policy the native host does not use — per-tier
identity, package closure, candidate expansion, source-only projection
authority — and that policy is **not duplicated anywhere**.

So the lane is not a resolver migration. **What duplicates is the tier list and
its order**, and it is spelled **eight times** across the writer and both
readers: `tools/xtask/src/local_build.rs` (7), `crates/host-native/src/lib.rs`
(2), `host/src/binary-tiers.ts` (1), `tools/xtask/src/build_deps.rs` (1).

**The drift already cost a measured failure.** `host-native`'s own comment
records that after a `./run.sh setup` that exited 0,
`local-binaries/source-only-v1/kernel.wasm` was fresh while
`local-binaries/kernel.wasm` was a seven-hour-old symlink, and `cargo test -p
host-native` **failed 39 of 53** with a missing export against a tree where the
build had just succeeded.

**And the right fix was already applied once, then stopped at the language
boundary.** `host/src/binary-tiers.ts` exists because TypeScript itself had two
copies that, in its own words, "drifted in both directions". Rust then made a
third.

## End state

One declaration of the tier roots and their order, in `crates/shared`,
generated into TypeScript the way ABI constants already are. The writer and both
readers consume it. `binary-resolver.ts`'s policy is untouched.

## The floor

Reading bytes from the host's own filesystem — Node `fs` in one host, fetch or
OPFS in the other. That is a byte-fetch, not a resolution policy.

**`binary-resolver.ts`'s 4,010 lines of policy are not floor and not lane R
work either.** They are simply not duplicated. The census establishes only
that; whether they are right-sized is a different question this lane does not
ask.

## Increments

- **R1 — census.** Done.
- **R2 — one declaration of the tier roots and order** in `crates/shared`,
  generated into TypeScript. `binary-tiers.ts` becomes the generated consumer.
- **R3 — `xtask` writes to the shared constant**, closing the writer/reader
  split that caused the 39-of-53 failure.
- **R4 — `host-native` consumes it**; `ARTIFACT_TIERS` is deleted.

## Acceptance evidence

`artifactTierPathSpellings` reaches **1**. The regression this closes is
concrete and already documented, so the decisive test is the one that would
have caught it: a check that the path the build writes and the path the hosts
read are the same constant, not two strings that happen to match.

## Known hazards

- **Resolution feeds the build**, so a wrong answer is a stale-artifact bug that
  presents as a kernel or package defect somewhere else entirely — which is
  exactly how the `source-only-v1` incident presented.
- **The seven `local_build.rs` spellings were counted by pattern, not read.**
  R2 must read them; some may be different concepts that merely share a string.
- **Only the source-only tier was counted.** `host/wasm` and the other two
  tiers may have the same problem and were not measured.
- **This lane is dev-and-build-time**, not on the wasmtime host's critical path.
  It is cheap and provable, not urgent.

---

# LANE Y — VFS image builders write the image format in TypeScript

**Status: Y1 census COMPLETE — `docs/plans/2026-09-11-lane-y1-census.md`.
The gate was measuring the wrong thing and has been replaced.**

`images/vfs/scripts/*.ts` — 13,502 lines, and **36 files under `images/`
import the TypeScript filesystem**.

## What this lane is — as corrected by the census

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

The lane text previously said three builders "write the format directly". **That
was wrong.** Only two files reach past `MemoryFileSystem` into
`sharedfs-vendor.ts`, and only for the constants `ENOENT`, `SFSError`, `S_IFMT`
and `S_IFREG`.

## Increments

- **Y1 — census.** Done.
- **Y2 — close the six image-level gaps** in Rust.
- **Y3 — move the three policy assertions** to sit with the writer, so a new
  image path cannot skip them.
- **Y4 — one bridge** the builders call instead of `MemoryFileSystem`, exposing
  the 24 methods over the Rust implementation.
- **Y5 — repoint 36 files.** Mechanical once Y4 exists.
- **Y6 — replace the four `sharedfs-vendor` constants** with generated ABI
  constants.
- **The recipes are not touched**, and that is the point.

## Acceptance evidence

`imageBuilderFilesystemImporters` reaches **0** — the fact lane V is blocked
on. Set by the census, and the census's own ceiling was corrected by the gate
on its first run (it reported 36 against a hand-counted 34).

The format evidence is byte equality: **nine production images must build
byte-identically** through the Rust writer before the TypeScript path is
removed — the corpus lane C already used for the lazy-identity gate.

## Known hazards

- **Lane V cannot close without this lane.** Any schedule putting V before Y is
  wrong.
- **A builder that silently produces a different image** is the worst outcome,
  because images are validated by running them and a subtly wrong image fails
  somewhere unrelated. Byte equality is the only acceptable bar.
- **The three policy assertions are the most likely thing to be silently
  dropped.** They live inside `serializeImage` today, and nobody has checked
  whether a test would notice their absence.
- **Byte-identical output may require changes to the Rust writer's block
  allocation order.** Four cross-language fixtures suggest it is achievable;
  nine whole images is a much larger claim.

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
