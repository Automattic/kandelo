# Upstream Node.js runtime restart

## Current state

The normal guest runtime still uses its existing compatibility bootstrap.
Through privileged JS-shell controls, the selected SpiderMonkey package now
executes the complete, unchanged upstream primordials, DOMException,
messageport and realm library loader on the Node host. A canonical native
context owns the original symbol inventory and protected primordials; the
realm owner retains the actual original loader closures. Original JavaScript
owns builtin caching, exposure policy and moduleLoadList. The eager native
realm closure uses the real ModuleWrap/Error owners and shared private symbols.

The native principal-body entry calls complete `internal/bootstrap/node` with
protected state. It now executes the original internal tracing helper and
reaches the missing `mksnapshot` binding through original `buffer.js`. The original native tracing agent, binding,
V8 tracing intrinsics and UTF-16 encoder are linked into the engine over real
Kandelo and SpiderMonkey primitives. Focused controls exercise these on all
four hosts. Continuation-preserved engine data and the complete original
async-context native source are also integrated; active JavaScript consumers
remain guarded until genuine bootstrap completes. Full observer exception/fatal
routing remains incomplete.
Engine ArrayBuffers now retain native detach keys and enforce them during
transfer and serialization. The complete original native Buffer binding is now compiled over real engine
allocation, retained storage, views, encodings and principal prototypes.
Its original CallbackInfo cleanup runs on all four hosts. Thirty shared
native control groups match exactly; a standalone native Node reentry
discrepancy is retained separately. Full lifecycle/exceptional coverage remains
incomplete. Original AliasedBuffer headers now compile over real typed/weak
engine handles with focused four-host controls; mksnapshot source review
does not establish the missing binding. Earlier
revision sections below describe their evidence at the time.
Complete Node startup, empty/simple evaluation,
user CJS/ESM entrypaths and browser startup remain unrun. The native process
and util/builtins bindings remain partial; no complete module compatibility or
443-source guest payload readback is established. ModuleWrap-owned dynamic
imports and genuine source/synthetic graphs have focused Node-host controls.
Owned Error stacks use real saved frames, with partial structured CallSites.

The target remains Node.js 26.13.0, Lithium LTS, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. Verification on November 10,
2026 found no target drift: the official release index, release tag and
source/native archive checksums agree. The retained source tree's 38,413
regular files match the verified archive. The Darwin arm64 reference
executable matches SHA-256
`533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4`.
Pin verification did not execute it; subsequent native controls are described
below. Other native reference contents were not
inspected. Evidence is in `tests/nodejs/upstream/pin-verification.json`.

Official references:

- https://nodejs.org/dist/index.json
- https://nodejs.org/dist/v26.13.0/SHASUMS256.txt
- https://github.com/nodejs/node/tree/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b

## Architecture contract

Run complete, unchanged upstream public modules and their internal and
vendored JavaScript dependencies. Use upstream primordials, realm/builtin
loaders and bootstrap. Implement their embedding, compiler, engine and
native-binding contracts over SpiderMonkey and the Kandelo guest OS.
One environment owns builtin identity, caching, cycles and CJS/ESM exposure.
Host Node builtins are not substitutes for guest operations.

Do not extract functions, rewrite upstream algorithms, replace public
modules or supply separate private dependency environments per family.
A concrete obstacle to unchanged execution needs an explicit decision.
Missing dependencies remain visible as missing work.

Imported source and runtime configuration are different. Optional sources
can be stored while their backend is unavailable; runtime feature metadata
must describe the implementation actually present. Native-reference
configuration and V8 identity must not be copied to manufacture support.

## Source inventory

The initial `third_party/nodejs/sources.json` import recorded 494 unchanged archive files:
427 library JavaScript files, 16 dependency JavaScript files, one library
support file, 37 dependency license files and thirteen provenance files. Its
443 builtin source records cover more than the public module list. The current
manifest has 557 files after complete native source/header additions; every
original JavaScript record and all 10,993,403 JavaScript bytes remain unchanged.
The original `src/env_properties.h` now supplies the native symbol inventory;
its bytes are verified before staging into Mozilla's source tree. The complete
original `src/node_exit_code.h` similarly supplies the native errors enum;
adding it left every prior source record and all JavaScript bytes unchanged.

`scripts/index-nodejs-bindings.mjs` traverses every builtin source using the
repository-declared Babel parser. The initial index has 443 parsed files,
zero parse errors, 3,342 loader/binding references, 72 literal native
binding names and 14 computed references. These are syntax counts, not
API counts or completed contract audits. The index retains computed
references and explicitly records that alias analysis, signatures,
implicit engine contracts, lifecycle and reachability remain unreviewed.
See `tests/nodejs/upstream/binding-index.json`.

Recreate the static index through the development shell:

```sh
scripts/dev-shell.sh node scripts/index-nodejs-bindings.mjs \
  third_party/nodejs/sources.json /path/to/binding-index.json
```

The source-level startup order and wrapper contracts are recorded in
`tests/nodejs/upstream/bootstrap-contracts.md` and its companion JSON.
The review covers 13 ordered stages and direct startup binding consumers;
transitive binding members remain unaudited.

## Startup milestone

Provide the actual native embedding needed to execute unchanged upstream
per-context setup, realm loader, Node bootstrap, pre-execution and selected
main scripts. The first evidence must cover an empty evaluation and a
simple script, real output/error handling, asynchronous job draining and
correct exit status. Track CommonJS and ES-module entrypaths separately
across Node, Chromium, Firefox and WebKit hosts.

Startup does not establish module compatibility. A selected SpiderMonkey
artifact has been built and run for private-key and original per-context
initializer controls; it does not execute the imported Node bootstrap. Full product and
successor-ABI artifact rebuilds remain deferred. Immutable ABI 55 history
and the separate Bun standalone extraction/launch work remain preserved.

## Backend catalog and review gate

Begin the catalog with startup work, then reconcile it across all imported
modules, including lazy, conditional, worker, platform and exceptional
paths. For each requirement record:

- The exact upstream consumers, binding exports, classes, methods, symbols
  and shared state.
- Signatures, errors, callback scheduling and async-context requirements.
- Ownership, GC, resource lifecycle, cancellation and ref/unref behavior.
- Owning engine, host, libc or kernel layer and prerequisite dependencies.
- Archived native reuse candidates, implementation status and validation
  obligations on each of the four hosts.

The reconciled source graph now retains all 443 source identities and 3,342 original
references, 37 lazy registrations, 18 transfer metadata sites and separate CJS/ESM
loader roots. An authenticated archive scan records 160 native registration sites
across 460 source/header files. Every one of the 72 literal binding names has initializer syntax;
17 have current Kandelo dispatcher routes and 55 do not. Route presence is not full
binding support. The survey links all 19 historical family reviews and 33 PR reuse
records. See [the source graph and native survey](../tests/nodejs/upstream/backend-graph.md)
for scope, reproduction, symbolic domains and remaining native API obligations.

The syntax index is the start of this catalog, not its completion. Use the
prior 19-family audit and PR reuse audit as historical evidence and native
salvage indexes. Do not import the old assembled public frontend wholesale.

Undici's HTTP parser and Amaro's compiler execute embedded WebAssembly.
Nested guest Wasm remains required for those paths; defer its implementation
unless startup depends on it. Its absence is an implementation gap.

Deliver the startup evidence, complete contract catalog and ordered
implementation/validation roadmap for user review before broader backend
implementation. Overall conformance suites wait for a later authorized
milestone. Preserve all failures, skips, unsupported cases, timeouts and
harness errors as distinct non-passing outcomes.

Detailed source-registration and engine-contract reviews are preserved in
`tests/nodejs/upstream/source-registration.md` and
`tests/nodejs/upstream/engine-contracts.md`, with companion JSON. The import
preserves original Undici bytes rather than applying upstream js2c's narrow
Unicode punctuation normalization; that distinction is recorded explicitly.

## Native compiler foundation checkpoint

The normal upstream Node entrypath is still inactive. An immutable native source registry and
build-time wrapper metadata producer now exist, along with a SpiderMonkey
function/module compilation consumer. The registry and metadata were compiled
and checked on the development host. The SpiderMonkey consumer and registry
have since compiled as real wasm32 objects against configured engine headers
and participated in a selected package build. The function compiler now runs
the three original per-context bodies on the Node host. The source-text module
compiler and upstream bootstrap remain unexercised. Guest readback of the full
builtin payload remains unverified. See `engine-object-compilation.json`
for the earlier object check and `private-key-engine-check.json` for the
separate package and private-key control evidence.

The metadata producer compiles the original Node `builtin_info.cc/.h` rather
than duplicating its classification and parameter map. The guest compiler
consumes immutable diagnostic origins, kinds and argument arrays, avoiding
additional unchecked C++ string/map allocations in its entrypath. Separate
engine function/module APIs preserve the required wrapper distinction; source
line origins and ownership remain source-reviewed, not runtime-proven.

The host-native composition control read all 443 records and 10,993,403 bytes
through the actual compiled registry and compared them with the verified source
files, independent registration inventory and original parameter contracts.
Missing IDs, bounds and embedded-NUL lookup controls passed. Exact input/tool
identities and limits are in `source-registry-composition.json`. Generator
integrity checks use explicit metadata-protocol fixtures; these are separate
from the original-C++ composition evidence and do not establish guest behavior.

Reproduce the focused source checks through the development shell:

```sh
scripts/dev-shell.sh python3 -B   tests/nodejs/upstream/source-registry-generator.test.py
scripts/dev-shell.sh python3 tests/nodejs/upstream/check-source-registry.py   --work-dir /path/to/new-private-evidence-directory
```

A bounded source review found real Float16Array, Iterator.from/drop, disposal
symbols and Error.captureStackTrace implementations in the pinned engine.
They must not be replaced with fake globals or preclassified as absent. The
concrete Error gap is its eager fixed-depth string behavior versus Node's
structured, lazy formatting, CallSites and stackTraceLimit. See
`primordial-prerequisites.md`; engine configuration and behavior still need
identified-artifact evidence.

`implementation-ledger.json` separates source inventory, implementation and
per-host startup/conformance. Next integrate genuine per-realm state and
binding ownership, then the eager startup closure. The full backend catalog
is incomplete. No full product or successor-ABI build ran.

## Real engine build wiring and hidden-key prerequisite

The source recipe now includes both native compiler/registry translation units
in Mozilla's non-unified shell source list, declares their source/host-tool
inputs and prepares their generated include in the recipe-owned source/object
roots. Initial wiring used package revision 16; revision 17 fixed the actual
compiler-header integration and added the focused object check below. Revision
18 adds the distinct embedding-private engine kind and privileged controls,
and fixes the include paths/generated header layout required by Mozilla's
normal package checks. This does not
activate upstream Node or turn an older engine artifact into evidence for the
new code. Revision 19 adds the native runtime/context owner and executes the
three complete original initializers through diagnostic controls. The selected
package builds; later realm-library integration is described below, while principal Node bootstrap remains unfinished.

