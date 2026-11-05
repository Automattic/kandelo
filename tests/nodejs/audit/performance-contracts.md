# Performance and histogram public contracts

Completed source review of the `node:perf_hooks` facade and absent public
members, including the separate global performance object. This is not
runtime conformance or completion of the remaining process-report audit.
No runtime execution, tests, probes or builds were performed. Target:
Node 26.13.0, commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

`performance-requirements.json` preserves all pinned documentation
sections and per-member source/requirement dispositions. The native
capture omits instance inheritance and several returned types; additional
source-derived obligations are retained. Existing evidence is historical,
with no four-host proof for the current candidate.

## Actual exposure and clock owners

Target `lib/perf_hooks.js` exports Performance, PerformanceEntry, Mark,
Measure, Observer, ObserverEntryList, ResourceTiming, performance,
monitorEventLoopDelay, eventLoopUtilization, timerify, createHistogram,
createSlidingWindowHistogram and importHistogram. Its constants property
is enumerable but nonwritable/nonconfigurable. PerformanceNodeTiming,
PerformanceNodeEntry, Histogram, RecordableHistogram, ELDHistogram and
SlidingWindowHistogram are returned/derived classes, not additional
namespace constructors. Histogram mutators belong to RecordableHistogram;
enable/disable/disposal belong to ELDHistogram. SlidingWindowHistogram
does **not** inherit Histogram.

Target globals lazily expose seven Performance interfaces and a replaceable
performance attribute from the same module
(`internal/bootstrap/web/exposed-window-or-worker.js:60–66`). The target
performance singleton extends EventTarget with real event-handler/brand
state. Standard methods/getters are enumerable on its prototype; Node
extensions such as nodeTiming, timerify, markResourceTiming and ELU are
nonenumerable prototype properties. It has a custom inspect symbol and
Performance toStringTag; missing constructors must still have the target
illegal-constructor errors where direct construction is forbidden.

Candidate `bootstrap.js:5830–5837` instead supplies a plain object with
Date.now and empty mark/measure, and an Observer whose constructor ignores
the callback. At 6060–6071 it returns an unbranded histogram-shaped object
with no-op controls and fixed-zero getters/percentile. No performance
entry, histogram, native sampler or observer producer bridge exists.

**O-020 — separate global owner:** Frozen engine source defines a shell
performance object with `now` bound to Now (`js.cpp:7240–7245,
14631–14637,15658–15685`). Now uses PRMJ_Now wall time in milliseconds;
the object also exposes mozMemory.gc. Bootstrap:7404–7427 only adjusts
the global attribute descriptor, and adapter.js:494–504 only removes
unretained *global names*. Neither replaces the retained performance
object with the module singleton or installs the seven interfaces.
Global and module objects therefore have different owners and wrong
clock semantics; exposing an outer browser's performance is not a fix.

Target now (`src/node_perf.cc:375–386`) uses uv_hrtime minus process start,
while timeOrigin is Unix-time process origin; timer duration and trace
units differ. Kandelo has a real native monotonic clock and host/kernel
clock path, traced in [timer-contracts.md](timer-contracts.md). This is
an implementation gap, not absence of any usable clock. Public CPU time,
ELU and idle time require different actual measurements.

## Timeline, entries and resource timing

| Surface | Exact target owner and behavior | Candidate disposition |
|---|---|---|
| mark / new PerformanceMark | `usertiming.js:73–123`: required/coerced name, reserved milestone names, start-time validation, mark index, structured-cloned detail, duration 0 and mark brand. Calling mark also enqueues/buffers | mark no-op, class/index/clone behavior absent |
| measure | `usertiming.js:174–237`: start/end/optional duration overload combinations, prior marks/milestones, missing-mark SyntaxError, exact option errors, cloned detail, enqueue/buffer/return entry | No-op |
| clearMarks/Measures/ResourceTimings | Clear correct timeline by optional coerced name; mark-name index is separately cleared and reserved names rejected | Missing |
| getEntries / ByName / ByType | Sorted startTime copies of stored mark/measure/resource entries; required argument and coercion rules | Missing; observer-only function/net/dns/gc entries are not automatically global timeline entries |
| PerformanceEntry | name/entryType/startTime/duration and toJSON; inherited/custom inspect behavior, brand validation and forbidden direct construction | Missing |
| Mark / Measure / NodeEntry | Proper prototype inheritance, detail getter/serialization; Measure/NodeEntry not directly constructible; NodeEntry not namespace export | Missing |
| ResourceTiming | Branded getter facade over retained timingInfo/bodyInfo, inherited entry type, own overrides and enumerable fields; all connection/redirect/request/interim/final/body/status/protocol/content/delivery fields | Missing |
| markResourceTiming | Assert cacheMode empty/local; build resource from supplied real timing, enqueue and buffer, default delivery type; no fabricated timings | Missing |
| Resource buffer | Default capacity 250, secondary overflow queue, deferred buffer-full Event on singleton, listener-driven clearing/resizing and discard if no progress (`observe.js:437–483`) | Missing |
| toJSON / custom inspection / tags | Actual entry/Performance properties and exact numeric/null/detail values, receiver and negative-depth behavior | Missing |

