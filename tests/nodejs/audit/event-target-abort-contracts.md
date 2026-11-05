# EventTarget, Event and cancellation contracts

Completed scoped source review of the Event/EventTarget/CustomEvent globals,
the returned/inherited NodeEventTarget surface, AbortController/AbortSignal,
and the three util cancellation helpers. This reviews their algorithms and
actual dependencies; it does not establish runtime conformance or complete
the web, worker or util families. Target Node 26.13.0, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.
No runtime tests, probes, compilations or builds were run.

## Final exposure and source correspondence

`third_party/node-core/event-platform-adapter.js`:1–102 constructs the guest
interfaces from pinned factories. Bootstrap:3218–3236 installs the globals
and util getters; its final global pass at 7390–7424 sets interface globals
nonenumerable, writable and configurable. Do not infer their descriptors
from the earlier Object.assign alone. Target exposed-wildcard bootstrap
uses exposeInterface for Event/EventTarget and native lazy data properties
for CustomEvent and Abort interfaces. Candidate construction is eager;
the eventual interfaces/descriptors have their own review here. Exact
lazy-load side effects remain a loading/VM control, not a claim that a
V8 lazy data property is necessarily a JavaScript accessor.

Neither EventTarget nor NodeEventTarget is an extra public constructor on
the events namespace. NodeEventTarget is documented as a returned/inherited
contract: target `internal/worker/io.js`:105–121 sets MessagePort's
constructor/prototype inheritance to it. Candidate has the actual internal
class but its public MessagePort is a separate unavailable facade
(bootstrap:6844–6856). Imported internal classes alone do not implement
their missing public consumers (WEB-006/R-011).

The requirements artifact records byte correspondence for event_target.js,
abort_controller.js, abort_listener.js and webidl.js, and inclusion in the
generated source. Factories receive real pinned primordials, validators,
coded errors, inspection, shared EventEmitter symbols, timers and queue
bridges. The owning native error/frame/scheduler/clone dependencies remain
separate from algorithm correspondence. The generated source is not an
identified running artifact.

## Event and CustomEvent

Event requires the type argument, validates non-null options and performs
template-string conversion, then reads bubbles/cancelable/composed with
boolean coercion. Each instance owns a timestamp and private cancellation,
dispatch and propagation state. Initial target/currentTarget are null.
Type and target are source-private symbols; the private fields and explicit
isEvent checks give method-specific receiver behavior. initEvent has a
different validation order from ordinary getters and does not reset every
private flag. Invalid receivers need their actual error path, not one
invented universal brand check.

preventDefault and false returnValue cancel only cancelable events outside
a passive listener. stopPropagation/cancelBubble track propagation state;
stopImmediatePropagation additionally marks immediate stop. No tree,
capture phase or DOM ancestor propagation is implemented or required by
Node's own documented flat target model. composedPath is the current target
only during dispatch, otherwise empty. eventPhase is AT_TARGET or NONE.
target/srcElement persist after dispatch; currentTarget does not.

Methods/accessors enumerated in the source are enumerable on the prototype.
Symbol.toStringTag is configurable/nonenumerable/nonwritable. isTrusted is
a nonconfigurable enumerable prototype getter over an actual WeakSet; the
target explicitly differs from DOM's own unforgeable instance property.
Static phase constants are enumerable, nonwritable and nonconfigurable.
They are not independently installed as instance own fields. Trusted abort
events are created through the shared private token, not a writable public
isTrusted property. CustomEvent extends Event, captures `options?.detail ??
null` and has its own detail brand and enumerable accessor. Its inherited
Event methods and static inheritance remain part of this contract.

