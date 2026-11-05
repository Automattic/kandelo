# Worker environments, messaging and shared ownership

Completed source audit of the workers family: node:worker_threads, its
returned objects, inherited event contracts, global aliases and narrative
requirements. Target Node 26.13.0, source
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. This is source completion
with substantial implementation gaps. No runtime tests, probes,
compilations, fixtures or builds were run.

`worker-requirements.json` preserves all 73 document sections, all 74
saved descriptor observations, additional returned/inherited contracts and
source identities. Those discovery counts are not a unique API count.
Private symbols and ordinary function prototype objects are retained as
metadata, not promoted into additional supported public APIs. Inventory,
source review, implementation and runtime evidence remain separate.

## Namespace, constructors and final owners

The active candidate factory is
`packages/registry/spidermonkey/node-compat/adapter.js`:367–462, called by
bootstrap:5838–5845. Its Worker extends the shared EventEmitter, launches
the shell's real evalInWorker and exposes only seven namespace entries.
The fallback empty Worker is not the active route. The child receives
only a three-member worker_threads object and a minimal CommonJS-shaped
prelude; it does not execute the ordinary Node bootstrap or loader.

Target lib/worker_threads.js exports the Worker/port/channel constructors,
BroadcastChannel, clone/transfer controls, arbitrary-thread messaging,
environment data, real thread identity and resource limits. Its locks
property is lazy. Lock/LockManager and CPUProfileHandle/HeapProfileHandle
are returned types, not own namespace exports. Inherited methods remain
requirements even though the saved own-descriptor capture omits them.

**R-012:** public metadata and aliases diverge. The candidate's SHARE_ENV
uses `Symbol.for('kandelo.worker_threads.SHARE_ENV')`; target uses
`Symbol.for('nodejs.worker_threads.SHARE_ENV')`. Candidate module ports
are constructible EventEmitters; target new MessagePort throws
ERR_CONSTRUCT_CALL_INVALID and its native-created instances inherit
NodeEventTarget. MessageChannel requires new and entangles two real ports.
Global MessagePort is a separate throwing candidate constructor, while
global MessageChannel/BroadcastChannel throw ERR_NOT_IMPLEMENTED.
Module/global identity, inheritance, handlers, toStringTag, inspection,
method names/lengths and descriptor flags require the actual shared model.
An ordinary returned object is not evidence of a functional channel.

The saved descriptor values and flags are exact capture metadata. The
source lazy locks property and its materialized capture are different
observations; neither permits silently replacing the other. Target
Worker class methods are nonenumerable; MessagePort's assigned public
methods and handlers are enumerable. Private kOnExit/kDispose/oninit
symbols are implementation hooks, while Symbol.asyncDispose, the
inspection symbol and toStringTag are public observable contracts.

## Worker construction and child environment

Target lib/internal/worker.js:202–388 validates options and filename,
supports absolute or ./../ paths and file:/data: URLs, and uses MIME/module
loading for data URLs. eval requires a string. argv values are stringified;
execArgv may replace inherited options, with explicit empty-list and
permission-sensitive behavior. env is copied/stringified by default;
SHARE_ENV selects an actual shared environment store. name is validated,
trimmed and passed to native thread naming. Native platform name limits
do not authorize truncating unrelated public values arbitrarily.

The constructor owns a private control port, an entangled public channel,
stdin/stdout/stderr, bootstrap payload, environment data and child handle
before starting it. Transfer validation and startup failure must release
the right resources. trackUnmanagedFds defaults true and is inherited by
nested workers; close and thread teardown must not leak or prematurely
reuse descriptor owners. Resource limits apply to the JS engine, not all
ArrayBuffer/external memory; whole-process memory exhaustion remains a
distinct outcome. Parsing is not a universal integer validator: target
accepts numeric resource fields and clamps old generation to at least 2.

lib/internal/main/worker_thread.js:65–266 prepares the child environment,
installs public parentPort/workerData, environment data, cwd coordination,
main-thread routing, actual loaders/preloads/VFS mounts, stdio and the
selected script/module execution path. The ready notification follows
that setup. Worker process.exit stops that worker; process.abort/chdir,
credential setters, writable umask and inherited child-process IPC are
restricted. Signals, process title, trace_events and native addons have
documented worker-specific rules, not the embedding host's process rules.

