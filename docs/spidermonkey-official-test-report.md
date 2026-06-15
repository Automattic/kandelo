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

On Node and browser hosts, the exhaustive runner classifies BigInt Atomics
jstest coverage as known skips: `test262/built-ins/Atomics/*/bigint`. On the
browser host, it also classifies `atomics/bigint-*.js` jit-tests as known skips.
Kandelo's current wasm32 SpiderMonkey build lacks native 64-bit atomic
operations, and those tests otherwise crash the shell with
`MOZ_CRASH("No 64-bit atomics")`; the rest of the atomics directories still run
normally.

On the Node host, the exhaustive jstest runner post-processes the 158
non-Atomics timeout/resource-envelope rows identified from the authoritative
`kad-165.4` inventory. The layer converts only exact listed
`TEST-UNEXPECTED-FAIL ... (TIMEOUT)` rows into `TEST-KNOWN-FAIL` rows. If one of
those tests passes, it remains a normal pass; if it fails for another reason, it
remains unexpected. Four deterministic single-file resource/stress timeouts are
called out separately in the runner, while the remaining listed rows are
documented as chunk/order-dependent Node host resource-envelope pressure from
long official jstest chunks. The BigInt Atomics `waitAsync` timeout remains
outside this layer because the wasm32 64-bit atomics limitation is tracked with
the Atomics classification work.

The official runners also share a small stack-stress exclusion policy for
tests that recurse through SpiderMonkey's wasm frames until the host worker's
WebAssembly call stack is exhausted before the shell can report a guest
`InternalError`. On the Node host this currently covers
`non262/extensions/array-isArray-proxy-recursion.js` and
`non262/regress/regress-311629.js`; the browser host keeps the same policy
shape for its existing recursion outlier.

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

The browser bridge also watches each Playwright `page.evaluate` from the Node
side using the wrapper timeout. This is separate from the page-local guest
timeout because a wedged browser execution can prevent page timers from firing
soon enough for the upstream harness. On a browser guest timeout, the bridge
closes the page context to discard the persistent `BrowserKernel`, opens a fresh
page, and retries the invocation once by default. Set
`SPIDERMONKEY_BROWSER_JS_SHELL_TIMEOUT_RETRIES=0` to disable that retry.
The bridge also recycles the browser page every 25 shell invocations by default
to release Chromium WebAssembly address space used by exited process workers.
Set `SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL=0` to disable periodic
recycling or another positive integer to tune it. If a shell invocation reports
`WebAssembly.Memory(): could not allocate memory`, the bridge treats that as
browser memory pressure, opens a fresh page context, and retries the invocation
once by default. Set `SPIDERMONKEY_BROWSER_JS_SHELL_MEMORY_RETRIES=0` to disable
that retry.

`scripts/ensure-spidermonkey-source.sh` locates or downloads the Firefox ESR
source tree pinned by the SpiderMonkey package manifest. The browser VFS builder
uses the same source tree so absolute upstream test paths stay valid inside the
guest filesystem.

## Exhaustive Node jstests Result

The `kad-165.4` Node host run of Mozilla's upstream `js/src/tests` jstest
inventory is preserved under:

```text
/Users/brandon/gt/kandelo/polecats/toast/kandelo/test-results/spidermonkey-official/
```

Selecting the latest valid row for each chunk across the preserved run and
resume segments gives 738 chunks, 50,503 passes, 1,932 known skips, and 237
unexpected results. The superseded `resume9` bridge-state corruption tail is
not part of those totals; `resume10-restart` superseded that tail with zero
unexpected results for the restarted class-statement range.

The 237 unexpected results are classified as:

| Count | Classification | Tracking |
| ---: | --- | --- |
| 61 | wasm32 BigInt Atomics platform limitation: 60 `MOZ_CRASH("No 64-bit atomics")` rows plus the deterministic `test262/built-ins/Atomics/waitAsync/bigint/good-views.js` timeout | `kad-165.18` |
| 16 | SpiderMonkey mozglue timezone/env interposer crashes in Node Date/Intl tests | `kad-crh` |
| 2 | recursion stress tests that trip the Node kernel worker call stack | `kad-165.20` |
| 158 | non-Atomics timeout/resource-envelope rows, split below | `kad-165.19` |

### Node jstest Timeout Classification

The timeout subset contains 159 `TEST-UNEXPECTED` timeout rows across 55
chunks. One of those is the BigInt Atomics timeout tracked by `kad-165.18`;
the remaining 158 are non-Atomics timeout/resource-envelope rows.

Segment distribution:

| Rows | Segment |
| ---: | --- |
| 113 | `kad-165.4-node-jstests-20260613T171924Z-resume8-retry` |
| 24 | `kad-165.4-node-jstests-20260613T114141Z-resume6-restart` |
| 14 | `kad-165.4-node-jstests-20260613T031900Z-resume4-restart` |
| 4 | `kad-165.4-node-jstests-20260614T051920Z-resume9` before the superseded corruption tail |
| 3 | `kad-165.4-node-jstests-20260613T003718Z` |
| 1 | `kad-165.4-node-jstests-20260613T021257Z-resume2` |

Largest timeout chunks:

| Rows | Chunk |
| ---: | --- |
| 10 | `test262/language/expressions/async-generator/_files#part-0001` |
| 8 | `test262/language/expressions/arrow-function` |
| 8 | `test262/language/expressions/async-generator/dstr` |
| 7 | `test262/language/expressions/class/elements/_files#part-0001` |
| 7 | `test262/language/expressions/object/method-definition` |
| 6 | `test262/built-ins/Set` |
| 6 | `test262/language/expressions/class/elements/_files#part-0002` |
| 6 | `test262/language/expressions/dynamic-import/usage` |
| 6 | `test262/language/expressions/object/dstr/_files#part-0001` |

Focused reruns on the current integration branch used the normal Node official
jstest harness with `--host node --suite jstests --jobs 1` and a shorter
`--timeout 20` to classify representatives quickly. A `KERNEL_SYSCALL_LOG=1`
rerun of `non262/TypedArray/sort_modifications_concurrent.js` with
`--timeout 5` showed the guest still active at the harness timeout, continuing
to issue clock/futex/mmap activity around the timeout boundary. That rules out a
completed guest process whose host cleanup merely failed to report exit.

Deterministic single-file timeout/resource rows observed in focused reruns:

- `non262/TypedArray/sort_modifications_concurrent.js`
- `shell/os.js`
- `non262/async-functions/syntax.js`
- `test262/built-ins/Set/prototype/union/size-is-a-number.js`
- `test262/built-ins/Atomics/waitAsync/bigint/good-views.js` (`kad-165.18`)

Representative timeout rows that passed in isolation under the same harness:

- `test262/built-ins/RegExp/prototype/Symbol.matchAll/species-constructor-species-throws.js`
- `test262/language/statements/async-generator/dstr/dflt-ary-ptrn-elem-id-init-fn-name-fn.js`
- `test262/language/expressions/dynamic-import/usage/nested-arrow-import-then-is-call-expression-square-brackets.js`
- `test262/language/expressions/async-generator/yield-star-next-not-callable-null-throw.js`
- `test262/language/expressions/object/method-definition/static-init-await-binding-accessor.js`
- `test262/built-ins/TypedArrayConstructors/internals/HasProperty/BigInt/infinity-with-detached-buffer.js`
- `test262/built-ins/decodeURI/S15.1.3.1_A1.11_T2.js`
- `test262/built-ins/isNaN/return-abrupt-from-tonumber-number.js`
- `test262/built-ins/Math/sin/S15.8.2.16_A5.js`
- `test262/built-ins/parseFloat/tonumber-numeric-separator-literal-nzd-nsl-dd.js`
- `test262/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-160.js`
- `test262/built-ins/Object/defineProperties/15.2.3.7-5-b-263.js`

Conclusion: the timeout cluster is not a single deterministic JavaScript engine
bug and not a generic post-exit host cleanup stall. It splits into a small
deterministic resource/stress set plus a larger chunk/order-dependent resource
pressure set in long official jstest chunks. The chunk-dependent rows should be
handled by an official expected-timeout/resource layer or by a follow-up harness
improvement that reruns timeout rows individually before recording them as
unexpected. The deterministic rows above should be tracked as explicit
SpiderMonkey resource/stress expected failures unless a later platform change
makes them pass under the supported timeout budget.

## Exhaustive Node jit-tests Result

The `kad-165.5` Node host run of the upstream `js/src/jit-test/tests` inventory
is preserved under `test-runs/spidermonkey-official-node-jit-kad-165.5/`. It
used `scripts/run-spidermonkey-official-all.sh --host node --suite jit-tests
--jobs 1 --no-slow` with the effective jit flag coverage left at the runner
default, `SPIDERMONKEY_OFFICIAL_JITFLAGS=all`.

The committed artifact bundle contains the merged `summary.tsv`, 70 per-chunk
logs, 70 per-chunk input lists, `inventory.tsv`, `progress.log`, and `run.log`.
Final merged totals were 10,371 passes, 0 known skips, and 45,386 unexpected
results across 70 chunks. The dominant unexpected classes were 45,173
`RuntimeError: memory access out of bounds` results, 174
`MOZ_CRASH(No 64-bit atomics)` results, 34 timeouts, and 5 pthread slot-limit
exhaustions. See the artifact README for the exact resume commands and largest
failure chunks.

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
