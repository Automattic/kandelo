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

**Therefore:** the 2026-09-04 E1 probe's two GC blockers are dissolved.
Provenance does not need recording because it is recoverable by casting.
`ForkGcProvenanceRegistry` is eliminable. **`resolve_externref` (handle →
canonical host externref) is the single genuine fork reference floor**, and
it is irreducible because the value is a host object.

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

Both deferrals were correct. Neither is done until the owner item lands.

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
| **K5** | **Dynamic linker → Rust** (`dylink*.ts` 6,340 + `worker-main.ts` pieces) | **V1**, **V2**, V4 | A full `ld.so` in TS. Host-native has no linker at all, so this *gains* native `dlopen` rather than relocating it. Also removes hand-maintained wasm32/wasm64 offset pairs and TS wasm binary rewriting |
| **K3** | **Blocking scheduler → Rust** (~4,500 lines, 21 state containers) | V1, **V2**, V4 | Keystone: signals, IPC blocking, and process-wait all collapse into it. Removes the epoll mirror. Highest risk in the campaign — every historical hang lives here |
| **K8** | **VFS runtime authority → Rust** (~12,000 lines) | **V3**, V1, V2 | Retires `memory-fs.ts`/`sharedfs-vendor.ts` as readers; in-kernel shmfs for `/dev/shm`; drops the image ABI stamp. Completes V3 |
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
