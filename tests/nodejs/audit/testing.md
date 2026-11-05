# Test and benchmark tooling source audit

State: **negative public source audit complete**. The detailed
[public-contract review](testing-public-contracts.md) reconciles API,
returned-object, descriptor, source-extra, narrative/CLI and fixture
requirements. All four public modules remain missing; runtime evidence
is pending. This survey is retained as the initial source-route summary.
No new test, benchmark, native control, runtime probe or build was run.

## Public exposure and target requirements

All four public modules are absent from the candidate builtin registry:
node:test, node:test/reporters, node:bench and node:bench/reporters.
The shared policy lists their scheme/option rules but does not construct
their implementations. See bootstrap:5771–6110 and the exposure matrix.

The pinned `lib/test.js` exports the callable test function with test/it,
suite/describe, run, lifecycle hooks and getTestContext; mock, snapshot
and assert are lazy public properties. `lib/test/reporters.js` exposes
dot/junit/tap and spec/lcov factories. These public entry points and their
returned contexts, mocks, streams/reporters are not supplied by the guest
module registry or by Kandelo's external test harness.

The pinned `lib/bench.js` exports bench plus lifecycle hooks, suite/describe,
createRunner, run and runFile. `lib/bench/reporters.js` exposes JSON/spec
reporters under the experimental benchmark activation. Current native
Node option handling recognizes neither that activation nor the complete
test/benchmark CLI.

## Concrete findings

| ID | Public requirement | Source observation | Owning prerequisites |
|---|---|---|---|
| TEST-001 | Callable test/suite and contexts | Entire node:test module missing, including async hierarchy, hooks, cancellation, concurrency, plans, skip/todo/only/filter/tag/rerun behavior and result state | Real runner state/scheduler, async context, test lifecycle and exception policy |
| TEST-002 | Mocks, timers, snapshots and assertion registration | Public mock/snapshot/assert exports and their methods absent. Existing process timers/assert APIs do not implement test-owned virtualization or snapshots | Scoped mock/restore lifetime, virtual clocks, module hooks, files and serialization |
| TEST-003 | TestsStream/reporters and CLI | No real test event stream, reporter implementations, coverage collection, watch/isolation/preload or report destinations/exit behavior | Streams, processes/workers, actual instrumentation, file/CLI and shutdown policy |
| TEST-004 | Benchmark runner/context/measurement | Modules absent, including independent runners, lifecycle, timed/recorded samples, parameters, result statistics and reporter protocols | Real monotonic timing, measurement state, async scheduling, validation and statistics |
| TEST-005 | Benchmark activation/isolation/transport | Experimental and --bench CLI/options absent. Target process isolation transfers structured records preserving BigInt/errors; JSON conversion is not equivalent | CLI, real child processes/IPC, loader/preloads, structured transport and result ownership |
| TEST-006 | Existing conformance launcher limitations | Guest runner marks every required flag other than --no-warnings unsupported; RLIMIT_AS launch requirements also unsupported. This prevents some bodies from running and is not proof those APIs fail or pass | Audit launcher capability separately from public runtime support and fixture applicability |

TEST-006 references `scripts/nodejs-guest-runner.ts`:15–19. Its current
classification preserves an honest unsupported status. The completed
initial baseline's unsupported cases must not become passes by deleting
flags, weakening assertions, stubbing node:test or replacing unchanged
upstream runners with a success-only facade.

## Real dependencies and boundaries

The candidate has actual async resources, timers, streams, process spawn
and engine jobs. Those are dependencies for a proper test/benchmark
implementation, not an already implemented framework. Browser/Node host
test orchestration also does not execute inside the guest as node:test.

Full coverage collection needs actual execution instrumentation. Missing
V8-specific coverage backend and absent public runner are separate
findings; portable framework behavior must not be excluded because one
instrumentation backend is unavailable.

The target benchmark docs distinguish process isolation from an in-process
run. They explicitly do not define worker isolation as a CLI mode; do not
invent a missing required CLI mode from general worker functionality.
Guest workers, child processes, loaded native state and host workers have
different resource/isolation boundaries.

All four hosts share the missing public entry points. Each later run
still needs its real host worker/process/memory and fixture capabilities;
no current-candidate four-host conformance has been established.

## Public-contract reconciliation and proposed later evidence

The detailed review now reconciles test.md/bench.md sections, including narrative execution
models, extraneous asynchronous activity, hook ordering, context methods,
mock functions/modules/timers/dates, snapshots, result stream events,
coverage, reporters, watch/global setup/isolation, reruns/tags and
measurement integrity. Source-discovered expectFailure shorthands and
scheduler.wait/AbortSignal.timeout timer options are retained. The exact
requirement matrix remains separate from implementation and conformance.

Review upstream test-runner/benchmark categories and nested fixtures with
their actual launchers. Native controls must include deliberate failures,
cancellation, leaked asynchronous work, failing hooks, concurrent/nested
tests, restored mocks, virtual timer/date effects, snapshots, event/reporter
schemas, subprocess exits and actual benchmark samples. Verify that a
failing assertion produces a failing result, not just that a happy-path
test prints a success label.

Keep native reference and all four guest host outcomes separate, including
pass/fail/upstream-skip/unsupported/timeout/harness-error/pending. This
document proposes later validation only; implementation and execution
remain unauthorized until the completed audit is reviewed.