`resource_timing.js` retains input objects instead of eagerly copying every
field; getters can change when those objects change. Absent connection
information may yield undefined. Source-only nextHopProtocol, initiatorType,
deliveryType and responseStatus remain obligations despite incomplete doc
headings. Source computes transferSize from encodedBodySize plus 300 for
network, zero for local and a separate validated-cache branch; it does not
measure arbitrary raw HTTP header byte counts. Preserve that source/prose
distinction for native controls. ResourceTiming toJSON reads the fields,
including default empty content type/encoding and blocking status.

The getter requestStart uses finalNetworkRequestStartTime while its doc
description refers to receiving the first response byte; retain this
target prose/source question. The first-interim response fallback and
final headers timestamps are separate fields, not interchangeable events.

Target Mark construction updates the name index before cloning detail;
failed-clone side effects require later controls. Measure has distinct
name validation and timing-option ordering. Do not infer identical WebIDL
conversion from the presence of similar method names.

## Observer scheduling and actual producers

`observe.js:80–377` freezes supportedEntryTypes, including source-only quic.
Observers keep callback, private buffer, entry-type Set and single/multiple
observation mode. Callback validation is real. Option copying, mutually
exclusive type/entryTypes, InvalidModificationError for changing mode,
duplicate type accounting, ignored unsupported types, buffered replay,
takeRecords and disconnect cleanup are separate contracts. Disconnect
clears the subscription, pending notification and buffered records and
resets mode. Delivery is batched through setImmediate with a sorted
EntryList and receives `(entryList, observer)`; callback exceptions follow
the owning callback exception machinery, not unconditional suppression.

EntryList getters copy/filter its captured sorted entries and preserve the
source's argument and type-comparison rules. Observer publication and
global timeline storage are separate. Per-observer state cannot be
replaced by one mutable public array or a positive callback counter.

Native GC observers are installed when subscriber counts become nonzero,
removed when the last subscriber disconnects, and restored after relevant
snapshot loading (`src/node_perf.cc:166–281`). Real GC durations and
detail.kind/flags are delivered on an unreferenced native immediate.
Other producers need actual HTTP/HTTP2/QUIC, successful TCP connect, DNS
and timerified-function lifetimes. Their payload schemas are preserved in
the requirements artifact. The facade cannot claim those event types
simply by advertising strings.

GC kind/flags constants are V8 enum values (`src/node_perf.h:63–85`), and
v8Start names a V8-platform milestone. Exact V8 phases have no literal
guest SpiderMonkey event. The mapping or exclusion must be decided per
field using real engine data; missing portable performance entries,
sampling or math is an implementation gap. No four-host exclusion or
synthetic V8/host-GC event is accepted here.

**O-021 — retained target questions:** Docs still list deprecated direct
NodeEntry.flags/kind, while the inspected entry/observer/GC producer path
only installs detail.kind/flags. Verify with the exact native pin later.
Docs omit quic from the main entry-type list while source supports it.
These are target discrepancies, not grounds to weaken assertions.

## Milestones, utilization and timerify

PerformanceNodeTiming (`nodetiming.js`) inherits PerformanceEntry and owns
enumerable name/type/start/duration and milestone getters. Unreached loop
milestones are -1; idle time is actual provider-idle duration. uvMetricsInfo
returns three number counters, while uvMetricsInfoBigInt supplies full
64-bit counters nonenumerably so spread/JSON remain serializable. Its
explicit toJSON selection must be matched, not every enumerable field
copied arbitrarily. Guest process/loop milestones belong to the guest,
not the embedding host process.

ELU (`event_loop_utilization.js`) has cumulative and one-/two-snapshot
delta modes. Pre-loop state is zero; blocked synchronous work counts as
active rather than CPU idle. It does not implement process.cpuUsage.
Caller-invented snapshots have no guaranteed correct accounting. The
module and performance prototype share the actual ELU function.

timerify (`timerify.js`) validates fn/options/optional RecordableHistogram,
preserves receiver/arguments and normal return, handles constructor calls
through ReflectConstruct, measures completed work and records nanoseconds
in the optional histogram. A returned object with callable finally is
chained through that finally, so the result can be a different promise;
the precise constructor/thenable/throw behavior follows the source rather
than a generic Promise.resolve wrapper. Entry detail contains original
argument references; enumerable immutable name/length metadata is set on
the wrapper. Synchronous throw precedes processComplete in the source.
No candidate timerify or ELU implementation exists.

