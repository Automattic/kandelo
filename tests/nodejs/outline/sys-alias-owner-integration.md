# Legacy sys builtin identity and initialization

Source189 integrates the sealed sys handoff over source188, preserving FFI,
crypto, util and unrelated source. Target/source/native-reference pins and ABI55
are unchanged. This is a source implementation slice, not family conformance.

## Actual behavior and ownership

The complete unchanged pinned lib/sys.js is compiled through the existing actual
native script entry point with node:sys filename and original line origin. Its
internal require returns the exact production util object. No copied namespace,
warning-shaped replacement or native sys fallback is installed.

A private builtin record consumes the unchanged pinned compileForInternalLoader
method. Metadata enumeration does not load sys. Reentry returns actual in-progress
exports; warning exceptions clear loading in finally and later loading retries.
Success records exactly one real NativeModule sys entry. Bare/node aliases and
process.getBuiltinModule consume the same record. Existing public CommonJS cache
replacement and node: cache bypass retain their owners. Native ESM already routes
builtin loading through the registry, but this slice does not execute that path.

The exact pinned process.emitWarning call, receiver/message/type/DEP0025 reach
the existing warning owner. Filtering, tick scheduling, tracing and throwing
remain there. No new sys-specific warning policy is introduced.

## Focused evidence

Thirteen paired native/current-source groups pass: metadata, alias order,
descriptors/mutation, warning reentry and retry, exact warning call/receiver,
public cache poisoning versus node:, delivery timing, suppression, tracing and
throwing. The complete unchanged pinned test-sys.js passes native and candidate
with its real upstream common harness. Exact candidate/public requests use the
production CJS/registry/sys owner, over declared native VM/util/filesystem/
EventEmitter/tick dependencies. Actual raw node:sys warning frames are retained;
V8 stack support is not guest SpiderMonkey evidence.

Normal generation/input closure covers844files. Complete bootstrap syntax,
unchanged Mozilla style checking and14package-source checks pass. No compiler,
package/engine/kernel/product build, overall suite or new guest execution ran.
Accepted engine173 remains stale for source189.

Exact results: `.context/node26-sys189-source-r1/report.json`,
`focused-results.json` and `.context/node26-sys189-affected-r1.json`.
The immutable handoff `.context/sys-alias-owner-agent` preserves patch pre/post
images, evidence, exact source identities and the original failures.

## Preserved harness gaps and remaining work

The original13candidate controls failed before sys assertions because the
existing default module-record fixture initializes an absent _nodeESMGraph.
Those logs remain failures. The new explicit skipESMResolver option omits only
that unrelated ESM installation for these focused CJS controls; default behavior
and upstream assertions are unchanged, and no fake graph is installed. This is
not repaired ESM conformance. The earlier recipe-input check also retains its
exact two missing declarations; this integration supplies both actual inputs.

V-025 was originally prose/range scoped rather than a recovered standalone
finding definition; that accounting ambiguity is preserved. Source now supplies
the missing alias/load effect, while actual guest/ESM import, warning stack/realm,
redirection/file lifetime, remaining warning options and all util method behavior
remain separate obligations. No finding or family closes. Full product rebuild
and overall suites stay deferred; nested guest Wasm backend remains in scope
for the final phase.
