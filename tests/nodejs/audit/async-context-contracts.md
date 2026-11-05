# Async hooks, resources and storage contracts

Completed scoped source review of the public `node:async_hooks` module,
returned AsyncHook/RunScope and AsyncResource/AsyncLocalStorage contracts.
The separate Event/Abort report completes the remaining family source
requirements. Integration in owning I/O/process/worker modules remains a
concrete implementation gap; their family audits and all runtime proof are
separate. No runtime tests, probes, compilations or builds were run.
Target Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

Requirements retain the complete async_hooks.md and async_context.md
sections, exact source identities and provider definitions. File catalogs
are future unchanged selections, not new conformance evidence.

## Public exposure, descriptors and hook registration

The namespace exports an AsyncLocalStorage getter, createHook,
executionAsyncId, triggerAsyncId, executionAsyncResource,
asyncWrapProviders and AsyncResource. AsyncHook and RunScope describe
returned objects, not namespace constructors. Target getter is enumerable/
configurable, the provider map frozen/null-prototype and ordinary export
properties writable/enumerable/configurable. Classes have their actual
Function/Object prototype inheritance and method-specific receiver/error
behavior; not every method enforces a private-field brand.

Candidate async-platform-adapter.js:1–300 supplies a real registry and
native state bridge. Its ALS getter caches the pinned class through the
module factory; it does not construct a class on every property access.
**A-024 — metadata:** Several public functions are arrow functions rather
than the target's ordinary declarations, losing their ordinary function
prototype/constructibility/name metadata. Namespace insertion order also
differs. AsyncHook callbacks are private WeakMap records, whereas the
target instance holds source-private callback symbols. Those captured
descriptors are retained observations, not independently documented APIs.

createHook reads callbacks through normal property/destructuring lookup,
including inherited getters; functions are validated and disabled by
default. enable/disable are idempotent and return the hook. Both target
and candidate defer registry changes made during callback dispatch until
the outermost dispatch completes. Nested dispatch therefore sees the
currently active set, not a half-mutated registry. Candidate uses a pending
SafeSet; target uses copied hook arrays/counts. Selection order, repeated
enable/disable, callback receiver and temporary count behavior require
later controls, not a passing export check.

**A-002** remains concrete: trackPromises=false plus promiseResolve is
rejected by target async_hooks.js:96–100 but accepted by the adapter.
The adapter's invalid-trackPromises branch also calls ERR_INVALID_ARG_TYPE
with only the property name, rather than the target boolean validator's
full expected/value arguments. Exact resulting error details remain a
control; validation and getter order must preserve the pinned wrappers.

## Lifecycle, IDs, resources and native providers

| Contract | Actual owner and candidate disposition |
|---|---|
| init | Allocate unique thread-local resource ID, type, trigger and actual resource; can be initialized then canceled without callbacks. Candidate has real JS/native/Promise records, but integration is not universal |
| before/after | Actual callback scope, 0..N calls, receiver/resource/trigger restoration and nested state. Exception recovery must place after at the target fatal/domain phase; A-014 remains a shared prerequisite |
| destroy | Asynchronous numeric notifications, actual lifetime/manual/GC distinction and tracking flags, without retaining the resource merely to notify cleanup |
| promiseResolve | Exact resolve/reject/thenable/state-assumption timing, not a generic then callback; candidate owns an engine Promise record and a once flag, with precise timing controls still pending |
| executionAsyncId / triggerAsyncId | Distinguish current execution from causal creation; native default-trigger overrides, startup modes and job resources need actual owners rather than one root ID applied universally |
| executionAsyncResource | Actual public resource where mapped, stable top-level empty resource and current native callback/Promise/resource identities; public methods of internal resources are not guaranteed APIs |
| per-worker scope | Independent guest JSContext state/ID allocation, retained frames and teardown; actual worker transport/lifetime remains a worker-family dependency |

Target internal/async_hooks.js explicitly separates execution stack,
temporary hook registries, default-trigger overrides, public-resource
lookup, Promise hook mode and destroy queue. The adapter replaces these
with state objects read/written through JSContext, a scope stack,
WeakMaps and an actual native notification queue. Native codec/file owners
provide their own records; timers/immediates/ticks use createTask/runTask/
retireTask. TCP/DNS/child/other native watches still lack full provider,
handle/request, causal callback and cleanup integration (A-003/N-013).
Promise wrappers do not implement those missing native resources.

