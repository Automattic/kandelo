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
  85 files at the batch's measurement (both prefixes needed; `test/fork-`
  alone misses every `vfork-` file). Every fork file is now expected
  green; `host/test/expected-failures.json` held 63 files at the lane's
  fork, none of them fork tests. (Lane F later banked 28 of them as
  restored, in e9ad4cdb3; that banking did not come across, because this
  branch's baseline was curated separately and lists 31 files as of
  2026-10-02.)
- The full-suite ratchet, `cd host && node test/suite-baseline.mjs`, must
  print `RATCHET_EXIT=0` on the merged tree after `./run.sh setup`. On lane
  F's final run it printed 1 with NO `UNBANKED:` list and three
  non-banked reds: `posix-utils-lite/process-tools` (contention, green
  alone) and `curl`/`php-concurrent-sqlite` (intermittent; green in three
  other runs; `docs/future-improvements.md` has the evidence). Not Change
  3's: both fail identically on the pre-Change-3 kernel in the same state.
- `cargo test -p host-native --target aarch64-apple-darwin`: 8 pre-existing
  fork-reference failures, all trapping in `__wpk_fork_ref_gc_allocate`.
- A hung sweep = a crashed guest OR a harness with no responder; the tell is
  a SHORT FILE COUNT in the summary, not the last line printed.
- `K-03` in `fork-instrument-coverage` sits 1.5s under a 10s budget; it
  fails above ~18% machine slowdown. Contention, not a defect.

> **Scope (added 2026-10-02 when porting this record to the integration
> branch):** this section and "Tasks 12 and 13" below were measured on
> `brandonpayton/lane-f-fork-inversion` (at `75fd2ce3f` and `e9ad4cdb3`),
> commits that never merged here; the commits they cite before 39107aef7
> are in this branch's history. Three statements are lane-F-only: the
> `fm_set_format` refusal of a zero channel base with live mappings (F4)
> is NOT in this branch's fork module; the K-03 budget change was ported
> separately; and the 18-page endpoint and the `RESUME_ASSIGNMENT` static
> are superseded here (see the SINCE notes in
> `docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`). The
> setup/stale-`kernel.wasm` finding no longer applies here; the other
> findings are in `docs/future-improvements.md`.

## End-of-change validation (2026-09-23, at `e9ad4cdb3`): PASS-WITH-FINDINGS

Full report: `.superpowers/sdd/2026-09-21-fork-storage-conversion/change3-validation-report.md`
(gitignored scratch; copy it if you need it after the workspace closes).

| suite | Change 2 baseline | Change 3 |
|---|---|---|
| posix (Node) | 174 / 0 | 174 / 0 |
| libc | 300 / 3 | 300 / 3, same names |
| sortix `--all` | 5052 / 8 / 2 timeouts | 5053 / 8 / 1 timeout, same 8 |
| host-native | 71 / 8 / 4 | 71 / 8 / 4, same 8 ("pump timed out") |
| browser posix | — | 163 / 0, 10 XPASS (stale expected list) |

Browser shell (Chromium): login, `ls /` exact, `FORKSUM_X:55`,
`FORKEXEC_BINCOUNT:206`, `NESTED_FORK:abcd`, zero console errors.
Placement baseline md5 `3f218130f68068a3a6941725dd241d7b` start and end.

Findings the merger should know (all recorded in
`docs/future-improvements.md`): `./run.sh setup` exited 0 with a STALE
`kernel.wasm` symlink and only `verify-fresh` caught it — run
`verify-fresh` after every setup and repoint; the Node conformance runners
need `CC_aarch64_apple_darwin`/`HOST_CC` on a cold cargo cache; invoke
`run-posix-tests.sh` as `bash scripts/...` (its shebang picks bash 3.2);
`sigaltstack/9-1` is the one Node/browser divergence.

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
6. FIXED on this branch (was banked before it): `fork-host-import-runtime`
   is off the expected-failures baseline (64 -> 63 files). Its two red
   cases were test defects: a shared prefix on a concrete type index,
   which the shared-everything-threads grammar does not allow
   (`heaptype ::= 0x65 ht:absheaptype`), and an assertion that the reader
   preserve `(ref null extern)` verbatim when `facts.rs` documents it
   canonicalizes to `externref`. The reader was right both times. No
   shipping runtime implements shared reference types today (V8
   flag-only, no Firefox/Safari signal, wasmtime "unimplemented").

