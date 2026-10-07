# Remote TCP for independent Kandelo machines

Date: 2026-10-06. Status: design and implementation in progress.

## Why and scope

The UDP experiment connects real guest sockets across a worker-owned star
network. Ordinary web servers and clients need byte streams with asynchronous
connect, bounded receive storage, half-close, and observable reset. The user
approved Phase 3 after the UDP evidence checkpoint. Keep this change on a
separate branch above the UDP draft so existing changes remain reviewable.

## Multiplex reliable streams

Multiplex bounded TCP frames on the existing reliable network-control channel,
with a binary marker distinct from its JSON directory messages. This preserves
one ordering domain for a stream's OPEN, DATA, credit, FIN, read-shutdown, and
reset messages. Creating one RTC channel per guest connection would move socket
lifecycle into the main thread and require asynchronous channel allocation on
every connect. The main thread instead forwards owned bytes and never performs
routing or syscall decisions.

Each frame contains its type, version, a nonreused connection number scoped to
the initiating machine, source/destination IPv4 addresses and ports, and a
bounded value or payload. Authenticate the ingress source against the assigned
machine and verify the established endpoint tuple on receipt. The host forwards
between joiners without becoming a TCP endpoint. Keep reliable delivery,
including FIN after the final admitted DATA, separate from unreliable UDP.
Malformed frames, impossible credit, or loss of reliable bridge admission fail
loudly; never discard an admitted TCP frame and report an orderly stream.

## Bounded flow control

Each receiver grants at most 64 KiB of byte credit. DATA consumes that credit;
ordinary recv returns credit only for consumed bytes, never for MSG_PEEK.
Bound a DATA frame to 16 KiB and the negotiated channel ceiling. Sender writes
are partial when only some credit is available and return EAGAIN when no
credit or port admission remains. Read shutdown refuses further writes; normal
close retains an orphaned receive sink that discards received bytes and returns
credit, matching VirtualTcpPeer rather than inventing a finite successful-write
count. Bound active, failed, and orphaned local stream slots to 64, total receive credit
to 4 MiB, bridge frames/bytes to 128/1 MiB per direction, and connect deadlines
to 10 seconds. Keep numeric retired-identifier high-water marks instead of an
unbounded set; do not reuse machine addresses during one segment lifetime
(the IPv4 assignment space has 254 addresses). Existing native bridge
limits remain additional bounds, not application delivery acknowledgements.

## Connection and lifecycle semantics

Begin a connect asynchronously and return -EAGAIN from connectStatus until the
remote listener accepts or supplies a real errno. Existing kernel handling
maps that to EINPROGRESS/EALREADY and blocking retries. Resolve unknown hosts
and refused listeners through the same error vocabulary as LocalVirtualNetwork.
Keep ordinary external TCP on the existing fallback backend.

FIN closes only the sending direction after prior DATA. Drain queued bytes
before EOF; receiving FIN does not prevent a reply. SHUT_RD discards unread
bytes and explicitly refuses the peer's send direction. Abort, disconnect, or
worker failure resets live streams and wakes readiness/error paths. Resource
retirement must preserve cleanly closed queued bytes instead of turning normal
FIN into reset during machine teardown.

Trace through the actual kernel path: host-backed SHUT_WR currently changes
only the kernel flag and never sends FIN to NetworkIO. Fix that platform gap
through a host shutdown import and both Node/browser adapters, with an ABI
bump and regenerated snapshot. The existing accepted-connection pipe bridge
also maps reset to EOF/EPIPE; expose/reset its real socket backing rather than
claiming TCP reset semantics from a transport-only unit test. Check host handle
ownership, actual local addresses, and inherited sockets with real guest probes
before making broader socket claims.

## Evidence required

Use normal source-only packages and VFS/process paths. Demonstrate a real guest
HTTP server and a packaged guest curl client in two Chromium contexts with a
throwaway piplet. Add Node worker guest proofs and bounded stream tests for
partial writes, exhausted/replenished credit, peek, FIN, read shutdown, reset,
connect refusal/timeouts, source ownership, forwarding, and cleanup. Consider
relevant TCP conformance suites and run ABI checks. Use the normal browser
launch for visible verification; save screenshots under .context. Report the
exact scope, existing failures, and unrun suites. Browser-only RTC transport
remains an explicit host boundary; the stream engine and native ports are shared
with Node. No performance or cross-computer/NAT claim follows from local tests.

## Review order

Review the independent service-worker correction (#1487), then the generic peer
extraction (#1488). Named sharing (#1489) and independent guest UDP (#1496) are
separate consumers of that extraction. TCP follows the UDP transport. Preserve
all contributor authorship and use additive commits/merges on these draft
branches; leave the original signalling branch and PR #1374 untouched.

## Implementation checkpoint

The branch stages ABI 49 for explicit source-bound connect, actual local
endpoints, host shutdown, and accepted-stream reset. The existing socket fields
and shared pipe references carry this state through descriptor duplication and
fork; no new serialized fork-state field is required. FIN and orderly CLOSE
are distinct wire messages so a half-closed live worker disappearing still
causes reset, while a normally closed peer's queued bytes survive teardown.
The network declaration uses `network-control-v2`; stale UDP-only channel sets
fail during generic signal validation instead of silently negotiating an
incompatible stream protocol.

Focused pre-artifact evidence: 63 transport/Node-backend cases passed after the
local-interface asynchronous accept repair. The preceding authority-audit run
passed all eight cases (67 total with its then-current transport inventory).
Workspace Rust tests passed; normal ABI 49 musl, packages, fixtures, guest TCP,
TCP conformance, HTTP/curl browser proof, and visible browser checks remain
pending. Do not read this checkpoint as a completed browser or POSIX claim.
