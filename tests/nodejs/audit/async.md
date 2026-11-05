# Async, events and timers source audit

State: **source review complete with gaps**. This review distinguishes real source implementations
from missing resource integration, inert diagnostics and unreviewed
semantics. All current-source native/four-host conformance remains pending.
No new test, runtime probe or build was executed.

All 498 original family obligations have source/applicability dispositions.
See [timer contracts](timer-contracts.md), [domain/diagnostics contracts](domain-diagnostics-contracts.md),
[EventEmitter contracts](event-emitter-contracts.md), [async context](async-context-contracts.md)
and [Event/Abort contracts](event-target-abort-contracts.md). Source-audit
completion includes definite missing native integration and explicit target
questions. It does not complete implementation, runtime conformance or the
separate worker/web/process/network/stream source audits.

## Final owners and dependencies

| Surface | Final source owner | Source observation |
|---|---|---|
| async_hooks / AsyncHook | `third_party/node-core/async-platform-adapter.js` | Custom hook registry, dispatch/mutation state, native ID/context access and destroy delivery |
| AsyncLocalStorage / RunScope | Pinned `upstream/async-local-storage.js`, `async-run-scope.js`, `async-context-frame.js` through that adapter | Actual frame storage, run/exit/bind/snapshot and disposable scope algorithms |
| AsyncResource | Pinned `upstream/async-resource.js` inserted into adapter | Actual resource IDs, before/after, frame exchange, bind and destroy registration |
| Promise/job context and lifecycle | SpiderMonkey patches 0040/0041, plus later native owner integration | Engine-owned rooted context snapshots and Promise/job metadata, not a Promise.then facade |
| EventEmitter | Bootstrap:430–1148 | Substantial listener core, copy-on-write arrays during emit, last-match removal, once wrappers, errors/warnings and rejection capture |
| Static event helpers / EventEmitterAsyncResource | `event-platform-adapter.js`, pinned helper excerpts, async adapter and bootstrap:2852–2856 | Later assignments replace early definitions; actual final helpers/classes and their dependencies reviewed in the detailed report |
| EventTarget / Abort interfaces | `event-platform-adapter.js` and pinned event/abort sources | Own guest algorithms over shared validation, timers, clone and native metadata |
| timers / timers.promises | Bootstrap:3021–3220 plus SpiderMonkey adapter deadline heap | Real timer state, ref flags, cancellation, primitive IDs, disposal and Promise/iterator wrappers |
| diagnostics_channel | Bootstrap:5892–5925 | Fresh inert objects, false subscriber state, no-op registration/publication/store binding |
| domain | Missing public builtin entry | Deprecated public surface remains a gap, including context/error integration |

Source-backed rows do not establish conformance. In particular, a pinned
class can still depend on a missing or semantically different private
binding, scheduler, error helper or host resource.

## Actual context and resource path

The shared adapter reads/writes the owning JSContext's rooted async state
through `getAsyncContext`/`setAsyncContext`. Patch 0040 adds host-defined
Promise reaction data and rooted queued-job snapshots. Patch 0041 adds
native Promise/job IDs, trigger metadata, lifecycle callbacks, fatal hook
handling and Node tick/destroy queue drains around shell jobs. Current
shell native methods are in the frozen post-53 `js/src/shell/js.cpp`:
3317–3409; the VM-file changes remain in the patch inputs rather than that
single shell source file.

`third_party/node-core/native-async.cpp` holds per-ShellContext native
destroy ownership, numeric notifications, retry records and detached
shutdown state. Native filesystem/codec owners use it. JavaScript timers,
immediates and nextTick use the same ID allocator through createTask,
runTask and retireTask. This is real owning-layer work already in the
source candidate, with compilation and behavioral validation still pending.

The integration is not universal: native TCP/DNS/process watches retain
Promises/fds but lack the full Node provider/handle/request resource model.
Promise lifecycle coverage does not itself establish every I/O callback's
type, trigger ID, execution resource, context, destroy or ref/exit behavior.
See N-013 in the network audit.

All four hosts run this guest SpiderMonkey code. Host worker scheduling,
memory budgets, termination and I/O completion can expose additional
differences; no new runtime comparison has been performed.

## Concrete findings

