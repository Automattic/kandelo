# Rust-First Runtime: Value-Driven Plan

> **Durable record.** If context is lost, this file plus
> `2026-09-09-whole-kernel-rust-migration-census.md`,
> `2026-09-09-runtime-ts-disposition-ledger.md`, and `git log` are the
> recovery map. Trust them over recollection.
>
> Written 2026-09-09. Worktree `/Users/brandon/kandelo-abi44-reconcile`,
> branch `brandonpayton/rust-first-abi44-reconcile` (head of PR #1350).

## 1. The values, in the maintainer's words and in priority order

Every work item is justified by what it delivers against these. An item that
serves none of them does not belong in this campaign, however tidy it looks.

| # | Value | What it buys | How progress is measured |
|---|---|---|---|
| **V1** | **Share code across hosts** | One implementation instead of one per host. Node, browser, and native wasmtime stop drifting; a new host inherits behavior instead of re-implementing it. | Lines of *duplicated* host logic eliminated; number of hosts that must implement a given behavior |
| **V2** | **Deeper type checking** | Move logic into Rust's type system: exhaustiveness, ownership, no hand-maintained wasm32/wasm64 offset pairs, no untyped `Map<string, …>` standing in for kernel objects | TS kernel-state containers removed; hand-maintained duplication removed |
| **V3** | **Bundle a kernel with a VFS** | ABI changes stop breaking VFS images. The kernel owns the image format; the only versioned boundary is kernel↔host | Image ABI stamp removed; image parsing owned by Rust |
| **V4** | **Smallest possible host API surface** | New hosts are cheap and elegant to write and maintain | **Distinct concepts** a host must implement (§4). Import count is a secondary readout, never the target |

**The Bar (maintainer, 2026-09-09):** *"We want to do the right thing most
of all. Sound engineering. Complete engineering. No cheats or hacks."*
A boundary is a floor only when it is **proven** to be one. Truthful failure
over convenient illusion.

### Generic-first (maintainer, 2026-09-09) — a standing rule, not a one-off

> *"Kandelo aims to be a generically applicable POSIX-compatible kernel. We
> don't really choose and implement special cases at all without good reason."*

Raised after this plan recorded that PHP is the only artifact performing a
runtime `dlopen`, and framed it as something that "materially shrinks K5's
blast radius". That phrasing invited a PHP-shaped linker. The maintainer's point
is that this is **a typical pattern in this repository**, not a single slip.

**The rule.** Knowing which packages exercise a subsystem today bounds the
**validation surface**. It never bounds the **design**. A POSIX interface must
be generically correct whether or not any in-repo artifact reaches a given path.
`docs/agent-guidance` already says it — *"a fix that only makes one program,
demo, package script, or button work is suspect"*, and *"missing or incomplete
POSIX behavior is a platform gap to close, not permission to weaken the model or
add software-specific behavior"* — this records that it binds **campaign
decisions**, not just code.

**The failure mode to watch for**, because it is subtle and sounds responsible:
"only X uses this, so we can scope to X" · "no package hits that path, so the
current behaviour is fine" · "the fixture set doesn't cover it, so it's out of
scope". Each of those silently converts a coverage fact into a design licence.

**Where generic correctness cannot be validated with today's package set, record
a documented boundary — do not narrow the implementation to match the tests.**

**Applied so far:** K5's guard (§2j D2) on `dlopen`, and the two adjudications
most exposed to it (the GOT zero-write on ELF/`RTLD_LAZY` semantics rather than
PHP's symbol set; the table-scan structure on generic symbol profiles rather
than `intl.so`'s). K1 had already made the right call independently by refusing
the `SOURCE_PATH_DERIVED` optimisation because the 7,467/7,467 match was a
property of *today's builders* rather than of the format.

**Needs re-checking under this rule:** K10's ranking was argued partly on
"a capability with no in-repo consumer". Ranking by value is legitimate — WASI
genuinely serves fewer users today — but the reasoning is one step from
"therefore implement less of it", and the item's held deletion (I6) is gated on
fixtures rather than on generic correctness. Re-read that decision before I6
lands.

**Scope:** the runtime — everything required to run the kernel on a host,
including fork capture/replay. Explicitly **not** the build/packaging
toolchain (`tools/mkrootfs`, `images/vfs/scripts`, `scripts/`, `sdk/`,
`packages/**`), `benchmarks/`, or the `apps/browser-demos` UI.

**Constraint that unlocks the plan:** *"This entire campaign is one ABI
epoch. I don't mind if you need to iterate on the campaign's ABI or
instrumentation."* Re-instrumentation and package rebuilds are available.
Nothing in this plan is blocked by a frozen guest ABI.

**Maintainer is sole merger. Never merge.**

## 2. Settled facts — do not re-derive these

Context loss should not cost a re-derivation. Each of these is measured, not
estimated. Full method in the census §12.

**Scale.** In-scope runtime TS ≈ **153,000 lines**. Of that ≈**62,000 is
migratable (b)**, ≈**9,000 eliminable outright (x)**, ≈**40,000 genuine
adapter (c)**. For contrast, `crates/runtime-core` + `crates/kernel` is
113,054 lines today.

**`kernel-worker.ts`** is 34,875 lines: one class, **539 methods** (exact
LSP spans), **114 properties of which 68 are `Map`/`Set` kernel-state
containers**, 2,744 lines of preamble, and 1,444 lines of
`#createTestAuthority` test scaffolding compiled into production.

**Host contract.** 85 `env.host_*` bindings; `HostIO` is 83 trait methods
with exactly **one** production implementor (`WasmHostIO`,
`crates/kernel/src/wasm_api.rs:318`). **25 of the 85 exist only because the
host is asked to resolve file names.** `EXPECTED_HOST_IMPORT_COUNT = 84`
(`crates/host-native/src/lib.rs:77`) is a ratchet with a maintained
changelog — useful, but **not the goal** (it has gone *up* twice, and it
would reward collapsing the contract behind one opaque call).

**Kernel exports.** 336 declared. Decomposed: **154 TS-only** + **35 both**
= 189 host drive surface; **119 dispatch-only** (internal, to be
*privatized*, not deleted); **24 dead**; 2 test-only; 1 native-only;
1 `__abi_version`.
*(Corrected 2026-09-09 by K13a grounding. The original census said 26 dead /
117 dispatch-only. `kernel_time` and `kernel_brk` are LIVE — called from
`dispatch_channel_wide_result`, `wasm_api.rs:3933`/`:3941`. Two independent
mistakes caused the miss: the dispatch-attribution window was
`3960-6444`, and `dispatch_channel_wide_result` sits at `3924-3948` just
above it; and the dead-set verification excluded `wasm_api.rs` from its own
caller search. Verified in code 2026-09-09.)*

**host-native is a partial host** by design — it defines the boot/trivial
path and leaves the rest to `define_unknown_imports_as_traps`
(`guest.rs:1656`): 20 `env` `func_wrap` registrations plus 9 defines, ~60
trapped. So scheduler and mapping work creates little native work; cross-
memory, dynamic linking, and the handle-only contract create real native work.

**K0 probe results (2026-09-09, Node v24.15.0 / Chromium 151 / WebKit 26.5,
all three agree).** Full table in census §8.

- **P1 PASSES.** A module recovers a GC value's concrete type by a
  `ref.test` cascade over its own type section — structs, subtypes (tested
  most-derived first), and `i32`/`f64`/`anyref` arrays. Contents read back
  generically. Structurally identical declared types canonicalize to one
  type, so "which declaration" is not a question reconstruction must answer.
- **P2 PASSES.** A GC-derived externref keeps its identity through a full
  round trip via the host — including being stored in a JS `Map` — and its
  concrete type is still recoverable afterwards.
- **P2c control returns 0 on all three.** A genuine *host* externref is not
  `ref.eq`-comparable once internalized.

**Therefore:** **`resolve_externref` (handle → canonical host externref) is
a genuine fork reference floor**, and it is irreducible because the value is a
host object.

> **CORRECTED 2026-09-09 by K12** (probes independently re-run — Node
> v24.15.0, Chromium 149.0.7827.55, WebKit 26.5, all 15 rows identical). This
> entry previously read "Provenance does not need recording because it is
> recoverable by casting. `ForkGcProvenanceRegistry` is eliminable." **That
> inference is wrong and must not be acted on.** The `ref.test` cascade P1
> validates was already implemented and already sorted most-derived-first
> (`crates/fork-instrument/src/module_gc_codec.rs:1278-1316`, `:2132-2140`), so
> P1 confirms existing behavior rather than unlocking a deletion. Provenance
> records **constructor shape** and **allocation seeds**, not type identity.
> An immutable, runtime-length GC array with non-uniform contents has **no**
> reconstruction path in the wasm instruction set other than
> `array.new_data`/`array.new_elem` from a static segment
> (`array.new_fixed`'s length is an immediate; `array.copy`/`array.init_data`
> require a mutable destination), so that provenance is a proven floor. P1's
> canonicalization result and the P2c control additionally argue *for* the
> cross-activation and externref provenance paths. Full reasoning, and the one
> sub-path that may still be reducible (the struct seed), are in
> `docs/plans/probes/2026-09-09-k0/README.md` § "Correction".

## 2b. Grounding round 1 — outcomes and maintainer decisions (2026-09-09)

All four Tier-1 items were grounded read-only. **Every one changed.** Groundings:
`2026-09-09-k1-sffs-wiring-grounding.md`, `-k2-cross-memory-grounding.md`,
`-k10-wasi-shim-grounding.md`, `-k13a-dead-exports-grounding.md`.

**K13a — dead exports.** 24, not 26. `kernel_time` and `kernel_brk` are LIVE
(`dispatch_channel_wide_result`, `wasm_api.rs:3933`/`:3941`) and belong to the
later privatization item. DECIDED: delete 24; **keep** `kernel_get_stack_pointer`
and `kernel_reap_process` (they guard a real 4,096-iteration shadow-stack leak
regression on both hosts); **no ABI bump** (`abi-versioning.md:790-794` — an
unreleased epoch is amended, not superseded); surgical `libc/glue` cleanup only,
with a musl rebuild. `kernel_mmap`/`kernel_mremap` are not a gap — they are
unvalidated duplicates and `kernel_mmap` discards errno.

**K2 — cross-memory.** DECIDED: `addr: u64`, `len: u32`; **fold into ABI 44, no
bump** (import signatures are absent from `abi/snapshot.json`, so widening
yields no diff); proof target swapped from msgsnd to **`SIOCGIFCONF`** (nested
pointer, no blocking-retry entanglement, deletes hand-maintained wasm32/wasm64
offset pairs). Also fixing two live defects the grounding found: the `HostIO`
defaults return `0` = success while copying nothing (`process.rs:361,370`), and
`netif.rs:11-13` + `ioctl_contract.rs:46-52` assert as fact that the kernel
"cannot itself reach" process memory — **false**, and the campaign's FOURTH
inherited-and-disproved floor. **Tier correction:** the *primitive* is Tier 1;
"dissolves all pre-dispatch marshalling" belongs to **K6**, which is not
low-risk. K6's load-bearing rule: *copy once into kernel memory, then parse;
never re-read a validated value from guest memory* — else every conversion adds
a TOCTOU that does not exist today.

**K10 — wasi-shim.** DECIDED: full scope including host-native (I7), but ranked
**below K1 and K13a**; fix the five latent defects in the Rust port rather than
porting them bug-for-bug, and extend `Errno` with the 17 missing variants.
Destination corrected: it is **guest-side**, so it becomes a co-resident Rust
PIC side module (`fork-module` pattern), not a `runtime-core` module. Needs no
ABI motion. Real payoff: `host-native` has no WASI at all today.

**K1 — sffs.** The SFFS *binary* layer is empirically proven complete (four
production images decode exactly, matching `mkrootfs inspect`). But lazy-file
metadata lives in a **trailing JSON blob** (2.78 MB for shell/wordpress), so
kernel-side parsing would need a new no_std JSON subsystem. DECIDED:
**re-ground the format first** (`2026-09-09-k1b-image-format-grounding.md`) to
test whether that JSON can become a binary section `sffs.rs` already reads, or
be fetched on demand through the existing byte provider — deleting the problem
rather than solving it. K1 implementation is held pending that.

## 2c. K1b image-format decisions (2026-09-09, decided under delegated authority)

Maintainer was AFK and granted "decide everything, report after." Each call
below is recorded with its reasoning so it can be audited or reversed.
Grounding: `2026-09-09-k1b-image-format-grounding.md`.

**The finding that reframes K1.** The VFSI trailer is three JSON sections and
nothing else (VERIFIED: zero unparsed tail bytes across all nine production
images). Only two facts in it are kernel-relevant — a lazy file's real size and
an archive member's `(archive_id, source_path, size)` — and **the kernel already
receives both today, in binary**, via RTFS v3 `KIND_LAZY_FILE`
(`rootfs.rs:977`). The JSON is a *persistence* form, not the kernel's interface.
So the no_std JSON parser problem is **deleted, not solved.**

1. **ADOPT recommendation (B):** a binary `KLZY` section in the repo's own
   `KFIG` idiom (469 KiB explicit vs 2,792 KiB JSON), appended under flags
   bit 4, dual-written, equivalence proven on all nine images, then cut over.
   (A) rejected: no JSON parser exists in the kernel and `runtime-core` has 3
   deps, no serde. (C) on-demand rejected **on evidence**: `shell.vfs` has 10
   genuinely-empty regular files coexisting with size-0 lazy stubs, so the lazy
   *set* must be known at load.

2. **SD-B1 — do NOT repurpose `host_blob_read`; add a typed
   `ByteReq::Image { offset }` variant instead.** `blob_id` currently *means*
   "the file's inode number"; making one opaque id mean two things is a
   semantic-surface increase wearing a no-change disguise — exactly what V4
   opposes and `abi.md` warns about. The typed variant needs no import change,
   is unambiguous, and its 8 `match req` sites are mechanical work the compiler
   finds for us (that is the V2 benefit, not a cost). This dissolves the
   ABI-semantics question rather than requiring a ruling on it.

3. **D-B1 / SD-B2 — steps 1-4 are snapshot-regen only, NO `ABI_VERSION` bump.**
   Additive and VERIFIED invisible to every existing reader. **Step 5 (removing
   the JSON `entries[]`) is split into its own item** with its own ABI ruling,
   recorded in `docs/abi-versioning.md` rather than left implicit. Guest-ABI
   stamp removal is likewise separate.

4. **SD-B5 — do NOT adopt `SOURCE_PATH_DERIVED` on today's evidence.** The 100%
   path-redundancy match is a property of current *builders*, not of the format.
   Plan on the **469 KiB explicit** figure; derived paths are an optimization
   gated on a per-group proof plus an explicit fallback. Banking 18.5× on a
   builder coincidence is the convenient illusion the Bar forbids.

5. **SD-B3 — prove the mutation ordering, do not infer it.** "The three host
   mutations all precede `init`" is inference from call ordering. A paged cursor
   re-reads blocks after boot and widens that window, so K1 must land a test
   that proves the ordering — or the cursor gets `Atomics` discipline. No
   inference-backed safety property.

6. **SD-B4 — ranged archive reads REJECTED** and recorded so they are not later
   adopted as an "optimization": they would grow host capability (HTTP Range on
   both hosts), which V4 forbids without proof of necessity.

7. **D-B2 — adopt the split.** Kernel-needed subset (ino, archive, size, source
   path) goes into `KLZY` for all kinds; host-needed open-ended metadata (URLs,
   integrity, seals, activation) stays JSON in a host-only section. No
   capability is withdrawn and the kernel never parses a variable shape. No
   further investment in the unused typed-tree schema; it is not removed either.

8. **D-B3 — DEFER the SFFS inode deferred-backing flag.** Saves 30 KiB; costs
   opening a shared on-disk inode contract every reader depends on. Not worth it.

9. **D-B4 — carve-out ACCEPTED.** The VFSI **container encoding** in
   `host/src/vfs/` is explicitly IN scope (it is runtime format authority).
   `tools/mkrootfs`'s CLI, manifest language, and build behavior stay OUT.
   **Consequence for K8:** it may not simply delete `memory-fs.ts` — it must
   carve out the builder surface `tools/mkrootfs/src/builder.ts:24` imports by
   source path.

10. **D-B5 — the three pre-manifest host mutations remain OPEN**, and are now
    recorded as a blocker for the *cutover* (step 5 / stamp removal), not for
    steps 1-4.

11. **K1 returns to Tier 1.** SD-1 is disproved (a full tree build touches
    ≤9.48 MiB even for the 249 MiB `lamp.vfs`, not 208–256 MiB); the `Sffs`
    refactor is a **paged cursor over a `BlockSource`**, 18 call sites across
    six functions, not a rewrite; blast radius into the toolchain is **zero code
    changes**.

12. **K10 is unblocked** — it was ranked below K1 and K13a, and both are now
    dispatched.

**Conflict-avoidance note:** K13a and K2 are in flight and both edit
`crates/kernel/src/wasm_api.rs`. K1's `ByteReq::Image` wiring also touches it
(`:1611,:1661`) plus `syscalls.rs`, so K1's first increments are deliberately
scoped to files those two do not touch; the `ByteReq` wiring lands after they
merge.

## 2d. Execution policy: commit small, validate in batches (2026-09-09)

Maintainer directive: *"Let's try to batch testing as much as possible, even
combining different work items... I often find agents spending a lot of time
testing small steps, and I'd much prefer to be taking large strides."*
Consistent with the standing `work-in-larger-strides` preference.

**Commit frequency and validation frequency are separate decisions.**

- **Commit early and often.** Cheap, and it is the only protection against a
  mid-flight failure. Two implementation agents were killed by transient API
  500s on 2026-09-09 with an hour of uncommitted work between them; one had to
  be rescued by the coordinator committing on its behalf (`9687b775b`).
- **Validate in batches, at meaningful checkpoints — not per increment.**

**Per-agent validation keeps only what is load-bearing for that item:**

| item | keeps | because |
|---|---|---|
| K13a | affected `cargo test`; `check-abi-version.sh update` + verify; musl rebuild if `libc/glue` touched; the retirement test | the snapshot IS the item |
| K2 | `cargo test` runtime-core + kernel; `cargo test -p host-native --target aarch64-apple-darwin` | native impl is the item and is irreplaceable |
| K1 | `cargo test -p runtime-core`; nine-image `KLZY`-vs-JSON equivalence; the SD-B3 ordering test | equivalence IS the gate |
| K10 | new-crate tests; the differential harness; host-native for I7 | the harness IS the gate |

**Deferred to ONE coordinator-run group pass on the integration branch:**
`cargo xtask verify-fresh`, full Vitest, the conformance suites
(posix/libc/sortix), and browser validation. Running these per agent is four
expensive duplicates of a check that is redone at merge anyway — and
`check-abi-version.sh` rebuilds the kernel wasm on every invocation.

**What batching must NOT erode.** Each item's own gate is not a "small step" to
economize on: K1's nine-image equivalence, K10's `.wat` fixture breadth, K2's
host-native tests. Batching means fewer validation *passes*, not thinner
evidence. An agent that batches its testing AND thins its gate has produced an
unvalidated change, and the report must distinguish "left to the group run"
from "not tested".

## 2e. K13a — COMPLETE (2026-09-09)

Worktree `.claude/worktrees/agent-a8af1a632d70ed416`, branch
`worktree-agent-a8af1a632d70ed416`, base `9638a2023`. Commits `da51e4c99`,
`5b47e478c`, `ba80be1be`, `dac344704`. 7 files, +87/−650. **Not pushed; merge,
do not fast-forward** — the campaign tip has since gained the docs commit
`899261824`.

**Result.** 24 of 24 deleted; none turned out live. `pub extern "C" fn` 336 →
312. `kernel_time`/`kernel_brk` correctly left alone; the two test-only exports
untouched. `libc/glue` cleaned surgically (14 `KERNEL_IMPORT` decls removed, 10
`syscall_glue.c` sites now return `ENOSYS` with a reason) and **musl was
rebuilt** for both wasm32posix and wasm64posix.

**Evidence.** `check-abi-version.sh update` produced a diff of *exactly* 24
removed `kernel_exports` entries and nothing else, with `abi_version` still 44
and every generated header plus `host/src/generated/abi.ts` regenerated
byte-identical — an independent proof that none of the 24 sat in a
required-export list. `cargo test -p kandelo` 7/7. The retirement-contract test
passes **and was shown non-vacuous** by injecting a live `kernel_time` and
watching it fail. Strongest single artifact: a scan of **all 143 built `.wasm`
artifacts** found 16 distinct `kernel.*` imports with **zero intersection** with
the 24 — guest-level proof no shipped binary linked them.

**A fragile pattern this exposed, worth remembering.**
`wasm_api_channel_pointer_contract.rs` delimited `kernel_utimensat` by the
literal string `"\n/// Remap memory."` — i.e. by the *doc comment* of the
adjacent `kernel_mremap`. Deleting that export silently broke the contract test's
range. Now sliced by the next `pub extern "C" fn` signature instead. Tests that
parse source by prose are landmines; expect more.

**D2 — DECIDED: open the ABI 44 section.** Done: `docs/abi-versioning.md` now
carries `### ABI 44 opaque transport, kernel-owned exec targets, and export
reduction`, recording the amendment rule and what 44 contains so far. Later K
items append rather than leaving the epoch's contract scattered across
`docs/plans/`.

**D4 — already handled.** The 26→24 and 117→119 corrections landed in this file
and the census before K13a reported; the agent based its work earlier and could
not see them.

**Follow-on for K13b (recorded, not acted on):**
`Process::note_legacy_posix_timer_interval_fire`
(`crates/runtime-core/src/process.rs:1945`) now has only three test callers.

### Two PRE-EXISTING failures on the branch — do NOT misattribute at group validation

Both were proven pre-existing by restoring base files and re-running:

1. `host/test/kernel-scratch-contract.test.ts` — 3 of 8 fail
   (`kernel_spawn_blob_decode` pointer role, 27 audit rows,
   `SPAWN_MAX_ARGV_COUNT`). Identical failures with the 5 base files restored.
2. `runtime-core zip::tests::real_man_zip_cross_checks_members` — 1421680 vs
   1397299. Baseline recorded 2026-08-30 in `a1d3e98a1`; `channel_syscall.c` and
   `kandelo_syscall_marshal.h` both changed on the branch afterwards.

Neither is caused by K13a. The group validation run must expect them, and they
are their own follow-up.

## 2f. K1 — COMPLETE (2026-09-09)

Worktree `.claude/worktrees/agent-acf13642165369fc6`, base `9638a2023`.
Commits `9687b775b` (coordinator WIP rescue), `b5ecebe3d`, `5c3a73aea`,
`f76020ed0`, `2052a5dfd`, `297af0cc9`, `9f88438ef`. 15 files, +2,352/−195.
VERIFIED merge-safe: neither `wasm_api.rs` nor `syscalls.rs` is in the diff, and
the agent's `local-binaries`/`host/wasm` symlinks are NOT committed.

**KLZY landed** in the `KFIG` idiom, constants in `crates/shared/src/lib.rs`:
20 B header; 24 B group record (`archive_id` nonzero and strictly increasing);
24 B file record (`ino` nonzero and unique, `archive_id` 0 = URL-backed, path
length zero **iff** archive_id 0). Paths explicit as directed; a group flag is
*reserved* for a future proven derived-path writer. Records are 24 B rather than
the sketch's 20 B (u32 lengths + reserved), so measured sizes run ~6% above the
469 KiB estimate — disclosed rather than quietly absorbed.

**Equivalence: all nine images green**, KLZY vs the RTFS v3 manifest the kernel
actually consumes.

| image | KLZY | lazy JSON |
|---|---|---|
| rootfs.vfs | 1,580 | 10,720 |
| shell / wordpress / lamp / nginx-php / nginx | 510,295 | 2,792,104–2,792,246 |
| node-vfs | 327,569 | 1,845,890 |
| kandelo-sdk, mariadb-test | 20 (empty) | 0 |

≈5.5× smaller on the images that matter.

**SD-B3 resolved better than asked.** I required proof that the three host
mutations precede `init`. The agent instead proved the concern *does not apply*:
`fromImage` copies into a fresh SAB and all three mutations
(`normalizeLegacyRootfs`, `ensureMountParentDirectories`, the browser TLS-cert
write) operate on that copy, so the source image is never mutated at all. The
test drives the real functions, asserts each mutation fired, asserts the image is
byte-identical afterwards, and demonstrates non-vacuity. A third test pins D-B5 —
a raw-image reader sees none of the three — as a *tested fact* rather than an
inherited assumption. **No `Atomics` discipline needed.** Buffer identity beat
call-ordering.

**Cursor:** `Sffs<S: BlockSource>`, 18 sites across 6 functions, with
`impl BlockSource` for `[u8]`/`Vec<u8>`/`&T`. No cache added — explicitly
unmeasured, so no performance claim; the inode was hoisted out of `read_at`'s
loop instead.

**Ran:** `cargo test -p runtime-core` 1782 pass / 1 fail; `cargo check` wasm32
clean; Vitest 25 files, 552 pass / 1 fail; mkrootfs 183 pass. Explicitly left to
the group run and explicitly marked **unproven rather than clean**:
`check-abi-version.sh`, `verify-fresh`, full Vitest, conformance.

**DECIDED (a) — the equivalence gate must HARD-FAIL, not skip.** It currently
skips when the VFS images are absent. A gate that silently passes without its
fixtures certifies nothing, and CLAUDE.md is explicit that a missing artifact is
a provisioning step, not a boundary. Same pathology as the `zip` test below,
whose verdict flips on artifact presence. **Integration task:** make it fail with
an actionable message naming how to produce the images. Not worth respinning the
agent; folded into the merge.

### Pre-existing failures — now THREE, none caused by this work

1. `runtime-core zip::real_man_zip_cross_checks_members` — **found independently
   by both K13a and K1**, which is good corroboration. `man.zip` is 1,421,680 B
   against a hardcoded 1,397,299 baseline recorded 2026-08-30 in `a1d3e98a1`;
   `channel_syscall.c` and `kandelo_syscall_marshal.h` changed afterwards. Note it
   *passes* when `local-binaries` is absent — the same skip-vs-fail pathology.
2. `host/test/kernel-scratch-contract.test.ts` — 3 of 8 fail; K13a proved
   pre-existing by restoring base files.
3. `vfs-image-wasm-policy` — `host/src/constants.ts:2580` still says **"ABI 43"**
   while `ABI_VERSION` is 44. A genuine stale-artifact claim that the platform's
   own fail-loudly-on-stale contract should have caught. Deserves its own item.

All three need owners; none blocks the merge, but the group run must expect them.

## 2g. K2 — COMPLETE (2026-09-09)

Worktree `.claude/worktrees/agent-a55b06b94200352e9`, base `9638a2023`.
Commits `7d3b69f1c` (I0 truthful defaults) · `7e6aa80e4` (I0b false comments) ·
`c7c76bc59` (I1 host-native) · `625753908` (I2 widen to u64) · `eb36f4be3`
(I3 SIOCGIFCONF). All five increments landed. Not pushed.

**ACCEPTED deviation — no pid→SharedMemory registry in host-native.** The
grounding sized one at ~150-200 lines; the agent instead checks `pid` against
the `current_pid` the pump binds before every `kernel_handle_channel` call,
in ~90 lines. Its argument is better than the plan: that check *is* the contract
term — the only sound target is the dispatching process, which is live by
construction — and it has **no stale state to miss**. A registry would have to
track 4 creation sites, `handle_exec_common`'s whole-image `mem::replace`
(which the agent upgraded from INFERRED to VERIFIED), and every teardown; one
missed update is a silent write into the wrong process's memory. A
non-dispatching target now returns `-ESRCH`. **Native is consequently stricter
than the JS host** — see D2 below.

**Proof that the mechanism works end to end:** `vitest run test/ifhwaddr.test.ts`
→ 2 passed, **wasm32 and wasm64**, with the TypeScript `handleIoctlIfconf`
intercept deleted. That is the kernel reading guest memory directly through the
widened primitive, on both pointer widths.

**Snapshot behaviour, correctly characterised.** I2 (the u64 widening) produced
**no snapshot diff** — and the agent flagged that as *the finding, not a clean
bill*: `check-abi-version.sh` cannot see import signatures at all. I3 does move
the snapshot (+`ioctl_request_contracts`, −3 `kernel_exports`); no version bump,
per the ABI-44 amendment decision.

**Ran:** runtime-core + kandelo 1768/3/4/6 passed, 0 failed; host-native 52
passed, 0 failed, 4 ignored (pre-existing); `check-abi-version.sh` verify
consistent; the three kernel-scratch suites 348 passed / 4 failed with **all
four verified pre-existing** by re-running the same files on `9638a2023` and
getting an identical failure set.

**Explicitly NOT proven, in the agent's own words:** *"I3 deletes an intercept
from `kernel-worker.ts`, a shared cross-host file — browser behaviour is
genuinely part of its surface and nothing above proves it."* Correct application
of the host-runtime contract. **The group validation run MUST include browser
for K2.**

### Decisions on K2's deferrals

**D1 — `xtask dump-abi` does not record `env.host_*` import signatures.
DECIDED: fix it, as its own item (K14), BEFORE K9.** I2 changed a kernel↔host
pointer interpretation completely invisibly to the ABI check. The whole 84-import
host contract — the very thing V4 is measured on — is structurally unchecked
today, and K9 removes 25 imports and would land equally unchecked. Cost is
~50-100 lines plus one large additive snapshot diff, which is why it belongs on
its own rather than mixed into this group merge.

**D2 — TS `getProcessMemory(pid)` has no liveness check.** Native returns
`-ESRCH` for a non-dispatching target; the JS host silently writes to it. Invisible
for every legal call today, but it is both a safety gap and a Node/browser-vs-native
parity divergence. Tracked follow-up; needs a `currentHandlePid` callback.

**D3 — `catch { return -14 }` in `kernel.ts`** collapses "kernel not
initialized" and a consumed destination token into `EFAULT`. Truthful-failure
violation, small, tracked.

**D4 — dev shell lacks `wasm-tools`. DECIDED: add it to `flake.nix`.** A GC-array
`.wat` fixture in the repo **cannot be regenerated in a fresh worktree** because
WABT's `wat2wasm` predates the GC text format; the agent had to copy a prebuilt
artifact. The build environment is part of the platform contract, and a
checked-in fixture no declared tool can rebuild violates it. (Distinct from the
wasi-sdk refusal: `wasm-tools` is tiny, and existing fixtures already need it —
the K0 probes required a Homebrew install for the same reason.) Deferred to
integration only to avoid disturbing the running K10 agent.

**D5 — parallel worktrees CONTEND ON `~/.cache/kandelo`.** `./run.sh setup` hit
a race with a sibling agent (`vim@9.1.0900`, "concurrent cache winner differs
from staged build"). Unrelated to K2's change, but a real hazard of the
parallel-agent strategy and a likely source of confusing future failures.
Recorded; needs either a per-worktree cache or locking.

## 2h. K10 — PARTIAL (I1/I2/I3/I7 landed; I4/I5 deferred; I6 held) 2026-09-09

Worktree `.claude/worktrees/agent-a4b251627d1ef4068`, based on `899261824`,
tip `6e92f9f3d`, tree clean. 15 commits, +16,364 lines, 50 files.

- **I1 `crates/wasi-abi`** — 107 WASI constants as typed enums, the 79-entry
  errno table, the pure functions. POSIX constants imported from
  `wasm-posix-shared` rather than redeclared. `Errno` extended with the 17 Linux
  values, each verified against `libc/musl/arch/generic/bits/errno.h`.
- **I2 differential harness** — `cargo xtask dump-wasi-translation` plus
  `host/test/wasi-translation-equivalence.test.ts` over **1,358 exhaustively
  enumerated inputs**, TS vs Rust. The per-defect exceptions are implemented
  exactly as intended: four tables carry documented `divergence` blocks, and the
  test asserts agreement *outside* each defect's input list and **disagreement
  inside it** — so a regression to the old wrong behaviour fails rather than
  silently passes.
- **I3 `crates/wasi-module`** — 46 entry points, generic over memory and
  channel, built as a real PIC side module (24,528 bytes, `dylink.0` present).
- **I7 `crates/host-native`** runs a WASI guest under wasmtime from that same
  artifact. `guest.rs` untouched; `lib.rs` gained a 3-line path helper.
  **This is K10's actual V1 payoff: native WASI, which host-native never had.**

**No ABI motion, no new host import — verified on the COMPILED ARTIFACT**, not
merely the source: the module's entire import list is `env.memory` plus
`__indirect_function_table` / `__stack_pointer` / `__memory_base` /
`__table_base`, and the host-native test re-asserts it.

**Validation:** `wasi-abi` 30 · `wasi-module` 11+59 · `host-native --test
wasi_module` 1 · `wasm-posix-shared` 63 · real-module Node integration 12/12 ·
differential harness 13. Per the batching policy it did not run `verify-fresh`,
`check-abi-version.sh`, full Vitest, or conformance.

**Defect 4 was worse than the grounding recorded.** `translateStat` reads offset
80 with `getBigInt64`, so a non-zero `_pad` at 84 drives `ctim` **negative**
(−7.0e17 against a true 1700000002123456789). Three further honesty fixes
surfaced while porting: `init()` now reports a failed root open instead of
leaving the guest apparently filesystem-less; `random_get` fails `EIO` rather
than spinning forever on zero progress; an oversized result is `EOVERFLOW`
rather than a truncated byte count.

**DEFERRAL 1 — I4/I5 not landed. ACCEPTED.** The cutover needs `resolveBinary`,
a Vite `?url` alias, and `worker-main.ts` wiring — i.e. **new browser surface** —
and CLAUDE.md forbids calling browser-facing work complete from code reasoning
alone. Correct call: it respected both the batching policy and the browser
contract rather than trading one against the other. Land I4/I5 in a session that
can run `./run.sh browser` + Playwright. It also deliberately did **not** hook
`crates/wasi-module/build-wasm.sh` into `local_build.rs`, to avoid slowing every
sibling's build for an artifact nothing yet reads — do that as part of I4/I5.

**DEFERRAL 2 — the sixth, unchartered defect. DECIDED: fix it.**
`wasiClockToPosix` silently defaults an unknown clock id to `CLOCK_REALTIME`.
A guest asking for a clock we do not implement and silently receiving a
*different* one is a truthful-failure violation of the same kind as the other
five. Adopt the strict behaviour (`EINVAL` for an unknown clock) as the default,
keep the `_lenient` variant available for the TS-parity path, and add defect #6
to the divergence blocks so the harness pins it like the rest. Risk is nil —
there is no in-repo WASI consumer.

**NOT GREEN, and correctly not claimed:** the two new `.wat` fixtures assemble
and are committed but have never been *run* — they need `rootfs.vfs`, which was
still building. The three pre-existing WASI fixtures fail identically without it,
so this is provisioning rather than a defect, but the agent explicitly refused to
claim a pass it had not seen. **The group validation run must actually execute
them.**

## 2i. The TS-removal ledger — measured per step, not asserted (2026-09-09)

Prompted by the maintainer asking whether anything actually *checks* that
TypeScript is being removed. Nothing did. Now it is checked **per step**, with
`scripts/migration-ledger.sh --step <base> <tip>`.

A line count is a poor measure but a useful hint. It rewards deleting comments,
punishes adding tests, and cannot tell a real migration from code relocated
outside the measured scope. Treat it as a **watchdog on a promise** — exactly
the status of `EXPECTED_HOST_IMPORT_COUNT`, which has itself risen twice. The
campaign is still judged on §8's structural criteria; this catches drift
between them, and it catches a deferred deletion that is quietly becoming a
permanent addition.

### Procedure (binding from here on)

1. **Every implementation agent** runs `scripts/migration-ledger.sh --step
   <its base> <its tip>` and reports added / removed / net for in-scope TS and
   Rust in its final report.
2. **The coordinator re-runs it at merge** — the agent's number is a claim, the
   merge number is the fact — and appends a row to the running ledger below.
3. **The maintainer is told per step**: that step's additions, subtractions and
   net effect, plus the running aggregate.
4. **An item with a positive TS net must name the item that removes the
   difference**, and that owner item must already exist in this plan before the
   increasing item is called done. Deferred deletions are debt with an owner,
   never intentions.

### Running ledger

Scope: `host/src` + `web-libs/kandelo-session/src` (`.ts`, excluding `.d.ts`)
for TS; `crates/**/*.rs` for Rust. Baseline `c326c5e72`: TS **150,261**,
Rust **206,833**.

| step | TS added | TS removed | TS net | Rust net | note |
|---|---|---|---|---|---|
| K13a dead exports | 0 | 0 | **+0** | −374 | win is in Rust: dead exports and glue deleted |
| K2 cross-memory | 29 | 181 | **−152** | +572 | the only Tier-1 item with a real TS reduction (`handleIoctlIfconf`) |
| K1 KLZY | 526 | 36 | **+490** | +777 | dual-write writer; **deletion owed by K1 step 5** |
| K10 WASI | 24 | 0 | **+24** | +5,702 | Rust module added; **deletion owed by K10 I6** (`wasi-shim.ts`, 1,625) |
| **Tier 1 total** | **579** | **217** | **+362** | **+6,677** | aggregate: TS 150,623 · Rust 213,510 |
| K5 I1 `crates/dylink` | 0 | 0 | **+0** | +7,271 | pure planner, wired to nothing; 4,918 production + 2,353 test; **deletion owed by K5 I7** |

### Outstanding deletion debt

| owed by | removes | why deferred |
|---|---|---|
| **K1 step 5** | the JSON `entries[]` path (~2,000+ across `memory-fs.ts`/`sharedfs-vendor.ts` once the stamp goes) | needs its own ABI ruling (§2c item 3); **completes V3** |
| **K10 I6** | `host/src/wasi-shim.ts`, 1,625 | fixtures cannot exercise a real wasi-libc guest (§2h) |
| **K5 I7** | `host/src/dylink.ts` + `dylink-fork-archive.ts`, **6,340** | the Rust planner landed first; executors and native `dlopen` follow (§2p) |

All three deferrals were correct. None is done until the owner item lands.

## 2j. K5 grounding — outcomes and decisions (2026-09-09)

`docs/plans/2026-09-09-k5-dynamic-linker-grounding.md` (885 lines).

**It disproved a claim written in THIS plan set, not an inherited one.** The
census said the floor under `dylink.ts` was four JS-API acts. It is **eight act
kinds at 16 call sites** — the omissions were `new WebAssembly.Module`,
`new WebAssembly.Global` + `Global.value` get/set (every GOT cell; `intl.so`
alone forces **2,469** Global allocations, VERIFIED by `wasm-objdump`), and
import-object construction, which is a *stateful counting `Proxy`* whose `get`
order is engine-observable. **Fifth disproved floor; first one that was ours.**
The number had been asserted from a symbol overview instead of from the call
sites. Census and ledger corrected.

Verdict survives: all eight have wasmtime-48 equivalents (`Tag::new` already in
use at `guest.rs:5276`) and collapse into **one** typed `LinkAct` executor.

**A second ported-but-unwired Rust module.** `crates/fork-codec/src/dylink_archive.rs`
— 1,318 lines, decoder-complete, **zero callers** — exactly the shape `sffs.rs`
was in before K1. That is now a *pattern*, not an accident: work gets ported to
Rust and never wired, so the repo accumulates Rust that proves nothing. Worth
sweeping for more.

### Decisions

**D1 — re-scope ACCEPTED.** `patchWasmForThread`, `encodeStartupMetadata` and
`verifyProgramAbi` (~900 lines) are **not** dlopen work; they move to **K4**
(process lifecycle), where they belong. K5 shrinks accordingly.

**D2 — redis reclassified, ACCEPTED on evidence.** No Redis module `.so` is
built anywhere; its `dlopen` caller is upstream's own module API pulled in by
`-ldl`. PHP (`php`/`php-fpm` + 6 `.so`) is the only consumer currently
exercisable, and the browser regression gate is WordPress / LAMP / nginx-php,
all of which `dlopen` `opcache.so`.

> **GUARD (maintainer, 2026-09-09) — read this before implementing K5.**
> *"dlopen is supposed to be a generically useful feature, not purpose built for
> PHP's use."*
>
> "PHP is the only consumer" bounds the **validation surface**, not the
> **design**. It is a fact about today's package set, not a licence to scope the
> linker to what `opcache.so` happens to need. `dlopen`/`dlsym`/`dlclose`/
> `dlerror` are POSIX interfaces and must be generically correct — including for
> paths no in-repo artifact exercises. An earlier revision of this section said
> the reclassification "materially shrinks K5's blast radius", which invited
> exactly the PHP-shaped implementation the platform-values contract forbids
> ("a fix that only makes one program, demo, package script, or button work is
> suspect"). It shrinks what we can *regression-test*, and nothing else.
>
> **Two open adjudications are directly exposed to this drift:**
> - **D4 (GOT zero-write).** Decide it on ELF/`RTLD_LAZY` semantics, not on
>   which symbols PHP happens to leave unresolved. "No PHP extension hits this"
>   is not an answer.
> - **D5 (table-scan complexity).** `intl.so`'s 1,646 scans motivate the change;
>   they must not define the data structure. A generic loader has to behave for
>   a library with a different symbol profile.
>
> Where generic correctness cannot be validated today, say so as a documented
> boundary — do not narrow the implementation to match the test surface.

**D3 — shape DECIDED: a pure `crates/dylink` planner, not a co-resident
module.** It emits an **ordered** `Vec<LinkAct>` / `ImportBinding` — which is
exactly what both `Instance::new`'s positional slice and the counting Proxy
need — consumed by three thin executors (Node, browser, wasmtime). K10's
co-resident precedent does **not** transfer: WASI's acts are channel syscalls
wasm can perform unaided, whereas K5's are JS-API object constructions wasm
fundamentally cannot, so a co-resident dylink module would need **new imports**
— a V4 regression. The pure planner is also testable without a wasm host.
K10's mmap caveat does not apply here: VERIFIED that dlopen guests are
SDK-built and `allocateMemory` is a synchronous `SYS_MMAP`
(`worker-main.ts:1516-1560`).

**D4 — GOT zero-write: adjudicate, do NOT port blind. DECIDED.**
`refreshGlobalGotEntries` (`dylink.ts:1022`) writes `0` for an unresolved
`GOT.mem`/`GOT.func` symbol, which the guest later dereferences as NULL. That is
either correct `RTLD_LAZY` semantics or exactly the silent success the
platform-values contract forbids — and the comment at `:1605-1614` records that
the seeding case was already a real bug (`opcache.so` reading `sapi_module.name`
as NULL, `accel_find_sapi` failing at startup), so the zero path has bitten
before. Investigate during I1 and use **K10's defect shape**: implement the
correct behaviour, pin the old one in the differential harness as a documented
divergence. Three implementations of the same ambiguity is the outcome to avoid.

**D5 — the O(n)→O(1) table-scan change: measure, claim nothing. DECIDED.**
`intl.so` performs 1,646 linear scans of a ≥2,357-entry table today, on the PHP
boot path in three browser demos. The change is not optional — a Rust core has
no reason to reproduce the scan — but per `docs/agent-guidance/performance.md`
no "faster" claim may be made without before/after evidence on Node **and**
browser. Measure at I6's gate; until then, say nothing about speed. Watch for
the opposite risk too: `intl.so`'s 2,469 Global constructions could regress.

**Native `dlopen` ≈ 650-900 lines** over the pure core, no wasmtime wall, no ABI
bump, no new host capability — so the V1 prize (host-native gains `dlopen`,
which it has never had) is real and affordable.

### K5 I1 — LANDED (2026-09-09)

`crates/dylink`, 4,918 production lines plus 2,353 of tests (72 passing),
`no_std` on wasm and native, wired to nothing. `host/src/dylink.ts` still drives
every load on every host. TS net **+0**; the deletion is owed by I7 and recorded
in §2i.

**Shape as decided in D3.** `LinkAct` is the eight act kinds as data, with
`LinkAct::Instantiate` carrying `Vec<ImportBinding>` — exactly one entry per
import declaration, in declaration order, duplicates preserved and the
second-and-later occurrence flagged. `ImportPlan::bind` enforces the invariant
by construction (a declaration pushed out of position is an error) and
`ImportPlan::validate_against` re-checks a finished list against the module's
import section. One `PlanStep::Host` variant carries the work that is NOT a
JS-API act — `SYS_MMAP` allocation, mapping adoption, activation
prepare/register/unregister, and the table-mutation journal — so the executor
contract stays honest about what belongs to the engine and what belongs to the
process.

**`dylink_archive.rs` is WIRED, not duplicated.** `ReplayInputs::from_archive`
consumes `DylinkModule` and `PendingTransaction::from_archive` consumes
`DylinkTransaction`. The 1,318-line decoder has callers for the first time.

**D4 RESOLVED: strong + unresolved fails the load; weak + unresolved is zero.**
Decided on ELF, as required. Four points, in `crates/dylink/src/got.rs`'s module
docs: `RTLD_LAZY` defers only PLT relocations, never data ones; lazy binding
never produces NULL even for functions, because the PLT slot points at the
resolver, which raises `symbol lookup error`; a wasm `GOT.func` cell is not a
PLT slot but an address-take, i.e. a `GLOB_DAT` data relocation resolved eagerly
under every mode, and the wasm ABI has no PLT and no resolver stub, so wasm
dynamic linking is `RTLD_NOW` by construction; and the single ELF case in which
zero is correct is `STB_WEAK` + `SHN_UNDEF`. Per K10's defect shape,
`UnresolvedPolicy::LegacyZero` pins the old behaviour for I2's differential
harness to name what changed. No product path selects it.

> **Why the current loader could not make that distinction, and it is a
> one-line answer.** `dylink.ts` parses `WASM_DYLINK_FLAG_WEAK` into
> `metadata.weakImports` and then **never reads it**. The only three occurrences
> in the whole repository are the field declaration (`:131`), its initialization
> (`:293`) and its one `add` (`:337`). Having discarded strong-vs-weak, the
> loader had no choice but to apply weak semantics to everything. This is the
> same failure mode §2k names — a contract fact asserted without checking the
> artifact — one level down: a flag parsed without checking that anything
> consumes it.

**Two further defects fixed in the port**, both found by writing the fixtures
rather than by reading:

1. `dylink.0`'s import-info record encodes `(module, field, flags)`.
   `dylink.ts:334-340` reads the module into `_module` and discards it, keying
   the weak set on `field` alone — so `env.foo`, `GOT.mem.foo` and `GOT.func.foo`
   share one entry and a weak declaration on any of them marks all three weak.
   The port keys on the pair the section encodes.
2. An element-segment offset encoded as a negative `i32.const` was
   reinterpreted by wrapping. A table index is unsigned, so `-1` became
   4294967295. It is now rejected.

**D5 unchanged and unclaimed.** The function→table-index map is keyed on
`(instance, export name)` — the identity wasm itself assigns — populated from
the main image's element segments, each side module's published exports, and any
slot the loader appends. No scan and no identity comparison, because the planner
holds no engine objects. **No performance claim is made and none may be made
before I6's before/after measurement on Node and browser.**

**What I1 does NOT include**, so the next agent does not have to re-derive it:
the three executors, native `dlopen` (I4), the KFLA encoder (I3), the
differential harness (I2), the dlopen reader/writer lock's offsets (I5), and
`dlsym`/`dlclose`'s transitive unload walk, which needs the executor to null
table slots. `HandleTable` has the two counts and their lifetime rules; the walk
that consumes them is I6's.

## 2k. K14 + K9 grounding — outcomes and decisions (2026-09-09)

`docs/plans/2026-09-09-k14-k9-host-contract-grounding.md`.

### Four more disproved claims — three of them ours

1. **84 imports, not 85.** `host_debug_log` is supplied by `kernel.ts` but
   DCE'd out of the artifact (VERIFIED independently: `wasm-tools print
   local-binaries/kernel.wasm | grep host_debug_log` → 0, against 84 function
   imports plus `env.memory`). The ledger listed it as a KEEP floor; a floor
   absent from the artifact is not a floor. The §4 "diagnostics: 1" concept is
   already 0.
2. **`host_access` has zero kernel call sites.** Dead like K13a's 24 exports —
   fold its removal into K9.
3. **OPFS is not mounted.** `OpfsFileSystem.create` has no production caller
   (VERIFIED independently). Ledger §2.3 corrected.
4. **The host `/` mount is unconditionally dropped** post-Phase-5
   (`node-kernel-worker-entry.ts:1244`); every path hits `tmpfs::claims_path`
   then `rootfs::claims_path` first. Host filesystem reach is only the foreign
   prefixes: `/dev/shm`, `/dev` (shadowed), Node `--mount`. **The 25
   path-taking imports are far less load-bearing than the census implied.**

That is nine disproved "floors" across the campaign now, five of them authored
in this document set. The lesson is not that the docs are bad — it is that
*asserting a contract fact without checking the artifact* is the recurring
failure mode, and the artifact is always cheap to check.

### K14 — the design, and why it is bigger than a visibility fix

`dump_abi.rs:7226-7256` **already parses the import section** for index
arithmetic and then discards module, name and `TypeRef`. Keep them, render with
the existing `format_func_type` (`:7349`), emit a `kernel_imports` section beside
`:4296`. ≈150 lines, not the 50-100 K2 estimated.

The extra is a **new inverse classifier**, and it is the point:
**import polarity is the reverse of export polarity.** *Adding* an import is
BREAKING — an older host cannot satisfy it. *Removing* one is compatible. So
K14 does not merely make K9's 25 removals visible:

> **it makes any future host-import ADDITION fail the ABI gate.**

That converts this campaign's most-repeated STRONG DOUBT — "any need to ADD host
surface" — from a thing agents are asked to notice into a thing the build
enforces. Strongest V4 mechanism available, and it is ~150 lines.

**Trap to honour:** `"kernel_imports"` must be added to
`additive_top_level_section` (`:7455`), or K14 fails its own gate and tempts a
spurious ABI bump. Diff ≈350-430 additive JSON lines, no bump.

### K9 — protocol and corrected target

**No new import.** Mount-root handles ride the existing
`kernel_rootfs_set_foreign_prefixes` **export** (free under V4), and the
kernel's existing per-component walk (`syscalls.rs:2250`) steps
`host_openat(dir, component)`. Result: 25 → **9 `*at` imports**, 84 → 68, each
retiring a named predecessor. Precedent exists — tmpfs/rootfs already issue
synthetic negative handle bands.

**"25 → 0" was wrong in mechanism.** `mkdir`, `unlink`, `rename` and
`lstat`-of-symlink have no handle-only form on any host API. The honest target
is **0 mandatory + ~9 optional** (a host-directory capability; the browser
implements zero of them after K8). §4's "85 → ≈31" happened to survive because
two errors cancelled; the corrected figure is **84 → ≈30 mandatory**.

**Cheating criteria** are enumerated in the grounding's §6.3 — opcode collapse,
struct-pointer collapse, moving a capability to an export, and trapping-as-removal.
Any of those would shrink the count while worsening the contract.

### Decisions

- **K9 FOLLOWS K8** — ACCEPTED on evidence: before K8, the browser's only
  consumer of these paths is a data structure K8 deletes.
- **`host_access` and `host_debug_log`**: remove with K9; neither is reachable.
  Correct the §4 concept table when they go.
- **`cap-std` for host-native**: ACCEPTED in principle — `std` has no `openat`,
  and cap-std encodes the directory-relative invariant in the type system, which
  is a V2 win rather than merely a dependency. host-native is a host, not
  `runtime-core` (which deliberately keeps 3 deps); the bar is different.
- **host-native cost**: 8 of its 21 implemented imports are in the 25;
  ~500-700 lines.
- Two items still need detail before deciding: wasm64 recording in the snapshot,
  and the mount-handle payload shape.

## 2l. K4 grounding — outcomes and decisions (2026-09-09)

`docs/plans/2026-09-09-k4-worker-entry-unification-grounding.md` (1,023 lines).

### Corrections to this plan set

- **Duplicated volume is 6,718 lines (74% of each file), not 9,100.** The 9,100
  was the two files' combined size, not the duplicated algorithm.
- **K3 is NOT a prerequisite.** The coupling is **two lines** (`usePolling`,
  `relistenBatchSize`). The census asserted a dependency that does not exist;
  **K4 can go first, and is cheaper first.**
- The "54 duplicated functions" count was **conservative, not inflated**:
  `handleTerminate`/`handleTerminateProcess` are one function renamed, plus four
  more renamed twins, so the real figure is **≥55**.

### The duplication is real, and it is already costing

Of the 54 named pairs: **13 byte-identical**, 17 cosmetic-only, 8 a justified
host difference, and **16 substantively drifted** (22 named drifts in total).
Four are bug-shaped:

| drift | node | browser |
|---|---|---|
| **D1** | frees a thread's address-space slot with **no quiescence proof** | guards it |
| **D2** | reports a duplicate exit | silently drops it |
| **D10** | exactly-releases an exec-replacement lease | force-retires after a start attempt |
| **D17** | clears `vmInterruptTimers` on destroy | does not |

`memoryRetirementSafe` has **7 browser sites and 0 node sites** — the browser's
entire retirement-safety model has no node counterpart.

Maintenance evidence: **105 commits since 2026-06-01 touched an entry file, and
73 of them (70%) had to touch both.**

### `parseShebang` — a POSIX gap the duplication was hiding

Parsing agrees across all three (the Rust is a documented port). **Chain depth
does not:** Rust/`exec-target.ts` allow 1 level then `ENOEXEC`; both TS entries
allow 4 then return null → **`ENOENT`**. But `kernel-worker.ts:22427` discards
the preflight argv, so **observable depth is 1 everywhere** — the TS copies'
extra depth is dead code masking a real POSIX gap. Both copies are deletable
**today** via the existing `kernel_exec_target_shebang`: no host surface, no ABI.

### Architecture — my assumption was wrong

I assumed K4 meant "move it to Rust". The grounding argues otherwise and the
evidence is strong: **`crates/host-native` runs the same lifecycle with ZERO
generations, against 221/251 in the TS entries**, because its dispatch is
synchronous. Most of the duplicated TS is **Worker-ownership complexity, not
POSIX decision-making** — and Rust does not dissolve that. host-native also
cannot become the shared implementation: it does not compile for wasm32 and
shares nothing with `runtime-core`.

**DECIDED: stage it. K4a = one shared TypeScript module; K4b = Rust.**

**GUARD — K4a must not silently become the terminus.** It delivers **V1 only**
(one implementation, no more 70% double-touch rate) and buys **nothing for V2 or
V4**, while removing the pain that motivates K4b. That is exactly how a
migration stalls at "good enough". So K4b gets a **named gate, not a someday**:
the async/one-import probe in the grounding's defer list runs *before* K4a is
called done, and its result is recorded here. `fork-module` hides 5,362 lines
behind one import, but its opcodes are **synchronous** and this transaction is
not — so the probe is the thing that decides whether K4b is affordable at all.

### Decisions

- **K4 moves ahead of K3** in the sequence — no dependency, cheaper first.
- **The four bug-shaped drifts are adjudicated on POSIX, not normalized to
  whichever host we unify toward.** Each gets a documented verdict; unification
  must not silently pick a behaviour.
- **Delete both `parseShebang` copies now** via `kernel_exec_target_shebang`.
- **The observable-depth-1 shebang gap gets its own item** — it is a real POSIX
  gap, not K4 scope, and must not be quietly fixed or quietly kept.
- Still needing detail: whether the three incomplete kernel seams get their own
  K-number, and the browser conformance runners that are wired into nothing.

### K4b entry gate — the async/one-import probe RAN, and it PASSES (2026-09-09)

§2l made K4b's affordability a **named gate, not a someday**: the probe runs
before K4a is called done. It has now run. Both halves of NDD-2 are answered.

#### Result: the control inversion works

A 220-line `#![no_std]` Rust `cdylib` compiled to `wasm32-unknown-unknown` —
**2,017 bytes, `env.memory` as its only import, zero function imports, 8
exports** — drove a two-`await` `CREATE_WORKER → AWAIT_FENCE →
RELEASE_LEASE` transaction from a Node harness using real `worker_threads`
Workers and a real `memory_quiescent` message fence. The harness also
simulated the reentrancy gate by **refusing the first delivery of every step
result**, forcing the pump to retry on a later turn.

```
A/commit  : CREATE_WORKER -> AWAIT_FENCE -> RELEASE_LEASE_EXACT -> DONE
            RUST OUTCOME: COMMITTED   HOST LEASE: exact
B/rollback: CREATE_WORKER -> AWAIT_FENCE -> TERMINATE_WORKER -> RELEASE_LEASE_FORCED -> DONE
            RUST OUTCOME: ROLLED_BACK HOST LEASE: forced
PROBE RESULT: PASS
```

Rust chose the compensating steps; the host never decided sequence. Two
enablers made it work, and both are already how the TS hosts behave: driver
state lives in a `static` so nothing is borrowed across an await, and step-id
matching rejects a stale continuation (returning −1) — which is exactly what
host-side `generation` staleness checking does today.

**So asynchrony is not the blocker §4.2 feared.** The `fork-module`
precedent transfers further than the grounding was willing to claim.

#### The archaeology corrects the grounding, and clears K4b

§4.2's warning — *"this seam was already cut once and abandoned"* — rests on
a misreading, and re-testing it was worthwhile. `kernel_is_fork_child` /
`kernel_get_fork_exec_path` are **guest→host imports declared by musl's CRT**
(`libc/musl-overlay/src/env/__libc_start_main.c:112-179`), and
`worker-main.ts:495-506` is the *process worker's import table for the
guest*. It is not a host consumer of a kernel export, so **it is not the K4b
seam at all.**

Its death is also not evidence against K4b. `345f55de7` introduced it;
`90d5de3b2` moved the choreography out of the guest into the host;
`13fecc4d7`/`9ed1ac268` made the guest's `kernel` imports stubs once the
kernel moved to another worker; `7d6c71f3b` (#167) states it outright — the
actions were *"silently no-op'd by centralized mode's catch-all kernel import
stub"*; and `8939ca1c9` (#81) made the question obsolete when continuation
fork stopped re-running `_start`. **Killed by a worker-boundary refactor and
then superseded — never by asynchrony.**

Residual: the six getters plus `fork_child_exec()` are still called by
`__libc_start_main.c` and permanently stubbed to `0` on both hosts. Dead
ABI-declared guest imports; worth their own cleanup.

#### The honest V4 price

Measured, not asserted. `handleExec` (browser, 2768–3259) has **14 `await`
points and 3 rollback regions; all 14 classify as host-pumped** — none needs
Rust-side borrowed state, and none is unencodable, because the JS objects
(Worker, Memory, Module, lease) stay behind opaque `u32` handles.

A command list needs **≈12 host concepts**: compile-module, alloc-lease,
release-exact, release-forced, create-worker, start-worker, terminate-worker,
await-fence, post-to-main, release-framebuffer-generation, externref
generation replace/release, fork-host-imports create/close. **None is new** —
each exists today as an internal TS API. The real cost is that ~12 become
**ABI-frozen opcodes**.

Against that, what K4b actually deletes (VERIFIED at `4cc15a99b`, where
`generation` has grown to **319** browser / **271** node occurrences, up from
the grounding's 251/221):

| concept | verdict |
|---|---|
| generation-as-staleness-token (~33 of 93 identifier uses) | **DELETABLE** — kernel-owned step ids subsume it; the probe demonstrated it |
| `externrefGeneration` (37 uses) | **SURVIVES** — externref identity is the campaign's proven engine floor |
| exact-vs-forced lease retirement | **SURVIVES** as two opcodes; `process-memory.ts` (1,357 lines) is untouched — Rust cannot hold a `WebAssembly.Memory` |
| `memory_quiescent` fence | **SURVIVES intact** — published by the *process* worker (`worker-entry{,-browser}.ts`); the kernel worker only consumes it |

**So K4b deletes duplication and the staleness token — not the
Worker-ownership model.** §6.3's central finding survives the probe: the
fence requirement is intrinsic to the asynchronous Worker model, not to
TypeScript. On concept count K4b is roughly a **wash**; its win is V1 and V2.

#### Decision

- **K4b is affordable. The STRONG DOUBT is relaxed, not lifted.**
- **K4a-then-K4b staging still stands.** The probe does not make it
  unnecessary: it removes the fear that K4b is impossible, while K4a's
  "one algorithm to port instead of two that disagree" is unaffected.
- **K4b gets a second gate, and it is browser-shaped.** Unproven: the pump
  running inside `browser-kernel-worker-entry.ts`, and reentrancy under real
  concurrent syscall dispatch rather than a simulated refusal. Settling it
  means running the same two scenarios against a live kernel with a real
  `handleExec` in flight — about a day. **K4b must not start before that.**

### K4 drift adjudication — the four bug-shaped drifts (2026-09-09, VERIFIED)

The four drifts were adjudicated on POSIX and on measured host behaviour, not
normalized toward either host. **Three of the four collapse to a single proven
host boundary, and the grounding mis-attributed all three to the wrong host.**

#### The boundary that explains D1, D10 and D16: `terminate()` is a join on Node and is not in the browser

**VERIFIED by direct experiment** (scratchpad, Node 24, not committed): a
worker thread parked in `Atomics.wait` on a `SharedArrayBuffer` is *provably
stopped* once `await worker.terminate()` resolves.

```
terminate() resolved code= 1 ms= 1 exitEventAlreadySeen= true
post-terminate resume marker (999 => thread ran AFTER terminate resolved): 0
CONTROL resume marker (999 => notify does wake a parked thread): 999
```

The control is the load-bearing half: the same `Atomics.notify` that wakes a
live parked thread (999) fails to wake the terminated one (0). So on Node,
`await worker.terminate()` **is an ownership fence**.

In the browser it is not, and the adapter says so itself:
`host/src/worker-adapter-browser.ts:82-99` calls `this.worker.terminate()` —
which returns `void`, with no completion signal — and then *fabricates* the
`exit` event (`for (const h of this.handlers.get("exit") ?? []) h(0)`). There
is no observable proof of stop.

This one asymmetry generates three of the four "drifts":

| drift | verdict |
|---|---|
| **D1** — node frees a thread's address-space slot with no quiescence proof (`node…:3393-3404`), browser guards on `threadEntry.quiescent` (`browser…:3641-3654`) | **NOT a Node bug.** Node reclaims *after* `await terminateTrackedWorker(...)`, which the experiment proves is a join. Node's comment ("The Worker is stopped at this point") is accurate. The browser's guard is required because its terminate is not a fence. |
| **D10** — node exactly-releases an exec-replacement lease (`node…:2984-2990`), browser force-retires when `replacementStartAttempted` (`browser…:3204-3208`) | **NOT a Node bug.** Both rollbacks `await terminateTrackedWorker(replacementWorker)` first (`node…:2972`, `browser…:3191`), so on Node the replacement is provably stopped and exact release is correct. **Node's comment is wrong** — "A non-transferred `DeferredWorker` was never started" describes `preparedTransferred`, which is set at `:2852`, *after* `.start()`; a start can absolutely have happened. The comment must be corrected to name the real reason (termination is a join), because as written it will license an unsafe copy into the browser. |
| **D16** — `memoryRetirementSafe`: 7 browser sites, 0 node sites | **Not a missing Node model.** The browser's persistent `ProcessInfo.memoryRetirementSafe` records "this process has a thread we could not prove stopped" (`browser…:3653`). Node cannot enter that state, so it needs no flag and computes `oldMemoryRetirementSafe` transiently from the quiescence results (`node…:2730`). |

**Generic-first consequence for the unification.** Do not pick a host's
behaviour. Express the boundary **once**, as a declared host capability —
*does an awaited termination prove the worker stopped?* — and derive all three
behaviours from it. The browser's retirement-safety model then becomes the
**universal** model, and Node is simply the host where the predicate is always
true. That is strictly better than either copy: it removes the divergence
*and* it stops the safety model from being browser-specific trivia.

#### D2 — duplicate exit: equivalent today, but the browser's guarantee is structural

**The grounding's framing is incorrect.** Neither host reports an exit twice
and neither drops one. Both post the exit *eagerly*, immediately after
`processTeardowns.set(...)` and outside the teardown body
(`browser…:3916-3921`, `node…:3637-3643`).

- Node dedupes explicitly, via a `reportedExits` set (`node…:325`, `:554-558`).
  Its duplicate-entry call at `:3560` is therefore a **no-op**, not a second
  report.
- The browser dedupes **structurally**: its early `return` is lossless only
  because `processTeardowns.set` and `post({type:"exit"})` are adjacent with
  no `await` between them.

**Verdict: adopt Node's explicit `reportedExits` dedup as the unified
mechanism.** Observable behaviour is unchanged on both hosts; what changes is
that the once-only exit guarantee becomes *stated* instead of *emergent*.
Today, inserting a single `await` between those two browser statements
silently loses a process exit — and nothing tests it.

Node's other `reportProcessExit` site (`:702`, in the node-only
`finalizeProcessWorker`) is a genuine second entry point for a trailing
worker-main `exit`/`error` on a worker already tearing down; the browser
funnels the same events through `finishProcessExit`. Both are lossless, for
the two different reasons above.

#### D17 — the one real defect, and it is the browser's

**Real, but narrower than stated.** The grounding says the browser never
clears `vmInterruptTimers` on destroy. It does — `clearAll()` at
`browser…:4315`, matching `node…:3825`. The genuine divergence is **ordering**:
node's `retireCurrentGenerations` disarms each process's timer *before*
terminating its workers and releasing its lease (`node…:3763`); the browser's
loop (`browser…:4267-4291`) does not, leaving the timer armed across
`terminateTrackedWorker` → `releaseAfterForcedTermination()`.

That window is live. `VmInterruptTimerManager.fire()`
(`host/src/vm-interrupt-timer.ts:199-219`) guards only on generation identity,
which still matches until `detachExactProcessGeneration` unregisters — so a
timer that fires inside the window performs
`Atomics.store(flags, entry.timedOutPtr, 1)` into a backing the host has
**already handed back**.

**Verdict: adopt Node's ordering generically — disarm before releasing the
backing.** It costs nothing and it is correct on every host, including hosts
where termination is a join.

#### What this means for K4a

The four drifts do **not** need four independent bug fixes ahead of the
unification (NDD-3's provisional shape). Three are one boundary that the
unification must *express*, one is a comment that must be corrected before it
is copied, one is an explicit-versus-emergent guarantee, and exactly one
(D17) is a real ordering fix. That is a materially cheaper and more honest
entry gate than the grounding assumed.

### K4a — STARTED, two tranches landed (2026-09-09/10)

`host/src/process-lifecycle.ts` now exists as the single implementation both
kernel worker entries call, and two tranches have moved into it. This is the
seam §4.3 asked for; the bulk of the algorithm has not moved yet.

#### The census, re-measured at `4cc15a99b` (the grounding drifted)

The grounding's bucket counts are from an earlier tree. Re-running the
extraction at the actual base gives **55 common-named pairs**, and the split
is worse than the grounding recorded:

| bucket | grounding | measured at `4cc15a99b` | lines (browser side) |
|---|---|---|---|
| byte-identical | 13 | **13** | 130 |
| cosmetic-only | 17 | **3** | 35 |
| substantively differing | 16 | **39** | **3,430** |

So the "56% already equivalent" reassurance does not hold at this commit:
**71% of the pairs now differ**, and the differing ones carry 3,430 lines. The
duplication is not drifting slowly — it is drifting faster than the grounding
measured a day earlier. That strengthens the case for finishing K4a rather
than stopping at the seam.

#### What landed

- **Tranche 1** — the 13 byte-identical and 3 cosmetic-only functions, plus
  the two duplicated interfaces (`ProcessGenerationOwnership`,
  `VforkWorkspaceOwnership`): 15 functions, −156 lines from Node, −158 from
  the browser.
- **Tranche 2** — `detachExactProcessGeneration`,
  `reportRetainedProcessGeneration`, `handlePtyWrite`, `handlePtyResize`:
  −87 from Node, −89 from the browser.

#### The shape, and why it is the shape

`createProcessLifecycle(host)` takes an explicit `ProcessLifecycleHost`
record and is generic over each entry's `ProcessInfo`, constrained
structurally to only the fields the shared code reads. Two consequences worth
keeping:

1. **Every genuine host difference is now a named field**, readable in one
   place rather than inferred from two 4,000-line files. The list so far is
   short: `post`, `diagnosticPrefix`, `isVforkMechanismTraceEnabled`, and
   `terminationProvesQuiescence`.
2. **`terminationProvesQuiescence` is the drift adjudication made
   structural.** Node declares `true`, the browser `false`. Later tranches
   derive thread-slot reclaim, exec-rollback lease release and the
   `memoryRetirementSafe` model from that one field instead of carrying two
   hand-written variants — which is the generic-first form of the D1/D10/D16
   verdict below.

`kernel()` is deliberately *not* a host difference: `CentralizedKernelWorker`
is the same class on both hosts, so the record passes it whole rather than
sprouting a new narrow hook per tranche. It is a function because both
entries assign `kernelWorker` during `handleInit`.

#### Ledger: **+59 TS, and the owner is named**

| | added | removed | net |
|---|---|---|---|
| in-scope TS | 617 | 558 | **+59** |

Positive, and honestly so. `process-lifecycle.ts` is **456 lines, of which 279
are code and 139 are documentation** — a one-time fixed cost (the host record,
the shared types, the rationale for the boundary) paid once. Against it, 490
lines left the two entries and 60 left `worker-main.ts`.

The arithmetic flips with the next tranche and keeps flipping: a shared
function of N lines replaces 2N, so every tranche after the module exists is
pure subtraction. **The owner of the +59 is K4a's remaining tranches** — the
39 differing pairs holding 3,430 lines — which is an existing item in this
plan, not an intention.

#### Not yet done, and not to be forgotten

- The 39 differing pairs, including all of `handleInit`, `handleExec`,
  `handleVfork`, `handleClone`, `handleSpawn`, `handleOrdinaryFork`,
  `finishProcessExit`, `performDestroy`.
- **The test helper is a fourth lifecycle implementation.**
  `host/test/centralized-test-helper.ts` (1,521 lines) re-implements
  `onResolveSpawn`/`onSpawn`/`onFork`/`onExec`/`onClone`/`onExit`, and 85 of
  ~330 `host/test` files use it — so those suites prove kernel semantics, not
  entry semantics, and pass identically before and after unification.
  §7.1 is right that it must become a third caller of the shared module, or
  the unification leaves a copy behind.
- **`parseShebang` is NOT deletable as cheaply as §3.5 claims.** The existing
  `kernel_exec_target_shebang` export takes a *prepared exec target token*
  (`crates/kernel/src/wasm_api.rs:3111`), and the spawn preflight has no such
  token — it works on bytes read from the host FS, and its whole job is to
  answer "will this launch?" without the side effects that preparing a target
  would incur. Routing it through the kernel therefore needs either a
  prepare/cancel pair on the preflight path or a bytes-oriented parse export.
  Neither is "no host surface, no ABI, today". **See NDD-K4-1.**

#### NDD-K4-1 — `parseShebang` cannot be deleted on the terms the plan assumed

Not self-deferred. The plan says *"Delete both `parseShebang` copies now via
`kernel_exec_target_shebang`"*, on the grounding's §3.5 finding that this
costs **no host surface and no ABI motion**. That premise does not survive
contact with the export's signature.

- **What:** `kernel_exec_target_shebang(owner_pid, token, out_ptr, out_len)`
  decodes the `#!` line of a **retained, prepared exec target**
  (`crates/kernel/src/wasm_api.rs:3111`; host binding
  `host/src/kernel-worker.ts:8824`). The exec path has a token because
  `launchPreparedExecTarget` prepared one. The **spawn preflight has none.**
  `resolveExecutableForLaunch` runs on bytes read from the host FS, and
  exists precisely to be *side-effect-free*: `kernel-worker.ts:2250-2264`
  records that it is what keeps `posix_spawnp`'s PATH walk from applying
  `file_actions` on every doomed candidate, which POSIX requires to happen
  exactly once. Preparing a kernel target per candidate is the side effect the
  preflight exists to avoid.
- **Why it needs a decision:** closing it needs one of — (a) a
  prepare/cancel pair on the preflight path, which must be proven free of the
  `file_actions` side effect the preflight guards against; (b) a new
  bytes-oriented shebang export (no new `env.host_*` import, but a new kernel
  export, so ABI-adjacent); or (c) leaving the TS copies until the
  observable-depth-1 gap is fixed, since that item touches the same code and
  would otherwise be done twice. Each is a different cost, and (b) is exactly
  the kind of "small" export that should not be added without the maintainer
  seeing it.
- **Cost now:** (a) is an afternoon plus a careful argument about spawn side
  effects; (b) is small Rust plus an ABI-adjacent review; (c) is free.
- **Cost later:** the two TS copies stay, and they keep *masking* the real
  POSIX gap — they read files 4 levels deep and their answer is then discarded
  by `kernel-worker.ts:22427`, so observable depth is 1 on every host where
  Linux allows 4, and preflight exhaustion surfaces as **ENOENT for a file
  that plainly exists**.
- **Recommendation:** **(c)** — fold the deletion into the
  observable-depth-1 item rather than doing it twice, and do not let that item
  quietly close the discrepancy by deleting the copies without fixing the
  depth and the errno. The plan already says the depth gap "gets its own
  item"; this says the deletion belongs *with* it, not before it.

## 2m. K8 grounding — outcomes and decisions (2026-09-09)

`docs/plans/2026-09-09-k8-vfs-authority-grounding.md` (1,287 lines).

### Corrections

- **`memory-fs.ts` cannot be deleted, and mostly does not move.** Only ~556 of
  its 8,269 lines stop being a guest-visible mount. It remains the **image
  writer** and host fetch authority, including the **runtime**
  `export_rootfs_image` path on both hosts. `sharedfs-vendor.ts` survives
  essentially whole. **K8 removes ~1,500-2,500 lines, not the ~12,000 the census
  claimed** — Phase 5 already took `/`.
- **K8 does NOT depend on K7.** Workstream H5's "needs SAB-shared `mmap` first"
  is refuted: `shmSab` is a single-consumer byte store never shared with process
  workers (6 sites, all `kernel-worker`), and `tmpfs.rs` already has everything
  `sem_open` needs except a mount entry — including `link:1020` and stable
  `(st_dev, st_ino)`. Kernel-owned files already get writable `MAP_SHARED` via
  the fd-writeback bridge.
- **The ABI stamp has a live caller.** The prior grounding called
  `assertImageKernelAbi` callerless; it is not —
  `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts:1168` is the
  repo's only load-time image check **and it throws**. (I nearly re-confirmed
  the wrong answer myself by truncating a grep with `head -4`.) Removing the
  stamp costs that browser gate, the safety net for programs with no
  `__abi_version`, a regenerated `scripts/resolve-binary.bundle.mjs`, a docs-site
  page, and a warn-once beside the otherwise silent `ENOEXEC`. Not free.

### THIRD instance of ported-but-unwired Rust

**`klzy.rs` and `sffs.rs` have zero production callers** (VERIFIED
independently). K1 proved equivalence and landed the reader, but nothing calls
it — because I scoped K1 away from `syscalls.rs` to keep the parallel merge
clean, deferring the `ByteReq::Image` wiring. That was the right call for the
merge and the wrong outcome to leave standing: **K1's deliverable is not yet
load-bearing.** With `dylink_archive.rs` (1,318 lines) that is now three
decoder-complete Rust modules proving nothing.

**DECIDED: wiring `klzy`/`sffs` into production is K8's FIRST job**, not a
later step. Until then K1 counts as unfinished, and the ledger's TS debt for
K1 step 5 cannot be paid.

### The trap worth naming — generic-first, exactly

The fd-writeback bridge is **flush-only** (`kernel-worker.ts:29119` gates import
on `backingKey`), so a naive shmfs cutover **silently regresses** the
cross-process convergence `docs/posix-status.md:426` documents. And because **no
shipped package uses `shm_open`/`sem_open`, the whole suite stays green.**

That is the generic-first failure mode in its purest form: a real POSIX
regression that today's package set cannot detect. **DECIDED: close the import
side of the bridge inside K8, and write the `shm_open`/`sem_open` coverage that
does not exist** — the absence of a consumer is not evidence of correctness.

### Browser risk (per `docs/agent-guidance/browser-and-user.md`)

CA-cert reordering; `export_rootfs_image` going silently wrong; and
`network-demo-worker.ts` has **no overlay at all**. All three need real browser
validation, not code reasoning.

7 NEEDS-DEFER-DECISION and 7 STRONG DOUBT entries remain in the doc; none
self-deferred.

## 2n. K3 grounding — outcomes and decisions (2026-09-09)

`docs/plans/2026-09-09-k3-blocking-scheduler-grounding.md` (1,441 lines).
Completes Tier-2 grounding.

### The reframe that matters

`handleBlockingRetry` (746 lines, `:17734-18479`) is entered from **one** EAGAIN
site. But it is **one of SEVEN independent parking mechanisms** — select, epoll,
sleep, waitpid and advisory-lock each have their own. **That multiplicity, not
the line count, is the cost.** K3 is really "collapse seven parking mechanisms
into one", which is a better description of both the value and the risk.

Size corrected: **5,794–7,793 lines, not 4,532.** Containers: the census's 21
reproduce exactly, plus 5 more K3 touches (`alarmTimers`, `posixTimers`,
`deferredProcessWorkerStarts`, `hostReaped`, `activeChannelRequests`). Most are
keyed on `ChannelInfo` **object identity**, because exec reuses pid + mailbox
offset — a subtlety any Rust design must reproduce. Signals: ~1,797 lines, of
which **1,278 die with K3**.

### Zero new host imports — and three come OUT

VERIFIED independently: `host_futex_wait` **0** Rust call sites,
`host_sigsuspend_wait` **0**, `host_nanosleep` 2, `host_futex_wake` 5. The
ledger's "two wait primitives are the floor" was wrong; two of them are dead.
**84 → 81 imports.** Guest ABI unaffected (`channel_syscall.c:1872`).

### A live defect, not a migration item

`#hostNanosleep` (`kernel.ts:1875`) is a **synchronous** sleep executed on the
kernel worker — a single-threaded multiplexer that must never park. **A guest
`usleep` stalls the whole machine.** Reachable via `SYS_USLEEP`. This is a
present-tense bug, not something K3 introduces, and it deserves its own item
rather than waiting for the scheduler rewrite.

### Epoll mirror — smaller than feared, and hiding two POSIX gaps

It **already dispatches through the kernel** (commit `d94c4652b`); four comments
still assert the V8 claim K0c disproved. 12 of 14 touchpoints delete against
existing exports; only `resolveEpollReadinessIndices` needs new Rust, and after
the poll cutover it needs none. The real cost is the two gaps it conceals:
`fork.rs:1631` **discards child epolls** — already broken *today*, with the
mirror present — and interests carry **no OFD identity**. Both need owners.

### Decisions

- **K3 ∥ K7 can run in PARALLEL.** My census asserted they would collide in
  `kernel-worker.ts`; measured, there is **zero block overlap**, 5 dual-touch
  methods, ~45 lines, and the grounding supplies a freeze list (§10.1). Another
  dependency I invented.
- **Add a SHADOW-MODE increment** (grounding step 2) that `tmpfs.rs` did not
  need. The dormant-flag pattern assumes wrong behaviour is *visible*; here the
  failure mode is a **silent hang**, so the new path must run alongside the old
  and be compared before it takes over.
- **Order:** debt/dead-import cleanup → dormant wait queue → shadow mode →
  timers → advisory locks → transfer → poll/select → epoll → futex →
  process/signal wait → stopped parking → cancellation → delete scaffolding.
  The poll/select step also kills the 50 ms `SIGNAL_SAFE_POLL_WAKE_DELAY_MS`
  race hack.
- **Run the futex-as-floor probe** (STRONG DOUBT: the kernel may be able to own
  futex outright). If it can, that is the tenth disproved floor.

## 2o. Tier-1 group validation — results (2026-09-09)

Branch `integration/k-tier1-20260909`, 86 files, +19,704/−1,408. **Not pushed.**

| check | result |
|---|---|
| Rust workspace (host triple) | green |
| `cargo test -p host-native` | **52 passed, 0 failed** |
| K1 nine-image KLZY equivalence | **21 passed** |
| K10 suites (wasi-abi, wasi-module, 1,358-input differential) | green |
| ABI snapshot regenerate + verify | consistent, **no bump** |
| `verify-fresh` | exit 0 |
| Full Vitest | **60 files / 122 tests failed — none traced to the merge** |
| Browser (Chromium, targeted) | **8 passed, 2 skipped** |
| Browser (full suite) | running |

### Two false greens I caught, both worth remembering

1. **A pipeline laundered a failure into a pass.** The first Vitest run was
   `npx vitest run 2>&1 | tail -30`, so the reported exit status came from
   `tail`, not Vitest — it said `0` while Vitest had actually exited **1**.
   Re-run without the pipe: `VITEST_EXIT=1`. **Never take an exit code through
   a pipe**; capture it directly or use `PIPESTATUS`.
2. **A truncated grep nearly "refuted" a true claim.** Checking whether
   `assertImageKernelAbi` had callers, `head -4` cut the real hit and the output
   looked like tests-only. Same shape as the earlier `wasm_api.rs` exclusion
   that hid two live exports. **Truncation is not evidence of absence.**

### Vitest: every failure checked, not assumed

- **~40 files** in `packages/registry/**` and `tests/package-system/**` fail on
  missing program binaries (`php-fpm.wasm`, `intl.so`, `curl.so`,
  `spidermonkey-node.wasm`, `dinitctl.wasm`). **The merge touched neither
  directory.** Provisioning.
- `abi-version`, `wasm64`, `wasm-binary-parse` — same cause (`Package artifact
  closure is incomplete … (missing)`), plus timeouts waiting on absent binaries.
- **`kernel-reservation-export-contract`** — looked like a K13a regression
  (2 required exports "missing"). It reads only `packages/registry/kernel/build-kernel.sh`
  and `run.sh`, and **the merge changed neither**; both exports are present in
  source, artifact *and* snapshot. Its two guard lists disagree with each other:
  a **stale guard list**, pre-existing, and its own follow-up.
- **`kernel-export-failure-audit`** — the strongest regression candidate, since
  it audits `kernel-worker.ts`, from which K2 cut 173 lines. **Disproved by
  running the audit against the base file**: identical `#handleSpawn` finding,
  same catch, only the line number moved. Pre-existing.

**Honest caveat:** with 60 files unable to run, this suite currently proves much
less than its size suggests. That is its own gap, independent of this work.

### Browser gap worth naming

`SIOCGIFCONF` has **no browser coverage at all**. K2 deleted its host intercept
and serves it from the kernel; that is proven on Node (`ifhwaddr.test.ts`, 2
passed, wasm32 + wasm64) and, in the browser, only indirectly. The Chromium
`kernel-scratch-runtime` specs do exercise the widened `u64` path on **both
pointer widths**, which is the riskier half — but an ifconf browser test does
not exist and should.

## 2p. K5 — Rust COMPLETE, but see the 2026-09-10 correction below (2026-09-09)

> **CORRECTION (2026-09-10):** this section claimed K5 was COMPLETE. The Rust
> was complete *in the agent's worktree* and had **never been merged onto the
> branch** — only the docs commit was cherry-picked, so `crates/dylink` did not
> exist here at all. Found when the K5-I7 agent could not cut over to a missing
> crate. Merged the same day (`f622651b1`…`ababb6eee`). Recording an outcome is
> not landing it; verify the artifact, not the record. See
> `docs/plans/2026-09-10-rust-first-campaign-status.md`.

Worktree `.claude/worktrees/agent-aa0323de6a37d7c51`, base `210384516`, tip
`4d6edebc4`, 7 commits. No ABI bump, no new `env.host_*`, **no
NEEDS-DEFER-DECISION and no STRONG DOUBT**.

**`LinkAct` as data.** Eight engine act kinds (`Compile`, `NewGlobal`,
`ReadGlobal`, `WriteGlobal`, `GrowTable`, `WriteTable`, `GrowMemory`, `NewTag`,
`Instantiate`, plus `ReadExports`/`ZeroMemory`) answered by `ActResult` — and a
**separate `PlanStep::Host`** for what is not an engine act at all: `SYS_MMAP`
allocation, mapping adoption, activation prepare/register/unregister, and
table-mutation journalling. That split keeps the executor contract honest about
engine-versus-process ownership instead of blurring them into one list.

**The ordered-binding requirement is enforced, not assumed.** `Instantiate`
carries `Vec<ImportBinding>`, one per import *declaration* in section order,
duplicates preserved and second occurrences flagged. `ImportPlan::bind` rejects
an out-of-position push and `validate_against` re-checks the finished list
against the import section — which is what both `Instance::new`'s positional
slice and the engine-observable counting `Proxy` actually require.

**`dylink_archive.rs` is WIRED, not duplicated.** `ReplayInputs::from_archive`
and `PendingTransaction::from_archive` give its 1,318 decoder lines callers for
the first time. **That is one of the three ported-but-unwired Rust modules
closed** (`sffs.rs`/`klzy.rs` remain, owned by K8).

### D4 adjudicated on ELF semantics — and the root cause found

**Verdict: strong + unresolved FAILS the load; weak + unresolved is zero.**
Reasoning: `RTLD_LAZY` defers only PLT relocations, never data ones; lazy
binding never yields NULL even for functions, because the PLT slot points at the
resolver, which raises `symbol lookup error`; a wasm `GOT.func` cell is an
address-take — a `GLOB_DAT` data relocation resolved eagerly — and wasm has no
PLT or resolver stub, so it is `RTLD_NOW` **by construction**. The only
zero-correct case is `STB_WEAK` + `SHN_UNDEF`. `UnresolvedPolicy::LegacyZero`
pins the old behaviour for the differential harness.

**Why the loader could not tell them apart:** `dylink.ts` **parses
`WASM_DYLINK_FLAG_WEAK` and never reads it** — the only three occurrences in the
repo are its declaration, its initialization, and one `add`. The zero-write was
not a lazy-binding choice; it was the absence of the information needed to make
one. Exactly the kind of answer generic-first was meant to force: decided on ELF
semantics, not on which symbols PHP leaves unresolved.

Two further defects fixed en route: weak flags keyed by field name alone
(conflating `env` / `GOT.mem` / `GOT.func`), and a negative element-segment
offset that wrapped instead of being rejected.

**Validation:** `cargo test -p dylink` 72/72, `-p fork-codec` 444/444, `no_std`
wasm32 build, `cargo check --workspace`. **D5 measured nothing and therefore
claims nothing** about the O(n)→O(1) table scan.

**Ledger** `210384516..4d6edebc4`: in-scope TS **+0**, Rust **+7,271** (4,918
production, 2,353 test). Deleting `dylink.ts` + `dylink-fork-archive.ts`
(**6,340 lines**) is debt owed by **K5 I7** — recorded below.

## 2q. K11 — PARTIAL (piece 1's rules landed; pieces 2-4 blocked) 2026-09-09

**The line this item holds:** decoding and state are computation; issuing a
call to a canvas, a WebGL context, an audio device, or a socket is not.
Applied to each of the four pieces below, with the exact split named so the
next round does not re-derive it.

### Piece 1 — `networking/virtual-network.ts` (527) — rules LANDED

**Found: the third instance of the duplicated-authority pattern, and this one
was live and wrong**, unlike the epoll interest list (a mirror) and the TCP
listener round-robin (already delegated).

`LocalVirtualNetwork.listenTcp` / `.bindUdp` each walked their own endpoint
registry with their own wildcard-conflict predicate and returned their own
`EADDRINUSE`. But `syscalls::udp_bind_socket` calls `socket::udp_register`
**first** — that is where `EADDRINUSE` is decided — and notifies the host
only afterwards; when the host disagreed the kernel rolled its own
registration back and returned the host's answer to the caller. **The second
opinion won.** The rules disagreed on two generic POSIX cases:

- **`SO_REUSEADDR`** — `socket::udp_can_bind` permits a shared address when
  both sockets set the option; the host copy had no notion of it, so
  `SO_REUSEADDR` did not work on a virtual-network machine at all.
- **Fork-inherited bindings** — `socket.rs` keeps one logical binding alive
  while any `fork`/`spawn` peer still owns the socket; the host copy keyed by
  `pid:handle` and read an inherited copy as an unrelated conflict.

Neither is reached by the in-repo network demo, and **the host-side rule had
no test at all**. Removed rather than reconciled, per §1 generic-first: a
bind-conflict case no demo triggers is still a case. `socket.rs` gains a
module doc naming itself the single authority and telling adapters not to
re-derive it. Regression test added, and verified to fail (errno 98) against
the pre-change file.

**Line drawn:** deciding whether a bind may happen is kernel computation;
carrying bytes between paired peers, and knowing which machine owns which
virtual address, is the wire.

**Still duplicated, and blocked.** The fabric also *selects* the receiving
socket for a routed datagram (`addrMatches` + `.find`), which is
`socket::udp_lookup`'s rule. It cannot move this round: `NetworkIO.bindUdp`'s
`receive` callback is constructed per-`pid:handle` in `kernel-worker.ts`, so
the fabric picks the pid. Fixing it needs a **machine-level ingress callback**
— one per machine, kernel picks the socket — which is a `NetworkIO` shape
change in `kernel-worker.ts`. Two consequences to fix with it, both generic
and both currently real:

1. A fork-inherited UDP socket is never registered with the fabric, so the
   child receives nothing from the virtual network.
2. `onUdpUnbind` drops the whole fabric entry when one owner closes, although
   `socket.rs` keeps the binding live for the remaining owners.

**A fifth false-provenance comment, and what it was hiding.** Corrected in
`socket.rs` at the coordinator's request after a read-only audit. The
`host_net_handle` note called the field "a host-side network handle (returned
by `host_net_connect` / `host_net_accept`)". `host_net_accept` **does not
exist** — the host net imports are `connect`, `connect_status`, `listen`,
`poll`, `recv`, `send`, `close` — and `host_net_connect` returns
`Result<(), Errno>`, so it returns no handle. The kernel mints the value
itself: `let net_handle = sock_idx as i32` (`syscalls.rs:13829`, `:13835`).
It is a correlation token the kernel issues *to* the host, which the host
uses as its connection-map key.

**The consequence nobody had looked for**, because the comment said the host
owned the value: the token is a **per-process** table index, so it is stable
across fork — which is what makes the refcount correct — but it is **not
unique across processes**. Two processes on one machine with sockets at the
same `sock_idx` present the same token to a host connection map keyed with no
pid, on **both** hosts (`VirtualNetworkBackend.connections`,
`TcpBackend.connections`). Generic, and no demo reaches it. Not fixed here:
namespacing the token by pid spans `syscalls.rs` and both host backends.
**Owner: K11 second pass.** The field name wants renaming with it.

This is the same shape as the four the ledger already lists — a stated host
mechanism that turns out not to exist — and it is the second one authored
inside this repository rather than inherited.

**Unrelated finding, reported not fixed** (`syscalls.rs` is sibling-owned):
`is_virtual_network_addr` (`syscalls.rs:10945`) hardcodes `10.88/16` as *the*
virtual network prefix, so "is this a bindable address" is answered from a
demo-shaped constant. `netif.rs` already establishes the generic alternative —
ask the host via `host_network_local_address`. Generic-first says this should
not be a hardcoded prefix.

### Piece 2 — `framebuffer/browser-controls.ts` (732) — BLOCKED

**Line:** the Linux VT wire format is kernel semantics; reading a DOM
`KeyboardEvent` and owning a pointer lock is the device.

- *Computation, ≈300 lines:* `LINUX_KEYCODE_BY_DOM_CODE`,
  `LINUX_KEYCODE_BY_KEY_VALUE`, `linuxKeyCodeFromKeyboardEvent`,
  `encodeLinuxMediumRawKeyCode`, `encodeKeyboardEventAsLinuxMediumRaw`,
  `scalePointerLockMouseDelta`, `injectChunkedMouseMotion` (PS/2 ±127 delta
  chunking), `clamp`, `finiteTrunc`.
- *Device, ≈430 lines:* `attachLinuxMediumRawKeyboard`,
  `attachPointerLockMouse`, `createPcmAudioScheduler` — DOM listener
  lifecycle, pointer-lock requests, held-key bookkeeping keyed on event
  identity, AudioWorklet scheduling.

**Blocker: this module runs on the browser main thread**
(`apps/browser-demos/pages/kandelo/panes/Framebuffer.tsx:135`,
`TouchControls.tsx:41`). The main thread has no kernel instance *by contract*
— `CentralizedKernelWorker` must never be instantiated there — so there is no
Rust to call. Migrating the encoding means migrating the **input path**: the
main thread posts a raw key/mouse event to the kernel worker and the kernel
produces the MEDIUMRAW / PS-2 bytes. That is an input-path change with real
latency consequences, not a port.

**Scope note preserved:** `docs/future-improvements.md` separately questions
whether the Linux-VT MEDIUMRAW model and the three VT ioctls are the right
long-term contract. That is a different question and must not be folded in.

**Piece 2 partial win: PS/2 delta splitting moved into `mouse.rs`.** Not on
the original list, and found only by sweeping for already-ported Rust. A PS/2
packet carries at most `-128..=127` per axis; `mouse::inject_event` **clamped**
and dropped the excess, and `browser-controls.ts` compensated by looping over
`injectMouseEvent`. So the `/dev/input/mice` device model's packet-generation
rule lived outside the device model, in one host only — Node and host-native
still clamped, and the same injected motion produced different bytes per host.
Moved into `mouse.rs`, which already owns the packet layout, sign bits, queue
and drop-oldest policy. **No ABI change**: `kernel_inject_mouse_event` already
carried the full `i32`, so the host had been truncating information the ABI
could express and then working around it. Bounded at the queue's packet
capacity, since past that a packet evicts one the same call just queued.

**Test-suite finding while validating it.** `host/test/mouse-integration.test.ts`
is gated on `host/wasm/mousetest.wasm`, which **no standard build populates** —
`build-programs.sh` writes `local-binaries/programs/wasm32/mousetest.wasm`, and
only `scripts/pack-exact-abi-source-test-workspace.sh` maps it across. So the
one end-to-end test of `/dev/input/mice` is skipped in every normal run. Staged
by hand, it delivers the packets **exactly** right — guest stdout was
`ready / pkt 08 3 5 / pkt 38 -2 -7 / pkt 09 0 0`, byte-for-byte the assertion —
and then **hangs**: the process does not exit within 10s of reading its three
packets. Delivery is correct; the exit path is not. Pre-existing and unrelated
to the encoding, but invisible because the gate keeps the test off.

### Piece 3 — `webgl/bridge.ts` (700) — BLOCKED

**Line:** framing and payload validation are computation; every `gl.*` call is
the device.

- *Computation, ≈180 lines:* `walkCommandBuffer` (span safety, per-command
  header framing, the `p += len` walk), `isSafeSpan`, `exact`,
  `u32ArrayPayload`, `tailBytesPayload`, `countedFloatPayload`, `validPayload`
  (the per-opcode payload-shape table), `validateCommandBuffer`.
- *Device, ≈490 lines:* `dispatch` — the opcode→`WebGLRenderingContext` method
  switch and the GL object handle maps.

**The destination is not a new export.** The kernel already bounds-checks
`offset`/`length` against the cmdbuf binding at `syscalls.rs:1441-1450`,
immediately before `host.gl_submit`. Structural validation of the buffer
belongs on those same lines, reading the command bytes through
`HostIO::proc_read_bytes` (which K2 generalized). `validateCommandBuffer` then
deletes outright and `dispatch` keeps only the walk it needs to issue calls.

**Blocker:** `crates/runtime-core/src/syscalls.rs` is sibling-owned this
round. The edit there is roughly three lines, but it is the only seam.

### Piece 4 — `networking/tls-network-backend.ts` (871) — BLOCKED

**First, a correction to this plan's own description.** The item calls this a
"TLS state machine". **There is no TLS state machine in the file.** The
handshake is delegated to an injected `TlsMitmConnection` backed by WebCrypto.
What the file actually owns is an **HTTP/1.1 parser and a MITM proxy**.

**Line:** HTTP/1.1 message framing is computation; the TLS handshake,
WebCrypto, and `fetch()` are the device.

- *Computation, ≈220 lines (83-300):* `findHeaderEnd`, `parseContentLength`,
  `parseHttpRequest`, `indexOfCRLF`, `parseChunkedBody`, `concatChunks`,
  `requestKeepsConnectionAlive`, `lastHeaderValue`,
  `browserRepresentableHeaders`, `headersFromOccurrences`,
  `HOP_BY_HOP_HEADERS`, `formatHttpResponse`.
- *Device, ≈650 lines:* handshake driving, CA key/cert generation via
  WebCrypto, `BrowserCorsProxy` / `fetch`, the connection maps.

**Blocker:** a `NetworkIO` backend holds no kernel handle, same as piece 1.
And the honest end state is larger than a port: the kernel should own the HTTP
proxy and call the host only for `fetch()`.

### The handle-keyed registries in `kernel-worker.ts` — noted, not touched

`kernel-worker.ts` is owned by K3 and K7 this round, so this is a note for
whoever holds it next.

- **`kmsCanvases` / `kmsContexts` / `kmsStatsViews`** are three parallel
  `Map`s keyed by the same crtc identity, each holding a real host object
  (an `OffscreenCanvas`, a rendering context, an `Int32Array` over a
  `SharedArrayBuffer`). The objects are genuine KEEP under §2.4. The
  *three-map-one-key* shape is not: it is one record per attached CRTC, and
  three maps that can disagree about which CRTCs exist. Collapse them into a
  single `Map<crtcId, KmsAttachment>` so a partial attach or a missed detach
  cannot leave two of three populated. That is a host-side tidy, not a
  migration — the kernel already owns `kernel_kms_commit_count` and
  `kernel_kms_last_frame_us`.
- **The PTY output-callback and index maps** are the same shape: a callback
  is a host object, but *which pid owns which pty index* is state `pty.rs`
  already holds. The callback map should be keyed by the kernel's pty index
  alone, with the ownership question asked of the kernel rather than
  mirrored beside it.

Neither is large. Both are the same class of defect this item found in the
virtual network — host-side bookkeeping shadowing kernel-owned identity —
and both should be folded into whichever item next opens that file rather
than becoming a separate pass.

### The shared blocker, stated once

Three of the four pieces need the same thing and none of them can have it this
round. Host TypeScript reaches Rust by exactly one route — a `kernel_*` export
called through the kernel instance — and **all 308 of those live in
`crates/kernel/src/wasm_api.rs`**, which is sibling-owned, as are
`syscalls.rs` and `kernel-worker.ts`. New `env.host_*` imports were ruled out
by direction, and correctly.

Porting the four to Rust *without* wiring them was rejected: §2j names that
exact outcome as a **pattern** in this repo, not an accident
(`fork-codec/src/dylink_archive.rs`, 1,318 lines, zero callers), and it would
have produced a positive TS delta with nothing removed.

**Owner for the remainder: K11 second pass**, once `wasm_api.rs`,
`syscalls.rs` and `kernel-worker.ts` are free. Sequence it after K3/K7 land.

**Ledger** — see the running ledger in §2i.
## 2q. K3 — increments 0a/1/2 LANDED, 0b BLOCKED ON OWNERSHIP (2026-09-09)

Worktree `.claude/worktrees/agent-a80522f9a40f00a13`, base `4cc15a99b`, tip
`352945f3d`, 3 commits, cherry-picked onto the branch as `ae20af7b9`,
`736b18bee`, `201f5e1fb`. No ABI bump, no new `env.host_*`, no STRONG DOUBT.

**0a — the comments now say what the code does.** Four comments asserting the
V8 `epoll_pwait` crash as fact were rewritten to cite the K0c disproof and name
the K3 epoll cutover as owner of the mirror's deletion. `handleEpollPwait`
already dispatched `SYS_EPOLL_PWAIT` through `kernel_handle_channel` — the
comments contradicted their own adjacent code.

**A tenth disproved claim, and it was a doc promising an export that never
existed.** `pshared.rs` said `kernel_wake_blocked_retries()` wakes waiters
"rather than through pure timer polling". No such export has ever existed in
this repo; the module pushes no wakeup at all. **pshared blocking *is* pure
timer polling**, and the doc now states that as the gap it is. Verified
independently by the coordinator: the only surviving occurrence of that symbol
anywhere in the tree is the correction itself.

**1 — `wait_queue.rs`, dormant and wired to nothing.** `ChannelGeneration`
reproduces `ChannelInfo` object identity as a never-reused id;
`BlockingRetryTarget` sits on the sleeper rather than behind a token; a
monotonic deadline heap exposes `next_deadline_ns()` so the machine needs one
timer, not one per sleeper. `wake()` selects-then-removes, which makes the
host's `Map`-iterator livelock — the WordPress SMTP reset deadlock —
**structurally impossible** rather than merely fixed. 20 tests.

**2 — a shadow apparatus, and it has not shadowed the live machine.**
`wait_shadow.rs` compares old against new with an asymmetric comparator:
`WouldHang` (host woke on an identified source, kernel would not) blocks
cutover; `WouldWakeEarly` is safe. `unattributed_broad_wakes` counts tasks
resumed only by a sweep — each of those hangs the day the sweep dies — and
`is_cutover_clean()` refuses while the count is nonzero. 17 tests, six
differential against a model of the host containers.

**What it showed about the live machine: nothing, and the agent said so.**
Feeding it real traffic needs exports in `wasm_api.rs`, frozen this round.
Agreement on modelled scenarios is evidence the design reproduces the routing —
**not** the zero-divergence conformance/WordPress run §7.2 requires before
cutover.

### 0b — two dead host imports, blocked only by file ownership

`host_futex_wait` and `host_sigsuspend_wait` have **zero production callers**.
Coordinator re-verified the whole surface: `process.rs:148,225` are the `HostIO`
trait declarations, `process.rs:2495,2547` and `netif.rs:301,351` are
`#[cfg(test)]` mocks, `host_raw_syscalls.rs` mentions are prose, and
`kernel.ts:1898,2065` are the host-side implementations of methods nothing
calls. Removal is all-or-nothing — dropping the trait method without the impls
does not compile — and the remaining 9 sites live in `crates/kernel/src/wasm_api.rs`
(3) and `crates/runtime-core/src/syscalls.rs` (6), **both owned by K8 this round**.

**This is a genuine 84 → 82 host-import reduction, the first direct V4 win of
the campaign.** It is queued for the coordinator to apply the moment K8 lands;
it is minutes of work, not a design question. `EXPECTED_HOST_IMPORT_COUNT` at
`crates/host-native/src/lib.rs:89` moves with it.

### K3's NEEDS-DEFER-DECISION items — returned undecided, for the maintainer

1. **§11.1 futex-as-floor probe.** Whether the futex path is genuinely
   irreducible, or merely unmeasured.
2. **§11.2 `usePolling` deletion.**
3. **§11.3 two epoll POSIX gaps** — D2 interest-list inheritance across `fork`,
   D3 OFD keying of registrations. These are conformance gaps the migration
   uncovered, not migration work.
4. **0b's ownership conflict** (resolved by the coordinator above: queued, not
   deferred).

Unactioned by choice: freeze-list item 5 (moving `epollInterests` out of the K7
field block), judged unasked-for churn in a contested file. Correct call.

**Validation:** `cargo test -p runtime-core` 1825/1825; 10 scheduler Vitest
files, 212 passed. `select-signal-guest` skipped — guest binary unbuilt, not
run, and reported as such rather than counted.

**Ledger** `4874238a8..201f5e1fb`: in-scope TS **+24**, Rust **+2,088**.
The +24 TS is truthful comment expansion in `kernel-worker.ts`; its owner is
**K3-7.7**, which deletes the epoll mirror and those comments outright. Caveat
recorded by the agent and worth keeping: ~1,028 of the Rust is in-module
`#[cfg(test)]` that `scripts/migration-ledger.sh` counts as production, because
the script splits on file path, not on `cfg` attributes. The aggregate Rust
production figure is therefore an over-count of this shape wherever a crate puts
its tests inline.

## 2r. K8 — increment 1 LANDED, boot cutover NEEDS A DECISION (2026-09-09)

Worktree `.claude/worktrees/agent-a969418c429674637`, base `210384516`, tip
`c043994e0`, 6 commits, cherry-picked as `782c15566`…`7a6d9ebd0`. **The kernel
now parses a real VFS image in production code, and `klzy.rs`/`sffs.rs` have
callers** — closing the second and third of the three ported-but-unwired Rust
modules (K5 closed `dylink_archive.rs`).

`ByteReq::Image { offset }` joins the byte-request enum; all eight `match req`
sites route to a new `HostIO::image_read`. `rootfs::load_image` mounts the
image's SFFS through a cursor, walks it root-first and sorted exactly as
`emitRootfsManifest` does, and applies `KLZY` — **both lazy kinds, not only the
one shipped images happen to use.** That is generic-first applied without being
asked, and it is the right instinct.

**Proved by an oracle, not by reasoning.** `host/test/rootfs-image-tree-parity.test.ts`
runs a real kernel Wasm over the real `rootfs.vfs`, builds the base tree twice —
host-walked manifest versus kernel image parse — and asserts the two
`kernel_rootfs_export_tree` RXPT buffers are **byte-identical**: 375 entries,
including mode, uid, gid, size, ino, target and times. The cursor touches under
half the image's bytes.

**Three defects the oracle found that reasoning had not.** The shipped
`host/wasm/rootfs.vfs` **predates KLZY** (flags `0x5`); `load_image` now refuses
such an image with `EINVAL` instead of silently building a tree of size-0 files.
`sffs.rs` flattened `ENOSYS`/`EAGAIN`/`EIO` into "corrupt image", blaming the
image for a host failure. A truncated image returned `EINVAL` or `EIO` depending
on which byte ran out first.

### The STRONG DOUBT, adjudicated: the honest import was the right call

K8 added `env.host_image_read` and flagged it, because §2c item 2 had asserted
the typed variant "needs no import change". **§2c was wrong and K8 was right.**
That claim only holds if `ByteReq::Image` rides a reserved `blob_id` sentinel —
which is the same semantic overload §2c itself rejected, pushed one layer down
and made invisible in the kernel's own types. Taking the honest import and
documenting it as temporary is the choice this campaign's values require.

**And the net is now negative anyway.** K3's increment 0b removed two imports
the kernel never called, so the surface went 84 → 85 → **83**, measured on a
freshly built artifact. `host_blob_read` still leaves at cutover: 83 − 1 = 82.

**Snapshot drift, resolved correctly.** One export added,
`kernel_rootfs_load_image`; snapshot regenerated, no `ABI_VERSION` bump, per
`docs/abi-versioning.md:143` on additive exports. The reasoning is recorded there.

### NEEDS-DEFER-DECISION — for the maintainer, not self-decided

**Neither worker entry passes an image, so a real boot still uses the manifest.**
`load_image` is production code with a real oracle, but the two
`configureRootfsOverlay` call sites still hand over a host-walked tree.

*Why it is not a one-line flip:* `fromImage` copies, and the host then mutates
that copy three times — `normalizeLegacyRootfs`, `ensureMountParentDirectories`,
and the browser MITM CA write. Handing the kernel the raw image drops all three
**silently**, which is precisely the failure mode this project's values forbid.
Every shipped image also needs rebuilding for KLZY.

*Cost now:* three transfers into `rootfs.rs` and `rootfsWriteFile`, an image
rebuild, and real browser validation of the CA-write ordering change.
*Cost later:* `load_image` stays test-only in real boots — the V3 win is built
but not collected.
*Agent's recommendation:* increment 2 — move 4.2 into `rootfs.rs`, 4.3 via
`rootfsWriteFile`, delete 4.1, rebuild images, then flip both entries with
`./run.sh browser`.

**Coordinator note:** this is blocked on file ownership too — the worker entries
belong to K4 and `kernel-worker.ts` to K3/K7 this round — so it is queued behind
them regardless of the maintainer's call.

**Validation:** `cargo test -p runtime-core -p kandelo` 1810/0. Nine-image gate
21/21. Two pre-existing failures, both provisioning and neither built by the
agent: `rootfs-overlay-foreign-mounts` (`fork_module32.wasm` absent from that
checkout) and `abi-version`'s freshly-built-user-programs case.

**Ledger** `210384516..c043994e0`: in-scope TS **+157**, Rust +717. The removal
is owed: the cutover deletes `host/src/vfs/rootfs-manifest.ts` (354 lines —
`emitRootfsManifest`, `blobPaths`, `createRootfsBlobProvider`) plus the manifest
branch, taking the item well below zero. **Owner: K8 increment 2.**

### One real accident, and it is worth keeping in the record

The kernel build script writes into `host/wasm/`, which in that worktree was a
**symlink into `/Users/brandon/src/kandelo`**, so the agent's first build
overwrote a different checkout's `kandelo-kernel.wasm`. It then made `host/wasm`
and `local-binaries` worktree-local. `host/wasm/` is gitignored, so no source
was harmed and the artifact is rebuildable — but a worktree that silently shares
a build output directory with another checkout is a freshness hazard of exactly
the kind this campaign has been closing.

## 2s. K3 increment 0b — LANDED, and the host contract is 83 (2026-09-09)

Applied by the coordinator once K8 freed `wasm_api.rs` and `syscalls.rs`.
Commit `a8f31a44d`.

**Both imports were dead, and the check was exhaustive.** No Rust call site
anywhere invoked either `HostIO` method — verified by searching for the method
call form (`.host_futex_wait(` / `.host_sigsuspend_wait(`) across the tree, not
merely for the names. What remained were two trait declarations, twelve
`#[cfg(test)]` mocks in `syscalls.rs`, four more in `process.rs`/`netif.rs`, two
`extern` declarations plus their `WasmHostIO` bodies in `wasm_api.rs`, two prose
mentions, and 96 lines of live `SharedArrayBuffer` CAS and `Atomics.wait`
machinery in `host/src/kernel.ts` that nothing could reach.

**An eleventh disproved claim.** `host_raw_syscalls.rs` documented `sigsuspend`
and `pause` as blocking "through the distinct `host_sigsuspend_wait` signal-wait
park (see `sys_sigsuspend`)". `sys_sigsuspend` does no such thing: it registers
a signal-mask wait on the process and returns `EAGAIN` for blocked-retry to
drive — its `host` parameter is literally named `_host`. The text is corrected
in place rather than deleted, so the next reader learns the real mechanism
instead of inheriting the wrong model. **Same shape as K3's `pshared.rs` find
hours earlier: a doc describing host-import-based blocking that the kernel
actually does with blocked-retry. Two instances is a pattern; the remaining
blocking docs deserve the same audit.**

Deleting the pair stranded `signalWakeSab` and `registerSignalWakeSab` — the
field's only reader was the deleted implementation, and the setter had no
callers anywhere outside a stale `host/dist/` build output. Both removed.

**Measured, not asserted.** A freshly built kernel declares **83** `env.host_*`
imports, counted two independent ways from `wasm-objdump`, with both removed
names absent and `host_image_read` present. `host-native`'s pinned-surface test
passes against the real artifact (52/52).

**Ledger** `7a6d9ebd0..a8f31a44d`: in-scope TS **−101**, Rust **−96**.
**The first step in this campaign that is net-negative in both languages** — and
the first that shrinks the host contract outright rather than relocating work
behind it.

### Two build-machinery facts this step established

1. **`verify-fresh` works, proven in the wild.** The extension added earlier
   today caught the real thing: `./run.sh rebuild kernel` refreshed the
   source-only projection to key `b610508c…` but left ambient
   `local-binaries/kernel.wasm` at `d9828ad3…`, and `host-native` then failed
   loudly against an 84-import kernel that predated both K8 and this change.
   The gate named the stale artifact and the two keys. That is the "stale
   artifacts fail loudly" contract doing its job on a defect it was not
   written for.
2. **`cargo run -p xtask` builds xtask for wasm32 unless given a target.**
   `.cargo/config.toml` sets `[build] target = "wasm32-unknown-unknown"`
   workspace-wide, so the obvious invocation compiles xtask's own host-side
   dependencies (`ring`, `getrandom`, `zstd-sys`) for wasm32, where nix's
   `zerocallusedregs` hardening flag expands to
   `-fzero-call-used-regs=used-gpr` and clang rejects it. **The freshness gate
   cannot be run by the obvious command.** Correct form:
   `cargo run -p xtask --target aarch64-apple-darwin -- verify-fresh`.
   Recorded in `docs/future-improvements.md`.

## 2t. K9 — LANDED: the host contract is 75, and the file-name family is optional (2026-09-10)

**Measured, not asserted.** A freshly built kernel declares **75** `env.host_*`
imports, down from **83**. Eighteen names removed, ten added, one reshaped in
place, six kept and re-filed. Counted from `wasm-objdump` on the artifact
before and after.

### The grounding's arithmetic was wrong, in our favour and against it

§2k said "25 imports in → **9** out … net **84 → 68**". Both halves are off:

- The nine names are the *newly added* ones. The 25 also leave behind
  `host_utimensat` (reshaped, not removed) and six already-handle-shaped
  imports (`host_fstat`, `host_fstatfs`, `host_fpathconf`, `host_fchmod`,
  `host_fchown`, `host_readdir`). So the family is 16, not 9, and the net is
  −9, not −16. "84 → 68" conflated "9 new names" with "9 total".
- The baseline was 83 by the time K9 started (K3 increment 0b had removed two).

Corrected and measured: **83 − 18 + 10 = 75.**

### A tenth `*at` was added deliberately, correcting the grounding

§2.2 gave `chown` an `fchownat` (because `lchown` forces one) but gave `chmod`
an "open, then `fchmod`". That asymmetry had no stated reason, and open-then-
`fchmod` is not equivalent to `chmod`: `open(O_RDONLY)` fails `EACCES` on a
file the caller owns but cannot read — which `chmod(2)` must still permit — and
blocks indefinitely on a FIFO with no writer. `host_fchmodat` costs one import
and preserves both. **Generic-first: a path no shipped package exercises is
still a path.**

### A gap in the protocol as specified

§3.1 established that host filesystem reach is only ever a *foreign mount*
beneath an overlay-owned `/`. True of `VirtualPlatformIO` — but not of
`NodePlatformIO`, which serves `/` itself when no rootfs image is supplied.
With no foreign mount there would have been no anchor, and every path would
have answered `ENOSYS`: a whole host mode silently broken. An anchor for `/` is
therefore part of the protocol.

### Where the mount roots ride (NEEDS-DEFER-DECISION #6, decided)

Not on `kernel_rootfs_set_foreign_prefixes`. Two reasons, one of them a hard
constraint:

1. **Position is unsound.** `VirtualPlatformIO` sorts its mounts by prefix
   length (`vfs.ts`), so the host's mount table and the prefix list published
   by `kernel-worker.ts` are provably *not* the same ordering. Any parallel-
   array or index-band scheme would bind two orderings that differ. Records
   carry their prefix instead.
2. **The one-seam route required editing `host/src/kernel-worker.ts`**, which
   K7 owns this round. §7 #6 explicitly declined to decide and argued only from
   seam count; a cross-agent conflict in the campaign's largest file outweighs
   that. A *new* export also has a new signature, so the ABI gate sees it —
   which is what §7 #6 worried a payload reinterpretation would not.

The anchor registry is independent of the foreign-prefix registry: they answer
different questions, and coupling them imposed a publication order for no gain.

### What actually changed, stated honestly

The count understates it. The file-name family went from **mandatory for every
host** to an **optional capability** — "expose a real host directory" —
reachable only under a mount whose root handle the host published. A browser
host implements zero of the eleven after K8. What a host used to have to
implement was: *reimplement a POSIX filesystem namespace in your own language,
including symlink resolution, `..`, mount routing, and permission semantics,
and keep it consistent with the kernel's.* That was the largest single concept
in the contract.

**It cannot be zero imports.** `mkdir`, `unlink`, `rename`, `link`, `symlink`
name an entry that does not exist yet or is about to stop existing; `lstat`,
`lchown`, and a `NOFOLLOW` `utimensat` name an entry the host must not open.
POSIX concedes the same point — the `*at` family exists because the final
component is irreducible. The honest framing is **no name resolution**, not
"no names".

### Cost this introduces, stated rather than hidden

Resolving a foreign path now walks its components with `host_openat`, opening
and closing intermediate directory handles. The host was already re-walking the
whole path on every call (longest-prefix routing, then a backend that re-splits
the string), so the work is not new — but it is now several host calls where it
was one, and that has **not been benchmarked**. It is unreachable in the
browser (no host-backed mount) and reachable on Node only under `--mount`.

### Two latent handle collisions this exposed

Both pre-existing, both made live by one `host_close` serving directories too:
`VirtualPlatformIO` numbered files from 100 and directories from 1, and
`NodePlatformIO` returns real OS descriptors as file handles while numbering
directories from 1 — so a directory handle could already be confused with
*stdout*.
## 2t. K12 — the twelfth disproved claim, and this one was mine, today (2026-09-09)

Worktree `.claude/worktrees/agent-a4b7423970fe02e78`, base `4874238a8`, tip
`4abb59d3b`, cherry-picked as `a6a22ffbe`, `fad8c3a15`, `16eb3a463`.

**I briefed this item asserting that the K0 probes had unlocked the elimination
of `ForkGcProvenanceRegistry`. That assertion was wrong, and the agent
disproved it rather than implementing it.** The brief even warned the agent not
to inherit the three claims it named; it did not warn the agent about the one I
had just added.

### Why the elimination is impossible, structurally

An **immutable** GC array of **runtime-determined length** with **non-uniform
contents** has no reconstruction path in the WebAssembly GC instruction set
except `array.new_data` / `array.new_elem` reading a **static** segment:

- `array.new_fixed` takes its element count as an **immediate** — it cannot
  accept a length discovered at replay time.
- `array.new` and `array.new_default` write **one** value to every slot.
- `array.set`, `array.copy`, `array.fill`, `array.init_data` and
  `array.init_elem` all require a **mutable** destination.
- Data and element segments cannot be synthesized at runtime.

So the value cannot be rebuilt generically from its type. Provenance is not a
substitute for type recovery — **it never was type recovery.** It records the
**constructor shape** and the **allocation seeds**, which is the one thing
casting cannot recover.

**The shipped code already encodes exactly this distinction**, and I verified it
independently of the agent: `crates/fork-codec/src/gc_codec.rs:81-86` defines
`LAYOUT_FLAG_REQUIRES_PROVENANCE` alongside `LAYOUT_FLAG_DEFAULTABLE_SHELL` —
one bit for layouts that can be raised as a default shell and then mutated,
another for layouts that cannot and must carry recorded provenance. The design
had the right answer before I claimed otherwise.

### The probes argue *for* the registry, not against it

- The `ref.test` cascade P1 demonstrates **is already implemented and already
  orders most-derived-first**. P1 confirmed shipped behaviour; it unlocked no
  deletion.
- **Canonicalization — P1's own headline result — is what makes cross-activation
  ownership unanswerable by casting** (`fork-activation-registry.ts:1245-1247`).
  Structurally identical types collapsing to one type is precisely why "which
  activation minted this" cannot be recovered from the value.
- **P2c is the reason mint-time externref provenance exists.** A host externref
  is not `ref.eq`-comparable once internalized, so identity must be recorded
  when it is minted.

**Agent's own re-verification:** all 15 probe rows reproduced on Node v24.15.0,
Chromium **149.0.7827.55** (older than the recorded 151 — still agreeing) and
WebKit 26.5, `P2c.host_externref_is_eq = 0` on all three. The probes are sound.
**The inference I drew from them was not.**

### (b) blocked by ownership, correctly

The segmented externref-handle scan runs in the **kernel worker**, which only
*compiles* the fork module (`browser-kernel-worker-entry.ts:1392`) and never
instantiates it — so no `fm_*` entry point is callable there at all. Its Rust
home is a kernel export in `wasm_api.rs`, and its consumers are the two
`*-kernel-worker-entry.ts` files: all three sibling-owned this round. Untouched,
and the reason is a real architectural fact rather than a scheduling excuse.

### (c) `fm_*` folded 72 → 70, and the agent declined to go further — correctly

`fm_decoded_node_{kind,module_activation,ordinal}` → `fm_decoded_node_field(index, field)`:
one concept, three identical `(usize) -> i32` signatures, so **no type safety is
lost** (the `fm_stats` precedent). The agent then **refused to fold the other
~40** and cited this plan against my own brief: the tracked item says "drive the
count well below 71", but §1 says the count is never the target and warns
against collapsing the contract behind one opaque call. Folding
`fm_capture_intern_*`, whose operands are variously `(activation, ordinal)`,
`(handle)` and `(value)`, would trade **V2 type checking** for a cosmetic
number. **That is the §6.3 cheating criterion applied to an instruction I
wrote.** Recommendation adopted: fold only where operand types already coincide.

### NEEDS-DEFER-DECISION — two, for the maintainer

1. **The struct seed path may still be removable.** Struct fields are mutable,
   so fill already rewrites them; a fabricated typed placeholder could replace
   the recorded operand. *Cost now:* four implementations, fixture regeneration,
   and an ABI-tracked `gc_codec.layout_record` change. *Cost later:* none — it
   is independent. *Agent's recommendation:* defer; it is a semantics change,
   not a re-derivation. **This is the live remainder of the GC question — the
   array path is closed, the struct path is not.**
2. **The remaining ~40 `fm_*` exports.** See above.

### Side finding — a declared validation command did not compile

`cargo test -p host-native` — named in this plan as a gate — **failed to build
from a clean checkout.** Three `include_bytes!` fixtures were missing, and
`.gitignore`'s `*.wasm` kept them out while their generators live in the very
crate that will not build without them. Built through the normal path and
committed (`a6a22ffbe`); they back `smoke_fork_gc_array_reconstructs` and both
externref smokes. **A gate that cannot run is not a gate** — the same lesson as
the two skipping test gates found on 2026-09-09.

**Validation:** `cargo test -p fork-codec -p fork-module-inject -p host-native`
— 444 / 2 / 52, zero failures. Vitest `host/test/fork` 285 passed; 4 files fail
on absent `programs/*.wasm` and sysroot, which is fresh-worktree provisioning
and fails before any fork code runs. **Browser not run, and the agent said so
plainly** — the folded export is a pure readout accessor with no host-parity
surface, but that is an argument, not evidence.

**Ledger** `4874238a8..4abb59d3b`: in-scope TS **+22**, Rust +4. The agent named
the owner of the difference without being asked: the removal was to come from
(a), and (a) is closed. The safe fold in (c) nets positive because a documented
enum plus one shared body outweigh three deleted call bodies. **That is the
correct trade and the ledger should show it as one.**

## 2u. The phantom-mechanism audit — five instances, and it is a pattern (2026-09-10)

Two doc comments describing blocking mechanisms the kernel does not use were
found **by accident** on 2026-09-09, hours apart, in unrelated work. Two
instances of one shape is a pattern, so the tree was swept deliberately. Three
more turned up.

**The shape:** a comment names a **host** authority — an import, an export, a
"park" — that either does not exist or is never called, on a **blocking** path,
where the **kernel** in fact owns the decision. The danger is not the wrong
sentence. It is that someone modifying the code inherits a wrong model of who
decides, and the wrong model always points the same way: *toward* the host.
That is the exact direction this campaign is trying to travel away from.

| # | Where | Claimed | Actual |
|---|---|---|---|
| 1 | `runtime-core/src/pshared.rs` *(fixed)* | kernel calls `kernel_wake_blocked_retries()` "rather than pure timer polling" | **No such export has ever existed.** pshared blocking *is* pure timer polling |
| 2 | `shared/src/host_raw_syscalls.rs` *(fixed)* | `sigsuspend`/`pause` park via `host_sigsuspend_wait` | `sys_sigsuspend` registers a signal-mask wait and returns `EAGAIN`; its host parameter is named `_host` |
| 3 | `kernel/src/wasm_api.rs:3382` | NULL mq timeout checked "via `host_is_mq_nonblock`" | **No such import exists** — one grep hit in the whole tree, the comment itself. `nonblock` is computed in-kernel from the mqueue table (`wasm_api.rs:6057`, `6065`, `6111`) |
| 4 | `runtime-core/src/socket.rs:10-11` | `host_net_handle` is a host handle "returned by `host_net_connect`/`host_net_accept`" | **`host_net_accept` does not exist**, and `host_net_connect` returns `Result<(), Errno>` — no handle. The stored value is the kernel's own socket index (`syscalls.rs:13833`, `13839`) |
| 5 | `kernel/src/wasm_api.rs:6247` | "See `crates/kernel/src/pshared.rs`" | That file does not exist; the module is `runtime-core/src/pshared.rs` — so the pointer also hides #1's GAP note |

#3 and #4 are the harmful ones, and both are the pure pattern: an invented host
authority over a decision the kernel already owns. #4 is worse than a wrong
name — the field's entire refcount rationale rests on the false provenance,
reading as "this is the host's handle, mind its lifetime" when the kernel minted
the integer itself.

**Routed to their owners** rather than fixed centrally: #3 and #5 to K9 (which
owns `wasm_api.rs` this round and is auditing exactly this axis), #4 to K11
(which owns `socket.rs` and is about to move the virtual-network registry into
it). Both instructed to correct in place, not delete — the next reader should
learn the real mechanism, not merely lose the wrong one.

### What the audit verified as TRUE — which is the other half of its value

- `wakeup.rs:1-6` drain-after-syscall and targeted/broad-retry routing:
  `kernel_drain_wakeup_events` is a real export (`wasm_api.rs:14108`), called
  from ~15 sites, and all five wake types are consumed
  (`kernel-worker.ts:16139-16194`).
- `wait_queue.rs` "Status: DORMANT" and `wait_shadow.rs` "host-side wiring not
  in this commit" — **true**, and independently confirmed: one internal
  reference, zero TS references. K3 described its own work accurately.
- `wait_shadow.rs:29`'s "three safety timers (10 ms, 50 ms, 500 ms)" — all
  three literals present.
- `shared/lib.rs:83` "no longer require the `host_fcntl_lock` import" — a
  correct **negative** claim, the hardest kind to keep true.
- `host-native/src/lib.rs` `EXPECTED_HOST_IMPORT_COUNT = 83` — matches the built
  binary exactly.

### Imprecise but not wrong

`wait_queue.rs:32` cites `kernel-worker.ts:3086-3090` for `ChannelInfo`-identity
keying; the claim holds at line **3091**, stale line numbers only.
`wait_queue.rs` says "seven independent parking mechanisms" at line 7 and "eight
containers" at line 59 — internally inconsistent, worth reconciling when K3
resumes.

### The residue pattern, named

`wasm_api.rs` declares **84** `host_*` imports in its `extern` block; the linked
kernel has **83**. `host_debug_log` is declared there with no caller in that
crate — its only call site is `runtime-core/src/lib.rs:79`, which declares its
own — so the linker drops it. Not a doc bug, but **this is exactly the residue
that let `host_futex_wait` survive for months as a documented floor**: a
declaration with no caller looks like a live contract to every reader and to
every grep that searches for names rather than call forms. Any future import
census must count the **linked** surface, not the declared one.

## 2v. K7 — shared-mapping page cache in Rust, dormant and honestly labelled (2026-09-10)

Worktree `.claude/worktrees/agent-a9ab0d6e628098e62`, base `4cc15a99b`, tip
`ea7c4791a`, 7 commits, cherry-picked as `4aa70002f`…`88877f586`. No ABI bump,
no new `env.host_*`.

**Eleven TypeScript containers collapse into one `SharedMappingTable`** in
`crates/runtime-core/src/memory.rs` (~2,100 production Rust, ~920 test).
`FileBacking` carries pages, the dirty set, a version, dev/ino revalidation,
EOF-clamped writeback and dirty-preserving invalidation. The publish/refresh
protocol keeps **both** phases whole-set — an alias advancing the backing
mid-boundary, and all-or-nothing refresh. Also moved: the fd-writeback bridge
with its **truthful refusal** on a closed or `dup2`-repointed guest-visible dup,
munmap head/tail/middle split with backing and dup refcounting, mremap re-seed,
mprotect upgrade validation, transactional fork inheritance with rollback, the
SysV byte-coherence mirror, and teardown that continues past a failed backing.

`SharedMappingIo` is the seam. **Five of its operations cross to the host, all
through existing imports** — `host_proc_read_bytes`, `host_proc_write_bytes`,
`host_pread`, `host_pwrite`, `host_fstat`. Nothing new was asked of the host.

### Blocked on the export surface, and it names the right reason

The subsystem is **host-driven**, so cutover needs host-callable `kernel_*`
entry points. `crates/kernel/src/wasm_api.rs` is the **only** export surface in
the repo — 309 exports, zero elsewhere — and the in-kernel alternative is
`syscalls.rs`. Both were sibling-owned. The agent did not touch them.

**Coordinator correction to the agent's report:** it named K8 as the owner.
K8 has since landed; **`wasm_api.rs` and `syscalls.rs` now belong to K9**, so
the K7 cutover queues behind K9 rather than K8. The blocker is unchanged in
substance.

**It did the one thing that keeps this from becoming a fourth unwired module:**
the cutover contract — import map, TS→Rust method map, and perf position — is
documented **on `SharedMappingTable` itself**, beside the code. The campaign has
already found three ported-but-unwired Rust modules (`sffs.rs`, `klzy.rs`,
`dylink_archive.rs`), all now closed. A fourth would have been a pattern.

### STRONG DOUBT — the boundary read cost, unresolved and correctly flagged

TypeScript diffs a **zero-copy view** of guest memory. Rust must **copy**. The
agent bounded the cost by design — one `host_proc_read_bytes` per mapping per
boundary rather than per page, plus an early-out in `synchronize_for_boundary`
when a process owns no shared state — and then said plainly that **a design
choice to bound a cost is not evidence the cost is bounded.** A process holding
a large writable `MAP_SHARED` with a peer could pay a full-range copy at every
boundary.

**Performance was not measured on either host, and the agent said so.** Per
`docs/agent-guidance/performance.md` this cannot be called neutral. It is a
second, independent reason the cutover could not land here: the perf contract
requires Node **and** browser before/after evidence.

### NEEDS-DEFER-DECISION — the K7 cutover, for the maintainer

*What:* wiring the Rust table into production.
*Why blocked:* both possible sites are sibling-owned (now K9).
*Cost now:* editing them risks a `wasm_api.rs`/`syscalls.rs` merge conflict and
two authorities over VFS-adjacent state.
*Cost later:* Rust and TS drift; K7's V1/V2 value stays unbanked.
*Recommendation:* sequence after K9 as its own item, gated on the Node+browser
benchmark evidence.

**Validation:** `cargo test -p runtime-core --lib` — 1823/1 in the worktree,
**1869/1 after merge** (36 new shared-mapping tests). The single failure is
`zip::real_man_zip_cross_checks_members`, and the agent did the right check:
reproduced it **with base `memory.rs` restored** in its own tree (1421680 vs
1397299), which tests its own change rather than merely reproducing on base.
`cargo check` clean on wasm32, wasm64 (`-Z build-std`) and native. Seven mmap
Vitest files: 95 passed, 1 skipped — after provisioning both sysroots,
`local-binaries/kernel.wasm`, and `fork_module{32,64}.wasm`.

**Merge conflict, resolved in K3's favour.** K7 branched from `4cc15a99b`, before
K3 corrected the `epollInterests` comment, so its move of that field carried the
**disproved** V8-crash text back with it. Resolution takes K7's move and K3's
corrected comment. Worth recording as a parallel-work hazard: a field *move* by
one agent silently reverts a *comment fix* by another, and git reports it as a
routine conflict.

**Ledger** `2bbd64ddc..88877f586`: in-scope TS **+12**, Rust **+3,097**. The +12
is `hasSharedMmapBackings()` and the `epollInterests` move — both K3 freeze-list
obligations (§10.1 items 2 and 5), owed by K7 precisely so K3 could proceed
without conflict. Removed by **K7's own cutover**, which deletes the whole
region; K3 also consumes the predicate.

## 2w. K7 cutover attempted — the item is mis-scoped, and the contract said so wrongly (2026-09-10)

Worktree `.claude/worktrees/agent-a926fd00020cebc3b`, base `8a89c2f4a`, tip
`a7c63731a`, 3 commits. **The cutover did not land.** No ABI bump, no new
`env.host_*`.

**Ledger `8a89c2f4a..a7c63731a`: in-scope TS +0, Rust +306.** This item was
required to be strongly net-negative in TypeScript and it is not. That is the
finding, not an excuse: the deletion it was scoped around cannot be performed,
because a third of the subsystem has nothing to replace it.

### What the survey established

The TypeScript shared-memory subsystem in `host/src/kernel-worker.ts` is
**~3,600 lines**, not the ~4,500 the item assumed, and it decomposes as:

| bucket | lines | Rust counterpart |
|---|---|---|
| the 34 named functions in the contract's map | 1,359 | present |
| collateral-dead helpers reachable only from them | 764 | present |
| **file-syscall coherence / registration cluster** | **1,203** | **absent** |
| the eleven container declarations | 14 | present |

The absent cluster is `handleSharedMappingsAfterFileSyscall` and its
per-syscall range policy, `flushSharedMappingsBeforeFileSyscall`,
`findSharedMmapBackingForFd` and the `sharedMmapFdCache`, the path-keyed
lookups (`resolveSharedMmapPath`, `findSharedMmapBackingForPath`,
`flushSharedBackingForPath`), the `reloadSharedMmapBacking*` family, and the
mmap-from-file registration path (`prepareSharedMmapFromFile`,
`registerPreparedSharedMmap`, `registerFdWritebackSharedMmap`).

**It reads the same containers.** `handleSharedMappingsAfterFileSyscall` opens
with `if ((this.sharedMmapBackings?.size ?? 0) === 0) return;`. So the eleven
containers cannot be deleted while it stands, which means the cutover cannot be
completed by wiring entry points — the thing the item was scoped as.

**And it cannot be dropped.** It is POSIX `MAP_SHARED` fd/mapping coherence: a
`write` through one descriptor becoming visible through a mapping held via
another, `O_TRUNC` reloading from zero, `ftruncate` clamping. Generic-first
applies — a coherence case no shipped package triggers is still a case.

### It is a dispatch gap, not a primitive gap

Worth stating precisely, because it sizes the remaining work. Every primitive
the missing cluster needs **already exists** in `memory.rs`:
`FileBacking::invalidate_range`, `flush_range`, `revalidate`,
`ensure_range_loaded`. What is absent is the layer that decides *which* backing
and *which* byte range each file syscall touches. Estimate is a port of policy,
not of mechanism.

The path-keyed functions want a **design decision rather than a port**: the
table keys backings on handle identity (`dev`/`ino`), never a pathname, and
that already subsumes the case the TypeScript path lookups exist for — a second
fd onto the same object resolves to the same key without consulting a name.

### Why the contract misled, and what was fixed

K7 was credited — correctly — for documenting the cutover contract on
`SharedMappingTable` itself rather than leaving a fourth unwired module. The
contract was accurate about what it *did* and silent about what it *did not*,
and silence in a work contract reads as completeness. Its TS→Rust map named
none of the 1,203 lines; its import map called five host imports sufficient.

The contract has been corrected in place (`a7c63731a`) to carry the gap, its
kind, the sequencing, and three smaller errors it contained:

1. `process_memory_len` is a **sixth** host-sourced value. It is not an import
   and should not become one: guest memory length belongs to a
   `WebAssembly.Memory` the kernel has no handle to, and the host grows a
   process's memory *after* the kernel returns from `mmap`. Entry points take
   it as an argument the host already holds.
2. `retain_handle` and the fd-writeback members were described as the existing
   in-kernel refcount. They did not exist. They now refuse with `ENOSYS`
   rather than hand a caller a handle the kernel may close underneath it.
3. The performance note left the copy cost unbounded (see below).

### The STRONG DOUBT is narrower than recorded — and general benchmarks cannot see it

Two structural facts, both verified in the code, confine where the copy can be
paid:

1. `synchronize_for_boundary` returns immediately when a process owns no shared
   state — the overwhelming majority of processes.
2. `sync_anonymous_from_process` skips a mapping whose backing has
   `ref_count <= 1` and is not stale, **exactly as the TypeScript does**
   (`memory.rs` and `kernel-worker.ts:27080` agree). A mapping with no live
   peer is never scanned, let alone copied.

So the regression risk is confined to a process holding a large writable
`MAP_SHARED` **with at least one live peer**, crossing boundaries often.

This matters for how the item is validated. A general syscall benchmark
exercises fact 1 and will report no change — a **true result about the
early-out that says nothing about the copy**. Per the validation contract that
is a narrow check supporting a broad claim, and it must not be used to close
the doubt. Measuring this honestly needs a targeted case holding a genuinely
shared mapping with a live peer.

**Performance was not measured in this item**, and the reason is that there is
no cutover to measure — "after" would be "before". Note from the analysis above
that the general benchmark suites would not have answered the open question
anyway: they exercise the early-out, not the copy.

### What did land

Two pieces of the environment the cutover needs, both of which the next
attempt would otherwise have to write first:

- **`global_shared_mapping_table()`** (`b4b9b5151`) — the machine-wide
  singleton, a peer of `global_ipc_table()` rather than a `ProcessTable` field,
  because the `SharedMappingIo` fd-writeback path needs `&mut Process` and
  owning the table outside the process table keeps that borrow disjoint.
- **`WasmSharedMappingIo`** (`cd267acae`) — the production `SharedMappingIo`.
  Before this the only implementation in the tree was `MockIo` in a test
  module, so the table could not have run whatever called it. It answers the
  trait from three sources: the host for the two cross-address-space byte
  copies, the kernel's own `IpcTable` for SysV segment bytes, and the caller
  for memory lengths.

`cargo test -p runtime-core --lib`: **1869 passed, 1 failed** — the failure is
`zip::real_man_zip_cross_checks_members`, pre-existing and assigned elsewhere.

`cargo check` clean on **wasm32 and wasm64** as well as native. The wasm build
earned its place here: a bare `String` in the bridge resolved on the native
test target and broke both real ones, because the kernel is `no_std` plus
`alloc`. A native-only check would have reported this item green.

The seven mmap/shared-memory Vitest files: **95 passed, 1 skipped** — the same
result K7 recorded, so the added Rust regresses nothing. `verify-fresh` is
green and reports the ABI snapshot in sync; this item adds no export and no
import, and `abi/snapshot.json` is untouched.

**Provisioning note, and it will hit every parallel worktree.** `./run.sh
setup` failed in this worktree with `kandelo-sdk/wasm32` executing a *different
worktree's* build script — `.../agent-a01d686732af90be5/packages/registry/
kandelo-sdk/build-kandelo-sdk.sh`, importing that tree's `host/src/vfs/
memory-fs.ts`, which failed on a missing `fzstd` because that worktree has no
`node_modules`. The shared `~/.cache/kandelo/source-only/` cache is capturing
**absolute source paths** from whichever worktree populated an entry first.
This is not the known cache-key drift (that was resolved and was about key
determinism); it is path capture in the cache payload, and with several agents
in parallel worktrees it will keep misrouting builds. Worth its own item.

### NEEDS-DEFER-DECISION — how to re-cut this item, for the maintainer

*What:* the K7 cutover cannot be one item. It needs splitting.

*Why:* a third of the subsystem has no Rust counterpart and shares the
containers with the two thirds that do.

*Cost now:* writing the missing file-syscall coherence layer is new design
work in the `MAP_SHARED` correctness core, not a port. Doing it in the same
pass as a hot-path cutover, unmeasured, is the highest-risk shape available.

*Cost later:* the TypeScript stays live and the campaign's net-TS number stays
positive for another cycle.

*Recommendation:* three items.

1. **The SysV half, now.** `sysv` / `sysv_versions`,
   `track_sysv_mapping`, `sync_sysv_from_process`,
   `sync_sysv_segment_from_attached`, `release_all_sysv_for_process` cover
   `shmMappings` / `shmSegmentVersions` completely, with no dependency on the
   gap, and it is the one part with a clear performance **gain** — the mirror
   stops pulling whole segments through `kernel_ipc_shm_*_chunk` round trips.
   ~263 TypeScript lines and two of the eleven containers.
   **Design this trap first:** `synchronizeSharedMemoryForBoundary` early-outs
   on `sharedMappings.size === 0 && shmMappings.size === 0`. Moving only the
   SysV half leaves the host unable to see half that predicate, and answering
   it with a per-syscall kernel call puts a new call on the hot path. Driving
   the sync from inside the kernel's own dispatch avoids the extra call but
   moves where the sync happens relative to the syscall, which is load-bearing.
2. **Write the file-syscall coherence layer in Rust**, as its own item, sized
   as policy rather than mechanism, with the handle-identity design decision
   taken deliberately.
3. **Then the anon+file cutover**, gated on a targeted shared-mapping
   benchmark, not a general syscall suite.

*Also for decision:* whether the `host_proc_compare_bytes` member is wanted at
all. It should not be added speculatively — if item 2's design keeps the
mapping's dirty set authoritative in the kernel, the full-range read may never
be on the hot path to begin with.
## 2w. Maintainer rulings, 2026-09-10 — these override earlier guidance

Twelve open questions were put to the maintainer. The answers change how the
rest of the campaign runs.

### 1. Cutover is part of the item — the campaign's biggest correction so far

**Ruling:** "I want you to do cutovers as you go. Can't you work on worktrees
and then merge `wasm_api.rs` changes when you complete a standalone task?"

**Yes — and the coordinator's file-ownership rule was over-cautious.** Every
agent works in its own git worktree, so two agents editing
`crates/kernel/src/wasm_api.rs` is a *merge* problem, not a *correctness*
problem, and this session had already resolved several such merges cleanly. By
treating that single file as a serialized lane, the campaign accumulated
**+476 net TypeScript lines and ~6,600 lines of dormant Rust** sitting beside
the TypeScript it was written to replace.

**New standing rule: an item is not done until the Rust runs and the superseded
TypeScript is deleted.** Landing more dormant Rust is a failed item, not a
partial success. Agents are explicitly told not to contort a change to avoid
touching a contested file.

**Why this matters beyond tidiness:** if the campaign stopped at any point
under the old rule, the repo would be *strictly worse* than at the start — the
same TypeScript plus a parallel Rust implementation. Value was entirely
backloaded behind a single-lane road.

### 2. The K8 boot flip — do it, and let tests find the problems

**Ruling:** "No, I want you to just use the kernel version and depend upon tests
to reveal issues. And I'll also insist on my manually testing the kandelo web
app before merging."

The three host mutations (`normalizeLegacyRootfs`, `ensureMountParentDirectories`,
the browser MITM CA write) still move into Rust — that part was never in
question. What is withdrawn is holding the flip back for review.

### 3. Cross-memory copy — the root cause, and the sanctioned remedy

**The question:** why must Rust copy where TypeScript had a zero-copy view?

**Answer, confirmed rather than assumed:** the kernel is itself a wasm module,
and a wasm load instruction can address only its own module's memory. Each
process has its own `WebAssembly.Memory` (`host/src/process-memory.ts:307`).
The host is JavaScript holding every `SharedArrayBuffer` at once, so its view
is free. **No Rust technique fixes this.** It is the address-space isolation
that makes processes processes.

**The same fact makes `host_futex_wake` a genuine floor** — and this answers
K3's §11.1 probe without needing one. It has five real call sites
(`syscalls.rs:16140-16163`), unlike its dead twin `host_futex_wait`. Guests park
via `__builtin_wasm_memory_atomic_wait32` on an address in **their own** memory
(`libc/glue/channel_syscall.c:1872`); the kernel cannot execute
`memory.atomic.notify` against it.

**This unifies several apparent floors into one:** *cross-memory access* is the
capability the host genuinely cannot give up. That sharpens what "smallest host
surface" can mean — the target is not zero, it is the closure of what only a
party holding two address spaces can do.

**Maintainer's ruling:** "This sounds like it might be best solved with a host
API member. Is there a way to do this while protecting the general abstraction?"

**Yes.** The host already exposes `host_proc_read_bytes` and
`host_proc_write_bytes`. The missing member of that family is cross-memory
**compare** — `host_proc_compare_bytes(pid, guest_addr, kernel_buf, len,
granularity) -> dirty bitmap` — so only changed pages cross.

It protects the abstraction because:
- It is a **pure function over bytes, not an authority.** The kernel keeps the
  mapping table, dirty-set semantics, publish/refresh and writeback policy. The
  host answers "which bytes differ", never "what should happen".
- It serves any future dirty-tracking need — checkpointing, COW detection,
  `MAP_SHARED` writeback — not one caller.
- It must be a **distinct named member**, never a mode flag on an existing
  import: §6.3 of the K14/K9 grounding lists opcode collapse as a cheating
  criterion that shrinks the count while worsening the contract.

**This is the one sanctioned new `env.host_*` import in the campaign, and it is
gated on measurement.** K7's cutover must benchmark before adding it.

### 4-12, briefly

4. **Epoll POSIX gaps** (interest-list inheritance across `fork`, OFD keying):
   fix if straightforward; otherwise log to `docs/future-improvements.md`
   explicitly and defer. Not a silent drop either way.
5. **The futex floor: answered above** by the cross-memory finding — no probe
   needed. `usePolling` deletion still owed.
6. **K12's struct seed path — coordinator's judgment, exercised: DO NOT DO IT.**
   The `fm_*` exports are module exports, free under the smallest-host-surface
   goal. Removing the struct seed path is a *semantics* change in fork replay —
   the highest-risk subsystem in the repo — buying no host-surface reduction and
   no TypeScript deletion. It fails the Bar. Logged as a possible future
   simplification with this reasoning.
7. **`cap-std` for host-native: approved**, not merely in principle.
8. **Browser validation runs as one consolidated pass per tier** (end of Tier 2,
   again after Tier 3), plus the maintainer's own manual check of the web app
   before merge. Agents are told to stop fighting browser provisioning and
   instead state precisely what is unproven.
9. **No further `ABI_VERSION` bumps. Everything stays under ABI 44.** Snapshot
   regeneration only; a gate complaining that the snapshot moved without a bump
   is expected within the epoch and must be reported, not silenced.
10. **The three long-standing failures are IN SCOPE** —
    `zip::real_man_zip_cross_checks_members`, `kernel-scratch-contract` 3/8,
    `vfs-image-wasm-policy`. Coordinator owns them.
11. **Fix the xtask target properly** — done: `scripts/xtask.sh`. `forced-target`
    re-tested on the pinned toolchain and still panics the cargo resolver.
12. **Hold the curation.** The maintainer wants to cross-examine the work and
    the repo state before agreeing to a curated commit set. Do not squash.

## 2x. K10 I4/I5/I6 — the Rust WASI module RUNS and `wasi-shim.ts` is DELETED (2026-09-10)

Worktree `.claude/worktrees/agent-af972f7169e0efbd3`, base `c45e73d3d`.
**Ledger `c45e73d3d..78718ecd1`: in-scope TS 740 added / 1,795 removed = −1,055.**
No `ABI_VERSION` change; no new `env.host_*`.

### The fixtures gate was NOT a floor. It was the thirteenth disproved one.

§2h held I6 because "fixtures cannot exercise a real wasi-libc guest", and §1
flagged its own gate: *"the item's held deletion (I6) is gated on fixtures
rather than on generic correctness. Re-read that decision before I6 lands."*

Re-read, and measured. Three findings, in order of how much they move the
decision.

**1. The gate asked the Rust to clear a bar the TypeScript never cleared.**
No wasi-libc guest has ever exercised `host/src/wasi-shim.ts` either. The
declared toolchain cannot build one (no wasi sysroot in `flake.nix`, no
`wasm32-wasip1` std). So "a real wasi-libc guest would catch something the
harness cannot" is true, and it was equally true of the code being kept.
Holding the deletion for evidence that never existed for the incumbent is not
caution; it is a standard applied to one implementation and not the other.

**2. The differential harness is real, exhaustive, and IN SYNC — verified, not
assumed.** `cargo xtask dump-wasi-translation` regenerated byte-identical to
the committed `host/test/fixtures/wasi-translation-rust.json`, so the Vitest
harness was comparing today's Rust rather than a stale dump. It ran green
(13/13) against the live TypeScript immediately before the deletion.

**3. But the harness covers less than "1,358 inputs, TypeScript vs Rust"
suggests, and the difference is worth recording.** 1,358 is the dump's total
row count across 11 tables. The harness *executes the TypeScript* on
**1,031** of them, across seven functions:

| table | rows | TS executed |
|---|---|---|
| `wasiOflagsToPosix` | 512 | yes |
| `splitSignedI64Words` | 212 | yes |
| `translateLinuxErrno` | 201 | yes |
| `modeToFiletype` | 60 | yes |
| `posixFlagToWasiFdflags` | 28 | yes |
| `wasiWhenceToPosix` | 9 | yes |
| `wasiClockToPosix` | 9 | yes |
| `pollOneoffTag` | 256 | **no** — asserts a `typescript` column recorded in the Rust dump |
| `fdFdstatSetFlags` | 64 | **no** — same |
| `pathFilestatGetLookupflags` | 4 | **no** — same |
| `translateStat` | 3 | **no** — the test re-implements the shim's `DataView` reads inline |

The four modelled tables are exactly the defect tables, where the point is
that Rust deliberately differs — so a hand-written model of the incumbent is
defensible there. It is still a weaker claim than the phrasing carried, and an
agent quoting "1,358 inputs, TypeScript against Rust" would be overstating by
24%.

**What the harness never covered at all: the 46 entry points.** Argument
marshalling into the syscall channel, iovec scatter/gather, the preopen table
and path resolution, dirent re-encoding, subscription/event encoding, the
scratch layout. That is the large majority of the deleted 1,649 lines. Those
are covered instead by `crates/wasi-module/tests/entry_points.rs` (60 tests
asserting the exact syscall number and six i64 argument slots against a
recording fake channel) and, end to end, by the five `.wat` guest fixtures.

### The residual risk was wiring, and wiring was testable without wasi-libc

Two of the five real-guest fixtures need no rootfs image, and both **passed on
the Rust module** on the first run of the cutover: `path_open` + `fd_read` +
`fd_seek` + `fd_tell` (`abcd4ghi`), and `fd_readdir`. That exercises placement,
instantiation, import splicing, the channel handshake against a real kernel,
path resolution through the preopen table, and dirent re-encoding — every layer
the "fixtures cannot prove it" objection was really about.

### The sixth silent-success defect, and it was inside this item's own gate

`cargo test -p wasi-module` — the command the crate's own Cargo.toml comment
declares — ran **zero tests and exited 0**. `tests/entry_points.rs` opens with
`#![cfg(feature = "testing")]` and nothing enabled the feature. Those 60 tests
are the only coverage of 40 of the 46 entry points. §2h recorded "wasi-module
11+59" because that agent passed `--features testing`; anyone following the
documented command saw green and proved nothing.

Fixed with a dev-dependency on the crate itself, which turns the feature on for
exactly the test targets. Making it a default feature would instead compile the
FakeMemory/FakeChannel harness into the wasm cdylib that ships inside a guest's
address space; the staged `wasi_module32.wasm` is byte-identical at 24,653
bytes after the change, which is the check that says so.

### I4/I5 were needed, and doing them shrank the host rather than growing it

The cutover needed the browser surface §2h deferred: a `@wasi-module32-wasm`
Vite alias, `browser-wasi-module-artifact.ts`, bytes shipped through the
browser kernel protocol, and `resolveBinary` on Node.

Two things were done rather than duplicated:

- **`host/src/pic-side-module.ts`** — reading `dylink.0` `mem_info`, the
  alignment arithmetic, and minting the three placement globals were private to
  `fork-module-instance.ts`. A second side module would have meant a second
  copy. They are now shared.
- **`CORESIDENT_SIDE_MODULES` in `local_build.rs`** — the projection, staging,
  freshness and `verify-fresh` machinery was written against the fork module
  specifically. It is now parameterized by a descriptor, so the WASI module is
  an entry rather than a second copy of five functions, and a third side module
  is one more entry. Without this, `./run.sh setup` would produce a tree where
  no WASI guest can run. `cargo test -p xtask`: 605 passed.

The `forkModuleInitFields` supplier in both worker entries became
`sideModuleInitFields`, so shipping a second co-resident module cost zero new
spread points at the seven worker-launch sites.

### What replaces the harness, since its subject is gone

A differential harness cannot outlive the implementation it differs from. The
fixture's *other* role — a reviewed record of Rust's answer on all 1,358 inputs,
including the five deliberate divergences — is now pinned by a Rust test
(`dump_wasi_translation::tests::the_committed_fixture_is_what_wasi_abi_produces_today`).
Any change to a translation table now fails a test until someone regenerates
and reviews the diff. That closes the one failure mode the Vitest harness could
not see: it compared TypeScript against whatever JSON happened to be checked in.

### One behaviour change beyond the five defects: wasm64 WASI now fails loud

The deleted shim hardcoded `PROCESS_IOVEC_WASM32_BASE_OFFSET` /
`_LEN_OFFSET` / `_SIZE` and took no pointer width at all, so a wasm64 WASI
guest would have had its `iovec` fields read at wasm32 offsets and been
silently mis-marshalled. WASI Preview 1 is a wasm32 ABI, so the module is
built wasm32-only and `sideModuleInitFields` supplies it only for `ptrWidth`
4; a wasm64 WASI guest now gets a loud error naming the build script instead
of wrong bytes. This is the truthful-failure contract applied to a case the
TypeScript answered incorrectly rather than not at all.

### Honestly unproven

- **Browser.** No browser was booted. One positive check did run: the browser
  input scanner, driven from the three real HTML entries, reports capabilities
  `["fork-module32-wasm", "kernel-wasm", "pages-vfs-products", "rootfs-vfs",
  "wasi-module32-wasm"]` — so `browser-wasi-module-artifact.ts` IS reachable
  from the browser entry graph through the dynamic import in
  `browser-kernel-host.ts`, and the alias is recognized. That proves the
  dependency edge exists, not that a WASI guest runs in a browser. Per §2w item
  8 the rest goes to the consolidated tier-end pass and the maintainer's manual
  check.

  **Do not cite `scripts/ci-check-browser-assets.sh` as evidence for this.**
  It exited 0, but reading it shows `browserAssetImportsForPolicy` hardcodes
  `@kernel-wasm` + `@rootfs-vfs` + `@binaries/*` and `resolveAssetImport`
  throws "unsupported browser asset import" for anything else — so it has never
  covered `@fork-module32-wasm` either. Its green says nothing about either
  side module. It also reports "Package artifacts not found" for a dozen
  unbuilt packages and still exits 0, which is worth knowing before quoting it
  for anything.
- **The three rootfs-dependent guest fixtures** (`wasi-hello`, `wasi-args`,
  `wasi-scalar-abi`) — provisioning, not a result; see the report.
- **Performance.** Not measured. Each WASI call loses a JavaScript frame and
  gains a wasm call, but no benchmark was run and no claim is made.
## 2x. K7 re-cut piece 1 — the SysV half is CUT OVER (2026-09-10)

Worktree `.claude/worktrees/agent-a4a3478cb72f27219`, base `7105e6b04`.
**The TypeScript is deleted.** No ABI bump, no new `env.host_*`;
`abi/snapshot.json` regenerated for nine additive exports inside ABI 44.

**Ledger `7105e6b04..<tip>`: in-scope TS 306 added / 638 removed = −332.
Rust +789 production.** The first item in this campaign whose cutover
actually happened, and the first meaningfully net-negative TS step since K2.

### What went

Both containers — `shmMappings` (pid → attach address → snapshot) and
`shmSegmentVersions` — and everything that read them: `hasPeerSysvShmMapping`,
`syncSysvShmMappingsFromProcess`, `syncSysvShmSegmentFromMappedProcesses`,
`mergeAndRefreshSysvShmMapping`, `readSysvShmRange`, `writeSysvShmRange`,
`mappingDiffersFromSnapshot`, `releaseAllSysvShmMappingsForProcess`, the
per-attachment fork attach/record/rollback loop with
`#rollbackInheritedSysvAttachmentsWithinKernelEntry`, and four interfaces
(`SysvShmMapping`, `PreparedInheritedSysvMapping`,
`MaterializedInheritedSysvMapping`, `MaterializedSharedMappingInheritance`).

Nine kernel exports drive the Rust mirror: `track`, `sync_process`,
`sync_segment`, `publish_mapping`, `drop_mapping`, `release_process`,
`inherit`, `active_pid_count`, `process_count`.

### The boundary early-out trap, and how it was answered

`synchronizeSharedMemoryForBoundary` early-outs on
`sharedMappings.size === 0 && shmMappings.size === 0`. The second half was the
trap: a per-boundary kernel call would put a new call on the syscall hot path
for every process, and driving the sync from inside kernel dispatch would move
where it happens relative to the syscall, which is load-bearing.

**Neither was needed.** The host caches the *count of processes owning
attachments* and re-reads it from the kernel at every site that can change it —
shmat, shmdt, fork inheritance, exec finalization, teardown. It is a cached
predicate refreshed from the authority, never an independently maintained
mirror, so it cannot drift: nothing in the host ever increments or decrements
it. The sync still runs on the host side of dispatch, before the syscall,
exactly as before.

**It also came out narrower than the code it replaced.** Every host path into
the mirror is gated on that predicate, not just the boundary — so a machine
that never uses SysV IPC now pays nothing at fork, exec or teardown either,
where the deleted TypeScript still walked its containers. The old boundary code
called its SysV sync whenever *either* half of the subsystem was non-empty.

### A POSIX defect the cutover surfaced

An attachment was skipped at a boundary whenever it had no live peer.
Peer-existence alone is not sufficient, and treating it as sufficient loses a
peer's writes in an ordinary IPC shape: a child attaches, fills the segment,
publishes and exits; the parent, now sole observer, never imports what the
child wrote. `shmdt` and teardown publish the departing attachment's bytes, but
nothing re-read them into the survivors.

An attachment is now skipped only when it has no live peer **and** has already
observed the segment's current version — exactly what
`sync_anonymous_from_process` has always tested (`ref_count <= 1 &&
!was_stale`). The SysV path tested only the first half.

**The defect predates the campaign**: the deleted TypeScript had the same
single-condition skip and the K7 Rust port reproduced it faithfully. It
surfaced from a test written to assert the POSIX behaviour rather than the
implemented one. It is a behaviour change riding inside a cutover, so it landed
as its own commit and can be dropped independently if the maintainer would
rather sequence it separately.

### One structural correction made during the work

The first draft put the fork transaction and its rollback in
`crates/kernel/src/wasm_api.rs`, which is the export shim and has no unit-test
seam — moving the rollback from a TypeScript file with five tests to a Rust
file with none. It now lives on
`SharedMappingTable::inherit_sysv_attachments` behind a `SysvAttachmentOps`
trait, with six tests, four of them rollback paths asserting exact call order
(releasing by the wrong key would detach an unrelated same-segment attachment).

**Generalizable:** "moved to Rust" is not automatically "better covered".
Check where in Rust, and whether that place can be tested.

### MEASURED: the predicted gain is a regression, and the sanctioned import is now justified

§2w predicted the SysV half was "the one part with a performance *gain*",
because the mirror stops pulling whole segments through
`kernel_ipc_shm_*_chunk`. **Measurement disproves that.** Node,
`benchmarks/programs/sysv-shm-bench.c`, 256 KiB segment, one live peer, medians
of 5 runs each, same machine, cutover kernel vs a kernel built from the base
commit with the base host:

| case | before | after | change |
|---|---|---|---|
| boundary, peer alive, nothing written | **793 µs** | **2,965 µs** | **3.7× slower** |
| boundary, a byte dirtied each iteration | **2,317 µs** | **3,861 µs** | **1.7× slower** |
| attach + detach cycle | **6,105 µs** | **11,441 µs** | **1.9× slower** |

The spreads do not overlap on the clean case (before 485–1,513; after
2,823–3,717), so this is a real separation, not the machine's noise. Both runs
were taken after the concurrent builds finished; an earlier "after" run taken
*during* a build was discarded rather than reported, because it would have
overstated the same conclusion.

**The cause is the one §2w already named, on the half nobody expected it on.**
The TypeScript diffed a zero-copy view of guest memory, so deciding "nothing
changed" was free. The kernel must pull the whole mapping across
`host_proc_read_bytes` *before* it can decide anything, and it pays that on
every boundary with a live peer whether or not a byte moved. Replacing the
chunked segment round trips is a real saving, but it is smaller than the copy
it buys.

**Two remedies, and the cheaper one is not an import.**

1. `host_proc_read_bytes` copies the range **twice** and allocates once per
   call (`host/src/kernel.ts`): `sliceUint8Array(processView)` materializes a
   fresh array, and `#writeKernelBytes` then copies that into the kernel
   destination. 256 KiB in, 512 KiB copied. Writing straight into the proven
   kernel destination is a host-side fix in existing code, needs no new import,
   and helps every one of the family's callers.
2. **`host_proc_compare_bytes` — the campaign's one sanctioned new import — is
   now justified by measurement rather than by argument**, and by the half it
   was not reserved for. A cross-memory compare returning a dirty bitmap turns
   the clean case (the common one) from a full copy into a comparison, which is
   exactly what the TypeScript had for free. §2w reserved it for the anon/file
   half "if a *targeted* benchmark ever justifies it". The targeted benchmark
   now exists and the answer is yes.

**This is a decision for the maintainer, not for the item that found it.** The
cutover is correct, deletes the TypeScript, and fixes a POSIX defect; it also
costs measurably on a narrow path — a process holding a large writable SysV
attachment with a live peer, crossing boundaries in a loop. Whether that is
acceptable until remedy 1 or 2 lands is a judgment about this platform's
priorities, and the performance contract puts correctness above speed but does
not license shipping an unreported regression.

### The host import count moved 83 → 84, and it is not growth

`host_debug_log`. Nothing was declared and no capability was added: it was
already the contract's single diagnostics sink, and it was absent from the
built artifact only because the one implementation reaching it —
`WasmSharedMappingIo`'s writeback-loss report — was unreachable while
`SharedMappingTable` was dormant. Cutting over constructs that type for real,
so the linker keeps the edge. **§4's concept table is unchanged: diagnostics
was 1 and is still 1.**

The instrument is reporting that dead code became live. The only way to keep
the number at 83 would be to make the writeback-loss report conditional, which
trades a truthful diagnostic for a smaller number — the trade this campaign
exists to refuse. `EXPECTED_HOST_IMPORT_COUNT` is bumped in its own one-line
commit so it can be dropped if the maintainer would rather the gate stay red
until the whole subsystem lands.

**Worth generalizing:** every remaining dormant module in this campaign may
carry the same latent edge. A cutover's import delta is not knowable from the
diff; it has to be measured on a built kernel, before and after.

### The scratch-contract audit caught a real weakening, in correct code

The first cut resolved the entry points through one generic
`#requireSysvMirrorExport<T>(name)` that indexed `exports[name]` with a
computed string and returned `exported as unknown as T`. The audit flagged
every call through it as `kernel-pointer-export-bypass`, correctly: a helper
that erases *which* export is being called also erases what its arguments mean,
so a `KernelPointer` could be handed a plain `number` and truncate silently for
a wasm64 process — the failure `checkedWasmPointer` exists to prevent,
reintroduced one layer up. The exports are now resolved by literal name with
exact signatures, and the findings moved to `kernel-export-direct-use`, the
reviewable kind.

**A convenience helper is where typing quietly goes to die.** The code was
otherwise correct; nothing failed; only the gate saw it.

### There is no conformance coverage for SysV shared memory anywhere in the repo

Checked rather than assumed: `shmget`, `shmat`, `shmctl` and `sys/shm.h` appear
nowhere under `tests/`. The open-posix-testsuite covers POSIX realtime
`shm_open`, not XSI SysV IPC, so the validation contract's "consider the
conformance suites" resolves to *there are none to consider* for this surface.

The coverage that exists is: 48 `SharedMappingTable` unit tests in Rust (14 of
them SysV), the host↔kernel contract tests, and
`benchmarks/programs/sysv-shm-bench.c`, which is a real multi-process exercise
(`shmget` / `fork` / two `shmat`s / peer handshake / `shmdt` / `IPC_RMID`) and
so doubles as the only end-to-end functional check of the subsystem. **That is
a platform gap worth its own item**, not something this cutover created.

### What is explicitly NOT covered by this item

Stated because silence in a work contract reads as completeness:

- The anonymous and file-backed halves of `MAP_SHARED` are untouched. Pieces 2
  and 3 of the re-cut still own them and the ~1,203-line file-syscall coherence
  gap.
- `retain_handle` / fd-writeback still refuse `ENOSYS`; that is the file half.
- Browser is unverified for this change. Node-only; see the validation note.
- The `host_proc_compare_bytes` import remains unspent. This half never needed
  it: the kernel reads its own segment bytes.
### Three defects only the guest-ABI tests could find

Unit tests would have passed on all three. Each needs a real kernel
instantiated against a real host:

1. **Every handle-taking operation rejected a directory handle with `EBADF`** —
   `fstat`, `fstatfs`, `fpathconf`, `fchmod`, `fchown`, `fsync` resolved only
   from the file table. `pathconf` of any path on a host mount failed outright,
   because the kernel now answers it from the containing directory.
2. **`kernel_rootfs_set_foreign_mount_roots` was not approved for scratch
   borrowing.** The name reached the allowlist array and the pointer-argument
   table but not the runtime validator, so publishing the anchors threw and
   *the kernel worker failed to boot at all*.
3. **Closing a directory stopped dropping its staged `readdir` entry.**
   `host_closedir` cleared `pendingDirectoryEntries` in a `finally`; `host_close`
   did not inherit that when the pair was retired. Backends reuse numeric
   handles, so the next directory at the same number would have served the
   previous one's record.

This is the "do not stop at unit tests" rule earning its place: the Rust suites
were 1834/1834 green while all three were live.

### Validation actually run

- `cargo test -p runtime-core -p kandelo -p host-native
  --target aarch64-apple-darwin` — **green** (runtime-core 1834/1834;
  host-native 52/52 with 4 pre-existing ignores).
- `host-native`'s `smoke_loads_real_kernel_and_reads_abi` — **green against a
  freshly built and installed artifact**, which is the pinned-import-surface
  proof. `EXPECTED_HOST_IMPORT_COUNT` = 75.
- `wasm-objdump` on the artifact, before and after: **83 → 75**.
- `xtask verify-fresh` — **green** (ambient `local-binaries/kernel.wasm` fresh
  against the source closure).
- Host Vitest: the VFS/path suites green, including the `pathconf` and
  `fstatat-empty-path` **guest-ABI** suites, which run real `.wasm` guests
  through a real kernel worker; and `chown-sentinel`, which exercises
  `chown`/`fchown`/`lchown` ownership and set-ID semantics end-to-end.
- **Not run: the browser.** See below.

### Browser: not validated, and what that leaves unproven

`./run.sh browser` plus Playwright was not run. What is unproven is the browser
boot path end to end.

Two things bound the risk, and neither is a substitute for running it:

- **Both hosts share one implementation.** `VirtualPlatformIO` serves Node and
  browser alike, so the `*at` methods, the unified handle space, and the
  directory-handle cases are exercised identically by the Node suites. The
  browser-specific code (`browser-kernel-worker-entry.ts`) was not touched.
- **The publication path is order-independent by construction.** `kernel.ts`
  publishes anchors at instantiation, which is *before* either worker entry
  registers foreign prefixes. That is safe only because the anchor registry is
  deliberately independent of the prefix registry — had they been coupled, the
  browser would have been the host most likely to break on ordering.

The browser still has foreign mounts after K8 (`/dev/shm` over a
`SharedArrayBuffer`, and a shadowed `/dev`), so the claim that a browser host
implements *zero* of the family is not yet true — it becomes true when the
in-kernel shmfs lands and `/dev/shm` stops being a host mount.

## 3. Decisions already taken — do not relitigate

1. The whole campaign is **one ABI epoch**. Re-instrumentation is available.
2. `EXPECTED_HOST_IMPORT_COUNT` is an **instrument, not a goal**.
3. Scope is the **runtime**; toolchain is a later campaign.
4. Host-contract **reshaping** is fair game, not just shrinking — all three
   hosts live in this repo and ABI 44 is unreleased.
5. `host/test` is **not a migration target**, but test fallout is sized as
   real work (§6).
6. Demos are consumers, not platform. Out of scope.

## 4. V4 measured properly: the host contract by concept

The unit is *concepts a host author must implement*, not import count.

*(Updated 2026-09-10 when K9 landed. The "now" column was measured against
the built artifact at the time of writing; K9's row is measured against the
artifact today.)*

| concept | now | target | why the target is right |
|---|---|---|---|
| file **names** + metadata | **DONE: 0 mandatory + 11 optional** (was 25) | 0 mandatory | the host must open a file; it must never resolve a name. Rust resolves namespace paths and steps the host one component at a time (`crates/runtime-core/src/hostdir.rs`). See §2t |
| graphics / audio devices | 23 | ~8 | real device surface; GL already has a command buffer (`gl_submit`), KMS/GBM/framebuffer can converge on attach + submit + query |
| sockets | 12 | ~6 | byte ops on a host socket; `getaddrinfo` can become a Rust resolver over a host UDP socket |
| file **bytes** on a handle | 10 | ~6 | genuine floor; `host_append`/`host_append_position` are an O_APPEND shim that disappears when the kernel owns the file |
| wait primitives | 4 | **2** | `futex_wait`/`futex_wake` irreducible; `sigsuspend_wait` and `nanosleep` are futex-with-timeout |
| image bytes | 2 | 2 | already correct (V3) |
| cross-memory copy | 2 | 2 | irreducible — and should *grow in use* |
| clock / entropy | 2 | 2 | host services |
| timers | 2 | 1 | one arm-at-deadline callback; the registry is kernel state |
| guest invocation | 1 | 1 | calling a guest export is host-side |
| host process wait | 1 | 0–1 | native only; meaningless in a browser |
| diagnostics | 1 | 1 | raw byte sink |
| **total** | **75** *(83 before K9; 85 was the declared count, never the linked one)* | **≈30 mandatory + ~11 optional** | ~8 of which are device surface |

## 5. Work items ranked by value

Ordering is **value delivered per unit of risk**, not size. IDs match the
census. "Serves" lists the values each item advances.

### Tier 1 — high value, low risk, independent, startable now

| id | item | serves | why now |
|---|---|---|---|
| **K1** | **Wire `sffs.rs`** — the kernel parses VFS images itself; host supplies bytes | **V3**, V1 | ~500 lines of Rust already written and reviewed, referenced by nothing. Unblocks the entire bundle architecture for almost no risk. Highest value/risk ratio in the campaign |
| **K10** | **`wasi-shim.ts` → Rust** (1,625 lines) | V1, **V2**, V4 | Pure WASI↔POSIX translation: ~180 constants and 8 functions, **zero host capability**. A table and a switch, currently in the one language with no exhaustiveness checking |
| **K13a** | **Delete the 26 dead `kernel_*` exports** | **V4** | Zero callers repo-wide, all shipped in `abi/snapshot.json`. Pure subtraction; ABI 44 is unreleased so it costs nothing |
| **K2** | **Cross-memory access**: generalize `proc_read_bytes`/`proc_write_bytes`, add wasm64 width, implement on host-native | V1, V4 | The enabler that dissolves *all* pre-dispatch marshalling. Currently called from six Rust sites. Small, but everything downstream needs it |

### Tier 2 — highest absolute value, real design work

| id | item | serves | why it matters |
|---|---|---|---|
| **K4** | **Unify the two worker entries** (9,107 lines, **54 duplicated functions**) | **V1**, V2 | The single clearest V1 win in the repo. `handleFork`/`handleVfork`/`handleExec`/`handleSpawn`/vfork teardown written twice, in the language where parity bugs live. Includes deleting both `parseShebang` copies in favour of `exec_target.rs` |
| **K5** *(COMPLETE, §2p)* | **Dynamic linker → Rust** (`dylink*.ts` 6,340 + `worker-main.ts` pieces) | **V1**, **V2**, V4 | A full `ld.so` in TS. Host-native has no linker at all, so this *gains* native `dlopen` rather than relocating it. Also removes hand-maintained wasm32/wasm64 offset pairs and TS wasm binary rewriting |
| **K3** *(0a/1/2 landed, §2q)* | **Blocking scheduler → Rust** (~4,500 lines, 21 state containers) | V1, **V2**, V4 | Keystone: signals, IPC blocking, and process-wait all collapse into it. Removes the epoll mirror. Highest risk in the campaign — every historical hang lives here |
| **K8** *(incr 1 landed, §2r)* | **VFS runtime authority → Rust** (~12,000 lines) | **V3**, V1, V2 | Retires `memory-fs.ts`/`sharedfs-vendor.ts` as readers; in-kernel shmfs for `/dev/shm`; drops the image ABI stamp. Completes V3 |
| **K9** *(COMPLETE, §2t)* | **Handle-only host contract** — the 25 name-taking imports become 0 mandatory + 11 optional | **V4** | The largest single V4 movement, in both count and concept |

### Tier 3 — mechanical once their enablers land

| id | item | serves | depends on |
|---|---|---|---|
| **K6** | Marshalling → Rust (SysV msg/sem, mqueue, sendmsg/recvmsg, ifconf) | V1, V2 | K2 |
| **K7** | Shared-mapping page cache → Rust (~3,000 lines). **Unblocks Workstream H5** | V1, V2 | — (perf-gated) |
| **K11** | Device encode/decode → Rust (VT input, GL command decode, virtual-network registry, TLS state machine) | V1, V2 | — |
| **K12** | Fork surface reduction: `fm_*` consolidation, externref scan into `fork-codec`, **and the GC reference elimination the K0 probes unlocked** | **V4**, V1 | K0 ✅ |
| **K13b** | Export cull: privatize the 117 dispatch-only exports; migrate 2 test-only ones to Rust tests; justify each of the 189 survivors | **V4** | most |

### K0 — COMPLETE (2026-09-09)

All three probes ran; all three settled their question.

- **P1/P2 — PASS** on Node v24.15.0 / Chromium 151.0.7922.34 / WebKit 26.5.
  GC provenance is *recoverable*, not something that must be recorded.
  Evidence: `docs/plans/probes/2026-09-09-k0/`.
- **K0c — the V8 `epoll_pwait` claim DOES NOT REPRODUCE.** Origin commit
  `4131f2498` (2026-04-01, PR #141) says a *"suspected"* V8 bug; the inline
  comment at `kernel-worker.ts:12274` hardened that into a fact and it was
  never re-checked. Driving `SYS_EPOLL_PWAIT` through
  `kernel_handle_channel` on the real ABI-44 kernel returns correctly on all
  three engines — page main thread *and* dedicated Worker with a peer worker
  sharing the kernel's `SharedArrayBuffer`, under real cross-origin
  isolation, 2,000 repeat calls, no crash. Evidence:
  `docs/plans/probes/2026-09-09-k0c-epoll/`.

**Consequence for K3:** the epoll mirror is unjustified. Delete it rather
than preserve it. Note it is not a self-contained deletion — it is read and
written from 10 methods including fork inheritance, exec fd-mirror pruning,
child rollback, and process teardown — so it lands inside K3, not before it.

**Pattern worth naming:** three "floors" have now been inherited and
disproved — wasmtime-exnref, the E1 GC blockers, and this. Re-verify before
inheriting.

## 6. Test fallout (sized, not scoped)

`host/test` is 151,615 lines across 368 files. Three fates, and classifying
them is a prerequisite for honestly sizing K3 and K4, not an afterthought:

- **Dies with its subject** — tests of TS implementations the migration
  deletes, e.g. `kernel-blocking-retry-snapshot.test.ts` (5,772 lines).
  Replaced by Rust tests where the primitives live.
- **Becomes a Rust test** — kernel semantics currently expressed through the
  TS harness.
- **Stays TS** — genuine cross-host wasm behavior: the 74 fork test files
  (18,959 lines), worker/threading, browser-specific paths. These are why
  the TS suite exists and must not be traded away.

## 7. Sequence

```
  Tier 1, all parallel, now:
    K1 sffs ─────────────► K8 VFS authority ──► K9 handle-only contract   [V3, V4]
    K10 wasi-shim                                                          [V1,V2]
    K13a delete 26 dead exports                                            [V4]
    K2 cross-memory ─────► K6 marshalling                                  [V1,V4]

  Tier 2:
    K0c epoll probe ─────► K3 scheduler ──► K4 unify entries               [V1,V2]
    K5 dylink (independent)                                                [V1,V2]
    K7 mapping table (independent, perf-gated) ──► Workstream H5

  Last:
    K12 fork surface   K13b export cull   ──► ABI-44 finalization (B7)
```

Everything must land before ABI-44 finalization, for the same reason
Workstream H must: the host surface has to settle before the ABI freezes.

Land each behavior move behind a **dormant flag, then cut over** — the
pattern `tmpfs.rs` proved across twelve increments. K3, K4, and K5 are the
largest single-step behavior moves in the campaign and must not be big-bang.

## 8. Definition of done, per value

- **V1** — no process-lifecycle, linker, or reference algorithm exists more
  than once. A behavior change is made in one place and every host gets it.
- **V2** — no kernel object is modelled by an untyped TS container; no
  hand-maintained wasm32/wasm64 offset pairs; `kernel-worker.ts` holds no
  `Map`/`Set` that models a POSIX object.
- **V3** — the kernel parses its own VFS image; images carry no guest-ABI
  stamp; kernel + VFS ship as one artifact whose only external contract is
  kernel↔host.
- **V4** — the concept table in §4 reaches its target column; every
  surviving import has a written justification, as the fork campaign now
  does for its `fm_*`.
- **Campaign** — TS is out of the syscall dispatch path; the same
  `kernel.wasm` runs on Node, browser, and native; full batch validation
  green on all three.

## 9. Risks and open questions

1. **K0c is unresolved** and sizes K3.
2. **Immediate cross-process shared-memory coherence is an architectural
   limit, not a migration item.** Each pid owns a distinct
   `WebAssembly.Memory`; a store in one is not observable in another and
   futex cannot target a peer's `SharedArrayBuffer`. K7 moves *ownership*
   into Rust; it does not close that gap and no plan should imply it does.
3. **K7 is syscall hot-path.** Full benchmark suites on Node and browser,
   before/after. No "neutral" claim without numbers.
4. **K5 has no native precedent** — host-native has never had a linker, so
   there is no reference implementation to check against.
5. **The K0 probes tested engine primitives, not the toolchain.** Walrus
   injection, instantiation ordering, and a guest importing the module's
   table remain integration risks. What is settled is that no *engine* limit
   blocks GC reference reconstruction.
6. **`syscalls.rs` is 46,885 lines in one file.** A mechanical module split
   should precede adding four subsystems to it.

## 10. Related records

| Document | Role |
|---|---|
| `2026-09-09-whole-kernel-rust-migration-census.md` | The measured census; K0 probe results in §8 |
| `2026-09-09-runtime-ts-disposition-ledger.md` | Every in-scope TS area: keep / migrate / eliminate, with reasons |
| `2026-09-05-rust-first-campaign-to-completion.md` | The campaign's existing plan. K-items are proposed for its Part B; its Z3 criterion is otherwise unreachable |
| `2026-09-09-rust-first-fork-inversion-completion.md` | Fork subsystem; K12 continues it |
| `docs/future-improvements.md` | Two mmap entries (K7); fork `fm_*` and externref-scan items (K12) |
| `docs/agent-guidance/{abi,performance,validation}.md` | Binding for K2/K13, K7, and every item respectively |

## 2y. `host/src/constants.ts` — the census correction was right, its conclusion was not (2026-09-10)

Worktree `.claude/worktrees/agent-adc8321d66dfd6187`, base `67912d81e`.
No `ABI_VERSION` change; no new `env.host_*`; host imports still **75**.

The mid-campaign census reclassified `constants.ts` from KEEP to MIGRATE, and
that reclassification is correct: the file touches no host object, its input is
an `ArrayBuffer`, and it fails §2's first test outright.

**But the brief's model of *where* it should go was wrong, and so was mine.**
The item was framed as a pre-kernel / post-kernel split, on the assumption that
`extractAbiVersion` and `detectPtrWidth` on `kernel.wasm` are a bootstrap
paradox and everything else can ask a live kernel. Measured against call sites,
that line does not decide this file.

### The split, with the call sites that establish it

**Post-kernel — a kernel is provably up.** Each of these sits beside a kernel
call:

- `exec-target.ts:461` (`launchPreparedExecTarget`) calls
  `options.kernel.execTargetShebang(...)` on the same token ~15 lines above, and
  the kernel is already holding the exact bytes in
  `PreparedExecTarget.observed_bytes`.
- `node-kernel-worker-entry.ts:1017` passes `kernelWorker.getKernelAbiVersion()`
  *as the argument* to the policy call.
- `node-kernel-worker-entry.ts:1478` sits between `kernelWorker.createProcess()`
  (1473) and `kernelWorker.registerProcess()` (1487).
- `browser-kernel-worker-entry.ts` mirrors all three.

**Pre-kernel — a genuine floor, proven.**

- `kernel.ts:1588` `detectPtrWidth(wasmSnapshot)` inside `#compileKernelModule`,
  which needs the width to build the import object *before*
  `WebAssembly.compile`.
- `kernel-worker.ts:5406` `readWasmCustomSectionPayload(kernelWasmBuffer, …)`,
  whose own comment reads "before init compiles the bytes" and which sits on the
  line preceding `await this.#kernel.init(...)`.

**Neither — no kernel is reachable at all.** This is the category the brief did
not have, and it is the largest:

- `worker-main.ts:3219`, `dylink.ts:{1199,1306,1320}`,
  `fork-host-import-runtime.ts:447` and `wasm-module-reflection.ts` all run in
  the **process worker**, which holds no kernel instance. `dylink.ts` compares
  against the statically imported `ABI_VERSION`, never a live kernel's.
- `binary-resolver.ts:2888` runs in three contexts, one of which is
  `node-kernel-host.ts:1201` `loadKernelWasm` — the main thread, validating
  `kernel.wasm` itself before any kernel exists.

### Why that makes the file mostly undeletable *by a kernel export*

`describeWasmArtifactPolicyFailures` transitively reaches roughly 2,900 of the
3,031 lines: the fork-artifact facts reader, all nine descriptor validators, and
every generic section reader. **One pre-kernel caller keeps that whole graph
alive.** Migrating every post-kernel call site therefore deletes almost no
TypeScript — which is exactly what happened here.

**The destination has to be a standalone Rust wasm module, not a kernel export**
— the K5 `crates/dylink` shape, zero imports, instantiable in the process worker
and on the main thread *before* the kernel exists. That dissolves the bootstrap
paradox rather than working around it: a module with no imports is available
earlier than the kernel is. It is also the only destination that serves all
three categories at once.

### A real gap the survey found

**`handleSpawn` performs no kernel-side artifact policy check, on either host**
(`node-kernel-worker-entry.ts:1439-1566`, `browser:1439-1580`). Both the
embedder API (`NodeKernelHost.spawn`) and `spawnFromVfs`/`spawnFirstProcess`
reach it, so the first booted process is unvalidated until
`worker-main.ts:3219` runs — *after* the Worker is constructed and shared memory
handed over. `fork`/`vfork` children inherit that state, and
`centralizedThreadWorkerMain` checks nothing at all.

Consequently `worker-main.ts:3219` is **not** redundant and must not be deleted
before `handleSpawn` is fixed. It is also the **only** check anywhere that
verifies `expectedAbiContractDigest`: every kernel-worker-side call passes only
`{expectedAbi}`, so the contract-digest dimension is currently never checked on
any kernel-side path.

### Duplicated authority: it was three, not two

The census recorded two decoders of the `WPK_FORK_*` format. There are three.
`tools/xtask/src/build_deps.rs:14661 wasm_artifact_policy_failures_for` is a
native partial re-implementation used at build and publish time, alongside
`fork-instrument/src/contract_inventory.rs` and the TypeScript. They disagreed:
the TypeScript validated descriptor *bytes* the native pair never read, and the
native pair checked memory pointer-width agreement the TypeScript reached only
by another route.

`crates/wasm-artifact` is the single authority those three should share. It is
`no_std + alloc` (so the wasm32 kernel, `host-native` and the build tooling can
all link it) and it re-decodes no descriptor format: each of the six goes to the
`fork-codec` module that already owns it. Only the *cross-module* invariants —
joining a descriptor record to an import ordinal, a catalog export to a table
index — are new, because those are precisely what a descriptor decoder cannot
see.

### Two things the port fixed rather than preserved

- `constants.ts`'s `readULEB128` accumulates with JavaScript `|=`, which is a
  **32-bit signed** operation: a section length at or above 2^31 reads back
  negative. Its byte reads also run past the end of the buffer, where
  `undefined & 0x7f` is 0 and silently terminates the loop instead of failing.
  The Rust walk is `wasmparser`, bounds-checked, and correct against the spec
  rather than against today's artifacts.
- Failure messages named "ABI 43" as a literal while `ABI_VERSION` is 44. The
  Rust validators take the epoch from the caller, so a message names the epoch
  the artifact was actually measured against.

### What landed, and what it is worth

The exec path is cut over and the Rust runs:
`kernel_exec_target_artifact_policy` judges the target over
`exec_target::artifact_bytes`, and `host/src/exec-target.ts` no longer imports
from `constants.ts` at all. This costs nothing —
`PreparedExecTarget::new` already reserves the whole artifact and the host fills
it by reading *through* the kernel, so the removed arrangement was the more
expensive one: it read those bytes back out and parsed them again in JavaScript.

**`constants.ts` itself is unchanged, and the ledger step is not net-negative.**
Owner named: the residual needs the module destination above, which collides
with K5's in-flight `crates/dylink` module pipeline. See the
NEEDS-DEFER-DECISION below.

### The host import count is 76, not 75 — measured, not inherited

`docs/plans/2026-09-10-rust-first-campaign-status.md` records **75** in one
place and **84** in another, and briefs have been quoting 75. Measured on two
kernels built from this worktree — one at `67912d81e`, one at this item's tip —
the answer is **76 at both**, and the two import lists are byte-identical
(`comm` reports nothing on either side).

So this item's import delta is **zero**, which is the claim that matters. But
the baseline it was measured against was wrong by one, and the discrepancy is
explained by the campaign status' own note: K7's SysV cutover made
`env.host_debug_log` reachable and took the count up by one. The "75" line
predates that and was never corrected; the "84" line is a different, older
measurement. `env.host_debug_log` is present in both lists here.

**Fourteenth inherited number this campaign has had to re-measure.** The
standing lesson applies unchanged: a cutover's import delta is not visible in a
diff, so measure it on a built kernel before and after — and do not trust the
recorded baseline either.

### NEEDS-DEFER-DECISION (NDD-CONST-1) — the destination for the remaining ~2,900 lines

- **What.** Whether to build a second standalone Rust side-module pipeline for
  `crates/wasm-artifact`, fold it into the `crates/dylink` module K5 I6a is
  already building, or leave the pre-kernel and process-worker halves in
  TypeScript for this epoch.
- **Why it is not the agent's call.** K5 measured the module pipeline at 14
  integration points (build 3, freshness 2, projection 4, hosts 5) and is
  mid-flight on exactly that machinery. Opening a second one duplicates it;
  folding into K5's changes another item's scope. Both are sequencing decisions
  across items.
- **Cost now.** The 14 pipeline points, or a scope change to K5.
- **Cost later.** `constants.ts` stays at ~3,031 lines and the three-way
  duplicated authority stays three-way, with the TypeScript copy still running
  on the `handleSpawn` and `dlopen` paths.
- **Recommendation.** Fold into K5's module rather than open a second pipeline,
  and sequence it after K5 I6b lands. Separately and independently: fix the
  `handleSpawn` kernel-side gap, which is a real hole regardless of where the
  parser ends up.

