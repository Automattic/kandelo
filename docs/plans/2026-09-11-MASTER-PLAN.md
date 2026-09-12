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
| **V** VFS / one SFFS | **10–20 d** | **unknown until V6** | The six-consumer census decides everything. Serving them from the kernel is the bulk; deleting 3,752 lines is the easy end. |
| **P** platform honesty | **10–15 d** | medium | Five independent instances. `st_rdev` is ABI-adjacent on the stat wire; the UI trio is smaller but one item is a product decision, not an engineering one. |
| **T** test hygiene | **5–10 d** | **unknown until T5** | One file carries 28% of failures and reproduces in isolation. Until it is diagnosed, "40 timeouts" could be one defect or forty. |
| **S** setuid integrity | **5–10 d** | medium | S1 is 1–2 d — the verifier already exists and the emitter already imports `createHash`. S2 needs a sha256 in the kernel and should land with the SDEF record. |
| **C** conformance | **4–7 d** | medium | C1 is a runner-contract change; C2 is following through on two XFAIL'd gaps. The 8 remaining failures are all harness. |
| **B** build truthfulness | **4–7 d** | medium | Reconciling the cheap path with the freshness gate is a decision plus a day; stamping the fixtures is the larger half. |
| **X** process and exec | **2–5 d** | medium | Blocked on one panic with a precise bisect. Once found, the repoint is a one-commit reapply. |
| **H** browser + curation | **3–6 d** | medium | The browser pass is short if provisioning holds; curation of ~370 commits into ~14 is a day or two with `commit-tree`. |

**Serial total is not the useful number** — these run in parallel lanes. The
**critical path is F and M**, both 15–40 d and both low confidence, and neither
is in #1350: M is deferred, and F is only as far as F0.

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

- **V6 — census the six consumers.** `rootfs-overlay.ts`, `memory-fs.ts`,
  `image-helpers.ts`, `package-deferred-tree.ts` and two image scripts hold the
  TypeScript filesystem up. For each: what does it actually need — a mounted
  tree, a byte range, a directory listing — and can the kernel serve it?
  **This is the deliverable that decides whether the rest is weeks or days**,
  and nobody has done it.
- **V7 — serve those needs from the kernel**, through the export the writer
  already has (`kernel_rootfs_export_tree`) plus whatever the census shows is
  missing.
- **V8 — delete `sharedfs-vendor.ts`.** The lane closes here, not at V7.

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

# LANE K — `kernel-worker.ts`, the host's second syscall table

**Status: characterized. Never previously named as a lane, and it is the file
every other lane queues behind.**

## End state

The host worker transports syscalls and does not interpret them. Syscall
identity, argument shape and dispatch belong to the kernel, which already owns
them for every call it serves itself.

## The floor

The worker must own the **channel**: reading a request out of shared memory,
entering the kernel, writing the reply, and the retry/park machinery around a
blocking call. That is transport. **Knowing what `SYS_IOCTL` means is not.**

## Increments

- **K1 — census the 515 `SYS_` references.** Which are transport (size a
  buffer, choose a scratch path) and which are semantics (decide an argument's
  meaning, pick an errno)? The second group is the lane.
- **K2 — retire the semantic cases**, starting with any that duplicate a
  decision the kernel already makes. Two dispatch-table defects this campaign
  found — `setsockopt` and `ioctl` each taking the sixth channel word as a
  pointer width — were *kernel*-side, but they were invisible partly because
  the host carries a parallel understanding of the same calls.
- **K3 — split what remains.** A 32,718-line file is a contention point and a
  measurement hazard in its own right.

## Acceptance evidence

`kernelWorkerTypeScript` falls to **12,000** in the budget. Per increment, the
host suite stays green — this file is the syscall hot path, so a regression
here is not subtle.

## Known hazards

- **Contention.** Lane F's A5, lane X's spawn work and the wait-path lane all
  live here. Two agents in this file produce a merge that compiles by luck.
