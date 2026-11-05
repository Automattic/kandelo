# Test and benchmark public contracts

This completes the **negative source audit** of the public test/benchmark
family: the required framework surface is missing on all four guest hosts.
It does not complete any implementation or establish runtime conformance.
No tests, probes, compilation or builds ran. Exact requirement ranges,
member observations and future unchanged-source test identities are in
`testing-requirements.json`, `api-matrix.json` and
`testing-validation-candidates.json`.

## Admission, namespaces and descriptors

`lib/test.js` exports the callable test function, with test/it identity,
suite/describe identity, hooks, run and getTestContext. Its mock, snapshot
and assert are enumerable/configurable lazy getters with cached results;
snapshot and assert return null-prototype dictionaries. The harness's
`runInParentContext` adds expectFailure/skip/todo/only shorthand functions
to test and suite, including their aliases. These shorthand methods need
not have independent prose headings to remain in scope.

`lib/test/reporters.js` exposes dot, junit and tap as lazy getters; spec
and lcov are enumerable/configurable, non-writable function values that
construct the actual implementation. Function names, arity, regular
function prototype descriptors and alias identities are real observable
requirements. The saved descriptor capture has no getter-result or
complete returned-context coverage. It is not the public surface limit.

`lib/bench.js` exports the callable bench function, bound shared-runner
functions, suite/describe and createRunner/run/runFile. Bench/reporters
has lazy json and constructible spec wrapper. These modules are
scheme-only and require `--experimental-bench`; the target emits its
experimental warning, with the specific benchmark child-context exception
in bench.js. `src/node_options.cc`:343–480,749 onward owns activation,
mode conflicts, isolation validation and benchmark-related options.

The candidate's final builtin registry (`bootstrap.js`:5771–6110)
supplies none of these four modules. Its policy lists cannot instantiate
their factories. The absence applies to all required members, including
returned contexts, streams, runner objects and mock objects; it is not
limited to top-level export names. No native hidden implementation or
embedding-host runner is connected as the missing guest framework.

## Node test requirements and missing behavior

| Area | Required public semantics and target source |
|---|---|
| Test/suite invocation | `test.md`:19–126,1891–2133 and `harness.js`:389–420: overload/name/fn precedence, synchronous, Promise or callback settlement; callback plus returned Promise fails. Outstanding subtests are cancelled on parent completion, while suites collect declarations. Each invocation returns the target Promise at the appropriate phase, not merely an emitted label. |
| Results/selection | `test.md`:204–610: skip/todo/expected-failure precedence; TODO bodies execute without causing process failure, context skip does not stop a running function. Expected-failure matching uses assert.throws semantics, including label/match objects. Only/name/tag selection includes ancestor and exclusion rules and must preserve hook behavior. Tags have strict validation, canonical union and frozen context arrays; boolean filters have precedence and wildcard/untagged rules. |
| Reruns/randomization | `test.md`:128–168,760–846: durable location/disambiguation-based rerun records, attempt state, still-failing TODO reruns, seeded file/queued-test randomization and incompatible watch mode. This is not a documented per-test automatic `retries` option; the earlier survey's generic retry wording was imprecise. |
| Async identity and late work | `harness.js`:111–160,436–443, `test.js`:271–537 and `test.md`:612–645,4066–4187: owner context through async resources, undefined outside an active test, hook context and tracing-channel propagation. Late subtests and unhandled exceptions/rejections produce real failure/diagnostic state after earlier reporting; reporter errors are not falsely attributed to a test. |
| Hooks/cleanup | `test.md`:2135–2257,4207–4323: suite and per-test hooks, callbacks/Promise support, inherited timeouts/signals, after/afterEach even on failure. Resources and mocks are restored when their owner finishes. Tests that block synchronously cannot be interrupted merely by a scheduled timeout. |
| Plans/assertions | `test.js`:193–269,324–365, `assert.js`, `test.md`:2259–2325,4325–4500,4662–4748: context-bound assertion counting, assert registration/replacement, mock-call assertions, exact count checks and delayed plan wait starting after the test body. Direct assert use does not increment the test's plan. Snapshot comparison/generation requires actual serialized values and files; serializers chain synchronously and paths resolve through the configured function. |
| Context/metadata | `test.js`:271–537, `test.md`:4502–5039: TestContext/SuiteContext are returned to callbacks, not module constructor exports. Metadata includes entry file versus declaration file, full name, owner signal, passed/error.cause, attempts, worker ID and frozen tags. TestContext also supplies lazily owned mock/assert, subtests, polling waitFor and immediate structured log versus buffered diagnostic. WaitFor rejects with its latest condition error as cause after timeout and retires both timers. |
| Mocks | `mock/mock.js`:93–805, `test.md`:2327–2892: callable Proxy behavior including constructor calls, this/result/throw/stack records, copied call/access history, one-call/access overrides and automatic times restoration. Method/getter/setter/property mocks preserve/recover descriptors and inherited lookup. Module mocks affect future CJS/ESM/JSON/builtin loads under their actual loader flag, with cache/exports validation and restoration; prior references stay unchanged. |
| Mock lifecycle | reset restores and disassociates; restoreAll restores without disassociation. Per-test trackers automatically reset. Module mocking resolves through synchronous customization hooks, including dual-package CJS resolution; async hooks are not promised to affect it. Deprecated defaultExport/namedExports options remain supported under their real deprecation policy, rather than being silently omitted or always warned. |
| Virtual timers | `mock/mock_timers.js`:69–76,697–819, `test.md`:2894–3496: one virtual clock for selected module/global timers and Date, associated clear functions, reset/disposal and owner cleanup. tick advances and executes due work; setTime changes the clock without running due timers. runAll advances to the furthest currently scheduled timer through tick. Already destructured original functions are not retroactively replaced. |
| Runner/CLI | `test.md`:647–895,1698–1890 and `runner.js`, `utils.js`, `src/node_options.cc`: real file/glob/TS discovery, per-file process isolation/concurrency versus shared context, force-exit, watch dependency ownership, global setup/teardown, filters/shards, preloads/options/environment inheritance, signals and inspector ports. Files can be ordinary scripts. Setup failure prevents tests and teardown. Parent-owned runner/coverage/reporter options must not recursively launch the same CLI in children. |
| Streams/events | `tests_stream.js`:12–215 and `test.md`:3498–4064: actual object-mode Readable with inherited stream/event/iteration behavior. Declaration-ordered start/pass/fail/plan/diagnostic differ from immediate enqueue/dequeue/complete/log. Per-file and cumulative summary, interruption/watch/stdout/stderr/coverage have distinct scopes and payloads. testId/parentId/entryFile/tags correlate concurrent tests; errors retain cause and rerun fields. Test:start is reporting order, not the body-start timestamp. |
| Reporters/coverage | `test.md`:897–953,1425–1696: reporters compose against structured records; paired destinations preserve order. Default spec, TAP, dot, JUnit and LCOV have actual formatting/state; exact human-readable output is not a stable programmatic contract. Coverage needs real execution instrumentation, include/exclude rules, never-loaded zero-coverage files, thresholds, reports and failure exit state. Existing V8 profile formats require a separate explicit engine assessment. |