**A-027 — time-origin coherence:** The Event factory uses the actual
adapter monotonic clock: bootstrap:3220 subtracts _nodeMonotonicStart from
os.timerNow; adapter:157–160 uses native.monotonicTime; frozen js.cpp:
1939–1947 uses mozilla::TimeStamp. This is not a Date.now timestamp stub.
However, perf_hooks/global performance still use the different clocks and
owners recorded in O-008/O-020. Target Event uses internal/perf/utils.now,
the same performance binding. Candidate Event/performance origin and
measurement coherence therefore remains incomplete. Exact process-start
versus bootstrap offset and guest libc monotonic provenance need controls;
no generic outer-browser time-origin exception has been accepted.

## Listener records, dispatch and lifecycle

EventTarget stores a SafeMap of doubly linked lists, keyed by converted
DOMString type. Identity includes listener and capture; duplicate adds are
ignored even with different once/passive options. Options getters run
before listener validation, including once/capture/passive/signal and the
source-private flags. Boolean and null options have distinct flattening
paths. Functions and objects are accepted; objects read handleEvent lazily
at delivery through an async wrapper. Missing/null listeners issue the
target's argument warning; invalid primitives throw. Listener errors and
thenable rejections are sent to the nextTick exception route, allowing the
remaining listeners to run.

removeEventListener validates/converts in its actual order and removes one
matching capture tuple. Signal-based auto-removal registers an abort
listener with weak retainer and resist-stop-propagation flags before the
final listener insertion. Already-aborted signals return early. Weak
records use real WeakRef/FinalizationRegistry plus a WeakMap of retainer
sets; removal unregisters and releases those records. A retained resource
must keep its callback alive without the target strongly retaining that
resource. The exact primordial/GC and error helpers remain dependencies.
Registration side effects before validation/duplicate detection are target
behavior questions, not an assumed candidate-only leak.

dispatchEvent requires its actual Event instanceof, rejects recursive
dispatch while its flag is set, sets the target, walks records and returns
the inverse of defaultPrevented. It snapshots each next link, skips removed
records, removes once before invoking, handles passive state in finally
and permits protected listeners after immediate stop. Add/remove/reentrant
effects follow this linked-list algorithm, rather than EventEmitter's
copied-array rules. Protected abort helpers use these actual private flags.
Warnings consult the shared EventEmitter max-listener symbols and process
emitWarning; they are not evidence of a complete warning/fatal owner.

NodeEventTarget adds brand-checked on/addListener/once/off/removeListener,
removeAllListeners, eventNames/listenerCount, max-listener access and emit.
on/addListener/once register node-style listeners that receive emit's raw
payload; DOM-style listeners receive a lazily created CustomEvent detail.
emit validates a string type and returns whether listeners existed. It
does not acquire EventEmitter's special error/newListener/removeListener,
prepend, rawListeners or errorMonitor behavior. Alias-like wrappers need
not be identical function objects; setMaxListeners returns undefined in
the actual class. removeAllListeners clears maps rather than iterating
every record's removal hook. Public MessagePort inheritance/liveness is
still missing, despite this source-backed internal implementation.

**A-028 — target prose/source questions:** events.md says bubbles/composed
always false, but the constructor honors true options. currentTarget is
described as a target alias but becomes null outside dispatch while target
persists. Error prose describes forwarding process 'error'; source
emitUncaughtException simply schedules a thrown nextTick error. The prose
that addListener differs only in its return omits node-style payload versus
Event delivery. Also the exact target dispatch loop clears its dispatch
flag after an individual successful callback, not only after the loop;
later-listener currentTarget/recursion/composedPath need native controls.
These behaviors are present in the pinned candidate algorithms too. No
target code/assertion or candidate runtime code was changed to resolve
the disagreements. A-014 remains the candidate's separate missing general
fatal/uncaughtException route.

## Abort, composition, timeout and resource ownership

AbortController lazily creates one private signal. abort synchronously
sets state/reason once and dispatches a trusted abort Event; subsequent
calls preserve the first reason. Default/explicit undefined reasons create
the real DOMException AbortError, while arbitrary supplied reasons retain
identity. signal and abort use private-field receiver validation. The
controller has ordinary class inheritance and enumerable public accessors/
methods; AbortSignal extends EventTarget and its public constructor throws
ERR_ILLEGAL_CONSTRUCTOR. aborted/reason/throwIfAborted use their actual
source-symbol checks and refresh composed state; this differs from the
stronger private brand used by its WebIDL interface converter.

