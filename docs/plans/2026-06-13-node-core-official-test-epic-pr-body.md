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

Final authoritative artifacts:

- Node host:
  `test-runs/node-core-official-node-final/`
- Browser host:
  `test-runs/node-core-official-browser-final/`

Final commands:

```bash
scripts/run-node-core-official-tests.sh --fetch-source --host node --results-dir test-runs/node-core-official-node-final
scripts/run-node-core-official-tests.sh --fetch-source --host browser --results-dir test-runs/node-core-official-browser-final
```

Both final runs used the same selected 10-test manifest, upstream Node
`v22.0.0` peeled commit `12fb157f79da8c094a54bc99370994941c28c235`, and the
current integration runtime staged at
`local-binaries/programs/wasm32/spidermonkey-node.wasm` from package
`spidermonkey-node` revision 8. Both hosts completed all executable selected
tests and recorded the explicit manifest skip. No test timed out. No browser
result was missing. `test-runs/node-core-official-browser-final/browser-console.log`
contains only Vite startup/client messages.

Final counts:

| Host | Selected | PASS | FAIL / unexpected | SKIP / support boundary | Timeout | Harness / resource failure |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node | 10 | 0 | 9 | 1 | 0 | 0 |
| Browser | 10 | 0 | 9 | 1 | 0 | 0 |

Superseded artifacts are retained for history but are not the final status:
`test-runs/node-core-official-node-kad-nct6-integration-rev7/` and
`test-runs/node-core-official-browser-kad-nct6-integration-rev7/` were recorded
against the pre-`kad-nct.9` rev7 runtime and reported `FAIL=10` on both hosts.
They are excluded from the final counts above.

The final shared failures are:

| Area | Tests | Classification | Tracking |
| --- | --- | --- | --- |
| Process global surface | `test-path.js`, `test-events-list.js`, `test-console-count.js`, `test-url-parse-query.js`, `test-timers-clear-null-does-not-throw-error.js` | Runtime bug: DOM/Web and Kandelo helper globals still leak into Node's `test/common` global-leak check: `__kandeloRunDueTimers`, `__kandeloNextTimerDelay`, `__kandeloCreateWorkerThreads`, `argv0`, `execArgv`, `TextEncoder`, `TextDecoder`, `btoa`, `atob`, `Blob`, `File`, `FormData`, `MessagePort`, `MessageChannel`, `BroadcastChannel`, `Event`, `EventTarget`, `MessageEvent`, `CloseEvent`, `ErrorEvent`, `DOMException`, `AbortSignal`. | `kad-nct.11` |
| Buffer | `test-buffer-alloc.js` | Runtime bug: `buffer.kMaxLength` still does not match the actual typed-array allocation limit; the test expected allocation past `kMaxLength` to throw. | `kad-nct.12` |
| Query string | `test-querystring.js` | Runtime bug: `querystring.stringify()` still throws `TypeError: can't convert undefined to object` for an official-test input. | `kad-nct.13` |
| String decoder | `test-string-decoder.js` | Runtime bug: UTF-8 replacement handling differs from Node for invalid byte sequence `c9 b5 a9 41`. | `kad-nct.14` |
| URL | `test-whatwg-url-custom-searchparams.js` | Runtime bug: `URLSearchParams` percent-encodes unpaired surrogate values differently from Node, preserving `%ED...` instead of replacement-character `%EF%BF%BD`. | `kad-nct.15` |
| Util internals | `test-util-inspect.js` | Support-boundary SKIP: selected official test requires Node's private `--expose-internals` path and `internal/test/binding` native hooks. | Manifest skip |

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
