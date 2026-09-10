# Rust-first campaign — live status

**Purpose:** one file that answers "where are we" after a crash or context loss.
Update it as work lands. The reasoning lives in
`docs/plans/2026-09-09-rust-first-value-plan.md`; this is the index.

**Branch:** local `brandonpayton/rust-first-abi44-reconcile` → remote
`brandonpayton/epoll-kernel-route` (PR #1350). **Push forward-only. Never
amend, never force-push. The maintainer is the sole merger.**

**Last pushed:** `bb9fe63ec` (2026-09-10)

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
| K5 | **Rust landed 2026-09-10; NOT cut over** | See the correction below |
| K8 | **incr 1 done; incr 2 running** | Kernel parses a real VFS image; boot flip in progress |
| K3 | **0a/0b/1/2 done; epoll cutover owed** | `wait_queue.rs` + `wait_shadow.rs` dormant |
| K7 | **Rust landed; cutover RUNNING** | `SharedMappingTable`, 11 TS containers to delete |
| K12 | **DONE (scope corrected)** | GC elimination disproved; `fm_*` 72 → 70 |
| K11 | **PARTIAL** | 1 of 4 pieces landed; 2/3/4 need a second pass |
| K9 | **RUNNING** | Handle-only host contract, 83 → ~67 |
| K4 | **RUNNING** | Worker entry unification |
| K6, K13b | **NOT STARTED** | |

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
| K7 cutover | 11 containers in `kernel-worker.ts` | ~4,500 |
| K3-7.7 | epoll mirror in `kernel-worker.ts` | unmeasured |

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
