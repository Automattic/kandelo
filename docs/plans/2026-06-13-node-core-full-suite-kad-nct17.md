# Node Core Full-Suite Correction (`kad-nct.17`)

**Date:** 2026-06-13
**Node source:** `nodejs/node` `v22.0.0`
**Peeled commit:** `12fb157f79da8c094a54bc99370994941c28c235`
**Suite:** `test/parallel/test-*.js`
**Selected tests:** 3382

`kad-nct.17` supersedes the earlier selected-manifest epic status. The official
core JavaScript module correction run discovers every upstream Node v22.0.0
`test/parallel/test-*.js` file and expects all 3382 files to pass. Full-suite
mode has no pre-run exclusions; the checked-in manifest is only a smoke and
targeted-run aid.

## Commands

Scope explanation:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --explain
```

Node host full suite:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --jobs 4 --timeout-ms 10000 --results-dir test-runs/node-core-official-node-full-kad-nct17
```

Browser host full-suite attempt:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host browser --jobs 4 --timeout-ms 10000 --results-dir test-runs/node-core-official-browser-full-kad-nct17-host-timeout
```

Browser authority sentinel:

```bash
scripts/run-node-core-official-tests.sh --host node --test test/parallel/test-kandelo-sentinel.js --timeout-ms 10000 --results-dir test-runs/node-core-official-node-sentinel-kad-nct17
scripts/run-node-core-official-tests.sh --host browser --jobs 1 --test test/parallel/test-kandelo-sentinel.js --timeout-ms 10000 --results-dir test-runs/node-core-official-browser-sentinel-kad-nct17
```

The sentinel was a temporary cache-only upstream test file containing:

```js
'use strict';
throw new Error('kandelo sentinel failure');
```

It was removed from `.cache/node-core-official/node-v22.0.0` after the sentinel
runs.

## Environment

- Runner Node: `v24.15.0`
- Runner platform: `darwin/arm64`
- Runtime: `local-binaries/programs/wasm32/spidermonkey-node.wasm`
- Source checkout:
  `.cache/node-core-official/node-v22.0.0`
- Guest markers recorded by the harness:
  `NODE_SKIP_FLAG_CHECK=1`, `NODE_DISABLE_COLORS=1`, `TERM=dumb`, `CI=1`

## Artifacts

- Node full suite:
  `test-runs/node-core-official-node-full-kad-nct17/`
- Browser full-suite attempt:
  `test-runs/node-core-official-browser-full-kad-nct17-host-timeout/`
- Node sentinel:
  `test-runs/node-core-official-node-sentinel-kad-nct17/`
- Browser sentinel:
  `test-runs/node-core-official-browser-sentinel-kad-nct17/`

Each run preserves `summary.txt`, `summary.json`, `results.ndjson`,
`manifest.used.json`, and per-test stdout/stderr logs. Browser runs also
preserve `browser-console.log`.

## Results

| Host | Status | Selected | PASS | FAIL | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| Node | Authoritative | 3382 | 7 | 3375 | Full run completed. |
| Browser | Attempted, blocked | 3382 | 3382 reported | 0 reported | Full run completed, but counts are not authoritative because the sentinel throwing test also reported PASS. |

Browser blocker: `kad-nct.18`. The browser full-suite artifacts are still useful
as evidence that the page/VFS transport can attempt all 3382 files, but they
must not be used as proof that the browser host passes the suite until
BrowserKernel/spidermonkey-node propagates uncaught JS exceptions to stderr and
non-zero exit status.

The Node-host PASS files are:

- `test/parallel/test-regression-object-prototype.js`
- `test/parallel/test-source-map-enable.js`
- `test/parallel/test-v8-coverage.js`
- `test/parallel/test-v8-stop-coverage.js`
- `test/parallel/test-v8-take-coverage-noop.js`
- `test/parallel/test-v8-take-coverage.js`
- `test/parallel/test-zlib-no-stream.js`

## Node Failure Groups

The table below uses the first non-empty stderr line as the primary grouping so
that teardown assertions do not mask earlier root causes. A separate
contains-pattern scan found 3354 files containing the Node `test/common`
unexpected-global assertion, even when another error appeared first.

| Primary group | Count | Tracking |
| --- | ---: | --- |
| Node `test/common` unexpected global leak assertion | 1455 | `kad-nct.11` |
| Missing module/API surface (`Cannot find module`, `not implemented`, missing worker adapter APIs) | 457 | `kad-nct.21` |
| TypeError semantic mismatch | 447 | `kad-nct.23` |
| Assertion semantic mismatch | 391 | `kad-nct.23`, with selected narrow bugs `kad-nct.12`-`kad-nct.15` |
| `http.createServer` not implemented | 269 | `kad-nct.20` |
| Shared tmpdir/process identity collision (`test/.tmp.0`) | 194 | `kad-nct.19` |
| `cluster.fork` missing | 48 | `kad-nct.22` |
| Other primary `Error` mismatches | 42 | `kad-nct.23` |
| `child_process.fork`/`cp.fork` missing | 33 | `kad-nct.22` |
| Other/empty stderr | 24 | `kad-nct.23` |
| Timeout as primary group | 12 | `kad-nct.24` |
| Stream buffer encoding mismatch | 2 | `kad-nct.23` |
| `querystring.stringify()` undefined input bug | 1 | `kad-nct.13` |
| PASS | 7 | none |

Contains-pattern counts that cut across primary groups:

- Unexpected global assertion: 3354
- `test/.tmp.0` collision: 194
- `http.createServer` missing: 269
- `Cannot find module`: 474
- `cluster.fork` missing: 48
- `fork`/`cp.fork` missing: 82
- Timeout result: 13

## Follow-Up Beads

- `kad-nct.11`: existing global leak bug, updated with the full-suite counts.
- `kad-nct.18`: browser host false-PASS/exit-status blocker.
- `kad-nct.19`: tmpdir/process identity collisions.
- `kad-nct.20`: HTTP server API support.
- `kad-nct.21`: missing built-in/internal module and API surface.
- `kad-nct.22`: `child_process.fork` and `cluster.fork` semantics.
- `kad-nct.23`: remaining assertion/TypeError semantic mismatch triage.
- `kad-nct.24`: unexplained full-suite timeouts.
- `kad-nct.12`-`kad-nct.15`: existing selected narrow runtime bugs for
  Buffer, querystring, StringDecoder, and URLSearchParams.
