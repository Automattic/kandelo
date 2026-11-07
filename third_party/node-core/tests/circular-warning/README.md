# Circular CommonJS warning owner

This is the bounded L-020 loader slice. The existing CJS cache/load owner now
consumes the exact pinned Node26.13.0 warning emitter, missing-property proxy
and CJS admission condition. Successful load restores only that exact warning
prototype. Failed initialization keeps the escaped unfinished exports' warning
prototype, removes the actual failed record/cache relation and can be retried.
User-set prototypes, classes, proxies and transpiled __esModule objects retain
the target exclusions; reading __esModule itself does not warn.

The native required-ESM status branch is the sole adaptation of the selected
getExportsForCircularRequire function. It preserves the current explicit
pending-ESM ERR_METHOD_NOT_IMPLEMENTED rather than inventing ModuleWrap status
or claiming cycle/TLA compatibility. The complete unchanged pinned source and
section hashes remain enforced by build.py/sources.json.

The focused control executes actual generated record/policy/cache algorithms
and extracted production bootstrap loader/compiler source. It uses pinned
native Node VM compilation, filesystem, URL, isProxy and native process warning
dispatch as explicit dependencies. sameRealmCJS:true uses the native realm for
CJS wrappers as well as generated factories so plain-object/prototype identity
matches the single production guest realm. Default fixture behavior is
unchanged. skipESMResolver:true omits only separately owned native ESM graph
installation; no ESM behavior is inferred. No global product setup runs.

Run from the repository root through scripts/dev-shell.sh with the pinned
native Node binary and --expose-internals; control.cjs takes an output directory
within the private task root (one level above its private repo). upstream.cjs
takes the unchanged upstream test-module-circular-dependency-warning.js path.
It restores only original internalBinding/primordials global descriptors after
initializing the native parser helper, then loads the unchanged test through
the actual candidate CJS owner. Its common/fixtures/assertions are unchanged.

The handoff records initial helper-warning contamination, five real baseline
mismatches, private source-generation missing-input failures and a stale-bundle
run. They remain nonpasses. Final focused scenarios and unchanged upstream
controls are dependency evidence, not guest or four-host conformance. There
are no new native C++/Rust/Wasm compilations, engine/product builds or overall
suite runs. Public loading findings and existing failures outside L-020 remain.