### TEST-007: timer source covers more than the prose list

`mock_timers.js`:69–76 includes `scheduler.wait` and `AbortSignal.timeout`
alongside setTimeout/setInterval/setImmediate/Date. `test.md`:2934–2936
lists only the latter four. This is a source-discovered reachable option
requirement, with real implementation branches; it must not be lost to
heading-only inventory. `test-runner-mock-timers-scheduler.js` and
`test-runner-mock-timers-with-timeout.js` are unchanged validation
candidates. Their existence is not a claim they passed.

## Benchmark requirements and missing behavior

| Area | Required public semantics and target source |
|---|---|
| Registration/runner ownership | `bench.md`:26–68,157–232,294–438 and `bench_runner/harness.js`:118–359: serial declaration order, async suite collection, shared automatic runner versus independent explicitly started runners, once-only run and closed declaration phase. Same-turn run can configure the automatic runner; benchmark CLI files cannot call run themselves. Only shared automatic/module runs update an unset process exit code. |
| Options/identity | `bench.md`:318–428: uint32 samples/warmup, signals, timeout, skip/only, union of canonical tags and string diagnostic-channel names, sorted finite primitive params. Source/file/name/params-derived bench identity is stable within compatible layouts, while logical run and file-run identities are distinct. Duplicate declarations fail instead of merging measurements. |
| Timing/measurement | `benchmark.js`:276–478, `bench.md`:70–155,578–726: fresh BenchContext per warmup/sample; exactly one start/end pair or record; positive safe operation count, positive bounded bigint external duration, monotonic hrtime and captured end before argument validation/cloning. Invalid calls poison the sample even if caller catches their exception. done only during measurement ends after a valid sample; it does not replace recording. |
| Diagnostics/failure | `bench.md`:366–386,688–714: synchronous structured clone and validation; diagnostic order before sample/failure output, scoped channel subscriptions and removal, async callback awaiting, abort/timeout and pending work handling. If abandoned async work cannot settle, later selected benchmarks fail without overlapping measurements. Timer-based abort needs event-loop turns; a monotonic timeout is still checked when yield is disabled. |
| Statistics | `benchmark.js`:480 onward, `bench.md`:814–855: preserve raw bigint durations, operations and rate; arithmetic mean of equally weighted rates, median, population stddev, CV, actual mean/median confidence intervals and skewness. The mean is not pooled throughput, and a confidence interval is not a pass/fail threshold. The framework promises neither optimization state nor a particular benchmark speed. |
| Returned stream | `benchmarks_stream.js`:195–287, `bench.md`:728–812: inherited object-mode Readable APIs, named events plus {type,data} records, independent snapshots across delivery mechanisms with normal listener/SAB sharing. After a reader starts, real backpressure excludes delivery/snapshot time from benchmark timeout accounting. Before reading, records buffer; an event-only consumer must drain. Destroying an in-process stream stops delivery but does not cancel measurements or strand completion promises. |
| Process execution | `bench_runner/cli.js`:778 onward, `bench.md`:529–576: runFile uses one fresh child, copied env/execArgv, no glob interpretation, real permissions, advanced IPC preserving BigInt/errors, stdout/stderr diagnostics, acknowledged record transport and terminal unsuccessful summary on execution failures. Aborting/destroying this subprocess stream sends TERM then KILL as needed. This differs from destroying an in-process stream. |
| CLI/reporters | `bench.md`:188–292: sorted explicit files/globs, process or none isolation, inherited preload declarations and identity, aggregate summary, samples/warmup/name filters/reporter destinations. Worker isolation is not a CLI mode. JSON reporter serializes BigInt as decimal strings, nonfinite numbers as null and rich errors; spec reports real statistics/noise/skew, with unstable human formatting. Custom composition follows stream.compose. |

