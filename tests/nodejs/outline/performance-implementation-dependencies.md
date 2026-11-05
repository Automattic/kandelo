# Performance observer and process-clock implementation dependencies

O-008/009/012/020 and N-013 gain partial source owners. The exact target,
frozen audit, nonpasses and rebuild deferral remain unchanged. No family
or four-host conformance is complete.

## Actual owners and reviewed adaptation

performance-observer-adapter.js embeds the full pinned PerformanceEntry/
PerformanceNodeEntry source and unchanged observer/entry-list/buffer/delivery
and start/stop sections from internal/perf/observe.js. Private state owns
callbacks, registration sets, per-type counts, queued entries and immediate
delivery; disconnect and takeRecords consume real state. DNS lookup and
lookupService publish actual successful operation details and timings.

The one reviewed source adaptation replaces the upstream fixed supported
type array with only the installed DNS producer type. Native GC/HTTP/HTTP2/
NET/QUIC, function/resource and mark/measure producers are not advertised as
working. This is a partial implementation and a deviation from the target's
complete list, not an accepted platform exclusion or a change to any test.
No unsupported/skip is reclassified as a pass. GC tracking explicitly fails
if invoked. mark/measure now fail explicitly instead of silently succeeding.

Full Performance/EventTarget prototypes, user timing, resource timing,
function timing, native GC and other operation producers, histograms,
utilization, nodeTiming/milestones, event handlers, options and public exports
remain implementation work. The current performance object exposes only
its implemented clock and explicit mark/measure failures. The public global
and builtin share that object; identity alone does not close O-020.

## Process-origin ownership

performance-clock.h records real CLOCK_REALTIME and CLOCK_MONOTONIC samples
once at engine main entry before PreInit/JS/worker boot. The immutable origin
is shared by the process's contexts; no per-worker or first-API-call origin
is invented. Failed initialization aborts engine startup visibly. Reads use
actual elapsed monotonic nanoseconds and fail on an unavailable origin or
clock error. Date mutation and testing Date clocks cannot move it.

Patch 62 exposes elapsed milliseconds and the origin timestamp. The current
performance.now/timeOrigin and process.uptime source use these operations.
No kernel/host import/wire ABI changes occur. The engine bridge remains
uncompiled; process/worker/fork/exit and browser resolution/clock behavior
need identified-artifact validation. OS uptime and other measurements remain
separate gaps; this clock does not fabricate CPU or memory accounting.

## Evidence, observed phase and remaining dependency

Four focused DNS/frontend/observer controls and 27 affected socket controls
pass over actual candidate algorithms with explicit native Node request,
engine, clock, streams and timer boundaries. Three unchanged upstream lookup/
validation/reverse files pass in candidate and native modes. A standalone
native POSIX clock helper checks uninitialized/reinitialization errors,
monotonic reads, wall correlation and four concurrent readers. These are
scoped controls, not guest/four-host or per-API pass counts.

The first frontend fixture assumed the native request was already retired
in a callback-resolved Promise continuation. Its retained failure showed an
active native async ID. Pinned cares_wrap.cc calls MakeCallback while its
BaseObjectPtr owns the ReqWrap; native callback scopes drain microtasks
before that owner is destroyed. The corrected fixture observes the actual
post-callback check phase before asserting invalid/NONE metadata. It does
not alter upstream tests or prove guest retirement phase.

This leaves a real shared scheduler/native callback-scope prerequisite.
The candidate's JS_CallFunctionValue/Complete cleanup does not by itself
implement Node's nextTick/microtask-before-retirement ordering. Its exact
hook/error/fatal/realm/shutdown behavior now has initial shared source wiring across DNS, filesystem and codecs;
complete rejection/fatal/GC/realm and actual engine behavior still need
implementation and validation. See the callback-scope dependency record. Do not equate a native
boundary control with that guest behavior or close N-013 on this evidence.
No new overall suite or full product/engine/target-package build ran.
