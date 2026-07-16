# SQLite Tcl All Run Plan

Status: PR setup for the high-throughput SQLite Tcl `all` audit.

## Scope

The target is SQLite's public Tcl `test/testrunner.tcl` `all` permutation on
Kandelo. This is broader than Tcl `full`: `full` runs the public Tcl scripts
once under the default configuration, while `all` includes `full` plus the
public runtime-configuration matrix from SQLite's `testrunner_data.tcl`.

The current job-count reference from the SQLite test taxonomy audit is:

| Target | Public Tcl jobs |
|---|---:|
| `full` | 1416 |
| `all` | 10523 |

Treat those counts as the planning reference, not as proof that a future
worktree is fresh. Before the long run, rebuild or refresh
`packages/registry/sqlite/sqlite-full-src/`, run `--explain`, and report the
actual scheduled job count from that run's `testrunner.db`.

Out of scope for this Tcl `all` PR setup:

- TH3, because it is SQLite's private/proprietary test suite.
- SQL Logic Test, because it is a separate public test repository and harness.
- dbsqlfuzz, because it is a separate proprietary fuzzing surface.
- `release`, `mdevtest`, and `sdevtest`, because they require host-side
  rebuilds, fuzz binaries, and source-test targets that are not Kandelo guest
  `testrunner.tcl` permutations.

## Host Plan

Node.js and browser are peer host surfaces and must be reported separately.
Use separate result roots so each host has independent `testrunner.db`, logs,
and outcome lists.

Preflight and source setup:

```bash
/Users/brandon/src/kandelo-gascity/tools/kandelo_worktree_policy.sh preflight <bead-id> test
bash packages/registry/tcl/build-tcl.sh
bash packages/registry/sqlite/build-testfixture.sh
```

Explain both hosts before execution:

```bash
scripts/run-sqlite-project-unit-tests.sh --host node --permutation all --explain --results-root <result-root>/explain-node
scripts/run-sqlite-project-unit-tests.sh --host browser --permutation all --explain --results-root <result-root>/explain-browser
```

Execute hosts as independent lanes:

```bash
scripts/run-sqlite-project-unit-tests.sh --host node --permutation all --jobs <node-jobs> --timeout-ms <timeout-ms> --results-root <result-root>/node-all
SQLITE_TEST_VITE_PORT=<port> scripts/run-sqlite-project-unit-tests.sh --host browser --permutation all --jobs <browser-jobs> --timeout-ms <timeout-ms> --results-root <result-root>/browser-all
```

Use the explain result to choose parallelism. The `all` target is 10523 public
Tcl jobs before host-specific omissions or source-tree drift, so high
parallelism should be increased only after focused smoke lanes prove the
worktree's SQLite testfixture, Tcl install, browser VFS image, and Vite port
assignment are healthy.

## Required Artifacts

Every substantive `all` run must publish the command line, environment,
result root, `summary.txt`, `combined-summary.md`, `host-status.tsv`,
`testrunner.db`, `testrunner.log`, and `failures.tsv`.

The SQLite official runners also write durable outcome lists under each host
result directory:

| File | Contents |
|---|---|
| `outcome-lists/passed-jobs.tsv` | Jobs whose SQLite testrunner state is `done`. |
| `outcome-lists/failed-jobs.tsv` | Jobs whose state is `failed`, with case/error counts and a compact output excerpt. |
| `outcome-lists/skipped-jobs.tsv` | Jobs whose state is `omit`, with the omitted reason when SQLite exposes one. |
| `outcome-lists/incomplete-jobs.tsv` | Jobs left `ready`, `running`, `halt`, empty, or otherwise nonterminal at report time. |

Final reporting for the all-target audit should include total jobs discovered,
pass/fail/skip/incomplete counts, SQLite `ntest` case totals, complete failure
and incomplete lists, host-specific caveats, and any reason an omitted job is
classified as skipped.
