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

The native principal-body entry now calls complete `internal/bootstrap/node`
with protected state, passes native configuration and stops on missing
`constants` through original internal/util and validators, after executing the
original internal/async_hooks module through real shared async state and symbols.
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

`third_party/nodejs/sources.json` records 494 unchanged archive files:
427 library JavaScript files, 16 dependency JavaScript files, one library
support file, 37 dependency license files and thirteen provenance files. Its
443 builtin source records cover more than the public module list.
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
expectations against the exact pinned Node26.13.0 Darwin arm64 binary,
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
