# Snapshot callback ownership review

This is a source contract review against the authenticated Node 26.13.0
archive, not a runtime implementation or startup result. Source identities and
review locations are recorded in `mksnapshot-contracts.json`; the audit receipt
is `mksnapshot-ownership-check.json`. The native snapshot-source architecture
choice remains pending.

The previous inventory called these three strong Environment slots shared
across realms. That description omitted the actual owner and context rule.
`snapshot_serialize_callback`, `snapshot_deserialize_callback` and
`snapshot_deserialize_main` are members of `PER_REALM_STRONG_PERSISTENT_VALUES`.
`Realm` owns their `v8::Global<Function>` storage. Environment getters and
setters forward to `principal_realm_`; they do not select the calling realm.
The principal-realm setter checks that its context is current when the input
is nonempty. This is a debug assertion in the original source, not a new
JavaScript error or permission to silently redirect foreign-realm assignment.

| Operation | Original contract | Implementation obligation |
| --- | --- | --- |
| Binding registration | Each original `Set*` checks that the principal slot is empty, checks that the argument is a Function, then calls the Environment setter. | Preserve order and fatal assertions. Registration stores the actual function without calling it or adding loop references. |
| Native setter | PrincipalRealm checks the current context for nonempty input and resets its strong Global to the input. Empty input is allowed. | Separate the root-storage operation from the binding's single-assignment checks. Do not make native storage permanently write-once. |
| Context selection | `Environment::context()` returns `principal_realm()->context()`. `CompileSerializeMain` separately requests the isolate's current context. | Represent both identities. A principal callback invocation and compilation in the active context are different operations. |
| Serialize callback | `RunSnapshotSerializeCallback` enters the principal context, calls with undefined receiver and no arguments, and preserves an empty MaybeLocal on failure. An empty slot returns real undefined. | Preserve function ownership, exception propagation, scope restoration and actual function execution. |
| Loop integration | `SpinEventLoopInternal` invokes serialization after `beforeExit`, rechecks real loop liveness, and clears the serialize callback before normal exit emission. Stopping returns earlier. | Do not invoke on registration or treat rooting as an active handle. Model both normal and stopping paths. |
| Deserialize main | `StartExecution` selects the registered main before ordinary worker/eval/file entrypaths, requires a main-thread Environment, and calls `RunSnapshotDeserializeMain`. | Preserve entrypath precedence; do not use this slot as a bootstrap-completion flag. |
| Realm cleanup | `RunCleanup` retires binding-data weak pointers and native object lists. Environment destruction later resets the principal realm; its strong Global members are destroyed with it. | Clean native resources and release callback roots before engine teardown. Do not assume binding finalization or cleanup-list draining alone clears the callback roots. |
| Snapshot persistence | Realm serialization records nonempty persistent values through real `SnapshotCreator::AddData`; deserialization restores them through actual context snapshot data. | Fresh and restored state differ. Never fabricate callback restoration, indices or builder state. |

The deserialize-callback slot is retained and serialized through the same
per-realm machinery. A literal-name scan of all 460 authenticated `src/**/*.cc`
and `src/**/*.h` files finds its declaration and the original binding setter,
but no separately named native invocation. That scan does not replace review
of generic serialization macros. Original JavaScript
`internal/v8/startup_snapshot` exports `runDeserializeCallbacks`, and
`internal/process/pre_execution` calls that runner directly. Do not invent a
second native callback invocation during ordinary startup.

The one-byte `isBuildingSnapshotBuffer` has a different owner: each Realm's
`BindingData` owns the original AliasedUint8Array, publishes the actual JS view,
and weakens its native handle. It is not the owner of the principal callback
slots. Reclaiming a child binding must not clear another realm's callback slots.

## Existing Kandelo foundations and gaps

The current runtime already records the first initialized principal realm and
process in `per-context.cpp`, independently of child realm registration. The
codec State and stable Environment are shared through the runtime's codec
state; `Environment::Drain` and `Shutdown` already enter the registered principal
realm. These are reuse candidates, not a reason to allocate a second principal
owner or one Environment per snapshot binding.

The native codec adapter's current `Environment::context()` returns the
isolate's active context. Its Context value carries the isolate pointer, and
`Frame` determines the current engine realm. It does not yet implement the
principal-versus-active context distinction needed here. Strong/weak Globals
and foreground shutdown exist, but the three callback roots and their native
accessors do not. No callback storage or context change was implemented during
this review.

After resolving the source architecture choice, the startup dependency order
is: establish native principal-context identity and accessors using the existing
owner; integrate the original live binding and its actual state view/compiler;
preserve callback registration assertions and native clearing; then wire any
required callback execution through the real entrypath and loop lifecycle.
Snapshot creation/restoration remains a distinct missing dependency. This is
the startup closure, not authorization to implement the broader backend roadmap.

## Required evidence

On each of Node, Chromium, Firefox and WebKit, use the identified normal package
artifact to verify principal registration survives child-realm use, roots retain
functions across moving GC, distinct runtime owners do not share callbacks,
registration never calls callbacks or keeps the loop alive, and foreground
shutdown releases roots. Exercise original duplicate/nonfunction fatal checks
in isolated processes. Check callback execution, thrown-value identity and
context restoration on success, exception and reentrant cleanup paths. Check
the original principal-context debug invariant with an assertion-enabled build
if that invariant is claimed tested; a release build cannot prove it.

The existing eight native reference controls prove selected fresh live behavior
and callback retention. They do not prove these cross-realm, teardown, loop or
snapshot-restoration obligations. No new runtime test, build, four-host result
or startup acceptance is claimed by this source review. Earlier runtime receipts
retain their original input identities; they are not rewritten to include this
later catalog correction.
