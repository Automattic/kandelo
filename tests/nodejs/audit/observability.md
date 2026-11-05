# Observability source audit

State: **source review complete with implementation gaps** for the three
public modules, their globals/returned types and diagnostic-report scope.
Detailed contracts supersede the earlier broad observations below:
[console](console-contracts.md), [performance](performance-contracts.md),
[tracing](trace-events-contracts.md) and
[diagnostic reports](diagnostic-report-contracts.md). No runtime tests,
probes or builds were performed. The broader process/OS measurements and
engine capability audits remain separate and incomplete. Unresolved
per-field mappings/target questions are retained in the detailed records.
Source observations apply to the common
guest implementation; current four-host conformance remains pending.

## Final owners and namespace behavior

The console registry at bootstrap:5856–5888 returns an object containing
Console and an extra default property pointing at that class. It is not
the global console object. Pinned `lib/console.js` exports
`internal/console/global`, which includes the public logging methods.
The current CommonJS console namespace therefore lacks log/warn/etc.
ES-module synthesis at bootstrap:6559–6581 defaults to that namespace
object and snapshots its enumerable keys; it does not repair the missing
methods or make it the Node global singleton.

Global console takes a separate route. The SpiderMonkey shell defines
console.log as print (js.cpp:14641–14653); shared bootstrap:6937 onward
adds missing methods and wall-clock timers. That is not the module's
Console implementation. Both paths must be audited independently.

perf_hooks at bootstrap:5831–5837 contains a small performance object and
an inert PerformanceObserver. monitorEventLoopDelay is later assigned
at 6060–6070 and returns constant statistics. No trace_events entry exists
in the public builtin registry. process measurement/report implementations
at 1509–1536,1570–1589 are separate public surfaces used by this family.

## Concrete findings

| ID | Public requirement | Source observation | Owning prerequisites |
|---|---|---|---|
| O-004 | console namespace/default/global relationship | Public module lacks logging functions and returns a separate namespace object. ESM default remains that object; global console is separately patched shell output | Correct shared console owner, builtin loader/ESM identity and descriptors |
| O-005 | Console constructor overloads/options | Only opts.stdout/stderr are read. Legacy stream arguments, ignoreErrors, colorMode, per-stream inspectOptions Map and groupIndentation are not implemented/validated | Stream validation/ownership, inspection/color policy and instance state |
| O-006 | Console formatting/output/error policy | writeLine joins strings/inspect output rather than util.format placeholders; all write exceptions are swallowed regardless of ignoreErrors. trace lacks stack; dir options and table rendering/columns are incomplete | Shared formatter, stack capture, option handling and stream completion |
| O-007 | Console counters/groups/timers/clear and missing methods | Class count/countReset/group/groupCollapsed/groupEnd/time/timeEnd/timeLog/clear are empty. dirxml and inspector methods are absent; global timer fallback has different Date.now-based behavior | Real per-console state, terminal controls, monotonic timing and actual inspector integration |
| O-008 | performance clock/origin/entries | now is Date.now; mark/measure do nothing. No actual user-timing entry store, clearing/filtering, resource entries, timeOrigin or Node timing model is provided | Existing monotonic clock, engine/host measurements and owning operation instrumentation |
| O-009 | PerformanceObserver lifecycle | Constructor does not retain callback; observe/disconnect do nothing; takeRecords and entry-list/type metadata absent | Entry queues, supported entry types, delivery scheduling and shutdown |
| O-010 | Histograms and event-loop metrics | monitorEventLoopDelay returns zeros and no-op controls; real histogram constructors/import/sliding-window APIs, extended statistics and utilization/timerify APIs missing | Actual sample collection, histogram state/math, loop busy/idle accounting and resource/ref behavior |
| O-011 | trace_events API, categories and output lifecycle | Entire module absent, including createTracing/getEnabledCategories and Tracing controls. Documented operation/category producers and CLI/file rotation/flush are not implemented by a missing namespace | Real trace backend, operation producers, CLI activation and file/shutdown lifecycle |
| O-012 | process.hrtime/uptime/CPU/memory accounting | hrtime helper uses Date.now and uptime uses wall-clock subtraction. memoryUsage returns zeros; cpuUsage returns zeros or negates supplied previous values | Actual monotonic clock and guest/engine/accounting interfaces, validation and units |
| O-013 | process.report | getReport returns only a hard-coded sharedObjects loader pathname, without actual report data or loaded-object inspection; writer/configuration/versioned schema APIs absent | Real process/thread/engine/resource metadata, source stacks and report file/error policy |

O-001–O-003 in the family survey record initial perf/console facade
findings. The detailed review above identifies additional namespace,
constructor, clock and report problems. They are implementation gaps,
not accepted instrumentation or platform exclusions.

## Actual lower capabilities and host implications

The candidate already exposes native monotonicTime for its timer scheduler
and event time origin. Runtime-core sys_clock_gettime at 11192 and guest
clock routing at 11208 distinguish monotonic clocks from realtime and
image-build logical clocks. A Date.now-backed public hrtime/performance
implementation is therefore not forced by a lack of any monotonic clock.
Its correct clock origin, units, precision and deterministic-build policy
still need source reconciliation.

Actual CPU, engine heap/external allocation, guest memory and event-loop
measurements need their own owning interfaces. Host process totals must
not be mislabeled as one guest process's usage. Similarly, V8-specific
field names require per-field semantic decisions; a fixed positive heap
limit or zero-valued measurement is not actual accounting.

All four hosts share the guest implementation. Their scheduler and memory
profiles differ; measurements must describe actual guest state within
the chosen profile and retain host identity. Native/browser APIs with
similar names are not automatically the guest public implementation.

## Source-review disposition and later evidence

The detailed reviews and requirements artifacts now reconcile constructor,
inherited EventTarget/entry fields, symbols/descriptors, histogram operations,
serialization, receiver/errors, callbacks and activation/CLI contracts.
They trace the distinct global console/performance owners and inspector
extension path. Full numerical certification and dependency implementation
are not claimed by this source review.

Report version/configuration, worker aggregation, exclusions, file/exit/
signal behavior and conditional field owners are reconciled in the report
review. Exact V8/libuv/native-address equivalence remains an explicit
field-specific question; no blanket report boundary is accepted. A fixed
sharedObjects field does not implement actual loaded-object inspection.

Later unchanged coverage must include parallel perf/console/report tests,
the `test/trace_events` category, message expected-output fixtures, resource
timing through real HTTP/DNS/net operations and relevant Web Platform
Tests. Candidate examples include
`test/parallel/test-perf-hooks-resourcetiming.js`,
`test-perf-hooks-histogram-record-zero.js`,
`test/trace_events/test-trace-events-api.js`,
`test-trace-events-process-exit.js` and `test/message/console_assert.js`.
These have not been run in this audit.

Native controls should observe namespace/alias identities, constructor
overloads, formatter/options/error behavior, counter/timer/group state,
monotonic origin and elapsed values, observer entry/delivery sequences,
actual histogram samples, trace categories/files/flush and report schema
with real resource state. Zero samples, absent capabilities and unrun
tests must remain distinct from successful measurements.
