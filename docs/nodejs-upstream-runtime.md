# Upstream Node.js runtime restart

## Current state

This is an inactive source import for the planned SpiderMonkey guest
runtime. The prior runtime still uses its existing compatibility bootstrap.
The new library has not been activated, compiled into the guest engine or
executed on any host. No compatibility claim follows from this import.

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

`third_party/nodejs/sources.json` records 492 unchanged archive files:
427 library JavaScript files, 16 dependency JavaScript files, one library
support file, 37 dependency license files and eleven provenance files. Its
443 builtin source records cover more than the public module list.

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

Startup does not establish module compatibility. No new guest engine or
runtime artifact has been built or run for this import. Full product and
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

The source import is still inactive. An immutable native source registry and
build-time wrapper metadata producer now exist, along with a SpiderMonkey
function/module compilation consumer. The registry and metadata were compiled
and checked on the development host. The SpiderMonkey consumer has not been
compiled against the guest engine, linked, or executed. No upstream bootstrap
has run on any of the four hosts.

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
roots. Package revision 16 invalidates earlier engine builds. This does not
activate upstream Node or turn an older engine artifact into evidence for the
new code. No actual engine translation unit or guest package was compiled.

The focused preparation check ran the actual recipe helper, built the host-only
original-Node metadata producer using the declared SDK, verified all four staged
C++/header copies and generated the 443-source include. Shell/TOML/Python syntax
checks passed. The new Mozilla patch applied without fuzz against the exact
verified source archive's moz.build; no earlier main patch modifies that file.
Exact identities and scope are in `engine-build-wiring-check.json`.

The next actual-header check requires a clean-branch checkout, normal wasm32
SDK-core provisioning and Mozilla configure/export generation, followed by the
selected native objects or SpiderMonkey package build. A full product rebuild
is not required for that check and remains deferred. Existing cached Wasm files
contain neither the new source nor usable generated headers.

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
hidden-key behavior is runtime-validated yet.

A subsequent focused native control confirmed eleven covered hidden-key
expectations against the exact pinned Node26.13.0 Darwin arm64 binary,
including both public untransferable-marker cases. Its flags/hash/outcomes and
coverage limits are in `private-key-native-reference.json`; the unchanged
control source is `private-key-native-controls.cjs`. These are reference
results only. No guest engine, browser host or current-candidate startup was
run, and the missing private-key implementation is not counted as supported.
