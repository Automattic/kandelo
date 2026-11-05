# Public module, package, ESM and CLI contracts

State: **source review complete with implementation gaps**, covering the
public `node:module` constructor/namespace, CommonJS module/require owners,
ESM, packages, TypeScript and CLI/environment activation narratives. The
[earlier layer trace](loading.md) and
[public reconciliation](loading-public-contracts.md) remain part of this
review. No runtime test, probe, compilation, package build or product
rebuild ran.

`loading-requirements.json` preserves all **539** original obligations:
459 documentation sections and 80 descriptor observations, including a
captured incidental cache key and repeated alias observation. These are
not unique public APIs. Gated APIs, returned hook owners, per-module
objects and CLI consumers extend the capture. An incidental absolute
reference-script cache entry remains explicitly outside the public value
contract; no failure or unsupported test is relabeled as passing.

## Source identities and actual loading path

The unchanged target is Node 26.13.0, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; the official/source/native pin
review is in [target-pins.md](target-pins.md).

Candidate `bootstrap.js:6087–6434,6460–6670` implements the public Module
facade, final builtin policy, custom package/file resolver, CommonJS
wrapper/cache and ESM bridge. Native `js.cpp:10796–10935,15723–15825,
16504–16556,16704–16743,17490–17522` owns Node-prefix option parsing,
adapter inputs and the remaining SpiderMonkey shell parser. The native
VM/loader and VFS bridges supply real source compilation, module graph,
jobs, source paths and file I/O; outer host Node resolution is not used.

The existing SpiderMonkey archive SHA-256
`1b034d2117356fda24807a151055132315c6ba58ad2bdf7ec71ee707fac5e028`
was read and its complete checksum rechecked without extraction or
execution. `loading-native-source-evidence.json` records the original
ModuleLoader.cpp/.h member hashes and selected source ranges. The
candidate loader is this base **plus** patches 0015/0016/0018/0019/0030/
0031; build-spidermonkey.sh:202 applies patches in order. This is a source
composition review, not a new generated tree, proof of patch applicability,
compiled artifact or four-host runtime result.

Patch 0030 routes relative/absolute imports through the JS format bridge
as well as bare imports, and adds a **resolve-only** import.meta.resolve
path. Resolving an existing CommonJS dependency therefore need not execute
it in this candidate; do not resurrect the older side-effect finding.
Patch 0031 supplies actual source URL/line origins. These positive changes
do not supply URL identity, complete format admission or Node metadata.

## Public owners and existing findings

`node:module` exports the actual Module function with its own members;
Module.Module is the same function. Loaded CommonJS modules must be
instances with the Module prototype, not just matching dictionaries.
`require`, `require.resolve/cache/extensions/main`, module instance fields,
wrapper variables, import.meta and CLI are **returned/language/runtime
surfaces**, not extra own exports on the Module function. Earlier grouped
matrix labels are retained and linked to those actual owners.

L-001–L-025 remain source-backed in the earlier reports:

- The builtin policy operates on incomplete candidate registry keys,
  including the preserved extra ws extension. Scheme-only and gated
  metadata, actual CJS/ESM loading, aliases and getBuiltinModule are distinct
  contracts. Frozen builtinModules alone is insufficient.
- Package main/index lookup lacks exports/imports/conditions/self-reference,
  proper configuration errors, global paths and mutable module.paths
  effects. URL/absolute/directory createRequire bases and require.resolve
  search options differ.
- Actual records/cache/parent-child graph/prototypes/preloading/extension
  hooks are incomplete. CommonJS compile failure occurs outside the cache
  rollback try; circular exports have no target warning owner.
- require(esm) lacks target cycle/static async-graph admission and
  module.exports/default facade. CJS ESM export discovery excludes quoted,
  Unicode/reserved and recognized non-enumerable names, and the
  module.exports marker. Builtin named exports are constant snapshots,
  without syncBuiltinESMExports.
- Hooks, SourceMap support, compile-cache state/files/activation, ordinary
  addon admission and TypeScript stripping are missing. Public Module
  constructor/instance descriptors differ from exact target source.

Target files `lib/module.js`, internal/modules/cjs/loader.js,
helpers.js, package_json_reader.js, esm/{loader,resolve,load,translators,
assert,get_format,utils}.js, customization_hooks.js and source_map files
define the actual callable/prototype/descriptor/overload/error/async owners.
Finding their names in a policy table does not instantiate them.

## Additional concrete findings

