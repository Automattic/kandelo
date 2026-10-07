# WebRTC remote segments for guest POSIX UDP

Date: 2026-10-06. Status: implemented UDP experiment with bounded Node and local Chromium evidence. TCP is deferred.

## Why

Session sharing transfers one machine's state. Multiplayer and remote services
instead need independent machines, independent process tables, and normal guest
sockets. The kernel already routes IPv4 UDP through `NetworkIO`. A transport
below that contract can connect browsers without reviving the superseded
kernel relay or adding application-specific socket interfaces.

## Connection and topology

Use the reusable peer connection declaration with `purpose: "network"`.
Session sharing continues to use `purpose: "migration"`. The rendezvous server
carries the same opaque offer and answer strings; it never interprets purpose,
addresses, socket bindings, or application traffic.

The host owns `10.89.0.1`. It assigns joiners `10.89.0.2` onward over an ordered,
reliable control channel. Register hostnames such as `host` and `peer-2` with
the virtual network resolver. A joiner does not advertise machine readiness
until its assignment and current routing/binding directory arrive. This avoids
launching software against an address the worker does not yet own.

Each host/joiner link is pairwise. For more than two machines, joiners send
peer-owned destinations through the host. The host's kernel worker forwards
to the owning segment; the main thread only moves framed bytes between worker
ports and data channels. The host therefore routes Doom's peer-to-peer traffic
as well as Quake's client/server traffic without requiring direct links between
joiners or changing the piplet's pairwise storage model.

Use bounded membership and binding directories. The host is authoritative for
address assignment. Validate source addresses against the sending link's
assignment, so a joiner cannot impersonate another guest. Drop stale routes and
bindings on disconnect. Reject duplicate or malformed assignments loudly.

## Worker ownership

The segment and `NetworkIO` remain in the dedicated kernel worker. Socket
lookup, address ownership, endpoint registration, errno decisions, and
forwarding are runtime responsibilities there. `RTCPeerConnection` and its
channels remain on the main thread, reached through a bounded `MessagePort`
bridge. BrowserKernel owns bridge attachment and teardown; pages consume it.

Transfer support was checked rather than assumed. In the local development
shell, a newly created RTCDataChannel transferred successfully in Chromium
151.0.7922.34 and WebKit 26.5. Firefox's Playwright launcher failed before the
probe with a macOS sandbox-extension error and a framebuffer mapping error;
that run provides no Firefox transfer evidence. MDN's compatibility source
reports transfer support in Chromium 130+, Firefox 144+, and Safari 15+.

