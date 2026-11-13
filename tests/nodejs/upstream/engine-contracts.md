# Engine boundaries for unchanged Node core JavaScript

Read-only source audit against retained Node 26.13.0 / `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. Exact source identity and official verification are recorded separately in [pin-verification.json](pin-verification.json). This report executes no Node/SpiderMonkey code, runtime probes, tests or builds. It does not change upstream files.

All four outer hosts run the guest SpiderMonkey implementation. The outer Node/Chromium engine being V8 does not supply guest V8 bindings automatically. These findings concern guest engine/embedding semantics. Engine differences are not engine defects; no upstream-defect workaround is proposed.

## Main conclusions

1. The first obstacle is the native bootstrap/embedding contract, not widespread V8 `%Intrinsic(...)` syntax. A textual scan of 443 production JS inputs found zero uppercase native-intrinsic call candidates. V8 fuzz/test tools outside Node shipped dependency inputs do contain such syntax and are not evidence that Node core needs it. This is source-search evidence, not parser validation.
2. Unchanged startup needs native builtins/module_wrap exports, fresh complete primordials, hidden private identities, structured error hooks and truthful job/snapshot state. Several features become active only later, but their bindings/constructors can still be imported at startup.
3. Most obstacles are implementable SpiderMonkey engine/binding work while leaving JS bytes unchanged. Ordinary Symbols, WeakMap rewrites, Promise wrappers, eval-based contexts and inert success bindings do not fulfill the contracts.
4. `node:v8` needs API-specific decisions: Promise hooks and serialization are meaningful implementable contracts; literal V8 heap spaces, flags, snapshots and cache artifacts cannot be fabricated as SpiderMonkey state.
5. A real nested-Wasm backend is a prerequisite for unchanged Undici HTTP/1 and bundled Amaro. Deferring it until after an initial fs/streams/CJS slice is possible; declaring complete unchanged fetch/TypeScript first is not. Native Node HTTP parser work does not silently substitute for Undici Module/Instance calls.

## Priority inventory

| ID | Area | Static reachability | Contract class |
|---|---|---|---|
| E01 | Builtin compiler and per-realm bootstrap | Startup: realm.js precedes node.js; builtin dependencies load on demand. | Implementable embedding/binding contract, not special JS syntax. |
| E02 | Standard intrinsic globals and primordials | Before realm bootstrap, on every guest realm. | Engine standard-library prerequisite; absence would be an engine implementation gap, not a V8 syntax problem. |
| E03 | Private engine keys and shared internal symbols | Startup: process exit state/errors; later CJS, VM, source maps, clone and messaging. | Implementable engine property-key semantics plus one shared native symbol registry. |
| E04 | Error capture, CallSites and lazy stack formatting | Startup: realm installs formatter; error construction/formatting widely reachable. | Engine hooks required, with unchanged JS formatting policy above them. |
| E05 | Microtasks, nextTick and rejection event ownership | Startup: node.js installs task queue; every asynchronous API. | Implementable engine/job queue + callback-scope contract. |
| E06 | Promise hooks and continuation-preserved context | Queue module imports at startup; active ALS/async_hooks/Promise hooks are conditional. | Implementable engine lifecycle hooks; cannot be recreated with Promise.then wrappers. |
| E07 | Side-effect-free engine introspection | Inspect/util/errors dependencies loaded broadly; detailed inspection usually lazy. | Implementable native inspection bindings, with some engine-model-specific presentation. |
| E08 | CJS compiler and source metadata | Normal CJS program loading; builtins use separate E01 compiler. | Implementable contextify compiler contract with engine-specific cache boundaries. |
| E09 | ModuleWrap, synthetic builtins and real ESM graph | ModuleWrap constructor/prototype needed at startup; synthetic builtin facades and source modules used on import. | Engine module embedding contract, including potentially missing language features. |
| E10 | VM contexts, compilation and watchdog control | Public node:vm and loader customization; not required to execute every basic builtin. | Implementable realms/native embedding with substantive lifecycle and safety requirements. |
| E11 | Backing stores, hidden clone brands and transfer | Buffer startup uses untransferable marker; structuredClone/messaging/workers lazy. | Implementable engine memory/clone contract; JS source reuse is insufficient. |
| E12 | V8 serialization wire format | node:v8 import consumes serdes constructors; test/bench/error transport can pull it indirectly. | Implementable cross-engine codec contract, not simply a permanent V8-only exclusion. |
| E13 | Snapshots, V8 caches, heap/optimizer and inspector | Snapshot state binding startup-reachable; heap/profiler/inspector public APIs lazy/config-dependent. | Mixed: truthful startup state is implementable; exact V8-specific observability needs explicit boundary decisions. |
| E14 | Nested WebAssembly required by unchanged shipped JS dependencies | Lazy fetch HTTP/1 parser and TypeScript transform; module Wasm imports; node:wasi. | Real execution backend prerequisite; cannot be replaced by repointing an existing native HTTP parser under unchanged bytes. |
| E15 | Native addon imports are a distinct ABI boundary | Only native .node addon import/load; regular builtin JS execution unaffected. | Native machine-code/addon ABI and embedding integration, not JS parser syntax. |

## Findings and exact source anchors

### E01: Builtin compiler and per-realm bootstrap

Native bootstrap must create fresh primordials and process objects, pass the real getInternalBinding/getLinkedBinding callbacks, and compile complete source files with upstream parameter lists and names. The builtin compiler returns functions receiving exports, require, module, process, internalBinding, primordials; modules share the upstream cache and cycle semantics. Dependency aliases must come from the real builtins/deps loader rather than isolated subsystem-specific require maps.

**Disposition:** Make unchanged primordials + realm.js a first milestone. Implement builtins.compileFunction/builtinIds/setInternalLoaders and bootstrap ownership natively. A normal compilation wrapper matching Node is allowed embedding; substring extraction or body replacement is not.

**Source:**
- [`lib/internal/bootstrap/realm.js:11`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/realm.js#L11): Upstream bootstrap order.
- [`lib/internal/bootstrap/realm.js:180`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/realm.js#L180): builtins binding.
- [`lib/internal/bootstrap/realm.js:437`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/realm.js#L437): Whole module factory compiler and six arguments.
- [`lib/internal/bootstrap/realm.js:476`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/realm.js#L476): Shipped JS dependency fallback.
- [`src/node_builtins.cc:515`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_builtins.cc#L515): Native bootstrap argument shapes.

**Limits:** Static required contract only. This report does not prove the current Kandelo loaders satisfy it or that all bindings are inventoried.

### E02: Standard intrinsic globals and primordials

Primordials enumerates actual property descriptors from constructors/prototypes, including Float16Array, Iterator, WeakRef and FinalizationRegistry; it calls Iterator.prototype.drop and Iterator.from to discover hidden iterator prototypes. Error.captureStackTrace and Symbol disposal members must be available before capture if later upstream code consumes their primordial aliases. Do not silently omit missing globals or substitute fake constructors.

**Disposition:** Retain unchanged primordials and explicitly inspect the configured SpiderMonkey standard intrinsic inventory. Implement missing real intrinsics in the engine or make an explicit API boundary decision. A handwritten truncated primordials list cannot establish unchanged execution.

**Source:**
- [`lib/internal/per_context/primordials.js:185`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/per_context/primordials.js#L185): Constructor and prototype descriptor capture.
- [`lib/internal/per_context/primordials.js:199`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/per_context/primordials.js#L199): Float16Array required by eager loop.
- [`lib/internal/per_context/primordials.js:206`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/per_context/primordials.js#L206): Iterator required by eager loop.
- [`lib/internal/per_context/primordials.js:284`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/per_context/primordials.js#L284): Iterator helper prototype discovery.
- [`lib/internal/per_context/primordials.js:304`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/per_context/primordials.js#L304): Iterator.from prototype discovery.

**Limits:** No engine runtime capability probe run; this is not a claim that any listed standard intrinsic is currently missing.

### E03: Private engine keys and shared internal symbols

Node creates V8 Private keys and exports the exact same identities through util.privateSymbols and per-context arguments. Upstream JS uses ordinary bracket syntax with these engine keys; native owners use GetPrivate/SetPrivate. Keys must remain hidden from ordinary reflection, consistent between JS/native, and coherent for object lifecycle, realms, proxies and transfer admission. Ordinary Symbol values are not equivalent. Internal public-ish symbols from symbols binding are a separate registry and need exact sharing.

**Disposition:** Implement the native private-name registry in SpiderMonkey and use genuine hidden private names; the old createCloneModeSymbol uses NewPrivateName already and is a reusable foothold. Replace per-adapter ordinary Symbol/WeakMap substitutions by the owning engine/binding contract, preserving unmodified JS.

**Source:**
- [`src/env.cc:504`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/env.cc#L504): Private::New creation.
- [`src/env_properties.h:20`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/env_properties.h#L20): Authoritative private key list.
- [`src/node_util.cc:542`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_util.cc#L542): Private identities exported to JS.
- [`lib/internal/bootstrap/node.js:94`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/node.js#L94): Process state consumes private key at startup.
- [`lib/internal/errors.js:951`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/errors.js#L951): Errors consume shared private key.
- [`lib/internal/modules/esm/utils.js:11`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/esm/utils.js#L11): Host-defined/module-source private keys.
- [`lib/internal/per_context/domexception.js:18`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/per_context/domexception.js#L18): Per-context privateSymbols argument.

**Limits:** Existing Kandelo private-name implementation is source reuse evidence only: packages/registry/spidermonkey/patches/0042-kandelo-node-clone-boundary.patch:30. Full V8 Private equivalence, including proxy/frozen object edges, remains unvalidated.

### E04: Error capture, CallSites and lazy stack formatting

Node installs a prepareStackTrace callback during realm bootstrap. Engine error creation/capture must retain actual frame identities, implement Error.captureStackTrace(error, boundary), stackTraceLimit and structured CallSite methods, then invoke the callback with the correct error realm/global when stack is accessed. JS formatter/source-map helpers do not produce missing engine frames or capture semantics. Cross-realm policy, hidden frames, source positions, async frames, descriptors and reentrancy are observable.

**Disposition:** Implement the native errors binding and actual SpiderMonkey Error/stack hooks before replacing guarded internal/errors source with its unchanged body. The existing assertion-only native source capture is useful input, not public Error.captureStackTrace. Never invent frames or keep the guard that suppresses required upstream behavior.

**Source:**
- [`lib/internal/bootstrap/realm.js:485`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/realm.js#L485): Mandatory per-realm formatter installation.
- [`lib/internal/errors.js:123`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/errors.js#L123): Realm selection and CallSite contract.
- [`lib/internal/errors.js:189`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/errors.js#L189): Public capture API needed for aggregate error boundary.
- [`lib/internal/errors.js:546`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/errors.js#L546): Recapture wrapped error at actual function boundary.
- [`src/api/environment.cc:250`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/api/environment.cc#L250): V8-native callback integration.
- [`src/node_errors.cc:1150`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_errors.cc#L1150): Binding callback registration.

**Limits:** Current source explicitly lacks this: third_party/node-core/native-error-source.cpp:1-2; third_party/node-core/build.py:231-242 rewrites internal/errors with capability guards. Source evidence does not validate a replacement engine design.

### E05: Microtasks, nextTick and rejection event ownership

task_queue binding owns actual microtask enqueue/checkpoint, mutable tickInfo shared state, tick callback and promise rejection callback. Upstream task_queues.js interleaves nextTicks, microtasks and rejection delivery in a specified loop. Native callback scopes must cooperate with that loop; draining the outer browser queue is not equivalent. Promise reject events must refer to actual guest promises and correct handler-added timing.

**Disposition:** Implement the full binding using the guest engine job queue and native callback entry/exit scopes. Keep upstream task_queues.js and process/promises.js unchanged. Audit exception unwinding and nested checkpoints before any broad module support claim.

**Source:**
- [`lib/internal/bootstrap/node.js:365`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/node.js#L365): Tick/timer callback setup.
- [`lib/internal/process/task_queues.js:9`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/process/task_queues.js#L9): Required native job queue binding.
- [`lib/internal/process/task_queues.js:62`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/process/task_queues.js#L62): Ordering policy.
- [`lib/internal/process/promises.js:14`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/process/promises.js#L14): Promise rejection event registry.
- [`lib/internal/process/promises.js:419`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/process/promises.js#L419): Native callback installed.
- [`src/node_task_queue.cc:140`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_task_queue.cc#L140): Actual native microtask checkpoint.

**Limits:** No queue ordering or rejection differential executed. Existing custom async adapter/native patch work is potential reuse, not proof it is the exact upstream binding.

### E06: Promise hooks and continuation-preserved context

Native async_wrap.setPromiseHooks feeds real promise init(parent), before, after and settled events into unchanged internal/promise_hooks. Async hooks adds separate resource ID/context policy. async_context_frame get/setContinuationPreservedEmbedderData must persist across actual promise jobs and await continuations, not just synchronous callbacks. Binding exports are imported even if optional behavior is inactive.

**Disposition:** Preserve raw Promise lifecycle and async-ID admission separation from later campaign engine patches; bind it to the complete upstream registries. Upstream inactive optional paths are legitimate when the real option is disabled; fabricated active support or silent loss of await context is not.

**Source:**
- [`lib/internal/promise_hooks.js:11`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/promise_hooks.js#L11): Native raw hook registration.
- [`lib/internal/promise_hooks.js:79`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/promise_hooks.js#L79): Shared hooks composed once.
- [`lib/internal/async_hooks.js:385`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/async_hooks.js#L385): AsyncWrap hooks consume raw engine lifecycle.
- [`lib/internal/async_context_frame.js:7`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/async_context_frame.js#L7): Continuation data binding.
- [`lib/internal/async_context_frame.js:55`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/async_context_frame.js#L55): Real optional flag selects active behavior.
- [`src/async_context_frame.cc:37`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/async_context_frame.cc#L37): V8 native continuation data owner.

**Limits:** Existing source engine patches contain relevant lifecycle work, including 0195-node-mapping-curves-promise-fetch.patch. Parent audit covers its exact artifact limitations; no runtime inference made here.

Current continuation implementation: the revision-38 engine stores a genuine
rooted value per JSContext, captures real host-defined reaction snapshots and
traces/restores queued values across Promise, thenable, await, generator and
microtask execution. The complete original async_context_frame.cc and its Scope
compile unchanged over those primitives. Raw Promise lifecycle hooks and assigned
async-resource/ID scopes remain separate unfinished contracts. Active original
Frame/AsyncLocalStorage consumers still reach ERR_OPTIONS_BEFORE_BOOTSTRAPPING;
those four checks are deferred until real startup, with their failures retained.
See continuation-contracts.json and continuation-engine-check.json for bounded
implementation, source identities and four-host evidence.

### E07: Side-effect-free engine introspection

util binding must inspect actual promise state/result, proxy target/handler, collection iterator entries and own properties without executing user getters, consuming iterators or triggering proxy traps. types binding needs real engine brands across realms. Call-site/source information must come from real frames. JS-level duck typing is insufficient.

**Disposition:** Reuse genuine SpiderMonkey Promise/Proxy/iterator inspection owners (0039 source patch is a foothold). Expose the exact util/types binding contracts to unchanged inspect/errors/util modules; retain explicit unresolved differences rather than string heuristics.

**Source:**
- [`lib/internal/util/inspect.js:136`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/util/inspect.js#L136): Native inspection dependencies.
- [`src/node_util.cc:105`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_util.cc#L105): Promise state/result without reaction.
- [`src/node_util.cc:123`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_util.cc#L123): Proxy target/handler without traps.
- [`src/node_util.cc:172`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_util.cc#L172): Iterator PreviewEntries without consumption.
- [`src/node_util.cc:629`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_util.cc#L629): Native call-site exposure.

**Limits:** No complete type/iterator/proxy inventory or new runtime verification performed. V8-specific inspection text and full CallSite parity need separate exact assertions.

### E08: CJS compiler and source metadata

Unchanged CJS loader uses contextify.compileFunctionForCJSLoader and module_wrap status/facade helpers, not a generic global eval. Compiler must provide real wrapper execution, source positions/URL/maps, module-syntax detection, cache result shape and dynamic-import host-defined identity. CJS cycles and errors stay in upstream loader; required synchronous ESM handoff must share the real module graph.

**Disposition:** Implement contextify and required module_wrap native contracts. Existing CJS source capture/compiler native work can be reused if its result and metadata contracts match. Reject source rewrites to split/recreate the loader.

**Source:**
- [`lib/internal/modules/cjs/loader.js:67`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/cjs/loader.js#L67): Shared hidden CJS bookkeeping.
- [`lib/internal/modules/cjs/loader.js:78`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/cjs/loader.js#L78): Native ESM facade contract.
- [`lib/internal/modules/cjs/loader.js:155`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/cjs/loader.js#L155): CJS compiler binding.
- [`lib/internal/modules/cjs/loader.js:1900`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/cjs/loader.js#L1900): Real compile invocation.
- [`src/node_contextify.cc:1651`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_contextify.cc#L1651): Native CJS compile implementation reference.

**Limits:** Need a binding-by-binding implementation inventory; line presence does not demonstrate current compatibility. V8 bytecode cache identity is separate from source-level CJS behavior.

### E09: ModuleWrap, synthetic builtins and real ESM graph

realm.js imports ModuleWrap unconditionally and nulls its prototype. Builtin ESM facades require real synthetic modules, named live exports, instantiate and immediate evaluate; full ESM requires source module requests, attributes, source/defer/evaluation phases, namespace identity, link/evaluation status, dynamic import/import.meta callbacks, graph cycles and TLA rejection. Node require(ESM) requires synchronous evaluateSync behavior for admissible graphs.

**Disposition:** Provide one genuine SpiderMonkey module-record owner with exact binding-facing shape; existing engine source graph/synthetic builtin work is a starting point. If the guest parser lacks a standardized phase syntax requested by user code, it is an engine feature gap to implement or explicitly review—not permission to rewrite upstream loader source.

**Source:**
- [`lib/internal/bootstrap/realm.js:186`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/realm.js#L186): Unconditional constructor dependency.
- [`lib/internal/bootstrap/realm.js:397`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/realm.js#L397): Synthetic builtin facade creation.
- [`lib/internal/modules/esm/utils.js:26`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/esm/utils.js#L26): Native import and import.meta callbacks.
- [`lib/internal/modules/esm/utils.js:304`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/esm/utils.js#L304): Callback registration.
- [`lib/internal/modules/esm/module_job.js:518`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/esm/module_job.js#L518): Synchronous ESM execution policy.
- [`src/module_wrap.cc:1612`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/module_wrap.cc#L1612): Native method inventory.
- [`src/module_wrap.cc:1673`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/module_wrap.cc#L1673): Source/defer phase constants.

**Limits:** No parser/module execution probes run. Full phase, synthetic module and sync/TLA parity has not been established by static inspection.

### E10: VM contexts, compilation and watchdog control

contextify must create real context/global proxy identity, native ContextifyScript, compileFunction contextExtensions/parsingContext, return cachedData acceptance truthfully, own microtask queues/modes, support interruption/timeouts/breakOnSigint/code-generation policy, and preserve dynamic import callbacks. Returning the main global or using JS eval does not implement VM isolation or native constructor behavior.

**Disposition:** Port contextify behavior to real SpiderMonkey realms/compartments plus native callback/watchdog ownership; reuse unchanged vm.js/internal/vm.js/internal/vm/module.js. Cache formats may be engine-specific but must be truthful and validated.

**Source:**
- [`lib/vm.js:38`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/vm.js#L38): Contextify binding import.
- [`lib/vm.js:100`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/vm.js#L100): Script compile options.
- [`lib/vm.js:238`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/vm.js#L238): Context creation options.
- [`lib/vm.js:321`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/vm.js#L321): CompileFunction API.
- [`lib/internal/vm.js:46`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/vm.js#L46): Native context identity key.
- [`lib/internal/vm/module.js:325`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/vm/module.js#L325): Native VM Module requests.

**Limits:** Specific limits such as V8 cachedData interchange require explicit per-API decisions. No claim of security isolation or timeout correctness is supported by this audit.

### E11: Backing stores, hidden clone brands and transfer

Native backing stores must remain real engine ArrayBuffers with correct detached/shared/resizable semantics, external allocation lifetime and detach keys. Buffer markAsUntransferable writes a hidden private marker and native detach protection. messaging uses hidden clone/transfer modes plus symbol callbacks, typed native objects and ownership transfer with atomic failure rollback. Guest object graphs cannot be replaced by outer-host objects.

**Disposition:** Keep unchanged Buffer/clone/Worker JS source and provide buffer/util/messaging/worker bindings plus engine clone ownership. Reuse existing private marker, retained backing, clone and host-sender pieces only against their final coherent contracts.

**Source:**
- [`lib/internal/buffer.js:1086`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/buffer.js#L1086): Real detach-key/private marker ownership.
- [`lib/internal/worker/js_transferable.js:14`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/worker/js_transferable.js#L14): Shared transfer method symbols.
- [`lib/internal/worker/js_transferable.js:91`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/worker/js_transferable.js#L91): Hidden clone/transfer admission.
- [`lib/internal/worker/io.js:34`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/worker/io.js#L34): Native messaging shared mode identity.
- [`src/node_messaging.cc:1296`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/src/node_messaging.cc#L1296): Native recognition of actual private marker.

**Limits:** No transfer, GC, cross-realm or Worker transport tests run. Existing native clone APIs and markers do not establish full structuredClone or wire compatibility.

### E12: V8 serialization wire format

Unchanged v8.js requires real Serializer/Deserializer constructors and prototype behavior; serialize/deserialize uses V8 wire headers/types plus Node custom host-object encodings. SpiderMonkey structured clone has different bytes and cannot be silently substituted. Partial benchmark/test transport therefore also depends on this even when no application explicitly imports node:v8.

**Disposition:** Implement the required serdes wire/API contract in a native backend or explicitly defer its dependent modules. Separate achievable stable serialization behavior from V8 heap/optimizer-only APIs below.

**Source:**
- [`lib/v8.js:45`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/v8.js#L45): Serializer/Deserializer native import.
- [`lib/v8.js:388`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/v8.js#L388): Native prototype integration.
- [`lib/v8.js:441`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/v8.js#L441): Node custom host-object serialization.
- [`lib/v8.js:513`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/v8.js#L513): Public serialize uses V8 serializer.
- [`lib/v8.js:526`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/v8.js#L526): Public deserialize uses V8 deserializer.

**Limits:** No codec compatibility evidence collected; exact supported wire versions, host objects, cycles, transfer flags and errors remain contract work.

### E13: Snapshots, V8 caches, heap/optimizer and inspector

startup_snapshot always imports mksnapshot binding and reads actual isBuildingSnapshotBuffer, even when snapshot creation is off. Heap space names, V8 optimizer flags, CPU/heap profiler protocols, cachedDataVersionTag and serialized V8 snapshots reflect a concrete engine and cannot be fabricated for SpiderMonkey. Inspector exposes real protocol session and debugger semantics; declaring hasInspector=false is truthful only if capability genuinely absent and remains a documented non-pass.

**Disposition:** Supply truthful snapshot-disabled state for an ordinary non-snapshot build while preserving upstream namespace/errors. Decompose node:v8 and inspector into API-specific implementable equivalents/protocols vs literal V8 artifacts that need user-reviewed exclusions or much larger backends. Never exempt all node:v8, because E06/E12 contain implementable behavior.

**Source:**
- [`lib/internal/process/pre_execution.js:40`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/process/pre_execution.js#L40): Early startup_snapshot import.
- [`lib/internal/v8/startup_snapshot.js:15`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/v8/startup_snapshot.js#L15): Always-required mksnapshot binding state.
- [`lib/v8.js:118`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/v8.js#L118): V8 cache/flags/profiler dependencies.
- [`lib/v8.js:277`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/v8.js#L277): Heap statistics public API.
- [`lib/internal/heap_utils.js:84`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/heap_utils.js#L84): Actual heap object traversal.
- [`lib/inspector.js:24`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/inspector.js#L24): Truthful inspector capability gate.
- [`lib/inspector.js:45`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/inspector.js#L45): Actual inspector session binding.

**Limits:** These are engine architecture differences, not claims of SpiderMonkey defects. Exact API exclusions are proposed decisions, not authorized omissions or conformance passes.

### E14: Nested WebAssembly required by unchanged shipped JS dependencies

configure.py includes bundled Undici/Amaro. Unchanged Undici HTTP/1 lazyllhttp throws without WebAssembly, compiles SIMD module with scalar fallback, and instantiates module/import callbacks synchronously. Amaro bundles Wasm bytes then creates Module/Instance synchronously. ESM translators also use WebAssembly.Module/Instance and source-phase module behavior. An outer host supports WebAssembly, but the guest JS global/API still needs its own correct execution boundary.

**Disposition:** Keep a genuine guest nested-Wasm backend in scope and reflect its dependencies explicitly. It can be last for an initial CJS/streams/fs slice, but complete unchanged fetch HTTP/1 and TypeScript cannot be marked done before it. Native llhttp work remains useful for Node internal http_parser and cannot silently replace Undici own Wasm engine calls.

**Source:**
- [`configure.py:61`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/configure.py#L61): Shipped JS dependency selection.
- [`lib/internal/bootstrap/web/exposed-window-or-worker.js:82`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/bootstrap/web/exposed-window-or-worker.js#L82): Lazy unchanged Undici fetch loading.
- [`deps/undici/undici.js:7275`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/deps/undici/undici.js#L7275): Honest WebAssembly absence error.
- [`deps/undici/undici.js:7294`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/deps/undici/undici.js#L7294): SIMD module creation.
- [`deps/undici/undici.js:7299`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/deps/undici/undici.js#L7299): Scalar fallback and instance creation.
- [`deps/amaro/dist/index.js:549`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/deps/amaro/dist/index.js#L549): Amaro actual Module/Instance creation.
- [`lib/internal/modules/esm/translators.js:560`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/esm/translators.js#L560): Guest WebAssembly module import owner.

**Limits:** Recipe selects --disable-jit at packages/registry/spidermonkey/build-spidermonkey.sh:524; that line alone does not prove the complete configured guest Wasm feature matrix. Parent retained evidence identifies missing nested execution. No new engine runtime query executed.

### E15: Native addon imports are a distinct ABI boundary

Unchanged CJS .node extension calls process.dlopen; ESM addon translation delegates to the same actual loader. Host native .node binaries and V8-linked addons cannot execute as Kandelo wasm guest code simply because JS modules are reused. N-API portability still needs a genuine supported guest side-module ABI, loader and object/lifetime implementation.

**Disposition:** Preserve upstream loader code, report real loader failures, and make native addon format/ABI support an explicit scoped roadmap/boundary. Do not infer an addon capability from implementing core internalBinding exports.

**Source:**
- [`lib/internal/modules/cjs/loader.js:2133`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/cjs/loader.js#L2133): Native extension loader.
- [`lib/internal/modules/cjs/loader.js:2135`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/cjs/loader.js#L2135): Actual dlopen contract.
- [`lib/internal/modules/esm/translators.js:656`](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib/internal/modules/esm/translators.js#L656): ESM addon loader path.

**Limits:** No native addon compatibility matrix or loader validation performed; this row prevents conflating C++ internal bindings with loading third-party native addons.

## Recommended implementation order

1. Complete native realm/bootstrap compiler and unchanged primordial execution (E01–E03).
2. Structured errors, job queue/rejections, callback scopes and raw Promise/continuation ownership (E04–E06); truthful snapshot-disabled state from E13.
3. CJS and side-effect-free inspection plus real backing/transfer ownership (E07–E08/E11).
4. One ModuleWrap graph and synthetic builtin facade, then real VM contexts (E09–E10).
5. Stable serialization + test/bench dependent transport (E12), guest Wasm dependency slice (E14), and explicitly decomposed inspector/V8/native addon contract work (E13/E15).

These are proposed dependencies, not implementation authorization or evidence that a stage currently works. Startup-reachable here means statically visible upstream imports/calls, not an observed runtime trace.

## Open questions

- Exact configured SpiderMonkey standard globals and ModuleWrap phase/sync behavior need later authorized runtime evidence.
- Decide API-specific treatment of literal V8 heap spaces/optimizer flags/snapshots/cache interoperability and unsupported inspector protocol features.
- Determine required Serializer/Deserializer wire versions and native addon ABI scope explicitly.
- Map all internalBinding exports to current final native owners before selectively moving backend commits; this report is not that full mapping.

## Evidence limits

This is a bounded engine architecture audit, not the full public API matrix or exhaustive transitive binding inventory. Exact file hashes are attached to each JSON anchor. Existing campaign native pieces are reuse candidates only; their final source/artifact identity, failed/skipped/unsupported/timeouts and unrun four-host validation remain intact. No source-level presence is counted as implementation completeness or runtime compatibility. No runtime, test, build, package-generation, tracked-source or Git/PR mutation was performed.