**A-003 — full provider metadata:** Target src/async_wrap.h:34–133 lists
the noncrypto provider macro and HAVE_OPENSSL-gated trailing crypto macro;
async_wrap.cc:476–482 creates the real map and async_hooks.js freezes a
null-prototype copy. Candidate exposes only PROMISE, ZLIB, FSREQCALLBACK,
FSREQPROMISE, FILEHANDLE and FILEHANDLECLOSEREQ. Their IDs are generated
from the pinned macro, but that does not implement the omitted map or
resources. Full names, numeric positions and crypto qualification are in
the requirements artifact. A provider enumeration is metadata, not a
claim that every possible resource can be created in this build.

**A-022 — Promise activation:** Target Promise hook installation/removal
is controlled by enableHooks/updatePromiseHookMode and delayed disable;
trackPromises filters hook callbacks. Candidate installs the native
lifecycle callback at platform initialization; engine Promise records and
before/after context notification are unconditional. Filtering public
callbacks for trackPromises=false does not reproduce the target's hook
activation/context-resource behavior. Later exact controls must separate
required public identity/context behavior from incidental numeric ID gaps;
the audit does not demand arbitrary identical ID numbers across platforms.
Empty-hook activation versus the docs' no-op wording also remains a target
question, because the source can update Promise mode without callbacks.

**A-025 — top-level state and native integration:** The candidate root
resource is ObjectCreate(null), whereas target internal/async_hooks.js
uses an ordinary `{}` topLevelResource. It lacks the target's general
public-resource/default-trigger mapping for all native operations. Root
IDs/startup resource for CJS, ESM, eval and native callbacks must be
reconciled separately; no universal 0/0 or fixed expected sequence is
declared conformant by this source review.

## Engine, GC, host and shutdown trace

Patches 0040/0041 add rooted JSContext context/IDs and Promise records,
host-defined reaction-registration snapshots (including an explicit
undefined-frame record), queued job resources and before/after delivery.
Cross-realm values are wrapped and the prior context is restored through
scope exit. Promise state uses owned reserved slots, not public properties
or a monkeypatched Promise.then. The resolution hook is inserted at real
Promise resolution and settle/reject paths with a per-record once flag;
do not infer settlement-only timing from its notify label alone.

The current frozen shell has actual get/set context, ID allocation,
resource-info lookup, native enqueueMicrotask and fatal-hook entry points
at js.cpp:3317–3409. Queue snapshots and resolver/resource retention are
engine/owner work; all four hosts run this guest engine. Their outer
Promise/ALS implementations do not replace it. Host scheduling, memory
and worker shutdown remain per-host validation requirements.

native-async.cpp owns per-ShellContext destroy records and detached state.
Queue moves numeric records before JS allocation, preserves failed
delivery for retry, reports allocation failure and releases records on
shutdown; it does not call JS during native GC. Adapter finalizers retain
ID/destroyed metadata instead of the resource. Manual destroy marks the
shared flag. Construction-time tracking, later hook enable/disable,
repeated manual calls, queued delivery and resource cancellation need
separate controls. The target destroy emitter ignores nonpositive IDs;
the candidate native queue has a different predicate/argument policy,
so borrowed/invalid-resource cases remain explicit receiver questions.

**A-021 — hook fatal exit:** Target internal/async_hooks.js:160–181 prints
the error and calls process.exit, or process.abort under the relevant
flag; documented ordinary fatal hook exit still runs exit callbacks.
Candidate native asyncHookFatal (js.cpp:3369–3380) reports, marks quitting,
stops jobs, clears the pending exception and returns an uncatchable
failure. Main finalization at js.cpp:16237 runs only when not quitting,
so this path skips the Node finalizer and exit callbacks; it also has no
equivalent flag-controlled abort branch. This is an implementation gap,
not an inherent SpiderMonkey or browser limitation. General callback
exception/after-hook recovery also depends on missing A-014.

## AsyncResource public algorithms and embedding differences

The exact public class excerpt from lib/async_hooks.js is present in the
generated bundle. It validates a string type, accepts options or a retained
numeric trigger overload, validates safe integer trigger >=-1, captures
the current frame, allocates an ID and emits init when active. Empty type
is rejected only when init hooks are active. Options/getters/manual-destroy
truthiness and validation precede the documented resource lifecycle.