- **It is a measurement hazard.** Moving code inside a file this size shifts V8
  parse and compile for unrelated functions — visible in the select A/B, where
  untouched metrics scattered up to +1.94 µs with identical arms.
- **`CLAUDE.md` names known-bad optimizations here** — syscall argument-count
  tables, classification sets, cached `DataView`s, conditional debug logging.
  Do not reintroduce them while restructuring.

---

# LANE G — ABI binding drift

**Status: characterized. Small, and it is the mechanism behind a defect already
found.**

## End state

Every `process_layout` module the C side depends on reaches C through the
generated header, and each emitted constant carries a `_Static_assert` against
the musl definition — so a constant that drifts fails the build instead of
producing a plausible wrong answer. The header is the delivery mechanism; the
assert is what makes it a gate, and G1 is not done until both exist.

## The floor

None. The generator, the layouts and the headers are all ours.

## Increments

- **G1 — extend `render_process_layouts_header`** from the 6 modules it imports
  (`iovec`, `msghdr`, `cmsghdr`, `multicast_group_request`, `rt_sigqueueinfo`,
  `sigevent`) to all 15. The other 9 — `sigaltstack`, `itimerval`, `mq_attr`,
  `statfs`, `sysinfo`, `stat`, `dev`, `statx`, `sched_param` — reach C as bare
  literals or not at all.
- **G2 — move the remaining bare literals into layout modules.** `statx`'s
  offsets were numeric literals in `wasm_api.rs` with no constant anywhere.

## Acceptance evidence

`unguardedLayoutModules` reaches **0**. Demonstrated by perturbing one offset
and watching the C side fail to compile — a static assert nobody has seen fail
is a guard that cannot fail (H-2).

## Known hazards

- **The snapshot gate does not cover this and will report green.** `xtask
  dump-abi` captures syscall numbers, kernel exports and generated constants —
  not struct offsets. This is the documented "necessary but not sufficient"
  case, and reading a green snapshot as coverage is how the gap survived.
- **`statx` is the proven instance**: `stx_dev_minor` was never written and the
  "major" was the low 32 bits rather than the major half, so even a small
  device number reassembled wrongly. Nothing objected.

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

## End state

Every host-suite failure is attributed to a named cause. Not zero failures —
attributed ones. A suite with 40 unexplained failures and a suite with 40
explained ones are different artifacts, and only the second can gate a release.

## The floor

Browser-dependent tests cannot run here and belong to lane H. Everything else
is expected to run.

## Increments

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

# Unclaimed surface — the survey this plan was missing

**`docs/plans/2026-09-11-repo-survey-unclaimed-surface.md` holds the complete
repo scan.** Read it before adding or closing a lane.

The short version, because it changes how this plan should be read: of
`host/src`'s 134,776 production TypeScript lines, lanes K, F and V claim 86,970.
**47,806 lines across 106 files are claimed by no lane at all — more than the
fork lane.** Outside `host/src` there are a further 14,091 TypeScript lines of
VFS image builders, 25,658 lines of shell plus 9,729 of TS/MJS build automation,
and 5,360 lines of `web-libs` session contracts, none of it claimed either.

The survey names seven clusters with evidence and coupling measurements:
dynamic linking (3,263), binary resolution (4,020), the host↔kernel plumbing
that *is* goal V4 (11,481), the Node/browser host pairs (7,513, and ~70%
divergent rather than duplicated), the process/exec host side (8,359 — behind
lane X's 12-reference gate), the image builders (14,091 — goal V3), and build
automation.

**None of those clusters is a lane yet**, because none has the five-section
characterization this file requires, and for most of them the floor has not
been established. They are listed so that "is everything covered?" has a
written answer instead of a remembered one. Two consequences of the survey are
already applied: lanes K, G and D exist, and `memoryFsTypeScript` closed lane
V's gate hole.

**This plan is therefore not yet complete, and should not be described as
complete.** It is complete for the lanes it characterizes.

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
