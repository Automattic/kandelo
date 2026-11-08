# Actual intrinsic Promise parent owner

This prerequisite supplies the actual parent Promise at native init and fixes
the current intrinsic slow-path parent trigger. Public `v8.promiseHooks` remains
unactivated. Its shared registration/order/exception and raw-only observer mode
are still missing; no exported functions or artificial AsyncHook IDs are added.

The current engine already admits actual Promise init, before, after and resolve
notifications and lazy IDs under the existing AsyncHook mode. It preserves only
a numeric parent ID in two fast allocation paths. The new synchronous rooted
parent scope carries the real parent alongside that existing numeric authority.
Native init roots the observed parent, clears both active parent values while
callbacks run, and appends the real object or undefined to lifecycle delivery.
Hook-created side promises therefore do not inherit the observed child link.
All previous event arguments, frame ownership and mode decisions are retained.

The generic `PromiseThenNewPromiseCapability` path resolves species first, then
compares its result with the actual current realm intrinsic constructor from
GlobalObject. This is the cached realm intrinsic, not a mutable globalThis.Promise
property. Exact pointer equality is required. Foreign-realm constructors,
wrappers, proxies and custom subclasses do not get this parent; their constructor
side promises remain parent-undefined. For the exact current intrinsic, the
existing native ID owner supplies the parent ID before child birth. The two
existing intrinsic fast paths carry the actual object through the same lifetime.
No parent is inferred from a constructor name, function-native test or ID map.

This follows pinned V8 `promise-then.tq:39–57`: both ordinary fast allocation and
slow lookup returning the current intrinsic take `NewJSPromise(promise)`, while
custom/foreign capability construction uses the parentless constructor path.
Species getter side effects precede the allocation scope. The earlier proposal
to scope all species was rejected before implementation because it would have
assigned incorrect parents to arbitrary constructor-created promises.

The current JS AsyncHook init consumer uses the delivered actual parent's
existing native resource ID as its trigger. The Promise does not retain a parent
edge in its metadata, and the native context slot is restored on every C++ exit.
Root registration is reused by assigning values, not clearing/unregistering and
then reassigning a PersistentRooted. Once construction unwinds, the slot holds
its prior value (ordinarily undefined). No JS roots cross threads or packets.

This is source-only, over exact current269 canonical JSContext/Promise images.
No compilation, normal generation, runtime controls or four-host validation was
performed. Existing before/after/resolve, frame/epoch, hook removal, native
destroy and rejection ownership are unchanged. Actual generic/await/thenable and
optimized creation coverage, full mutable Promise metadata, GC/OOM/realm/Worker,
hook error/fatal/reentry and native ordering still require conformance evidence.
Raw-only hooks must later observe genuine objects/events without synthesizing
AsyncHook IDs; the current three-boolean mode does not supply that owner. Public
registration must share chronological hook lists and the real uncaught-error
policy, rather than append a second fixed-priority callback facade.
