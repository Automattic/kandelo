# Public test runner execution owner

The public `node:test` run API consumes exact pinned discovery and run algorithms
for explicit `isolation: 'none'` executions. Discovery uses the same real Glob
class as public fs.glob; directory expansion/default patterns/node_modules
exclusion/sorting, sharding and option-validation stay in their original source.
Setup, real module import, bootstrap, test registration, hooks, cancellation,
placeholder tests and TestsStream reporting flow through the actual test tree.

The current module sync resolver is not an async import owner. The testing loader
keeps genuine resolveSync and uses a narrow absolute-file-URL import bridge for
test files/global setup. This bridge passes the original URL once to the native
module graph, preserving its actual registry/CJS/ESM/source/load owners. It does
not resolve the URL twice or substitute require() for module evaluation. Bare or
relative external reporter/preload imports and nonempty import attributes remain
explicit missing bridge operations. General parent-referrer imports remain a
shared loader implementation gap; this slice does not pretend to complete them.

Only one capability check is inserted before upstream root/resource creation,
after all original public validation. Process isolation/child report transport,
watch restart/lifecycle, measured coverage and CLI launcher/preload ownership
remain explicit ERR_NOT_IMPLEMENTED failures. Those are valid public API
implementation failures, not accepted platform boundaries or passing coverage.
No dummy V8 serializer, host production passthrough, successful-result stream or
coverage metadata is supplied. The full default process-isolation/IPC/serializer/
CLI/watch/coverage runner remains in the implementation roadmap.

Focused controls use genuine native Node process/async/timer/stream/filesystem/
module graph dependencies. Their native module hook routes fixture node:test
imports to the actual candidate test tree; it does not produce test outcomes.
These controls do not establish guest module/realm/async/GC/teardown behavior or
identified-artifact conformance on any of the four hosts. A selected engine build
and broader suites remain deferred; performance was not measured.
