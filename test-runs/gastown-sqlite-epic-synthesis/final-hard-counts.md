# SQLite Final Hard Counts

Issue: `kad-wtb.14`
Epic: `kad-wtb`
Integration branch: `integration/kad-wtb-sqlite-testing`
Integration head inspected: `40a9df5c947ca79c1952c451abfbe122deba75e4`
Date: 2026-06-14

This report records the hard pass/fail/skip counts from the preserved official
SQLite project-unit `full` snapshots plus focused reruns that supersede the
original browser failure rows. No SQLite test was skipped or xfailed as part of
this epic. The SQLite testrunner schema records `done`, `failed`, `omit`,
`running`, and `ready`; it does not record XFAIL/XPASS/flaky fields.

## Official Full Snapshots

### Node

Command:

```bash
/bin/bash scripts/dev-shell.sh /bin/bash scripts/run-sqlite-project-unit-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-node-full-pr5
```

Artifacts:

- `test-runs/gastown-sqlite-node-full-pr5/command.log`
- `test-runs/gastown-sqlite-node-full-pr5/host-status.tsv`
- `test-runs/gastown-sqlite-node-full-pr5/node/summary.txt`
- `test-runs/gastown-sqlite-node-full-pr5/node/failures.tsv`
- `test-runs/gastown-sqlite-node-full-pr5/node/testrunner.db`
- `test-runs/gastown-sqlite-node-full-pr5/node/testrunner.log`

Runner status: `host-status.tsv` recorded `node 143`; `command.log` recorded
`exit_status=1` after writing the DB summary. The host failure was the old
Mach-O executable compile wedge later fixed by `kad-36g`; there is no later
full-suite Node DB in this artifact set.

| Host | Total jobs | PASS/done jobs | FAIL jobs | SKIP/OMIT jobs | RUNNING jobs | READY/not-run jobs | SQLite cases | Case errors | XFAIL | XPASS/flaky |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| node | 1394 | 0 | 0 | 0 | 1 | 1393 | 0 | 0 | not recorded | not recorded |

Node running job in the preserved full snapshot:

| Job | State | Cases | Errors | Classification |
|---|---|---:|---:|---|
| `ext/fts5/test/fts5optimize2.test` | running | 0 | 0 | Scheduler casualty of the old exec-resolution wedge, not a focused SQLite test failure. |

### Browser

Command:

```bash
bash scripts/run-sqlite-project-unit-tests.sh --host browser --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-browser-full-pr5-snapshot
```

Artifacts:

- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/run.log`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/host-status.tsv`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/combined-summary.md`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/summary.txt`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/failures.tsv`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/testrunner.db`
- `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/testrunner.log`

Runner status: `host-status.tsv` recorded `browser 1`. The page navigated or
reloaded while Playwright was waiting in `page.evaluate()`, but the testrunner
DB was preserved and readable.

| Host | Total jobs | PASS/done jobs | FAIL jobs | SKIP/OMIT jobs | RUNNING jobs | READY/not-run jobs | SQLite cases | Case errors | XFAIL | XPASS/flaky |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| browser | 1393 | 58 | 4 | 0 | 2 | 1329 | 20066 | 1004 | not recorded | not recorded |

Browser failed/running rows from the preserved full snapshot:

| Job | Full-snapshot state | Cases | Errors | Superseding focused status |
|---|---|---:|---:|---|
| `test/sysfault.test` | failed | 1360 | 2 | Browser focused PASS, 1365 cases / 0 errors. |
| `test/writecrash.test` | failed | 20 | 1 | Browser focused FAIL, 158 cases / 1 error; tracked by `kad-wtb.19`. |
| `test/like.test` | failed | 159 | 1 | Node focused PASS and browser default focused PASS twice, 159 cases / 0 errors. |
| `test/savepoint6.test` | failed | 3325 | 1000 | Browser focused PASS, 8007 cases / 0 errors. |
| `test/walfault.test` | running | 0 | 0 | Browser focused FAIL, 1 case / 1 error; tracked by `kad-wtb.20`. |
| `test/sort4.test` | running | 0 | 0 | Browser focused PASS, 11 cases / 0 errors; Node focused FAIL tracked by `kad-wtb.21`. |

## Focused Rerun Counts

