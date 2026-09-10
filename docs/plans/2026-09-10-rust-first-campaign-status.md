# Rust-first campaign — live status

**Purpose:** one file that answers "where are we" after a crash or context loss.
Update it as work lands. The reasoning lives in
`docs/plans/2026-09-09-rust-first-value-plan.md`; this is the index.

**Branch:** local `brandonpayton/rust-first-abi44-reconcile` → remote
`brandonpayton/epoll-kernel-route` (PR #1350). **Push forward-only. Never
amend, never force-push. The maintainer is the sole merger.**

**Last pushed:** (see git) (2026-09-10)

## Ledger — the number that judges this campaign

`9638a2023..bb9fe63ec`: in-scope TS **+474** (890 added / 416 removed),
Rust **+21,211** (16,678 production / 4,533 test).

**TypeScript is still net POSITIVE. That is the campaign's central open risk.**
If work stopped now the repo would be strictly worse than at the start: the same
TypeScript, plus a large parallel Rust implementation. All the value is
backloaded into cutovers.

Measure with `scripts/migration-ledger.sh --step <base> <tip>`. It is a
measurement, not a gate; line count is a poor metric but a useful hint.

## The rule that governs everything from 2026-09-10

**Cutover is part of the item.** An item is done when the Rust *runs* and the
superseded TypeScript is *deleted*. Landing tested-but-dormant Rust is a failed
item, not a partial success.

Agents work in separate git worktrees, so two agents editing
`crates/kernel/src/wasm_api.rs` (the repo's only export surface, ~308 exports)
is a **merge** problem, not a correctness problem. Do not contort a change to
avoid a contested file. The coordinator resolves at merge.

## Standing constraints

- **ABI 44 for the whole campaign. No further `ABI_VERSION` bumps.** Regenerate
  `abi/snapshot.json` only; a gate complaining the snapshot moved without a bump
  is expected within the epoch — report it, never silence it.
- **Never self-defer.** Land the safe part, then report NEEDS-DEFER-DECISION
  with what / why / cost-now / cost-later / recommendation. Deferrals are the
  maintainer's call.
- **Generic-first (BINDING).** Kandelo is a generically applicable POSIX kernel.
  Never shape behaviour to what today's packages or demos exercise.
- **Browser validation:** one consolidated pass at the end of Tier 2 and again
  after Tier 3, plus the maintainer's own manual check of the web app before
  merge. Agents state what is unproven instead of fighting provisioning.
- **Curation is on hold** — the maintainer wants to cross-examine the work and
  the repo state before agreeing a curated commit set. Do not squash.

## Status by item

| Item | State | Notes |
|---|---|---|
| K0 probes | **DONE** | Disproved the E1 GC blockers and the V8 `epoll_pwait` crash |
| K13a | **DONE** | Dead export deletion |
| K1 / K1b | **DONE** (step 5 owed) | JSON + ABI stamp completes V3 |
| K10 | **PARTIAL** | I1/I2/I3/I7 landed; I6 (`wasi-shim.ts`, 1,649) owed; I4/I5 browser cutover owed |
| K14 | **DONE** | |
| K5 | **Rust landed 2026-09-10; NOT cut over** | Placement adjudicated; re-cut as I6a + I6b. See the correction below |
| K8 | **incr 1 done; incr 2 running** | Kernel parses a real VFS image; boot flip in progress |
| K3 | **0a/0b/1/2 done; epoll cutover owed** | `wait_queue.rs` + `wait_shadow.rs` dormant |
| K7 | **Rust landed; cutover MIS-SCOPED — re-cut into 3** | See "K7 cutover" below |
| K12 | **DONE (scope corrected)** | GC elimination disproved; `fm_*` 72 → 70 |
| K11 | **PARTIAL** | 1 of 4 landed; 2/3/4 need a second pass (now unblocked) |
| K9 | **RUNNING** | Handle-only host contract, 83 → ~67 |
| K4 | **RUNNING** | Worker entry unification |
| K6 | **RUNNING** | Marshalling: SysV IPC, mqueue, sendmsg/recvmsg, ifconf |
| K13b | **NOT STARTED** | Export cull |

## Host import surface

**83**, measured on a freshly built kernel (`wasm-objdump -x
local-binaries/kernel.wasm | grep -o "env\.host_[a-z_0-9]*" | sort -u | wc -l`).
84 → 85 (K8's `host_image_read`) → 83 (K3 0b removed two dead ones).

**One new import is sanctioned**, gated on measurement: cross-memory
`host_proc_compare_bytes`, the third member of the read/write family. See §2w of
the value plan for why it protects the abstraction.

## CORRECTION — K5 was recorded as COMPLETE and was not

§2p of the value plan claimed "K5 — COMPLETE … `cargo test -p dylink` 72/72".
**Only the docs commit had been cherry-picked onto the branch. `crates/dylink`
did not exist here at all**; the code sat in the agent's worktree. The tests
genuinely passed — in a tree that was never merged.

Found on 2026-09-10 by the K5-I7 agent, which could not cut over to a crate that
was not present. Fixed the same day: nine commits merged
(`f622651b1`…`ababb6eee`), `cargo test -p dylink` green on the branch.

**Coordinator error, and the lesson generalizes: recording an outcome is not
landing it.** After every agent merge, verify the *artifact* exists on the
branch — not just that a docs commit describing it does.

## Deletion debt — every line here is owed, with an owner

| Owner | Target | Lines |
|---|---|---|
| K5 I6a/I6b | `dylink.ts` + `dylink-fork-archive.ts` | 6,340 |
| K10 I6 | `wasi-shim.ts` | 1,649 |
| K8 i2 | `vfs/rootfs-manifest.ts` | 354 |
| K7 re-cut (1) | SysV half of `kernel-worker.ts` | ~263 |
| K7 re-cut (2,3) | rest of the mapping subsystem | ~3,300 |
| K3-7.7 | epoll mirror in `kernel-worker.ts` | unmeasured |

## K7 cutover — mis-scoped, and the finding is worth more than the item

The cutover agent could not delete the TypeScript, and this is **not** a
deferral: the deletion is not performable as scoped.

`SharedMappingTable` covers about two thirds of the ~3,600-line TypeScript
subsystem. **~1,203 lines have no Rust counterpart at all:**
`handleSharedMappingsAfterFileSyscall` and its per-syscall range policy, the
pre-syscall flush, `findSharedMmapBackingForFd` + `sharedMmapFdCache`, the
path-keyed lookups, the `reload*` family, and the mmap-from-file registration
path. That code opens by reading the very containers the cutover was meant to
delete, and it implements POSIX `MAP_SHARED` fd/mapping coherence, so it can be
neither deleted nor dropped. **Wiring entry points could never have finished
this cutover.**

It is a **dispatch/policy gap, not a primitive gap** — `invalidate_range`,
`flush_range`, `revalidate` and `ensure_range_loaded` all exist.

**Why it was missed:** the cutover contract written on `SharedMappingTable` was
accurate about what it did and *silent* about what it did not. **Silence in a
work contract reads as completeness.** Three concrete errors were corrected in
place: `process_memory_len` is a sixth host-sourced value but an *entry-point
argument*, not an import (the host grows guest memory after the kernel returns
from `mmap`, so it already holds the value); `retain_handle`/fd-writeback were
described as existing and did not, and now refuse with `ENOSYS` rather than
hand out a handle the kernel may close; and the perf note left the copy
unbounded.

**The performance doubt is narrower than filed.** Both Rust and TypeScript skip
a mapping whose backing has `ref_count <= 1` and is not stale, so the copy is
confined to a large writable `MAP_SHARED` **with a live peer**. A general
syscall benchmark exercises only the early-out — a true result that says
nothing about the copy. Closing this needs a *targeted* shared-mapping
benchmark, not a general suite. **`host_proc_compare_bytes` was therefore not
needed and not added**; the sanctioned import remains unspent.

**Re-cut as three items:**
1. **SysV half, now** — separable, complete, ~263 TypeScript lines, two
   containers, and the one part with a performance *gain*. Design the boundary
   early-out trap first: `shmMappings.size` is half a predicate the host would
   otherwise lose.
2. **Write the coherence layer in Rust**, sized as policy rather than as
   plumbing.
3. **Anon + file cutover**, gated on that targeted benchmark.

## In-scope test failures — coordinator owns these

| Failure | State |
|---|---|
| `zip::real_man_zip_cross_checks_members` | **FIXED** — asserted a locally built binary's byte count; now asserts the archive's own `uncompressed_size`, which is strictly stronger |
| `kernel-scratch-contract` — pointer-role | **FIXED** — `kernel_spawn_blob_decode` used `buf_cap`; the repo uses `_capacity` 13× and `_len` 74×, so the guard was right and the code had drifted |
| `kernel-scratch-contract` — spawn symbols | **FIXED** — the guard demanded the host reference spawn limits the kernel owns under ABI 44; satisfying it would have pushed an authority back out of the kernel to make a test pass |
| `kernel-scratch-contract` — unreviewed memory authority | **53 → 16**, see below |
| `vfs-image-wasm-policy` | **NOT STARTED** |

### The unreviewed-memory-authority guard: 53 → 16, and why the rest waits

Two genuine scope gaps accounted for 37 of the 53, and neither fix weakens the
guard:

- `isOrdinaryTestHarness` matched `/test/`, the TypeScript layout. Rust crates
  use Cargo's `tests/`, and the `.mts` generators that build their `.wasm`
  inputs sit in `testdata/`. Those are test infrastructure by exactly the same
  argument as `host/test/`; the match missed them purely on directory spelling.
  Recognizing both applies **one rule across two language conventions** rather
  than granting Rust an exemption.
- Probe harnesses under `docs/plans/probes/` are recorded measurements, not
  runtime sources. They are run by hand to prove or disprove a claim about an
  engine and never enter the product. Auditing them made the contract depend on
  which experiments happened to be committed.

`wasm-memory-write-audit.test.ts`, which shares the scope function, still passes
87/87 — the narrowing did not blind it.

**The remaining 16 are real and are all in `host/src`**: K8's `loadImage`
direct export use, the spawn-blob decode scratch leases, the opaque-transport
`#handleRecordSyscall` leases, the `host_image_read` destination factory calls,
and fork-module/trampoline instantiation. Each is a new view into kernel memory
created by this campaign, and the guard is correctly demanding review of each.

**Deliberately deferred to the tier-end reconciliation, not forgotten.** Those
sites live in `kernel-worker.ts` and `kernel.ts`, which K9, K4 and K8-i2 are
actively rewriting. Reviewing and allowlisting them now guarantees doing it
twice. **Owner: coordinator, at the end of Tier 2.**

## Open decisions for the maintainer

1. K3 §11.2 `usePolling` deletion.
2. K3 §11.3 two epoll POSIX gaps — interest-list inheritance across `fork`, OFD
   keying. Ruling: **fix if straightforward, else log explicitly and defer.**
3. K11's second pass over pieces 2/3/4 (~2,300 lines) — now unblocked by the
   worktree ruling.
4. K5's remaining cutover shape (I6a module + 14 pipeline points, I6b rewire +
   delete). **Placement is already adjudicated — do not re-derive it.**

## Standing instruction for the end of the campaign

When every tier closes, **do not stop**: run a fresh census over the same scope
and ask again what should be migrated, reduced, or removed — then start on
whatever it finds. The maintainer asked for this explicitly on 2026-09-10.

## Traps this campaign has already paid for

- **`cargo run -p xtask` needs a host target** or it builds xtask for wasm32 and
  dies in `zstd-sys`/`ring`. Use `scripts/xtask.sh`.
- **`./run.sh rebuild kernel` does NOT repoint ambient
  `local-binaries/kernel.wasm`.** Install it with `build-deps …
  install-local-artifact` (needs `WASM_POSIX_LOCAL_INSTALL_SOURCE` **and**
  `WASM_POSIX_LOCAL_INSTALL_SESSION`).
- **Run Vitest inside `./scripts/dev-shell.sh`** or the SDK is absent from PATH
  and ~80 unrelated failures appear.
- **A base reproduction shows authorship, not innocence** — a defect may have
  entered hours earlier. One of the coordinator's own was caught this way.
- **Never `git add -A docs/plans/`** — it sweeps other agents' in-progress files.
- **Twelve inherited "floors" have been disproved, six of them the
  coordinator's.** Measure rather than inherit.
