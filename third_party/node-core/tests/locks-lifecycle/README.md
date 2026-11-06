# Locks deferred-provider scope controls

The exact Node26 reference uses a foreign Worker's normal release, which wakes
this Environment through the real native-immediate queue. Its waiting callback
has IDs0/0, an undefined async-local frame and a fresh plain execution resource;
a resource created inside the callback gets trigger0.

The component controls execute the actual portable native lock manager through
Node-API and the generated shared async/Locks adapters over the actual portable
native execution owner. A separate real Worker releases its held lock; the
fixture-only `waitForReady` operation waits on that actual manager condition
variable. This blocking main-thread component driver is not the production
engine event loop. Production adds only a readiness read, never a blocking
operation. Host WebIDL/errors and Node-API roots are explicit dependencies.

`provider-control.cjs` checks the deferred callback's native state and frame,
restoration of the existing caller scope, and absence of internal scope creation
for an empty provider. `zero-scope-control.cjs` also checks synchronous request
context, nested zero-scope ownership, clear guards and failed-scope retention.
The producer/caller uses the exact pinned Node executable; all processes need
bounded supervision. There is no product setup or whole-suite dependency.

These controls do not validate production SpiderMonkey classes/GC/realm/OOM,
actual provider phase timing, worker interruption/descendant teardown, browser
hosts or API completeness. Native termination cleanup and raw query ordering
remain separate unresolved differences. Sorting a snapshot does not implement
native resource ownership and is not a remedy for that order distinction.
