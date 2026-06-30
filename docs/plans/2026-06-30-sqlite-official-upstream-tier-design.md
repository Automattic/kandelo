# SQLite Official Upstream Tier Design

Date: 2026-06-30

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-1mr.2` - Port sqlite, bzip2, and xz Homebrew pilot.
- `kd-1mr.2.4` - Scope SQLite official upstream harness for Kandelo runtime.
- Source evidence: `kd-1mr.2` commit `440ac7e5e`, plus its
  `test-runs/kd-1mr.2/sqlite-upstream/` artifacts.

This is a design artifact. It does not implement new runners, change package
artifacts, publish bottles, or claim a new SQLite upstream-test tier has passed.

## Problem Statement

The sqlite/bzip2/xz Homebrew pilot proved the SQLite library bottle can be built
locally, poured into a Homebrew-derived VFS image, and consumed by a small
`sqlite_basic` program on the Node host. It also proved that SQLite's official
`testrunner.tcl` can start under Kandelo once the rootfs provides `/bin/sh`, but
the official `veryquick` permutation is not a practical default package gate.

Evidence from `kd-1mr.2`:

- SQLite fixture smoke: 17 passed, 0 failed, 0 skipped.
- Homebrew SQLite Node smoke: 2 passed, 0 failed, 0 skipped.
- Official `veryquick` before rootfs: failed before executing jobs because
  `sh` was unavailable; 1 harness failure and 1183 incomplete jobs were
  recorded.
- Official `veryquick` after rootfs: built 1183 jobs, completed 4 jobs with
  zero errors in about 65 seconds, left 1 running job and 1179 incomplete jobs,
  and projected multiple hours.
- Older SQLite project-unit evidence shows `full` and `all` permutations are
  larger still: `full` had 1393 to 1394 jobs and exposed separate Node and
  browser blockers; `all --explain` planned more than 10,000 jobs per host.

Kandelo needs a durable upstream-test status model that records useful SQLite
official-test signal without turning a multi-hour upstream suite into the
default Homebrew bottle gate or hiding runtime defects behind package-specific
shortcuts.

## Non-Goals

- Do not make SQLite official `veryquick`, `full`, or `all` success a default
  Homebrew bottle publication gate.
- Do not replace SQL fixture smoke or the Homebrew `sqlite_basic` consumer
  smoke. Those remain the practical bottle/runtime smoke layer.
- Do not patch SQLite tests to fit Kandelo unless the patch documents an
  upstream portability boundary rather than a Kandelo platform defect.
- Do not mark browser compatibility from Node official-test results.
- Do not revive Asyncify or accept stale SQLite/Testfixture artifacts.
- Do not bump `packages/registry/sqlite/build.toml` revision unless output
  bytes legitimately change.
- Do not hand-edit release indexes or treat local dry-run artifacts as trusted
  GHCR/tap publication.

## Users And Operator Workflows

### Package Porter

The porter needs a small command that can be run during the Homebrew SQLite
pilot without blocking for hours. The command should exercise SQLite's official
runner path, emit complete outcome lists, and leave clear artifacts when the
official harness is incomplete.

### Runtime Debugger

The debugger needs job-level evidence that distinguishes SQLite failures from
Kandelo platform failures: shell availability, `exec` resolution, process worker
lifecycle, VFS persistence, fault/crash behavior, threading, collation, and
browser page stability should be visible as separate failure classes.

### Maintainer Reviewer

The reviewer needs truthful status language. A passing tiny official subset is
useful upstream signal, but it is not a full SQLite upstream certification. A
long-run interruption should be reported as incomplete with a complete job list,
not as success or failure of jobs that never ran.

### Trusted Publisher

The publisher can include upstream-test metadata in Homebrew sidecars and
provenance, but bottle availability should be decided by build, Formula test,
sidecar validation, VFS materialization, and Node/browser smoke status. Upstream
official tiers are package-status metadata unless a later policy explicitly
promotes one tier to a gate.

### Browser Operator

The browser operator needs a separate status path. Today's official browser
harness exists for the registry SQLite test VFS, but the Homebrew pilot does not
yet have a generic non-hello browser smoke path or a Homebrew-derived official
SQLite browser image. Browser upstream-test status should therefore remain
`unsupported/deferred` for Homebrew SQLite until a focused browser follow-up
lands. Existing follow-up `kd-1mr.2.1` covers the generic non-hello Homebrew
browser smoke foundation.

## Proposed Tier Model

Use explicit tier names instead of overloaded words like "quick" or "full".
Each tier records host, permutation, selected jobs, timeout, result semantics,
and whether it is a gate.

### Tier 0: `sqlite-official-smoke-v1`

Purpose: a small deterministic official-runner smoke for the Homebrew SQLite
pilot.

Host policy:

- Required first host: Node.
- Browser status: deferred until the Homebrew browser smoke follow-up can boot
  a Homebrew-derived SQLite validation image.

Command shape:

```bash
bash scripts/dev-shell.sh bash scripts/run-sqlite-official-tier.sh \
  --tier sqlite-official-smoke-v1 \
  --host node \
  --results-root test-runs/<bead>/sqlite-official-smoke-v1-node
