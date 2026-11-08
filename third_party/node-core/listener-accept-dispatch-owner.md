# Native listener accept consumer

The source264 callback transition installed `socketListenerStart` and changed
Server acceptance to that callback route, but current source268 lacks both
`KandeloDispatchListenerConnections` and its loop call. The original sealed
callback capsule contains them. Setting `accepting` and `onconnection` alone
does not accept a connection. Earlier source/package checks are not evidence
that ordinary Server acceptance works.

This slice restores a consumed native poll/accept provider. It polls the
actual retained nonblocking listener and creates each accepted TCPWRAP under
the real TCPSERVERWRAP default trigger. Existing accepted-lease ownership
protects unpublished clients through constructor/init, property access, native
callback before/after hooks and the checkpoint. Successful adoption empties
that capability. Failure closes only its actual unpublished owner, preserving
the pending exception. Native callback scope owns receiver, frame and error
recovery. No Promise is introduced into the public connection callback.

The portable owner now performs the real `listen` syscall and records its
success. Read registration is therefore separate from merely owning an opened
descriptor or attaching a callback. Dispatch and referenced-loop liveness
consume the same registration. It remains registered through accepted-client
init and callback execution, and Close removes it before exact-fd close.
Future supplied-fd listen must call this actual Listen operation; a standalone
metadata assignment is insufficient. This does not solve modern TCP stream
read/write/connect watcher-mask ownership.

The native close barrier retains `accepts`, `callbackActive` and rooted owners
until client init, callback and all scope cleanup unwind. Reentrant loop entry
cannot accept again from that listener or finalize its close while the frame
is active. Selection rotates before JS and retains no raw successor across
reentry. Existing close, TCP/TLS and child providers keep their existing turn;
legacy watches are snapshotted afresh after listener callback/checkpoint JS.
Legacy Promise acceptance and callback-mode acceptance are separate readers;
start rejects an outstanding legacy request, and legacy accept rejects an
already attached callback reader, rather than consuming the same queue twice.

Pinned POSIX uv__server_io emits connection callbacks after successful accept.
Poll/accept errno does not manufacture an onconnection error callback. The
libuv EMFILE shedding mechanism and its cached unconsumed accepted_fd are not
implemented here. The candidate captures the fd before client construction,
then closes it on failed publication/init; exact native allocation-failure
retry behavior remains a gap. Parent close from client init declines
publication and closes the captured lease. Full listener callback/getter/fatal
channels, GC/realm/Worker execution, prototype/public Server/Socket semantics,
requested-backlog and host-listen errors, public supplied-fd admission and all
four-host conformance remain incomplete.

No native or candidate controls, compilers, normal generation, engine build,
package regression or overall suite ran. Evidence is source trace and exact
private forward/reverse/forward replay only. No source or audit finding is
closed, and there is no guest proof. Parent must compose narrow source hunks
and the engine patch over the actual later canonical and regenerate normally.
The existing native listener/header inputs already cover runtime files; no new
native function export or ABI55 change is introduced.
