# Stream source review

State: **source review complete with implementation gaps** for classic,
promise, consumer and iterable stream contracts, together with the
[full review](streams-contracts.md), requirements and source correspondence.
Full stream/web classes remain a separate pending web-family audit.
No runtime validation ran.

## Implementation and ownership

Classic, promises, iterable and Web Streams use pinned Node source
factories from `third_party/node-core/sources.json` through
`stream-platform-adapter.js`:3–110 and `build.py`:303–320. Bootstrap:
3264–3282 installs their actual constructors and state. Globals,
stream/web, Blob and Fetch bodies share those constructors; the later
WebReadableStream assignment is the same constructor, not a replacement
shim. Older direct tests of node-web-platform's retained ponyfill do not
validate this source candidate.

Pinned state machines supply real buffering, backpressure, pipeline,
finished, cancellation, operators, async iterators and disposal algorithms.
Their correctness depends on the actual supplied events, tick queues,
errors, Buffer, native Promise metadata and I/O subclass callbacks.
Importing those algorithms is not enough to approve those dependencies.
ReadStream/WriteStream factories/accessors are separately installed with
their descriptors by fs-streams-adapter.js, not the old bootstrap bodies.

| ID | Requirement | Source observation/dependency |
|---|---|---|
| STR-001 | Classic Stream/Readable/Writable/Duplex/Transform/PassThrough, constructors, inherited methods, descriptors and symbols | Real pinned algorithms; all injected dependencies and public overloads still require full reconciliation. Buffer encodings/ownership and EventEmitter/async findings propagate here |
| STR-002 | pipeline/finished and promises cleanup, abort and completion ordering | Actual upstream algorithms are present; custom fs/socket/child/TLS owners must obey callback-once, terminal/error and ref semantics. No current runtime evidence |
| STR-003 | Web Stream transfer/cancellation across real ports | Adapter internal/worker/io MessageChannel constructor throws ERR_NOT_IMPLEMENTED (stream-platform-adapter.js:34–36). Transfer hooks cannot supply working remote stream transport despite a real local stream implementation |
| STR-004 | Classic/Web adapters, byte brands, BYOB, transferred/resized/detached storage | build.py prepends an explicit adapter dependency prelude and appended exports around pinned adapter source. Native clone/pins and current Buffer semantics remain governing dependencies; no guarantee follows from source import |
| STR-005 | Experimental stream/iter activation and full iterable protocols | Policy/factories honor --experimental-stream-iter. Batching, pull/pipeTo, sync/async cancellation, sharing/broadcast ownership and FileHandle pull/writer remain in scope; normal unflagged absence is not a defect |
| STR-006 | Event-loop liveness and I/O resource ownership | Socket/TTY/process/TLS ref/no-op and error gaps are separate I/O owner findings. Pure queue/state correctness cannot establish resource liveness |

All four hosts use the same guest algorithms. Host fd readiness,
worker/clone and shutdown routes differ; no blanket browser or non-V8
boundary is accepted. Windows HANDLE import is explicitly unavailable in
the POSIX binding; its target platform guard must be retained, rather
than counting an intentionally inapplicable Windows-only operation as a
missing POSIX API.

Existing evidence: historical suite and selected controls only, identified
in the evidence catalog. No four-host result exists for this unbuilt
candidate. Later unchanged upstream stream, pipeline, finished,
readable/writable/duplex/transform, Web Streams, transfer and iterable
tests need native controls for callback/event ordering, abort races,
backpressure, destroy/final errors, late listeners, Buffer mutation,
byte/BYOB detachment, shared state, transfer and early iterator return.

The completed source review covers exported/static/inherited methods and symbols; helper
dependencies/primordials; streams with unusual subclasses; transfer
serialization; iterable share/broadcast refcounts and source closing;
WebIDL receiver errors/descriptors; underlying source/sink exceptions;
adapter cancellation and actual fd liveness dependencies. Exact native
edge controls remain pending; the full Web class source review is now
recorded in [web contracts](web-contracts.md), with gaps. Source
completion establishes neither implementation completeness nor conformance.