```

Initial job allowlist, all selected from jobs that completed with zero errors
in the `kd-1mr.2` after-rootfs run:

```text
ext/fts5/test/fts5optimize3.test
ext/fts5/test/fts5optimize2.test
test/walvfs.test
test/win32lock.test
```

Gate status: not a bottle gate. It is required package-status evidence for the
SQLite Homebrew pilot once implemented. A failure blocks the claim "official
smoke tier passed"; it does not by itself prove the SQLite bottle is unusable.

Timeout: start with 10 minutes on Node. The observed after-rootfs run completed
these four jobs in about 65 seconds, but the tier should allow enough margin
for clean worktrees and slower runners.

Outcome semantics:

- All selected jobs done with `nerr=0`: tier passes.
- Any selected job `failed`: tier fails and records the complete failure list.
- Timeout or interrupted run: tier is incomplete and records all selected jobs
  not done, including the running job when available.
- Harness setup failure, such as missing `/bin/sh`, is a harness failure and
  all planned jobs are incomplete with the same setup reason.

### Tier 1: `sqlite-official-veryquick-shards-v1`

Purpose: periodic or convoy-scale coverage of the full official `veryquick`
permutation without a single multi-hour unbounded job.

Command shape:

```bash
bash scripts/dev-shell.sh bash scripts/run-sqlite-official-tier.sh \
  --tier sqlite-official-veryquick-shards-v1 \
  --host node \
  --shard <n>/<total> \
  --timeout-ms 1800000 \
  --results-root test-runs/<bead>/sqlite-official-veryquick-shard-<n>
```

Implementation policy:

- Build the job list with `scripts/run-sqlite-official-tests.sh --explain`.
- Persist the planned job list before running so the incomplete list can include
  jobs that never entered `testrunner.db`.
- Sort by SQLite job id, then split into deterministic shards.
- Each shard runs an explicit allowlist of test files instead of relying on a
  mutable upstream scheduler order.
- Start with Node only. Browser shards wait for a separate browser capability
  bead because older evidence shows browser full runs expose page reload and
  runtime-stability blockers that are independent of SQLite library packaging.

Gate status: not a default package gate. It is a scheduled or convoy tier for
upstream conformance status and regression discovery.

### Tier 2: `sqlite-official-full-investigation-v1`

Purpose: long-run investigation for `full` and later `all`, used only when a
specific SQLite/platform campaign needs it.

Command shape:

```bash
bash scripts/dev-shell.sh bash scripts/run-sqlite-project-unit-tests.sh \
  --host node \
  --permutation full \
  --jobs 2 \
  --timeout-ms 21600000 \
  --results-root test-runs/<bead>/sqlite-official-full-node
```

Gate status: never a Homebrew bottle gate without a later policy decision.
Failures create or update focused debugging beads by failure class.

## Architecture And Data Flow

Keep the existing official harness as the execution engine:

```text
Tier manifest
  packages/registry/sqlite/test/official-tiers.toml
        |
        v
scripts/run-sqlite-official-tier.sh
  validates prerequisites
  expands tier/shard to explicit test list
        |
        v
scripts/run-sqlite-official-tests.sh
  Node: examples/run-example.ts + testfixture.wasm
  Browser: delegates to browser runner only for supported tiers
        |
        v
testrunner.db, testrunner.log, summary.txt
        |
        v
outcome exporter
  passed-tests.tsv
  failed-tests.tsv
  skipped-tests.tsv
  incomplete-tests.tsv
  summary.json
  combined-summary.md
        |
        v
