# kad-nct.4 Node-Host Official Node.js Core Run

Command:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --results-dir test-runs/node-core-official-node-kad-nct4
```

Setup notes:

- Initial harness attempt failed before running tests because `node_modules/` was absent and `fzstd` could not be resolved from `host/src/vfs/memory-fs.ts`.
- Ran `npm ci` at the repo root and `npm --prefix host ci`.
- Runtime wasm was initially absent. A bare `scripts/fetch-binaries.sh --allow-stale` failed to link `xtask` because `libbz2` was unavailable outside the project dev shell.
- Reran via `scripts/dev-shell.sh bash scripts/fetch-binaries.sh --allow-stale`; cached `node`, `node-vfs`, and `spidermonkey-node` artifacts materialized. The broad fetch was stopped after it moved on to unrelated `texlive` source build work.

Source/runtime:

- Upstream Node.js tag: `v22.0.0`
- Upstream commit: `12fb157f79da8c094a54bc99370994941c28c235`
- Source checkout: `.cache/node-core-official/node-v22.0.0`
- Runtime: `binaries/programs/wasm32/spidermonkey-node.wasm`

Summary:

- Selected tests: 10
- Expected: 10 PASS
- Actual: 10 FAIL
- Unexpected: 10
- Timeouts: 0
- Exit code for each failed test process: 3

Per-test first failures:

| Test | First failure | Common exit assertion |
| --- | --- | --- |
| `test/parallel/test-path.js` | `AssertionError: no error throws error` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-querystring.js` | `TypeError: vm.runInNewContext is not a function` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-events-list.js` | `TypeError: can't convert symbol to string` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-buffer-alloc.js` | `AssertionError: no error throws error` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-string-decoder.js` | `TypeError: class constructors must be invoked with 'new'` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-whatwg-url-custom-searchparams.js` | `AssertionError: 1 === 10` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-url-parse-query.js` | `TypeError: url.Url is not a constructor` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-util-inspect.js` | `Error: Cannot find module 'internal/test/binding'` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-console-count.js` | `AssertionError:  === default: 1` | Unexpected SpiderMonkey shell/Kandelo globals |
| `test/parallel/test-timers-clear-null-does-not-throw-error.js` | No test-local failure before process exit | Unexpected SpiderMonkey shell/Kandelo globals |

Artifacts in this directory:

- `summary.txt`
- `summary.json`
- `results.ndjson`
- `manifest.used.json`
- `stdout/*.log`
- `stderr/*.log`
- `kandelo-node-core-prelude.js`

The stderr logs contain the complete stack traces and the full unexpected-global lists emitted by Node common on process exit.
