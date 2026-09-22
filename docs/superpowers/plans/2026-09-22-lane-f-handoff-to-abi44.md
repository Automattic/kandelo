# Lane F handoff: `brandonpayton/lane-f-fork-inversion` → ABI 44 batching branch

Written 2026-09-22 for the agent that merges this branch. It is a MAP, not a
narrative: what the branch contains, what must be rebuilt after merge, where
conflicts will be, and what the maintainer still has to rule on. The full
decision record is in the two SDD ledgers named at the end.

## Merge geometry

- Branch: `brandonpayton/lane-f-fork-inversion`
- Parent: `origin/brandonpayton/epoll-kernel-route`
- Merge base: `0eb0c2e1bc87f6728663c1f0afd51cad4bbd577f`. At writing the parent has not advanced past
  it (the PR #1350 head, whose worktree/ledger name is
  `rust-first-abi44-reconcile`), so the merge is a fast-forward and
  `git merge-tree` reports zero conflict hunks. Re-run
  `git merge-tree $(git merge-base HEAD <parent>) HEAD <parent>` before
  merging; if the parent has moved, the hotspots below are where conflicts
  will land.
- `origin` for this branch is stale at `161b7d6b9`; everything after is
  local-only until the maintainer pushes. Do not assume origin reflects HEAD.

## What the branch contains

**Change 2 — resume-thunk placement moved from JavaScript into wasm** (7
tasks, each reviewed). Host TypeScript net −56 lines. ABI 44 gained a
required guest export, `__wpk_fork_place_resume_thunks`, in
`WPK_FORK_REQUIRED_EXPORTS`; `abi/snapshot.json` moved by exactly one
`required_exports` entry. **ABI_VERSION stays 44** (unreleased; no bump).

**Change 3 — fork-module fixed BSS converted to on-demand chunks** (13 tasks;
1–11 committed one-commit-each; 12–13 = the test batch + measured record,
PENDING at writing). Measured: `regionBytes` 3,801,088 → 1,376,256, 54 → 18
pages, −2,424,832 bytes per fork-capable thread's mmap window.

Plus fixes found on the way, each its own commit: a live use-after-free in
the vfork child's teardown (`47f2decea`); host-native fixture provisioning
that had never worked (`c8789ac27`); msmtpd shipping an un-instrumented
guest (`c82a4e25b`); the artifact-gate skip announcement that never printed
(`161b7d6b9`).

## MUST REBUILD after merge — wasm is never committed

Every package artifact must be rebuilt through the normal path: the new
required export invalidates every fork-instrumented guest, and stale ones
fail loudly at process start. `./run.sh setup` re-projects; then
`cargo xtask verify-fresh` must exit 0. Known trap: `packages/registry/*/bin/`
is gitignored, so a long-lived worktree can carry a stale prebuilt that a
fresh clone never has (msmtpd was exactly this). Also `local-binaries/*.wasm`
symlinks into `.kandelo-local-generations/` are shadowed residue that
`verify-fresh` flags; repoint or remove them.

## Conflict hotspots (largest diffs vs `161b7d6b9`)

`crates/fork-module/src/lib.rs` (+3.8k lines net: the whole conversion),
`crates/host-native/src/guest.rs`, `host/src/worker-main.ts`,
`host/test/fork-module-capture-fixture.ts`, `docs/surface-budget.json`
(ceilings banked down; two +13 raises in the UAF fix with targets HELD),
`abi/snapshot.json` (+1 entry), `crates/shared/src/lib.rs` (the export list
and its pinned count 28 → 29). Prefer this branch's side for all of these;
they are the deliverable.

## Test baseline the merger should expect

- Full fork sweep: `cd host && npx vitest run test/fork- test/vfork-` —
  **81 files** (both prefixes needed; `test/fork-` alone misses every
  `vfork-` file). Only `fork-host-import-runtime`'s two tests fail; they are
  in the 64-file `host/test/expected-failures.json` baseline.
- `cargo test -p host-native --target aarch64-apple-darwin`: 8 pre-existing
  fork-reference failures, all trapping in `__wpk_fork_ref_gc_allocate`.
- A hung sweep = a crashed guest OR a harness with no responder; the tell is
  a SHORT FILE COUNT in the summary, not the last line printed.
- `K-03` in `fork-instrument-coverage` sits 1.5s under a 10s budget; it
  fails above ~18% machine slowdown. Contention, not a defect.

## Open for the MAINTAINER (not the merger)

1. Push authorization (never granted this session).
2. Surface-budget raises: Change 2's 72/59/3 (third returned to 2), the UAF
   fix's two +13 with targets held — see `why` fields.
3. Behaviour change: a vfork whose chained scratch exceeds one page now
   returns EAGAIN where it used to trap (Node/browser; native cannot see
   it — a pre-existing parity boundary).
4. Direction call made in your absence: host-invoked placement over
   module-driven (Task 3 of Change 2); its third supporting fact was false.
5. The plan's 17-page endpoint is not reachable by storage work; the 1 MiB
   shadow stack now dominates 12:1. Task 13's record says so.

## PENDING at writing (filled in when the batch lands)

- Task 12: batch verdict, red list, unproven guards by name.
- Task 13: final ledger row, selftest deletion and its three ceilings,
  remaining-static composition.
- End-of-change browser + conformance run.

## Where the record lives

- `.superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/progress.md`
  (Change 2 and the cross-change rulings)
- `.superpowers/sdd/2026-09-21-fork-storage-conversion/progress.md` (Change 3)
- Reviews: `change3-tasks1-7-review.md`, `change3-tasks8-11-review.md`
Both ledgers are gitignored scratch; copy what you need before the workspace
is deleted at plan close.
