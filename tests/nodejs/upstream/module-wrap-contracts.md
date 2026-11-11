# Native module owner contracts

This is a bounded startup/backend inventory for the pinned Node26.13.0 source
commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. It does not establish a
complete binding audit or Node startup. Original sources were read from the
hash-verified source archive; exact input identities accompany this record.

## Ownership and first consumer

Unchanged `internal/bootstrap/realm.js:186` eagerly retrieves `ModuleWrap` and
sets its prototype's prototype to null. Its `BuiltinModule.getESMFacade()`
later constructs `(url, undefined, exportNames, evaluationCallback)`, calls
`instantiate()` then `evaluate(-1, false)`, and retains that one facade. The
callback's receiver is the native wrapper and it sets actual live exports via
`setExport()`. Upstream JavaScript owns builtin identity, module caching,
exposure policy, cycles and synchronization with CommonJS exports. A native
constructor with an empty body or an ordinary object posing as a namespace
would not implement this path.

The synthetic owner needs a traced engine module record, originating realm,
URL, evaluation callback, actual module status/error and export cells. Native
module-to-wrapper identity and callback-to-wrapper edges must be traced, with
no finalizer-dependent persistent-root cycle. Node clears the evaluation
callback field before calling it (`src/module_wrap.cc:1458`). Retaining the
module must not retain an already-consumed callback indefinitely. Wrapper
methods must validate their receiver and realm/context authority.

## Binding inventory and prerequisites

The original registration in `src/module_wrap.cc:1611–1680` exposes:

| Surface | Owning contract and prerequisites |
|---|---|
| `ModuleWrap(url, context, names, callback[, cjsModule])` | Genuine synthetic module with exact export names, undefined-initialized live cells, wrapper receiver for callback, callback once and real status/error. Context admission must use actual contextify ownership. |
| `ModuleWrap(url, context, source, lineOffset, columnOffset[, cachedDataOrIdSymbol])` | Real source-text compilation with offsets, syntax errors, host-defined options, optional compile-cache validation and context identity. No function wrapper or source rewrite. |
| `link(moduleWraps)` | Ordered module request/dependency identity, import attributes and phases. Must use the actual engine graph. |
| `getModuleRequests()` | Real parsed requests, specifiers, attributes and source/evaluation/defer phase; no textual dependency scan. |
| `instantiate()` | Real graph linking, export resolution, cycles, missing/ambiguous export errors and namespace state. |
| `evaluate(timeout, breakOnSigint)` | Real graph evaluation and Promise/error result, top-level await, guest interrupt/deadline ownership, context microtask-queue behavior. `-1,false` is the ordinary builtin-facade call. Positive deadlines and signal handling cannot be ignored. |
| `evaluateSync()` | Synchronous graph path; the upstream caller rejects async graphs before evaluation, and native code checks that the Promise is fulfilled. Do not turn unresolved work into completion. |
| `setExport(name, value)` | Mutate actual existing synthetic export cells; preserve the original ReferenceError for unknown names and validate receivers. Source imports and namespace getters observe updates. |
| `getNamespace()` | Actual engine namespace exotic object and phase-aware access; ordinary copied export objects are insufficient. |
| `getStatus()`, `getError()` | Preserve native status numbering and actual terminal exception; SpiderMonkey has an additional internal EvaluatingAsync status, so raw enum numbers cannot be copied. |
| `hasAsyncGraph` | Derive from the actual linked graph; lazy property with correct descriptors, not an arbitrary false flag. |
| `setModuleSourceObject()`, `getModuleSourceObject()` | Real module-source object identity for source-phase consumers. Nested Wasm remains catalogued and deferred unless startup requires it. |
| `createCachedData()` | Real engine compile-cache bytes and state checks. A native V8 cache is not a SpiderMonkey cache. Unavailable cache generation must remain an explicit failure. |
| `setImportModuleDynamicallyCallback()` | Traced callback, originating realm/referrer/attributes/phase and real asynchronous module linking/evaluation. |
| `setInitializeImportMetaObjectCallback()` | Correct originating module and actual mutable import.meta object, invoked at the engine hook. |
| `setImportMetaResolveInitializer()` | Own the real resolver initializer and module/private-state lifetime. |
| `createRequiredModuleFacade()` | Real required-ESM facade with live bindings and synchronous fulfilled evaluation checks. |
| `throwIfPromiseRejected()` | Inspect actual Promise state/result and throw the original exception; unresolved work must not become success. |
| Status constants | Original V8 order: Uninstantiated, Instantiating, Instantiated, Evaluating, Evaluated, Errored. Map engine states explicitly. |
| Phase constants | Source=1, Defer=2, Evaluation=3 in the original native header. Availability and semantics must follow actual engine support. |

