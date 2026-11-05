# Module loading source audit

State: **source review complete with implementation gaps**, together with
the [full contract review](loading-contracts.md), requirement/CLI crosswalk
and native source evidence. This review covers final builtin/CommonJS/ES-module
routes, package resolution, public module APIs and CLI activation. It is
source evidence only; no runtime tests or builds were run.

## Actual owners

The public Module function is installed at bootstrap:6087–6159. Builtin
policy/getBuiltinModule use the final registry and pinned policy excerpts.
File/package resolution is custom JavaScript at 6168–6243, followed by
the process-wide CommonJS cache/loader at 6249–6408. ESM entry detection
and metadata/synthetic namespaces are at 6410–6434 and 6538–6667.

CommonJS compilation uses the native evalScriptAsFunction binding so
scripts carry actual source filenames. ESM linking/evaluation uses the
SpiderMonkey ModuleLoader, including patches 0015/0016/0018/0019 and later
URL/exit-contract changes. This is real compilation and module state,
not string evaluation disguised as imports. The remaining defects below
are not eliminated by having that real backend.

The public module class differs from loaded module records: the loader
constructs plain objects, with a separate cache. Module._cache/_extensions
exist separately. Their undocumented internals require applicability
review; public require.cache, require.extensions and module metadata
remain in scope regardless of that private-interface decision.

## Concrete findings

L-001/L-002 in the family survey cover absent builtin entries and ws being
registered as a builtin outside the pinned Node discovery set. The latter
belongs to the preserved Claude/npm/Bun remainder; this audit changes none
of that implementation.

| ID | Public requirement | Source observation | Owning prerequisites |
|---|---|---|---|
| L-003 | Package exports/imports, conditions and self references | Resolver walks node_modules and reads package.main/index only. No exports/imports map, condition matching, subpath encapsulation or # imports implementation is present | Shared package resolver for require/import/resolve, URL and exact errors |
| L-004 | Package configuration errors | _resolvePackageMain and _nearestPackageType catch parse/read failures and fall back. Invalid package JSON is not reported through Node's package configuration error path | Package-reader validation, error identity and resolution precedence |
| L-005 | module.createRequire validation/base handling | Accepts arbitrary objects with href and relative/nonvalidated strings; documents require a file URL or absolute filename. Delegates to _makeRequire without the public contract validation | URL brands, path policy and exact argument/error handling |
| L-006 | require.resolve options/paths and extension hooks | resolve ignores its second options argument; resolve.paths and require.extensions are not attached. Separate null Module._extensions slots do not implement require's extension API | Shared resolver options/search paths, actual extension handlers |
| L-007 | Failed CommonJS compilation and cache cleanup | Module is cached before evalScriptAsFunction compiles; compilation is outside the try that deletes cache on wrapper execution failure. A syntax error can leave a cached incomplete module | Correct cache transaction spanning compile and execution |
| L-008 | Public module graph and metadata | Loaded records have children arrays but no parent/path/isPreloading fields or parent-child graph update in the inspected load path | Actual module ownership and graph bookkeeping, main/require identity |
| L-009 | Public hooks/source-map/cache/package APIs | register/registerHooks, findPackageJSON, compile-cache APIs/constants, SourceMap helpers, get/setSourceMapsSupport and syncBuiltinESMExports are absent | Actual loader hooks and lifecycle, cache format, package reader and stack/source-map integration |
| L-010 | TypeScript support | No stripTypeScriptTypes or general type-stripping stage in ordinary file loading. Node 26 documents default erasable syntax stripping; Bun asset metadata is not that implementation | Real parser/backend, format/extension rules and feature availability |
| L-011 | ESM classification/namespace/identity | Entry syntax detection uses a regular expression; builtin/CJS named exports snapshot enumerable Object.keys values. Native lexical-path and JS realpath caches use different identity policies | Parser-based format classification, builtin export synchronization, symlink/URL/cache policy |
| L-012 | require(esm) cycle rejection | Native patch 0018 returns a partial namespace for an Evaluating module. Pinned Node's ESM loader explicitly throws ERR_REQUIRE_CYCLE_MODULE for this state | Node loader admission rules; reconcile engine-linking changes made for this assumption |
| L-013 | require(esm) async-graph admission | Native bridge decides from evaluation Promise state. Pinned loader checks throwIfAsyncGraph before returning an already evaluated namespace, so an already completed TLA graph is still rejected | Actual static module graph async metadata and cache/error ordering |
| L-014 | CLI/NODE_OPTIONS and activation | Native option bridge recognizes warnings, stream iterators, version/eval handling, then retains shell parser behavior for remaining CLI. NODE_OPTIONS accepts only its small recognized subset | Public Node CLI parsing/validation, preload/hooks/test/bench/inspector/TS activation |

