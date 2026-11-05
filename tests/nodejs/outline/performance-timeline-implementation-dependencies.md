# Performance timeline source owners and remaining measurements

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).

Recipe93 advances the observability source pass. Exact Node26.13.0 pins
and frozen audit remain unchanged. This is partial implementation of the
performance obligations, including O-019/O-020/O-021. No family or API-wide
conformance closure is claimed. The accepted guest engine remains88; the
combined source93 candidate has no current four-host validation.

## Real public source and ownership

The manifest retains full pinned Performance, usertiming, resource timing,
NodeTiming and timerify modules, in addition to the existing entry/observer
sources. Five full modules are embedded unchanged. They own actual classes,
inheritance, receiver checks, marks and measure overloads/errors, cloned
detail, timeline indexes/buffers, sorted entry copies, resource field getters
and serialization, observer delivery and function/constructor/Promise timing.
The public factory does not rewrite assertions or replace the algorithms
with export-shaped facades.

The actual guest monotonic clock and fixed process time origin remain the
clock owners. The existing structured-clone owner supplies mark/measure
detail, and the pinned EventTarget/WebIDL owners supply the Performance
instance, resource overflow events and buffer-size conversion. Resource
timing consumes caller-supplied timing/body data and preserves the target's
live-object getters; it does not fabricate HTTP/Fetch measurements. Fetch
publication still needs its actual transport/body ownership bridge.

The shared observer queue and timeline buffers now receive real mark,
measure, function and explicit resource entries alongside DNS producers.
supportedEntryTypes advertises these five installed types only. This is
still a mismatch with the target's ten types: GC, HTTP/HTTP2, net and QUIC
producers remain implementation gaps. Unsupported subscriptions/skips are
not passing conformance, and no platform exclusion is accepted for them.

One actual Performance instance is shared by the builtin and guest global.
Seven corresponding global interfaces are installed from the same owner.
The performance getter/setter uses the unchanged pinned replaceable-lazy
attribute helper, including setter-called handling for undefined. Interface
constructors are installed eagerly; exact target native lazy-load/realm
behavior remains a separate global-descriptor obligation.

The old monitorEventLoopDelay facade returned invented zero statistics and
inert enable/disable/reset methods. It is removed. Monitor/histogram/import
factories and event-loop utilization now fail explicitly with
ERR_METHOD_NOT_IMPLEMENTED. This exposes missing implementation; it does
not implement those APIs. Missing milestones, idle time and loop metrics
also fail rather than becoming zero measurements. The full pinned NodeTiming
class uses the real clock for its duration, but its measurement getters,
Performance.toJSON/inspection and milestone-based measures remain partial.
Histogram branding for timerify options still needs a real product owner;
the native fixture supplies that owner only for source controls.

## Evidence

Exact source/report identities are recorded in
performance-timeline-finding-progress.json. All paths below are in .context.

* node26-performance-timeline-frontend-r1.json:43pass/0fail/0skip across
  seven new timeline controls and36 affected DNS/socket controls. Controls
  exercise clone/index/error ordering, overloads, sorted copies, buffered
  replay, takeRecords/disconnect, live resource getters and buffer-full
  events, sync/constructor/Promise timerify behavior, brands/descriptors and
  replaceable globals. Native Node supplies clock/clone/EventTarget/branding
  dependencies. The nested DNS resolver cases are not additional file totals.
* node26-performance-timeline-upstream-r1/report.json: eight unchanged files
  pass in native mode; adapted mode records7pass/1fail, with0skip/timeout/
  harness errors. The retained failure is test-perf-hooks-usertiming.js:141,
  a measure referencing nodeTiming.nodeStart; its actual measurement provider
  is missing. Do not relabel it unsupported or passing. The other selected
  measure/detail/resource/buffer-full/timerify files pass without assertion
  changes. Raw bodies are checked against the pinned archive.
* node26-performance-timeline-source-r2/report.json: pinned full inputs,
  frozen audit/target, generated bootstrap syntax, unchanged Mozilla style,
  source-only test registration and the preceding native patch identity
  pass. This slice adds no native patch or compile. It does not establish
  guest load, callback/resource/GC/clone or browser conformance.

The first source-check harness invocation failed on an invalid copy2 call;
its exact script/log and partial checks remain retained. The corrected rerun
completes the source checks. This was a verification harness error, not a
package or runtime compile failure.

Native source fixtures use explicit private native dependencies. The upstream
preload substitutes the selected timeline API and globals; other namespace
exports remain native and do not establish missing Kandelo histogram/metrics
or constants support. No performance improvement was measured or claimed.
This is functional API implementation, not a benchmark or optimization.

## Remaining dependency order

1. Record real process/engine/bootstrap/loop milestones at their owning
   lifecycle points, and provide actual loop-idle/iteration/event accounting.
   Do not turn absent measurements into zeros or confuse host lifetime with
   guest lifetime. Resolve V8-named fields against concrete SpiderMonkey
   phases or an explicit per-field boundary; none is accepted here.
2. Implement histogram storage, distributions/QRDE/sliding windows/import/
   clone/worker transport and ELD sampling/retirement. Reuse the target's
   storage/algorithms where portable, with real sampler and memory owners.
3. Complete GC/HTTP/HTTP2/net/QUIC/Fetch producers, histogram-backed timerify,
   namespace constants and all lifecycle/provider/observer/overflow policies.
4. Verify actual guest clock/clone/EventTarget/async delivery, shutdown/GC/
   worker/realm behavior, global lazy loading/descriptors, error stacks and
   current combined artifacts across all four hosts.

All other audited observability and family obligations remain open. Preserve
the upstream failure and source-only compilation debts for process89,
KDF90, metadata91, Argon2/source92 and OpenSSL3.5.9. Overall suites and the
full product rebuild remain deferred. Continue independent source gaps
before expanding a deep Performance test campaign.
