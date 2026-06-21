# SQLite All Permutation Preflight

Bead: `kad-29m`
Scheduled execution bead: `kad-p6f`

## Commands Run

Prepared the browser demo dependency tree so the browser host runner could
start Vite from `apps/browser-demos`:

```bash
scripts/dev-shell.sh bash -lc 'cd apps/browser-demos && npm ci --no-audit --no-fund --prefer-offline'
```

Built the missing test prerequisites in the local worktree before the preflight:

```bash
bash packages/registry/tcl/build-tcl.sh
bash packages/registry/zlib/build-zlib.sh
bash packages/registry/sqlite/build-sqlite.sh
bash packages/registry/sqlite/build-testfixture.sh
```

Planned SQLite upstream `all` coverage on both hosts without executing the jobs:

```bash
scripts/dev-shell.sh bash -lc 'scripts/run-sqlite-project-unit-tests.sh --host both --permutation all --jobs 1 --timeout-ms 600000 --explain --results-root test-runs/sqlite-project-unit-all/kad-29m-explain-20260614-235828'
```

## Result

Both hosts completed the `all --explain` pass with runner exit `0`.

| Host | Planned jobs | Ready jobs | Failures |
|------|--------------|------------|----------|
| Node | 10353 | 10353 | 0 |
| Browser | 10366 | 10366 | 0 |

No all-only failure blockers were filed from this preflight because no jobs
were executed in explain mode.

## Scheduled Long Run

The actual long-running all-permutation coverage is scheduled on `kad-p6f` with
the command shape below:

```bash
scripts/dev-shell.sh bash -lc 'scripts/run-sqlite-project-unit-tests.sh --host both --permutation all --jobs 1 --timeout-ms 43200000 --results-root test-runs/sqlite-project-unit-all/<timestamp>'
```

Preserve each host's `summary.txt`, `failures.tsv`, `testrunner.db`, and any
run logs. File narrower blockers for failures that appear only under the
`all` permutation.