## Histogram requirements and ownership

The full `internal/histogram.js` public wrapper, constructors, validation,
symbols, clone routes and returned types were reviewed. The requirements
artifact retains every statistic, overload, range, result shape and error.

| Group | Target contract | Candidate disposition |
|---|---|---|
| Creation/import | Integer/bigint limits, highest >= 2*lowest, figures 1–5; EWMA halfLife/threshold; Uint8Array CBOR import with version 1/2 compatibility | Missing |
| Basic statistics | min/max/count/exceeds number and bigint, mean/stddev/skewness/kurtosis, percentile and Map distributions; actual empty-state values/NaN/sentinels | Fixed zeros only on a separate unbranded object; other members missing |
| Probability/buckets | cdf/ccdf/countAt, percentile batches, linear/log buckets and precise validation | Missing |
| Inference/comparisons | KS, Welch, Mann-Whitney, Cohen/Cliff effects, mean/percentile confidence intervals and minimum-sample behavior | Missing; public result objects use null prototypes where source constructs them |
| EWMA/SLO | Real per-sample weighted state and error rate, burn-rate formula/range validation | Missing |
| Recording | Nonnegative number/bigint values, recordDelta monotonic ns, coordinated-omission correction, add/subtract compatible state | Missing |
| Snapshot/diff/reset | Independent read-only snapshot, resetCount, precise compatibility/reset/order errors; subtract clamps counts and increments resetCount | No-op reset, other behavior missing |
| export/import | Real sparse CBOR bucket/config/EWMA representation, version-specific unknown-key rules and count validation | Missing; engine-specific serialization not a substitute |
| QRDE | Snapshot at call, async native work, Float64Array result fields and bigint count, options/empty/discrete/dequantization behavior, generation-invalidated optional snapshot cache | Missing |
| Sliding window | Separate class, exactly one rotation mode, lazy time/count chunks including over-high recording attempts, reset and independent window snapshot; not cloneable | Missing |
| ELDHistogram | Inherits Histogram; actual interval or per-iteration samples, bool idempotent controls, disposal and clone-to-Histogram behavior | Inert controls return undefined, no disposal/brand/sampling/clone owner |

Native HDR storage and statistics (`src/histogram.h`, `histogram.cc`) are
shared owned allocations with locking and external-memory accounting,
not a V8-only statistical facility. Native wrappers are weak and release
their accounting/handles on destruction. Message cloning retains a shared
native histogram pointer (`histogram.h:369–374`); it is different from an
independent snapshot. An ELD clone receives plain Histogram behavior,
without transferring control of the sampling handle. Sliding windows are
explicitly noncloneable/nontransferable. Kandelo's clone/native-resource
bridge must carry those actual owners; JSON transport is insufficient.

QRDE jobs (`histogram.cc:964–1053,3116–3155`) retain a snapshot and optional
cache target/resolver, run numerical work off-thread, reject cancellation
when JS delivery is possible and release roots if the environment can no
longer call JS. They return null-prototype result objects; cache insertion
checks the mutation generation. Memory use depends on configured bucket
precision and concurrent snapshots. No current guest native bridge exists.
This negative review does not certify the upstream numerical algorithm.

The native interval sampler unrefs its timer; per-iteration sampling
uses unreferenced prepare/check hooks, adjusts poll time against timeout
and records at least 1 ns (`histogram.cc:2616–2812`). Stop/close and
environment cleanup own their actual resources. A fake histogram does
not make those unsupported just because Kandelo does not use libuv.
**O-022:** Docs say resolution is ignored in per-iteration mode, but
`event_loop_delay.js:96–100` validates it before selecting mode. Preserve
that option-error control rather than assuming all ignored values pass.

## Later validation and family boundary

Future candidates include unchanged parallel performance/histogram tests,
WPT performance wrappers and their variants/resources, relevant
async-hooks/workers/inspector/HTTP/DNS/net tests and message errors.
File catalogs are not a complete WPT/subtest denominator. Original native
flags, GC controls, actual operation fixtures, expected output and skip
metadata must remain intact. No new tests were run.

Differential controls must separate clocks/origins, global/module aliases,
brands/constructors/inheritance/descriptors/symbols, conversion/error order,
detail clone/retention, observer queue/reentrancy/cleanup, buffer overflow,
real producer payloads and milestones, ELU modes, timerify thenables and
throws, all histogram distributions/empty/invalid cases, mutation/diff,
CBOR versions/malformed data, shared clone versus independent snapshot,
QRDE cancellation/cache/memory, sliding rotation and sampler liveness.
The exact target questions above remain unresolved until authorized native
validation. Performance source review is complete with implementation gaps;
process.report/measurement source review remains separate unfinished work.
