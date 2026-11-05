# VM, V8, inspector and debugger public contracts

State: **source review complete with implementation gaps**, covering
`node:vm`, `node:v8`, `node:inspector`, `node:inspector/promises` and the
public debugger narratives. The [earlier layer report](engine.md) remains
part of the review. No runtime test/probe, compilation or build ran.
Requirements, 361 original discovery identities (193 documentation
sections and 168 descriptor observations), additional gated/returned
members, exact source hashes and future unchanged-source candidates are
preserved in `engine-requirements.json` and
`engine-validation-candidates.json`. These records are not unique APIs or
passing compatibility.

## VM implementation and actual native owner

Candidate `bootstrap.js:5938–5990` forwards seven VM APIs to
`packages/registry/spidermonkey/node-compat/adapter.js:581–592` and the
frozen post-53 `js.cpp:2590–3007` (identity in state.json). Native code
creates actual compartments/zones/globals, roots the wrapped sandbox in
reserved slots, compiles realm-independent Stencils, instantiates them in
the target realm, executes real scripts, and wraps results/exceptions back
to the caller. Script handles are actual GC-owned Stencil objects, not
serialized JSON or fake execution. These positive paths do not establish
the Node contextified-object or execution contract.

Target `lib/vm.js`, `lib/internal/vm.js`, `lib/internal/vm/module.js` and
`src/node_contextify.cc` distinguish ordinary sandbox association,
DONT_CONTEXTIFY globals, Script/ContextifyScript, native compiled-function
ownership, per-context module/import/microtask state and deadlines. An
embedding browser realm or embedding Node's vm module is not the guest
engine's implementation.

