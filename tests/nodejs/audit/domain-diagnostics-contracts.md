# Domain and diagnostics public contracts

Source review: **complete with gaps** for these two module surfaces.
Domain is absent; diagnostics is a reachable, inert facade. No new
runtime test/probe, compilation or build ran. Neither statement signs off
EventEmitter, async hooks, process exceptions or any producer family.
All four hosts share these guest defects; conformance remains pending.

## Domain exposure, lifecycle and inheritance

Target `lib/domain.js`:22–540 exports Domain, create/createDomain (same
function), active and the source-private _stack. Domain is a class
extending EventEmitter, with its inherited instance/static protocols and
ordinary object/function descriptors. Its instance members array is
distinct from implicit binding. The public create factory is named
createDomain; Domain itself requires construction with new.

Candidate bootstrap's final registry has no domain entry. Its policy
recognition does not instantiate the module. EventEmitter.usingDomains
stays false (bootstrap:494), and no load-time Domain/EventEmitter/process
integration is installed. This is A-006, not an engine/platform boundary.

| Contract | Exact target behavior and absent candidate owner |
|---|---|
| Load effects and deprecation | Source installs process.domain getter/setter, hooks and the native-domain trampoline, and patches EventEmitter.init/emit. DEP0032 is documentation-only (`deprecations.md`:773–790); there is no unconditional module-load warning. The separate legacy MakeCallback path can issue DEP0097 once. Deprecated status does not remove these public APIs. |
| create / createDomain / Domain | Same factory identity and class result; constructor owns members and a weak domain reference and enables the actual async hook. EventEmitter inherited methods, capture/error protocols and constructor inheritance remain requirements, not additional top-level exports. |
| members / add / remove | Explicit member array; add is idempotent, reassigns from an earlier domain and avoids circular Domain chains. It defines non-enumerable configurable/writable emitter.domain. Remove clears domain and removes one recorded member. Implicit binding does not populate members or implicitly parent new Domain instances. |
| enter / exit / active | Active and process.domain change with the actual stack. Repeated/nested enter is allowed; exit removes this domain and nested entries and restores the prior active state. Ordinary return values and descriptors are observable. _stack is a retained private implementation observation, not a new documented public API promise. |
| run / bind | Actual arguments, receiver and return value; run calls fn with this=Domain, bound callbacks retain their caller receiver and carry a non-enumerable domain property. Wrappers enter/exit normally; exceptions reach the owning fatal/domain path rather than being swallowed. Replacing this with a try/catch that merely returns success would not reproduce the contract. |
| intercept | Removes the first callback argument; when it is a truthy target Error instance, routes it to domain error handling with domainBound/domainThrown fields instead of invoking callback. It is not a generic truthy-error test. Cross-realm Error and wrapper receiver behavior need native controls. |
| Error decoration and nesting | Domain errors distinguish thrown, emitted and intercepted cases and attach correct domain/domainEmitter/domainBound/domainThrown fields. A failing nested error handler can route to an outer domain; adjacent active duplicates are popped to prevent recursion. The top-level handler preserves abort-on-uncaught policy rather than blindly catching it. |
| EventEmitter integration | Target init implicitly binds new emitters except Domains; emit handles local error listeners, process exclusions, domain error routing and active-stack changes/restoration. It does not count all ordinary EventEmitter errors as domain-handled. These methods require the actual EventEmitter and process owners. |
| Async and Promise lifetime | Async hooks pair resource IDs with weak domain references, hold them while callbacks run and remove pairings on destroy. Same-realm resources get non-enumerable domain properties; cross-VM Promises use weak-map lifetime instead of an exposed domain property. Promise handlers use the domain in which then/catch was registered. Unhandled Promise rejection is not automatically a Domain error event. |

The required fatal-exception owner is independently missing in A-014.
Real guest async resources, Promise reaction context and GC primitives
exist, but do not supply Domain's error routing. Candidate TCP/process
providers also lack complete resource integration (N-013). Exact V8
private fixtures are a separate applicability question; portable domains
are not excluded merely because SpiderMonkey executes the guest.

## Diagnostics namespace, class and channel ownership

`lib/diagnostics_channel.js`:22–720 implements the target registry,
channel state, disposable store scopes, bounded call windows and tracing.
Its exports are channel, hasSubscribers, subscribe, tracingChannel,
unsubscribe, boundedChannel, Channel and BoundedChannel.

