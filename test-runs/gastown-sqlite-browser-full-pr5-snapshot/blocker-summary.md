# SQLite Browser Full-Suite Blocker

Command:

```bash
bash scripts/run-sqlite-project-unit-tests.sh --host browser --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-browser-full-pr5-snapshot
```

Result: browser runner exited 1 after the page navigated/reloaded while `page.evaluate()` was waiting for the in-browser SQLite testrunner command.

Artifacts:

- `combined-summary.md`
- `run.log`
- `host-status.tsv`
- `browser/summary.txt`
- `browser/failures.tsv`
- `browser/testrunner.db`
- `browser/testrunner.log`

Snapshot summary:

| Total jobs | Done | Failed | Running | Ready | SQLite cases | Case errors |
|---:|---:|---:|---:|---:|---:|---:|
| 1393 | 58 | 4 | 2 | 1329 | 20066 | 1004 |

Failed jobs:

| Job | Test | Cases | Errors | Note |
|---:|---|---:|---:|---|
| 3 | `test/sysfault.test` | 1360 | 2 | Fault-injection WAL/open path returned `file is not a database`, `disk I/O error`, and `large file support is disabled` where SQLite expected success. |
| 4 | `test/writecrash.test` | 20 | 1 | `writecrash-1.6.1` expected `0 {}` but received binary/corrupt-looking output. |
| 48 | `test/like.test` | 159 | 1 | `like-14.2` expected `1` and got `0`. |
| 50 | `test/savepoint6.test` | 3325 | 1000 | `savepoint6-tempdb.73.1` onward report mismatched database vs in-memory array entry counts. |

Running at browser reload:

| Job | Test | Command |
|---:|---|---|
| 63 | `test/walfault.test` | `/usr/bin/testfixture /sqlite/test/walfault.test` |
| 727 | `test/sort4.test` | `/usr/bin/testfixture /sqlite/test/sort4.test` |

Root-cause direction:

- The adopted browser harness can now export a readable partial `testrunner.db` even when the page reloads; this required preserving `testrunner.db-wal`/`testrunner.db-shm` style artifacts and pushing periodic snapshots from the page to the Playwright runner.
- The remaining blocker is browser runtime stability during the full run: the page navigates back to `/pages/sqlite-test/` without a logged page error, and Playwright reports `Execution context was destroyed, most likely because of a navigation`.
- The reload happened after `sort4.test` and `walfault.test` were both marked running with no per-job output yet. Given the prior sort4 stall history and the full-run memory profile, the next investigation should focus on browser renderer reload/OOM or Vite/client reload while those long-running jobs are active, then compare with a single-job browser run to separate concurrency pressure from an individual test hang.
