# SpiderMonkey Official Test Harness

This integration branch adopts a minimal official SpiderMonkey JS-shell
harness from PR #1. The harness lets Mozilla's upstream Python runners execute
Kandelo's `js.wasm` through either the Node.js host or the browser host without
requiring a native `js` executable.

## Commands

Smoke one small jstest and one small jit-test on both hosts:

```bash
scripts/run-spidermonkey-official-tests.sh --host both --suite both --smoke
```

Run a specific host or suite:

```bash
scripts/run-spidermonkey-official-tests.sh --host node --suite jstests --smoke
scripts/run-spidermonkey-official-tests.sh --host browser --suite jit-tests -- --read-tests /tmp/jit-list.txt
```

Run the exhaustive chunked harness:

```bash
scripts/run-spidermonkey-official-all.sh --host node --suite jstests --jobs 1 --no-slow
```

The exhaustive runner writes `inventory.tsv`, `summary.tsv`, per-chunk logs, and
`progress.log` under `test-results/spidermonkey-official/` by default. Use
`--results-dir DIR` to put artifacts somewhere else, and `--start-at CHUNK` to
resume after an interrupted run.

## Harness Shape

The Node host path starts `scripts/kandelo-node-js-shell-server.ts`, which keeps
a `NodeKernelHost` alive and serves shell invocations over localhost. The wrapper
script `scripts/kandelo-js-shell-wrapper.sh` becomes the executable `js` path
passed to Mozilla's harness.

The browser path starts `scripts/kandelo-browser-js-shell-server.ts`, which
launches Chromium through Playwright, serves the `spidermonkey-test` Vite page,
and forwards each harness invocation to `window.__runSpiderMonkeyScript`. The
browser page restores `apps/browser-demos/public/spidermonkey-test.vfs.zst`,
where `/usr/bin/js` and the upstream `js/src/tests` and `js/src/jit-test` trees
are staged. If Playwright reports that the page execution context was lost while
a shell invocation is in flight, the bridge reopens the page and retries that
same invocation a bounded number of times before reporting an infrastructure
failure to the upstream harness.

`scripts/ensure-spidermonkey-source.sh` locates or downloads the Firefox ESR
source tree pinned by the SpiderMonkey package manifest. The browser VFS builder
uses the same source tree so absolute upstream test paths stay valid inside the
guest filesystem.

## Current Limitations

This branch intentionally does not adopt the broad PR #1 runtime changes:

- no global SDK `--max-memory=2147483648` default change
- no kernel `memory.rs` brk-limit semantic change
- no SpiderMonkey package patch or revision bump
- no mozglue interposer or 64-bit atomics patch import

Those changes need separate package/runtime diagnosis before they can be treated
as validated fixes. Current PR #1 CI failures were caused by SpiderMonkey build
errors around Mozilla assertions and `__builtin_return_address`, not by the
harness scripts themselves.

SpiderMonkey's `js.wasm` is intentionally not fork-instrumented. The browser
test VFS builder allows only the `/usr/bin/js` wasm artifact policy failure for
missing fork instrumentation; other stale wasm artifact failures still abort the
image save.

WPT jsshell is disabled by default through `SPIDERMONKEY_OFFICIAL_WPT=disabled`.
The exhaustive runner inventories Mozilla's `js/src/tests` and
`js/src/jit-test/tests`; WPT scope is tracked separately by the epic.
