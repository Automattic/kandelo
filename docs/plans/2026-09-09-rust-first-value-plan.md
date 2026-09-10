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

### Outstanding deletion debt

| owed by | removes | why deferred |
|---|---|---|
| **K1 step 5** | the JSON `entries[]` path (~2,000+ across `memory-fs.ts`/`sharedfs-vendor.ts` once the stamp goes) | needs its own ABI ruling (§2c item 3); **completes V3** |
| **K10 I6** | `host/src/wasi-shim.ts`, 1,625 | fixtures cannot exercise a real wasi-libc guest (§2h) |
| **K5 I7** | `host/src/dylink.ts` + `dylink-fork-archive.ts`, **6,340** | the Rust planner landed first; executors and native `dlopen` follow (§2p) |

Both deferrals were correct. Neither is done until the owner item lands.

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

## 2p. K5 — COMPLETE (2026-09-09)

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

| concept | now | target | why the target is right |
|---|---|---|---|
| file **names** + metadata | **25** | **0** | the host must open a file; it must never resolve a name. Rust already resolves namespace paths (`syscalls.rs:2075`) |
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
| **total** | **85** | **≈31** | ~8 of which are device surface |

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
| **K9** | **Handle-only host contract** — remove all 25 name-taking imports | **V4** | The largest single V4 movement, in both count and concept |

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
