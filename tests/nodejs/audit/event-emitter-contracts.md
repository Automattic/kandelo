# EventEmitter and public event-helper contracts

Completed scoped source review of `node:events`: EventEmitter, its static
helpers and returned iterator/disposable/async-resource emitter contracts.
Global Event/EventTarget/CustomEvent, NodeEventTarget consumers and the
async-hooks/ALS/Abort source reviews are recorded separately. Missing
native integration and runtime conformance remain distinct. No runtime
tests, probes, compilations or builds were run.
Target Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

The requirements artifact retains all events.md sections before its
separate EventTarget discussion, native descriptor obligations, source
comparisons and source-discovered iterator/class metadata. Cataloged tests
are future unchanged candidates, not new evidence or coverage signoff.

## Final owners and actual dependency composition

The namespace is the EventEmitter function itself; EventEmitter.EventEmitter
is the same function. Core at bootstrap:430–1148 is an adaptation of the
pinned listener implementation. Later initialization installs the lazy
EventEmitterAsyncResource getter (2851–2856) and replaces early static
getEventListeners/getMaxListeners/listenerCount with the pinned helper
excerpt via event-platform-adapter.js:97–102. The generated node-core.js
also contains that exact excerpt and the exact lazy async-resource class.
Thus the early getMaxListeners calling an override is **not** the final
public behavior. CJS/bare/node: and ESM namespace/default coherence still
depends on the shared loader audit; EventTarget is not an extra namespace
constructor exported by this module.

Source comparison establishes identical whitespace-normalized init and
rejection-capture blocks. The emit/listener/state/array-cloning block has
only comment differences. This is algorithm correspondence, not proof of
the helpers or embedding: local spliceOne, inspection/error helpers,
process warning/tick/fatal handling, AsyncResource and EventTarget/Abort
dependencies were reviewed separately below. No current running artifact
is inferred from the generated source.

## Constructor, metadata, listeners and synchronous dispatch

| Contract | Actual source behavior and candidate disposition |
|---|---|
| Construction/init | Calls EventEmitter.init on receiver, supports subclass/super and legacy call-on-object patterns, separates inherited listener maps with a null-prototype own map and shape state. Ordinary direct call need not construct a new instance. _events/_eventsCount/_maxListeners are retained metadata, not substitutes for actual listeners |
| captureRejections | Shared getter/setter on constructor, false default and boolean setter; instance option follows target truthy-check/read order and otherwise inherits current default. Source does not implement a general explicit-false override of a true global default |
| Descriptors/aliases | Prototype functions assigned as enumerable/writable/configurable; on===addListener, off===removeListener, EventEmitter self alias, global rejection Symbol.for identity and private per-module monitor/capture symbols. Configurability/constructor/prototype/function metadata follows assignment or explicit definition |
| add/on/prepend | Validates function, emits newListener before insertion, unwraps once listeners for that notification, rereads _events after reentrancy, permits duplicates, preserves registration/prepend ordering and returns receiver |
| emit | Synchronous receiver/arguments and ordered listeners, boolean return, result ignored except optional thenable rejection capture. Reentrant mutations copy an actively emitted array so the entered batch continues with its original listeners; emission counter is restored through finally |
| once/prependOnce | Validate function, wrapper stores listener and a fired guard; removes before calling, target receiver and return propagated. Raw wrapper can be invoked manually without allowing later duplicate invocation |
| remove/off | Backward search removes most-recent matching registration, at most one; wrapper listener match supported. Single/array shape transitions, counts and removeListener notification occur after removal |
| removeAll | Fast path without notifications; otherwise events including symbols, removeListener event last, per-event LIFO notifications and reentrant target state. No-argument differs from an explicit undefined key |
| listeners/rawListeners | Copies arrays, listeners unwraps once wrappers, raw preserves them; user changes to a returned array do not replace stored list state |
| listenerCount/eventNames | Optional listener matching counts duplicates/wrappers; ReflectOwnKeys and shape-mode undefined filtering; symbols and JS key order retained |
| Max listeners/warnings | Global/current per-instance limit and multi-target setter, nonnegative number validation including Infinity/zero, warning is advisory; warns once per warned array and preserves warning flag on copy. Warning carries name/emitter/type/count and goes through real process.emitWarning |