| ID | Requirement and candidate source conclusion |
|---|---|
| L-026 | The CommonJS wrapper must be called with initial exports as `this`, including strict module code. Target cjs/loader.js:1958–1968 uses FunctionPrototypeCall with thisValue=exports. Candidate bootstrap:6378 calls wrappedFn as a plain function. The wrapper's arguments are real, but its receiver differs. Source/error locations and wrapper function properties remain separate requirements. |
| L-027 | Target JSON uses stripBOM and decorates parse errors with filename (cjs/loader.js:2116–2126). Candidate bootstrap:6319–6323 directly JSON.parses source and caches only {exports}. ESM JSON additionally requires mandatory type:json, default-only namespace and shared CJS object/cache identity. Native base ModuleLoader.cpp:439–499 has separate JS/JSON compilation, but the candidate bridge can replace file source with generated JS namespace source; it does not supply target attribute/default/cache policy. The shell import-attributes switch defaults off (`js.cpp:17502–17507`), without Node-default activation. Exact enabled JSON branch outcomes require later controls; no parsing outcome was executed here. |
| L-028 | import.meta.filename/main are absent; dirname/url are eager copied enumerable properties and require is an extra Bun extension (`bootstrap:6650–6670`, patch0016). Target src/module_wrap.cc:1320–1384 creates file-only lazy dirname/filename, actual entry main, lazy scoped resolve and actual URL. Resolve-only prevents CJS evaluation, but target missing-file file: URLs, optional parentURL flag, hook restrictions, encoded URLs and correct result/error/descriptor semantics remain incomplete. |
| L-029 | ESM must resolve/cache by URLs, preserve query/fragment instance distinctions, file encoding and supported file:/node:/data: schemes, reject directory/extension errors correctly and keep CJS extension search distinct. JS _resolveFile uses extension/main/index probing for imports; native normalizePath uses filesystem components, not full Node URL semantics. Native javascript: source imports remain an extra shell feature, whereas Node's default loader rejects that scheme. Default arbitrary https: imports are **not** a Node requirement without custom hooks. |
| L-030 | Node 26 experimental package maps have no candidate option/config/parser/resolver/cache route. Target packages.md:950–1135 describes static file-URL packages/dependencies and package identity, while internal/modules/package_map.js:124–132 explicitly rejects duplicate URLs despite the documentation promising support. The implementation is missing either way; exact duplicate-URL behavior remains a target question, not an excuse to guess one side or change the pin. |
| L-031 | Prefix CLI handling only consumes warning/stream booleans, version and eval; the first other argument hands the entire tail to the shell parser (`js.cpp:10838–10935`). Shell -p means prelude, not Node --print; --help describes the shell. Shell -c sets compileOnly, but RunKandeloNodeBootstrap executes a file before returning (`15819–15825`) without guarding compileOnly, so it is not Node check-only behavior. --check is not that shell alias. Eval is a real shell execution path, but Node input-type/stdin/syntax/TS/print/preload/options precedence/exit/REPL behavior is not thereby implemented. |
| L-032 | Most documented Node options/env consumers are missing or disconnected. NODE_OPTIONS only accepts the two recognized boolean families, not Node's allowlist/config/preload semantics; execArgv captures only consumed prefix arguments. The builtin getOptionValue bridge only exposes experimental-stream-iter (`bootstrap:6104–6106`). Other gated modules, permissions, test/bench, proxy/TLS/DNS, loader/VM, diagnostic/profile/coverage/cache/watch/run/VFS/SEA controls need real owning consumers. A shell flag with the same spelling is not equivalent. |
| L-033 | Missing public hooks/cache/source-map APIs require real lifetimes, not detached helper results. registerHooks returns a frozen ModuleHooks with deregister and identical Symbol.dispose alias (`customization_hooks.js:67–104`), mutating actual resolve/load chains and enforcing next/shortCircuit/result contracts. SourceMap clones payload and lineLengths while retaining actual decoded mappings (`source_map.js:126–244`); real source-map cache/stack integration must follow generated/builtin/URL/VFS module lifetime. Compile-cache status/portable/readOnly/files/flush/exit/worker activation must derive actual compiler/cache ownership. |

Package configuration validation, failed read/stat/realpath errors,
requireStack, syntax/TLA/cycle errors, module namespace descriptors and
error phase must use the actual owning path. Native syntax errors or a
generic MODULE_NOT_FOUND string are not every target error. Genuine
CommonJS cycles, real ESM evaluation/Promise jobs and cross-module thrown
values remain positive foundations with incomplete semantics.

## CLI, environment and cross-family ownership

`loading-requirements.json` includes a section-by-section CLI consumer
crosswalk with full target requirements, candidate parser/consumer paths,
shared owners, admission limits and pending controls. It preserves all 265
CLI sections, including narrative and repeated V8-option references; it
does not count them as independent callable APIs.

The warning booleans and stream-iterator activation have actual native
state and JS consumers, and version prints the candidate macro. Eval maps
to actual shell execution. These are partial source paths, not runtime
signoff for every alias, negation, =suffix, ordering, NODE_OPTIONS override,
argument boundary or warning behavior. Existing warning and iterable-source
reviews remain dependencies. Raw shell -i/-m/-f/-c/-p and options are not
the full Node REPL/module/check/print CLI. `--`, `-`, no entry, -e/-p,
preloads, run/test/bench/inspect/watch, configuration/env files and process
exit need their actual Node entry/owner semantics.

