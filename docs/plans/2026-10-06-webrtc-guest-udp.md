# WebRTC remote segments for guest POSIX UDP

Date: 2026-10-06. Status: design draft; implementation and end-to-end evidence pending.

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

Real guest probes exposed two kernel gaps: UDP connect rejected destinations
outside its hard-coded 10.88 subnet, and FIONREAD ignored datagram queues.
The kernel now delegates non-loopback UDP source selection and local-address
binding validation to the host adapter. A connected wildcard UDP socket records
the actual selected source for getsockname; AF_UNSPEC disconnect restores its
wildcard binding. FIONREAD observes the first queued datagram without consuming
it, including empty datagrams. This changes socket semantics and adds a kernel
host import, so ABI 48 and a regenerated snapshot are required. All programs and
images used for evidence must be rebuilt through the normal ABI-bound package
path. The obsolete application-specific Doom relay remains superseded.

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

Required evidence: segment host tests including forwarding and errno cases;
the Sortix UDP suite; two-context Playwright datagrams through guest `nc -u`
and a throwaway piplet; real two-player Doom and, if the driver's socket path
is compatible, Quake runs; and a manual `./run.sh browser` check with screenshots
under `.context/`. Report evidence separately for Node and browsers, including
launch or ICE failures. A simulated transport unit test does not prove WebRTC
or guest sockets work.

## External-route conformance boundary

The Sortix `udp/connect-loopback-reconnect-wan-getsockname` case expects a
public Internet UDP route to 8.8.8.8. A clean session-migration kernel at
9d34e6e9c, with its ABI 45 SDK and an actual guest run in a dedicated Node
worker, returns ENETUNREACH from its second connect. The test already accepts the
empty stdout produced by that truthful failure as a cross-platform alternative;
it needs no additional expected-failure marker. External UDP remains unavailable.
The new route-selection path must still query the host after an earlier
loopback auto-bind; reusing that binding must not invent external connectivity.
A Rust regression checks the failure and preserves the preceding association.

## TCP is a later decision

Do not implement remote TCP in this phase. After the user confirms Phase 3,
settle multiplexing, asynchronous EINPROGRESS/connectStatus, FIN/half-close,
RST semantics, and credit-based receive flow control, then prove the guest
HTTP-server/curl scenario in two browser contexts.