The target itself uses mutable array methods on some paths; this is not a
claim that every operation is immune to user prototype changes.
**A-005** remains specific: candidate spliceOne calls array.splice while
the target internal/util helper moves indexed elements and pops. Listener
removal at a nonzero array position can therefore consult a different
mutable dependency. Zero-position removal uses shift in both sources.

The public constructor and lazy class have normal Function/Object
inheritance. Retained kMaxEventTargetListeners symbols are shared with
the actual EventTarget factory, not recreated independently. Domain's
replacement init/emit behavior remains missing with node:domain (A-006).
Warning formatting/delivery and terminal stderr behavior depend on the
incomplete process/console/inspection owners; a real listener array alone
does not establish the required warning behavior on every host.

## Errors, monitoring and rejection capture

errorMonitor runs before checking ordinary error listeners, but does not
consume an unhandled error. A monitor can reenter or change listeners;
the source uses its actual event map and normal emit path. An Error
argument is rethrown as the same object; other contexts are inspected and
wrapped with ERR_UNHANDLED_ERROR plus .context.

**A-018 — error construction and fatal-stack enrichment:** Candidate
getUnhandledErrorException at bootstrap:668–678 creates plain Error and
assigns code/context. Target events.js:440–470 uses the shared coded-error
constructor, whose prototype/toString includes `[ERR_UNHANDLED_ERROR]`
(`internal/errors.js:435–531,1920–1927`). Their public error metadata and
stringification differ even when message/code/context agree. For an Error
argument the target also installs a configurable, nonenumerable private
stack-enhancer function using an actual captured emission stack; the
fatal before-inspector phase calls it (`errors.js:895–914`). Candidate
omits that producer and the general fatal/inspector route is incomplete
(A-014). Exact engine frame text is a separate question; missing the
emission/fatal phase is an implementation gap.

The rejection-capture block otherwise matches target code: inspect then
once, call with the original thenable receiver and rejection callback,
schedule delivery through process.nextTick, prefer the global rejection
symbol method, otherwise disable capture around error emission and restore
it in finally. Throwing then getters route to error synchronously. An
ordinary listener throw propagates immediately from emit; it is not
converted into a rejection by this listener core. Uncaught exceptions from
the later tick require the missing shared fatal route; handling them by
just setting shell exitCode does not implement process handlers.

## Static helpers and returned resources

getEventListeners prefers an emitter's listeners function; for actual
EventTarget state it walks listener records, including weak-reference
dereferencing. getMaxListeners checks a callable instance method but reads
the shared stored limit rather than invoking a user override. listenerCount
prefers an actual method and otherwise reads EventTarget root size. Invalid
receiver/error order follows the pinned excerpt; do not replace it with
duck checks from the superseded early helpers.

once returns an async-function Promise, validates options/signal and rejects
with AbortError/cause if already aborted. It registers one event listener,
an error listener only for emitter-style non-error waits, and protected
abort handling. It resolves to the complete arguments array and removes
event/error/abort listeners along the applicable paths. EventTarget error
events are ordinary events. nextTick-before-Promise scheduling means
serial awaited once calls can miss events; the public API does not buffer
arbitrarily late registrations. The exact Promise/job/tick paths are real
guest engine queues, with source limitations documented in the timer and
async family reviews.

on returns an object inheriting the real AsyncIteratorPrototype. It owns
two FixedQueues for events and waiters, close/error/abort listeners and
pause/resume watermark state. It accepts both WaterMark and legacy
Watermark option spellings. Queue size >high pauses and <low resumes;
low/high validation does not invent an extra ordering constraint. next
drains queued events before the stored one-time error and then completion;
pending next calls resolve/reject individually. return cleans listeners
and pending waiters; it does not eagerly discard all already buffered
events in the pinned source. throw validates a same-realm Error and calls
the error path, returning undefined rather than a new rejecting Promise.
Close/error state transitions, queue/argument retention and callback order
must be tested rather than assumed from for-await syntax.

