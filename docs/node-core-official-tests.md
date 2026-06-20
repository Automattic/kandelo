# Official Node.js Core Test Harness

`scripts/run-node-core-official-tests.sh` runs the complete official Node.js
`test/parallel/test-*.js` JavaScript suite against Kandelo's Node-compatible
runtime by default. The small checked-in manifest is now only for smoke and
targeted compatibility runs.

The harness is pinned to upstream `nodejs/node` tag `v22.0.0`, tag object
`ec49bec48284ab642db1d109d917c6ae3b695c13`, peeled commit
`12fb157f79da8c094a54bc99370994941c28c235`. It sparse-checks out
`test/parallel`, `test/common`, `test/fixtures`, and `lib` when run with
`--fetch-source`.

Common commands:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --explain
scripts/run-node-core-official-tests.sh --fetch-source --host node --jobs 4
scripts/run-node-core-official-tests.sh --fetch-source --host browser --jobs 4
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
- `--jobs N` controls runner concurrency. Browser jobs use separate pages; keep
  this low because each test creates a fresh kernel and SharedArrayBuffer-backed
  process memory.
- `--full-suite` discovers every upstream `test/parallel/test-*.js` file from
  the pinned source checkout. This is the default unless `--smoke` or
  `--manifest-only` is used. Discovered tests default to `PASS`; explicit
  manifest entries can override a discovered test after triage to record a
  support boundary such as `SKIP` or `XFAIL`.
- `--area NAME` and `--test PATH` filter the selected full suite or manifest.
- `--smoke` and `--manifest-only` use the checked-in manifest rather than the
  generated full-suite list.

Each selected test gets a unique `TEST_SERIAL_ID`/`TEST_THREAD_ID` and
`NODE_TEST_DIR`. Node-host roots live under the result artifact directory, and
browser roots live under `/node-v22.0.0/.kandelo-test-roots/` inside each test
VFS. This keeps upstream `test/common/tmpdir` paths isolated when runner jobs
execute tests against fresh Kandelo kernels that start user processes at the
same initial pid.

Browser runs start the Vite test-runner page with `KANDELO_BROWSER_DEMO_INPUTS`
set to `test-runner` and serve the pinned Node source, generated prelude, and
runtime wasm through an env-gated same-origin route. This avoids serializing the
large source fixture tree and runtime wasm through Playwright's `page.evaluate`
payload. The selected `test/parallel/test-*.js` file is fetched eagerly into the
browser VFS before the runtime starts so browser pass/fail/output reporting proves
the test body actually executed; shared `test/common`, `test/fixtures`, and `lib`
files remain lazy URL-backed data files.

The runner forwards upstream `// Flags:` entries only for compatibility flags
the runtime understands today. `--disable-proto=delete` and
`--disable-proto=throw` are passed on both Node and browser hosts, split out of
`process.argv` into `process.execArgv`, and enforced by the SpiderMonkey
Node-compatible bootstrap for the main realm, `node:vm` contexts, and shell
worker startup.

Artifacts are written under `test-runs/node-core-official-<host>-<mode>/` by
default, or under `--results-dir`. Each run preserves `summary.txt`,
`summary.json`, `results.ndjson`, `manifest.used.json`, and per-test
`stdout/*.log` and `stderr/*.log`; browser runs also preserve
`browser-console.log`.

Full-suite mode discovers every upstream parallel test. Every discovered test
is expected to pass unless it has an explicit manifest override added after
triage. Unsupported native, V8, inspector, platform, or environment assumptions
should first be recorded as concrete failure or timeout artifacts, then moved
to a manifest `SKIP` or `XFAIL` only when the support boundary is understood
and documented in the manifest reason.

The current manifest records the two `node --interactive` REPL child-process
tests as `SKIP`: they require streaming `child_process` stdio connected to a
separately executing interactive REPL child, while Kandelo's Node compatibility
layer currently implements buffered popen-style child output.

The manifest also records `test-async-hooks-recursive-stack-runInAsyncScope.js`
as a browser-only `SKIP`: the Node host passes the official 1000-level
`AsyncResource.runInAsyncScope()` recursion check, but the browser host exhausts
the WebAssembly call stack inside the SpiderMonkey-in-Wasm process worker before
the test can complete. Treat this as a browser worker stack-capacity boundary,
not an expected Node test-level `RangeError`.

## SpiderMonkey VM Boundary

