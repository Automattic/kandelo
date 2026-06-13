# Node Host Comparison Run

Issue: `kad-nct.6`
Host: `node`
Target branch at run time: `origin/integration/kad-nct-node-core-tests`
Target revision at run time: `1ba6e4ec96144dd1161c36283609b79532679124`
Runtime symlink: `binaries/programs/wasm32/spidermonkey-node.wasm`
Runtime cache target: `/Users/brandon/.cache/kandelo/programs/spidermonkey-node-140.11.0esr-node.1-rev7-wasm32-103d026c/node.wasm`
Upstream Node source: `nodejs/node` tag `v22.0.0`, commit `12fb157f79da8c094a54bc99370994941c28c235`

Command:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --results-dir test-runs/node-core-official-node-kad-nct6-integration-rev7
```

The Node-host comparison completed and returned per-test results for all 10 selected official tests. The command exited 1 because every manifest entry is currently expected `PASS` and every result was an unexpected `FAIL`.

Totals:

- `FAIL`: 10

This run was captured to compare with `test-runs/node-core-official-browser-kad-nct6-integration-rev7`. The same broad failure classes reproduce on Node and browser: SpiderMonkey shell global leakage, buffer typed-array limit exposure, console stdout interception, querystring null-prototype behavior, callable `StringDecoder`, URLSearchParams append/getAll behavior, legacy `url.Url`, and `internal/test/binding` for the selected util.inspect test. The earlier `test-path.js` invalid-argument failure is fixed in rev7 and that test now fails at the shared global-leak check.

See `summary.json`, `results.ndjson`, and `stderr/*.log` in this directory for the complete per-test details.