The focused preparation check ran the actual recipe helper, built the host-only
original-Node metadata producer using the declared SDK, verified all four staged
C++/header copies and generated the 443-source include. Shell/TOML/Python syntax
checks passed. The new Mozilla patch applied without fuzz against the exact
verified source archive's moz.build; no earlier main patch modifies that file.
Exact identities and scope are in `engine-build-wiring-check.json`.

The actual-header check now runs in the Port Vila clean-branch checkout with
normal wasm32 SDK-core provisioning and Mozilla configure/pre-export/export
generation. Both selected native objects compiled with zero compiler warnings.
The first attempts exposed missing header installation in the check and
unannotated JSAPI forward declarations in the compiler; both were corrected.
The parameter-count conversion now uses a checked round trip without the
wasm32 always-false comparison warning. Exact inputs, configuration, headers,
objects and failed-attempt history are in `engine-object-compilation.json`.
This is object-only evidence, not link or execution evidence. Full product
and successor-ABI campaign rebuilds remain deferred. The existing recipe's
Linux target triplet/defines remain targeting debt and do not establish
finished Kandelo runtime metadata or conformance.

Source investigation also found that V8's internal private keys and
SpiderMonkey's class-private names differ in observable operations: own-only
inheritance, new writes on nonextensible objects, missing proxy reads, private
proxy deletion and default enumerability. Existing clone-marker code does not
establish the required behavior. First ordinary proxy writes reject in both
engines; native initialization is a distinct operation and must not be weakened.
The recommended owning design is a distinct embedding-private engine identity
and operation contract that leaves ordinary Symbols and class #private
semantics intact. This is an implementation prerequisite, not an approved
engine-boundary exclusion or permission to rewrite upstream JavaScript.

See `private-key-semantics.md` and `per-context-state-contracts.md`. The native
owner must share 22 private and 27 ordinary symbol identities per guest runtime,
create fresh per-context table objects with exact descriptors, preserve the
original three-script initialization order, and keep failure terminal. A
GC-traced canonical state per global is required; a publicly reflected Symbol
or self-rooting native cycle is insufficient. None of this initializer or
hidden-key behavior was runtime-validated by that source review. The initializer
now has the focused guest evidence below. Neither those controls nor the
distinct key controls establish the complete Node engine contract.

A subsequent focused native control confirmed eleven covered hidden-key
expectations against the exact pinned Node.js 26.13.0 Darwin arm64 binary,
including both public untransferable-marker cases. Its flags/hash/outcomes and
coverage limits are in `private-key-native-reference.json`; the unchanged
control source is `private-key-native-controls.cjs`. These are reference
results only. That reference run exercised no guest engine, browser host or
current-candidate startup. The later guest controls below remain separate
evidence and do not establish complete Node-equivalent private-key behavior.

## Focused compiler object check

The SpiderMonkey recipe accepts `--check-upstream-compiler` for a standalone
development check. Supply an existing, absolute private work directory and
leave `WASM_POSIX_DEP_OUT_DIR` unset. Run through the development shell after
provisioning the wasm32 SDK core:

```sh
scripts/dev-shell.sh bash scripts/build-musl.sh --ensure --core-only
mkdir -p .scratch
compiler_work=$(mktemp -d "$PWD/.scratch/node-upstream-objects.XXXXXX")
scripts/dev-shell.sh env WASM_POSIX_DEP_WORK_DIR="$compiler_work" \
  bash packages/registry/spidermonkey/build-spidermonkey.sh \
  --check-upstream-compiler
```

The check uses the recipe's verified Mozilla source, patches, declared native
dependencies, private sysroot and target configuration. It runs Mozilla
configure, `pre-export` to install public headers, `export` for generated
headers, then the compiler, registry, per-context and diagnostic API object targets. Resolver output roots
are rejected so this diagnostic cannot stand in for a complete package build.
The guest engine is not linked, optimized, instrumented, installed or published.
An object compile result does not establish runtime source positions, GC ownership,
error behavior or startup on any host. For long runs, use `scripts/agent-job`
and retain its command and log alongside the resulting object identities.

## Embedding-private key prerequisite

The guest engine now has a distinct `EmbeddingPrivateSymbol` kind and native
factory. It leaves the existing class-private name kind unchanged. Native
object lookups are own-only and bypass resolve hooks; new private entries
can be added after nonextensibility, remain nonenumerable, and are omitted
from public and class-private key collection and integrity-level changes.
Storage uses the engine's traced property slots and supported proxy handlers'
traced expando. Proxy policy and realm forwarding remain in the normal path.
Missing proxy reads yield undefined; ordinary first writes still reject;
native definition initializes an entry and deletion bypasses script traps.

The source primitive has focused execution evidence on the Node host only:
23 guest controls passed, including proxy initialization/deletion, revoked
scripted proxies, cross-compartment forwarding, value retention across a GC,
frozen objects, and ordinary Symbol/class-private controls. Two additional
driver checks passed: normal shell mode exposes no test API, and Node mode
rejects the test flag. Each execution used a dedicated kernel worker and real
guest output and exit status. Program/kernel/fixture identities and raw results
are in `tests/nodejs/upstream/private-key-engine-check.json` and
`tests/nodejs/upstream/private-key-engine-result.json`.

The diagnostic API is available only with `js --kandelo-test-upstream`. It
creates genuine native keys and performs native initialization; it is not a
runtime binding substitute. Reproduce the focused Node-host controls with an
admitted selected-package artifact:

```sh
scripts/dev-shell.sh node_modules/.bin/tsx \
  scripts/run-nodejs-private-key-controls.ts /absolute/path/to/js.wasm \
  /absolute/path/to/new-report.json
```

The complete native-V8 differential contract, security-wrapper admission,
OOM/finalization behavior and browser hosts remain unproven. The native
reference's earlier eleven controls remain separate reference evidence.
The canonical owner and per-context initializer now exist as described below;
no Node runtime binding exposes their tables yet.

The selected build passed Mozilla's include-style, macroassembler and opcode
checks. It emitted 16 compiler warnings; the retained log includes ICU
thread-safety/deprecation and unused linker-option diagnostics. Its existing
pre-instrumentation optimization invalidates compiler-fact code hashes, so
the instrumenter reported its bounded native baseline fallback. Preserve that
diagnostic: these runs do not validate fork behavior. No full product,
successor-ABI campaign rebuild, overall suite or upstream startup ran.

## Original per-context initialization

The native owner expands the unchanged pinned `env_properties.h` macros to
create 22 embedding-private and 27 ordinary, nonregistry symbol identities
once per guest `ShellContext`. An externally owned engine root holds the runtime
carrier and is destroyed before its JSContext. Each global privately retains
one canonical context carrier through a genuine embedding-private key. Its
reserved slots contain traced JS values; cross-compartment owner references
use engine wrappers. No JS finalizer owns a persistent root back to itself.

Each context receives fresh null-prototype symbol tables with writable,
enumerable, configurable properties, ordinary exports and null-prototype
primordials. The exact original three scripts compile and run in order with
their original four arguments and an undefined receiver. Native state moves
through Initializing to Ready or terminal Failed. Normal getters expose exports
only after Ready, repeated getters preserve identity, and explicit repeat or
reentrant initialization rejects. Failure after canonical publication preserves
the original exception and prevents retry; allocation failure before publication
has no exposed state and may retry. Node's fresh-exports Has/CHECK invariant
remains a native fatal assertion.

On the Node host, 14 focused guest controls passed: all three original scripts,
descriptors and freeze state, shared identities with fresh realm tables,
realm-owned exports/constructors, original DOMException/QuotaExceededError and
messageport behavior, stable getters, repeat/reentry rejection, terminal failure
in each of the three initializer stages, global admission and identity across GC.
Two API-exposure driver controls passed. A separate inherited-primordials
invariant control produced the expected assertion, exit 132 and one host
unreachable diagnostic; it returned neither a catch nor success marker. The
successful initializer run had no host diagnostics. The same revision-19
artifact also passed all 23 existing private-key controls and their two driver
checks. Exact source/artifact identities, raw outputs and retained logs are in
`tests/nodejs/upstream/per-context-engine-check.json` and the linked result receipts.

Reproduce against the identified selected-package engine:

```sh
scripts/dev-shell.sh node_modules/.bin/tsx \
  scripts/run-nodejs-private-key-controls.ts /absolute/path/to/js.wasm \
  /absolute/path/to/new-report.json per-context
```

These are JS-shell diagnostics behind `--kandelo-test-upstream`; Node mode
rejects the flag. They exercise the native owner and unchanged JavaScript,
not a substitute bootstrap. Full security-wrapper, OOM, teardown/finalization
and native-V8 differential contracts remain open, as do source-text modules,
Node realm/bootstrap, CJS/ESM startup, browsers and the complete backend catalog.
The package emitted 16 compiler warnings and the existing fork-facts mismatch
diagnostic. Full products, successor-ABI campaign rebuilds and overall suites
remain deferred; ABI 55 history is unchanged.

## Synthetic module engine prerequisite

Revision 20 extends SpiderMonkey's genuine synthetic module machinery beyond
its original JSON-only evaluation path. `JS::CreateSyntheticModule` accepts
unique string export names, native evaluation steps and a traced private value.
`JS::SetSyntheticModuleExport` updates existing live bindings after linking.
The module owns traced atoms/private state/evaluation Promise; namespaces and
imports use the real engine module environment and graph. Public export names
map to distinct local identifiers, including empty/numeric names and
`*namespace*`, so they cannot collide with engine storage. JSON retains its
original parser, type and evaluation path.

The callback runs once and synchronously. Its Promise is published before
embedding code can reenter, failures reject with the original exception, and
source graphs propagate dependency failures. A reentrant graph cannot treat a
still-evaluating synthetic dependency as complete. This is an engine API
contract; the eventual native ModuleWrap must preserve Node's observable
wrapper, status, callback receiver, error and Promise behavior separately.

On the Node host, 15 guest controls passed with no host diagnostics, covering
actual namespaces and live imports/reexports, dependency ordering/failure,
top-level await, reentry, shared dependencies, arbitrary names, GC retention and
the JSON path. The run enables the existing engine `--enable-import-attributes`
parser option for JSON import syntax; the Node embedding must configure that
capability before compiling sources that require it. All 14 original-context
controls and 23 private-key controls also passed on the same artifact. The
separate fatal-invariant regression retained its assertion, exit 132 and one
expected host trap diagnostic.

Three earlier package attempts failed on declaration ordering/header integration
and a missing inline definition. One guest run recorded three control failures:
the shell's intentionally hidden synthetic debug getters and disabled import
attribute syntax. Corrected controls use actual link/evaluation/Promise
operations and the real parser option; engine bytes did not change for that
repeat. Full failures, final source/artifact identities and results are in
`tests/nodejs/upstream/synthetic-module-engine-check.json` and its result receipt.

