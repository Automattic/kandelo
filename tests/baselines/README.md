# Failure evidence

This directory holds the failures and anomalies most recently observed on
main, one record per suite, host and selection. They are observations to
investigate, not allowances that make a failing run green. The conformance
runners' expectation lists remain authoritative.

## Layout

Each record is a JSON file named for what was run:

- `<suite>-<host>.json`: a full run of the suite on that host.
- `<suite>-<host>-<selection>.json`: a shard or targeted selection, such as
  `vitest-node-shard-1-of-2` or `sortix-node-dlfcn-tcgetwinsize`. Name the
  selection after the tests it ran, so a rerun of the same tests gets the
  same name.

Hosts are `node`, `chromium`, `firefox` and `webkit`; use `build` for build
and native test runs that have no guest host. A `.log` file with the same
stem holds the console excerpt when the JSON leaves out a diagnostic.

There are no per-commit directories. The commit is a field in each record,
and git history keeps every earlier record, so replacing a file loses
nothing.

## Replacing and retiring records

Records describe main as last observed, so the directory does not grow with
each PR:

- A newer main run with the same name replaces the record and its `.log`.
  If that run is clean, delete them instead; clean runs are not committed.
- A full run covers the shard and selection records for the same suite and
  host. Delete those when you commit the full run's record, or when the
  full run is clean.
- A PR that fixes every case in a record deletes the record and says so in
  its description. If it fixes only some cases, leave the record for the
  next run of that selection to replace; do not edit outcomes by hand.
- Never replace a record with a run of a different selection or shard:
  absence from a partial report does not show that a test passed.

## Which commit to record

Run the suite on main and record that commit as `commit`. If main needs a
build-only fix before the suite can run, record the commit you actually ran
as `commit`, the main commit it was based on as `base_commit`, and what
differed in `note`. The run commit usually disappears once its PR is
squash-merged; `base_commit` stays reachable.

## Records from 2026-10-30

The `vitest-node`, `sortix-node`, `sortix-chromium`, `posix-chromium`,
`libc-chromium` and `playwright-*-pr1600` records are excerpts from main at
`e4bca8639e4b6853080ca7f3a09b0e95488c9d50`, run on 2026-10-30 for
[PR #1600](https://github.com/Automattic/kandelo/pull/1600), before the
JSON importer existed. Each JSON gives the original command, exit code,
full-log SHA-256 hash and one-based source line numbers. ANSI escapes and
trailing whitespace were removed; lines keep source order. Ordinary passes
and success counters are omitted. These `.log` excerpts are not inputs to
the Vitest/Playwright JSON importer.

The full raw logs named in `source_log` survive only in a local archive on
the recording machine. The committed excerpts are readable without it.

- Node Sortix: **one runner incident**, with 1,357 timeouts and 19
  XFAIL-MISMATCH results. PR #1600 diagnosed stale per-test xtask checker
  rebuilds. Only representative lines are kept; these are not 1,376
  established guest-test defects.
- Vitest: 30 failures; the reporter did not name every skipped case.
- Playwright: only the selected specs were run, with retries disabled.
- Conformance logs may report more skips/expected failures than they name.
  Keep those counters without inventing missing test identities. The libc
  clock test was an expected failure in this run, not an unexpected failure.

Exact recording times, artifact identities and OS/runtime/browser versions
were not retained. Load is known only for Vitest (see its `note`).
There are no seeds for main's Node libc/POSIX or Firefox runs.

xtask's importer tests use frozen copies of the two Sortix excerpts in
`tools/xtask/tests/fixtures/test-failures/`, so replacing these records
does not change those tests.

## Recording a new run

Opt into the existing JSON reporters through the normal suite wrapper.
Set the directory inside the dev shell (outer environment variables are
not generally passed through):

```bash
scripts/dev-shell.sh bash -c '
  export KANDELO_TEST_REPORT_DIR="$PWD/.scratch/reports"
  bash scripts/ci-run-test-suite.sh vitest 1/2
'
```

The `vitest` and `browser` groups capture each test process separately,
including isolated cases and Bun runs. Each gets a unique directory with
`report.json`, `console.log`, and `context.json` containing its exit code,
command, working directory, repository root, commit and start time.
Relative report directories resolve against the repository root. Capture
is disabled when `KANDELO_TEST_REPORT_DIR` is unset; normal verdicts and
suite partitions are preserved. A process killed before completion may
leave only its console log; do not import an older report in its place.

For targeted commands, use the same thin wrapper from the normal test
working directory, with `KANDELO_TEST_REPORT_DIR` set inside the dev shell:

```bash
# From host/; replace TEST_SELECTION with the intended tests.
bash ../scripts/record-test-report.sh vitest npx vitest run TEST_SELECTION
# From apps/browser-demos/; choose a unique port as usual.
bash ../../scripts/record-test-report.sh playwright \
  npx playwright test TEST_SELECTION --project=chromium
```

Conformance runners retain their text output. Keep that log and write a
context JSON object with `exit_code`, suite, host, commit, date and command.
Include `repo_root` for the worktree used by the run; Vitest absolute file
names are normalized against it so identities match across worktrees.
Known versions/load can be added; do not invent unknown historical fields.

Build xtask as described in its [README](../../tools/xtask/README.md), then
import one finished process report (replace RUN_DIR with its directory):

```bash
scripts/dev-shell.sh bash -c '
  target/aarch64-apple-darwin/debug/xtask \
    test-failures vitest RUN_DIR/report.json RUN_DIR/context.json \
    > RUN_DIR/failures.json
'
```

Keep redirection inside the dev shell so startup banners stay out of JSON.

Formats are `vitest` (JSON), `playwright` (JSON), and `conformance` (text).
The output contains supplied context, the source-report hash, and sorted
nonpassing cases. **A nonzero exit is also retained as a run error**:
Vitest JSON can claim success while omitting an unhandled error. This run
error records the failed exit, not a separate diagnosed infrastructure bug.
Keep the console log to investigate it. Successful importing never means
the tests passed. Duplicate nonpassing IDs are rejected rather than
silently merged; retain the raw report or rerun distinct selections.

## Committing a record

Review new anomalies before committing them. Keep branch reports in
`.scratch/`; only main runs go here, and they establish which failures
already existed before a PR. Copy the importer output to the record's name
in this directory and apply the replacement rules above.
If JSON omits the diagnostic or retry history, commit the relevant raw
console failure/anomaly excerpt beside it as a `.log` file. This includes
Vitest unhandled errors: the local `context.console_log` path alone is not
durable evidence. Omit routine passing output from committed excerpts.

Playwright retry statuses are preserved in `observed`; mixed outcomes are
intermittent. Terminal outcomes use the final attempt's diagnostic;
intermittent results retain a failure diagnostic after a passing retry.
Interrupted attempts are run errors; intentional skips remain skips.
Vitest JSON omits retry history: retain console evidence and
document observed retries separately, without inventing rates. Conformance
`FLAKE-*` labels annotate known-flaky tests after a single attempt; preserve
the actual failure/timeout (or `known-flaky-pass`) with `known_flaky: true`.
No freshness machinery, enforcement, or CI gate is added.