## Tasks 12 and 13: the batch and the measured record (landed 2026-09-22)

**Task 12 (the test batch).** Every proof deferred by Tasks 1-11 ran or is
named unproven below. Serial fork sweep (`test/fork- test/vfork-`, 85
files): green. A forced-chunk build (`ARENA_CHUNK_BYTES = 4_096`) chained
the record arena (field 101) and the scratch chain (field 104) and found
no module defect; three test-arithmetic drifts it exposed are fixed
(`39107aef7`). Full suite in both builds: 448 files. The GC-codec COW
exclusion is retired with proof it was dead (`eae66a84b`). The vfork
EAGAIN behaviour is pinned on Node only (native cannot reach it).

Two regressions the batch caught, both fixed in-range and both worth
knowing when bisecting:
- `dd3f54657` (Task 10) broke EVERY native fork launch for two commits
  ("fork-module stack top ... is not 16-byte aligned") until `99ee3c88e`
  aligned the region base to 16. Do not bisect native across that pair.
- `660e977df` (Task 6) shrank the region enough that `malloc-deep-fork`'s
  "genuine OOM" case fit inside a 40 MiB budget; `8f51d8f1f` recalibrates
  it to 32 MiB with the derivation.

**Task 13 (the record).** `fm_arena_selftest` deleted; the three budget
ceilings banked to 71/58/2. Measured endpoint: `regionBytes` **1,376,256
= 18 pages + 196,608 slab**, static 88,728 bytes (align 8); cumulative
**-2,424,832 bytes, 54 -> 18 pages**. The 23,192 bytes between here and
17 pages are ONE static: `RESUME_ASSIGNMENT`, Change 2's 65,536-byte
publish buffer (the rest is 21,204 `.data`, 1,544 `.rodata`, <500 of
roots). The 1 MiB shadow stack dominates at 11.8:1; the plan's 17-page
endpoint is a `RESUME_ASSIGNMENT` decision (its 8,192-record floor), not
storage work. F4 decided: a release with no channel base is REFUSED, not
silently leaked.

**Unproven guards, by name** (green in every run, never forced red):
`begin_capture_impl`'s reset ordering (no perturbation can open the
window); the SIGKILL-contained vfork teardown's `channel_munmap`
mechanism; `carve_borrowed_prefix`'s two guards (vfork e2e only); native
reuse of retained chunks across vforks (native cannot run a second vfork
from one parent — pre-existing).

**Review findings still open (both LOW):** staging-capacity measures
artifact-sized seeds only, the runtime-sized externref handover is
unmeasured (review 1-7 F5); Task 6's replace leaves a half-state when the
re-register fails and swallows the UAF detector on that path (F7).

**Batch concerns for the maintainer:** `host/dist` freshness is ungated
(a test routed through `worker-adapter` runs whatever the bundle holds);
the borrowed child's failure-path region leak (`worker-main.ts:4151`) is
pre-existing and open; load from other workspaces (up to 229) made every
timing test unreliable — each load-attributed red was re-run alone at
load <= 12 before being called load.

## Where the record lives

- `.superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/progress.md`
  (Change 2 and the cross-change rulings)
- `.superpowers/sdd/2026-09-21-fork-storage-conversion/progress.md` (Change 3)
- Reviews: `change3-tasks1-7-review.md`, `change3-tasks8-11-review.md`
Both ledgers are gitignored scratch; copy what you need before the workspace
is deleted at plan close.