```sh
scripts/dev-shell.sh node_modules/.bin/tsx \
  scripts/run-nodejs-private-key-controls.ts /absolute/path/to/js.wasm \
  /absolute/path/to/new-report.json synthetic-modules
```

Four separate controls passed against the exact pinned native Node executable
with `--experimental-vm-modules`. They include public VM reentry rejection,
terminal error identity and distinct rejected Promises on repeated failed
evaluation. They are reference observations, not guest/raw-engine equivalence.
See `synthetic-module-native-reference.json` and `module-wrap-contracts.md`.
The latter inventories the native ModuleWrap registration and prerequisites;
full member/error/lifecycle and transitive-consumer coverage remains incomplete.

The native ModuleWrap core below exists; there is no connected upstream realm/bootstrap yet.
The original builtin source-text compiler helper, Node CJS/ESM entrypaths,
browsers, complete native differential, security/OOM/finalization and startup
remain unverified. The successful package emitted 16 compiler warnings and the
existing instrumentation fallback diagnostic. No canonical image, full product,
successor-ABI campaign rebuild or overall suite ran.

## Native ModuleWrap core

Revision 21 adds a canonical per-realm native binding with genuine ModuleWrap
instances. Reserved slots trace engine records, callback state, dependency
wrappers, host-defined identities and module-source objects. The existing
canonical context carrier caches the binding; native constructor functions
retain its private owner. Runtime module hooks route owned records to this
binding and delegate other records to the prior shell hooks. No finalizer
owns a persistent root back to itself.

The core compiles complete UTF-16 source strings without rewriting them,
retains parser request attributes, links ordered dependencies, creates real
namespaces/live reexports and derives async-graph state from the linked
dependencies. Attribute retention includes unknown values; the original engine
unsupported-attribute error is preserved. Status values map explicitly to
Node's constants. The synthetic callback receives its actual wrapper and is
released before invocation. The first synthetic failure throws synchronously;
later evaluation rejects with the same exception. Own lazy `hasAsyncGraph`,
source pragmas, positive offsets, source-object identity and custom import.meta
callbacks have bounded control coverage.

Nineteen guest controls passed on the Node host, alongside six separate
controls against the exact pinned native internal ModuleWrap binding. The
guest checks include cycles, live imports, top-level await/sync refusal,
original exception identity, separate realm bindings, GC retention and prior
shell-hook delegation. Two isolated fatal controls preserve the constructor
and once-only module-source-object assertions. The same artifact passed all
15 synthetic-engine, 14 context and 23 private-key regressions, including the
separate context fatal-invariant control. Expected assertion traps and host
diagnostics are retained separately from successful runs.

One earlier compile failed on two API mismatches. The first runtime candidate
built but failed four controls: Boolean properties used an integer overload,
and the engine discarded unknown attribute values before metadata storage.
The corrected source and final identified artifact pass the controls. Exact
input/artifact identities, earlier failures and raw results are in
`tests/nodejs/upstream/module-wrap-engine-check.json` and its result receipt;
native-reference evidence is in `module-wrap-native-reference.json`.

```sh
scripts/dev-shell.sh node_modules/.bin/tsx \
  scripts/run-nodejs-private-key-controls.ts /absolute/path/to/js.wasm \
  /absolute/path/to/new-report.json module-wrap
```

This remains a partial native binding. Dynamic import has the bounded core
described below. Default import.meta
URL/path/resolve handling, contextify admission, compile caches, required-ESM
facades, positive deadlines and signal-interruption ownership are explicit
unimplemented failures. Negative source offsets and embedded-NUL diagnostic
URLs are also explicit gaps. Source/defer import phases and nested Wasm are
not established by storing a module-source object. Full native differential,
security/OOM/finalization, browser hosts and actual upstream startup remain
unverified. No canonical image, full product, successor-ABI campaign rebuild
or overall suite ran. The final package reported 16 warnings and the existing
instrumentation fallback; no fork-behavior claim is made.

## Native dynamic-import callback

Revision 22 implements `setImportModuleDynamicallyCallback` and the engine
handoff for ModuleWrap-owned evaluation-phase imports. The callback receives
the original host identity, specifier, phase, frozen null-prototype attributes
and compilation resource name, with an undefined receiver. Attribute values
are validated by the engine; custom and numeric string keys reach the actual
callback. Static unknown-attribute rejection and ordinary shell imports keep
their existing paths.

Node's callback returns a value, which may be a namespace, Promise, thenable
or ordinary value. SpiderMonkey's original completion path instead expects
an evaluated module from its resolver. The new opt-in engine hook preserves
the callback-value contract: a fresh Promise in the referrer realm adopts the
result and forwards settlement to the actual import Promise, without asking
the static resolver to invent a module record. Native reactions trace pending
completion state. A synchronous callback exception stops the source module;
rejected callback Promises reject the import. Upstream JavaScript remains
responsible for actual loader policy and module execution.

Fourteen Node-host guest controls and twelve separate exact native internal
binding controls pass. They cover arguments/resource identity, asynchronous
thenable adoption, pending/foreign Promises, original rejection values,
options conversion order, synchronous callback exceptions and actual namespace
imports with top-level await. Guest controls additionally cover GC retention,
per-realm registration/replacement and delegation to the ordinary shell
loader. The same identified package passes 19 ModuleWrap, 15 synthetic-module,
14 context and 23 private-key regression cases and their exposure/assertion
drivers. Expected fatal traps are retained separately from successful runs.
See `tests/nodejs/upstream/dynamic-import-engine-check.json` and
`dynamic-import-native-reference.json` for identities and limits.

Run the focused guest fixture with `dynamic-import` as the final argument to
`scripts/run-nodejs-private-key-controls.ts`, using the command shape above.
This does not establish script/contextify callback ownership, source/defer
phases, browser behavior or upstream startup. Default metadata/resolver,
cache/facade/interrupt backends and the complete backend catalog remain
unfinished. The build reports the same 16 warnings and existing instrumentation
fallback. No canonical image, full product, successor-ABI campaign rebuild,
overall suite or fork-behavior validation ran.

## Native Error stack core

Revision 23 extends SpiderMonkey's existing native `Error.captureStackTrace`
with an owned-realm policy before original primordials execute. It preserves
actual saved frames, constructor trimming and capture-time limits, adds real
own lazy accessors, caches any successful preparation result, retries thrown
callbacks and guards recursive preparation across realms. Original shell
realms retain their prior capture behavior. A canonical per-context WeakMap
traces captures and prepared values without a finalizer-owned root cycle.

The native errors binding stores and invokes the real bootstrap preparation
callback with `(creationGlobalThis, error, trace)`. Both fatal enhancer
callbacks have actual traced storage and a native phase dispatcher; the guest
process's fatal-reporting path remains disconnected. CallSite objects expose
actual saved-frame source/name/line/column and string formatting. Separate
original-filename state is retained from active engine ScriptSources, so a
`sourceURL` display name does not replace `getFileName()`. Unavailable historical
filename metadata raises an implementation error. Additional
receiver/function/eval/constructor/async/Wasm metadata remains explicit gaps;
the implementation does not invent frame flags or placeholder receiver state.
The native registration inventory and remaining methods are in
`tests/nodejs/upstream/error-stack-contracts.md`.

Twenty-one guest controls and eighteen separate pinned native reference
controls cover the bounded core. The same artifact passes 85 existing engine
regressions and their exposure/assertion drivers. The first compile failed a
namespace assumption; the first runtime candidate failed two controls for
pre-trim budgeting and the bootstrap global-this identity. Those source paths
were corrected while retaining the assertions. Exact source/artifact inputs,
logs and limitations are in `error-stack-engine-check.json` and its receipts.

This is an engine/bootstrap prerequisite, not actual Node startup or complete
stack compatibility. Realm/process/binding loader integration, CJS/ESM entry,
browser hosts, full native/security/OOM/lifecycle differential and the complete
backend catalog remain open. No canonical image, full product, successor-ABI
campaign rebuild, overall suite or fork-behavior validation ran.

## Original realm library loader

Revision 24 executes the complete original `internal/bootstrap/realm` body
with its original four arguments. The native realm owner is published before
execution, retains the actual loader closures and preserves original thrown
values and terminal failure. It reads primordials from protected context state.
Its frozen builtins binding exposes the real registry and compiler; upstream
JavaScript supplies the only builtin cache and exposure policy. Guest process
metadata comes from actual uname/getpid/getppid calls through libc/kernel.
Missing bindings, configuration and cache/source-text operations fail explicitly.

Sixteen focused guest controls pass, including original internal/errors/assert
execution, cache/loader identity, private symbols, real kernel-assigned PID,
original moduleLoadList, builtin ESM facade evaluation, failed/reentrant
initialization and separate realms with GC. The same package passes the 106
prior stack/dynamic-import/ModuleWrap/synthetic/context/private-key cases.
Twelve separate pinned native reference controls pass. Native private-loader
access policy required the original modules helper; no upstream source or
require implementation was substituted. See `realm-library-contracts.md` and
`realm-library-engine-check.json` for exact identities and limitations.

Principal bootstrap remains unfinished: the earlier complete-body diagnostic
stopped on missing config; the native principal-body entry described below now
reaches the missing timers binding through original internal/timers. This failure
is recorded separately from successful realm controls. The process object,
configuration, exit-info, Buffer, timers, async context and wider eager backend
closure still need implementation. The complete catalog/roadmap, real user
CJS/ESM startup and four-host evidence remain open. No canonical image, full
product, successor-ABI campaign rebuild, overall suite or fork-behavior
validation ran.

## Native process and build configuration

Revision 25 gives each realm process a distinct mutable native class prototype
and empty-instance constructor. Non-constructor calls preserve actual effective
receiver/global/boxing behavior. One runtime-owned Int32Array supplies the
original hidden exit-info fields across realms, using checked compartment
wrapping. Native util exposes the original field indices. Actual exit dispatch,
full process metadata/environment and completion still need implementation.

A per-realm config binding reports actual compiled engine/OpenSSL/Intl features,
guest pointer width and selected standard web-bootstrap policy. The locale
comes from the guest engine runtime. Native reference platform/V8 configuration
is not copied; unsupported FIPS configuration and builtins JSON remain explicit
errors. Inspector, tracing and NODE_OPTIONS integration are absent. See
`process-config-contracts.md` for field ownership and current boundaries.

The native owner calls the entire original internal/bootstrap/node body with
protected process/require/internalBinding/primordials, records the actual body
phase, and preserves terminal failure. This currently reaches missing timers
rather than missing config. Node-body completion is separate from the remaining
web/thread/ownership/env stages. Thirteen native-state controls, the 122 prior
engine/realm cases and eight separate pinned native references pass; these
include failure/retry tests, not successful startup. The first reference/guest
attempts exposed incorrect receiver-return and cached-binding assumptions; the
native implementation and control respectively were corrected while preserving
the original JS cache. Exact artifacts/failures/limits are in
`process-config-engine-check.json`. No user CJS/ESM or browser startup, full
catalog, canonical products, successor-ABI campaign or overall suite is proven.

