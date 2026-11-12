# Source graph and native binding survey

This is source evidence for the upstream runtime restart. It does not establish
startup, module compatibility, a complete native API catalog, or permission to
implement the broader backend roadmap.

## What is accounted for

| Evidence | Current result |
|---|---|
| Registered JavaScript sources | All 443 parsed and authenticated |
| Earlier loader/binding index | All 3,342 reference identities and all source hashes reconciled |
| Lazy helper registrations | 37, including one parameter-forwarding site |
| Transfer-deserialization metadata | 18 actual syntax sites; comments are excluded |
| Direct WebAssembly constructions/calls | 12, with surrounding source contexts |
| Concrete module edges | 2,739, including guarded/lazy/receiver paths |
| Literal native binding names | 72; every name has upstream initializer registration syntax |
| Upstream native source/header files scanned | 460 from the authenticated source archive |
| Native registration sites | 160 across four explicitly recognized macros |
| Registration names | 77: 73 initializer names and four external-reference-only names |
| Current Kandelo dispatcher routes | 17 of the 72 literal names; these remain bounded implementations |
| Literal names without a current dispatcher route | 55 |
| Historical evidence linked | All 19 family source-review records and 33 PR reuse records |

See [dependency-graph.json](dependency-graph.json),
[native-registration-index.json](native-registration-index.json), and
[backend-binding-survey.json](backend-binding-survey.json).

The extra initializer is `debug`. `binding`, `env_var`, `handle_wrap`, and
`process_object` have external-reference registrations without a loadable
binding initializer in this scan. Their implicit native/engine ownership
contracts still require review; do not treat these four names as missing
ordinary internalBinding exports.

A route in Kandelo's `InternalBinding` function establishes source dispatch,
not API completeness. A native library such as libuv can already be present
while the upstream Node binding named `uv` still lacks a route. The survey
checks the exact dispatcher bytes against the prior identified-artifact
receipt. It adds no guest runtime evidence.

## Paths that remain visible

Each site retains source coordinates, direct nested export-pattern paths, and
surrounding function, class-initializer, condition, loop and exception regions.
Both arms of a platform branch remain in the graph. Being inside a function
is syntax, not proof of lazy scheduling: immediately invoked functions exist.
Explicit lazy-property registrations and receiver-deserialization metadata
have separate phase labels. The latter does not prove that the receiving
Realm is initialized or that every native/user transfer producer was found.

CommonJS and ES-module loader sources have separate root records. Four cyclic
source components are retained; the largest has 279 sources because the graph
includes conditional and deferred dependencies. These are potential source
closures, not eager-load traces or an implementation order for native backends.

[dependency-dynamic-reviews.json](dependency-dynamic-reviews.json) records all
14 original computed sites plus the lazy-helper forwarding site. Five have
reviewed finite source domains; ten remain open or parameterized dispatches.
Generic loaders stay symbolic rather than creating unconditional edges to all
443 modules. Reporter maps include later conditional writes, including the
test runner's v8-serializer. The snapshot `supportedModules` set controls a
warning; it is not a filter and must not exclude dependencies from this graph.

Native registration parsing handles multiline macros, C++ comments and quoted
or raw strings, macro definitions and conditional preprocessor arms. It records
those arms without evaluating them. Build-file/GYP selection, generated/custom
registration mechanisms, aliases and actual target capability remain separate
reviews. Macro presence in an optional source file does not establish support.

## What is still required

Every native row keeps its API-contract status incomplete. Existing bounded
contract inventories are linked where available. The remaining audit must
cover classes/methods/symbols/shared state, signatures, errors/assertions,
callbacks and async context, GC and allocation ownership, resource lifecycle,
cancellation and liveness, security/OOM/reentrancy, actual owning layers,
prerequisites and identified-artifact validation on all four hosts.

The 19-family and PR audits describe the retired candidate and remain historical
source/salvage evidence. Their observation counts are not coverage denominators
for this implementation. Reuse native mechanisms only after matching the actual
original binding contracts; retain neither old public shims nor excerpt assembly.

Genuine startup still stops at `mksnapshot`. Its native-source architecture
choice is pending. Continue independent source review while preserving the
original JavaScript and the no-excerpts/no-rewritten-algorithms constraint.
After startup, reconcile the complete catalog and dependency-ordered validation
roadmap, then stop for user review before broader backend implementation.
Nested guest Wasm remains required and is implemented last unless startup needs
it. This graph does not convert that missing backend into a platform exclusion.

## Reproduction and checks

Run from the repository root through the declared development shell:

```sh
scripts/dev-shell.sh node scripts/index-nodejs-dependency-graph.mjs \
  third_party/nodejs/sources.json \
  tests/nodejs/upstream/dependency-dynamic-reviews.json \
  /path/to/dependency-graph.json
scripts/dev-shell.sh python3 scripts/index-nodejs-native-registrations.py \
  /path/to/node-v26.13.0.tar.gz third_party/nodejs/sources.json \
  /path/to/native-registration-index.json
scripts/dev-shell.sh python3 scripts/reconcile-nodejs-backend-survey.py \
  /path/to/backend-binding-survey.json
```

The native scanner verifies the entire archive checksum before reading sources.
The reconciler uses the canonical graph/index inputs and pinned local Git objects
for the historical audits. Native source files are indexed without importing or
compiling them. The graph/indexer controls test corrupted identities, missing
and computed targets, cycles, lazy/transfer/exception paths, separate CJS/ESM
roots, parser failures, conditional maps, multiline macros and false registrations
inside comments/literals. See [backend-graph-check.json](backend-graph-check.json).
No runtime code or package inputs changed; no package, image or conformance build
was run for this source-only phase.
