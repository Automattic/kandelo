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