**A-016: namespace/class/name mismatch.** Candidate bootstrap:5892–5929
omits boundedChannel/BoundedChannel and adds an empty TracingChannel
export that the target module does not export. Target TracingChannel,
RunStoresScope and BoundedChannelScope are returned-object classes,
not extra namespace constructor exports. Channel is exported, but its
docs explicitly say direct new Channel is unsupported; source-visible
constructor behavior is recorded without inventing a supported overload.

Candidate channel(name) returns a fresh plain object, not a registered
Channel. Its tracing factory names subchannels name:event rather than
the target tracing:name:event and cannot preserve the supplied channel-
map overload. Empty candidate class exports do not repair factory brands,
prototype descriptors, Channel.Symbol.hasInstance or channel identity.

| Public contract | Target source requirements and current gap |
|---|---|
| channel(name) / registry | String/symbol name validation and stable live channel identity. WeakRefMap and finalizers avoid a permanent root, while active subscriptions/stores hold appropriate strong references. Candidate allocates a new object and accepts unrelated names. |
| subscribe/unsubscribe/hasSubscribers | Actual handler validation, synchronous delivery with data and name, boolean unsubscribe result, duplicate/removal and mutation behavior. Target copies subscriber arrays on changes, preserving the current publication snapshot. Active/inactive prototype transitions and store bindings affect subscriber state. Candidate registration/removal is no-op and false/undefined metadata never reflects ownership. |
| Channel properties/publish | Name, dynamic hasSubscribers getter, real Channel instanceof behavior for active/inactive prototypes, correct instance/method descriptors. Inactive publish is intentionally a fast no-op in the target; an unconditionally inert implementation is not equivalent. Subscriber exceptions are queued through nextTick to actual uncaught-exception routing, not silently swallowed or thrown as ordinary publisher failures. |
| bindStore/unbindStore/runStores | Real AsyncLocalStorage bindings, replacement transforms, boolean removal, previous-context transform visibility, callback receiver/args/result and async propagation. Scope creation enters stores then publishes original data. Transform errors queue fatal handling and skip that transform; partial entry failure disposes entered scopes. Normal finally cleanup has the target's actual exception precedence. Candidate calls fn without setting stores or publishing. |
| withStoreScope / RunStoresScope | Disposable owner for real entered store scopes. Disposal restores in reverse order, is idempotent and aggregates multiple cleanup errors through the shared error helper. This uses actual ALS.withScope and Symbol.dispose, not a host-only context variable. Candidate API and scope are absent. |
| boundedChannel / BoundedChannel | String or actual channel-map overload, shared registry subchannels, fixed non-enumerable/non-writable/non-configurable own start/end properties and dynamic hasSubscribers. subscribe/unsubscribe manipulate real channels. run/context defaults, return/throw/finally behavior and withScope own a start/end execution window. **Bounded means a delimited execution window, not a message-capacity queue.** Entire candidate API is absent. |
| BoundedChannelScope | If its window has subscribers at entry, enter/publish start and retain context/end; disposal publishes end before restoring start stores and is idempotent. The context object is shared across the window, not cloned. Proper using/exception cleanup depends on the actual engine's existing resource-management support. |
| TracingChannel / subscribe helpers | Two composed bounded windows (call and continuation) plus an error channel; start/end/asyncStart/asyncEnd getters and fixed error property. Group unsubscribe reports combined results. Factory returns new wrappers with shared underlying named channels, not a globally cached tracing wrapper. Candidate channels and methods remain inert. |
| traceSync | Actual receiver/args/return or thrown value, shared default/context object with result/error fields, start/error/end publication and bound stores; no-subscriber fast path. Candidate simply applies fn and omits tracing. |
| tracePromise | For direct native Promises, target returns a chained Promise preserving fulfillment/rejection; for other thenables/subclasses it subscribes and returns the original object. Non-thenables return unchanged with a warning, including on the no-subscriber path. Source publishes asyncStart/asyncEnd around settlement handling, not around arbitrary later consumer continuations. Candidate omits these distinctions and events. |
| traceCallback | Selects callback position (default last, with target Array.at/splice semantics), validates and replaces it while preserving receiver/all args and wrapper return. Error-first result/cause fields, call and continuation windows and stores are real. Candidate never wraps or validates the callback path. |

