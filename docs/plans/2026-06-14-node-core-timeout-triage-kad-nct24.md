# Node Core Timeout Triage (`kad-nct.24`)

**Date:** 2026-06-14
**Source run:** `kad-nct.17`
**Node source:** `nodejs/node` `v22.0.0`
**Peeled commit:** `12fb157f79da8c094a54bc99370994941c28c235`
**Artifact source:** `test-runs/node-core-official-node-full-kad-nct17/`

`kad-nct.17` recorded 13 Node-host full-suite results with
`error=timeout after 10000ms`. The primary first-line grouping counted 12
timeout rows because `test-worker-terminate-microtask-loop.js` also wrote
stderr before the harness timeout.

This triage reran the timeout rows with focused Node-host selections. The
original 10s budget was too low for two long-running rows, but most rows remain
true runtime-progress bugs under a 30s per-test timeout.

## Method

The baseline set comes from:

```bash
jq -r '.results[] | select((.error // "") | contains("timeout after 10000ms")) | .path' \
  test-runs/node-core-official-node-full-kad-nct17/summary.json
```

Focused reruns used the same pinned Node source and
`local-binaries/programs/wasm32/spidermonkey-node.wasm` runtime:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --jobs 1 \
  --timeout-ms 30000 --results-dir <case-dir> --test <official-test>
```

A 13-test batch with `--timeout-ms 60000` exposed a separate runner cleanup
hang: the batch exceeded the 13 x 60s worst-case budget, wrote no
`results.ndjson`, and had to be interrupted. That cleanup issue is tracked
separately by `kad-nct.52`; focused single-test reruns used an outer shell
timeout so one stuck cleanup path could not block the investigation.

## Results

| Test | 30s focused result | Root-cause direction | Tracking |
| --- | --- | --- | --- |
| `test/parallel/test-buffer-tostring-rangeerror.js` | Timeout at 30s; the 60s batch stderr showed SpiderMonkey OOM/unreachable during oversized Buffer string conversion. | Buffer/string length guard should throw `ERR_STRING_TOO_LONG` before allocating into an unhandleable OOM path. | `kad-nct.12`, `kad-nct.32` |
| `test/parallel/test-fs-readdir-stack-overflow.js` | Exited after 29.5s with the known `test/common` unexpected-global assertion. | Not a persistent timeout at the default 30s budget; it is slow stack-overflow coverage plus global-surface cleanup noise. | `kad-nct.11` |
| `test/parallel/test-repl-array-prototype-tempering.js` | Timeout at 30s with empty stdout/stderr. | Interactive REPL child never reaches the prompt/evaluation/`.exit` sequence expected by the test. | `kad-nct.51` |
| `test/parallel/test-repl-unsafe-array-iteration.js` | Timeout at 30s with empty stdout/stderr. | Same interactive REPL prompt/evaluation hang as above. | `kad-nct.51` |
| `test/parallel/test-stream-pipe-needDrain.js` | Timeout at 30s with empty stdout/stderr. | Writable backpressure does not make `write()` return false or otherwise fails to drive the drain/pause lifecycle. | `kad-nct.26` |
| `test/parallel/test-stringbytes-external.js` | Exited after 27.2s with the known unexpected-global assertion. | Not a persistent timeout at the default 30s budget; the large string/Buffer workload completes, then global-surface cleanup fails. | `kad-nct.11` |
| `test/parallel/test-timers-immediate-queue.js` | Timeout at 30s with empty stdout/stderr. | `setImmediate` queue draining appears to starve the timer phase or run recursively queued immediates in the same turn. | `kad-nct.53` |
| `test/parallel/test-timers-zero-timeout.js` | Timeout at 30s with empty stdout/stderr. | Zero-delay interval/timer progress or callback argument delivery does not reach the expected clear condition. | `kad-nct.53` |
| `test/parallel/test-timers.js` | Timeout at 30s with empty stdout/stderr. | Invalid/zero/large delay coercion and timer/interval progress do not match Node's scheduling expectations. | `kad-nct.53` |
| `test/parallel/test-util-inspect-long-running.js` | Timeout at 30s with empty stdout/stderr. | `util.inspect()` on a deep/circular object is still too slow or non-terminating for the official long-running regression. | `kad-nct.45` |
| `test/parallel/test-vm-timeout.js` | Timeout at 30s with empty stdout/stderr. | `vm.runInThisContext()` / `runInNewContext()` timeout options do not interrupt infinite loops. | `kad-nct.30` |
| `test/parallel/test-worker-abort-on-uncaught-exception-terminate.js` | Timeout at 30s with empty stdout/stderr. | `Worker.terminate()` does not interrupt a CPU-bound worker running `while(true)`. | `kad-nct.54` |
| `test/parallel/test-worker-terminate-microtask-loop.js` | Timeout at 30s; stderr also contains the known unexpected-global assertion plus a worker `TypeError`. | `Worker.terminate()` does not interrupt a recursive microtask loop; global-surface cleanup also appears in stderr. | `kad-nct.54`, `kad-nct.11` |

## Follow-Up Beads

- `kad-nct.11`: existing global-surface leak assertion. It explains
  `test-fs-readdir-stack-overflow.js`, `test-stringbytes-external.js`, and the
  extra stderr in `test-worker-terminate-microtask-loop.js` once those tests run
  long enough to emit stderr.
- `kad-nct.12` and `kad-nct.32`: Buffer allocation/string conversion guards for
  `test-buffer-tostring-rangeerror.js`.
- `kad-nct.26`: stream Writable backpressure and drain state for
  `test-stream-pipe-needDrain.js`.
- `kad-nct.30`: VM execution-timeout enforcement for `test-vm-timeout.js`.
- `kad-nct.45`: `util.inspect()` termination/performance for
  `test-util-inspect-long-running.js`.
- `kad-nct.51`: new REPL interactive prompt/evaluation hang follow-up for both
  REPL timeout rows.
- `kad-nct.52`: new runner/host timeout-cleanup follow-up so timed-out Node-host
  tests cannot hang the entire official-suite runner.
- `kad-nct.53`: new timer/immediate event-loop progress follow-up for the three
  timer timeout rows. Existing `kad-nct.39` remains the timer API/ref/dispose
  surface bead.
- `kad-nct.54`: new worker termination follow-up for busy CPU and microtask-loop
  workers. Existing `kad-nct.41` remains the MessagePort/BroadcastChannel
  surface bead.

## Verification Notes

This bead is triage-only. The concrete verification is that every
`kad-nct.17` timeout artifact is now mapped to a specific runtime bug,
expected long-running/global-leak behavior, or runner cleanup blocker. Follow-up
fix beads should rerun their affected official tests on both Node and browser
hosts and then rerun the full-suite grouping to confirm no unexplained timeout
rows remain.
