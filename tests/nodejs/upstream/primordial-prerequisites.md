# Upstream primordial engine prerequisites

Bounded read-only audit of pinned Node 26.13.0 (`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`), retained Mozilla 140.11.0 source and main recipe at `6d5ebb19b24572480edebd5dc355dfca36ae63c6`. No runtime tests, probes, builds, generation or tracked changes. The retained Mozilla source is already patched; per-file hashes in JSON identify exact inspection inputs. It is not described as a pristine archive or a compiled artifact.

## Findings

| Required feature | Source implementation/config evidence | Remaining owning work |
|---|---|---|
| Float16Array | Native constructor/typed-array implementation present; no constructor runtime gate found. | Do not create a replacement Float16Array global. Use the real engine constructor; later authorize focused unchanged primordial startup and exact Float16Array behavior checks. |
| Iterator / Iterator.prototype.drop / Iterator.from | Native constructor and self-hosted implementations present; required methods unconditional. | Use existing engine implementations unchanged; do not add JS shims or remove Node prototype-discovery calls. Focus later validation on actual primordial invocation and descriptors/real helper prototypes. |
| Symbol.dispose / Symbol.asyncDispose | Genuine well-known engine symbols present behind explicit-resource compile macro; main recipe enables it. | Retain the native compile option and existing startup pref policy. Do not replace symbols with Symbol.for or ordinary Symbol values. Later verify unchanged consumers use the same native identities. |
| Error.captureStackTrace | Real native implementation exists and archive runtime pref defaults true; Node-equivalent stack contract remains partial. | Reuse actual engine capture/frame machinery; implement Node structured/lazy formatting and limit/descriptor behavior in the owning engine+errors binding. No new library wrapper or fake global is needed. |
| Error.prepareStackTrace / structured CallSite formatting | Node-required hook contract not found in inspected production SpiderMonkey source. | Earliest substantive owning-engine work: real saved-frame retention, lazy formatter invocation with realm selection/reentrancy, CallSite objects/descriptors and upstream errors callback binding. Keep upstream JS unchanged. |
| Error.stackTraceLimit | Required Node behavior absent from inspected engine path; fixed depth is not equivalent. | Implement per-realm Error limit/descriptors and enforcement in native error capture/constructor paths, shared with P05. Do not bypass upstream isErrorStackTraceLimitWritable or manufacture frame truncation success in a public JS adapter. |

## Earliest work decision

Float16Array, Iterator.from/drop and disposal symbols already have real native/self-hosted implementations. The main recipe supplies the resource-management compile option and patch0017 enables its runtime pref. Do not begin by writing globals or library shims for these.

Error.captureStackTrace also already exists, and the archive preference defaults it on. The engine work is to supply the structured/lazy Node stack contract, CallSites, per-realm prepareStackTrace integration and stackTraceLimit behavior using actual SavedFrame/capture primitives. A simple capability-name check or eager string formatter does not establish Node compatibility. This refines earlier campaign statements about captureStackTrace being absent; no running artifact was queried.

## Evidence by feature

### P01: Float16Array

**Node requirement:** Node eagerly copies Float16Array constructor and prototype properties in primordials, before any user module.

**Actual engine evidence:** ProtoKey.h registers REAL(Float16Array, TYPED_ARRAY_CLASP(Float16)); GlobalObject::skipDeselectedConstructor includes it in the unconditional false group. TypedArrayObject-inl.h maps real float16 storage to JSProto_Float16Array; shared TypedArrayObject templates instantiate real class/spec/constructors. This is not a mere alias/export.

**Configuration/runtime limits:** The configured main recipe disables JIT but that does not remove these native/interpreter typed-array registrations. No generated config or built artifact was examined and no primordial startup was executed. Numeric/descriptor/Buffer interoperability is not runtime-proven.

**Next owning work:** Do not create a replacement Float16Array global. Use the real engine constructor; later authorize focused unchanged primordial startup and exact Float16Array behavior checks.