## Native timer scheduler

Revision 26 adds the native timer binding and an opt-in native shell-loop path.
A runtime owns the actual single deadline, reference state, shared immediate and
timeout arrays, real registered callbacks and principal process receiver. The
clock uses guest CLOCK_MONOTONIC relative to environment creation. Integer
conversion, deadline replacement/saturation, expiry return/ref semantics,
reentrant scheduling, GC and foreign function ownership have focused controls.
Public compatibility timer hooks do not supply this native path. Original
internal/timers remains the JavaScript queue and policy implementation.

Twenty-three guest binding/loop controls and 135 existing cases pass on the
same package, with natural-exit and isolated fatal-invariant drivers. Sixteen
separate native reference controls cover direct binding behavior, isolated
unref-only natural exits and fresh-loop phase order. An initial ordering test
assumed that independently queued timers/immediates always have one order;
that assumption was corrected against native behavior. A separate replay then
confirmed and fixed stale native phase state between drains. Exact artifacts,
source identities and failures are in timers-engine-check.json; contracts and
remaining callback/phase boundaries are in timers-contracts.md.

The original principal-node body now passes timers and stops at task_queue.
Native callback-scope/async/tick/fatal retry, full Node/libuv phase semantics,
public timer/module compatibility, process exit dispatch, actual user CJS/ESM
startup, browser hosts and the complete catalog remain unfinished. Full products,
successor-ABI campaign rebuilds and overall suites remain deferred.

## Standalone libuv foundation

The initial libuv package builds the exact 1.52.1 sources bundled in the pinned
Node archive through the normal resolver and the true Kandelo CMake toolchain.
The standalone libuv release differs in four C files; its bytes were compared,
not silently adopted. The port selects upstream POSIX poll/monotonic-clock
backends and exports their public loop layout through CMake/pkg-config. A typed
pthread wrapper replaces upstream's incompatible void/pointer-returning callback
cast, with explicit child/caller allocation ownership. No kernel, libc, SDK or
Node JavaScript source change was needed.

Thirteen focused controls pass on Node, Chromium, Firefox and WebKit using the
same probe and ABI-56 kernel bytes. They cover empty loops, timer deadlines and
repeat/ref/close state, prepare/check phases, actual cross-thread async wakeups,
thread-pool work, pipe readiness, asynchronous file write/read effects and
errors. Two controls check honest unsupported boundaries: filesystem event
watching and process titles return ENOSYS. This is initial loop evidence, not
complete libuv conformance or Node startup. The archive defines 308 of 318 public
function declarations; ten OS resource/interface/executable-path functions
remain missing and fail to link. Socket/DNS/spawn/signal/cancellation/fork/OOM
and complete lifecycle behavior remain unvalidated.

The checks used empty guest filesystems. No partial/canonical product image or
overall suite was built/run. The browser image-builder helpers were provisioned
through their normal focused build. An initial ordinary browser setup began
unrelated historical ABI-56 fixture/tool provisioning; it was stopped before
cohort publication. No pinned ABI-55 or ABI-56 cohort artifacts were published;
temporary ABI-56 build outputs remain under target/program-baseline.
Subsequent focused setup avoids that provisioner. Earlier browser harness
errors/timeouts and the actual pthread trap remain recorded. The passing browser
run reports a separate host cleanup warning: macOS denied removal of the owned
Firefox Downloads directory; guest stderr and host diagnostics are empty.

Node's revision-26 embedding still uses its existing native scheduler and still
stops on task_queue during the original principal body. Next adapt that scheduler
to the verified libuv loop/handles, retain native realm/GC/callback ownership,
and implement genuine task-queue/async callback scopes. Wider libuv support
belongs in the backend catalog and ordered roadmap; it is not implied by these
controls. Exact artifacts, inputs, source comparison, failures and limits are in
[libuv-backend-engine-check.json](../tests/nodejs/upstream/libuv-backend-engine-check.json).

## Native timers integrated with libuv

Revision 27 links the normal resolved libuv 1.52.1 package (revision 3) and uses
real loop, timer, check and idle handles. The native deadline/ref/PreferImmediate
slots and custom phase selection are removed. Time, deadlines, liveness and
phases now come from libuv. The native-only path blocks in UV_RUN_DEFAULT;
existing non-libuv native watches retain an explicit NOWAIT/shell-poll bridge.
The ordinary compatibility bootstrap and its timer path remain separate.

Callbacks, shared arrays, principal process and realm remain traced in protected
JS slots. Native data borrows only a stack root while uv_run executes. Timer and
check callbacks run actual engine job checkpoints; foreground finalization
closes initialized handles and their native loop without calling JS. Failed
callbacks stop the loop and preserve their exception; shell quit status is also
preserved. Full Node callback scopes, AsyncWrap/ticks/rejection/fatal routing and
complete lifecycle/security/OOM behavior remain unfinished. Public handle sizes
are checked before libuv writes native state. The explicit Kandelo header
selector takes precedence over ambient legacy SpiderMonkey Linux macros; the
libuv library itself uses the true Kandelo target. SpiderMonkey's wider target
configuration debt remains open.

Twenty-seven timer binding/loop controls pass on each of Node, Chromium, Firefox
and WebKit using identical engine/kernel bytes, including moving GC during a
callback checkpoint and outstanding immediate batches. Natural unref exits and
callback quit status pass separately on all four hosts. On Node, the same
artifact also passes the 135 prior cases and their drivers; six expected fatal
assertions retain their diagnostic/error exits. Eighteen pinned native timer
reference controls pass separately. These are binding/engine controls, not
successful original public timers or Node startup.

The initial patch build failed because short context let patch place the
checkpoint before its dependencies; the corrected patch uses actual loop
context. The first guest run then exposed a former scheduler test's incorrect
same-drain assumption: the pinned native executable also services a reentrant
zero-delay timer after its first callback unrefs it. The corrected fixture tests
both that native phase behavior and future reentrant scheduling. No engine code
was changed to force the old expectation. The first browser run failed in the
harness's inspector-body hashing of the large response. The final runner hashes
the exact consumed ArrayBuffer in-page and uses the normal resolver's file
approval. Those failed attempts remain retained. The passing browser run still
reports a separate macOS permission warning cleaning its owned Firefox profile.

Original principal bootstrap still stops on task_queue at internal/timers:92;
original stack-limit policy still reaches missing constants. User CJS/ESM entry,
output/error/exit startup acceptance and the full backend catalog remain open.
No partial/canonical product images, full product/ABI campaigns or overall suites
ran. Exact inputs, artifacts, per-host results, failures and limits are in
[timers-libuv-engine-check.json](../tests/nodejs/upstream/timers-libuv-engine-check.json).

The next startup seam is cataloged in
[task-queue-contracts.md](../tests/nodejs/upstream/task-queue-contracts.md).
Selected Node-host probes confirm actual shell queue FIFO, nested suppression
and promise event identity, but also two integration gaps: job exceptions use
shell reporting/error exit rather than Node's fatal policy, and nested shell
checkpoints clear kept objects during the active job. Six pinned native
reference controls cover the corresponding binding contracts separately.
These are measured prerequisites and gaps, not a task_queue implementation or
startup success. Native Node callback/error routing and checkpoint ownership
must address them while preserving the real engine queue and unchanged JS
tick/rejection policy. No new browser queue probe or package rebuild belongs
to this source inventory; earlier four-host timer evidence remains separate.

## Native task queue checkpoints

Revision 28 adds the actual native task queue state/registrations and engine
enqueue/checkpoint path. Traced native job adapters retain arbitrary callables
without a shadow FIFO or Promise wrapper. Native and shell nested checkpoints
check the engine's real drain state before kept-object cleanup. The shared
Uint8Array flags drive the retained original tick callback with the principal
process receiver, separately from microtask-only entry.

The native owner receives job errors through the script-environment preparer
and can invoke the actual mutable process `_fatalException` callback. Real
promise/reason identities and handler-added events reach the retained rejection
callback. Full native AsyncWrap IDs/resources/frames, original public rejection
policy, common callback scopes and fatal exit/at-exit remain incomplete.
Assigned promise contexts and active module-evaluation checkpoints fail
explicitly; unhandled/false/throwing fatal policy preserves the actual failure.

The first integrated bootstrap exposed absent `errors.exitCodes`. Importing
the complete pinned native header and expanding its enum supplies all fourteen
constants and native property attributes, matching the pinned executable.
The imported set is now 494 files; every previous record and all 443 registered
JavaScript bodies remain unchanged. This does not establish process-exit support.
Original principal bootstrap now stops on `async_wrap` through internal/async_hooks;
the separate original stack-policy probe still stops on constants.

Twenty-six task queue/enum controls pass on each host with identical
engine/kernel bytes. The same artifact passes the prior 162 Node cases, with
all eleven expected fatal controls retaining error exits/diagnostics. Six pinned
native queue references pass separately. The first failed build, initial
24-of-25 control run and intermediate bootstrap TypeError remain retained.
The browser run also retains its macOS cleanup permission warning. These are
raw binding/checkpoint results, not successful empty/simple or CJS/ESM startup.
Full product/images/ABI campaigns and overall suites remain deferred. See
[task-queue-engine-check.json](../tests/nodejs/upstream/task-queue-engine-check.json)
for exact identities, per-host results, failures and limits.

## Native async state and original internal hooks

Revision 29 adds partial native `async_wrap` state and the canonical `symbols`
binding. The complete original internal/async_hooks body executes through the
existing realm loader. Actual runtime-owned fields, IDs, stack and resources
support native and original-JS stack operations; registered hook/trampoline
functions and owners are traced. The existing Promise rejection callback now
pushes actual assigned IDs and the actual Promise resource, then conditionally
restores context, including after callback failures or stack reset.

The importer adds complete original src/env.h, src/async_wrap.h and
src/async_wrap.cc. All previous 494 records and all 443 registered JavaScript
bodies (10,993,403 bytes) remain unchanged; the import now contains 497 files.
Thirteen API enum constants and the provider names come from verified complete
native declarations. Constructor state follows the native constructor, not a
post-bootstrap native snapshot. Provider names are not resource implementations.

Twenty selected controls pass on each of Node, Chromium, Firefox and WebKit
using identical engine/kernel bytes. The same artifact passes 188 prior Node
cases. Nine shared assertions pass on the verified pinned native Node executable;
thirteen constants and 69 provider values match. Nineteen expected fatal Node
controls retain diagnostic/error exits across 73 process drivers. The first
18-of-20 result, failed rooting build and copied browser count assertion remain
recorded separately. Browser cleanup retains its macOS permission warning.

