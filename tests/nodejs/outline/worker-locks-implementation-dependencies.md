# Guest process lock ownership candidate

This adds a source candidate for the audited Node 26.13.0 Web Locks manager,
not worker-family or four-host acceptance. The immutable target remains source
commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. The full public
`lib/internal/locks.js` and native reference `src/node_locks.cc/.h` are copied
unchanged under `third_party/node-core/upstream/locks`, with identities in
`locks-sources.json`. The existing full pinned WebIDL dependency is reused.
The public source owns options/name conversion, validation, returned Lock and
LockManager brands/descriptors, abort listeners, and diagnostic channels.

`lock-manager.h` owns process-shared metadata under a native mutex. It retains
UTF16 resource names, exact per-environment request identities, held/pending
state, shared/exclusive compatibility, priority steal requests, unavailable
requests, stolen-holder notifications and atomic completion authority. Query
filters to the calling environment, matching the pinned native implementation.
No JS values or engine roots cross threads. `native-locks.cpp` owns context
registration and receiver-local reconstruction; `locks-platform-adapter.js`
retains callbacks and released Promise resolvers only within that context.
Callback Promise settlement and callback reentry release/process the actual
registry. A completion racing a foreign steal atomically observes the stolen
state before resolving its public Promise.

Aborting a pending public request leaves the native entry queued, as the
pinned wrapper does. When eventually granted, its wrapper suppresses the user
callback and releases the lock. Steal rejects a holder's released Promise,
while its original callback continues to own its own lifetime. Context
retirement removes both held and pending entries and wakes blocked receivers.
Neither outer browser `navigator.locks` nor the embedding host Node lock
manager implements any candidate operation.

The proposed engine integration registers one native binding and one JS
dispatch phase, checks actual deliverable lock work in both liveness branches,
and retires context ownership before joining descendants. An unresolved held
or blocked pending Promise alone is not a loop reference, matching the exact
native target. The manager condition variable replaces only the existing
bounded provider sleep, retaining its socket/work/timer deadline and the
actual idle-clock bracket. Its wake can end that sleep early. This is not a
new polling timer or permanent Promise keeper. Integration must preserve all
other providers and the ordinary tick/job checkpoints.

## Focused evidence

`host/test/fixtures/node-lock-manager.cpp` compiles against this exact portable
owner. On native Darwin arm64, it checks shared/exclusive ordering, pending
visibility, exact owner authority, miss/steal, a callback-completion/steal race,
UTF16/NUL names, environment retirement, a real condition-variable wake, and
1,000 exclusive grants across four native threads. It does not compile the
SpiderMonkey bridge or execute a guest.

`node-locks-controls.cjs` contains ten identical public controls for the exact
native target and candidate source adapter. The candidate harness uses
`node-locks-native-addon.cpp` to expose this same portable C++ manager through
Node-API; it never delegates to host locks. This checks the full pinned public
source, options, metadata, ordering/reentry, callback/Promise/thenable lifetime,
pending-only abort, steal, name preservation and real diagnostic channels.
Native internal dependencies in that harness are fixture dependencies rather
than proof of guest dependency wiring, JSAPI, event-loop or worker integration.

`node-locks-reference.cjs` separately observes native target liveness, query
visibility and worker teardown. Held plus blocked pending Promises do not keep
the native process alive. Queries expose the calling environment's records.
After terminating a worker holding a lock, its waiting main request did not
progress during a 100 ms real timer window; another lock request triggered
progress. The candidate retirement path wakes receivers immediately. That is
an explicit scheduling difference requiring integration review, rather than a
claim about an upstream runtime defect.

The target's synchronous callback-throw path rejects the request but leaves
its granted lock held until steal or environment teardown. This is reproduced
by both native and adapter controls and retained. Its illegal constructor and
invalid receiver paths currently produce TypeErrors from missing top-level
error constructors; the full pinned source is retained rather than repaired.

All controls run through `WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh`.
Detailed commands, identities, initial strict-compiler nonpass, corrected
controls and exact native reference output are retained under the workspace's
`.context/worker-locks-agent` evidence directory.

## Remaining boundaries

The native JSAPI bridge and proposed engine/build/bootstrap hooks have not
been compiled into a product artifact. No guest or browser test, product or
package build, whole suite, or engine acceptance run was performed here.
Root integration must regenerate the ordinary declared artifacts and source
identities before using this source candidate. No audit finding closes.

Cross-environment callback scheduling/async context, phase and beforeExit
ordering, abort/steal/death races under the actual guest engine, forced worker
interruptions and descendants, GC/OOM/finalization, all descriptor/receiver
details, and cleanup progress need actual guest and four-host controls. Query
record ordering across distinct resource names is not matched to the pinned
native unordered resource map. The Node-API adapter harness is not a substitute
for the SpiderMonkey bridge or actual guest loop. Runtime performance and
memory pressure have not been measured. The change adds no kernel syscall,
host import, shared wire layout or memory ceiling.

## Adversarial-review followup

The reviewed candidate now owns distinct waiting and released Promises, marks
both handled and applies the pinned settlement order. Non-Promise callback
results resolve waiting while the lock is still held, then independently
resolve released after authoritative release; thenables therefore undergo the
two actual assimilations present in the target. Query creates its resolver
before snapshotting, preserving synchronous Promise-init hook mutations.
Consumed callback references retire after invocation even when a synchronous
throw intentionally leaves the actual lock held.

Delivery prepares immutable metadata and receiver-local JS packets/errors
before committing manager state. The commit revalidates the selected request
and local victims under the shared mutex without allocations. Stale previews
retry. Packet/preflight allocation failure consumes neither held state nor a
stolen notification; a newly submitted undelivered request retires its exact
pending ownership on failure. Completion returns a scalar so it cannot fail
constructing a result after releasing the native record. Receiver teardown
also drops any prepared metadata. This does not claim actual guest JSAPI OOM
execution: focused fixture failures and portable transaction races are separate
from the deferred real-engine allocation/GC/interruption controls.

A separate engine proposal rotates actual native-work, port, worker and lock
providers. One successful provider returns to the normal tick/job checkpoint;
each continuously ready provider is attempted within four successful turns.
The rotation creates no loop reference, deadline, polling timer or synthetic
async resource. The existing provider sleep remains inside the unchanged
loop-idle clock bracket. This establishes a source/portable scheduling rule,
not measured product performance or guest four-host phase parity.

The earlier worker-termination scheduling and query ordering across distinct
names remain unresolved. No acceptance or audit finding closes from this
followup; actual engine compilation, provider execution, Promise activation,
GC/OOM, cancellation/steal/death races and four-host controls remain required.
