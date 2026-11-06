# Deferred Locks execution ownership

Source155 connects ready deferred lock delivery to the actual native execution
stack with IDs0/0, a fresh plain execution resource and the default async-local
frame. A metadata-only update cannot substitute for this owner. Synchronous
request/settlement callbacks keep their caller context; empty dispatch creates
no scope. Successful delivery restores its actual entering owner, while failure
or a cleared stack cannot resurrect a stale context snapshot. Native readiness
comes from the real manager state, without timers or invented references.

The reviewed patch is applied additively over current149 execution ownership,
153 CJS hooks and154 SQLite lifecycle. Three bounded current-source controls
pass: the exact native foreign-release reference, actual portable-manager/native
execution-owner component delivery, and scope clear/failure/synchronous checks.
They assert the undefined async-local frame, actual resource identity, child
trigger0 and caller restoration. Identified Node-API addons are reused with
exact current manager/source identities; no compilation ran. Source/input and
assembled bootstrap checks plus14 existing package-source tests pass.

The component's condition-variable wait is an explicit driver, not a production
event loop. Native VM/Promise/Worker/error dependencies remain explicit. Prior
three deliberately broken component variants remain rejected. Existing native
termination-wake and raw query-order differences remain unresolved nonmatches;
provider batching/resource identity and Promise/GC/rejection/realm/teardown
behavior also remain open. No assertion/snapshot comparator or real wakeup was
removed to make these differences pass. No platform boundary is accepted here.

The first root source check used a wrong header pathname and failed before
controls ran. Its log remains preserved; the corrected path verifies the same
actual header/hash. Production native-locks.cpp/JSAPI and all four guest hosts
still require an identified current engine artifact. No API/family closes, and
overall suites/full product rebuild remain deferred.

Exact evidence: [locks-lifecycle-finding-progress.json](locks-lifecycle-finding-progress.json).