Requested Promise lifecycle hooks, GC destroy observers and observer-enabled
destroy delivery still fail explicitly. Common native callback scopes,
continuation frames, complete fatal/exit lifecycle and full async resource classes
remain unfinished. Original principal bootstrap now reaches missing constants in
internal/util:62 through internal/validators:35 and internal/timers:120. Complete
empty/simple/CJS/ESM startup and the full catalog remain unproven. No product images,
full product/successor-ABI campaigns or overall suites ran. Exact artifacts and
limits are in [async-wrap-engine-check.json](../tests/nodejs/upstream/async-wrap-engine-check.json);
contracts and next work are in [async-wrap-contracts.md](../tests/nodejs/upstream/async-wrap-contracts.md).

## Original native constants initializer

Revision 30 compiles complete original node_constants.cc/node_constants.h through
an actual SpiderMonkey property builder. It registers the original native
initializer and creates per-realm cached null-prototype tables with original
attributes. All 425 definitions come from original native declarations and actual
target headers. Compression metadata derives 171 export operands and original
enum/limit declarations; no upstream JavaScript or compression algorithms change.
The imported set is 509 files; every prior 497 record and all 443 JS bodies remain
unchanged. Pinned Brotli headers supply declarations only, not a Node backend.

An independent C guest probe exposed missing zstd_errors.h in libzstd's outputs
and unintended Mozilla bundled-zlib header precedence. The library now installs
its matching public header; decoder archive bytes remain unchanged. The Node
constants source explicitly uses the declared compression dependency headers.
Actual codec symbol/version and operational integration remain future work.

Ten constants controls, 43 target-header comparisons and four filesystem flag/errno
effects pass on each host using identical artifacts. The engine also passes 208
prior Node cases; 80 selected process drivers retain 19 expected fatal controls.
Six shared native references pass; 348 values match the native snapshot and 90
OS/dependency/configuration differences remain explicit. No Darwin values are
substituted for target values. Original bootstrap now reaches missing types at
internal/util:73; no complete upstream startup or full graph catalog follows.

Exact source/artifact identities, failed builds, incorrect header selection,
reference/probe fixture failures and limits are in
[constants-engine-check.json](../tests/nodejs/upstream/constants-engine-check.json).
Contracts and next work are in
[constants-contracts.md](../tests/nodejs/upstream/constants-contracts.md).
No product images, full products, successor-ABI campaigns or overall suites ran.

## Native engine type predicates

Revision 31 supplies all 26 native `types` exports using actual SpiderMonkey
object classes and function flags. A strict generator derives export names from
the complete byte-verified native source; original JavaScript remains unchanged.
Predicates do not inspect public tags, constructors or prototypes. Checked engine
wrappers preserve foreign native identity; scripted/revoked proxies do not unwrap
or invoke handlers. Genuine module namespaces are distinguished from scripted
proxies. The real borrowed-pointer External carrier has a private class, null
prototype and no extensibility; it is not a Node resource handle or Node-API
implementation. Traced functions retain their realm and reject after its failure.

Twenty-one focused controls pass on Node, Chromium, Firefox and WebKit with
identical engine/kernel bytes, including execution of the complete original
`internal/util/types` module. All 86 shared-value classifications match the pinned
native executable; thirteen shared native controls pass separately with a genuine
External addon. The same engine passes 218 prior cases on Node, including nineteen
expected fatal controls. The browser drivers preserve natural job exit, requested
quit status and the original unhandled job error. Selected controls cover moving
GC, cross-realm values, intrinsic typed-array getters and failed-realm isolation.
Complete denied-wrapper/OOM/teardown/ShadowRealm equivalence remains unproven.

The original principal body and stack-policy probe now reach missing `options`
at `internal/options:20`, from `internal/util:74`; original typed NodeError
construction still succeeds. Ordinary public startup remains the compatibility
bootstrap. Empty/simple and separate CJS/ESM startup acceptance, the full backend
catalog and broader implementation roadmap remain open. Initial include-style
and native fixture failures are retained, along with the existing browser cleanup
permission warning and Mozilla targeting/fork limitations. No product images,
full product or successor-ABI builds, or overall suites ran. Exact evidence and
partial contracts are in [types-engine-check.json](../tests/nodejs/upstream/types-engine-check.json)
and [types-contracts.json](../tests/nodejs/upstream/types-contracts.json).

## Original native options parser

Revision 32 compiles the complete original native options parser, storage,
validation and serializers unchanged, with the original libuv mutex header.
A private API adapter marshals actual rooted SpiderMonkey values and real
realm/profile state. It emits no JavaScript or function excerpts. Seven original
methods and both readonly enum inventories are registered by the original native
initializer; the complete original `internal/options` module executes.

Six queries preserve ERR_OPTIONS_BEFORE_BOOTSTRAPPING until genuine complete
bootstrap. No test override opens that phase. Real native guest invocation inputs
are parsed before realm.js; explicit private profile controls exercise the same
original parser and real storage without claiming startup. Unimplemented engine,
config/security/file adoption and memory queries fail explicitly. Kernel sysinfo
placeholders are not published as actual available memory. Full CLI adoption and
post-bootstrap metadata equivalence remain unfinished.

Fourteen selected controls pass on each of Node, Chromium, Firefox and WebKit with
identical engine/kernel bytes; six shared native controls pass separately. Seven
additional Node profile drivers preserve actual errors and unsupported boundaries.
The same engine passes 239 prior Node cases. A separate complete-source C++ probe
has identical 23-case observations on all four hosts, with 114 selected native
value comparisons, ten matching errors and 152 common environment metadata entries.
Inspector/FFI build differences and raw namespace versus schema filtering are
recorded. These remain component controls, not successful upstream startup.

Method registration now follows original Set-before-name ordering and inherited
setters. Setter failures remain fatal; name inspection during that late mutation
fails explicitly until engine tracking is implemented.

The original principal and stack-policy probes now reach missing `string_decoder`;
typed NodeError construction still succeeds. Empty/simple and separate CJS/ESM
startup, the full backend catalog and roadmap remain open. No product images,
full products, successor-ABI builds or overall suites ran. Full evidence, failures
and partial contracts are in [options-engine-check.json](../tests/nodejs/upstream/options-engine-check.json)
and [options-contracts.json](../tests/nodejs/upstream/options-contracts.json).

## Decoder dependency inventory

The `string_decoder` partial catalog records
ten original exports, two literal native consumers and eight literal public-module
consumers, including the lazy TextDecoder path. The original decoder stores its
streaming state in actual guest buffer bytes and calls the native StringBytes
codec layer. An encodings table alone does not implement that binding.

The initial inventory retained thirteen native controls and 280 selected
chunk/output/state records. Its separate compile-only codec preflight remains
historical evidence; the linked revision-33 integration is described below.

The catalog distinguishes native view/string ownership from the still incomplete
public Buffer closure. Archived codec
regression requirements and retained-allocation owners are reuse candidates;
the old handwritten public codecs are excluded. See
[string-decoder-contracts.json](../tests/nodejs/upstream/string-decoder-contracts.json)
and [string-decoder-native-reference.json](../tests/nodejs/upstream/string-decoder-native-reference.json).

## Resolved native codec dependencies

The normal resolver now builds nbytes 0.1.4 and simdutf 7.7.0 from the exact
audited Node archive. nbytes uses upstream CMake with optional C++ module scanning
disabled for its non-module sources. simdutf builds the complete V8-vendored
amalgamation. Both packages retain original headers/licenses, declare libcxx and
use the true Kandelo SDK target. Their installed pkg-config metadata is relocatable.

A consumer linked from relocated package copies passes seventeen selected controls
on Node, Chromium, Firefox and WebKit with identical guest program/kernel bytes.
The controls cover Unicode validation/conversion, surrogate replacement, base64
and bounded output, Node byte primitives and actual implementation selection.
These are native library controls, not the SpiderMonkey Node runtime or complete
codec conformance. No product image or supported-package-set entry is added.

The earlier declaration-only preflight compiled the complete original decoder
and StringBytes translation units. Those historical objects do not establish
runtime behavior. Exact artifacts, inputs, failed attempts
and limits are in [native-codec-engine-check.json](../tests/nodejs/upstream/native-codec-engine-check.json).

## Original native decoder and StringBytes integration

Revision 33 links both resolved codec libraries and executes the complete,
unchanged original decoder and StringBytes translation units. Six whole native
files are staged byte-identically. The complete original encoding enum and three
error type/code/message records supply verified metadata; no codec algorithm or
JavaScript function is extracted. All prior 516 imported records and all 443
JavaScript source records remain unchanged.

The engine bridge owns real rooted values, typed callback metadata and actual
ArrayBufferView storage, including view offsets, shared memory, aliasing and
resizable buffers. It stabilizes inline backing storage before pinning lengths
and restores only pins acquired by the current owner. Strings use actual engine
allocation and external-string finalizers. Per-runtime shared native state keeps
external-resource accounting alive until final disposal without permanent JS
roots or JavaScript callbacks from finalizers.

Twenty-two binding controls pass on Node, Chromium, Firefox and WebKit using
identical engine/kernel bytes. Sixteen shared controls, export descriptors and
280 chunk/output/state records match the authenticated native Node reference.
Additional controls collect during native borrows, retain cached functions across
GC, use cross-realm views and observe external Latin1/UTF16 resource retirement.
Three invalid-state/input drivers retain fatal exits on Node. This is bounded
native binding evidence; public StringDecoder and complete Buffer behavior are
not established.

The same artifact passes all 253 prior Node-host engine cases. Across these
selected engine checks there are 341 case observations, 95 process drivers and
24 expected fatal exits. Browser job-draining/error/quit-status drivers also
pass. The browser harness retained its storage after reporting WebKit still
running; the cleanup warning is separate from empty guest/host diagnostics.

The initial aliasing failure came from calling the engine's stabilization helper
on already pinned out-of-line storage; the bridge now inspects the actual storage
kind first. A later GC trap narrowed to resizable storage. Engine patch 0040
preserves full maximum capacity and zero-filled growth when converting inline
storage. This is tracked as the suspected
[resizable-buffer capacity defect](../tests/runtime-workarounds/FIREFOX-RAB-NONINLINE-CAPACITY/entry.md).
An authenticated unmodified Mozilla 140.11.0 native shell did not crash on the
first reduced case; that outcome is retained and the defect is not called confirmed.

The revision-33 principal bootstrap and original stack-limit policy reached
`TypeError: can't access property "openssl", process.versions is undefined`
at `node:internal/util:78`. The next prerequisite is a truthful native versions
provider from actual source/build/library identities. Buffer allocation/prototype
support, complete StringBytes Write/Size coverage, OOM/security/worker teardown
and complete graph reconciliation remain open. No partial/canonical image, full
product, successor-ABI campaign or overall suite ran. See
[decoder-engine-check.json](../tests/nodejs/upstream/decoder-engine-check.json).

## Native process version metadata

Revision 34 initializes `version` and `versions` on the actual initial realm
process through the native embedding. The complete original `node_version.h`
supplies source-version data. Four whole upstream process/metadata files are
admitted for provenance and contract review; the original V8-dependent metadata
constructor and process factory are not claimed as executed. No upstream
JavaScript or native function excerpt is substituted.

