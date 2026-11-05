# Trace-events public contracts

This is a completed **negative source review of `node:trace_events`**,
not a completed observability-family audit or a conformance result.
The guest module and its tracing bridge are missing on all four hosts.
No runtime tests, probes, compilations or builds were run for this review.
The target is Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

`trace-events-requirements.json` preserves the complete pinned public
document sections, exact source identities, per-member requirements and
unresolved target questions. `trace-events-validation-candidates.json`
identifies unchanged future tests; inclusion is not assertion coverage.

## Exposure, state and descriptors

Target `lib/trace_events.js:9–25,100–117` checks compiled tracing support,
process-state ownership and an actual tracing agent at module evaluation.
Workers fail with `ERR_TRACE_EVENTS_UNAVAILABLE`. A main process need not
start with a tracing flag: `src/node_v8_platform-inl.h:19–32` constructs
the agent before optional CLI activation. This is a process/feature gate,
not a reason to exclude the public module from every Kandelo host.

The namespace exports only `createTracing` and `getEnabledCategories`.
`Tracing` describes returned instances; it is not a namespace constructor.
The ordinary exported `createTracing` function has its normal prototype
property. Its namespace property and the native function's namespace
property are ordinary enumerable, writable, configurable properties.
CommonJS/bare and `node:` exposure and ESM/default behavior depend on the
shared loader; an absent registry entry implements neither route.

The returned class has private handle, original categories array and
enabled boolean. Its `enable`/`disable` methods and `enabled`/`categories`
getter descriptors are class prototype properties, not own enumerable
instance fields. The methods/getters brand-check through private fields.
There are no public ref/unref, disposal, iterator or EventEmitter methods.
The prototype's custom inspection symbol has separate behavior, including
returning the receiver for negative numeric depth. Generic Object methods
are inherited normally; copying only the six documented names does not
reproduce these contracts.

`createTracing` validates an object and an array of strings, rejects an
empty array with `ERR_TRACE_EVENTS_CATEGORY_REQUIRED`, and reads the
`categories` option repeatedly. Getters, proxies, sparse arrays, mutation
and error precedence therefore require later differential controls.
`src/node_trace_events.cc:67–82` copies category values into an ordered
native set, while the JS getter joins the **original array** on each read.
Changing that array after construction can change `tracing.categories`
without changing the handle's captured categories. Duplicates/order are
preserved in the getter but deduplicated/sorted in the native set.

Enable/disable are idempotent at each instance. Enabled instances are
strongly rooted by a module-level Set, retaining the native handle even
when user references disappear; disabling removes that root. More than
ten enabled instances emits a warning. Native category ownership uses
multisets shared with CLI and other tracing/inspector clients, so disabling
one handle must preserve categories still owned by another. Empty union
returns `undefined` in the binding; nonempty union is sorted and joined.

Enable is permission-sensitive (`node_trace_events.cc:84–104`): starting
the writer checks filesystem-write permission for the first resolved
trace path. JS sets its enabled bit before calling the binding and adds
the strong root afterwards. Failure-state behavior needs a native control;
the audit does not assume rollback that the target source does not show.

## Owning backend and operation producers

`src/tracing/agent.cc` selects a legacy or Perfetto implementation at
compile time. Both agents keep category ownership, start a file writer
on first use, and remove one owner's occurrences on disable. They have
distinct output and rotation behavior. Generic tracing requires a real
guest operation event sink, not forwarding host process traces or writing
predetermined events. The guest's existing async IDs, native work/jobs,
monotonic clock and VFS are prerequisites, not an implemented trace sink.

The complete documented category list is preserved in the requirements
artifact. Its owning producer paths include:

| Producer | Pinned owning source | Kandelo prerequisite |
|---|---|---|
| async lifecycle/trigger IDs | `src/async_wrap.cc:110–158,550–580` | Actual shared async-resource lifecycle and trace emission |
| bootstrap/environment | `src/node_perf.cc`, `src/env.cc`, `src/api/hooks.cc` | Guest process/engine milestones, not embedding-host milestones |
| console counters/timers | `lib/internal/console/constructor.js` | Real per-console counter/timer state plus trace backend |
| native work sync/async | `src/threadpoolwork-inl.h:30–56` | Real job start/completion, cancellation and worker ownership |
| DNS/network | `src/cares_wrap.cc`, `src/tcp_wrap.cc`, `src/pipe_wrap.cc` | Real resolver/socket operations and IDs; no synthetic host attribution |
| fs and directory sync/async | `src/node_file.cc:150–212`, `src/node_dir.cc:62–92` | Actual guest file-job lifecycle and sync syscall instrumentation |
| user timing/timerify | `lib/internal/perf/usertiming.js`, `lib/internal/perf/timerify.js` | Real performance entries, clock and callback lifecycle |
| rejection accounting | `src/env-inl.h`, `src/env.h` | Actual rejected/late-handled promise accounting |
| VM script execution | `src/node_contextify.cc:1019–1111,1212` | Actual guest realm/script lifecycle |
| HTTP | `lib/internal/http.js`, `src/node_http2.cc` | Actual request/response and stream lifetime |
| CommonJS loading | `lib/internal/modules/cjs/loader.js` | Actual loader spans, including failures and nesting |
| V8 compilation/GC/execution | V8 tracing controller/backend | Concrete guest-engine boundary: SpiderMonkey does not run V8. No fabricated V8 events; per-event equivalence remains an engine-family question |

