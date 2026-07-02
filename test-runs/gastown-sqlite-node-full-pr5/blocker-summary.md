# SQLite Node Full-Suite Validation

Issue: `kad-wtb.3`
Follow-up blocker: `kad-36g`

## Command

```bash
/bin/bash scripts/dev-shell.sh /bin/bash scripts/run-sqlite-project-unit-tests.sh --host node --permutation full --jobs 2 --timeout-ms 21600000 --results-root test-runs/gastown-sqlite-node-full-pr5
```

## Result

The Node full-suite run did not complete. SQLite's testrunner initialized the
full permutation, then the first child process path emitted:

```text
WebAssembly.compile(): expected magic word 00 61 73 6d, found cf fa ed fe @+0
```

The testrunner then wedged with one job still marked `running`:

| Total jobs | Done | Failed | Omitted | Running | Ready | Cases | Case errors |
|------------|------|--------|---------|---------|-------|-------|-------------|
| 1394 | 0 | 0 | 0 | 1 | 1393 | 0 | 0 |

Running job:

| Job ID | State | Display type | Display name |
|--------|-------|--------------|--------------|
| 883 | running | tcl | ext/fts5/test/fts5optimize2.test |

## Focused Reproduction

The named SQLite test itself passed when launched directly:

```text
fts5optimize2-1.0... Ok
fts5optimize2-1.1... Ok
fts5optimize2-1.2... Ok
0 errors out of 4 tests on   32-bit
```

The scheduler-shaped launch also passed when run as `sh run.sh` with
`KERNEL_CWD` set to the generated SQLite test directory inside the dev shell.

## Artifacts

- `command.log`: raw full-suite command output.
- `node/summary.txt`: partial SQLite testrunner database summary.
- `node/failures.tsv`: running job list from the partial DB.
- `node/testrunner.db`: copied SQLite testrunner state at interruption.
- `repro/fts5optimize2-direct.log`: direct single-test pass.
- `repro/fts5optimize2-sh-run-kcwd.log`: scheduler-shaped single-test pass.
- `attempt1/`: setup failure before root `node_modules` existed.
- `attempt2/`: setup failure from outer shell not finding `bash`.