The provider reports the actual SpiderMonkey implementation, resolved libuv,
OpenSSL, zlib, zstd, nbytes and simdutf, plus the engine's ICU, Unicode, CLDR and
timezone data. Unsupported V8, addon ABI, Node-API and Amaro entries remain
absent. Imported vendored sources do not enable their runtime features. Ordinary
data properties retain the native reference's read-only/configurable/enumerable
attributes, node-first ordering and ordinary mutable object prototype. Each
initial realm process owns its own metadata; constructor instances remain empty.

The first link exposed Mozilla's omission of the declared CLDR-query API. The
build now compiles the complete unchanged ICU `ulocdata.cpp` unit and queries
the installed data. The first runtime comparison then exposed Mozilla's exported
prefixed zlib header selecting its internal 1.3.2 library. The embedding now stages
the resolver's complete `zlib.h`/`zconf.h` pair and calls its actual 1.3.1 library,
matching the embedding's dependency and native constants. Mozilla's own prefixed
zlib remains separate. Neither failure is hidden by a copied version string.

Twelve metadata controls pass on Node, Chromium, Firefox and WebKit using
identical engine/kernel bytes. Four native reference controls verify property,
constructor and collection behavior separately. The same engine passes all 275
prior Node cases: 323 selected engine case observations, 98 process drivers and
24 expected fatal exits overall. The browser harness reports a separate macOS
permission warning cleaning its Firefox Downloads directory.

Original `internal/util` now executes, including encoding normalization and
actual crypto/TypeScript capability checks. Principal bootstrap reaches missing
`icu` at `internal/util/inspect:2958`; original stack-limit policy reaches missing
`mksnapshot` at `internal/v8/startup_snapshot:19`. Typed original Node errors still
return. Empty/simple, CJS/ESM and browser startup acceptance remain unfinished.

The metadata syntax index parses all 443 original JavaScript sources and records
22 references with conservative alias handling. This is not complete dataflow,
worker, lazy or exceptional-path reconciliation. Full process metadata, remaining
native binding closure and the full backend catalog/roadmap remain open. No full
product, image, successor-ABI rebuild or overall suite ran. See
[process-versions-contracts.json](../tests/nodejs/upstream/process-versions-contracts.json),
[process-versions-consumers.json](../tests/nodejs/upstream/process-versions-consumers.json)
and [process-versions-engine-check.json](../tests/nodejs/upstream/process-versions-engine-check.json).


## Complete original native ICU binding

Revision 35 compiles the whole unchanged `src/node_i18n.cc` and
`src/api/encoding.cc` against the private rooted SpiderMonkey API. The original
per-isolate initializer installs all six binding exports and the actual
Converter template; the original per-context initializer runs too. The width
algorithm, encoding parser and streaming/BOM/error policy remain upstream C++.
Five complete source/header additions bring the manifest to 532 files; all 527
previous records and all 443 JavaScript sources remain unchanged. Original
`util-inl.h` and `node_internals.h` are provenance for helper contracts, rather
than claimed executed factories.

Each Converter is a real engine object owning the original native
`ConverterObject` and guest ICU `UConverter`. Its construction root becomes weak,
its owning realm remains traced, and foreground finalization retires its pointer
before deleting it and closing ICU state. Moving GC preserves live converters;
a failed owner cannot be bypassed through another realm's active decode
function. Binding callbacks retain their actual realm and template. Per-call
buffer roots retain actual views, offsets and shared/resizable storage; previous
pin states are restored. Logical stack-buffer lengths now follow the complete
original helper contract. Callback return slots start as undefined after rooting
the engine callee, preserving original early returns.

Twenty-three controls pass on each of Node, Chromium, Firefox and WebKit using
identical engine/kernel bytes. Fifteen shared controls, 68 selected width records
and eight streaming records match the authenticated native reference. All 287
prior Node cases pass on this artifact. The aggregate is 379 selected case
observations, 104 process drivers and 27 expected fatal exits. Six source-stage
integrity controls pass. The browser harness retains its separate macOS
permission warning removing its owned Firefox Downloads directory.

This is partial ICU binding support. Mozilla's selected ICU configuration sets
`UCONFIG_NO_LEGACY_CONVERSION=1`: windows-1252, shift_jis, gb18030, koi8-r and big5
are unavailable where the native reference supports them. These five differences
are recorded as build gaps, not browser limits or matching controls. Successful
transcode needs the missing original Buffer allocation/prototype backend and
throws an explicit unsupported error; no Uint8Array substitutes for Buffer.
Unexercised encoding helper paths, reentrant resize/detach, OOM/security/full
teardown, data-version coverage and complete public TextDecoder/Buffer
compatibility remain open. Snapshot external-reference serialization is not
implemented by this source-mode embedding.

The first build failed on missing declaration glue. Runtime checks then exposed
an incorrect width expectation, an uninitialized callback return slot and a
failed-owner admission bypass; the native comparison and pre-fix failures remain
retained. Original `internal/util/inspect` now executes, including its ANSI/NFC
width helper. Principal bootstrap stops honestly on missing `trace_events` at
`internal/trace_events:8` through `internal/util/debuglog:25`; original stack-limit
policy still stops on `mksnapshot` at `internal/v8/startup_snapshot:19`. Typed
original Node errors return. Complete empty/simple and separate CJS/ESM startup,
full graph catalog and ordered roadmap remain unfinished. No image, full product,
successor-ABI campaign or overall suite ran. See
[icu-contracts.json](../tests/nodejs/upstream/icu-contracts.json) and
[icu-engine-check.json](../tests/nodejs/upstream/icu-engine-check.json).


## Standalone tracing library prerequisite

The missing trace-events binding needs a real controller, native agent and
engine extra-binding functions. The new `v8-tracing` package provides the first
prerequisite: seven complete original translation units for the Node-bundled V8
controller, config, event object, ring buffer, JSON writer, fatal logging and
abort mode. The component version 14.6.202.34 comes from the audited archive's
V8 version header; it does not identify a running V8 JavaScript engine and does
not add `process.versions.v8`.

The native target-header patch recognizes Kandelo/wasm32 explicitly. Private
clock, process/thread ID, printing and termination facilities call guest
libc/kernel APIs. The mutex adapter uses the whole original Node `node_mutex.h`
over resolved libuv. Category matching, enabled bytes, observer transitions,
copy/convertable ownership, ring handles and JSON serialization remain original
library algorithms. No upstream JavaScript changed, and the existing 532 source
records remain identical.

Nine controls pass on each of Node, Chromium, Firefox and WebKit with identical
program/kernel bytes. Two compile-only checks verify actual target identity and
precedence over the existing embedding Linux macro. The initial selector was
placed in the feature-header block; the new check exposed that mistake, and the
corrected OS detector now takes precedence. Relocated CMake and pkg-config consumers pass separately
on Node: 54 selected case observations across six guest processes. The first
relocation check exposed libuv's installed pkg-config file retaining its original
cache prefix. Revision 4 fixes that metadata; its runtime archive is byte-identical
to revision 3. The initial compiler-driver error, unsupported target/missing Abseil
probe, incomplete private declarations and relocation failure remain retained.
The first browser run retained storage because WebKit was still running; the
final run reports a separate Firefox profile-cleanup permission warning.

At this standalone checkpoint the library was not linked into SpiderMonkey.
Original Node agent/writer/buffer classes, trace binding, engine intrinsics,
per-environment handler and native external byte ownership were incomplete. The original controller uses
process-global category storage, which must outlive every future guest JS view.
Broader file/rotation/error, clocks, locking, cancellation, OOM/security and
process/worker teardown behavior remain unproven. The existing engine was not
rebuilt this phase: its identified ICU evidence remains separate, principal
bootstrap still stops on trace_events and stack-limit policy on mksnapshot.
No product images, full products, successor-ABI builds or overall suites ran.
See [trace-events-contracts.json](../tests/nodejs/upstream/trace-events-contracts.json)
and [v8-tracing-component-check.json](../tests/nodejs/upstream/v8-tracing-component-check.json).

## Original native tracing agent integration

The revision-36 engine links the resolved standalone tracing library and six
complete original Node translation units: `agent.cc`, `agent_legacy.cc`,
`node_trace_buffer.cc`, `node_trace_writer.cc`, `traced_value.cc` and
`trace_event_helper.cc`. The import now contains 549 authenticated files;
all 532 prior records and all 443 JavaScript sources remain unchanged. The
native `node_trace_events.cc` and V8 `builtins-trace.cc` are imported for the
next binding step, but are not compiled by this checkpoint.

One process owner supplies actual dependency versions from the same native
provider as `process.versions`, and tracing configuration from the complete
original options parser. It never reads mutable JavaScript version properties.
The source agent owns its real libuv worker, buffer, asynchronous writer and
guest trace files. An explicit main-thread hook removes native observers and
destroys the agent before destroying the JavaScript context, so finalizers
cannot become responsible for joining a tracing worker. The process owner
cannot be recreated after shutdown. Permission-policy adoption and changes to
the process tracing profile remain explicit errors.

Nine agent controls pass on Node, Chromium, Firefox and WebKit with identical
engine/kernel bytes. They read actual guest trace files and cover metadata
independent of mutable JS properties, category selection, moving GC, explicit
shutdown, natural exit, quit status, uncaught errors, immutable options and
failed-realm/permission admission. The final engine also passes all 310 prior
Node cases: 346 selected engine observations across 128 guest processes,
including 27 expected fatal assertion exits. Three pinned native CLI controls
independently check trace metadata and exit/error flushing. These are native
agent/engine controls; they do not execute the original trace-events binding.

Failed attempts remain recorded. The first build exposed a C++20 header leaking
into Mozilla's C++17 shell; the shutdown-only header fixes that boundary. The
next build exposed include-order errors. Initial fixtures wrote to the read-only
guest root, received EROFS and timed out during writer shutdown. The corrected
fixtures explicitly select writable guest `/tmp`. File-open failure handling
remains an open investigation, with its timeout and syscall evidence retained.
Later checks caught the adapter's hardcoded platform label and incorrect test
snapshot boolean: tracing now reads actual guest `uname`, and the test property
uses a real JS boolean. Two fixture assumptions about repeated/empty options
were corrected to match the actual parser. The final browser run reports a
separate Firefox profile-cleanup permission warning; guest diagnostics and
browser errors are empty.

The original V8 trace builtin preserves lone UTF-16 surrogates as WTF-8.
SpiderMonkey's usual UTF-8 helper replaces them. A separate guest probe compiles
the complete original V8 encoder header and passes six encoding controls;
three actual pinned native builtin/file-byte checks confirm surrogate encoding.
This supplies a verified primitive for the next binding step, but is not yet
adopted in the engine. No upstream algorithm was extracted or rewritten.

This integration does not provide the original trace-events binding, V8 extra
functions, `CategorySet` constructor, external category-byte views or the
per-environment JavaScript observer. Principal upstream bootstrap still stops
on `trace_events`; stack-limit policy still stops on `mksnapshot`. The broader
backend catalog, public module compatibility and genuine CJS/ESM startup remain
open.

