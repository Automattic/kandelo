# Failure evidence

Keep failures and anomalies here as separate observations of each run. These are
observations to investigate, not allowances that make a failing run green.
The conformance runners' expectation lists remain authoritative.

## Historical evidence

The `.log` files contain real excerpts from main at
`e4bca8639e4b6853080ca7f3a09b0e95488c9d50`, run on 2026-10-30 for
[PR #1600](https://github.com/Automattic/kandelo/pull/1600).
[sources.json](sources.json) records the original commands, exit codes,
full-log SHA-256 hashes and selected one-based source line numbers.
ANSI escapes and trailing whitespace were removed; lines retain source order.
Ordinary passes and success counters are omitted.

The original `columbia` workspace is gone. The complete raw logs survive at
`/Users/brandon/conductor/archived-contexts/kandelo/batched-follow-ups-for-main-correctness/`,
including `main-validation-v1/`, `validation-v1/` and `validation-v1b/`.
The committed excerpts remain readable without that local archive.

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
were not retained. Load is known only for Vitest (see the manifest).
There are no seeds for main's Node libc/POSIX or Firefox runs.
These are historical observations, not claims about today's main.

## Recording a new run

Opt into the existing JSON reporters through the normal suite wrapper.
Set the directory inside the dev shell (outer environment variables are
not generally passed through):

```bash
scripts/dev-shell.sh bash -c '
  export KANDELO_TEST_REPORT_DIR="$PWD/.context/reports"
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

## Keeping evidence across PRs

Review new anomalies before committing them. Keep each main observation
under `tests/baselines/<recorded-commit>/<suite>-<host>-<run-id>.json`, using
the unique run directory name as the run ID. Keep branch reports separate
in `.context/`; use main-run evidence to establish pre-existing failures.
Never overwrite an earlier record with a targeted rerun or another shard:
absence from a partial report does not establish that a test passed. A
rerun adds an observation and does not refresh the rest of the inventory.
Do not commit ordinary clean runs or edit generated outcomes by hand.
If JSON omits the diagnostic or retry history, commit the relevant raw
console failure/anomaly excerpt beside it as a `.log` file. This includes
Vitest unhandled errors: the local `context.console_log` path alone is not
durable evidence. Omit routine passing output from committed excerpts.
The initial `.log` excerpts remain historical records; they are not inputs
to the Vitest/Playwright JSON importer.

Playwright retry statuses are preserved in `observed`; mixed outcomes are
intermittent. Terminal outcomes use the final attempt's diagnostic;
intermittent results retain a failure diagnostic after a passing retry.
Interrupted attempts are run errors; intentional skips remain skips.
Vitest JSON omits retry history: retain console evidence and
document observed retries separately, without inventing rates. Conformance
`FLAKE-*` labels annotate known-flaky tests after a single attempt; preserve
the actual failure/timeout (or `known-flaky-pass`) with `known_flaky: true`.
No freshness machinery, enforcement, or CI gate is added.