**Anchors:**
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/per_context/primordials.js:199` — Eager Float16Array capture.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/per_context/primordials.js:226` — Descriptor/prototype copy without optional guard.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/public/ProtoKey.h:104` — Unconditional real typed-array class registration.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/GlobalObject.cpp:151` — No runtime constructor deselection.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/GlobalObject.cpp:174` — Constructor group returns false.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/TypedArrayObject-inl.h:155` — Real float16 storage/type binding.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/TypedArrayObject.cpp:4693` — All typed-array class specs instantiated.

### P02: Iterator / Iterator.prototype.drop / Iterator.from

**Node requirement:** Node eagerly captures Iterator methods, calls uncurried Iterator.prototype.drop on an ordinary object with null limit to obtain IteratorHelperPrototype, and calls Iterator.from on an ordinary object to obtain WrapForValidIteratorPrototype.

**Actual engine evidence:** REAL(Iterator) constructor is not deselected. Iteration.cpp registers static from and prototype drop outside NIGHTLY_BUILD conditionals, attaches those arrays in IteratorObjectClassSpec, and contains actual native helper/wrapper classes. IteratorDrop validates object/limit, creates an engine IteratorHelper with a generator and stops at initial yield; IteratorFrom gets a direct iterator and builds the engine wrapper. An old comment about Iterator Helpers being enabled is not evidence of a remaining runtime gate.

**Configuration/runtime limits:** Nightly gates apply to unrelated concat/range/zip additions; async iterator helper flags are separate. This source evidence does not execute either exact primordial call or prove every iterator helper edge. No new test run.

**Next owning work:** Use existing engine implementations unchanged; do not add JS shims or remove Node prototype-discovery calls. Focus later validation on actual primordial invocation and descriptors/real helper prototypes.

**Anchors:**
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/per_context/primordials.js:206` — Eager Iterator capture.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/per_context/primordials.js:284` — drop helper prototype discovery.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/per_context/primordials.js:304` — Iterator.from wrapper prototype discovery.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/public/ProtoKey.h:146` — Real Iterator global constructor.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/GlobalObject.cpp:132` — Iterator constructor unconditional group.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/Iteration.cpp:1945` — from registration outside Nightly block.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/Iteration.cpp:1962` — drop registration.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/Iteration.cpp:2199` — ClassSpec consumes method tables.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/builtin/Iterator.js:119` — Real IteratorFrom implementation.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/builtin/Iterator.js:566` — Real IteratorDrop implementation.

### P03: Symbol.dispose / Symbol.asyncDispose

**Node requirement:** Node generic Symbol property copying derives primordial SymbolDispose/SymbolAsyncDispose aliases from actual Symbol properties. These are not direct pure-primordials assertions, but unchanged consumers such as stream constructors attach methods with SymbolAsyncDispose; absent symbols would produce incorrect public methods.

**Actual engine evidence:** js/public/Symbol.h includes both well-known codes under IF_EXPLICIT_RESOURCE_MANAGEMENT. TypeDecls.h implements that macro using ENABLE_EXPLICIT_RESOURCE_MANAGEMENT. SymbolClassFinish installs every engine well-known symbol as readonly/permanent Symbol constructor property. Runtime explicit-resource pref controls parser/DisposableStack selection; this symbol installation loop itself has no runtime-pref gate.

**Configuration/runtime limits:** js/moz.configure defaults the compile option to Nightly, but origin/main recipe explicitly supplies --enable-explicit-resource-management. ESR archive defaults the runtime pref false; existing main patch0017 sets it true, with explicit shell --disable override. No actual generated macro/header or shell invocation/artifact was inspected. The cached shell source contains that main patch.

**Next owning work:** Retain the native compile option and existing startup pref policy. Do not replace symbols with Symbol.for or ordinary Symbol values. Later verify unchanged consumers use the same native identities.

**Anchors:**
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/per_context/primordials.js:215` — Symbol copied as a real intrinsic.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/streams/readable.js:398` — Actual public async-disposal symbol consumer.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/public/Symbol.h:66` — Well-known disposal symbol macro.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/public/TypeDecls.h:135` — Compile macro expansion.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/builtin/Symbol.cpp:61` — Native installation of all well-known symbol identities.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/moz.configure:139` — Compile feature option/default.
- `main: packages/registry/spidermonkey/build-spidermonkey.sh:297` — Main explicitly enables compile feature.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/shell/js.cpp:17737` — Patched native shell enables runtime resource pref.

### P04: Error.captureStackTrace

**Node requirement:** Node captures the actual Error static method into ErrorCaptureStackTrace and uses it for aggregate/hidden constructor boundaries. Exposing a callable method and implementing structured Node stack behavior are separate requirements.

**Actual engine evidence:** ErrorObject.cpp registers exn_captureStackTrace; JSObject.cpp omits it only if experimental_error_capture_stack_trace is false. Archive StaticPrefList.yaml defaults that pref true. The implementation unwraps the optional callable boundary, captures real SavedFrames, builds a string immediately with fixed MAX_REPORTED_STACK_DEPTH, and defines a writable/configurable nonenumerable stack data property. Its own comment explicitly follows JSC data-property behavior rather than V8 accessor behavior.

**Configuration/runtime limits:** This corrects a blanket statement that the pinned engine lacks captureStackTrace. Runtime flags or embedding may override the pref; no actual running artifact was checked. The absence guards in old Node generation source are not proof of current engine absence.

**Next owning work:** Reuse actual engine capture/frame machinery; implement Node structured/lazy formatting and limit/descriptor behavior in the owning engine+errors binding. No new library wrapper or fake global is needed.

**Anchors:**
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/per_context/primordials.js:230` — Static Error properties captured generically.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/errors.js:26` — ErrorCaptureStackTrace dependency.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/errors.js:189` — Required real constructor boundary capture.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/ErrorObject.cpp:106` — Native static method registration.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/JSObject.cpp:2248` — Runtime preference gate.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/ErrorObject.cpp:1104` — Actual callable boundary unwrap.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/ErrorObject.cpp:1114` — Actual fixed-depth frame capture.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/ErrorObject.cpp:1130` — Explicit eager data-property behavior.

