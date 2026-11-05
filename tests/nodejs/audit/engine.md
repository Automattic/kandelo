# VM, V8 and inspector source audit

State: **source review complete with implementation gaps**, together with
the [full public/gated/returned-owner review](engine-contracts.md), exact
requirements and future unchanged-source catalog. The guest is
SpiderMonkey on every embedding host.
This audit distinguishes actual engine features, missing public bridges
and proposed engine/format boundaries. No build or runtime probe was run.

## Existing native implementation

Bootstrap:5938–5990 exposes selected vm methods over native bindings.
The frozen post-53 engine `js/src/shell/js.cpp`:2590–3007 contains a
real global/realm context class, property hooks, code-generation flags,
realm-independent compiled Stencil handles, script instantiation/execution
and cross-realm result/exception wrapping. This is more than a stub, but
it is not Node contextification semantics in full.

Public v8 exports at bootstrap:5927–5936 only provide a fixed heap limit
and an empty heap-space array. inspector and inspector/promises are
absent from the final public registry. Host browser DevTools do not
automatically implement sessions over guest SpiderMonkey JavaScript.

## Concrete findings

| ID | Requirement | Source observation | Owning prerequisites |
|---|---|---|---|
| E-003 | createContext identity/idempotence and isContext | Candidate always allocates/returns a separate global wrapper and only recognizes that wrapper. Pinned ordinary contextification returns the supplied sandbox; createContext reuses an already-contextified object | Native context association/identity, constructor/brand validation |
| E-004 | Live contextified sandbox properties/descriptors | Native resolve reads a sandbox value and defines a data property on the global; addProperty mirrors only creation. There is no complete get/set/descriptor forwarding or post-evaluation sync. Later writes can diverge between sandbox and global | Actual contextified exotic object/property semantics, cross-realm descriptors and accessors |
| E-005 | VM option and argument validation | JS wrapper coerces/defaults inputs and offsets, forwards only a small subset; native compile uses filename/lineOffset but not columnOffset/displayErrors. Names/origins, microtaskMode and dynamic import options absent/ignored | Exact validators, script metadata, per-context microtask/import integration |
| E-006 | Shared memory in VM contexts | Native realm creation hard-codes shared memory/Atomics disabled regardless of public options. This is a candidate realm policy, not proof of an unavoidable all-host engine limit | Realm capability policy and shared-memory ownership |
| E-007 | compileFunction | Builds/evaluates a function-expression string instead of implementing full native function compilation, parameter/context-extension, cache/import and validation semantics | Proper compile-function API, parsing context, metadata and loader ownership |
| E-008 | Script cache/metadata and VM module APIs | cachedDataRejected/createCachedData/sourceMapURL, Module/SourceTextModule/SyntheticModule, constants and measureMemory are not implemented | Native module lifecycle/link/evaluation, cache format, source metadata and actual memory measurement |
| E-009 | Execution deadlines and interrupt policy | Public timeout rejects rather than enforcing a deadline. Native shell CancelExecution already requests JS interrupts, so the blanket comment that interrupts are unavailable is not a capability proof | Owned deadline/interrupt/cleanup and breakOnSigint/microtask policy |
| E-010 | Heap statistics | Fixed heap_size_limit lacks actual engine/guest accounting and remaining fields; empty spaces do not establish a conformant V8 heap-space model | Per-field real measurements and explicit V8-specific applicability |
| E-011 | Other public v8 APIs | Serialization, promise hooks, startup snapshots, profilers, coverage/flags and other exports absent | Real engine/backend integration; separate portable behavior from engine-specific formats |
| E-012 | Inspector/debugger APIs | Session/protocol, notification/posting, connect/open/URL/wait/close, worker/main-thread behavior and public instrumentation absent | Actual debugger/profiler, protocol backend, transport, event/error/ownership lifecycle |

E-001/E-002 in the family survey identify the initial heap/deadline gaps.
The target exposes VM Module/SourceTextModule/SyntheticModule during
pre-execution under `--experimental-vm-modules`, as stated at the end of
pinned lib/vm.js. Their absence in a default native capture is therefore
not the finding: the candidate lacks their enabled implementations and
activation path as well.
E-003 compares native js.cpp:2739–2823 with pinned
`lib/vm.js`:226–268 and `src/node_contextify.cc`:413–467. The pinned
native return branch returns sandbox for ordinary input and a global
only for the explicitly uncontextified mode.

For E-004, the source predicts divergence after a sandbox property is
resolved into the candidate global and then updated: the existing global
data-property assignment does not invoke an addProperty hook. The return
path at 2987–3007 wraps results/exceptions, not sandbox state. This is a
source finding, not a newly executed example.

## Concrete engine capability evidence

The recipe explicitly selects `--disable-jit` at
`packages/registry/spidermonkey/build-spidermonkey.sh`:287.
[The engine-source evidence](engine-source-evidence.json) records inspected
members/hashes/excerpts from the existing pinned SpiderMonkey archive,
without extracting a new product tree, compiling or executing it.
WasmFeatures.cpp's HasPlatformSupport rejects the lack of a JIT backend;
WasmSignalHandlers.cpp rejects full signal handlers for JS_CODEGEN_NONE.

This supports a concrete source-level restriction for nested guest
JavaScript WebAssembly compilation in the current no-JIT engine recipe.
The outer Node/Chromium/Firefox/WebKit host executing Kandelo's Wasm
kernel is a different boundary. It does not give the guest JS engine a
working nested compiler. Current compiled feature metadata/runtime
behavior is still unverified; this is not a new four-host runtime result.

The pinned TypeScript documentation states that Node's built-in parser
requires WebAssembly and has a documented unavailable-WebAssembly error.
Its dependency and the guest engine restriction must be reconciled in
the loading/web/native-integration audits. This is not a blanket excuse
for every missing TypeScript, VM or WASI API.

Conversely, actual shell interrupt support exists at native js.cpp:8823.
Missing VM deadline or per-worker termination wiring is an implementation
gap, not established engine impossibility. Neither debug-build settings
nor the absence of a public inspector entry is by itself proof that no
debugger primitive can be embedded.

## Format and measurement boundary decisions remain open

V8 cached data, heap/snapshot/profiler representations and flags require
API-specific review against the target docs/source. The existing private
same-process SpiderMonkey structured-clone representation must not be
renamed v8.serialize and presented as Node's persistent serialization.
Likewise a SpiderMonkey Stencil is not automatically a compatible V8
cached-data buffer or startup snapshot.

Where a contract is fundamentally tied to a particular engine format or
state, document that precise boundary and the requested interoperability.
Where the API describes portable behavior, keep missing implementation
as a gap. No entire v8/vm/inspector family is excluded by this review.

## Source review and remaining runtime evidence

The full contract review reconciles methods/overloads/properties/symbols, ordinary versus
DONT_CONTEXTIFY identity, descriptors/global builtins, cross-context
objects, codeGeneration behavior, async module/link/evaluate/status,
dynamic imports and microtask/timeout interactions. Exact native edge
controls, per-field/format boundaries and unresolved source questions
remain recorded; no runtime conformance or blanket exclusion follows.

Later unchanged cases include parallel `test-vm-context.js`,
`test-vm-context-property-forwarding.js`,
`test-vm-context-dont-contextify.js`, the es-module context/leak cases,
the inspector category and relevant serialization/snapshot fixtures.
Native comparisons must examine identities and mutations, exact errors,
deadline interruption/cleanup, realm isolation and feature metadata, real
measurement values, cache interoperability and protocol event lifetime.
No such new execution is authorized during this audit.