No product images, full products, successor-ABI builds or overall suites ran.
See [trace-agent-engine-check.json](../tests/nodejs/upstream/trace-agent-engine-check.json)
for exact inputs, artifacts, checks and retained failures.

## Original tracing binding and engine intrinsics

Revision 37 compiles complete, unchanged `node_trace_events.cc` and
`builtins-trace.cc`. Three additional original Unicode/UTF-8 decoder headers
bring the authenticated import to 552 files; all 549 prior records and all
443 JavaScript sources remain unchanged. The encoder uses the complete
original V8 implementation, including its WTF-8 policy. No upstream function
body was extracted or rewritten.

The shared native value bridge now supplies actual rooted functions, arrays,
receivers, constructors and prototype methods. CategorySet objects retain
their real native source owner and traced realm; weak finalization deletes
that owner once. Actual external ArrayBuffers expose the controller's stable
category bytes directly. Their deleters retain native process state, while
foreground process shutdown remains responsible for removing observers,
flushing the source writer and joining its worker. Collecting a view never
joins a tracing thread.

The original intrinsics validate their own arguments and emit their own
TypeErrors. JSON traversal uses SpiderMonkey's actual ToJSON operation,
preserving getters, toJSON, reentrancy, cycles, BigInt and thrown identities.
The original trace payload owns the converted bytes. One traced environment
observer retains the current handler across realm replacement and moving GC,
checks actual principal/callback-owner state and invokes the real synchronous
controller notifications. The privileged test teardown control rejects calls
from an active tracing stack, preventing a JSON getter or observer from
removing the agent beneath an original native call.

Twenty-one shared controls and the trace file's category/name/phase/id/data
projection match the pinned native Node reference. Twenty-nine binding and
ownership controls, five source-fatal assertion drivers and three real exit
flush/status drivers run on each host. They exercise long Unicode names,
32-bit numeric conversions, original internal/trace_events execution,
constructor/receiver shape, live flag aliases, cross-realm ownership, observer
replacement, failed-owner retirement and native finalization. The same engine
also passes the prior 310 Node controls and nine native-agent controls.
Expected native aborts and browser Wasm-trap diagnostics remain recorded.

The first build exposed libuv's NO_DATA macro colliding with SpiderMonkey's
buffer enum. A declaration-order prelude loads the actual buffer types before
libuv; no OS identity or upstream source change fixes this. Later builds
caught a const override mismatch and include ordering. Test failures include
an uninitialized private file reader, one added fixture syntax error, stale
hasTracing metadata expectations, and browser-specific intentional-trap console
text. Retained reports distinguish each attempt from the corrected checks.

The original principal body now stops at `async_context_frame:10`, through
`internal/timers:130`. The stack-limit policy still requires `mksnapshot`.
Original public trace_events also depends on the unfinished worker closure;
these controls do not establish public compatibility. Native verbose observer
exception routing, permission-policy adoption, source writer open-failure
shutdown, rotation/cancellation/partial writes, transfer edge behavior,
heap snapshots and full security/OOM/worker teardown remain open. Normal Node
mode still uses the legacy bootstrap; genuine empty/simple startup and CJS/ESM
entrypaths are incomplete.

No images, full products, successor ABI or overall suites were built or run.
See [trace-binding-engine-check.json](../tests/nodejs/upstream/trace-binding-engine-check.json)
for exact source/artifact identities, selected results and retained failures.

## Continuation-preserved engine data

Revision 38 adds actual continuation data to SpiderMonkey's JSContext and
compiles the complete original `async_context_frame.cc` and header. The
canonical native value bridge supplies the source's actual current/set/exchange
operations and persistent `Global<Value>` root. The source Scope constructor
and destructor exchange/restore the real value. Its setter reads the actual
original async-context option under the original CLI mutex; the default stays
true. Engine get/set intrinsics remain available independently of the optional
Node library mode, matching the authenticated disabled-option reference.

The existing engine JobQueue hook captures a real snapshot when a reaction is
registered, including an undefined value. The typed FIFO traces each native
job and its retained value. Promise reactions use their registration snapshot;
direct native microtasks capture at enqueue. Each job installs its snapshot and
restores the prior rooted value through scope exit, including throw and quit
paths. Wrapping occurs at real realm boundaries. This uses adapted native
snapshot/queue/restoration mechanisms from archived patch0040, without its old
public JavaScript surface. Raw Promise lifecycle hooks, AsyncWrap IDs and common
native callback scopes remain separate unfinished contracts.

Twenty raw shared controls match native Node. Twenty-seven engine/native-scope
controls plus seven additional drivers pass on each host with identical engine
and kernel bytes. They exercise pending/settled reactions, undefined capture,
thenables and errors, Promise combinators, async functions/generators, repeated
await, actual native microtasks, arbitrary rooted values, moving GC, foreign
realm values/jobs, original native Scope nesting/throw/async capture, actual
option gating, error recovery, checkpoint restoration and real exit statuses.
The same engine passes all 310 prior Node controls, nine native-agent controls
and 37 tracing binding/exit/fatal observations. These selected checks do not
establish complete async lifecycle or public AsyncLocalStorage compatibility.

The first 28-case fixture reports four real failures from the original
pre-bootstrap options guard. The engine cases passed; active original Frame,
AsyncLocalStorage and RunScope checks attempted their actual upstream code and
received ERR_OPTIONS_BEFORE_BOOTSTRAPPING. Their native counterparts pass after
real native bootstrap. Those four guest consumer checks remain deferred and
recorded until genuine startup completes. No completion flag or JavaScript
module was substituted. The first expanded native-reference driver also had a
duplicate binding declaration; its harness failure and corrected run are kept.

Principal bootstrap now executes original internal/timers, original events and
abort-listener dependencies, then stops at the missing buffer binding in
setupBuffer. The stack-limit policy still stops at mksnapshot. The import has
554 authenticated records, with all 552 prior records and all 443 JavaScript
sources unchanged. Four-host startup, empty/simple evaluation, separate CJS/ESM
entrypaths and the full backend catalog remain incomplete. No images, full
products, successor ABI or overall suites were built or run.

See [continuation-contracts.json](../tests/nodejs/upstream/continuation-contracts.json)
and [continuation-engine-check.json](../tests/nodejs/upstream/continuation-engine-check.json)
for exact coverage, retained failures, ownership limits and artifact identities.

## Native Buffer memory prerequisites

Revision 39 adds an engine-traced ArrayBuffer detach-key slot. Ordinary
transfer, storage extraction, JSAPI detachment and structured-clone transfer
reject protected storage. The native embedding detach entry checks actual
SameValue identity, realm wrapping, Wasm/asm.js restrictions and existing
length pins before invalidating the buffer and its views. Clearing a key
releases its strong reference. Ordinary properties, frozen objects and
serialization copies cannot forge or inherit that native state. Existing
data/length/flag slot offsets are unchanged; reserved-slot counts, inline
capacity and resizable-buffer metadata use the actual new layout.

Twenty-three memory controls pass on each of Node, Chromium, Firefox and
WebKit with identical engine and kernel bytes. Twelve shared observations
match the authenticated native Node reference through its original buffer
binding. Additional engine controls cover authorized detach, SameValue,
moving GC, key collection after clearing, foreign realms, native pinning,
ordinary JSAPI detach and three serialization scopes. These use privileged
engine controls; they do not execute a replacement native Buffer binding.
The same artifact passes the previous 492 selected engine observations,
including 32 expected fatal assertion exits, across 142 guest processes.
The new memory controls add 92 observations and four guest processes.

The complete original 76,513-byte node_buffer.cc has been authenticated and
reviewed, but is not yet imported or compiled. Its partial catalog records
37 functions, two constants, eight direct binding consumers and 100 literal
buffer/internal-buffer module references. Those references are a syntax
index, not complete lazy/conditional/worker reachability. In particular,
the original CallbackInfo retains an Environment and needs a genuine
cleanup queue, weak ArrayBuffer handle and thread-safe foreground dispatch.
At that checkpoint the frame-local codec Environment could not safely serve
that owner; the stable ownership foundation below addresses that prerequisite.
General Buffer allocation, stable alignment, principal-realm prototype,
copy semantics and additional native string/number/handle contracts remain
to be connected to the complete original source.

The initial build-list ordering failure and a pinning-test error expectation
are retained. SpiderMonkey's existing pinned-length error is RangeError;
the first test incorrectly expected TypeError. Final browser guest errors
are empty; separate run-owned Firefox Downloads/Library cleanup attempts
reported EACCES and their storage was retained. No user permissions changed.
Normal resolution reuses the tested revision-39 artifact. All 554 source
records and all 443 JavaScript sources remain byte-identical. Bootstrap
still stops at native buffer, with mksnapshot separately missing. Empty/simple
startup, CJS/ESM entrypaths and the full backend catalog remain incomplete.
No images, canonical products, successor-ABI builds or overall suites ran.

See [buffer-contracts.json](../tests/nodejs/upstream/buffer-contracts.json)
and [buffer-memory-engine-check.json](../tests/nodejs/upstream/buffer-memory-engine-check.json)
for contract coverage, exact artifacts, retained attempts and remaining work.


## Stable native Environment and foreground cleanup

Revision 40 moves the native codec Environment from temporary call frames into
one actual Isolate-bound runtime State. Frames borrow the same owner. The
registered context owner keeps its native address, canonical runtime and loop
alive until foreground shutdown. Existing native BaseObject construction
validates that owner. This supplies infrastructure for the original Buffer
allocation callbacks; the complete node_buffer.cc binding is still not compiled.

Weak Global<ArrayBuffer> handles use actual engine weak-zone callbacks. They
update moving pointers, return rooted values in the active realm and clear
unreachable buffers. A foreground registry retains native records while
background owners release their references, so those threads do not destroy
JS roots. Strong continuation handles remain actual PersistentRooted values.
Generic nursery-object weak semantics and the rest of the Global API remain
unproven.

The Environment owns a native cleanup queue and a move-only foreground work
queue. Producers post native data under a mutex and signal the real async
handle in the existing libuv loop. The foreground owns ref changes, callbacks
and checkpoints. Error recovery preserves the queued tail and re-arms real
async delivery on re-entry; an empty queue releases the handle reference.
Metadata accounting accumulates actual amounts without a State ownership
cycle and advises SpiderMonkey through Add/RemoveAssociatedMemory on the real
codec-state object. Existing external-string payload accounting stays with
the actual engine string allocation.

Every ShellContext calls the shutdown hook before unregistering context data.
Cleanup retires membership before callbacks, handles reentrant registrations,
drains native posts, closes admission and removes weak edges before context
destruction. The worker hook is installed, but worker/fork/cancellation
lifecycle is not validated. Full native callback/resource-ID/fatal policy,
independently owned delayed producers, OOM and native callbacks creating JS
exceptions during shutdown remain incomplete.

