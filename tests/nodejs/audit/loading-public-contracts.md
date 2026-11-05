# Module API and public loading contracts reconciliation

Source audit only. No new runtime execution, probes, compilation or builds.
The [full loading review](loading-contracts.md) now completes the family
source audit with implementation gaps. The following scoped public
requirements and deviations remain part of that exact-target review.

## Newly established CommonJS/interoperability findings

| ID | Requirement | Candidate source / implication |
|---|---|---|
| L-015 | require.cache may shadow a schemeless builtin; node: bypasses that cache | modules.md:898–927 explicitly demonstrates cache.fs. Bootstrap:6267–6271 returns the builtin before consulting _moduleCache. Adding require.cache.fs therefore cannot implement the documented shadowing |
| L-016 | CommonJS module records are instances of public Module, including cached JSON records | module.md:18 states the instance contract. Bootstrap:6350–6361 constructs a plain object, while JSON branches cache only {exports}. Loaded records have the wrong prototype/constructor, and JSON cached records omit ordinary module metadata. The exported constructor also presets filename to id, omits path and does not register the parent-child relation, unlike target cjs/loader.js:382–392 |
| L-017 | NODE_PATH and historic global folders remain valid fallback search paths | modules.md:728–759 defines them. _resolveFile:6201–6243 only walks local node_modules ancestors. It never consults NODE_PATH or global folders; having NODE_PATH in process.env is insufficient |
| L-018 | createRequire accepts valid file URLs/absolute paths and preserves directory bases | Target cjs/loader.js:2143–2200 handles trailing slash by appending a dummy filename before creating its module. Candidate:6118–6125,6264 normalizes/realpaths then takes dirname, so an existing /pkg/ directory base can move to / instead of /pkg. It also only recognizes file:// strings, rather than all valid file-URL string forms accepted by target URL parsing |
| L-019 | module.paths is actual module search state | Target cjs/loader.js:1035–1042 prepends parent.paths to fallback paths. Candidate exposes an array but resolves from a closed-over basedir without consulting it. Mutation of module.paths has no corresponding resolution effect |
| L-020 | Applicable access to unfinished circular CommonJS exports emits a warning | Target cjs/loader.js:1066–1130 temporarily uses a warning prototype for suitable plain exports. Candidate immediately returns cached exports at 6279 without the warning owner. Real partial-export cycle support therefore lacks this warning behavior |
| L-021 | File resolution/admission includes native .node modules | Target file-module algorithm includes .node. Candidate implicit extension/index lookup only tries JS/JSON; an exact ordinary .node path falls into source loading/compilation unless the separate Bun manifest explicitly marks it napi, in which case it throws. There is no ordinary Node addon admission path |
| L-022 | require.cache has the target cache object's prototype and tracks actual records | Target Module._cache is a null-prototype object (cjs/loader.js:395). Candidate _moduleCache and separate unused Module._cache are ordinary objects. Public cache prototype/metadata and the two cache owners differ |
| L-023 | require(esm) supports the target module.exports export override and default facade | Target cjs/loader.js:1794–1848 selects namespace['module.exports'] or builds a live __esModule default facade. Candidate:6342–6344 and native patch 0018 return the raw namespace unconditionally. This misses both interop contracts, separately from TLA/cycle admission findings L-012/L-013 |
| L-024 | ESM import of CJS discovers target export names and exposes the module.exports marker | Candidate _makeBareEsmSource:6559–6581 uses Object.keys plus ASCII/reserved-word filters. Target translators.js:208–280 preparses named exports, includes non-enumerable recognized names and a module.exports alias. Target fixture exports-cases.js/cjs-exports.mjs pins spaces/punctuation/Unicode/reserved names, a non-enumerable z and marker identity. Candidate excludes these names and has no marker binding |
| L-025 | Public Module constructor and prototype descriptors match the target | Target Module.prototype.constructor is a non-enumerable, non-configurable getter returning Module (cjs/loader.js:2286–2293); candidate leaves the default writable/configurable constructor value. Target Module(id = '', parent) has callable length 0, candidate Module(id, parent) has length 2. Missing isPreloading/parent prototype accessors are separate public-instance gaps |

L-018 concerns an existing directory successfully resolved by realpath;
it does not assume every nonexistent pathname loses its trailing slash.
L-020 follows the target's conditional warning path, not a requirement to
warn for all cycles or every object. L-021 separates missing admission
and correct errors from the concrete inability to execute CPU-native
ELF/Mach-O/PE as guest Wasm. Rebuilt Wasm/opaque Node-API support is a
different, still missing contract.

The candidate comment that reserved/invalid identifier keys match a safe
Node subset is not authoritative. The unchanged target fixture expressly
requires these names. No test or assertion has been changed to accommodate
the candidate's synthetic source strategy.

## Public node:module APIs with no candidate implementation

The final public Module assignments in bootstrap:6087–6159 provide
Module/Module, builtinModules, isBuiltin, createRequire and some legacy
helpers. The following methods/classes are absent. Their source audit is
negative implementation evidence, not a conclusion that an underlying
engine capability is impossible.

