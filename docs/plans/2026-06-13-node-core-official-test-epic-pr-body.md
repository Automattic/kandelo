<!--
PR title: Add official Node.js core module test harness
Suggested command:
gh pr create --base main --head integration/kad-nct-node-core-tests --title "Add official Node.js core module test harness" --body-file docs/plans/2026-06-13-node-core-official-test-epic-pr-body.md
-->

## Summary

This PR adds the first official Node.js core JavaScript module test harness for
Kandelo's SpiderMonkey-backed Node-compatible runtime. The harness is pinned to
upstream `nodejs/node` `v22.0.0` at peeled commit
`12fb157f79da8c094a54bc99370994941c28c235`, sparse-checks out only the selected
official test material, and runs each selected `test/parallel/test-*.js` file
through Kandelo's normal runtime path on either host.

The branch includes:

- Scope documentation for the official-test adoption boundary.
- `scripts/run-node-core-official-tests.sh` and
  `scripts/node-core-official-runner.ts`.
- A small public-API-focused manifest under `tests/node-core-official/`.
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

Recorded comparison artifacts:

- Node host:
  `test-runs/node-core-official-node-kad-nct6-integration-rev7/`
- Browser host:
  `test-runs/node-core-official-browser-kad-nct6-integration-rev7/`

Both hosts completed the same 10-test manifest and returned per-test results.
No browser test timed out, no browser result was missing, and
`browser-console.log` contains only Vite startup/client messages. The recorded
rev7 run reported `FAIL=10` on both hosts, which classifies the failures as
shared Node-compat/runtime gaps rather than browser harness blockers.

The shared failures were root-caused as:

| Area | Tests | Classification | Tracking |
| --- | --- | --- | --- |
| Process global surface | `test-path.js`, `test-events-list.js`, `test-timers-clear-null-does-not-throw-error.js` | Runtime bug: SpiderMonkey shell helpers leak as unexpected globals under Node's `test/common` global-leak check. | `kad-nct.9`, MR `kad-wisp-fkf` |
| Buffer | `test-buffer-alloc.js` | Runtime bug: `buffer.kMaxLength` does not match the actual typed-array allocation limit. | `kad-nct.9`, MR `kad-wisp-fkf` |
| Console | `test-console-count.js` | Runtime bug: `console.count()` bypasses a test override of `process.stdout.write`. | `kad-nct.9`, MR `kad-wisp-fkf` |
| Query string | `test-querystring.js` | Runtime bug: `querystring.parse()` returns an object that is still `instanceof Object`; Node expects a null-prototype result. | `kad-nct.9`, MR `kad-wisp-fkf` |
| String decoder | `test-string-decoder.js` | Runtime bug: `StringDecoder.call(obj)` throws because the shim is class-only. | `kad-nct.9`, MR `kad-wisp-fkf` |
| URL | `test-whatwg-url-custom-searchparams.js`, `test-url-parse-query.js` | Runtime bug: `URLSearchParams.append()`/`getAll()` duplicate handling and legacy `url.Url` constructor parity are missing. | `kad-nct.9`, MR `kad-wisp-fkf` |
| Util internals | `test-util-inspect.js` | Support-boundary SKIP: selected official test requires Node's private `--expose-internals` path and `internal/test/binding` native hooks. | `kad-nct.9`, MR `kad-wisp-fkf` |

`kad-nct.9` is closed and has MR `kad-wisp-fkf` targeting
`integration/kad-nct-node-core-tests` at commit
`74d7ec5d8ae295763490155a273a6129df60be88`. That MR updates the runtime parity
layer for the public API gaps and marks the internal-only `util.inspect` case as
an explicit manifest `SKIP`.

Before opening this PR, confirm `kad-wisp-fkf` has landed in
`integration/kad-nct-node-core-tests`, then rerun:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --results-dir test-runs/node-core-official-node-final
scripts/run-node-core-official-tests.sh --fetch-source --host browser --results-dir test-runs/node-core-official-browser-final
```

Expected post-`kad-nct.9` manifest status is `PASS=9`, `SKIP=1` on both hosts:
the nine public API tests should pass, and `test-util-inspect.js` should be
skipped with the documented `internal/test/binding` support-boundary reason.

## Unsupported And Excluded Scope

The initial manifest is intentionally small and public-API focused. The full
scope policy is in `docs/plans/2026-06-12-node-core-js-test-scope.md`.

Current exclusions are not hidden failures:

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

- `kad-nct.8`: open or update the GitHub PR using the command in the comment at
  the top of this file after the `kad-nct.9` MR has landed and the final
  two-host official runs have been recorded.
- Future beads can expand the manifest area by area using the adoption boundary
  in `docs/plans/2026-06-12-node-core-js-test-scope.md`. Each expansion should
  classify unsupported official expectations as `SKIP` and real in-scope gaps as
  `XFAIL` or tracked runtime bugs.
