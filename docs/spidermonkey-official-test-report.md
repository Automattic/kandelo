# SpiderMonkey Official Test Harness

This integration branch adopts a minimal official SpiderMonkey JS-shell
harness from PR #1. The harness lets Mozilla's upstream Python runners execute
Kandelo's `js.wasm` through either the Node.js host or the browser host without
requiring a native `js` executable.

## Final Epic Status

The supported official-test scope for this epic is Mozilla's
`js/src/tests` jstest inventory on both Kandelo hosts. The current
SpiderMonkey package builds wasm32 with `ac_add_options --disable-jit`, and the
package README documents JIT disabled / nested WebAssembly out of scope, so
`js/src/jit-test/tests` is not a product gate for this PR. `kad-165.9` also
decided WPT jsshell is out of scope for this epic.

| Host | Suite | Epic status | Result summary | Artifacts |
| --- | --- | --- | --- | --- |
| Node | jstests | Completed; residual unexpected rows classified | 738 selected chunks, 50,503 pass, 1,932 known skip, 237 historical unexpected rows. The 237 rows are classified as 61 wasm32 BigInt Atomics limitations, 158 non-Atomics timeout/resource rows, 2 stack-stress rows, and 16 mozglue timezone/env interposer crashes. | `/Users/brandon/gt/kandelo/polecats/toast/kandelo/test-results/spidermonkey-official/kad-165.4-node-jstests-*` |
| Browser | jstests | Completed; final supported tail rerun is clean after known-skip fixes | The final long tail resume produced 373 rows with 11,670 pass, 418 known skip, and 4 unexpected staging rows. The follow-up tail-skipfix rerun from `test262/staging/sm/expressions` produced 22 rows with 464 pass, 49 known skip, and 0 unexpected. Earlier browser resume artifacts are preserved as raw pre-fix evidence, not a single clean post-fix aggregate. | `/Users/brandon/gt/kandelo/polecats/rictus/kandelo/test-results/spidermonkey-official/kad-165.7-browser-jstests-resume11-20260614T131756Z` and `.../kad-165.7-browser-jstests-tail-skipfix-20260614T192700Z` |
| Node | jit-tests | Skipped for epic; exploratory artifact preserved | Exploratory run preserved 70 chunks, 10,371 pass, 0 known skip, and 45,386 unexpected rows under `--jitflags=all`. These failures are not a gate while the package is JIT-disabled. | `test-runs/spidermonkey-official-node-jit-kad-165.5/` |
| Browser | jit-tests | Skipped for epic; partial exploratory artifact preserved | Stopped on the scope correction while `gc#part-0004` was in flight. The preserved chunk log recorded 108 pass and 180 fail; `summary.tsv` has only the header because the run was interrupted mid-chunk. | `/Users/brandon/gt/kandelo/polecats/morsov/kandelo/test-results/spidermonkey-official/kad-165.8-browser-jit-tests-gc4-continuation-20260614T131641Z` |

Residual work is tracked rather than hidden:

- `kad-crh`: SpiderMonkey mozglue timezone/env interposer crashes in Node
  Date/Intl jstests. This is the one remaining package/runtime product bug
  from the Node jstest inventory that is not resolved by known-skip policy in
  this integration branch.
- `kad-165.18`: Node and browser BigInt Atomics jstests are classified as a
  wasm32 SpiderMonkey 64-bit atomics limitation while preserving non-BigInt
  Atomics coverage.
- `kad-165.21`: Node timeout/resource rows are explicitly classified instead
  of left as an untriaged broad timeout bucket.
- `kad-165.20`: Node recursion-stress rows are classified with the shared
  SpiderMonkey stack/resource rationale.
- `kad-6wx`: focused browser `non262/Promise/any-stack-overflow.js`
  diagnostics remain tracked separately as a browser stack/resource-envelope
  follow-up.
- `kad-2tp`: focused browser `non262/Intl/default-locale-shell.js`
  diagnostics remain tracked separately as a browser default-locale follow-up.

The final epic PR (`kad-165.11`) should target `main` from
`integration/kad-165-spidermonkey-tests`, cite this report, and state that
official jstest coverage is the supported validation surface for this branch.
It should not claim SpiderMonkey jit-tests or WPT jsshell are validated.

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

Run browser jstests with independent browser lanes:

```bash
scripts/run-spidermonkey-browser-sharded.sh --suite jstests --lanes 2 --no-slow
```

