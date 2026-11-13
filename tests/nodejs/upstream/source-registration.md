# Upstream Node source-registration review

Static audit of the pinned Node.js 26.13.0 source archive. No runtime probes, tests, builds, generation of runtime code, tracked edits, or Git mutations. Full file/ID/kind/SHA-256 manifest is in `source-registration.json`.

The inherited verification record identifies official source archive `https://nodejs.org/dist/v26.13.0/node-v26.13.0.tar.gz`, SHA-256 `986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191`, commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`, source tree hash `4fb0c4ebc1b7e3fdbc52049159f64c4ce1c0953a70895c37c95ab10ebea091d5`. This subtask reads that record; it does not freshly reverify official signature/archive/tree hashes or authorize a target change.

## Complete default upstream registration input

**Copying only `lib/` is insufficient.** The default Node build registers 443 JS/MJS source files: 427 library files, 14 explicitly named dependency files, and 2 default shareable bundles. All 443 appear in the cached source tarball index. `config.gypi` is a separate generated required input and is absent as expected.

| Group | Files | Selection / source anchor |
|---|---:|---|
| Whole `lib/` | 427 `.js` | Configure dependency list `configure.py:1895-1896`, `tools/utils.py:115-119`. Actual `node_js2c` invocation passes directory `lib`, **not just that dependency list**: `node.gyp:1062-1092`. `tools/js2c.cc:80-130,909-953` recursively scans both `.js` and `.mjs`, explicitly removes `lib/eslint.config_partial.mjs`, sorts extensions separately. This pin has no included library `.mjs`. |
| V8 tool modules | 11 `.mjs` | `node.gyp:67-77`: `splaytree`, `codemap`, `consarray`, `csvparser`, `profile`, `profile_view`, `logreader`, `arguments`, `tickprocessor`, `sourcemap`, `tickprocessor-driver`, all under `deps/v8/tools/`. |
| Acorn | 2 `.js` | `node.gyp:78-79`: `deps/acorn/acorn/dist/acorn.js`, `deps/acorn/acorn-walk/dist/walk.js`. |
| Minimatch | 1 `.js` | `node.gyp:80`: `deps/minimatch/index.js`. |
| Shareable defaults | 2 `.js` | `configure.py:61-63,2995-3006`: `deps/undici/undici.js`, `deps/amaro/dist/index.js`. |
| Optional linked modules | 0 by default | `configure.py:243-249,2169-2170`; `node.gyp:55-64`. Explicit extra inputs must have separate provenance. |
| Generated configuration | 1 nonmodule resource | `configure.py:3045-3047` emits `config.gypi`; `node.gyp:1068,1088` requires it. |

The resulting kinds are 406 `kFunction`, 11 `kSourceTextModule`, 8 `kBootstrapScript`, 1 `kBootstrapRealm`, 14 `kMainScript`, 3 `kPerContextScript`. These counts describe registration, **not public API support**.

## ID, compilation and bootstrap contract

`tools/js2c.cc:328-351` maps `lib/internal/url.js` to `internal/url`, `deps/acorn/acorn/dist/acorn.js` to `internal/deps/acorn/acorn/dist/acorn`, strips `.js`/`.mjs`, and otherwise retains a linked source's path. C++ storage variable names replacing punctuation are not module IDs. `node:` is not in these registry keys; `src/node_builtins.cc:341-408` compiles with origin `node:<id>`.

`src/builtin_info.cc:7-29` assigns source kinds by extension and ID; `src/builtin_info.h:18-58` defines distinct function argument contracts:

| Kind | Arguments / compilation |
|---|---|
| Bootstrap realm | `process, getLinkedBinding, getInternalBinding, primordials` |
| Bootstrap / main scripts | `process, require, internalBinding, primordials` |
| Per-context script | `exports, primordials, privateSymbols, perIsolateSymbols` |
| Ordinary builtin | `exports, require, module, process, internalBinding, primordials` |
| Source-text module | Native ES module compilation/linking, no CommonJS wrapper |

`js2c` stores original bodies; wrapper arguments enter at the native engine's CompileFunction stage. Whole upstream `internal/bootstrap/realm.js` owns private binding loaders, builtin module caching, dependency fallback, module identity and public/prefix-only/experimental policy. `realm.js:434-440,474-482` selects dependency fallback require. Whole upstream `internal/modules/cjs/loader.js` and `internal/modules/esm/*` own user-module loading; a source registry is not a replacement for these loaders. `src/node_realm.cc:196,329-353` records realm/node/bootstrap-switch sequencing. Preserve source-body line accounting, private capability boundaries and per-realm ownership.

## What is generated or conditional

* `node_javascript.cc` is a generated C++ byte/source table and registry (`tools/js2c.cc:174-208`, `node.gyp:1080-1092`), not an independently authored JavaScript compatibility implementation. Kandelo can provide an equivalent immutable source registry instead of compiling V8-specific storage code.
* `js2c` encodes text as ASCII/Latin-1/UTF-16. It has **one source-text normalization exception**: Undici's U+2019 becomes ASCII apostrophe on the non-Latin-1 path (`tools/js2c.cc:594-669`). Decide whether the restart preserves literal source bytes or exact upstream embedding output; these are different identities. Otherwise this inspected generator does not perform AST transforms, minification, import rewriting or algorithm extraction.
* `config.gypi` is generated JSON plus a header; `js2c` strips `#` comments and converts exact quoted `"true"` / `"false"` to JSON booleans (`tools/js2c.cc:741-812`). `lib/internal/bootstrap/node.js:132-146` reads and freezes it as `process.config`. Distinct `internalBinding('config')` metadata comes from `src/node_config.cc:34-109`.
* Most build feature flags leave `lib/` sources registered. `node.gypi:152-174,402-469` changes native features; `src/node_builtins.cc:115-199` and `realm.js:181-243` gate module availability. Actual guest capabilities must determine these values; copying a native reference's V8/libuv/OpenSSL/OS flags would misrepresent Kandelo.
* `--without-amaro` removes its shared bundle (`configure.py:2995-2997`). Explicit shared Undici/Amaro paths omit an embedded bundle and load the same ID from disk (`configure.py:2999-3006`, `src/node_builtins.cc:58-70`). Optional linked files add registration inputs. Keep these empty/default unless pinned explicitly.
* `--node-builtin-modules-path` chooses on-disk sources and disables snapshot/code-cache settings (`configure.py:1287-1292,1972-1983`; `src/node_builtins.cc:202-241`). It does not make source/module policy irrelevant.
* `node_snapshot.cc` and V8 code-cache data are optional generated native boot optimizations (`node.gyp:1133-1183,1730-1734`), not missing upstream JS sources. SpiderMonkey cannot reuse those V8 artifacts; it needs correct boot execution.

The source tar already ships the generated distribution bundles: Undici, Amaro, Minimatch, Acorn and Acorn Walk. Consume pinned bundles rather than rebuilding them locally. **Amaro embeds its Wasm bytes as base64** and directly constructs `WebAssembly.Module` and `WebAssembly.Instance` (`deps/amaro/dist/index.js:548-550`); no external Amaro `.wasm` input is missing. This makes nested guest Wasm a real dependency for whole upstream TypeScript behavior (`lib/internal/modules/typescript.js:32-38`), potentially earlier than final `node:wasi` work.

## Notices to preserve

Retain full upstream root `LICENSE` and source notices; all-lib includes third-party-derived code, not only Node-origin code. Root anchors include Node MIT (1-52), Punycode (1685), Caja/freeze_intrinsics (2603), rimraf (2760), fs-extra (2856), on-exit-leak-free (2875), sonic-boom (2900).

| Dependency | Available notice files | Composite license anchor |
|---|---|---|
| Acorn / Acorn Walk | Both respective `LICENSE` files | `LICENSE:54-77`, MIT |
| Undici | `deps/undici/LICENSE` | `LICENSE:1240-1263`, MIT |
| Amaro + embedded SWC | `deps/amaro/LICENSE.md`, `deps/amaro/dist/LICENSE` | `LICENSE:141-369`, MIT + Apache-2.0 |
| Minimatch | `deps/minimatch/LICENSE.md` | `LICENSE:2061-2118`, BlueOak-1.0.0 |
| V8 profiling tools | `deps/v8/LICENSE`, `deps/v8/AUTHORS`, per-file headers | `LICENSE:1709-1773`, BSD-style |

Minimatch's bundle includes balanced-match and brace-expansion (`index.js:13,81`). Whether available aggregate/package notices completely cover those bundled versions is an explicit redistribution question; this source audit is not legal clearance.

## Unresolved design choices / acceptance limits

1. Choose truthful generated guest configuration, not native-reference `process.config`, and expose real capabilities consistently across all four embedding hosts.
2. Decide and record byte-preservation versus the upstream Undici normalization exception; hash every input and any explicitly permitted transformed output.
3. Choose immutable embedded registry or guest-VFS storage, with full IDs/kinds/bootstrap and private binding ownership. Never equate all-source availability with all-source execution or expose every internal ID publicly.
4. Decide API-specific SpiderMonkey boundaries for V8 profiling/engine-facing APIs; preserving those sources alone proves nothing about their operation.
5. Resolve bundled notice completeness before redistribution.
6. Determine whether enabling whole upstream TypeScript makes nested Wasm a bootstrap/module-loading prerequisite earlier than previously scheduled.

No registered source file is missing from the tar index. Generated config is a concrete remaining required input. This is **not** a complete native dependency-build inventory, binding contract audit, syntax-support result, loading-closure proof, or four-host conformance result. No implementation or validation is authorized by this report.

## Coordinator decision for this import

The user explicitly requires unmodified upstream source, so this import
retains the original Undici bytes. It does not apply js2c's U+2019
normalization. Runtime embedding must preserve that declared source
identity; any resulting observable difference from native embedding stays
explicit in later differential evidence. No source-rewrite authorization
is inferred from upstream's packaging normalization.