| IDs | Source conclusions and exact requirements |
|---|---|
| E-003/E-004 | Candidate makeContext always allocates/returns a different global wrapper (`js.cpp:2739–2810`), while target createContext reuses an already-contextified sandbox (`lib/vm.js:226–268`). Native resolve reads/copies a sandbox property into an enumerable global data property; add/delete/enumerate hooks (`2599–2687`) do not implement live Node getters/setters/descriptors/mutations/identity. No blanket copying or claimed sandbox sync may substitute for the correct exotic-object owner. |
| E-005/E-014 | Candidate normOpts uses truthy defaults and bitwise integer coercion; createContext uses sandbox||{}; isContext returns false for nonobjects; all execution code uses String(code). Target validates context/options/types/ranges, Script uses template coercion (including Symbol rejection), compileFunction requires a string and string-array parameters, and isContext rejects invalid object inputs. Filename/name/origin/line/column/displayErrors, invalid versus absent options and exact error phase are observable. Native compile only applies filename and lineOffset (`2827–2884`), ignoring forwarded columnOffset/displayErrors. |
| E-006/E-014 | runInNewContext/Script.runInNewContext pass the whole options object directly to createContext, which reads codeGeneration; target maps **contextCodeGeneration/contextName/contextOrigin** through getContextOptions (`vm.js:199–223`). microtaskMode afterEvaluate and import callbacks/default-loader sentinel are absent. Native realm creation unconditionally disables shared memory/Atomics (`js.cpp:2775`), even though the recipe enables shared-memory support. That is candidate policy/wiring, not an all-host engine impossibility. |
| E-007 | compileFunction creates/evaluates a function-expression string using params.join and optional parsingContext (`bootstrap:5980–5986`); this does not supply validated function-body parsing/parameters/contextExtensions, native function metadata, cached data, dynamic imports or exact parsing-context errors (`vm.js:319–372`, internal/vm.js). |
| E-008/E-013 | createScript is missing. Script supports only three execution methods, without target ContextifyScript prototype/constructor identity, createCachedData, instance sourceMapURL/cachedDataRejected metadata, actual cache rejection/production or public frozen constants. Target `node_contextify.cc:946,1105–1133` installs createCachedData on the prototype and metadata on the instance. Earlier labels placing all metadata on Script.prototype are retained as grouped requirements, not assertions of wrong property placement. |
| E-008/E-015 | Flag-enabled Module, SourceTextModule and SyntheticModule owners are missing, not merely absent from a default descriptor capture. SourceTextModule requires live module requests/attributes/**phase**, linkRequests/instantiate, static hasTopLevelAwait/hasAsyncGraph, cached data, namespace/status/error/context and dynamic import/meta callbacks. SyntheticModule is instantiated in its target constructor and its link is intentionally a no-op (`internal/vm/module.js:461–510`); a correct target no-op must not be mistaken for an implementation defect. Missing the actual owner is the candidate defect. |
| E-009 | Candidate rejects any non-null timeout, ignores breakOnSigint and has no owned per-context microtask/deadline scope. The shell already has CancelExecution/JS_RequestInterruptCallback (`js.cpp:8823+`), contradicting the blanket comment that interrupts are unavailable. Proper native deadline/cancellation/cleanup and SIGINT restoration remain missing; this audit did not execute a timeout or conclude that those lower primitives are already sufficient. |

VM Module is abstract; SourceTextModule/SyntheticModule inherit it rather
than export duplicate per-method namespace functions. Public context,
status/error/namespace getters, custom inspection, linker validation and
cross-context errors must derive from the actual module graph. Target
evaluate converts validation/status errors into rejected Promises, whereas
some construction/linkRequests operations throw synchronously. Promise
resolution timing, TLA dependencies/cycles/live exports, graph retention
and destruction must not be flattened into one synchronous wrapper.

Compile-time dynamic-import admission differs from calling import():
target no callback permits compilation but rejects the actual import with
ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING; callback and missing-flag sentinels
and main-context default loader have different rules
(`internal/vm.js:53–91`; vm.md:2371+). Loading family's real ModuleLoader
does not automatically supply these VM referrer/context/options contracts.
Inherited Object/ContextifyScript members and prototype chains, cross-realm
brands, thrown values, nonconfigurable/accessor/symbol keys, globals and
poisoned intrinsics all remain later native-control obligations.

## V8 module: actual measurements, formats and returned handles

Candidate `bootstrap.js:5927–5936` returns only
`{heap_size_limit:256*1024*1024}` and an empty heap-space array. Neither is
backed by current engine accounting. Target `lib/v8.js:277–336` populates
15 heap fields from actual engine statistics and actual space records.
V8 space names/order/availability may vary by V8 version; that documented
variability is not permission to report missing measurement as conformant.

E-010/E-011 remain definite missing/partial implementation findings. The
entire Serializer/Deserializer/DefaultSerializer/DefaultDeserializer
hierarchy, cachedDataVersionTag, real heap/code/C++ statistics, heap
snapshot stream/file ownership, object queries, flags/coverage,
promiseHooks, startupSnapshot and profilers are missing. The requirements
artifact preserves every method and source-exposed hook/descriptor,
including callbacks that subclasses may provide without an own base-class
method (`_writeHostObject`, `_getSharedArrayBufferId`, `_readHostObject`).

New E-016 covers returned profiling and callback ownership. Target
startCpuProfile/startHeapProfile return **SyncCPUProfileHandle** and
**SyncHeapProfileHandle**, with idempotent stop and Symbol.dispose
(`v8.js:180–253`); these are returned types, not additional own module
exports. Worker methods return separate asynchronous CPUProfileHandle and
HeapProfileHandle (`internal/worker.js:142–201`), whose stop caches a Promise
and rejects native errors/ERR_WORKER_NOT_RUNNING. Their asyncDispose awaits
actual native stop. GCProfiler similarly owns real native collection and
disposal (`v8.js:531–552`). Real CPU/heap sampling intervals/budgets/GC
flags, active-session admission and teardown cannot be supplied by a
constant profile or a listener-only handle. Worker lifecycle is a shared
prerequisite, not an excuse to skip these v8 documentation obligations.

Promise hooks require real engine promise/parent events, list snapshots,
registration/removal and fatal-error routing
(`internal/promise_hooks.js`). Existing async compatibility primitives are
related foundations but no node:v8 promiseHooks export is installed.
Startup snapshot callbacks/data/main selection require genuine build/read
phases, ordering and coded duplicate/not-building errors
(`internal/v8/startup_snapshot.js`), with filesystem/CLI/SEA dependencies.
Ordinary non-snapshot behavior still has a public contract.

Serialization is HTML structured-clone compatible **and backward-compatible
for stored buffers** (v8.md:696+). Default serialization deliberately stores
only a view's byte span, avoiding its entire pooled Buffer backing storage
(`v8.js:441–530`). Base subclass hooks, out-of-band/shared backing IDs,
write/release/failed states, aligned/unaligned views and zero-copy
deserialization have distinct byte ownership/lifetime contracts. The
candidate's private SpiderMonkey clone format is not automatically a
Node-readable v8 serialization buffer. Node does not require equal values
to produce byte-for-byte identical serialized output; later controls must
test supported value/identity and required interoperability rather than
invent an identical-output assertion.

## Inspector and debugger

Both inspector namespaces are absent from the candidate registry; there is
no public guest inspector bridge elsewhere in the inspected native adapter
and bootstrap. E-012/E-017 distinguish this missing bridge from the fact
that SpiderMonkey has debugger/interrupt primitives (e.g.
`js.cpp:15619` defines Debugger). Host browser DevTools inspect the outer
host, not automatically the guest JS engine's named public sessions.

Target `lib/inspector.js` checks hasInspector and throws a coded unavailable
error when disabled. When enabled it requires actual native Connection/
MainThreadConnection, request IDs, pending response map, notifications,
protocol errors and EventEmitter ownership. Session.connect and
connectToMainThread have state/thread restrictions. disconnect tears down
the exact connection and schedules pending callbacks with
ERR_INSPECTOR_CLOSED; open creates a disposable native listener, url and
waitForDebugger reflect actual activation. The target's open port checks
are intentionally limited for legacy behavior (`inspector.js:174+`), so
later work must not replace them with an assumed uniformly strict overload.

The promises Session **inherits** the callback Session and replaces post
with its promisified method (`lib/inspector/promises.js`); connect,
disconnect, notification events, main-thread restrictions and shared
namespace functions remain inherited/aliased requirements. A descriptor
capture of own methods does not erase inherited methods. The returned
open handle's null prototype/Symbol.dispose and the console protocol's
object retention are further ownership contracts.

New Network events include dataSent/dataReceived and WebSocket lifecycle;
NetworkResources.put validates/stores actual resources behind its specific
flag, with a warning/return when disabled
(`internal/inspector/network_resources.js`). DOMStorage notifications and
registerStorage connect to actual protocol storage state. Missing owners
must not be replaced with a fabricated successful empty response. Arbitrary
CDP Runtime/Debugger/Profiler/HeapProfiler/Network schemas need explicit
backend translation and per-domain boundaries, not an assertion that all
V8 debugger internals exist.

Debugger documentation is an executable public CLI contract, not another
requireable `node:debugger` module. Interactive inspect includes stepping,
watchers/breakpoints, launch/attach, source and REPL state. Node 26 probe
mode adds real child launch, paired --probe/--expr, conditions/max hits,
source locations, JSON v2 reports, previews, deadline/terminal errors and
exit codes (`internal/debugger/inspect.js:280–367`, inspect_probe.js).
No such probe was executed in the audit. These are missing debugger/CLI/
process/transport integration, with terminal/loader/source-map owners,
not extra passing APIs merely because shell debugging exists.

## Boundaries, four hosts, questions and evidence

| Scope | Concrete distinction |
|---|---|
| All four hosts | Same guest SpiderMonkey VM/native implementation, bootstrap and missing inspector/v8 bridges. Neither outer Node's V8 nor a browser's own VM is the guest engine. Native result/error wrapping, GC roots, script/module graph and async lifetime must be real across hosts. Current runtime outcomes are unestablished. |
| Current no-JIT recipe | build-spidermonkey.sh:287 selects --disable-jit. Existing hashed engine-source-evidence.json excerpts show WasmFeatures/SignalHandlers rejecting JS_CODEGEN_NONE support. This is source evidence for nested guest JS Wasm compilation under this recipe; outer hosts running Kandelo Wasm are a different layer. It does not exclude ordinary VM evaluation, realm sharing, inspector, WASI or every TypeScript path. Compiled feature metadata still lacks current runtime validation. |
| V8 internal state/formats | V8 code caches, flags, heap-space representation, startup snapshot binaries and heap schemas do not become compatible by renaming a Stencil/SpiderMonkey blob. Some contracts are intrinsically V8-specific, but portable values/control/measurement, error/activation and required interoperability remain implementation obligations. No whole module is accepted as unsupported. Field/format-specific boundary proposals require final review. |
| External inspector transport | Actual guest debugger listener/protocol/backend and main/worker routing are missing. Browser external raw socket ingress has a concrete adapter restriction; local/session or embedded Session protocol integration is not made impossible by that restriction. |

Open audit/reference questions are retained:

- Establish exact VM property/realm/global forwarding, code-generation error
  details, arbitrary thrown-value identity and microtask/deadline/SIGINT
  cleanup under the pin; no runtime outcome is inferred from a proposed
  source-control example.
- The process-global gKandeloVmSecurityInstalled/security callback lifetime
  versus actual per-runtime worker contexts needs later ownership controls.
  It is not yet a proven cross-worker policy leak. Native GC/zone retirement
  and root lifetimes likewise need actual controls, not a guessed leak.
- V8-specific fields/formats need individual applicability/interop decisions
  without silently changing the target. Missing serializer/profiler/VM APIs
  are not all justified boundaries.
- v8.md async profile stop prose says fulfillment with error/data; the actual
  worker source rejects errors and not-running state. Preserve both for
  native controls. CPU option comments use different names than the public
  normalizeCpuProfileOptions implementation; use the exact source/docs pin,
  not stale comments. SyntheticModule's actual eager instantiate/no-op link
  and allowed setExport phases require controls rather than older assumptions.
- Feature/flag-gated VM modules, inspector availability and NetworkResources
  must be evaluated in the correct configuration later. A default capture
  is incomplete discovery, not evidence these APIs do not exist upstream.

[Historical evidence](existing-evidence.md) retains its original identities,
statuses, common prerequisite failures and Firefox/WebKit launcher limits.
The old test-vm-not-strict pass is narrow evidence for its exact artifacts;
it does not validate contextification or the current candidate. No current
four-host runtime conformance exists for this family.

Later unchanged upstream/native controls must compare ordinary versus
DONT_CONTEXTIFY identity, inherited/described/symbol/accessor/global
properties, Script reuse and metadata, options/coercion/errors, dynamic
imports, module requests/TLA/cycles and partial/error graphs, real
deadline/microtask/SIGINT/resource cleanup, actual measurement rather than
fixed values, persisted serializer interop/view spans, profiler handle and
snapshot phase ownership, and inspector callback/Promise/notification/
disconnect/main-worker/protocol/debugger CLI behavior. The catalog is an
unchanged-source selection aid, not a completed variant/fixture/peer or
assertion denominator. Preserve all nonpassing statuses.

Implementation and new runtime validation remain unauthorized. Finish the
entire broad audit and present its roadmap/questions before either begins.