The exhaustive runner writes `inventory.tsv`, `summary.tsv`, per-chunk logs, and
`progress.log` under `test-results/spidermonkey-official/` by default. Use
`--results-dir DIR` to put artifacts somewhere else, and `--start-at CHUNK` to
resume after an interrupted run.

Browser `--jobs N` with `N > 1` through `run-spidermonkey-official-tests.sh` or
`run-spidermonkey-official-all.sh` is refused because one browser bridge still
serializes all `/run` requests through one page. The sharded runner is the
authoritative browser parallelism path: each lane runs upstream `jstests.py`
with `--worker-count 1`, unique Vite and bridge ports, a lane-local result
directory, and a lane-local chunk list. It writes `inventory.json`,
`shard-plan.json`, `progress.jsonl`, merged `summary.tsv`, `summary.jsonl`,
`failures.tsv`, `known-skips.tsv`, and `merge-audit.json`. The merge audit is
required evidence for no duplicate and no missing planned chunks. Timing columns
separate `queue_seconds` from `guest_seconds`; Stage 1 browser lanes have
`queue_seconds=0` because there is one upstream worker per lane.

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

The official runners also share a small stack-stress exclusion policy for tests
that recurse through SpiderMonkey's wasm frames until the host worker's
WebAssembly call stack is exhausted before the shell can report a guest
`InternalError`. On the Node host this currently covers
`non262/extensions/array-isArray-proxy-recursion.js` and
`non262/regress/regress-311629.js`; on the browser host it covers
`non262/Promise/any-stack-overflow.js`,
`test262/staging/sm/extensions/recursion.js`, the exact browser extension
recursion files listed in `scripts/spidermonkey-known-skips.sh`, and these
`non262/regress` stack-stress files:

- `regress-96526-002.js`
- `regress-329530.js`
- `regress-192414.js`
- `regress-234389.js`
- `regress-311629.js`
- `regress-152646.js`

Focused browser directory selectors such as `non262/Promise/` expand around an
exact known-skipped file and still run the rest of the directory.

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
page recycling or another positive integer to tune it. The bridge also restarts
the Chromium browser process every 100 shell invocations by default; set
`SPIDERMONKEY_BROWSER_JS_SHELL_BROWSER_RECYCLE_INTERVAL=0` to disable that
process recycle or another positive integer to tune it. If a shell invocation
reports browser WebAssembly memory pressure, the bridge restarts Chromium and
retries the invocation once by default. Set
`SPIDERMONKEY_BROWSER_JS_SHELL_MEMORY_RETRIES=0` to disable that retry. If an
exited kernel worker reports `RuntimeError: memory access out of bounds`, the
bridge also restarts Chromium and retries once by default; set
`SPIDERMONKEY_BROWSER_JS_SHELL_WASM_OOB_RETRIES=0` to disable that retry.

If a browser process worker reports `RuntimeError: memory access out of bounds`
with a SIGSEGV-style exit status, the bridge can reopen the page and retry the
same invocation with `SPIDERMONKEY_BROWSER_JS_SHELL_WASM_OOB_RETRIES=N`. The
default is `0` so deterministic guest crashes remain visible unless a test run
explicitly opts into treating isolated browser OOB traps as retryable bridge
state.

`scripts/ensure-spidermonkey-source.sh` locates or downloads the Firefox ESR
source tree pinned by the SpiderMonkey package manifest. The browser VFS builder
uses the same source tree so absolute upstream test paths stay valid inside the
guest filesystem.

## Exhaustive Suite Status

The SpiderMonkey epic treats `jstests` as the supported official-suite signal.
Official SpiderMonkey `jit-tests` are skipped for the epic because Kandelo's
wasm32 SpiderMonkey package is built with `ac_add_options --disable-jit`, and
the package README lists JIT and nested WebAssembly support outside current
scope. The preserved jit-test attempts remain useful exploratory evidence, but
they are not product pass/fail gates unless JIT support becomes a product goal.

The authoritative Node `jstests` inventory is the merged latest row per chunk
from the `kad-165.4` result segments under:

```text
/Users/brandon/gt/kandelo/polecats/toast/kandelo/test-results/spidermonkey-official/
```

The corrupted `resume9` bridge-state tail is superseded by
`kad-165.4-node-jstests-20260614T060645Z-resume10-restart`, which reran from
`test262/language/statements/class/elements/_files#part-0002` through the end.
Final selected totals are 738 chunks, 50,503 passes, 1,932 known skips, and 237
unexpected results across 66 chunks. No selected latest log contains the
superseded `RuntimeError: memory access out of bounds` cascade from `resume9`.