The iterator has its own asyncIterator and Symbol.for('nodejs.watermarkData')
metadata object with size/low/high/isPaused getters. It inherits
Symbol.asyncDispose from the engine's AsyncIteratorPrototype. The pinned
SpiderMonkey and V8 disposal implementations and guest explicit-resource
feature are already source-traced in timer-contracts.md and
engine-iterator-source.json; this is not a missing one-off iterator method.
FixedQueue really removes shifted entries/recycles bounded empty blocks;
it is not an unbounded array-index queue pretending to release values.

addAbortListener validates signal/listener, registers an unstoppable once
abort listener and returns a null-prototype disposable with Symbol.dispose.
For an already-aborted signal it schedules a trusted abort Event on a real
microtask; disposing before delivery cancels it. It depends on shared
EventTarget protected/trust/dispatch flags and error routing, not the outer
browser's AbortSignal. The guest Event/Abort algorithms and factories are
real, but their complete dependency review remains separately incomplete.

EventEmitterAsyncResource's exact lazy class binds an actual AsyncResource
to each emitter, executes super.emit through runInAsyncScope, exposes
asyncId/triggerAsyncId/asyncResource and a referencing asyncResource.eventEmitter
getter, and delegates emitDestroy. The imported implementation has real
JSContext frame/ID exchange, hook scopes and numeric destroy queues. Native
resource state/finalizers are in native-async.cpp; the VM jobs use patches
0040/0041. Provider integration, hook policies and full AsyncResource
semantics still require the owning async-hooks audit; source inclusion is
not runtime signoff.

## Target questions and namespace order

**A-019 — target disagreements/controls:** EventEmitterAsyncResource docs
give an optional options/name default, while direct construction in the
source validates options.name; string construction and subclass fallback
are separate source paths. Docs say repeated emitDestroy throws and GC
never emits destruction, while the delegated AsyncResource source has no
once-only throw guard and registers GC destruction when enabled and not
manual. Both target and candidate use those actual paths; preserve exact
native controls before deciding contract changes. The docs' positive/
integer limit wording also needs qualification: the target number
validator accepts zero/nonnegative fractional values and Infinity. No
assertions or target pins were changed to settle these questions.

**A-020 — namespace property order:** Target installs enumerable public
helpers before the EventEmitter self alias. Candidate adds the self alias
and core metadata first and appends/replaces helpers during later
initialization. Public Object.keys/Reflect.ownKeys order therefore differs
by source construction order, although many property values/descriptors
match. A complete namespace audit must retain that observable difference.

Registration-time side effects that abort a signal or synchronously emit
close/error during helper setup need later controls; the unchanged helper
source has its own partial-registration/temporal ordering. The audit does
not declare those target cases correct or silently add rollback semantics
that the target does not implement.

## Hosts, existing evidence and proposed validation

All four hosts run the shared guest listener/helper code and packaged
SpiderMonkey engine. Their scheduling, resource limits and shutdown paths
can differ; a host-native EventEmitter is not the guest implementation.
There is no newly established current-candidate runtime conformance.

Historical selected events evidence retains exact identities in
existing-evidence.json and historical-evidence-index.json: native 36/36
passing; guest Node/Chromium/Firefox 22 pass,10 fail,4 unsupported each;
WebKit 13 pass,5 fail,1 harness error and17 pending. These are distinct
older artifacts. The WebKit page/context closure does not establish an
EventEmitter or engine cause. Earlier seven passing selected controls do
not override these failures or prove the current source candidate.

Later unchanged cases need all message/expected-output and async-hooks/
EventTarget/Abort fixtures, original flags and native controls. Controls
must include constructor/aliases/property order/descriptors/symbols,
reentrant mutations and throws, duplicate/once wrappers, warnings and
inspection side effects, code/prototype/string/stack error behavior,
thenable capture/tick ordering, helper queue/abort/error/close/backpressure,
iterator disposal and resource context/ID/GC/manual-destroy lifecycle.
Original failures, unsupported cases, harness errors and pending work are
retained. Nothing in this report authorizes new validation or fixes.
