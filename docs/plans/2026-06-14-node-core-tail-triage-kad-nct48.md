# Node Core One-Off Tail Triage (`kad-nct.48`)

**Date:** 2026-06-14
**Source run:** current `origin/integration/kad-nct-node-core-tests`
**Node source:** `nodejs/node` `v22.0.0`
**Artifact source:** `test-runs/node-core-official-node-full-kad-nct48-rerun/`

`kad-nct.48` reran the Node-host full official `test/parallel` suite after the
first wave of `kad-nct.23` module-cluster fixes had landed on the integration
branch. This is not a final epic status run: several larger clusters are still
open or not present on this branch. The purpose of this run is to make the
remaining small one-off tail actionable.

Command:

```bash
scripts/dev-shell.sh scripts/run-node-core-official-tests.sh --fetch-source --host node --jobs 4 --timeout-ms 10000 --results-dir test-runs/node-core-official-node-full-kad-nct48-rerun
```

Summary:

| Status | Count |
| --- | ---: |
| PASS | 1253 |
| FAIL | 2126 |
| SKIP | 3 |

## Tail Mapping

| Tail area | Current evidence | Tracking |
| --- | --- | --- |
| Self-exec CLI option and exit status | `test-cli-*`, `test-math-random.js`, `test-startup-large-pages.js`, `test-security-revert-unknown.js`, `test-unhandled-exception-rethrow-error.js`, and preload rows use `spawnSync(process.execPath, ...)` and receive `status: null`, empty output, or `/usr/bin/node` `ENOENT`. | `kad-nct.61` |
| `node:test` runner | 20 runner rows still fail, including CLI reporter output, exit codes, mocks, `test.only`, `internal/test_runner` helpers, and concurrency. | `kad-nct.62` |
| Bootstrap and preload | `test-bootstrap-modules.js` reports Node internal module load-list mismatches; preload rows still fail through self-exec or `/usr/bin/node` lookup. | `kad-nct.63` |
| `test/common` helpers | `test-common-countdown.js` and `test-common-must-not-call.js` still differ in helper diagnostic text and child stderr behavior. | `kad-nct.64` |
| `--disable-proto` | `test-disable-proto-delete.js` and `test-disable-proto-throw.js` do not enforce delete/throw behavior across the main realm, vm contexts, and workers. | `kad-nct.65` |
| Dotenv / `--env-file` | `test-dotenv.js` does not populate `process.env` from `valid.env`; edge-case and `NODE_OPTIONS` rows also hit `/usr/bin/node` self-exec gaps. | `kad-nct.66` |
| `os` module | `test-os.js` leaks a host/nix-shell tmp path, priority constants and `availableParallelism()` are missing, and homedir child checks still fail. | `kad-nct.67` |
| Punycode | `test-punycode.js` fails because `punycode.encode` is missing. | `kad-nct.68` |
| Source-map API | `test-source-map-api.js` fails because `module.SourceMap` is not constructible and `findSourceMap()` behavior is incomplete. | `kad-nct.69` |
| Querystring residuals | `test-querystring-escape.js` throws on malformed input Node accepts; `test-querystring-maxKeys-non-finite.js` coerces `maxKeys` incorrectly. | `kad-nct.70` |
| V8-only shared value conveyor | `test-experimental-shared-value-conveyor.js` depends on `--harmony-struct` and `globalThis.SharedArray`, a V8-specific experimental surface. | `kad-nct.71` |
| HTTP `IncomingMessage` / `OutgoingMessage` residuals | Incoming/outgoing rows still miss internal/prototype methods such as `_addHeaderLine`, `_renderHeaders`, `setTimeout`, socket state, and Writable completion behavior. | `kad-nct.72` |
| StringDecoder residuals | `test-string-decoder.js`, `test-string-decoder-end.js`, and `test-string-decoder-fuzz.js` still fail. | Existing `kad-nct.14`, updated with current evidence |

## Already Resolved Or Reclassified

- `test-memory-usage.js` and `test-memory-usage-emfile.js` pass in the
  `kad-nct.48` rerun. The remaining `test-worker-memory.js` failure is due to
  missing `os.availableParallelism()` and is tracked by `kad-nct.67`.
- The REPL interactive prompt/evaluation timeout rows are now manifest `SKIP`
  support boundaries from `kad-nct.51`.
- The original `kad-nct.23` note said the HTTP incoming/outgoing constructor
  rows were covered by `kad-nct.29`. The current run shows residual HTTP class
  and lifecycle failures, so they are tracked explicitly by `kad-nct.72`.

## Caveats

This run used the current integration branch runtime artifact resolved at
`binaries/programs/wasm32/spidermonkey-node.wasm`. Beads for some other large
clusters have closed or are in recovery, but their code or manifest updates are
not necessarily present in this branch. Final epic pass/fail/skip numbers
should come from a later hard status run after the open larger clusters and
recovery beads land.