Homebrew sidecar/provenance package-status metadata
```

The tier manifest should be data, not shell conditionals. A TOML shape keeps it
reviewable:

```toml
[[tiers]]
name = "sqlite-official-smoke-v1"
permutation = "veryquick"
hosts = ["node"]
timeout_ms = 600000
gate = false
description = "Small deterministic official-runner smoke for Homebrew SQLite."
tests = [
  "ext/fts5/test/fts5optimize3.test",
  "ext/fts5/test/fts5optimize2.test",
  "test/walvfs.test",
  "test/win32lock.test",
]

[[tiers]]
name = "sqlite-official-veryquick-shards-v1"
permutation = "veryquick"
hosts = ["node"]
timeout_ms = 1800000
gate = false
sharded = true
```

The exporter should read `testrunner.db` when present and fall back to planned
job files plus runner stderr/stdout when the harness fails before creating a
usable database. Each outcome row should include enough data for triage:

```text
test    jobid    state    displaytype    cases    errors    duration_ms    reason_or_error
```

For compatibility with existing Gas City outcome-list expectations, also keep
the simple current filenames:

- `outcome-lists/passed-tests.tsv`
- `outcome-lists/failed-tests.tsv`
- `outcome-lists/skipped-tests.tsv`
- `outcome-lists/incomplete-tests.tsv`

Skipped and incomplete are different categories. SQLite `omit` jobs map to
skipped with SQLite's reason when available. Jobs not reached because of
timeout, interruption, setup failure, or unsupported host map to incomplete.

## Host Treatment

Node is the first required host because `kd-1mr.2` official evidence came from
Node and because the Homebrew SQLite Node smoke already passed.

Browser is a peer host but not the same feature:

- Existing browser official tooling boots `apps/browser-demos/pages/sqlite-test`
  with a registry-built SQLite test VFS.
- The Homebrew pilot needs a generic non-hello browser smoke path before it can
  claim browser support for a Homebrew-derived SQLite bottle.
- Therefore `sqlite-official-smoke-v1` should record browser status as deferred
  with a link to `kd-1mr.2.1` until a Homebrew-derived browser image can run
  the same tier.

The design should not create a fake browser pass from Node artifacts. Browser
results must come from a browser host run or remain explicitly unsupported.

## Alternatives Considered

### Make `veryquick` the package gate

Rejected. `veryquick` scheduled 1183 jobs and the after-rootfs run projected
hours after completing only four jobs. Making that the default bottle gate would
turn ordinary package publication into a long upstream conformance campaign.

### Use only SQL fixtures and ignore the official runner

Rejected. The 17 fixture files are useful smoke coverage, but they do not
exercise SQLite's official scheduler, Tcl harness, shell subprocess path, or
upstream job classification. The follow-up exists because official-runner status
is valuable as separate metadata.

### Run the first N scheduler jobs

Rejected as the durable tier definition. The first N jobs depend on upstream
scheduler details and may drift when SQLite changes its testrunner. A named
allowlist is more reviewable for Tier 0, and deterministic shard manifests are
better for broader tiers.

### Browser first

Rejected for this bead. Browser is required product surface, but current
blocking evidence points to generic non-hello Homebrew browser smoke and
browser long-run stability work. Node is the practical first official tier;
browser should be a focused follow-up with explicit status.

### Hide unsupported official-test jobs as skipped

Rejected. Jobs that did not run because of interruption, timeout, or setup
failure are incomplete, not skipped. Skipped should mean SQLite or the tier
intentionally omitted the job with a reason.

## Risks And Mitigations

Misleading confidence:

- Risk: a four-job official tier could be read as "SQLite upstream tests pass".
- Mitigation: name it `smoke`, mark it non-gating, record job counts, and keep
  `veryquick/full/all` status separate in sidecars and bead notes.

Stale allowlist:

- Risk: SQLite upstream renames or removes selected tests.
- Mitigation: tier expansion should fail loudly when planned tests are absent,
  and the fix should update the manifest with evidence from `--explain`.

Runner setup masking platform defects:

- Risk: adding shell/rootfs setup in the test harness could hide exec or VFS
  issues.
- Mitigation: use Kandelo's normal rootfs and process path. Missing `/bin/sh`
  remains a setup failure with incomplete jobs; do not special-case SQLite to
  bypass the shell.

Browser parity drift:

- Risk: Node official tier lands while browser status disappears.
- Mitigation: sidecar/provenance metadata must include browser status as
  `deferred` or `unsupported` with a follow-up bead until a browser run exists.

Unbounded runtime:

- Risk: `veryquick` shards grow until they are no longer practical.
- Mitigation: every tier has an outer timeout, incomplete jobs are first-class
  artifacts, and long runs belong to scheduled/convoy tiers, not package gates.

Outcome-list gaps:

- Risk: existing scripts emit summaries but not complete passed/skipped/
  incomplete lists for every category.
- Mitigation: add a shared exporter before claiming tier completion. If a
  category cannot be emitted from the harness, record the missing category and
  create a focused follow-up.

## Implementation Sequence

1. Preflight the bead worktree and confirm whether the implementation branch
   should be based on `kd-1mr.2` commit `440ac7e5e` or current `origin/main`.
2. Add `packages/registry/sqlite/test/official-tiers.toml` with
   `sqlite-official-smoke-v1` and placeholder metadata for broader tiers.
3. Add `scripts/run-sqlite-official-tier.sh` as a thin tier/shard wrapper over
   `scripts/run-sqlite-official-tests.sh` and
   `scripts/run-sqlite-project-unit-tests.sh`.
4. Add an outcome exporter that reads planned jobs plus `testrunner.db` and
   writes passed, failed, skipped, incomplete, and `summary.json` artifacts.
5. Run Tier 0 on Node from a clean preflighted worktree:

   ```bash
   bash scripts/dev-shell.sh bash scripts/run-sqlite-official-tier.sh \
     --tier sqlite-official-smoke-v1 \
     --host node \
     --results-root test-runs/kd-1mr.2.4/sqlite-official-smoke-v1-node
   ```

6. Record browser status as deferred and link it to the non-hello Homebrew
   browser smoke follow-up. If that follow-up lands first, add a browser Tier 0
   run from the Homebrew-derived SQLite image.
7. Wire Tier 0 summary paths into Homebrew sidecar/provenance metadata as
   upstream-test status, not as default bottle availability.
8. Add a scheduled or manually dispatched convoy path for Tier 1 shards only
   after Tier 0 exporter behavior is stable.

## Test And Documentation Plan

Implementation verification should publish exact outcome counts before and
after any runner change.

Required checks for Tier 0 implementation:

- `bash scripts/dev-shell.sh bash scripts/run-sqlite-official-tier.sh --tier sqlite-official-smoke-v1 --host node ...`
- A setup-failure fixture or forced missing-prerequisite run proving the
  exporter writes failed and incomplete lists when the harness cannot start.
- A timeout-limited run proving incomplete jobs are emitted when the harness is
  interrupted.
- Focused shell lint or script check for new shell wrappers.
- If sidecar metadata is touched:
  `cargo xtask homebrew-validate --tap-root <generated-sidecar-root>`.

Runtime full gates are not required for a docs-only tier design. If the
implementation changes host runtime, VFS, syscall, libc, fork instrumentation,
or ABI behavior while making the tier pass, it must run the relevant full gate
from `CLAUDE.md` and report every skipped suite with a reason.

Documentation updates after implementation:

- Update `docs/porting-guide.md` SQLite Official Project Tests with the tiered
  runner command and the meaning of smoke/sharded/investigation tiers.
- Update `docs/homebrew-publishing.md` if upstream-test status is added to
  Homebrew sidecars or provenance.
- Add a short note to the SQLite package test README if one exists by then;
  otherwise keep the manifest self-documenting.

## Open Questions

- Should Tier 0 stay at the four jobs observed passing under `kd-1mr.2`, or
  should it add a basic non-FTS SQL job once a clean run proves the runtime
  budget still stays under 10 minutes?
- Should Tier 1 shards be fixed-count shards derived at implementation time, or
  should the tier manifest pin every shard's explicit job list for review?
- Where should browser official status live if `kd-1mr.2.1` lands generic
  browser smoke but not a full Homebrew-derived SQLite official-test image?
- Should upstream-test status become a new structured field in Homebrew
  sidecars, or remain provenance-only until more packages have upstream suites?
- What is the owner-approved policy for promoting any SQLite official tier from
  package-status metadata to a merge or publication gate?