| API | Exact target requirement | Owner/prerequisites |
|---|---|---|
| findPackageJSON(specifier[, base]) | String/URL inputs; package-root JSON for bare specifier versus closest parent for relative/absolute; correct base and undefined result; currently uses the default resolver even when hooks exist (module.md:73–160) | Package reader, path/URL, resolver/error state |
| register(specifier[, parentURL][, options]) | Async hook module registration, parentURL/default data: base, cloneable initialize data and transfers; worker permission checks. Still exported but runtime-deprecated DEP0205 in Node 26 (179–226) | Actual hook worker/transport, loader chain, permissions and warning lifecycle |
| registerHooks(options) | Sync/in-thread resolve/load, chain protocol, actual registration lifetime; returned deregister and Symbol.dispose alias (227–255,655–1074) | Loader hook state, CJS/ESM/resolve integration, one deregistration owner |
| stripTypeScriptTypes(code[, options]) | Strip-only parser with mode strip and sourceUrl, reject syntax requiring transformation. Transform/sourceMap options were removed in 26.0.0 (256–320) | Actual parser/backend and errors; no Bun asset-loader substitution |
| syncBuiltinESMExports() | Synchronize existing builtin ESM named bindings with the CJS export object, without adding/removing names (321–359) | Real builtin namespace binding owner, not const snapshots |
| constants.compileCacheStatus | Actual FAILED/ENABLED/ALREADY_ENABLED/DISABLED statuses with correct frozen descriptors (454–508) | Shared compile-cache state and result definitions |
| enableCompileCache([options]) | Directory string or options; directory/env defaults, portable and Node 26.8 readOnly behavior; returns status/message/directory rather than throwing merely because cache enabling fails (509–574) | Real compiler-cache backend, files, per-instance state, portable/readonly policy |
| flushCompileCache() | Synchronously complete pending disk flush, silently tolerate cache write errors (575–592) | Actual pending compiler artifacts/files, shutdown order |
| getCompileCacheDir() | Return enabled directory or undefined (593–607) | Actual compile-cache state |
| findSourceMap(path) | Actual cached SourceMap or undefined for a resolved filename (1906–1920) | Loader/source-map cache ownership |
| getSourceMapsSupport() | Real enabled/nodeModules/generatedCode flags (1886–1905) | Engine stack/source-map policy state |
| setSourceMapsSupport(enabled[, options]) | Actual toggle with origin/generated-code scope; affects maps loaded subsequently (1921–1947) | Loader/source parser and stack mapping, state lifetime |
| SourceMap constructor/payload/lineLengths/findEntry/findOrigin | Parse/own Source Map v3 payload, optional line lengths, generated-to-original mapping and correct zero-based versus one-based coordinates (1948–end plus target class source) | Real VLQ/map data implementation; engine integration for stack consumers |

The native ModuleLoader and VM stencils are real foundations but do not
provide these absent APIs. A V8 cache byte format is distinct from portable
compile-cache behavior. A missing V8-specific representation must not
turn all compile-cache controls into an accepted exclusion. SourceMap's
public mapping operations also do not require V8-specific object types.

The current no-JIT nested-Wasm compiler restriction can affect a direct
port of Node's chosen TypeScript parser backend. It does not justify
claiming stripTypeScriptTypes exists, accepting unsupported syntax or
excluding every parser implementation. Target activation and concrete
backend limits must be described separately.

## Module object/require surface and applicability

Module.Module identity is present. builtinModules is an actually frozen
array derived from the candidate registry and policy; its omissions and
extra ws entry are tracked separately. isBuiltin and getBuiltinModule
therefore reflect candidate exposure, not the complete target surface.
They must not be independently marked fully conformant merely because
the helper source is pinned.

Public require, require.resolve/options/paths, require.cache/extensions/
main, module.children/exports/filename/id/isPreloading/loaded/parent/path/
paths/require and wrapper variables remain in scope. Existing plain
records and true source compilation cover portions of these contracts;
findings L-003–L-024 identify unresolved implementation. Underline-prefixed
Module internals discovered by the native snapshot retain separate
public-applicability questions rather than automatic inclusion/exclusion.

The captured _pathCache entry containing the inventory script's absolute
host filename is incidental reference state, not a required guest file
or a portable API value. Recursive alias descriptor rows are discovery
observations, not additional independent APIs.

## Four hosts, evidence and later validation

All findings concern guest JavaScript/native loader ownership shared by
Node, Chromium, Firefox and WebKit. Guest VFS/package/env state is the
input; embedding-host paths and native Node module caches do not fill
these gaps. No newly accepted host boundary applies to the portable
cache/metadata/namespace/hook behavior above.

Existing initial baseline failures often stop in common helper setup;
none establish this source candidate's module conformance. Later unchanged
upstream coverage should include test-require-cache, test-module-create-
require/multibyte, test-module-loading-globalpaths, test-module-circular-
dependency-warning, module-hooks and es-module suites, with the original
fixtures. test-esm-cjs-exports exercises the quoted/Unicode names above;
require-module-defined-esmodule and export-override fixtures pin the
reverse interop contract. Native controls must include failing compilation
then retry, builtins shadowed only without node:, directory/file URL
bases, altered module.paths, cache record/prototype identity, cycles,
TLA completion, hook deregistration and exact error/status behavior.

These are validation proposals only. The completed contract review covers every CLI option,
import metadata/attributes, namespace live bindings, format/JSON/BOM and
symlink branches, all module graph/cache failure paths, inherited members,
native-linking status and hook/source-map/cache narrative details.
