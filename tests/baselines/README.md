# Failure evidence

Keep failures and anomalies here, one file per suite and host. These are
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

Keep the raw report in `.context/`. For Vitest and Playwright, use their
existing JSON reporters instead of parsing console layouts. For example,
append these options to the normal selected-test commands:

```bash
# From host/; retain both configured human/health reporters.
npx vitest run TEST_SELECTION \
  --reporter=default --reporter=./test/support/suite-health-reporter.ts \
  --reporter=json --outputFile.json="$PWD/../.context/vitest.json"

# From apps/browser-demos/; choose a unique port as usual.
PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/../../.context/playwright.json" \
  npx playwright test TEST_SELECTION --project=chromium --reporter=list,json
```

Replace `TEST_SELECTION` with the intended tests. Preserve the runner's exit
code; successful importing does not mean the tests passed. Record each
process separately so shards or isolated reruns do not overwrite reports.
Conformance runners retain their existing text output and verdicts.

Write a context JSON object with the observed suite, host, commit, date,
command/selection, exit code, and any known versions/load. Unknown fields
may be omitted. Build xtask as described in its [README](../../tools/xtask/README.md),
then import a finished report:

```bash
scripts/dev-shell.sh target/aarch64-apple-darwin/debug/xtask \
  test-failures vitest .context/vitest.json .context/run-context.json \
  > .context/vitest-node.json
```

Formats are `vitest` (JSON), `playwright` (JSON), and `conformance` (text).
Review the generated JSON, then copy it into this directory. It contains
supplied context, the source-report hash, and sorted nonpassing cases.
The historical Vitest/Playwright text excerpts are intentionally not inputs
to the JSON importer. Do not hand-edit generated outcomes.

Playwright retry statuses are preserved in `observed`; mixed outcomes are
intermittent. Vitest's JSON reporter does not expose retry history: retain
the raw console log and document observed retries separately, without
inventing rates. No freshness machinery, enforcement, or CI gate is added.