Candidate String(filenameOrSource), std.loadFile and truthy eval ignore
these overloads/options. The minimal require accepts only worker_threads;
no normal child process object, loader or usable parentPort is installed
(R-003/R-009). Parent and child state must be initialized per context,
including async state, globals, native bindings and cleanup. Existence of
a fresh shell realm alone does not establish that contract.

## Structured clone, transfer and per-worker delivery

Target MessagePort serializes immediately, with graph identity/cycles,
BigInt, Map/Set, typed arrays, shared memory and supported host objects.
Functions and unsupported values fail with DataCloneError. Ordinary
class prototypes, accessors and nonenumerable properties are not
preserved; Buffer clones become Uint8Array. URL is not implicitly an
ordinary transferable clone. Transfer lists reject duplicates, detached
ports, the source port, marked objects and invalid/shared buffers.
ArrayBuffer transfer detaches every sender view even when the buffer is
not reachable from the value. Host-object transfer requires that object's
real admission, ownership and receiver reconstruction path.

src/node_messaging.cc:474–655 validates/serializes before detaching
ordinary ArrayBuffers, then finishes host transfers. Do not claim all
later host-transfer failures roll back every earlier detachment. Public
requirements include FileHandle/CryptoKey/KeyObject/Histogram/BlockList,
SocketAddress/X509 and supported TCP server/socket/bound-socket owners;
their backend ownership is a dependency on those families, not a new
implementation within the worker facade.

Candidate workerData uses JSON.stringify except for a top-level SAB or
Wasm memory. JSON loses graph/types, invokes toJSON, changes nonfinite
values and cannot handle cycles/BigInt. transferList is ignored (R-004).
The shared exception uses one process-wide synchronized mailbox, so
concurrent construction/default data/termination can replace the value
before the intended child retrieves it (R-005). The mailbox itself has
real backing-store/module reference counting: Set retains before replacing,
Get creates an owning receiver object and allocation failures drop the
appropriate reference. This review does **not** establish a dangling
buffer or use-after-free. The missing contract is addressed per-worker
handoff, acknowledgement and cleanup.

**R-013:** same-process structuredClone support is not cross-worker
transport. Candidate clone patch 0042 has real graph/ArrayBuffer machinery
but rejects registered host-object transfers; no connected port transport
adopts those objects. Likewise upstream/buffer-numeric-source.js contains
the target's full markAsUntransferable implementation, but build.py
selects numeric/prototype regions. That imported file does not activate
the public marking API. Target internal/buffer.js:1086–1108 uses an
uninherited private mark and an ArrayBuffer detach key. Primitive marking
is a no-op; isMarked tests the mark, not every reason a value might be
untransferable. Buffer allocation/pool marks must share the actual policy.
markAsUncloneable changes clone eligibility, not ordinary buffer transfer.

## Ports, broadcast, routing and event/ref state

| Surface | Required target behavior and candidate disposition |
|---|---|
| MessageChannel.port1/port2 | Entangled native endpoints; target constructor cleanup closes both on failed creation/property assignment. Candidate endpoints are disconnected. |
| MessagePort.postMessage/start/close | Queue, clone/transfer, actual receiving state, asynchronous close notification and peer disconnect. Target close optionally registers a callback. Candidate post/start are no-ops; close repeatedly emits synchronously. |
| MessagePort inherited events | NodeEventTarget/EventTarget APIs, Node-style payload versus MessageEvent handlers, once/signal/error rules and brands. Candidate inherits the different EventEmitter surface. See event-target-abort-contracts.md. |
| Port refs | Actual hasRef/ref/unref, first message listener starts/refs receiving, last removal stops/unrefs. Inspection reflects active/refed state; closed operations retain their specified validation. Candidate ref/unref only return this and hasRef is missing. |
| receiveMessageOnPort | Consume oldest queued port/BroadcastChannel message synchronously into {message}; undefined when empty, without later dispatch of that consumed message. Missing. |
| moveMessagePortToContext | Validate actual port and context; detach old endpoint, reconstruct in target realm. Foreign Object/message prototypes and loss of EventTarget/.on in that context are observable. Missing; engine realms are only a prerequisite. |
| BroadcastChannel | Process-wide named sibling group, string coercion, asynchronous clone delivery, MessageEvents, required argument, closed-post InvalidStateError, close once and actual ref/unref. Module missing; global throws. |
| postMessageToThread | Route to the specified unique thread, process workerMessage listener and shared status/ack; reject same ID, missing destination/listener, listener failure and timeout distinctly. Transfer/timeout overloads and nested routing matter. Missing. |