Even where transfer exists, the [WebRTC specification](https://www.w3.org/TR/webrtc/#rtcdatachannel)
clears transfer eligibility in a queued task after channel creation. The
generic API intentionally returns established channels after asynchronous
signalling and ICE gathering, so transferring those channels afterward is not
the bridge contract. Main-thread byte forwarding works for that lifecycle
without creating a browser-dependent syscall engine.

Reference: [MDN browser compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/RTCDataChannel.json).
The executable probe and its observations are under `.context/`.

## Datagram delivery

Declare an unchunked UDP channel with `ordered: false, maxRetransmits: 0` and
a separate ordered, reliable control channel. Never apply the migration
message codec or chunk reassembly to UDP: one frame is one datagram, and a lost
datagram must not stall following datagrams.

The datagram frame is versioned and carries source IPv4 address and port,
destination IPv4 address and port, followed by the payload. Validate frame
length, port ranges, addresses, version, and source ownership before delivery.
Use network byte order for integers and transfer ArrayBuffers through the
worker bridge. Copy guest-owned bytes before yielding ownership.

Limit UDP payloads to the lesser of the IPv4 UDP maximum (65,507 bytes) and
the negotiated SCTP maximum message size minus the framing header. Publish
the effective limit to the worker during attachment; oversized sends return
`EMSGSIZE` rather than fragmenting or claiming success. When a star path has a
smaller downstream transport limit, the control directory advertises that
route's effective limit.

Both bridge directions have bounded outstanding frame counts and byte limits.
Worker-side send admission returns `EAGAIN` when the outbound bridge budget is
exhausted. The main thread acknowledges released frames, caps RTC buffering,
and may drop UDP traffic under congestion. Incoming excess datagrams are
dropped rather than queued without bound. UDP is best effort; acknowledgement
of bridge admission is not an application delivery acknowledgement.

## Virtual network integration and errors

Reuse `LocalVirtualNetwork` address ownership and endpoint lookup. Announce
remote UDP bind/unbind events over the control channel, and register the
remote endpoints with transport-backed receive targets. Locally unknown
addresses return `EHOSTUNREACH`; a known address with no announced matching
UDP endpoint returns `ECONNREFUSED`, matching the local virtual backend.
These are backend errors, not remote delivery acknowledgements. The kernel
admits an unconnected UDP send before host delivery and may discard it. On a
connected UDP socket, an admitted refused send records `ECONNREFUSED` as its
pending socket error, observable through `SO_ERROR`. The real guest errno
probe checks that path instead of expecting immediate refusal from sendto.
Duplicate bindings and foreign local-address binds retain `EADDRINUSE` and
`EADDRNOTAVAIL`. Receive delivery still enters the kernel's normal datagram
queue through the registered `UdpReceiveTarget`.

A binding announcement is asynchronous across a network. A stale directory
can admit a datagram whose receiver has since closed; it may then be lost,
as with ordinary best-effort UDP. Do not invent synchronous remote receipt or
mask that race with demo output. The tests synchronize on the actual binding
announcement before asserting refused/unreachable behavior.

The existing platform does not implement raw limited or directed broadcast
delivery. Explicit peer addresses and hostnames are the multiplayer path for
this phase. That is a documented platform gap, not a reason to make a game's
discovery API report success.

## Node and ABI boundaries

The segment and frame codec do not depend on browser globals. Exercise the
same routing, source validation, endpoint semantics, and bounded transport
contract with paired Node transports in host tests. Node has no built-in
WebRTC implementation; the supplied WebRTC adapter is browser-only. State
that boundary in architecture and browser support docs without claiming
Node WebRTC support or changing ordinary Node TCP behavior.

Real guest probes exposed kernel gaps: UDP connect rejected destinations
outside its hard-coded 10.88 subnet, and FIONREAD ignored datagram queues.
The kernel now delegates non-loopback UDP source selection and local-address
binding validation to the host adapter. A connected wildcard UDP socket records
the actual selected source for getsockname; AF_UNSPEC disconnect restores its
wildcard binding. FIONREAD observes the first queued datagram without consuming
it, including empty datagrams. Preserve host EHOSTUNREACH and ENOBUFS instead
of converting either to EIO at the host-to-kernel boundary. This changes socket
semantics and adds a kernel host import, so ABI 48 and a regenerated snapshot
are required. The kernel fork snapshot format advances from 15 to 16 to
preserve the selected UDP source address across fork; older snapshots are
rejected. All programs and images used for evidence must be rebuilt through
the normal ABI-bound package path. The obsolete application-specific Doom
relay remains superseded.

## Packages and evidence

Bring forward fbdoom's POSIX UDP transport at the upstream fbdoom boundary:
its framebuffer build omits SDL_net and disables multiplayer startup code.
Preserve contributor attribution, remove obsolete kernel-relay descriptions,
apply patches through the declared package recipe, and rebuild the package.
Do not patch Doom to fake platform socket behavior.

TyrQuake exists on current main but not on the session-migration base. Its
[pinned BSD UDP driver](https://github.com/sezero/tyrquake/blob/52c707768f7e9b118b1517476c65a7c87a929602/NQ/net_udp.c)
uses socket/bind/sendto/recvfrom, FIONBIO/FIONREAD, and getifaddrs; it has
ordinary `-ip` and `-localip` options. Bring the established package recipe
forward, preserving its authorship. Check these APIs through the real guest
path; a missing interface or ioctl contract is platform feedback, not a reason
to patch Quake to report success. Do not claim that a Quake port is available
on the base merely because main has it.

The pinned TyrQuake sender has an independent upstream retransmission defect:
`ReSendMessage` calls the same sequence-incrementing helper as a new packet.
After a lost or delayed acknowledgement, retries relabel the same reliable
fragment and invalidate earlier acknowledgements. The observed browser trace
shows repeated first fragments with advancing sequence numbers and stale ACKs.
A scoped package patch preserves the outstanding sequence on retries, matching
[the original Quake implementation](https://github.com/id-Software/Quake/blob/master/WinQuake/net_dgrm.c).
The native source-function probe reproduces the failure before the patch and
checks byte-identical retries and a single advance for the following fragment.
This correction belongs to the upstream protocol boundary; it changes no
Kandelo socket behavior and adds no transport retries to the UDP channel.

A second pinned upstream defect is in
[Cmd_StuffCmds_f](https://github.com/sezero/tyrquake/blob/52c707768f7e9b118b1517476c65a7c87a929602/common/cmd.c):
it treats every hyphen in a `+command` argument as an option delimiter.
Consequently `+connect peer-2` becomes `connect peer` before DNS resolution,
and no datagram enters the segment. A separate scoped package patch recognizes
plus/minus prefixes only at word boundaries. A native probe of the actual
source function fails before and passes after, preserving hyphenated names,
embedded plus signs, and following options and commands. The assigned network
hostnames and ordinary guest resolver remain authoritative.

## Validation evidence and limits

All builds and verification ran under `scripts/dev-shell.sh`, using the
worktree SDK, source-only resolution, and normal package recipes. The normal
`./run.sh browser --host 127.0.0.1 --port 5522 --strictPort` path completed
106/106 build nodes and 8/8 products. Both musl architectures and current ABI
program/image artifacts were built. After the final Quake parser correction,
the full graph completed again with 105 cache hits and one rebuilt package.

| Check | Observed result |
|---|---|
| Native Rust workspace, including xtask | 2,717 unfiltered tests passed; zero failures or ignored cases |
| ABI snapshot check | Passed for ABI 48 and fork-state format 16 |
| Node segment, virtual-network, guest UDP, and packaged Netcat checks | Four files; 35 passed, six existing developer-fixture skips |
| Sortix UDP, actual dedicated-worker guest runs | 199 passed, 13 existing expected failures, zero unexpected outcomes; 212 total |
| Chromium named-piplet networking scenarios | Four passed: bidirectional guest Netcat, joiner-to-joiner forwarding, two-player Doom, and two-player TyrQuake |
| Browser assets and explicit peer-network resolution | 94 imports, seven memory64 fixtures, publication-size check, and all seven required source-only artifacts passed |
| Production peer-network Vite bundle | Passed after the final Quake package revision |
| Strict segment TypeScript | Five implementation files passed |
| Full app and host TypeScript | Still fail with the same baseline 88 and 37 diagnostics respectively |

The game tests place both player machines at `.2` and `.3`, with a separate
`.1` forwarding host. They assert actual guest game startup and participant
sign-on, live frames, running processes, and changed frames after keyboard
input. Screenshots and raw guest diagnostics are saved under `.context/`.
Doom uses two participants; Quake's client reaches sign-on stage four and its
server records the remote client's real address.

Visible Chromium checks used the normal `./run.sh browser` server and real
PHP rendezvous server: guest Netcat exchanged messages both ways; Doom showed
both player roles; TyrQuake completed sign-on. The final rebuilt Quake check
hosts the game at `.2` and connects from `.1` using `peer-2`, preserving the
hyphenated hostname through the actual guest command parser and resolver.
Screenshots show live games and input was sent through the ordinary keyboard
adapter. An idle manual Netcat receiver expired its declared three-second
timeout before the first send; immediate subsequent exchanges exited zero.

The default browser ICE policy failed to find a direct local route in the
first visible run and displayed the real no-route/no-TURN error. The passing
local Chromium runs use loopback ICE candidates and a microphone permission
grant to expose candidates; no capture is requested. They do not establish
cross-computer or NAT connectivity. Newly created channel transfer probes are
separate evidence from guest runtime behavior.

The direct SDK test fixture builder emits its existing missing ABI-contract
stamp warning; packaged game and Netcat browser artifacts use the normal
stamped package path. Six Node cases skip unregistered developer-only fixtures
under source-only resolution; the packaged TCP and UDP Netcat cases pass.
Full host/browser suites, libc-test, Open POSIX, complete Sortix, Firefox and
WebKit guest runtime runs, long-duration gameplay, cross-computer/NAT tests,
and benchmarks were not run. Performance was not measured. This is bounded
UDP evidence for a draft change, not a general merge-readiness claim.

## External-route conformance boundary

The Sortix `udp/connect-loopback-reconnect-wan-getsockname` case expects a
public Internet UDP route to 8.8.8.8. A clean session-migration kernel at
9d34e6e9c, with its ABI 45 SDK and an actual guest run in a dedicated Node
worker, returns ENETUNREACH from its second connect. The test already accepts the
ENETUNREACH failure as a cross-platform alternative;
it needs no additional expected-failure marker. External UDP remains unavailable.
The new route-selection path must still query the host after an earlier
loopback auto-bind; reusing that binding must not invent external connectivity.
A Rust regression checks the failure and preserves the preceding association.

## TCP is a later decision

Do not implement remote TCP in this phase. After the user confirms Phase 3,
settle multiplexing, asynchronous EINPROGRESS/connectStatus, FIN/half-close,
RST semantics, and credit-based receive flow control, then prove the guest
HTTP-server/curl scenario in two browser contexts.
