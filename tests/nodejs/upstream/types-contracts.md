# Native engine type predicates

Revision 31 adds all 26 exports declared in the complete pinned
`src/node_types.cc`. The source is imported unchanged for identity and contract
review. A strict generator emits export names only; the embedding inspects
actual SpiderMonkey object classes and function flags. It does not generate
JavaScript, extract function bodies or replace original module algorithms.

Predicates ignore the receiver and extra arguments, return false for missing
or primitive arguments, and do not coerce values or read public properties.
Functions have the pinned native reference's empty name and length zero.
Their binding properties remain writable, enumerable and configurable. The
original realm loader caches each binding; traced native function slots retain
its realm owner and reject calls after that realm's bootstrap fails.

Checked engine wrappers preserve foreign native identity. Scripted and revoked
JavaScript proxies remain proxies without invoking handlers or classifying their
targets. Actual module namespace objects are distinguished from scripted proxies,
even though SpiderMonkey implements namespaces with internal proxy machinery.
Denied wrapper access is an error; complete security-wrapper equivalence remains
unvalidated. Async generators match both function flags; bound functions do not
inherit their targets' flags. Actual detached buffers retain their native type.
Native Error classification follows engine state, including the real Error
created by the unchanged DOMException constructor, rather than inheritance.

`External` uses a private class with null prototype, no extensibility and one
opaque slot holding an actual borrowed native pointer. The embedding owns the
payload lifetime; the JavaScript carrier does not manufacture a resource handle
or add a finalizer. A small native reference addon creates and reads a genuine
N-API External. The guest's privileged fixture independently creates and reads
an actual C++ pointer. Both read the same respective int value before and after
GC. This establishes the selected carrier contract, not Node-API compatibility
or general native resource ownership.

Twenty-one guest controls pass on Node, Chromium, Firefox and WebKit using the
same engine/kernel bytes. They include all 26 exports over 86 values shared with
the pinned native reference, with identical classifications, plus foreign realm
values, cache/owner isolation, moving GC, real module namespaces, failed-realm
rejection and execution of the complete original `internal/util/types` body.
Selected original typed-array helpers use the actual intrinsic getters. Thirteen
shared controls pass separately on the pinned native executable. The same guest
engine passes 218 prior cases on Node; these remain bounded controls, not full
native conformance or public `node:util` compatibility.

The complete original principal body and stack-policy probe now pass `types`
and stop on `options` in `internal/options:20`, reached from `internal/util:74`.
The original typed NodeError probe still returns. Ordinary public Node startup
still uses the compatibility bootstrap. Empty/simple output, errors, job draining,
exit status and separate CJS/ESM entry acceptance remain unproven.

The initial build compiled and linked, then failed Mozilla's include-order check.
The embedding includes were corrected without weakening the checker. The first
native reference fixture incorrectly expected DOMException not to be a native
Error and External to be extensible; the corrected fixture follows actual native
behavior and unchanged DOMException source. The embedding now prevents External
extensions. Staged review also caught a blank patch context line; reducing the
hunk preserved the exact applied source, and the normal rebuild produced identical
engine bytes. These failures and exact source/artifact identities are retained in
[types-engine-check.json](types-engine-check.json). Full OOM, teardown, denied
wrappers and ShadowRealm equivalence remain open. Existing Mozilla targeting
and bounded native fork-instrumentation limitations remain unchanged.

The partial catalog [types-contracts.json](types-contracts.json) includes every
export, three direct literal consumers and 76 references to the original internal
types module. That syntax index is not complete graph coverage. Next implement
the startup-required options/native closure, then finish four-host startup and
reconcile the entire lazy/conditional/worker/platform/exception backend graph.
Keep nested guest Wasm last unless startup needs it. Deliver the complete catalog
and dependency-ordered roadmap for user review before broader implementation.
Full products, successor-ABI rebuilds and overall suites remain deferred. These
focused checks use empty guest filesystems, not product images.
