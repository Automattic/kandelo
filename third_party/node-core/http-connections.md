# HTTP request connection tracking prerequisite

This source adds actual native ConnectionsList ownership to the existing llhttp
request-parser path. It does not activate public http.Server/createServer.

The existing request factory accepts its real private `connections` owner. Its
returned API is the same native parser object held by that list; queries return
actual parser identities and preserve socket associations, without public-ID or
user-property lookup. Response packet consumers keep their existing path.

ConnectionRecord owns its native list through shared ownership. The list owns
only intrusive raw membership, so it cannot keep dead JS parsers alive. The
parser's traced self-edge updates an already-live object's moving identity.
Foreground finalization detaches both nodes. The parser also retains the actual
list wrapper in a reserved slot; native shared ownership makes either finalizer
order safe. List queries first select native records and establish temporary
PersistentRooted identities under a no-GC scope, before JS array/CCW allocations.
No roots cross threads. New guest C++ remains uncompiled and these GC/realm/OOM
paths have not been executed in the guest.

The unchanged pinned list-node/append algorithms are source-hash verified. Real
CLOCK_MONOTONIC nanoseconds feed Node's initial-idle/active overlap, Begin active
reordering, Headers flag, Complete idle transition, request/header deadline swap,
unsigned subtraction guard and expired-active-only removal. Remove detaches and
suppresses further llhttp callbacks without deleting an executing parser.

Remaining implementation gaps include persistent parser reuse/reset/free and
pipelining, real HTTP parser AsyncWrap lifecycle, complete accepted-transport /
ConnectionsList / timeout / close coordination needed by pinned Server, native
consume/backpressure/upgrade/EOF ownership, and complete public HTTP/HTTPS.

Body and Complete are still deferred packets. In particular native Complete can
remove an active record before JS receives a queued Body callback, whereas Node
calls Body synchronously before Complete. A Body callback querying idle/active
can therefore differ. The passing bounded owner controls do not establish full
ConnectionsList callback chronology or public HTTP server conformance.

Associated memory reports requested known payload sizes, not RSS; shared_ptr
control-block overhead and broader allocation accounting are not established by
this slice. Real clock failure throws rather than manufacturing a timestamp;
exact guest error/fatal policy remains unvalidated.