Fourteen ownership/weak-handle/queue controls plus three natural/quit/error
exit drivers pass on each host with identical engine/kernel bytes. They
exercise native producer threads, moving GC during background weak-handle
disposal, cumulative real allocation accounting, reentrant cleanup, caught
work errors, tail preservation and cleanup-time posts. All previous 584
selected observations also pass: 652 observations across 162 guest processes,
including 32 expected assertion traps. These are private embedding controls,
not a native Node differential or proof of the original CallbackInfo protocol.

Retained build failures cover an unrooted JSString argument and include
ordering. Final browser guest errors are empty; separate run-owned Firefox
Library cleanup EACCES warnings remain. An earlier run also retained storage
because its cleanup check still saw WebKit. Normal resolution reuses the tested
revision-40 artifact. All 554 source records and all 443 JavaScript sources
remain unchanged. No image, canonical product, successor ABI or overall suite
was built. Startup still fails on missing native buffer; mksnapshot, CJS/ESM
entrypaths and the complete backend catalog remain unfinished.

See [environment-contracts.json](../tests/nodejs/upstream/environment-contracts.json)
and [environment-engine-check.json](../tests/nodejs/upstream/environment-engine-check.json)
for the exact artifacts, controls, source contracts and retained limitations.


## Complete original native Buffer integration

Revision 41 imports and compiles all of `src/node_buffer.cc` unchanged. Its
37 functions and two constants are initialized by the original source.
Actual engine strings, numeric conversion, errors and escaped roots support
the original algorithms; encoding, search, fill, mask, swap and copy bodies
are not extracted or rewritten. Native function/signature metadata is retained,
while ordinary SpiderMonkey calls execute the original slow callbacks.
The original unnamed fast-method names are preserved. V8 fast JIT and native
snapshot serialization remain unavailable.

An engine-owned allocation reference keeps native byte spans alive while JS
coercion detaches or resizes their original buffer. It materializes inline
storage before exposing its actual address. Ownership follows same-size
transfers; reallocating transfers and raw clone/steal transports copy when
shared native ownership cannot be carried. Buffer methods use actual offsets,
lengths and aliases; both-shared copies use the engine's racy atomic memmove.
External ArrayBuffer bytes receive real engine cell credits. Transient native
leases and queued free callbacks still need a complete GC-pressure audit.

Original New/Copy/string/adoption overloads now install the actual principal
Realm prototype. The original principal-only setter assertion remains fatal.
Zero-fill reads the real parsed CLI option. This embedding builds live contexts
and has no snapshot builder; ordinary execution does not pretend to be building
one. Native empty views over detached backing support the original null-data
constructor, while the JavaScript typed-array constructor keeps its normal
rejection policy. Immutable ArrayBuffers are not an available engine kind.

The whole original CallbackInfo now owns the real weak backing, cleanup queue,
metadata credits and foreground post. Controls cover unreachable-backing GC,
asynchronous null-data free callbacks, detaching live buffers during cleanup,
and natural, quit and uncaught-error exits. A native addon built against the
authenticated exact-version headers confirms the corresponding native Node
null-data, GC and process cleanup behavior. Original internal/buffer.js and
its numeric/string prototype methods execute against this binding; original
ICU transcode also returns real native Buffers.

There are 44 controls plus five option/assertion/exit drivers per host, using
identical engine and kernel artifacts on Node, Chromium, Firefox and WebKit.
Thirty native observation groups compare exactly. The initializer-only setter
is compared separately because original node.js deletes it during bootstrap.
One further native observation is retained as a discrepancy: a standalone
Buffer.utf8Slice reproduction returned bytes different from its original input
after index coercion detached the backing and forced GC in all eight native
attempts. Kandelo's native allocation owner retains the original bytes.
This is a finding in the ported Node package, excluded from the host-runtime
workaround registry; no upstream source patch or external report was made.
See [the standalone reproduction](../tests/nodejs/upstream/buffer-native-reentry-repro.cjs)
and [its recorded result](../tests/nodejs/upstream/buffer-native-reentry-result.json).
The discrepancy is not counted as exact native agreement.

All prior selected controls also pass on the new artifact. The first browser
harness run failed only because it rejected the deliberate assertion console
message; final checks recognize that exact trap and retain every diagnostic.
Separate Firefox Downloads cleanup EACCES warnings remain in retained logs.
All 554 prior source records and 443 JS sources/10,993,403 bytes are unchanged;
adding the complete native Buffer file brings the authenticated inventory to
555 records. Normal package resolution reuses the tested revision-41 artifact.

Startup now passes the native Buffer lookup and stops at the actual missing
mksnapshot binding. Empty/simple upstream startup, CJS/ESM entrypaths and the
complete backend catalog remain unfinished. Full callback/fatal policy,
worker/fork/cancel/security/OOM, immutable/snapshot and nested guest Wasm paths
are not established. No full product/image, successor-ABI or overall suite ran.
See [buffer-contracts.json](../tests/nodejs/upstream/buffer-contracts.json) and
[buffer-engine-check.json](../tests/nodejs/upstream/buffer-engine-check.json)
for coverage, exact identities, retained failures and remaining obligations.


## Original AliasedBuffer and snapshot boundary

The complete original `src/aliased_buffer.h` and `src/aliased_buffer-inl.h`
are imported without edits. They supply native mapped state used by Node's
Environment and snapshot binding. The bridge allocates actual engine typed
arrays for all ten original classes and supplies move-only strong Global
handles, cleared weak handles and typed-array lengths. Before publishing a
weak edge, it promotes a nursery target while the real strong root remains
installed. Engine weak-zone callbacks update the edge through moving GC.
The original allocation, alias, copy, reserve and release bodies stay in the
original headers. Private controls require a valid live view before borrowed
native pointer access and reject detached backing. Those controls are test
admission checks, not a new public Node API or a general detached-pointer policy.

Revision 42 passes 21 selected controls plus five assertion/exit drivers on
Node, Chromium, Firefox and WebKit using identical engine/kernel bytes. Every
host exercises an actual nursery target becoming tenured, weak collection,
copy/growth/subview identity, all ten native element types and the original
alignment/bounds CHECKs. These are engine ownership controls, not a native
Node differential or full AliasedBuffer API audit. Exact identities, retained
failed attempts and regression evidence are in
[aliased-engine-check.json](../tests/nodejs/upstream/aliased-engine-check.json).

The one-byte state required by `mksnapshot` uses this original class. The
binding itself is still missing. Its complete C++ unit also contains V8 heap
serialization, code-cache generation, snapshot configuration parsing and
restoration of many native types. There is no actual snapshot builder or heap
graph traversal in this embedding. Their native API boundaries fail explicitly;
no creator instance, snapshot index, heap graph or restored object is fabricated.
No patch to `node_snapshotable.cc` or native function excerpt has been applied.

The reviewed contract inventory records seven binding exports, per-Realm state,
three strong callback slots owned by the principal Realm, compiler/preload
behavior and original JavaScript guards. Environment accessors forward to that
principal Realm. Its native setter requires the principal context for nonempty
assignment under the original debug assertion and accepts empty input to clear
storage; the binding methods separately enforce their fatal single-assignment
checks. The native adapter still needs that principal-versus-active context
distinction and the callback accessors. The existing runtime principal owner
and foreground shutdown are reuse foundations, not a complete implementation.
See the [ownership review](../tests/nodejs/upstream/mksnapshot-ownership.md) for
source locations, loop/teardown obligations and remaining four-host checks.
A fresh ordinary native Node reference, run with
`--no-node-snapshot`, passes eight controls. That flag matters: the first
reference invocation used the default embedded snapshot and aborted at the
original empty-deserialize-callback CHECK because restoration had already
populated the slot. The failed invocation is retained; it is a reference-state
mismatch, not a runtime defect. The reference runner checks the executable's
exact identity immediately before execution. This evidence does not validate
a Kandelo mksnapshot binding or V8 serialization.

A user decision remains pending between reviewed C++ feature guards preserving
original live-binding bodies, porting the entire snapshot unit and dependencies,
or explicitly allowing direct Kandelo-native contract implementations. Continue
independent required engine primitives while that choice is pending. Upstream
JavaScript and the no-excerpts/no-rewritten-algorithms constraint remain intact.
See [aliased-contracts.json](../tests/nodejs/upstream/aliased-contracts.json),
[mksnapshot-contracts.json](../tests/nodejs/upstream/mksnapshot-contracts.json)
and [the native reference](../tests/nodejs/upstream/mksnapshot-live-native-reference.json).

The selected prior controls pass on the same revision-42 artifact: 310 named
primitive cases, native tracing and agent controls, and four-host Buffer,
continuation, memory and Environment checks. The combined evidence covers 210
guest process drivers with 44 expected source assertion traps. The ordinary
package resolver reuses the exact tested artifact. Separate Firefox storage
cleanup EACCES warnings are retained without a cleanup guarantee. No full
product/image, successor-ABI or overall conformance suite was run.


## Native function-body compiler prerequisite

Revision 43 adds an underlying compiler for a complete runtime-provided UTF-16
function body with native-known C-string parameter and origin metadata. It uses
SpiderMonkey's actual CompileFunction in the current global lexical environment.
The existing unchanged builtin-source path shares that global-environment helper.
No caller frame or separate dependency environment is captured, and the public
Function constructor is not consulted. The engine owns the compiled source and
function; original input strings can be collected and closures retain live values.
The supplied body starts at diagnostic line one after the engine's own wrapper.

This is engine/compiler support required by the reviewed live snapshot APIs
under every pending native-source route. It does not implement the mksnapshot
binding, a V8 snapshot builder, a public node:vm replacement or the complete
V8 ScriptCompiler interface. Native formal-name metadata follows the engine's
Latin-1 C-string contract, with three known names in the diagnostic. Origin
metadata is a native UTF-8 C string; the private probe explicitly rejects NUL
and unpaired-surrogate filenames. Arbitrary V8 ScriptOrigin/UTF-16 argument-name,
context-extension/cache/security/deadline and module callback contracts remain
separate work. The JavaScript source body itself preserves every UTF-16 unit,
including NUL and unpaired-surrogate units inside literals.

All four hosts pass 25 focused controls and three job/exit drivers on identical
engine/kernel bytes. Twenty-one observation groups match the authenticated native
Node vm/contextify function compiler exactly. Tests exercise target intrinsics,
global lexical state, foreign parser exception identity and realm restoration,
source lifetime, live closures, full GC, strict/sloppy/new-target behavior and
actual Promise/await jobs. Existing selected binding controls also pass on the
new artifact. These are bounded engine controls, not full VM or startup acceptance.
Genuine bootstrap still fails on the missing mksnapshot binding, whose source
architecture question remains pending; no snapshot C++ import/patch or function
excerpt has been applied. Full products/images, successor ABI builds and overall
suites remain deferred. See
[function-compiler-contracts.json](../tests/nodejs/upstream/function-compiler-contracts.json)
and [function-compiler-engine-check.json](../tests/nodejs/upstream/function-compiler-engine-check.json).
