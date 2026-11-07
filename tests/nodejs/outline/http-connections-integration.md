# HTTP parser connection ownership prerequisite

Source236 connects the actual native request parser to a shared native
ConnectionsList. Intrusive all/active membership, monotonic message/header
state and exact pinned deadline policy own real connection state. Queries
return the same actual parser identities and socket associations. The parser
self-edge is traced only from a live parser; list membership does not keep
otherwise dead JS parsers alive. Foreground finalization removes both nodes.
Temporary rooted identity snapshots precede JS result/CCW allocation, so raw
record iterators do not survive that reentry. New checked-unwrap branches report
real access denial before class validation without bypassing security.

Current-root controls pass10portablelist comparisons,17request/header groups
and25unchangedresponse cases. They use actual candidate portable C++ list and
llhttp owners with explicit native Node parser/list/IncomingMessage/Socket
dependencies. They do not execute the new guest JSAPI/GC/realm/OOM paths. Six
source/input/staging checks and fourteen package-input tests are separate.
Three producer helper compilations are counted once303 to306; three immutable
llhttp objects and all final helpers are reused, not rebuilt by root checks.
Four earlier source/fixture setup failures remain preserved. The denied-unwrap
review correction is source evidence, not an executed denial reproduction.

Normal source generation changes the real bundle; normal staging declares and
copies the new owner header. Existing235TLS async identity,234publication and
233write callback owners remain intact. The patch also changes the executable
build-spidermonkey.sh (Git100755). scripts/agent-integrate V1 rejects executable
owned files, so this change uses the existing guarded manual integration path.
No chmod, weakened tool check or disguised success is used.

Deferred Body/Complete packets remain a real semantic gap: native Complete can
transition list state before JS Body callbacks. Persistent reuse/reset/free,
pipelining, actual parser AsyncWrap/provider shape, consume/backpressure and
complete transport/timeout/close ownership remain incomplete. Public Server,
ServerResponse and OutgoingMessage are not activated by this prerequisite.
New guest C++ and four-host runtime conformance remain unvalidated; all nineteen
families remain partial. No full product rebuild or overall suite ran.
