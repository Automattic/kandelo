# Worker startup publication foundation

All user startup values now belong to one LOAD graph and one transfer registry:
argv, captured filename/source and evaluation mode, workerData, environmentData.
Their target-relative property order preserves transfer-prefix hooks, then argv
clone hooks, then data clone hooks, actual shared identities and AB commits.
There is no post hoc phase/error selection across separate user serializations.

Early metadata contains only actual env strings and the native CLI data schema,
captured before user code can mutate public arguments/prototypes. Child eval
source/argv are not early metadata. The public argv Array species can therefore
produce a genuine registered Blob without passing that host to a pre-protocol
bootstrap reader. Native metadata contains no user host graph.

The child decodes the actual LOAD after builtin clone owners exist, then applies
its array-like argv with the pinned push-apply behavior and actual captured entry.
The file entry updates the consumed main path/native path and removes temporary
file globals so real module wrappers provide their bindings. Eval executes the
actual captured source with its native script label. Existing complete eval CJS
module/global metadata, ESM/referrer and loader conformance remain separate gaps.

`StartupGate` owns independent metadata/data slots and once-only read leases. A
missing LOAD stays absent and interruptibly pending until Stop; no default env,
argv, online event or user source is fabricated. Genuine metadata may prepare the
environment while LOAD is absent. Defensive no-result/missing-content admission
prevents null clone content reaching a reader. Both raw context-local packet boxes
are admitted before saved outcomes are consumed; deferred constructor exceptions
abort before thread launch. Failed preparation retires partial packet/port owners.
No sender ExceptionStack or JS root enters the gate or cross-thread packet.

Stop/retirement release the gate mutex before interrupt callbacks and packet/graph
retirement. Moving the actual slots into local native roots preserves ownership
across unlock; a retirement callback may safely reenter Stop. Native controls use
actual `Transit::Root` packets and threads, not JS metadata standing in for them.

This is source implementation and scoped native evidence, not guest conformance.
The new native bridge/header/loader/realm/GC/fatal/Worker paths remain uncompiled
and unexecuted in Kandelo. Private/public startup channel construction and async
init order, Worker stdio/options, complete error transport, ref/termination races,
engine interrupt/GC behavior and four-host runtime evidence remain open. Exact
whole-LOAD correctness also depends on the sender/receiver/AB owners; passing
frontend controls over native Node's serializer does not establish guest parity.
