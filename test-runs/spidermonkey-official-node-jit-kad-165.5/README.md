# SpiderMonkey Node jit-tests exhaustive run

This directory preserves the completed `kad-165.5` Node host run of Mozilla's
`js/src/jit-test/tests` inventory through Kandelo's chunked official
SpiderMonkey runner.

## Command

Initial run:

```bash
scripts/dev-shell.sh bash -lc 'export SPIDERMONKEY_NODE_JS_SHELL_PORT=55372; bash scripts/run-spidermonkey-official-all.sh --host node --suite jit-tests --jobs 1 --no-slow --results-dir test-results/spidermonkey-official/kad-165.5-node-jit-tests-20260613T021426Z'
```

Resume checkpoints used the same runner with `--start-at atomics` and then
`--start-at jaeger`. The final successful resume set
`SPIDERMONKEY_WASM=$PWD/binaries/programs/wasm32/js.wasm` and
`SPIDERMONKEY_NODE_JS_SHELL_PORT=55390` before rerunning from `jaeger`.

Effective jit flag coverage was `all`, the script default from
`SPIDERMONKEY_OFFICIAL_JITFLAGS`; no `--jitflags` override was used.

## Artifacts

- `summary.tsv`: merged full run summary with paths rewritten to the committed
  per-chunk log files.
- `logs/node-jit-tests-*.log`: one upstream harness log per executed chunk.
- `chunks/jit-*.txt`: exact per-chunk jit-test input lists used by the runner.
- `inventory.tsv`: final 70-row chunk inventory.
- `progress.log`: chunk start markers and resume skips from the preserved run.
- `run.log`: shell transcript with command, resume, and bridge context.

## Totals

| Metric | Count |
| --- | ---: |
| Chunks executed | 70 |
| Chunk logs | 70 |
| Chunk input lists | 70 |
| Status 0 chunks | 11 |
| Status 2 chunks | 59 |
| Passed tests | 10,371 |
| Known skips | 0 |
| Unexpected results | 45,386 |

Largest unexpected-result chunks:

| Chunk | Unexpected |
| --- | ---: |
| `wasm#part-0001` | 5,170 |
| `wasm#part-0002` | 3,697 |
| `ion#part-0002` | 3,000 |
| `debug#part-0001` | 3,000 |
| `ion#part-0001` | 2,988 |
| `basic#part-0002` | 2,982 |
| `debug#part-0002` | 2,978 |
| `basic#part-0003` | 2,814 |
| `gc` | 2,742 |
| `basic#part-0001` | 1,908 |

Normalized `TEST-UNEXPECTED` classes:

| Class | Count |
| --- | ---: |
| `RuntimeError: memory access out of bounds` | 45,173 |
| `MOZ_CRASH(No 64-bit atomics)` | 174 |
| `Timeout` | 34 |
| `process pthread slot limit exhausted` | 5 |

The 64-bit atomics failures are Node-host results. The browser-host runner has
separate browser-only known-skip handling for BigInt atomics, but this Node run
preserved the default `--jitflags=all` behavior requested by the bead.
