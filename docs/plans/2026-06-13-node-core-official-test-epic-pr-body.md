<!--
PR title: Add official Node.js core module test harness
Suggested command:
gh pr create --base main --head integration/kad-nct-node-core-tests --title "Add official Node.js core module test harness" --body-file docs/plans/2026-06-13-node-core-official-test-epic-pr-body.md
-->

## Summary

This PR adds the first official Node.js core JavaScript module test harness for
Kandelo's SpiderMonkey-backed Node-compatible runtime. The harness is pinned to
upstream `nodejs/node` `v22.0.0` at peeled commit
`12fb157f79da8c094a54bc99370994941c28c235`, discovers the complete upstream
`test/parallel/test-*.js` suite by default, and runs each test file through
Kandelo's normal runtime path on either host.

The branch includes:

- Scope documentation for the official-test adoption boundary.
- `scripts/run-node-core-official-tests.sh` and
  `scripts/node-core-official-runner.ts`.
- A small public-API-focused manifest under `tests/node-core-official/` for
  smoke and targeted runs only.
- Browser test-runner support for serving the upstream source fixture tree,
  generated prelude, and runtime wasm through a same-origin Vite route.
- Recorded Node-host and browser-host result artifacts under
  `test-runs/node-core-official-*`.
- Runtime compatibility fixes already landed in this integration stack:
  `vm.runInNewContext`, Symbol-aware assertion parity, and invalid path
  argument validation.

## Validation Status

Pinned source:

- Repo: `https://github.com/nodejs/node.git`
- Tag: `v22.0.0`
- Tag object: `ec49bec48284ab642db1d109d917c6ae3b695c13`
- Peeled commit: `12fb157f79da8c094a54bc99370994941c28c235`

Full-suite correction artifacts:

- Node host:
  `test-runs/node-core-official-node-full-kad-nct17/`
- Browser host attempt:
  `test-runs/node-core-official-browser-full-kad-nct17-host-timeout/`
- Browser authority sentinel:
  `test-runs/node-core-official-node-sentinel-kad-nct17/` and
  `test-runs/node-core-official-browser-sentinel-kad-nct17/`

Full-suite commands:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --jobs 4 --timeout-ms 10000 --results-dir test-runs/node-core-official-node-full-kad-nct17
scripts/run-node-core-official-tests.sh --fetch-source --host browser --jobs 4 --timeout-ms 10000 --results-dir test-runs/node-core-official-browser-full-kad-nct17-host-timeout
```

Both full-suite runs used upstream Node `v22.0.0` peeled commit
`12fb157f79da8c094a54bc99370994941c28c235`, runner Node `v24.15.0` on
`darwin/arm64`, and the current integration runtime staged at
`local-binaries/programs/wasm32/spidermonkey-node.wasm`.

The browser host completed an attempt over all 3382 files, but its reported
PASS count is not authoritative. A temporary throwing sentinel test failed
correctly on the Node host and incorrectly reported `PASS`/`exitCode=0` with
empty stdout/stderr on the browser host. Tracking: `kad-nct.18`.

Final counts:

| Host | Selected | PASS | FAIL / unexpected | Timeout | Authority |
| --- | ---: | ---: | ---: | ---: | --- |
| Node | 3382 | 7 | 3375 | 13 timeout results included in FAIL | Authoritative |
| Browser | 3382 | 3382 reported | 0 reported | 0 reported | Not authoritative until `kad-nct.18` is fixed |

The Node-host failure grouping is in
`docs/plans/2026-06-13-node-core-full-suite-kad-nct17.md`. Primary first-line
groups:

| Group | Count | Tracking |
| --- | ---: | --- |
| Node `test/common` unexpected global leak assertion | 1455 | `kad-nct.11` |
| Missing module/API surface | 457 | `kad-nct.21` |
| TypeError semantic mismatch | 447 | `kad-nct.23` |
| Assertion semantic mismatch | 391 | `kad-nct.23`, plus `kad-nct.12`-`kad-nct.15` for selected narrow bugs |
| `http.createServer` not implemented | 269 | `kad-nct.20` |
| Shared tmpdir/process identity collision | 194 | `kad-nct.19` |
| `cluster.fork` missing | 48 | `kad-nct.22` |
| Other primary `Error` mismatches | 42 | `kad-nct.23` |
| `child_process.fork`/`cp.fork` missing | 33 | `kad-nct.22` |
| Other/empty stderr | 24 | `kad-nct.23` |
| Timeout as primary group | 12 | `kad-nct.24` |
| Stream buffer encoding mismatch | 2 | `kad-nct.23` |
| `querystring.stringify()` undefined input bug | 1 | `kad-nct.13` |

## Unsupported And Excluded Scope

The full-suite correction has no pre-run exclusions: all 3382 upstream
`test/parallel/test-*.js` files are selected and expected to pass. Unsupported
native, V8, inspector, platform, or environment assumptions are recorded as
concrete failures or timeouts and then grouped into follow-up beads.

The support-boundary policy is in
`docs/plans/2026-06-12-node-core-js-test-scope.md`; the `kad-nct.17` correction
and counts are in
`docs/plans/2026-06-13-node-core-full-suite-kad-nct17.md`.

Classes that may become explicit support-boundary exclusions in later manifests
must be justified; they are not hidden from the full-suite correction:

- Native addons, Node-API, C++ tests, `.node` loads, and
  `process.dlopen()` are outside this harness boundary.
- V8-only internals, inspector/debugger/profiling hooks, snapshots, coverage,
  and V8-specific stack/format details are outside this SpiderMonkey-backed
  runtime contract.
- Libuv/native handle internals, exact TTY/pipe handle behavior, and
  host-specific signal/job-control expectations are excluded unless a later
  bead expands the supported behavior.
- External network access, host filesystem permission tests outside the mounted
  VFS, CLI restart/flag tests, and Python `tools/test.py` orchestration are
  harness-host escape hatches and are not run here.
- Official tests that require Node private internals must be represented as
  explicit `SKIP` entries with reasons, not as unexplained failures.

## Follow-Up Work

- `kad-nct.18`: fix the browser false-PASS/exit-status blocker before treating
  browser PASS counts as authoritative.
- `kad-nct.11`: fix Node global surface leaks, now observed in 3354 full-suite
  Node-host stderr logs.
- `kad-nct.19`-`kad-nct.24`: full-suite failure classes created by
  `kad-nct.17`.
- `kad-nct.12`-`kad-nct.15`: existing selected narrow runtime bugs still linked
  from the full-suite semantic mismatch group.
- `kad-nct.8`: open or update the GitHub PR using the command in the comment at
  the top of this file after this full-suite correction is reviewed.
