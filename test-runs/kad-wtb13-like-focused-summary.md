# SQLite LIKE Focused Classification

Issue: `kad-wtb.13`
Base branch: `integration/kad-wtb-sqlite-testing`

## Scope

The browser full-suite snapshot at
`test-runs/gastown-sqlite-browser-full-pr5-snapshot` recorded one
`test/like.test` failure: `like-14.2` expected `1` and got `0`.

`like-14.2` is a timing assertion, not a LIKE result mismatch. The test runs:

```sql
SELECT 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaz' LIKE '%a%a%a%a%a%a%a%a%y'
```

and expects the elapsed Tcl `time` measurement to be less than
`1000 * $::sqlite_options(configslower)` ms.

## Focused Commands

```bash
bash scripts/run-sqlite-official-tests.sh --host node --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-node-full like.test
```

```bash
bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-browser-full like.test
```

```bash
bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-browser-full-rerun-default like.test
```

```bash
SQLITE_TEST_VITE_PORT=5260 SQLITE_BROWSER_MAX_MEMORY_PAGES=16384 bash scripts/run-sqlite-official-tests.sh --host browser --permutation full --jobs 1 --timeout-ms 600000 --results-dir test-runs/kad-wtb13-like-browser-full-1g like.test
```

## Result

| Host/config | Result | Cases | `like-14.1` timing | `like-14.2` timing |
|---|---:|---:|---:|---:|
| Node | pass | 159/159 | 194 ms | 175 ms |
| Browser default cap, run 1 | pass | 159/159 | 0 ms | 0 ms |
| Browser default cap, run 2 | pass | 159/159 | 0 ms | 0 ms |
| Browser 16384-page cap | fail | 158/159 | 1000 ms | 0 ms |

The original browser snapshot failed because `like-14.2` measured exactly
`1000 ms`, and the upstream assertion is strictly `< 1000`.

```text
like-14.2... (1000 ms - want less than 1000.0)
! like-14.2 expected: [1]
! like-14.2 got:      [0]
```

## Classification

Focused `test/like.test` classifies the original `like-14.2` failure as a
browser timing-threshold miss, not a string comparison, collation, or locale
semantic mismatch. On the final rebased branch, `like-14.2` passed in every
focused browser rerun. The adjacent pathological GLOB timing assertion,
`like-14.1`, can hit the same exact `1000 ms` strict threshold in the 16384-page
browser memory-cap diagnostic and make the focused `test/like.test` job fail
even though `like-14.2` passes.

The default 4096-page browser cap passed twice on the final branch, while the
16384-page comparison failed on `like-14.1`. That separates the original
`like-14.2` report from any string semantics bug and shows this class of failure
belongs to strict browser timing thresholds around the pathological LIKE/GLOB
performance tests.

No harness skip or workaround was introduced.

## Artifacts

- `test-runs/kad-wtb13-like-node-full/summary.txt`
- `test-runs/kad-wtb13-like-node-full/testrunner.log`
- `test-runs/kad-wtb13-like-browser-full/summary.txt`
- `test-runs/kad-wtb13-like-browser-full/testrunner.log`
- `test-runs/kad-wtb13-like-browser-full-rerun-default/summary.txt`
- `test-runs/kad-wtb13-like-browser-full-rerun-default/testrunner.log`
- `test-runs/kad-wtb13-like-browser-full-1g/summary.txt`
- `test-runs/kad-wtb13-like-browser-full-1g/testrunner.log`