These rows identify the registration surface and core dependencies. Complete
argument conversions, every error/assertion, exceptional path, lifecycle and
all transitive consumers remain to be audited. The existing syntax index
supplies consumer locations; it is not proof those contracts are implemented.

## Engine prerequisite

SpiderMonkey140 has genuine synthetic module records, export environments,
namespace exotic objects, live bindings and graph resolution for JSON modules.
Its original public API only creates JSON synthetic records, and graph
`InnerModuleEvaluation` skips their evaluation because JSON has no callback.
Callback-backed Node builtin facades require extending that machinery to run
real embedding evaluation steps, including when imported by a source module.

The new engine extension uses the existing native module record and graph,
adds a traced private value and evaluation Promise, and separates public
export names from local environment identifiers. The latter is required for
empty/numeric names and `*namespace*`, which otherwise collide with the
engine's internal namespace binding. JSON keeps its original path and type.
The diagnostic shell API is not the Node ModuleWrap binding. Its internal
Promise identity/reentry policy is not a public Node VM compatibility claim.

The selected revision-20 guest engine passed 15 controls on the Node host,
using `--enable-import-attributes` for the JSON import syntax. That real
parser option is disabled by default in shell mode; the eventual Node
embedding must configure it before compiling sources that require it.
The controls cover real source imports/live reexports, dependency ordering and
failure, top-level await, root evaluation reentry, refusal to complete a graph
whose synthetic dependency is still evaluating, arbitrary export names,
namespace identity, GC retention and the unchanged JSON path. Shell debug
getters intentionally hide synthetic internals, so these controls observe
lifecycle through actual link/evaluation operations and Promise results.
Exact inputs/artifacts and all failed attempts are in
`synthetic-module-engine-check.json`. Node ModuleWrap and upstream startup
remain unimplemented.

## Native reference observations

The exact pinned Darwin arm64 Node executable, SHA-256
`533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4`,
passed the four bounded controls in `synthetic-module-native-controls.cjs`
with `--experimental-vm-modules`. The experimental warning is retained.
These controls observe public VM behavior only:

- Arbitrary names including `*namespace*`, `0` and the empty string, with real
  live namespace updates.
- Public `vm.Module.evaluate()` rejects reentry with `ERR_VM_MODULE_STATUS`.
- Callback failure is terminal and preserves exception identity. Repeated
  public evaluation of a failed module returns distinct rejected Promises.
- Source imports observe live synthetic bindings, and a failed synthetic
  dependency prevents the importing body from running.

The upstream VM wrapper itself validates status, while native ModuleWrap owns
engine evaluation, interrupts and context microtask handling. Do not infer a
raw engine Promise-identity rule from these public wrapper observations or
claim that engine-only controls prove Node ModuleWrap compatibility.

## Remaining integration and validation

Implement the native wrapper and binding against real synthetic and source
module records. Reconcile timeout/interrupt state and context microtask queues
with the real guest process. Connect builtin compiler/source registry and
canonical per-context state to one realm/binding owner, then run complete
`internal/bootstrap/realm` with actual errors/util/process contracts. Preserve
all upstream assertions and source bodies.

Validate exact-artifact source/synthetic graphs, builtin CJS/ESM facades,
cycles, live updates, import.meta/dynamic import, TLA, sync rejection,
exception identity, source positions, GC/lifecycle/teardown and cancellation
on Node/Chromium/Firefox/WebKit. Security/contextify and OOM paths remain
separate obligations. No Node startup, four-host module conformance or complete
backend catalog is established by this inventory or native reference.