Source references: L-003/L-004 bootstrap:6180–6243,6410–6424;
L-005:6118–6125; L-006:6126–6131,6387–6406;
L-007/L-008:6350–6384; L-009 final Module assignments:6087–6159;
L-010 file-load path:6285–6384; L-011:6430–6434,6559–6581 and
native ModuleLoader patches; L-014 native js.cpp:10838–10935 and
public getOptionValue callback at bootstrap:6104–6106.

L-012/L-013 are direct target-source comparisons, not assertions based
on the candidate patch comments. In pinned
`lib/internal/modules/esm/loader.js`:290–335, a cached graph is checked
for asynchronicity and an Evaluating module is rejected as a require
cycle. `0018-kandelo-require-module.patch` instead returns its namespace
for Evaluating and only rejects a pending evaluation Promise.

Patch 0019 also relaxes the engine linker to accept Evaluating modules.
Its compatibility rationale must be re-audited against Node's actual
cycle rejection rather than assumed correct from the patch comment.
This audit makes no change to either patch.

## Exposure, formats and preserved extensions

The shared builtin policy correctly has a separate place for scheme-only
and option-gated names, but it starts from candidate registry keys. A
policy table naming a module does not create its implementation. Metadata
queries, actual loading, CJS and ESM exports must be reviewed separately.

The source includes real CommonJS circular-cache behavior, real ESM
namespaces and propagation of CommonJS execution failures. Those are
useful foundations, not complete cycle/format/error conformance. JSON
parsing, module compilation and execution also have distinct cache-failure
paths and must not be conflated.

The preserved Bun asset-loader dispatch runs before ordinary format
selection. It is an explicit product extension; it does not implement
Node package conditions, import attributes, TypeScript or native addons.
Ordinary .node admission and its actual addon ABI belong in the separate
native-integration audit. No extension/remainder code was changed here.

Import metadata currently adds url/dirname/require through a native hook;
the underlying shell also installs its resolver. Node's filename/main,
resolve URL semantics, descriptors, schemes and option/entry behavior
still need complete source reconciliation. Do not infer all metadata
from the helper's three returned fields or assume shell defaults are
Node-compatible.

## Four-host and remaining review

[Public loading-contract reconciliation](loading-public-contracts.md)
adds source-backed L-015–L-024, exact missing node:module requirements and
unchanged fixture evidence for non-ASCII/quoted CJS export names. The
full [loading contract review](loading-contracts.md) completes the source
reconciliation with remaining target/reference questions. These are not
runtime test results.

All four hosts execute the same guest loader. The relevant file state is
the guest VFS, not the embedding host's filesystem. Host Node's native
resolver/package cache does not fill missing guest behavior.

The completed source review covers every module/modules/ESM/packages/TypeScript/CLI obligation,
including legacy exposed APIs, aliases/descriptors, CJS module graph,
package errors, import attributes, supported schemes, preload and hook
chaining, async modules, loader cache lifetime, source maps and real
compile-cache activation. Module provenance, contexts/realms and shutdown
must retain actual owning resources. Exact native controls and current
four-host runtime conformance remain unestablished.

Proposed later unchanged cases include the pinned es-module
require-cycle cases, `test-require-module-cached-tla.js`, parallel
`test-require-cache.js` and relevant package exports/imports, hooks,
TypeScript and source-map cases. The es-module category and nested
fixtures must be reviewed in addition to parallel/sequential.

Native controls should compare invalid-package errors, require/createRequire
input validation, compile failure followed by re-require, cache/module graph
identity, actual package-map resolution, aliases/symlinks, builtin export
synchronization, cycle and cached-TLA rejection, hook/preload ordering and
type-stripping/error behavior. None has been newly executed here.