| Scope | Command / artifact | PASS/done jobs | FAIL jobs | SKIP/OMIT jobs | RUNNING/TIME jobs | Cases | Errors | Classification |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Browser `sysfault.test` | `scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 900000 --results-dir test-runs/kad-wtb.11-browser-sysfault sysfault.test`; committed report `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser-fault-recheck.md` | 1 | 0 | 0 | 0 | 1365 | 0 | Original WAL/open-path failures did not reproduce after rebuild. |
| Browser `writecrash.test` | `scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 900000 --results-dir test-runs/kad-wtb.11-browser-writecrash writecrash.test`; committed report `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser-fault-recheck.md` | 0 | 1 | 0 | 0 | 158 | 1 | Browser-only executable visibility/materialization failure for `/usr/bin/testfixture`; follow-up `kad-wtb.19`. |
| Node `writecrash.test` | Same committed fault/crash report | 1 | 0 | 0 | 0 | 995 | 0 | Node comparison passes. |
| Browser `walfault.test` | `scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 900000 --results-dir test-runs/kad-wtb.11-browser-walfault walfault.test`; committed report `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser-fault-recheck.md` | 0 | 1 | 0 | 0 | 1 | 1 | Late Tcl abort plus browser kernel `munmap` trap; follow-up `kad-wtb.20`. |
| Node `walfault.test` | Same committed fault/crash report | 0 | 0 | 0 | 1 | 0 | 0 | Timed out/running without reaching the browser abort path. |
| Node `like.test` | `bash scripts/run-sqlite-official-tests.sh --host node --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-node-full like.test`; committed summary `test-runs/kad-wtb13-like-node-full/summary.txt` | 1 | 0 | 0 | 0 | 159 | 0 | Pass. |
| Browser `like.test` default run 1 | `bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-browser-full like.test`; committed summary `test-runs/kad-wtb13-like-browser-full/summary.txt` | 1 | 0 | 0 | 0 | 159 | 0 | Pass. |
| Browser `like.test` default run 2 | `bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-browser-full-rerun-default like.test`; committed summary `test-runs/kad-wtb13-like-browser-full-rerun-default/summary.txt` | 1 | 0 | 0 | 0 | 159 | 0 | Pass. |
| Browser `like.test` 16384-page diagnostic | `SQLITE_TEST_VITE_PORT=5260 SQLITE_BROWSER_MAX_MEMORY_PAGES=16384 bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-browser-full-1g like.test`; committed summary `test-runs/kad-wtb13-like-browser-full-1g/summary.txt` | 0 | 1 | 0 | 0 | 159 | 1 | Diagnostic failure on adjacent timing case `like-14.1`; original `like-14.2` passes. |
| Browser `savepoint6.test` | `scripts/run-sqlite-project-unit-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 900000 --results-root test-runs/kad-wtb.12-savepoint6-focused-after-fix savepoint6.test`; local artifact `/Users/brandon/gt/kandelo/polecats/warboy/kandelo/test-runs/kad-wtb.12-savepoint6-focused-after-fix/browser/summary.txt`; durable close note `kad-wtb.12` | 1 | 0 | 0 | 0 | 8007 | 0 | Pass after SharedFS open-unlink/rename-over fix. |
| Browser `sort4.test` | `scripts/run-browser-sqlite-official-tests.sh --permutation full --jobs 1 --timeout-ms 300000 sort4`; durable close note `kad-wtb.9` | 1 | 0 | 0 | 0 | 11 | 0 | Pass after browser threaded-sorter stabilization; no preserved final results-dir was found. |
| Node `sort4.test` | `/Users/brandon/gt/kandelo/polecats/dag/kandelo/test-runs/sqlite-node-sort4-dag-trace-20260613/{summary.txt,failures.tsv,testrunner.db,testrunner.log}` and `/Users/brandon/gt/kandelo/polecats/dag/kandelo/test-runs/sqlite-official-node-full/20260613-095215/{summary.txt,failures.tsv,testrunner.db,testrunner.log}` | 0 | 1 | 0 | 0 | 11 | 5 | Fails `sort4-2.3/2.4/2.5/2.6/2.8` with `unable to open database file`; follow-up `kad-wtb.21`. |

## Final Failure Inventory

Active follow-up bugs filed from `kad-wtb.18`:

| Bead | Host | Test | Classification | Current hard count |
|---|---|---|---|---|
| `kad-wtb.19` | browser | `writecrash.test` | Browser process teardown / executable materialization / VFS visibility after repeated crash-child iterations. | 1 failed job, 158 cases, 1 error. |
| `kad-wtb.20` | browser | `walfault.test` | Browser crash/abort cleanup path reaches `munmap` trap. | 1 failed job, 1 recorded case, 1 error. |
| `kad-wtb.21` | node | `sort4.test` | Node filesystem/temp database open failure in SQLite sorter coverage. | 1 failed job, 11 cases, 5 errors. |

Resolved or superseded rows:

| Host | Test | Resolution |
|---|---|---|
| node | Full-run Mach-O compile wedge | Fixed by `kad-36g`; preserved full DB remains the hard snapshot because no later full-suite Node DB is present. |
| browser | `sysfault.test` | Focused rebuilt browser run passes, 1365 cases / 0 errors. |
| browser | `like.test` / `like-14.2` | Focused Node and browser default runs pass; diagnostic 16384-page comparison fails adjacent timing case `like-14.1`, not the original string/collation concern. |
| browser | `savepoint6.test` | Focused browser run passes after SharedFS fix, 8007 cases / 0 errors. |
| browser | `sort4.test` | Focused browser run passes after threaded-sorter stabilization, 11 cases / 0 errors. |

## Superseded Or Excluded Artifacts

- `test-runs/gastown-sqlite-node-full-pr5/attempt1/combined-summary.md` has no
  usable testrunner DB and is superseded by
  `test-runs/gastown-sqlite-node-full-pr5/node/testrunner.db`.
- Early browser sort4 diagnostic directories under Dag's worktree are
  intermediate failed/running probes and are superseded by the `kad-wtb.9`
  focused browser pass close note.
- `test-runs/kad-wtb13-like-browser-full-1g` is a memory-cap diagnostic only;
  it should not replace the two passing default browser focused runs.
