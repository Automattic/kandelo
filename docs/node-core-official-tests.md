# Official Node.js Core Test Harness

`scripts/run-node-core-official-tests.sh` runs selected official Node.js
JavaScript core-module tests against Kandelo's Node-compatible runtime.

The harness is pinned to upstream `nodejs/node` tag `v22.0.0`, tag object
`ec49bec48284ab642db1d109d917c6ae3b695c13`, peeled commit
`12fb157f79da8c094a54bc99370994941c28c235`. It sparse-checks out
`test/parallel`, `test/common`, `test/fixtures`, and `lib` when run with
`--fetch-source`.

Common commands:

```bash
scripts/run-node-core-official-tests.sh --explain
scripts/run-node-core-official-tests.sh --list --smoke
scripts/run-node-core-official-tests.sh --fetch-source --smoke --host node
scripts/run-node-core-official-tests.sh --fetch-source --smoke --host browser
```

Useful controls:

- `--host node|browser` selects the Kandelo host.
- `--source-dir DIR` uses an existing upstream checkout.
- `--runtime FILE` overrides the resolved `spidermonkey-node.wasm` or
  `node.wasm` binary.
- `--timeout-ms N` overrides the per-test timeout.
- `--jobs N` controls Node-host concurrency. Browser runs stay serial because
  each test creates a fresh kernel and SharedArrayBuffer-backed process memory.
- `--area NAME`, `--test PATH`, and `--smoke` filter the manifest.

Artifacts are written under `test-runs/node-core-official-<host>-<mode>/` by
default, or under `--results-dir`. Each run preserves `summary.txt`,
`summary.json`, `results.ndjson`, `manifest.used.json`, and per-test
`stdout/*.log` and `stderr/*.log`; browser runs also preserve
`browser-console.log`.