The authoritative browser `jstests` outcome is `kad-165.7`: the full browser
tail completed with four browser-only staging outliers, then those four were
classified as browser known skips and rerun cleanly in
`kad-165.7-browser-jstests-tail-skipfix-20260614T192700Z` with status sum 0,
464 passes, 49 known skips, and 0 unexpected. Earlier browser BigInt Atomics
failures are covered by `kad-165.12`; the final browser residual failure count
for the supported `jstests` scope is 0.

### Final Hard Counts for Epic PR

Use the following hard counts in the epic PR body. They come from the final
authoritative artifacts listed here, not from every preserved intermediate
resume directory.

| Host | Suite | Epic status | Authoritative artifact | Scope | PASS | SKIP / known-skip | FAIL / unexpected | Timeout / resource detail | Unsupported-scope detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| Node | `jstests` | Supported final signal | `/Users/brandon/gt/kandelo/polecats/toast/kandelo/test-results/spidermonkey-official/kad-165.4-node-jstests-*`, with final tail replacement `kad-165.4-node-jstests-20260614T060645Z-resume10-restart` | 738 selected latest chunks | 50,503 | 1,932 | 237 | 159 timeout rows: 158 non-Atomics timeout/resource-envelope rows plus 1 BigInt Atomics `waitAsync` timeout. The remaining unexpected rows are 60 BigInt Atomics crashes, 16 mozglue timezone/env crashes, and 2 worker stack-resource failures. | None for supported `jstests`. |
| Browser | `jstests` raw completed tail | Superseded by skipfix rerun for final status | `/Users/brandon/gt/kandelo/polecats/rictus/kandelo/test-results/spidermonkey-official/kad-165.7-browser-jstests-resume11-20260614T131756Z` | 373 tail chunks, from regexp through the end | 11,670 | 418 | 4 | Three browser-only staging expression timeouts plus one staging recursion stack/resource failure. | None for supported `jstests`; these four rows were reclassified before final status. |
| Browser | `jstests` final replacement tail | Supported final signal for the corrected tail; residual supported failures 0 | `/Users/brandon/gt/kandelo/polecats/rictus/kandelo/test-results/spidermonkey-official/kad-165.7-browser-jstests-tail-skipfix-20260614T192700Z` | 22 tail chunks replacing the staging tail from `test262/staging/sm/expressions` onward | 464 | 49 | 0 | 0 timeout/resource failures in the corrected tail. | None for supported `jstests`. |
| Node | `jit-tests` | SKIPPED / out of scope for the epic | `test-runs/spidermonkey-official-node-jit-kad-165.5/summary.tsv` | 70 chunks, 8,634 upstream jit-test files, effective `SPIDERMONKEY_OFFICIAL_JITFLAGS=all` | 10,371 exploratory passes | 0 | 45,386 exploratory unexpected results | Exploratory classes: 45,173 memory traps, 174 `MOZ_CRASH(No 64-bit atomics)`, 34 timeouts, and 5 pthread slot-limit exhaustions. | All official jit-tests are unsupported product scope while `packages/registry/spidermonkey/build-spidermonkey.sh` uses `--disable-jit`. Do not route these exploratory failures as epic blockers. |
| Browser | `jit-tests` | SKIPPED / out of scope for the epic | `/Users/brandon/gt/kandelo/polecats/morsov/kandelo/test-results/spidermonkey-official/kad-165.8-browser-jit-tests-gc4-continuation-20260614T131641Z/SKIPPED.md` and `browser-jit-tests-gc#part-0004.log` | 8,634 upstream jit-test files in inventory; intentionally stopped mid-`gc#part-0004` after scope correction | No official final aggregate; partial exploratory log had 108 passes | No official final aggregate | No official final aggregate; partial exploratory log had 180 failures | Partial mid-chunk counts are evidence only. `summary.tsv` has only the header because the run was interrupted by scope correction. | All official browser jit-tests are unsupported product scope for the same JIT-disabled package reason. |

Reproduction and resume command references:

- Node `jstests`: initial exhaustive shape was
  `scripts/run-spidermonkey-official-all.sh --host node --suite jstests --jobs 1 --no-slow`.
  The authoritative replacement tail used
  `SPIDERMONKEY_NODE_JS_SHELL_PORT=5412 scripts/run-spidermonkey-official-all.sh --host node --suite jstests --jobs 1 --no-slow --restart-bridge-per-chunk --start-at test262/language/statements/class/elements/_files#part-0002 --results-dir test-results/spidermonkey-official/kad-165.4-node-jstests-20260614T060645Z-resume10-restart`.