| ID | Requirement | Observed source | Owning follow-up |
|---|---|---|---|
| A-002 | createHook rejects trackPromises false with promiseResolve enabled | Adapter validates callback types and boolean but omits the combination rejection. Pinned `lib/async_hooks.js`:96–100 throws ERR_INVALID_ARG_VALUE | Hook constructor validation/error contract |
| A-003 | asyncWrapProviders metadata | Public map contains only PROMISE/ZLIB/four filesystem owner types. Full target macro names, numeric positions and OpenSSL conditional metadata are recorded in async-context-requirements.json | Complete public metadata and owning provider integration are different obligations |
| A-004 | async context CLI activation/overrides | Adapter recognizes only its hard-coded enabled --async-context-frame path; unsupported overrides throw. Full Node CLI behavior is not implemented | CLI, engine context initialization and public activation |
| A-005 | EventEmitter helper dependency semantics | Local spliceOne invokes list.splice; pinned internal/util spliceOne shifts indexed elements then pops. Replacing Array.prototype.splice can therefore affect candidate listener removal through a dependency the pinned helper does not consult | Captured/helper behavior; targeted later native comparison, not a blanket primordial-hardening claim |
| A-006 | Domain public APIs and cross-resource behavior | node:domain is absent while EventEmitter.usingDomains stays false and no domain module integrates error/context/resource lifetime | Public module, async context, exception and EventEmitter integration |
| A-007 | Diagnostics identity/subscriptions/publication | channel(name) returns a fresh object on each call, subscribe/unsubscribe/publish are no-ops and hasSubscribers stays false. No named channel registry or subscriber delivery exists | Actual named/weak channel ownership and subscriber/error policy |
| A-008 | Diagnostics stores, tracing, bounded channels and scopes | bindStore/unbindStore do nothing; runStores only calls fn; trace methods omit lifecycle publication/context semantics. boundedChannel, BoundedChannel, scope APIs and tracing subscribe/unsubscribe are missing | ALS scopes, cancellation/exception paths and real lifecycle producers |
| A-009 | Built-in diagnostic producers | Inert registry cannot deliver documented console, crypto, HTTP, module, net, process, worker and other channels; adding subscribers alone will not wire producers | Owning modules and native operations must publish actual events at the correct boundaries |
| A-010 | Canceled timer argument lifetime | Candidate clearTimeout nulls callback and retires the task but leaves `_timerArgs` attached to a retained Timeout. Pinned unenroll calls cleanTimer for an enrolled timer, clearing callback/argument slots and stored contexts | Timer cancellation/close/dispose cleanup; retained arguments can retain user objects/backing storage |

A-001 in the family survey records the initial diagnostics facade finding.
A-002 comes from a direct comparison of current adapter lines 65–75 with
the unchanged target constructor. A-005 references bootstrap:444 and
896–926 and pinned `lib/internal/util.js`:535–539. It does not claim that
every upstream array operation is protected against every mutation.
A-010 compares bootstrap:3101–3108 with pinned `lib/timers.js`:73–113
and `lib/internal/timers.js`:144–148. It concerns cancellation, not the
intentional callback retention that can support refresh after expiry.

The current EventEmitter removeListener searches backward and removes one
matching listener. The older `coverage/net.json` remainingReview prose
describes an earlier implementation that removed all duplicates. Preserve
that report's historical source identity; do not repeat its old source
defect as a current finding or treat the newer source as runtime-validated.

## Completed source findings and unresolved control questions

The detailed reviews cover aliases, descriptors, inherited/returned
contracts, reentrant mutation, option/receiver/error order, warning,
ownership, context, shutdown and actual dependencies. Additional findings:

| IDs | Source disposition |
|---|---|
| A-018–A-020 | Unhandled error constructor/fatal-stack enrichment and namespace order differ; emitter-resource default/destruction prose conflicts remain target questions |
| A-021 | Hook fatal path sets shell quitting and bypasses the Node finalizer/exit callbacks; target process.exit/abort policy is missing |
| A-022–A-025 | Promise activation, alternate CLI branch, function/namespace metadata, top-level resource prototype and general native public-resource/default-trigger integration differ |
| A-026 | ALS disable/default-value/captured-frame and alternate-mode target questions require later native controls |
| A-027 | Event uses a real monotonic native clock; shared performance/time-origin coherence remains incomplete |
| A-028 | Target Event/NodeEventTarget prose differs from actual options/currentTarget/error/payload/dispatch-state behavior; do not manufacture a candidate-only defect |
| A-029 | Transferable Abort helpers mark real state but host-object transfer and actual MessagePort transport remain missing |
| A-030 | util cancellation getter function name metadata differs |

Unresolved runtime questions remain explicit in the matrix and scoped
reports: startup/Promise context identity, hook mutation and lifecycle,
thenable timing, GC/finalizers, exception recovery, timer phases and late
primitive coercion, option/abort races, target Event dispatch state,
weak/composite signal cleanup and cross-owner transfer. Source conclusions
do not settle those questions or authorize new execution. Source-reviewed
native integration gaps remain assigned to the actual owning modules.

The detailed diagnostics review adds A-016 (namespace/returned-constructor
ownership) and A-017 (target disagreement about mid-trace subscriptions).
Those questions remain visible without executing native controls now.

The early public event helper implementations are replaced by pinned
helpers through ObjectAssign in event-platform-adapter. Early util
helpers are also overwritten. Audit final initialization order rather
than counting a superseded definition as the active implementation.

## Later validation and existing evidence

Existing selected event controls and the 36-case upstream selection are
catalogued in `existing-evidence.json`. They predate the current candidate
and include failures, unsupported cases and an incomplete WebKit run.
They do not establish these new source paths or full async compatibility.

Later coverage must include unchanged `test/async-hooks` cases, relevant
parallel/sequential events/ALS/timer cases, callback exception/message
fixtures and relevant Web Platform Tests for event/abort behavior. These
categories need their actual launch/configuration requirements reviewed;
the initial parallel/sequential inventory is insufficient.

Native controls should compare hook options and exact errors, per-resource
provider/ID/trigger/context/lifetime sequences, mutation during dispatch,
reaction registration versus resolution contexts, finalization/shutdown,
timer/I/O phase ordering, abort races, domain errors, channel identity and
store/tracing publications. No new execution is authorized in this audit.