The public class/channel requirements are missing on every host, even
though actual WeakRef/FinalizationRegistry, ALS scopes, errors and
resource-management primitives can support their implementation. Native
Node's subscriber storage/index notifications (`src/node_diagnostics_channel.cc`)
connect actual native producers to public subscription state. Candidate
native/core adapters have no corresponding registry/producer connection;
copying a private array layout is not a substitute for correct events.

### A-017: target prose versus mid-trace subscriptions

Docs:923–925,991–994,1047–1050 say handlers added after a trace begins do
not see later events from that trace. The source checks window presence
at entry, but retains live Channel objects. When a start subscriber
already exists, subscribing to the previously inactive end channel
inside fn changes that live object before BoundedChannelScope disposal
publishes end. Source therefore permits a newly added end subscriber to
receive that event. The per-publication subscriber-array snapshot is a
different guarantee from a whole-trace snapshot.

This source/prose conflict is recorded as an unresolved **target** question
for later pinned native controls. It does not justify the candidate's
no-op channels or a silent target change. Source review of the conflicting
branches is complete; no new execution has resolved the reference behavior.

## Built-in producer requirements

The matrix preserves every documented channel's exact payload and
timing/activation requirement. All are blocked by the unusable public
registry. Actual producer owners also need integration; merely replacing
hasSubscribers with true would manufacture diagnostics.

| Producer | Required event/state boundaries and current owning layer |
|---|---|
| Console | Five argument-array channels at actual log/info/debug/warn/error calls; target console constructor:64 onward. Candidate console/stdio facades lack registry publication (observability owner). |
| HTTP / HTTP2 | Real request/response/stream creation, send/start, errors, finish/body/close with actual objects/headers/flags. Candidate custom HTTP/TLS paths lack publication; server/HTTP2 implementations have their own gaps. |
| CJS/ESM loading | require/import call/return/async/error windows, request ID and parent file/URL; target cjs/loader.js:229 onward and ESM owner. Candidate resolver/loader has no diagnostics integration. |
| Net/UDP/process/worker | Actual socket creation/listen ready/error, datagram creation, child spawn call/success/error, execve and worker creation, with real arguments/objects. Their native watches/process/thread owners are separate from a channel dictionary. |
| Test runner / locks | Actual node.test tracing context and lock request/start/grant/miss/end, modes, steal/availability and errors. Test framework is missing; lock/worker support requires its own owner audit. |
| SQLite | Real sqlite.db.query profiling after completed statements, expanded-or-source SQL, actual Database and SQLite C-layer duration. Abandoned/finalized mid-iteration statements do not produce a completion event; subscribers cannot close an executing statement/database. Missing SQLite bridge does not establish this profiler. |
| FIPS indicator | Conditional OpenSSL provider callback, --enable-fips-indicator-events, main-thread asynchronous coalescing, bounded 256 distinct pending messages/dropped accounting, unreferenced best-effort queue and preservation of preexisting native callback result. Requires OpenSSL >=3.4, not BoringSSL or arbitrary addon libcrypto contexts. Kandelo's packaged 3.3.2 lacks that backend feature and CLI/bridge; version/provider applicability is separate from generic channel semantics. No FIPS validation claim follows from messages or their absence. |

## Existing evidence and proposed later validation

No current-candidate native/four-host conformance is established. The
historical baseline usually stops at its common helper and includes
unsupported flags; those statuses and artifact identities are unchanged.
Future source catalogs retain exact domain/diagnostics upstream files,
including async-hook, VM, callback/Promise, subscriber GC and native
fixture requirements. They are not executed tests or coverage signoff.

Later native controls need domain aliases/inherited methods, explicit
versus implicit membership, nested/repeated stack entry, wrapper receiver/
error decoration, Promise registration context/VM isolation, fatal routing
and GC ownership. Diagnostics controls need string/symbol identity,
subscribe mutation/GC/error delivery, scoped stores and disposal failures,
descriptor/class/factory maps, thenable/native Promise behavior and
callback position/context. Resolve the target mid-trace subscription
question with exact source/native identities before choosing behavior.

Producer controls require actual operations and feature gates, not
hand-published success messages. Preserve OpenSSL/provider/main-thread
conditions, private implementation fixture classifications, native skips,
and separate pass/fail/unsupported/timeout/harness/pending outcomes per
host. All execution and implementation remain unauthorized.
