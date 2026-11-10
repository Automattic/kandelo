# Upstream Node.js runtime restart

## Current state

The normal guest runtime still uses its existing compatibility bootstrap.
The selected SpiderMonkey package now executes the complete, unchanged
upstream primordials, DOMException and messageport context initializers through
privileged diagnostic controls on the Node host. A native runtime owner shares
the original symbol inventory across fresh per-global state. The upstream realm
loader and Node bootstrap are not connected; startup, CJS/ESM entrypaths and
browser execution remain unrun. This prerequisite does not establish module
compatibility or guest readback of all 443 builtin sources.

The target remains Node.js 26.13.0, Lithium LTS, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. Verification on November 10,
2026 found no target drift: the official release index, release tag and
source/native archive checksums agree. The retained source tree's 38,413
regular files match the verified archive. The Darwin arm64 reference
executable matches SHA-256
`533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4`;
it was not executed for this work. Other native reference contents were not
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

`third_party/nodejs/sources.json` records 493 unchanged archive files:
427 library JavaScript files, 16 dependency JavaScript files, one library
support file, 37 dependency license files and twelve provenance files. Its
443 builtin source records cover more than the public module list.
The original `src/env_properties.h` now supplies the native symbol inventory;
its bytes are verified before staging into Mozilla's source tree.

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
package builds; upstream realm/bootstrap integration remains unimplemented.

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
