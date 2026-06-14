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

Browser runs start the Vite test-runner page with `KANDELO_BROWSER_DEMO_INPUTS`
set to `test-runner` and serve the pinned Node source, generated prelude, and
runtime wasm through an env-gated same-origin route. This avoids serializing the
large source fixture tree and runtime wasm through Playwright's `page.evaluate`
payload.

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
