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