Target internal/worker/io.js:105–512 owns port prototype integration,
event creation, listener/ref state, stdio backpressure and broadcast
wrappers. src/node_messaging.cc owns synchronized queues, entanglement,
serialization, native lifecycle and context moves (1180–1213). Even a
closed port's postMessage performs observable validation/serialization;
an inert return is not automatically correct closed behavior.
internal/worker/messaging.js routes nested workers through a main-thread
port registry. Delivery uses shared status/result words and Atomics wait/
notify. Timeout need not cancel an already queued message; later native
controls must observe both timeout and subsequent delivery.

## Lifecycle, stdio and measurements

Target Worker readiness, uncaught errors, queued messages, actual exit
status and final exit event come from the child's environment/handle.
Exit drains ports before disposal, closes streams, unregisters routing,
removes listeners and invalidates handle-dependent accessors. threadId
becomes -1, threadName null and resourceLimits {} after stop. Errors use
real error serialization and a could-not-serialize path. EventEmitter
inheritance alone does not connect a candidate child failure to its parent.

Candidate online is a parent microtask after evalInWorker returns and is
not canceled by terminate. No native child error/exit event feeds the
public instance (R-006). terminate clears the mailbox, synchronously joins
**all** shell workers, emits exit 0 and resolves 0 (R-007). A live unrelated
worker can therefore block that path by source reasoning; this was not
newly executed. Target stopThread acts on one native handle; terminate
waits for actual exit, normally code 1 for forced stop. ref/unref change
parent loop ownership and return undefined, while candidate returns this
without changing ownership (R-008/R-012). Symbol.asyncDispose awaits
termination rather than synchronously claiming completion.

Worker stdio is real Readable/Writable state over the private channel,
with chunk/encoding payloads, read requests and acknowledgement callbacks.
An absent stdin yields null; stdout/stderr options select piping versus
manual consumption. Pending writes and parent blocking affect progress.
Closing or ending must release the appropriate references and callbacks,
not discard bytes or keep unrelated threads alive. Candidate has no
worker stdio owner (R-009).

cpuUsage uses actual per-thread user/system time and validated previous
samples. performance.eventLoopUtilization is actual worker loop timing;
its zero result is limited to offline/stopped/uninitialized states.
getHeapStatistics returns actual engine statistics; getHeapSnapshot owns
an asynchronous readable snapshot. CPU/heap profile methods validate
options before submitting a native request, then return handles whose
stop caches its Promise and whose asyncDispose awaits stop. CPU sampling
converts milliseconds to bounded microseconds; heap sampling defaults to
512 KiB/stack depth 16 with explicit boolean GC flags. Candidate has none
of these (R-009/R-012). Exact V8 formats/fields may need engine-specific
boundary decisions; absence of portable accounting is still a gap.

## Shared locks

**R-015:** locks, returned LockManager and Lock are missing. Target
internal/locks.js implements WebIDL name/options conversion, callback
overload, shared/exclusive modes, ifAvailable/null, steal, pending-only
abort and callback/Promise lifetime. Invalid leading hyphen and
incompatible options reject with DOMExceptions. Returned lock name/mode
are enumerable readonly accessors; constructor use without private
tokens fails. Lock getters and query use instanceof checks; request does
not have a universal equivalent receiver check. Retain that actual source
distinction for native controls.

The native process-wide manager (src/node_locks.cc/.h) owns its mutex,
held sets, pending queue, per-environment callbacks and wakeups. Callback
settlement releases the lock, steal rejects the stolen holder's released
Promise, and environment cleanup removes its held and pending entries.
The shared-object mailbox, POSIX mutexes and embedding browser navigator
locks are not implementations of this guest public manager. Required
prerequisites are per-worker identity, cross-context queues/wakeups,
Promise/abort ownership, teardown and real diagnostic channels.

## Explicit target questions (R-014)

These remain unresolved target questions, not observed candidate passes
or excuses to weaken tests:

- Worker profiling prose says the Promise fulfills with an error or a
  handle; internal/worker.js rejects on errors. CPU maxBufferSize is
  documented integer, while internal/v8/cpu_profiler.js validates a
  number and floors it. Compare fractional values and sync throw versus
  Promise rejection on exact native 26.13.0.