Returned runner/context classes and readable inheritance add public
requirements without being extra module exports. Context methods used
only by internal harness bookkeeping (such as BenchContext.finish/close)
and stream producer methods are recorded as incidental reachable source
details, not silently asserted as documented API obligations. Their
absence is also covered by the missing whole framework. A later choice
to emulate such undocumented details must remain explicit.

## Dependencies, host differences and boundaries

The candidate does have real timers/jobs/async resources, engine contexts,
classic streams, filesystem native work and guest process spawn. Their
owners and concrete gaps are in [async.md](async.md), [streams.md](streams.md),
[filesystem.md](filesystem.md), [processes.md](processes.md),
[workers.md](workers.md) and [loading.md](loading.md). Native work completion
does not itself provide framework state, test ownership, stream event
protocols or child-process advanced serialization. Module mocking depends
on actual loader hooks/cache/namespace identity; coverage and stack
locations depend on real engine instrumentation. Watch mode depends on
actual filesystem change notifications, not polling success markers.

None of the four hosts supplies a guest test/benchmark module. Browser
worker/process scheduling and transport differ and need their own later
evidence, but the missing shared factories are implementation gaps on
every host. No blanket browser or non-V8 exclusion is accepted. Exact
V8-private intrinsics, CPU-native fixtures and serialized profile formats
need concrete applicability dispositions per test; they cannot excuse
portable framework behavior or be stripped from an unchanged test.

## Existing evidence and later validation

The historical 5,147-case per-host baseline did not cover the separate
test-runner category. Most ordinary baseline failures hit a shared common
helper before API bodies, as retained in `baseline-failure-analysis.json`.
Those outcomes are not new framework conformance evidence. Current
candidate revision 45 is unbuilt and has no four-host runtime validation.

`test/test-runner/testcfg.py` uses the upstream parallel category launcher.
Its output tests call `test/common/assertSnapshot.js` and intentionally
compare fixtures/snapshots through their supplied transforms. Preserve
those sources, category rules, fixtures and real CLI launches; do not
substitute a generic zero-exit check or rewrite expected snapshots.
Separate node:bench API tests in parallel/sequential are not the same as
the `test/benchmark` category's general performance harness tests.

After explicit authorization, use pinned native and four guest controls
for deliberate failures and callback/Promise misuse, late work, hook
cleanup, plans, expected-failure versus TODO/skip, active async context,
mock restoration/descriptors/module cache, virtual timer/date/scheduler/
AbortSignal behavior, structured logs and event ordering. Cover actual
child isolation/abort/IPC/backpressure, seeded ordering, watchers, failure
exit status, snapshots and measured benchmark samples/statistics. Record
real passes, failures, skips, unsupported launches, timeouts, harness
errors and pending cases separately for identified source/artifact bytes.

Unresolved questions are retained: exact private-intrinsic/coverage-format
boundaries, undocumented producer/bookkeeping method emulation, and
prose/source option differences. None changes the definite finding that
the public framework implementation is missing. The overall audit remains
in progress; this family review does not authorize implementation or tests.