runInAsyncScope pushes actual ID/resource context, emits before, exchanges
captured frame, calls fn with receiver/args and restores frame/after in
finally. The callback's return or throw propagates. bind preserves dynamic
receiver if no fixed thisArg, otherwise uses the fixed receiver; length
metadata is defined from fn.length. Static bind derives a type from
provided type/function name or bound-anonymous-fn. IDs/getters and borrowed
receiver behavior follow actual symbol fields rather than an invented
universal class brand.

emitDestroy updates construction-time GC metadata and enqueues the ID,
returning the resource. The wrapper has no once-only throw guard. The
docs' manual-only/no-GC/repeated-call-error prose conflicts with its
constructor and delegate, as also recorded in A-019 for the emitter class.
Keep native controls rather than silently adding or suppressing events.
The adapter's destroy filter, native queue, fatal policy and missing
default-trigger/public-resource owners remain real differences despite
the unchanged class text.

## AsyncLocalStorage and RunScope

The active target frame implementation, AsyncContextFrame and RunScope
are exact source files in the generated bundle. The adapter's binding
reads a frame from actual native state and setFrame preserves other
execution fields. Each frame copies the current SafeMap; each storage
instance is a separate key. No outer host ALS or shared global store is
used. The source review traces the actual Map/native/jobs composition;
runtime propagation across every module remains unproven.

Constructor validates options, retains defaultValue and coerces provided
name. Name getter defaults empty. getStore distinguishes missing entry
from an explicit undefined value. enterWith replaces the current frame;
run returns/throws through fn, has an ObjectIs equal-store fast path and
restores this storage's prior value in finally. exit runs with explicit
undefined, including when defaultValue exists. Callback receiver is null
through ReflectApply; instance methods may delegate through overridable
methods, not a forced frozen private implementation.

Static bind/snapshot use an actual AsyncResource and its captured context.
withScope returns RunScope, which enters immediately and remembers the
previous value. dispose is idempotent; its own prototype Symbol.dispose
delegates to dispose. This is a returned class, not an extra public export.
Scope changes before an async function's first await can affect the caller,
as the docs explicitly warn; using syntax does not create an independent
async context. The target has no invented LIFO-error guard for manual
out-of-order disposal.

**A-023 — CLI branch (extends A-004):** Target public ALS getter selects either frame
implementation or async-hooks implementation according to the actual
async-context-frame option. Candidate getOptionValue returns true for
that one option and throws for other names; the alternate implementation
and override behavior are absent. The default active frame path is real,
but its presence does not implement every public CLI/platform branch.

The target fallback was also source-reviewed: it keeps a storageList,
enables a real init-propagation hook, stores per-instance symbol-keyed
data on actual execution resources and globally removes disabled storage
from that list. Its constructor enables storage, its exit temporarily
disables propagation, and reentry enables it again. It uses the shared
RunScope but is not the same algorithm as deleting a key in the current
frame. The guest factory does not provide this selected fallback branch.

**A-026 — retained target storage questions:** getStore outside a frame
returns constructor defaultValue while older prose says undefined. disable
deletes this storage only from the current frame in the active source;
the prose says all contexts exit and subsequent getStore is undefined.
Captured frames/defaultValue and alternate CLI implementation therefore
need explicit native controls. Candidate shares the active source rather
than independently fixing those target disagreements. The entire target
and assertions remain unchanged.

## Evidence and proposed later controls

Existing four-host baselines/selected controls are earlier identified
artifacts, with failures/unsupported/harness/pending outcomes preserved.
No current-candidate native/four-host conformance is established. Source
and metadata identity checks are not runtime tests.

Future unchanged coverage includes async-hooks category, relevant parallel/
sequential context/resource/promise tests, message/death/error output,
worker/stream/fs/socket/native-addon owners and original flags/fixtures.
Controls must exercise hook registry mutation/reentrancy/errors and exit,
Promise mode/resolve/adoption/GC, exact resource/trigger/context identity,
manual/GC/destroy ordering, metadata/receiver/option errors, ALS names/
defaults/nesting/disable/run/exit, native callback loss, snapshot/bind and
scope disposal across throws/awaits/workers. Missing owner integration,
unsupported flags and skipped tests remain nonpassing gaps. No roadmap
or validation execution is authorized by this review.