- terminate prose describes an exit-code result; target's already-gone
  branch resolves undefined. Compare repeated, natural-exit and concurrent
  calls without changing the target or assertions.
- locks.query prose describes a process snapshot; node_locks.cc:650–690
  filters held and pending records to the calling Environment. Compare
  visibility across independent worker IDs.
- Lock abort rejects the public Promise before grant, but JS passes no
  signal/cancellation token to native request; its later wrapped callback
  checks the aborted signal. Determine queue/query/fairness and cleanup
  semantics after abort. A falsy signal.reason also uses a fallback
  AbortError in this path. Environment cleanup removes entries without
  an immediately visible explicit ProcessQueue call; trace/wakeup controls
  must resolve whether a remaining request progresses. No runtime defect
  in upstream is asserted from these source observations.

## Guest, engine, libc, kernel and host boundaries

Frozen js.cpp:8430–8615 starts actual js::Thread instances, each with an
8 MiB JSContext, shell global, module-loader state, script execution and
RunShellJobs. The native vector/join at 8784–8818 is process-wide and
returns no per-public-Worker handle. CancelExecution requests an engine
interrupt; missing safe per-worker stop/cleanup integration is not proof
that SpiderMonkey cannot interrupt. The public Node environment and
independent lifecycle must own those facilities explicitly.

musl-overlay/src/thread/wasm32posix/clone.c marshals native thread clone
through kernel_clone. worker-main.ts:490–575 and kernel-worker.ts:21907–
22035 create a real guest thread; runtime-core/syscalls.rs:18409–18460
requires shared VM/thread flags, handles TLS/CTID and inherits the signal
mask. Guest kernel TIDs are not automatically Node environment threadIds.
The host allocates thread control slots, shared process memory, TLS/stack,
generation/channel state and a separate outer Worker.

| Host | Concrete source ownership and limits |
|---|---|
| Node | node-kernel-worker-entry.ts:2970–3095 registers each actual thread worker, awaits its termination barrier, then frees thread slots/listeners and removes registry identity. This does not provide the missing public guest handle. |
| Chromium | Browser thread path shares guest memory/module/channel state. browser-kernel-worker-entry.ts:3335–3405 frees a slot only after guest quiescence; otherwise it retains storage and marks memory retirement unsafe. |
| Firefox | Same browser retirement/quiescence policy and same guest worker factory. Outer Firefox hosting does not replace the guest SpiderMonkey runtime or prove an individual worker result. |
| WebKit | Same browser ownership policy; configured memory ceilings/reservation budgets must be accounted for in runtime-memory-profile.ts. Prior source comments about measurements are not new conformance or proof of an engine defect. |

R-016 records this cross-layer identity/reclamation prerequisite. Browser
hard termination without a completion result is a concrete host interface
difference. It does not justify fabricated exit success or exclusion of
normal Worker shutdown; a guest acknowledgement/fence is an implementation
responsibility. Resource ceilings, no-JIT recipe and exact V8/ISA artifacts
must be documented per capability, not as a blanket worker exception.
No new four-host runtime divergence or unavoidable worker API exclusion
has been established in this review.

## Evidence and proposed later validation

No identified current-candidate worker conformance evidence exists. The
candidate remains unbuilt. Historical baseline/archive identities and all
original statuses remain in existing-evidence.json and the historical
index; common-helper failures and unsupported flags do not show worker
test bodies passed. This audit changes no historical result.

worker-validation-candidates.json retains unchanged future source hashes,
Flags/Env and helper roles. File counts are selection aids, not executable
case/subtest/variant counts. Later validation must use real native
26.13.0 controls, guest artifacts and all four hosts, including clone/
transfer/GC/native-addon/network/file fixtures and WPT launcher resources.
No test/fixture source was executed to produce the catalog.

Prioritize independent/concurrent worker readiness, loading/options,
workerData handoff, error/exit/message order, per-worker termination,
nested threads and resource cleanup; entangled channels, transfer marks,
partial failed transfers, realms, pooled buffers and host objects;
listener/ref/unref/process-exit controls; stdio/backpressure; environment
copy/share; arbitrary-thread acknowledgement/timeouts; locks, abort,
steal, environment death and diagnostics; and actual CPU/heap/loop/profile
measurements with invalid argument/receiver/descriptor controls. Resolve
R-014 using unchanged tests plus native differentials. Implementation or
new runtime validation requires separate explicit authorization.