The `node` category is documented as an empty placeholder. It is not a
required fabricated operation event. Native/browser outer engine traces
are not interchangeable with traces of the guest SpiderMonkey process.
Chromium hosting Kandelo does not make the guest engine V8.

## Files, clocks, shutdown and inspector

CLI `--trace-events-enabled` aliases the explicit categories
`v8,node,node.async_hooks`; `--trace-event-categories` and
`--trace-event-file-pattern` are allowed in `NODE_OPTIONS`
(`src/node_options.cc:1618–1628`). `${pid}` means the guest process ID;
`${rotation}` advances per writer, with replacement implemented by
`src/tracing/trace_event_helper.cc:33–40`. Trace timestamps use the
monotonic hrtime source in microseconds, not wall-clock milliseconds or
host process CPU time. Existing timer-clock source tracing is recorded
in [timer-contracts.md](timer-contracts.md).

The legacy writer opens lazily on the first event, emits JSON trace data,
rotates after its event threshold, serializes write requests and blocks
final flush/close until pending data is drained
(`node_trace_writer.cc:30–230`; threshold in its header). With no events,
that writer produces no file. The Perfetto writer opens on initialization,
writes whole binary packets, rotates at 64 MiB and has its own
flush/read/stop protocol (`agent_perfetto.cc:23,78–160,370–408`). A single
unqualified JSON/no-empty-file rule would be wrong across the target's
build branches. Native-reference compiled backend must be identified
later; it was not executed for this audit.

Orderly process/agent destruction must drain actual work, finalize output
and release writer/descriptor/thread resources. Signal-triggered orderly
exit requires the handlers described by the target docs; the docs do not
promise flushed output after arbitrary abrupt termination. VFS write,
open failures and permission behavior need the real owning paths.
Inspector `NodeTracing.start/stop`, `dataCollected` and `tracingComplete`
use separate client/session ownership (`src/inspector/tracing_agent.cc`)
and require the absent inspector transport/session implementation. They
are cross-family gaps, not evidence of an implemented tracing API.

## Findings and unresolved questions

**O-011:** Entire guest module, category registry/ownership, output backend,
producers and lifecycle bridge are missing. Same source gap on Node,
Chromium, Firefox and WebKit; current-candidate runtime evidence is absent.

**O-014 — target category validation disagreement:** Docs at
`tracing.md:221–224` promise string coercion. The public JS validator
(`lib/internal/validators.js:330–339`) rejects non-string elements before
native conversion. Preserve both requirements and later native controls
for numbers, coercible objects, sparse arrays and side effects; do not
silently choose or revise the target.

**O-015 — target empty-union disagreement:** Docs at `tracing.md:253`
declare a string return. `node_trace_events.cc:119–130` leaves the return
undefined for an empty union; the unchanged API test explicitly expects
that state. Record the discrepancy and native control requirement.

**O-016 — output branch qualification:** Docs describe `.log` JSON output
without the Perfetto build branch. `src/node_options.h:382–386`, the
two writer implementations and `test/common/trace_events.js:20–65`
select `.pftrace` binary output/conversion on that branch. Exact native
backend identity, conversion dependency and shutdown/file-error behavior
remain later validation questions. This does not obstruct the negative
source conclusion for the absent guest module.

The enabled-bit state after a denied native enable, categories mutation
between option reads, and the exact per-event boundary for V8-only data
remain explicit questions. The public module-member negative audit is
complete; implementation completeness and runtime conformance are not.

## Later validation proposal — authorization required

Run unchanged `test/trace_events` sources with original flags, helpers,
fixtures, child invocations and assertions; preserve explicit feature
skips and worker unavailability. The target helper requires
`trace_processor_shell` on Perfetto builds and asserts when absent:
missing conversion is a prerequisite failure, not a passing API test.
Include permission/category/inspector and signal/exit coverage outside
that directory. Retain metadata about native/internal flags and do not
replace child-process assertions with a passing parent exit code.

Proposed native controls cover namespace/descriptors/brands, aliased
loads, validation/accessor order, original-array mutation, overlap/CLI
ownership, warning/GC retention, denied enable state, empty-union return,
clock units, actual event payloads and guest IDs, real files/rotation,
orderly/abrupt shutdown and inspector client lifetime. Nothing in this
proposal authorizes executing it.
