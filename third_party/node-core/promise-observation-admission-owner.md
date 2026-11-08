# Promise observation admission prerequisite

The actual async_hooks consumer now passes five separate producer admissions:
init, before, after, settled, and async identities. The native setter and
JSContext use that same contract. Existing async_hooks still requests real
identities and retains its deferred microtask removal; this does not install
public v8.promiseHooks or a second hook registry.

Init and the three existing intrinsic child-birth scopes can carry the actual
rooted Promise parent without allocating parent or child AsyncWrap IDs when
identity admission is off. The synchronous parent scope/reset remains real;
no persistent child-to-parent edge, numeric lookup or new species inference
is introduced. Optimized await/custom species coverage remains incomplete.

Raw settled observation records its once state in the existing private
Promise metadata slot as a Boolean until a genuine identity consumer needs
the real metadata object. Later lazy identity creation preserves that once
state. No fake async ID/resource is created for the Boolean marker. Existing
native async-info callers still require an actual metadata object.

The real queue separately admits before and current late-after observations.
Only identity-admitted Promise callbacks allocate AsyncResourceData. Snapshot
frame propagation and the existing execution-epoch restoration guard remain.
Promise-before-only admission cannot fall through to generic task after.
These are source changes, not executed queue/GC/realm proof.

Public/shared-registry activation is held. The current JS Promise lifecycle
still directly calls nativeResource/getAsyncResourceInfo; it must first be
replaced with the exact pinned internal/promise_hooks.js shared chronological
registry and real async_hooks observers. The single-hook fast path and the
multiplexer exception list both require actual ordinary uncaught dispatch
(fromPromise=false), not asyncHookFatal. The existing native recovery helper
is a pending-exception/event-boundary owner which can clear execution epochs;
calling it blindly inside a raw init/before/after notification could restore
retired scopes, duplicate after delivery, or skip callbacks. That consumed
registry/exception/entered-scope owner is the next implementation dependency.
No raw-only JS registration reaches this native seam in the current adapter.

No public v8.promiseHooks export, fake support flag or unused runtime copy of
the pinned registry is added here. No new generated bundle, recipe revision,
ABI change, compiler, runtime test or four-host conformance is supplied.
