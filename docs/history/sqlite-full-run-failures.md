# Historical SQLite full-run failures

These are consolidated observations from two interrupted SQLite `full`
permutation runs. They preserve the distinction between guest test failures,
an interrupted browser runner and a Node executable-format failure. They do
not establish current failures, a completed full-suite run or current readiness.
The source reports do not specify tested commits or runtime/browser versions.

## Browser run

The original command was:

```bash
bash scripts/run-sqlite-project-unit-tests.sh --host browser --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-browser-full-pr5-snapshot
```

The runner exited 1 after the page navigated/reloaded while Playwright was
waiting in `page.evaluate()`. The reported error was
`Execution context was destroyed, most likely because of a navigation`.
The cause of the reload was not established.

| Total jobs | Done | Failed | Running | Ready | SQLite cases | Case errors |
|---:|---:|---:|---:|---:|---:|---:|
| 1393 | 58 | 4 | 2 | 1329 | 20066 | 1004 |

The following rows preserve every field in the original `browser/failures.tsv`.
All rows had display type `tcl`; `ms` is the recorded per-job duration. The
`running` rows are interrupted work, not established failing tests.

| Job | State | Display type | Test | Cases | Errors | ms |
|---:|---|---|---|---:|---:|---:|
| 3 | failed | tcl | `test/sysfault.test` | 1360 | 2 | 8907 |
| 4 | failed | tcl | `test/writecrash.test` | 20 | 1 | 7888 |
| 48 | failed | tcl | `test/like.test` | 159 | 1 | 1747 |
| 50 | failed | tcl | `test/savepoint6.test` | 3325 | 1000 | 56592 |
| 63 | running | tcl | `test/walfault.test` | 0 | 0 | 0 |
| 727 | running | tcl | `test/sort4.test` | 0 | 0 | 0 |

The accompanying report described these failures:

- `sysfault.test`: fault-injection WAL/open paths returned `file is not a database`,
  `disk I/O error` and `large file support is disabled` where success was expected.
- `writecrash-1.6.1`: expected `0 {}` and received binary/corrupt-looking output.
- `like-14.2`: expected `1` and received `0`.
- `savepoint6-tempdb.73.1` onward: database versus in-memory array entry counts
  diverged, producing 1000 case errors.

At reload, jobs 63 and 727 were running as
`/usr/bin/testfixture /sqlite/test/walfault.test` and
`/usr/bin/testfixture /sqlite/test/sort4.test`. The harness exported readable
partial testrunner state despite losing the page context by retaining SQLite
WAL/SHM sidecar state and sending periodic snapshots from the page to the
Playwright runner. That snapshot did not establish that either running test
caused the reload.

## Node run

The original command was:

```bash
/bin/bash scripts/dev-shell.sh /bin/bash scripts/run-sqlite-project-unit-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-node-full-pr5
```

The testrunner initialized its full permutation, then its first child-process
path reported:

```text
WebAssembly.compile(): expected magic word 00 61 73 6d, found cf fa ed fe @+0
```

| Total jobs | Done | Failed | Omitted | Running | Ready | Cases | Case errors |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1394 | 0 | 0 | 0 | 1 | 1393 | 0 | 0 |

Job 883, display type `tcl`, remained `running` with display name
`ext/fts5/test/fts5optimize2.test`. The named test passed when launched directly
(`0 errors out of 4 tests on 32-bit`) and through a scheduler-shaped
`sh run.sh` invocation with `KERNEL_CWD` set to the generated test directory.
The report therefore treated the outstanding problem as a child launch or
runtime issue, not a demonstrated failure of `fts5optimize2.test` itself.
Its historical issue IDs were `kad-wtb.3` and follow-up `kad-36g`.

The Node run executed no SQLite cases before stalling. The browser run reached
named failing cases before interruption. They were different observations and
should not be combined into one shared-host test failure.

## Original records

These source links identify the tree from which the records were retained,
not the commits that the original runs tested. Full logs, databases and SQLite
sidecar files remain in that tree's Git history.

- [Browser blocker report](https://github.com/Automattic/kandelo/blob/e9b878876750dbd9b2d966463579787319c555f3/test-runs/gastown-sqlite-browser-full-pr5-snapshot/blocker-summary.md)
- [Complete browser failure list](https://github.com/Automattic/kandelo/blob/e9b878876750dbd9b2d966463579787319c555f3/test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser/failures.tsv)
- [Node blocker report](https://github.com/Automattic/kandelo/blob/e9b878876750dbd9b2d966463579787319c555f3/test-runs/gastown-sqlite-node-full-pr5/blocker-summary.md)