Kandelo's `node:vm` shim is backed by SpiderMonkey globals, not V8 isolates.
It supports context creation/execution, `Script` cached-data bookkeeping,
`Script#sourceMapURL`, `measureMemory` result-shape compatibility, and a small
`SourceTextModule`/`SyntheticModule` surface for simple module smoke cases.
Full V8 vm-module semantics remain a support boundary: async linker graphs,
V8 bytecode cache compatibility, timeout interruption, stack formatting, and
complete ES module live-binding behavior are not implemented by the shim.

The manifest is intentionally small and public-API focused. Tests that require
Node's private `--expose-internals` hooks, such as `internal/test/binding`, must
be marked as an explicit support-boundary `SKIP` with a reason instead of being
reported as runtime parity failures.

The SpiderMonkey Node-compatible runtime exposes `child_process.fork()` as a
best-effort process launcher backed by the normal Kandelo `exec` path for
`/usr/bin/node`. It does not provide Node's IPC channel semantics: `child.send()`
reports `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, and `cluster.fork()` is an
explicit unsupported platform boundary for the same reason. Official tests that
require fork IPC or cluster primary/worker coordination should be marked `SKIP`
with that reason instead of failing as missing functions.

## Current Full-Suite Status

`kad-nct.17` records the first complete correction run against Node v22.0.0:

- Node host: 3382 selected, 7 PASS, 3375 FAIL. Artifacts:
  `test-runs/node-core-official-node-full-kad-nct17/`.
- Browser host: all 3382 files were attempted, but the reported 3382 PASS
  result is not authoritative. A deliberate throwing sentinel test failed on
  the Node host and incorrectly reported PASS on the browser host, proving the
  browser path does not yet propagate uncaught JS exceptions to stderr and
  non-zero exit status. Tracking: `kad-nct.18`.

See `docs/plans/2026-06-13-node-core-full-suite-kad-nct17.md` for the exact
commands, artifact paths, root-cause grouping, and follow-up beads.

`kad-nct.23` further breaks the broad semantic TypeError and AssertionError
buckets into module-specific follow-up beads. See
`docs/plans/2026-06-14-node-core-semantic-mismatch-triage-kad-nct23.md` for the
fix bead breakdown.

`kd-ei6` restored browser sentinel authority for PR #693 by eager-mounting the
selected browser test file. A throwing sentinel now reports `FAIL` with stderr,
and a printing sentinel now reports `PASS` with stdout on both Node and browser
hosts. Re-run the browser full suite before treating any broad browser pass count
as current.

`kad-nct.24` breaks the original 13 Node-host timeout artifacts into specific
runtime-progress bugs, long-running rows, and a runner cleanup blocker. See
`docs/plans/2026-06-14-node-core-timeout-triage-kad-nct24.md`.

`kad-nct.48` reran the Node-host full suite on the current integration branch
and split the remaining one-off semantic tail into narrow follow-up beads. See
`docs/plans/2026-06-14-node-core-tail-triage-kad-nct48.md`.

The manifest is intentionally small and public-API focused. Tests that require
Node's private `--expose-internals` hooks, such as `internal/test/binding`, must
be marked as an explicit support-boundary `SKIP` with a reason instead of being
reported as runtime parity failures.

The Node-compatible `http.createServer()` support used by these tests is
same-process loopback support inside the runtime. It lets `http.request()` and
`http.get()` connect to a server created in the same Node-compatible process on
`localhost`/`127.0.0.1`, but it does not expose a real host-visible listening
port. Browser-facing HTTP server demos still use the kernel TCP listener and
service-worker HTTP bridge documented in `docs/browser-support.md`.

The SpiderMonkey Node-compatible bootstrap resolves the public modules and
private helper names that appear in the full `test/parallel/test-*.js` suite,
including `dgram`, `domain`, `repl`, `node:test`, `internal/errors`,
`internal/util`, and the `internal/test_runner/*` loader surface. Public modules
have small JavaScript compatibility shims. V8/native-only internals exposed
through `internal/test/binding` and low-level `internal/*` helpers resolve to
namespaces that throw `ERR_KANDELO_UNSUPPORTED_NODE_API` only when used, making
the boundary explicit instead of surfacing unexplained `Cannot find module`
failures. SpiderMonkey shell workers similarly expose shared-memory
`workerData`, same-isolate `MessageChannel`/`MessagePort`, and same-isolate
`BroadcastChannel`, but not Node's bidirectional post-start `worker_threads`
message channel. Official tests that require `Worker.postMessage()`/
`parentPort` after startup, live `MessagePort` ownership inside workers,
cross-worker `BroadcastChannel` delivery, V8 worker heap-limit enforcement, or
cross-vm moved-port wrapper identity are manifest `SKIP` entries with explicit
reasons.