AbortSignal.abort creates already-aborted state. timeout validates a uint32
without coercion (including integer/range errors), creates an unreferenced
real Timeout and closes over a WeakRef. A FinalizationRegistry clears the
timer if the signal dies; attached nonweak abort listeners can retain a
pending timeout signal. Its TimeoutError reason and actual timer
cancellation/liveness rely on the reviewed timer owner, with A-010–A-015
still applicable. A large allowed uint32 reaches timers' separate delay
clamping/warning contract; do not silently clamp it in the signal API.

any converts a full iterable using the pinned sequence/AbortSignal brand
converters before choosing a result. It flattens composite sources, follows
them through WeakRefs, propagates the first observed aborted reason and
retains timeout sources where required. Empty input produces a never-abort
composite. Dependent signals are marked aborted/reasoned before source
dispatch; their own abort events run afterward. Cleanup removes persistent
roots for settled signals and prunes source/dependent WeakRefs through
two registries. Reentrant abort and collection order need later controls;
source import alone does not certify GC scheduling.

onabort uses defineEventHandler's wrapper map and preserves first handler
position while replacing/deactivating a handler. Noncallable objects and
primitives take different setter paths; an object need not be coerced to
a callable callback. Public additions after abortion are not replayed.
util.aborted is an async helper with actual interface/resource validation,
protected one-shot weak retention, and a pending Promise when its resource
is collected before abortion. Already aborted resolves immediately through
the Promise path. util's three getters resolve the same factory functions;
their accessor function name metadata differs from target declarations
(candidate generic get arrow versus named public getter), **A-030**.

**A-029 — transferable cancellation remains an implementation gap:**
util.transferableAbortController/Signal mark real transfer modes and the
pinned signal owns transfer/list/deserialization hooks. But clone patch
0042 explicitly rejects registered transferable host objects before their
transfer hooks; it does not implement port transfer. The event factory
does not map internal/worker/io, and public channels/ports are unavailable
facades. Merely adding that map would not supply real transport. Both
already-aborted reason graphs and live cross-owner following remain
unimplemented. Do not claim these helpers work because they return a
marked signal, or call the missing protocol a browser engine boundary.

## Hosts, evidence and proposed later validation

All four hosts run these guest SpiderMonkey objects and native bridges.
No host DOM EventTarget/AbortController is substituted. The flat target
model is a concrete target API contract; unavailable MessagePort transport,
clock coherence, error routing and missing consumers are implementation
gaps on all four hosts. Outer workers, completion delivery, GC pressure and
memory/termination differ by host and need their identified runtime
artifacts. No new four-host behavior was observed.

Historical suites and selected controls remain in existing-evidence.json
and the immutable historical evidence archive. Their common-helper stops,
unsupported activation and incomplete runs cannot establish these APIs.
The earlier web-events selection is an existing list, not new evidence.
The future catalog preserves unchanged file identities/Flags, plus actual
WPT wrapper, variant and fixture requirements. No WPT discovery code ran.

After explicit authorization, compare target/native and each guest host
for descriptors/brands/aliases, string/option/iterator getter order, invalid
receivers, async object handlers and thenables, reentrant mutation/passive/
once/protected listeners, warnings, fatal and handled exceptions, dispatch
state after each callback, trusted abort metadata, arbitrary/undefined
reasons, iterable composition/first-abort/reentry, GC weak-retainer cleanup,
unreferenced timeout exit, cancellation, same/shared origin, structured
clone/transfer rollback and real MessagePort inheritance. Preserve target
prose/source disagreements and every failure/skip/unsupported/timeout/
harness error. This report authorizes no implementation or execution.