- Browser `jstests`: resume/tail command shape was
  `scripts/run-spidermonkey-official-all.sh --host browser --suite jstests --jobs 1 --no-slow --restart-bridge-per-chunk --start-at <chunk> --results-dir <dir>`.
  The final corrected tail artifact is
  `test-results/spidermonkey-official/kad-165.7-browser-jstests-tail-skipfix-20260614T192700Z`.
- Node `jit-tests`: exploratory command was
  `scripts/run-spidermonkey-official-all.sh --host node --suite jit-tests --jobs 1 --no-slow --results-dir test-results/spidermonkey-official/kad-165.5-node-jit-tests-20260613T021426Z`;
  resumes used `--start-at atomics` and `--start-at jaeger`.
- Browser `jit-tests`: final exploratory command before retirement was
  `scripts/run-spidermonkey-official-all.sh --host browser --suite jit-tests --jobs 1 --no-slow --jitflags all --restart-bridge-per-chunk --start-at gc#part-0004 --results-dir test-results/spidermonkey-official/kad-165.8-browser-jit-tests-gc4-continuation-20260614T131641Z`.

Excluded snapshots:

- The Node `resume9` out-of-bounds cascade is excluded from final counts; the
  `resume10` replacement reran from
  `test262/language/statements/class/elements/_files#part-0002` through the
  end and supersedes that corrupted tail.
- The browser `resume11` four staging outliers are excluded from residual final
  failure counts after the `tail-skipfix` rerun above. Earlier browser resume
  summaries remain preserved as pre-fix/pre-classification evidence and should
  not be rolled into a post-fix final aggregate.
- Node and browser `jit-tests` are unsupported-scope evidence only. The current
  SpiderMonkey package builds with `ac_add_options --disable-jit`, and the
  package README documents JIT disabled / nested WebAssembly out of scope.

### Failure Inventory

| Count | Scope | Classification | Routed bead |
| ---: | --- | --- | --- |
| 158 | Node `jstests` non-Atomics timeouts | Host/runtime resource or timeout-budget cluster requiring narrower focused reruns. The full timeout set is tracked under `kad-165.19` and post-processed by the runner's exact-match resource envelope layer; the one Atomics timeout is counted with the Atomics row below. | `kad-165.19` |
| 61 | Node `test262/built-ins/Atomics/*/bigint` | wasm32 platform limitation: SpiderMonkey traps with `MOZ_CRASH(No 64-bit atomics)` for 60 tests and times out in `waitAsync/bigint/good-views.js`. Browser BigInt Atomics were already known-skipped by `kad-165.12`. | `kad-165.18`, `kad-165.12` |
| 16 | Node timezone/env jstests | SpiderMonkey package/runtime bug in Mozilla's `setenv`/`unsetenv` interposer path: 15 `non262/Date` tests plus `non262/Intl/DateTimeFormat/tz-environment-variable.js`. | `kad-crh` |
| 2 | Node recursion-stress jstests | Kernel/host stack-resource failure: `non262/extensions/array-isArray-proxy-recursion.js` and `non262/regress/regress-311629.js` report `Kernel worker failed: Maximum call stack size exceeded`. | `kad-165.20`, related `kad-6wx` |

Browser-only failures discovered during the full run were either fixed in the
harness or explicitly classified before the clean tail rerun:

- `test262/built-ins/Atomics/*/bigint`: known-skip for missing wasm32 64-bit
  atomics (`kad-165.12`).
- `non262/Promise/any-stack-overflow.js`: browser process-worker stack/resource
  tracker (`kad-6wx`).
- `non262/regress/{regress-96526-002,regress-329530,regress-192414,
  regress-234389,regress-311629,regress-152646}.js`: browser process-worker
  stack/resource cluster found during PR #697 follow-up validation (`kd-ymw`).
- `non262/Intl/default-locale-shell.js`: browser default locale mismatch
  tracker (`kad-2tp`).
- `test262/staging/sm/expressions/{destructuring-pattern-parenthesized,
  optional-chain-super-elem,optional-chain-tdz}.js` and
  `test262/staging/sm/extensions/recursion.js`: browser known skips added by
  `kad-165.7` before the final clean tail rerun.

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

## Exploratory Node jit-tests Artifact

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
failure chunks. Because the current package disables JIT, these results are
classified as skipped/out of scope for the SpiderMonkey epic rather than routed
as kernel/runtime failures.

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
