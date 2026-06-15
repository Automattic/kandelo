# SQLite Epic Synthesis

Issue: `kad-wtb.6`
Epic: `kad-wtb`
Integration branch: `integration/kad-wtb-sqlite-testing`

## Completion Scope

The current epic should remain scoped to SQLite's official `full` permutation on
both Kandelo hosts. SQLite's larger `all` permutation should be a separate
expansion after `full` is stable enough to complete or produce deterministic
per-test failures. Expansion bead: `kad-29m`.

## Included Child Work

This synthesis branch includes the completed SQLite epic child commits needed
for the integration branch:

| Bead | Commit | Result |
|---|---|---|
| `kad-wtb.7` | `730e477b` | Added `scripts/run-sqlite-project-unit-tests.sh`, the combined project-unit wrapper around the official SQLite runner. |
| `kad-wtb.3` | `4dc59513` | Preserved Node full-run artifacts and filed `kad-36g` for the Node scheduler/exec wedge. |
| `kad-wtb.4` | `817f659f` | Disabled accidental default browser syscall tracing; focused browser `sort4.test` now reaches the real runtime crash/stall. |
| `kad-wtb.5` | `d59d92ad` | Preserved browser full-run snapshot artifacts and filed `kad-wtb.10` for page reload/runtime stability. |

`kad-wtb.5` was still on `origin/polecat/capable/kad-wtb.5@mqbrg3qd` when this
synthesis started. It has been fast-forwarded into this `kad-wtb.6` branch and
will be submitted to the integration target with this report.

## Node Result

Command:

```bash
/bin/bash scripts/dev-shell.sh /bin/bash scripts/run-sqlite-project-unit-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-node-full-pr5
```

The Node full run did not reach SQLite test execution. The testrunner initialized
the full permutation, then a child process path emitted:

```text
WebAssembly.compile(): expected magic word 00 61 73 6d, found cf fa ed fe @+0
```

Snapshot:

| Total jobs | Done | Failed | Omitted | Running | Ready | Cases | Case errors |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1394 | 0 | 0 | 0 | 1 | 1393 | 0 | 0 |

The running job was `ext/fts5/test/fts5optimize2.test`, but focused direct and
scheduler-shaped reproductions of that test passed. Classification: Node host
exec resolution or process-worker lifecycle wedge, not a SQLite
`fts5optimize2.test` failure. Follow-up: `kad-36g`.

Artifacts:

- `test-runs/gastown-sqlite-node-full-pr5/blocker-summary.md`
- `test-runs/gastown-sqlite-node-full-pr5/node/summary.txt`
- `test-runs/gastown-sqlite-node-full-pr5/node/failures.tsv`
- `test-runs/gastown-sqlite-node-full-pr5/node/testrunner.db`
- `test-runs/gastown-sqlite-node-full-pr5/repro/fts5optimize2-direct.log`
- `test-runs/gastown-sqlite-node-full-pr5/repro/fts5optimize2-sh-run-kcwd.log`

## Browser Result

Command:

```bash
bash scripts/run-sqlite-project-unit-tests.sh --host browser --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-browser-full-pr5-snapshot
```

The browser full run reached SQLite test execution and preserved a readable
partial testrunner database, but the page navigated/reloaded while Playwright
was waiting inside `page.evaluate()`.

Snapshot:

| Total jobs | Done | Failed | Omitted | Running | Ready | Cases | Case errors |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1393 | 58 | 4 | 0 | 2 | 1329 | 20066 | 1004 |

Failures and stalls are grouped as follows:

| Bead | Classification | Evidence |
|---|---|---|
| `kad-wtb.10` | Browser runtime stability/page reload under long full-run jobs | Playwright reported execution context destruction from navigation; `test/walfault.test` and `test/sort4.test` were running at reload. |
| `kad-wtb.9` | Browser pthread/threaded-sorter crash or CPU-bound stall | Focused `sort4.test` reaches `sort4-2.3` and then exposes process-worker memory OOB or CPU-bound renderer behavior. |
| `kad-wtb.11` | Browser fault/crash filesystem behavior | `test/sysfault.test` and `test/writecrash.test` failed before reload; `test/walfault.test` was running. |
| `kad-wtb.12` | Browser tempdb/savepoint state divergence | `test/savepoint6.test` failed 1000 cases starting at `savepoint6-tempdb.73.1`. |
| `kad-wtb.13` | Browser string/collation/LIKE semantics mismatch | `test/like.test` failed one case: `like-14.2` expected `1`, got `0`. |

Artifacts:

- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/blocker-summary.md`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/combined-summary.md`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/summary.txt`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/failures.tsv`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/testrunner.db`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/testrunner.log`

## Host Comparison

The current Node and browser blockers are different subsystems:

- Node wedges before any SQLite cases run, after a host Mach-O executable is fed
  to `WebAssembly.compile()`. The preserved `fts5optimize2` job name is a
  scheduler casualty, not the root test failure.
- Browser reaches 58 completed jobs and exposes concrete SQLite failure classes,
  then loses the page context during long-running `walfault`/`sort4` work.

Therefore the next work should not treat the two hosts as having one shared
SQLite test failure. Keep `kad-36g` on the Node exec/scheduler path, and keep
the browser follow-ups split across runtime stability, threading, fault/crash
filesystem behavior, tempdb/savepoint state, and LIKE semantics.

## Epic PR Preparation

Open or update the GitHub PR only after this synthesis branch has landed into
`integration/kad-wtb-sqlite-testing`. Use:

```bash
gh pr create --base main --head integration/kad-wtb-sqlite-testing --title "Adopt SQLite project unit test harness" --body-file test-runs/gastown-sqlite-epic-synthesis/pr-body.md
```

If a matching PR already exists, update that PR with
`test-runs/gastown-sqlite-epic-synthesis/pr-body.md` instead of creating a
duplicate. Do not run `gt mq integration land` without explicit human approval.