Environment visibility needs distinct read/enumeration/mutation review:
bootstrap:1386–1398 seeds process.env from a limited fixed key list, but its
Proxy getter at 1402–1413 queries std.getenv for unseeded keys. Adapter.js:
269–272 forwards shellOs.getenv when available. Thus the fixed list does
not prove NODE_NO_WARNINGS unreadable by the actual check at 1625. Own-key
enumeration is still incomplete, and adapter setenv/unsetenv at 274–284 are
no-ops; deletion can expose an unchanged native value again. Native reads,
mutation, enumeration and child inheritance are separate requirements.
NODE_DEBUG has a real debuglog consumer. See DOC-010's corrected trace. Environment data, warning/color/REPL, TLS roots/proxy, ICU/timezone,
thread-pool and profiler/cache variables require distinct owning paths.
Do **not** report every environment feature wholly absent: native
SSL_CTX_set_default_verify_paths (`js.cpp:2385`) can consult guest OpenSSL
trust defaults, and libc/engine can consume native environment directly.
Those paths are not proof of Node-specific extra/system CA, process.env
mutation, precedence, initialization or metadata. Thread-pool/V8 flags and
native instrumentation need field/engine applicability decisions, not fake
libuv/V8 state or a spoofed process.platform.

TypeScript is stripping only in this pin: no type-checking, tsconfig paths
or transformation-required syntax is required by Node's builtin path.
stripTypeScriptTypes, .ts/.mts/.cts format selection, dependency restrictions,
non-file input and exact errors still need real owners. The pinned parser
uses Wasm and docs define ERR_WEBASSEMBLY_NOT_SUPPORTED when unavailable;
the current no-JIT guest engine restriction is separately source-backed in
[engine-contracts.md](engine-contracts.md). That does not justify generic
SyntaxError, silent string rewriting or pretending all JS loading is
unsupported. mode/sourceMap removal prose versus source accepting false/
undefined sourceMap remains an exact native-control question.

## Hosts, boundaries and evidence

All four hosts execute the same guest bootstrap/SpiderMonkey loader and
read **guest VFS** state through std/os native file bridges, libc and kernel
open/stat/realpath/read ownership. The browser or host Node filesystem,
package manager, loader cache or debugger is not an implementation. Actual
package mount/permissions/symlink/case/descriptor state, URL/path decoding,
source bytes and worker process environments are inputs to later controls.

Portable module metadata, package/hook/cache semantics, source maps, CLI
entry modes and URL/JSON/text behavior are implementation gaps on every
host. CPU-native .node binaries versus guest Wasm/Node-API and V8 cache
formats have concrete separate boundaries; native-integration/engine
reports retain the missing portable bridges. Browser external raw network
restrictions affect a custom remote loader/inspector transport, not local
module or package resolution. No engine bug or current host-specific
loader outcome is established by this source review.

[Existing evidence](existing-evidence.md) retains exact artifacts/statuses.
Most historical baseline failures stop at a common net helper prerequisite,
not a loader assertion. Earlier selected URL/exit or module controls apply
only to their recorded source/artifacts, and the Firefox exit fixture
timeout remains unresolved. The current source candidate is unbuilt and
has **no current four-host loading conformance**.

## Open questions and later validation

- Target package-map duplicate URL documentation/source conflict must be
  resolved with unchanged/native controls before later implementation.
- Exact Node input-type/detection fallback, code coercion/CLI duplicate and
  option ordering, NODE_OPTIONS/config/env precedence, exit/error phases
  and full feature activation need controls of actual native entry points.
- Preserve stripTypeScriptTypes sourceMap/mode edge and hook legacy
  validation differences rather than substitute older Node behavior.
- Native ModuleLoader base and patches are source evidence; patch
  composition/applicability, actual attributes/JSON support and compiled
  engine configuration still need validation after authorization.
- Legacy underscore helpers/source-exposed mapping symbols have specific
  discoverability and private ABI questions. The captured inventory
  script's absolute cache entry is incidental, not a required guest path.
- Module/namespace/cache/GC/async hook worker retirement, symlink/URL/package
  identity and VFS source-map invalidation need actual resource controls;
  no leak or successful cleanup is invented from source alone.

The unchanged-source catalog includes es-module, module-hook/loader,
package-map/exports/imports, TypeScript, CLI/env/config, source-map/cache,
addon and relevant worker/VM fixtures beyond parallel/sequential. It is a
selection aid, not an executable/assertion/subtest/variant denominator or
complete fixture closure. Later exact native comparisons must include
cache compile failure and retry, wrapper this/strictness, BOM/JSON/text
attributes/cache identity, symlink/query/URL/package IDs, quoted export
names, require(esm) cycles/static TLA/interop, loader chains/deregistration,
source-map and cache file ownership, stdin/check/eval/print/REPL/preloads,
worker inheritance and all activated CLI/environment controls. Preserve
failures/skips/unsupported/timeouts/harness errors separately.

The audit does not authorize these controls or implementation. Finish the
remaining broad family audits, present the roadmap/questions, and stop for
explicit authorization before either proceeds.
