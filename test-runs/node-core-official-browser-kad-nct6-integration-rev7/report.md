# Browser Host Official Node.js Core Test Run

Issue: `kad-nct.6`
Host: `browser`
Target branch at run time: `origin/integration/kad-nct-node-core-tests`
Target revision at run time: `1ba6e4ec96144dd1161c36283609b79532679124`
Runtime symlink: `binaries/programs/wasm32/spidermonkey-node.wasm`
Runtime cache target: `/Users/brandon/.cache/kandelo/programs/spidermonkey-node-140.11.0esr-node.1-rev7-wasm32-103d026c/node.wasm`
Upstream Node source: `nodejs/node` tag `v22.0.0`, commit `12fb157f79da8c094a54bc99370994941c28c235`

Command:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host browser --results-dir test-runs/node-core-official-browser-kad-nct6-integration-rev7
```

The harness completed and returned per-test results for all 10 selected official tests. The command exited 1 because every manifest entry is currently expected `PASS` and every result was an unexpected `FAIL`.

## Summary

Totals:

- `FAIL`: 10

Browser harness status:

- `browser-console.log` contains only Vite startup and client connection messages.
- No browser test timed out.
- No selected test was missing a browser-runner result.
- Every test exited with code 3 after a Node-compat assertion or module/runtime error.

## Node Host Comparison

The same manifest was also run on the Node host with the same rev7 runtime:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --results-dir test-runs/node-core-official-node-kad-nct6-integration-rev7
```

The Node host also reported `FAIL=10`. The root failure classes below reproduce on Node and browser, so this run did not find a remaining browser-host harness blocker.

## Failure Classes

| Test | First browser failure | Root-cause direction |
| --- | --- | --- |
| `test/parallel/test-path.js` | `AssertionError: Unexpected global(s) found: ...` | `kad-d6z` fixed the earlier invalid-argument failure; this test now reaches Node's `test/common` global leak check and fails on exposed SpiderMonkey shell globals. |
| `test/parallel/test-events-list.js` | `AssertionError: Unexpected global(s) found: ...` | Same global surface leak from SpiderMonkey shell helpers after the EventEmitter/Symbol assertions complete. |
| `test/parallel/test-timers-clear-null-does-not-throw-error.js` | `AssertionError: Unexpected global(s) found: ...` | Same global surface leak from SpiderMonkey shell helpers. |
| `test/parallel/test-buffer-alloc.js` | `AssertionError: 'no error' throws 'error'` at `new Uint8Array(kMaxLength + 1)` | `buffer.kMaxLength` does not match the actual typed-array allocation limit exposed by the SpiderMonkey runtime. |
| `test/parallel/test-console-count.js` | `AssertionError: '' === 'default: 1\n'` | `console.count()` writes through a path that bypasses a test override of `process.stdout.write`, even though stdout captures `default: 1`. |
| `test/parallel/test-querystring.js` | `AssertionError: false == true` in `check()` | `querystring.parse()` returns an object that is still `instanceof Object`; the official test expects Node's null-prototype parse result. |
| `test/parallel/test-string-decoder.js` | `TypeError: class constructors must be invoked with 'new'` | `StringDecoder.call(obj)` compatibility is missing; Node supports calling `StringDecoder` without `new` to initialize an existing object. |
| `test/parallel/test-whatwg-url-custom-searchparams.js` | `AssertionError: 1 === 10` | `URLSearchParams.append()`/`getAll()` behavior does not retain all appended converted values for this Node test case. |
| `test/parallel/test-url-parse-query.js` | `TypeError: url.Url is not a constructor` | Legacy `url.Url` constructor is not exported/implemented. |
| `test/parallel/test-util-inspect.js` | `Error: Cannot find module 'internal/test/binding'` | This selected official test uses `--expose-internals` and requires `internal/test/binding`; the Node-compat runtime or harness needs an explicit support boundary for that internal test dependency. |

See `summary.json`, `results.ndjson`, `browser-console.log`, and `stderr/*.log` in this directory for the complete per-test details.
