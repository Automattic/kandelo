# Synchronous CommonJS customization hooks

Source153 installs unchanged pinned customization_hooks.js registration,
chain/context/result validation and disposal over the actual CommonJS loader.
Hook resolution and load results participate in real Module ownership, source
compilation/JSON parsing, builtin replacement, extensions and failure cleanup.
Synthetic URLs and supplied source execute rather than silently reading the
original filename. The per-parent-directory resolution cache follows actual
Module cache admission/eviction and failed transactions. The separate Bun
asset path remains present.

The delivered source matches all14 sealed postimages. The two new production
inputs are declared normally;718 core inputs, bundle freshness and assembled
bootstrap syntax checks pass. On the combined branch,17 native/component
comparison groups and22 existing record/wrapper/syntax tests pass, with14
package-source tests separately passing. No skips occurred. Prior14 unchanged
upstream CJS hook tests also pass against these exact source identities; that
result is reused and not counted as fresh execution.

Component tests explicitly depend on pinned native VM compilation, filesystem,
URL/Buffer/encoding, builtin exports and the actual native test-process module
load list. Native test/common supplies real mustCall exit accounting. These
are dependency controls, not Kandelo engine/guest/four-host conformance. They
do not establish full conformance of those dependencies. No upstream assertion
or target/source/native pin changed and no compilation/product setup ran.

Earlier cache invocation and format-policy mismatches remain preserved beside
fixture cache-scope/module-load-list/worker-flag failures. Fixes change owning
loader/cache behavior; fixture corrections retain original assertions and
their narrower evidence scope.

Remaining gaps include hooks in ESM consumers, supplied ESM source execution,
async module.register and loader workers, TypeScript/addon formats, preload/
CLI activation, namespace/cache/source-map behavior and other L-009 APIs.
Supplied ESM source reports an implementation gap instead of being discarded.
No API or family closes. The current combined engine lacks an accepted
artifact; overall suites and the full product rebuild remain deferred.

Exact evidence: [module-hooks-finding-progress.json](module-hooks-finding-progress.json).