### P05: Error.prepareStackTrace / structured CallSite formatting

**Node requirement:** Unchanged realm.js unconditionally installs a per-realm setPrepareStackTraceCallback through errors binding and defines Error.prepareStackTrace. internal/errors.js callback expects actual structured CallSite objects and correct originating realm/global. Merely defining a JS function property does not cause the engine to invoke it.

**Actual engine evidence:** Production js/src and js/public text searches found no prepareStackTrace or stackTraceLimit references. ErrorObject::getStack builds a stack string from SavedFrames directly. SpiderMonkey SetStackFormat supports V8-like string layout only; it is not a structured formatter callback. SavedFrame source/line/column/function/async-parent APIs are real primitives available for an implementation, not an existing complete CallSite API.

**Configuration/runtime limits:** Negative source search is bounded to the inspected retained tree; no built-artifact behavior was queried. Tree includes Kandelo patches, source identity is recorded per file. This is a documented engine/embedding behavior difference, not an upstream defect allegation.

**Next owning work:** Earliest substantive owning-engine work: real saved-frame retention, lazy formatter invocation with realm selection/reentrancy, CallSite objects/descriptors and upstream errors callback binding. Keep upstream JS unchanged.

**Anchors:**
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/bootstrap/realm.js:485` — Mandatory per-realm prepare callback setup.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/bootstrap/realm.js:504` — Public Error.prepareStackTrace property installation.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/errors.js:123` — Structured CallSite and realm requirements.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/ErrorObject.cpp:833` — Error getStack builds direct engine string.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/public/Stack.h:54` — V8 string-format option alone.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/SavedStacks.cpp:777` — Actual saved-frame source access.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/SavedStacks.cpp:919` — Actual saved-frame async parent access.

### P06: Error.stackTraceLimit

**Node requirement:** Node temporarily sets stackTraceLimit=0 around error construction, restores it, tests descriptors, and gates/calls captureStackTrace. Correct limits affect captured/retained frames and later formatted output, not just a JS property value.

**Actual engine evidence:** No production stackTraceLimit source reference found. Native captureStackTrace directly requests JS::MaxFrames(MAX_REPORTED_STACK_DEPTH); normal Error getStack consumes engine SavedFrames and formats directly. Installing a number property would not make those engine paths honor it.

**Configuration/runtime limits:** No runtime probe run. Do not claim all general engine stack capture must be rewritten: actual engine SavedFrame capture and boundary censoring are useful. Exact constructor/accessor and arbitrary error-object semantics still need design.

**Next owning work:** Implement per-realm Error limit/descriptors and enforcement in native error capture/constructor paths, shared with P05. Do not bypass upstream isErrorStackTraceLimitWritable or manufacture frame truncation success in a public JS adapter.

**Anchors:**
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/errors.js:181` — Node zero-limit construction behavior.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/errors.js:248` — Snapshot/descriptor-sensitive writable check.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/errors.js:416` — Zero-limit errors construction and restore.
- `node: .context/nodejs-lts-cache-v2/node-v26.13.0/lib/internal/errors.js:546` — Actual capture gate.
- `engine: .context/node26-mozilla-style-source/tree/firefox-140.11.0/js/src/vm/ErrorObject.cpp:1116` — Current fixed max depth capture.

## Archive preference evidence

The source tree omits the libpref YAML, so its values were read directly into memory from `source.tar.xz`, member `firefox-140.11.0/modules/libpref/init/StaticPrefList.yaml`:

- Line 8808: explicit_resource_management; line 8810: false; guarded by ENABLE_EXPLICIT_RESOURCE_MANAGEMENT. Main recipe and existing patch0017 deliberately enable it.
- Line 8815: error_capture_stack_trace; line 8817: true; non-startup pref with mirror always. Existing shell options/embedder code can still change actual state.

The archive checksum was not recomputed in this task. Main package metadata supplies expected source SHA256 `1b034d2117356fda24807a151055132315c6ba58ad2bdf7ec71ee707fac5e028`. No new source files were extracted.

## Declaration coverage versus runtime evidence

Node eagerly lists 39 constructors in this section. Their ProtoKey name mentions are recorded individually in JSON; this is declaration coverage only. It does not audit numeric behavior, constructors, inherited symbols/descriptors or other ECMA semantics for all those names. The bounded deeper checks here cover the specifically delegated prerequisites.

No generated PrefsGenerated.h/config result, node.wasm/js.wasm executable, runtime flags, unchanged primordial execution or four-host conformance was observed. Source presence, a configured feature switch and true default preferences remain distinct from runtime proof. No SpiderMonkey defect allegation or runtime workaround is made.

## Unresolved

- Actual generated config/compiled artifact and shell option state have not been inspected.
- No unchanged primordial execution or multi-realm initialization tested.
- General ECMA constructor descriptor/semantics for other eagerly captured names are not audited merely from ProtoKey declarations.
- Full Node CallSite fields, async frame/function identity and cross-realm formatting need a design before implementation.
